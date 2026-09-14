/* ================================================================
   morning-email.js — draait elke ochtend via GitHub Actions
   Leest taken uit Firestore en stuurt een HTML-overzicht per mail.
   ================================================================ */

const admin      = require('firebase-admin');
const nodemailer = require('nodemailer');

// ── Firebase Admin ──────────────────────────────────────────────
const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
const db = admin.firestore();

// ── Datumhulpfuncties ───────────────────────────────────────────

/** Geeft de huidige datum als YYYY-MM-DD in Amsterdam-tijdzone. */
function todayNL() {
  return new Date().toLocaleDateString('en-CA', { timeZone: 'Europe/Amsterdam' });
}

/** Tel `days` op bij een ISO-datumstring en geef het resultaat terug. */
function addDays(iso, days) {
  const d = new Date(iso + 'T12:00:00Z');
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/** "2026-06-03" → "wo 3 jun" */
function formatShort(iso) {
  const [y, m, d] = iso.split('-').map(Number);
  const dt = new Date(y, m - 1, d);
  const dag    = ['zo','ma','di','wo','do','vr','za'][dt.getDay()];
  const maand  = ['jan','feb','mrt','apr','mei','jun','jul','aug','sep','okt','nov','dec'][m - 1];
  return `${dag} ${d} ${maand}`;
}

/** "2026-06-03" → "woensdag 3 juni" */
function formatLong(iso) {
  const [y, m, d] = iso.split('-').map(Number);
  const dt = new Date(y, m - 1, d);
  const dag   = ['zondag','maandag','dinsdag','woensdag','donderdag','vrijdag','zaterdag'][dt.getDay()];
  const maand = ['januari','februari','maart','april','mei','juni','juli','augustus',
                 'september','oktober','november','december'][m - 1];
  return `${dag} ${d} ${maand}`;
}

/** Sorteert op prioriteit (hoog eerst), dan op deadline (vroegste eerst). */
function sortTasks(tasks) {
  const order = { hoog: 0, midden: 1, laag: 2 };
  return [...tasks].sort((a, b) => {
    const pa = order[a.priority] ?? 99;
    const pb = order[b.priority] ?? 99;
    if (pa !== pb) return pa - pb;
    if (a.deadline && b.deadline) return a.deadline.localeCompare(b.deadline);
    if (a.deadline) return -1;
    if (b.deadline) return 1;
    return 0;
  });
}

// ── HTML-email opbouwen ─────────────────────────────────────────

function buildEmail(tasks, today) {
  const tomorrow = addDays(today, 1);
  const weekEnd  = addDays(today, 7);

  // Groepen
  const overdue  = tasks.filter(t => !t.done && t.deadline && t.deadline < today);
  const todayT   = tasks.filter(t => !t.done && t.deadline === today);
  const upcoming = tasks.filter(t =>
    !t.done && t.deadline && t.deadline > today && t.deadline <= weekEnd
  );
  const highPrio = tasks.filter(t =>
    !t.done && t.priority === 'hoog' &&
    !overdue.includes(t) && !todayT.includes(t) && !upcoming.includes(t)
  );

  const openCount   = tasks.filter(t => !t.done).length;
  const doneCount   = tasks.filter(t =>  t.done).length;
  const hasItems    = overdue.length + todayT.length + upcoming.length + highPrio.length > 0;

  // Begroeting op basis van uur in Amsterdam
  const hourNL  = parseInt(new Date().toLocaleString('en-US',
    { timeZone: 'Europe/Amsterdam', hour: 'numeric', hour12: false }));
  const greeting = hourNL < 12 ? 'Goedemorgen' : hourNL < 18 ? 'Goedemiddag' : 'Goedenavond';

  // Helper: één taakregel
  function row(t, nameColor = '#1F1E1B') {
    const catBadge = t.category
      ? `<span style="background:#F1EFE6;color:#5C574E;padding:2px 8px;border-radius:99px;font-size:11px;margin-right:5px;">${t.category}</span>`
      : '';
    const dateStr = t.deadline && t.deadline !== today
      ? `<span style="color:#8A8378;font-size:12px;margin-left:5px;">${formatShort(t.deadline)}</span>`
      : '';
    return `
      <tr>
        <td style="padding:7px 0;border-bottom:1px solid #E6E2D5;">
          <div style="font-size:14px;font-weight:500;color:${nameColor};margin-bottom:3px;">
            ${t.title}${dateStr}
          </div>
          <div>${catBadge}</div>
        </td>
      </tr>`;
  }

  // Helper: sectieblok
  function section(title, items, titleColor, nameColor) {
    if (!items.length) return '';
    return `
      <tr>
        <td style="padding:18px 0 6px;">
          <div style="font-size:11px;font-weight:600;color:${titleColor};
                      text-transform:uppercase;letter-spacing:.08em;">${title}</div>
        </td>
      </tr>
      ${sortTasks(items).map(t => row(t, nameColor)).join('')}`;
  }

  return `<!DOCTYPE html>
<html lang="nl">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>Takenlijst — ${formatShort(today)}</title>
</head>
<body style="margin:0;padding:0;background:#F5F4ED;
             font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;">

  <div style="max-width:520px;margin:32px auto 16px;background:#FBFAF5;
              border-radius:14px;overflow:hidden;
              box-shadow:0 4px 24px rgba(31,30,27,.10);">

    <!-- HEADER -->
    <div style="background:#C96442;padding:22px 28px 20px;">
      <div style="font-size:11px;font-weight:600;letter-spacing:.1em;
                  text-transform:uppercase;color:rgba(255,255,255,.7);margin-bottom:4px;">
        Takenlijst
      </div>
      <div style="font-size:22px;font-weight:500;color:#fff;">${greeting}</div>
      <div style="font-size:14px;color:rgba(255,255,255,.8);margin-top:2px;">
        ${formatLong(today)}
      </div>
    </div>

    <!-- STATISTIEKEN -->
    <table style="width:100%;border-collapse:collapse;border-bottom:1px solid #E6E2D5;">
      <tr>
        <td style="width:33%;text-align:center;padding:14px 0;border-right:1px solid #E6E2D5;">
          <div style="font-size:24px;font-weight:500;color:#1F1E1B;">${openCount}</div>
          <div style="font-size:10px;color:#8A8378;text-transform:uppercase;letter-spacing:.06em;">openstaand</div>
        </td>
        <td style="width:33%;text-align:center;padding:14px 0;border-right:1px solid #E6E2D5;">
          <div style="font-size:24px;font-weight:500;color:#4B7A4A;">${doneCount}</div>
          <div style="font-size:10px;color:#8A8378;text-transform:uppercase;letter-spacing:.06em;">afgerond</div>
        </td>
        <td style="width:33%;text-align:center;padding:14px 0;">
          <div style="font-size:24px;font-weight:500;color:${overdue.length ? '#B0432E' : '#1F1E1B'};">
            ${overdue.length}
          </div>
          <div style="font-size:10px;color:#8A8378;text-transform:uppercase;letter-spacing:.06em;">te laat</div>
        </td>
      </tr>
    </table>

    <!-- TAKEN -->
    <div style="padding:4px 28px 24px;">
      ${hasItems
        ? `<table style="width:100%;border-collapse:collapse;">
             ${section('Te laat',        overdue,  '#B0432E', '#B0432E')}
             ${section('Vandaag',         todayT,   '#1F1E1B', '#1F1E1B')}
             ${section('Deze week',       upcoming, '#5C574E', '#1F1E1B')}
             ${section('Hoog prioriteit', highPrio, '#A06A1B', '#1F1E1B')}
           </table>`
        : `<p style="color:#8A8378;font-style:italic;text-align:center;padding:28px 0;">
             Geen taken die direct aandacht nodig hebben. Mooi!
           </p>`
      }
      <div style="margin-top:22px;text-align:center;">
        <a href="https://keeshehenkamp.github.io/Taken-lijst/"
           style="display:inline-block;background:#C96442;color:#fff;text-decoration:none;
                  padding:10px 24px;border-radius:8px;font-size:14px;font-weight:500;">
          Open takenlijst →
        </a>
      </div>
    </div>
  </div>

  <div style="text-align:center;padding:8px 0 24px;font-size:11px;color:#8A8378;">
    Automatisch verstuurd door je Takenlijst-app
  </div>

</body>
</html>`;
}

// ── Hoofdprogramma ──────────────────────────────────────────────
async function main() {
  const uid   = process.env.USER_UID;
  const today = todayNL();

  // Taken ophalen
  const snap = await db.collection('users').doc(uid).get();
  if (!snap.exists) {
    console.log('Geen Firestore-data gevonden — e-mail overgeslagen.');
    process.exit(0);
  }
  const { tasks = [] } = snap.data();

  // E-mail versturen via Gmail SMTP
  const transporter = nodemailer.createTransport({
    host:   'smtp.gmail.com',
    port:   465,
    secure: true,
    auth: {
      user: process.env.GMAIL_USER,
      pass: process.env.GMAIL_APP_PASSWORD,
    },
  });

  const subject = `Takenlijst · ${formatLong(today)}`;
  const html    = buildEmail(tasks, today);

  await transporter.sendMail({
    from:    `"Takenlijst" <${process.env.GMAIL_USER}>`,
    to:      process.env.RECIPIENT_EMAIL,
    subject,
    html,
  });

  console.log(`✓ E-mail verstuurd naar ${process.env.RECIPIENT_EMAIL} voor ${today}`);
}

main().catch(err => {
  console.error('Fout bij versturen e-mail:', err);
  process.exit(1);
});
