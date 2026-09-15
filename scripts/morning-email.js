/* ================================================================
   morning-email.js — draait elke ochtend via GitHub Actions
   Leest taken uit Firestore en stuurt een persoonlijk dagoverzicht.
   ================================================================ */

const admin      = require('firebase-admin');
const nodemailer = require('nodemailer');

// ── Firebase Admin ──────────────────────────────────────────────
const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
const db = admin.firestore();

// ── Datumhulpfuncties ───────────────────────────────────────────

function todayNL() {
  return new Date().toLocaleDateString('en-CA', { timeZone: 'Europe/Amsterdam' });
}

function addDays(iso, days) {
  const d = new Date(iso + 'T12:00:00Z');
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

function formatLong(iso) {
  const [y, m, d] = iso.split('-').map(Number);
  const dt = new Date(y, m - 1, d);
  const dag   = ['zondag','maandag','dinsdag','woensdag','donderdag','vrijdag','zaterdag'][dt.getDay()];
  const maand = ['januari','februari','maart','april','mei','juni','juli','augustus',
                 'september','oktober','november','december'][m - 1];
  return `${dag} ${d} ${maand}`;
}

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

// ── Weer ophalen via wttr.in ────────────────────────────────────

async function fetchWeather() {
  try {
    const res  = await fetch('https://wttr.in/Amsterdam?format=j1');
    const data = await res.json();
    const cur  = data.current_condition[0];
    const desc = cur.lang_nl?.[0]?.value || cur.weatherDesc[0].value;
    const temp = cur.temp_C;
    const feel = cur.FeelsLikeC;
    const wind = cur.windspeedKmph;
    return `${desc}, ${temp}°C (voelt als ${feel}°C), wind ${wind} km/u`;
  } catch {
    return null;
  }
}

// ── Nieuws ophalen via NOS RSS ──────────────────────────────────

async function fetchNews() {
  try {
    const res  = await fetch('https://feeds.nos.nl/nosnieuwsalgemeen');
    const text = await res.text();
    const items = [...text.matchAll(/<item>[\s\S]*?<title><!\[CDATA\[(.*?)\]\]><\/title>[\s\S]*?<\/item>/g)]
      .slice(0, 4)
      .map(m => m[1].trim());
    return items.length ? items : null;
  } catch {
    return null;
  }
}

// ── HTML-email opbouwen ─────────────────────────────────────────

function buildEmail(tasks, today, weather, news) {
  const weekEnd = addDays(today, 7);

  const overdue  = sortTasks(tasks.filter(t => !t.done && t.deadline && t.deadline < today));
  const todayT   = sortTasks(tasks.filter(t => !t.done && t.deadline === today));
  const upcoming = sortTasks(tasks.filter(t =>
    !t.done && t.deadline && t.deadline > today && t.deadline <= weekEnd
  ));
  const highPrio = sortTasks(tasks.filter(t =>
    !t.done && t.priority === 'hoog' &&
    !overdue.includes(t) && !todayT.includes(t) && !upcoming.includes(t)
  ));
  const vergeetNiet = [...overdue, ...highPrio];

  function bullets(items, showDate = false) {
    if (!items.length) return `<li style="color:#8A8378;font-style:italic;">Niets gepland</li>`;
    return items.map(t => {
      const date = showDate && t.deadline && t.deadline !== today
        ? ` <span style="color:#8A8378;font-size:13px;">(${formatLong(t.deadline)})</span>` : '';
      return `<li>${t.title}${date}</li>`;
    }).join('\n');
  }

  const weatherBlock = weather ? `
    <p style="margin:0 0 6px;"><strong>Weer vandaag</strong></p>
    <p style="margin:0 0 24px;color:#5C574E;">${weather}</p>` : '';

  const newsBlock = news ? `
    <p style="margin:0 0 6px;"><strong>Nieuws</strong></p>
    <ul style="margin:0 0 24px;padding-left:20px;color:#5C574E;">
      ${news.map(h => `<li style="margin-bottom:4px;">${h}</li>`).join('\n')}
    </ul>` : '';

  return `<!DOCTYPE html>
<html lang="nl">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>Takenlijst — ${formatLong(today)}</title>
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
        ${formatLong(today)}
      </div>
      <div style="font-size:22px;font-weight:500;color:#fff;">Goedemorgen, Kees</div>
    </div>

    <!-- BODY -->
    <div style="padding:24px 28px;font-size:15px;line-height:1.7;color:#1F1E1B;">

      <p style="margin:0 0 6px;"><strong>Voor vandaag staat</strong></p>
      <ul style="margin:0 0 24px;padding-left:20px;color:#5C574E;">
        ${bullets(todayT)}
      </ul>

      <p style="margin:0 0 6px;"><strong>Voor deze week</strong></p>
      <ul style="margin:0 0 24px;padding-left:20px;color:#5C574E;">
        ${bullets(upcoming, true)}
      </ul>

      ${vergeetNiet.length ? `
      <p style="margin:0 0 6px;"><strong>Vergeet niet</strong></p>
      <ul style="margin:0 0 24px;padding-left:20px;color:#B0432E;">
        ${bullets(vergeetNiet, true)}
      </ul>` : ''}

      ${weatherBlock}
      ${newsBlock}

      <div style="margin-top:8px;text-align:center;">
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

  const snap = await db.collection('users').doc(uid).get();
  if (!snap.exists) {
    console.log('Geen Firestore-data gevonden — e-mail overgeslagen.');
    process.exit(0);
  }
  const { tasks = [] } = snap.data();

  const [weather, news] = await Promise.all([fetchWeather(), fetchNews()]);

  const transporter = nodemailer.createTransport({
    host:   'smtp.gmail.com',
    port:   465,
    secure: true,
    auth: {
      user: process.env.GMAIL_USER,
      pass: process.env.GMAIL_APP_PASSWORD,
    },
  });

  const subject = `Goedemorgen Kees — ${formatLong(today)}`;
  const html    = buildEmail(tasks, today, weather, news);

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
