/* ================================================================
   morning-email.js — draait elke ochtend via GitHub Actions
   ================================================================ */

const admin      = require('firebase-admin');
const nodemailer = require('nodemailer');

const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
const db = admin.firestore();

// ── Datum ───────────────────────────────────────────────────────

function todayNL() {
  return new Date().toLocaleDateString('en-CA', { timeZone: 'Europe/Amsterdam' });
}

function addDays(iso, days) {
  const d = new Date(iso + 'T12:00:00Z');
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

function dayOfWeek(iso) {
  const [y, m, d] = iso.split('-').map(Number);
  return new Date(y, m - 1, d).getDay(); // 0=zo, 1=ma, ...
}

function formatLong(iso) {
  const [y, m, d] = iso.split('-').map(Number);
  const dt  = new Date(y, m - 1, d);
  const dag   = ['zondag','maandag','dinsdag','woensdag','donderdag','vrijdag','zaterdag'][dt.getDay()];
  const maand = ['januari','februari','maart','april','mei','juni','juli','augustus',
                 'september','oktober','november','december'][m - 1];
  return `${dag} ${d} ${maand}`;
}

function formatShort(iso) {
  const [y, m, d] = iso.split('-').map(Number);
  const dt  = new Date(y, m - 1, d);
  const dag   = ['zo','ma','di','wo','do','vr','za'][dt.getDay()];
  const maand = ['jan','feb','mrt','apr','mei','jun','jul','aug','sep','okt','nov','dec'][m - 1];
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

// ── Weer ────────────────────────────────────────────────────────

async function fetchWeather() {
  try {
    const res  = await fetch('https://wttr.in/Amsterdam?format=j1');
    const data = await res.json();
    const cur  = data.current_condition[0];
    const desc = cur.lang_nl?.[0]?.value || cur.weatherDesc[0].value;
    const temp = cur.temp_C;
    const feel = cur.FeelsLikeC;

    // Middagweer (uurlijks slot rond 13-15u)
    let middagTekst = '';
    try {
      const uurlijks = data.weather[0].hourly;
      const middag   = uurlijks.find(h => parseInt(h.time) >= 1200 && parseInt(h.time) <= 1500);
      if (middag) {
        const mdDesc = middag.lang_nl?.[0]?.value || middag.weatherDesc[0].value;
        const mdRegen = parseInt(middag.chanceofrain);
        middagTekst = mdRegen >= 50
          ? ` Vanmiddag kans op regen (${mdRegen}%), ${mdDesc.toLowerCase()}.`
          : ` Vanmiddag ${mdDesc.toLowerCase()}.`;
      }
    } catch {}

    return `${desc}, ${temp}°C (voelt als ${feel}°C).${middagTekst}`;
  } catch {
    return null;
  }
}

// ── Nieuws ──────────────────────────────────────────────────────

async function fetchFeed(url, count) {
  const res  = await fetch(url);
  const text = await res.text();
  const items = [];
  const re = /<item>([\s\S]*?)<\/item>/g;
  let m;
  while ((m = re.exec(text)) !== null && items.length < count) {
    const block = m[1];
    const titleM = block.match(/<title><!\[CDATA\[(.*?)\]\]><\/title>/);
    const descM  = block.match(/<description><!\[CDATA\[(.*?)\]\]><\/description>/);
    if (!titleM) continue;
    const title = titleM[1].trim();
    const desc  = descM
      ? descM[1].replace(/<[^>]+>/g, '').trim().slice(0, 160)
      : '';
    items.push({ title, desc });
  }
  return items;
}

async function fetchNews() {
  try {
    const [algemeen, gezondheid] = await Promise.all([
      fetchFeed('https://feeds.nos.nl/nosnieuwsalgemeen', 2),
      fetchFeed('https://feeds.nos.nl/nosnieuwsgezondheid', 2),
    ]);
    return [...algemeen, ...gezondheid].filter(Boolean);
  } catch {
    return [];
  }
}

// ── Openingszin ─────────────────────────────────────────────────

function openingszin(today, todayTasks, overdue, doneThisWeek, totalOpen, dow) {
  if (dow === 1) {
    return `Nieuwe week! Je hebt ${totalOpen} open ${totalOpen === 1 ? 'taak' : 'taken'} staan. Goed begin maken vandaag.`;
  }
  if (dow === 5) {
    return `Het is vrijdag — nog één dag om de week goed af te sluiten. Je hebt er deze week al ${doneThisWeek} afgerond.`;
  }
  if (overdue.length > 2) {
    return `Je hebt ${overdue.length} taken die al te laat zijn. Vandaag is een goed moment om die aan te pakken.`;
  }
  if (todayTasks.length === 0 && overdue.length === 0) {
    return `Rustige dag vandaag — niets gepland. Goed moment om vooruit te werken of iets af te ronden.`;
  }
  if (todayTasks.length >= 4) {
    return `Volle agenda vandaag met ${todayTasks.length} taken. Begin met de belangrijkste en werk van daaruit.`;
  }
  if (doneThisWeek >= 5) {
    return `Je hebt deze week al ${doneThisWeek} taken afgerond — lekker bezig. Nog even doorzetten.`;
  }
  return `Je hebt vandaag ${todayTasks.length || 'geen'} ${todayTasks.length === 1 ? 'taak' : 'taken'} gepland en ${totalOpen} open staan in totaal.`;
}

// ── HTML ────────────────────────────────────────────────────────

function buildEmail({ tasks, today, weather, news, dow }) {
  const weekStart = addDays(today, -(dow === 0 ? 6 : dow - 1));
  const weekEnd   = addDays(today, 7);

  const overdue   = sortTasks(tasks.filter(t => !t.done && t.deadline && t.deadline < today));
  const todayT    = sortTasks(tasks.filter(t => !t.done && t.deadline === today));
  const upcoming  = sortTasks(tasks.filter(t =>
    !t.done && t.deadline && t.deadline > today && t.deadline <= weekEnd
  ));
  const highPrio  = sortTasks(tasks.filter(t =>
    !t.done && t.priority === 'hoog' &&
    !overdue.includes(t) && !todayT.includes(t) && !upcoming.includes(t)
  ));

  const doneThisWeek = tasks.filter(t => t.done && t.updatedAt >= weekStart).length;
  const totalOpen    = tasks.filter(t => !t.done).length;
  const totalDone    = tasks.filter(t => t.done).length;
  const totalAll     = tasks.length;
  const pct          = totalAll ? Math.round((totalDone / totalAll) * 100) : 0;

  // Focus taak: eerste van vandaag, anders eerste overdue, anders eerste high prio
  const focusTaak = todayT[0] || overdue[0] || highPrio[0] || null;

  const intro = openingszin(today, todayT, overdue, doneThisWeek, totalOpen, dow);

  // Helpers
  const li = (t, showDate = false, color = '#5C574E') => {
    const date = showDate && t.deadline && t.deadline !== today
      ? ` <span style="font-size:13px;color:#8A8378;">(${formatShort(t.deadline)})</span>` : '';
    return `<li style="margin-bottom:6px;color:${color};">${t.title}${date}</li>`;
  };

  const section = (label, items, showDate = false, color = '#5C574E') => {
    if (!items.length) return '';
    return `
      <p style="margin:20px 0 6px;font-weight:600;color:#1F1E1B;">${label}</p>
      <ul style="margin:0;padding-left:20px;">
        ${items.map(t => li(t, showDate, color)).join('\n')}
      </ul>`;
  };

  const nieuws = news.length ? `
    <p style="margin:20px 0 6px;font-weight:600;color:#1F1E1B;">Nieuws</p>
    ${news.map(n => `
      <div style="margin-bottom:12px;">
        <div style="font-weight:500;color:#1F1E1B;">${n.title}</div>
        ${n.desc ? `<div style="font-size:13px;color:#8A8378;margin-top:2px;">${n.desc}${n.desc.length === 160 ? '…' : ''}</div>` : ''}
      </div>`).join('')}` : '';

  const weerBlok = weather ? `
    <p style="margin:20px 0 6px;font-weight:600;color:#1F1E1B;">Weer vandaag</p>
    <p style="margin:0;color:#5C574E;">${weather}</p>` : '';

  const focusBlok = focusTaak ? `
    <div style="background:#FFF8F5;border-left:3px solid #C96442;padding:12px 16px;
                border-radius:0 8px 8px 0;margin-bottom:4px;">
      <div style="font-size:11px;font-weight:600;letter-spacing:.08em;text-transform:uppercase;
                  color:#C96442;margin-bottom:4px;">Focus vandaag</div>
      <div style="font-size:15px;font-weight:500;color:#1F1E1B;">${focusTaak.title}</div>
    </div>` : '';

  const voortgang = `
    <div style="margin:20px 0 0;">
      <div style="display:flex;justify-content:space-between;font-size:12px;color:#8A8378;margin-bottom:4px;">
        <span>Voortgang totaal</span>
        <span>${totalDone} van ${totalAll} afgerond</span>
      </div>
      <div style="background:#E8E5DC;border-radius:99px;height:6px;">
        <div style="background:#C96442;width:${pct}%;height:6px;border-radius:99px;"></div>
      </div>
    </div>`;

  return `<!DOCTYPE html>
<html lang="nl">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
</head>
<body style="margin:0;padding:0;background:#F5F4ED;
             font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;">

  <div style="max-width:520px;margin:32px auto 16px;background:#FBFAF5;
              border-radius:14px;overflow:hidden;
              box-shadow:0 4px 24px rgba(31,30,27,.10);">

    <div style="background:#C96442;padding:22px 28px 20px;">
      <div style="font-size:11px;font-weight:600;letter-spacing:.1em;
                  text-transform:uppercase;color:rgba(255,255,255,.7);margin-bottom:4px;">
        ${formatLong(today)}
      </div>
      <div style="font-size:22px;font-weight:500;color:#fff;">Goedemorgen, Kees</div>
    </div>

    <div style="padding:24px 28px 28px;font-size:15px;line-height:1.7;color:#1F1E1B;">

      <p style="margin:0 0 16px;color:#5C574E;">${intro}</p>

      ${focusBlok}

      ${section('Vandaag', todayT)}
      ${section('Deze week', upcoming, true)}
      ${overdue.length || highPrio.length
        ? section('Vergeet niet', [...overdue, ...highPrio], true, '#B0432E') : ''}

      ${voortgang}

      <hr style="border:none;border-top:1px solid #E8E5DC;margin:24px 0;">

      ${weerBlok}
      ${nieuws}

      <div style="margin-top:24px;text-align:center;">
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
  const dow   = dayOfWeek(today);

  const snap = await db.collection('users').doc(uid).get();
  if (!snap.exists) {
    console.log('Geen Firestore-data gevonden — e-mail overgeslagen.');
    process.exit(0);
  }
  const { tasks = [] } = snap.data();

  const [weather, news] = await Promise.all([fetchWeather(), fetchNews()]);

  const transporter = nodemailer.createTransport({
    host: 'smtp.gmail.com', port: 465, secure: true,
    auth: { user: process.env.GMAIL_USER, pass: process.env.GMAIL_APP_PASSWORD },
  });

  await transporter.sendMail({
    from:    `"Takenlijst" <${process.env.GMAIL_USER}>`,
    to:      process.env.RECIPIENT_EMAIL,
    subject: `Goedemorgen Kees — ${formatLong(today)}`,
    html:    buildEmail({ tasks, today, weather, news, dow }),
  });

  console.log(`✓ E-mail verstuurd voor ${today}`);
}

main().catch(err => {
  console.error('Fout bij versturen e-mail:', err);
  process.exit(1);
});
