/* ================================================================
   morning-email.js — draait elke ochtend via GitHub Actions
   ================================================================ */

const admin      = require('firebase-admin');
const nodemailer = require('nodemailer');
const Anthropic  = require('@anthropic-ai/sdk');

const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
const db      = admin.firestore();
const claude  = new Anthropic.default({ apiKey: process.env.ANTHROPIC_API_KEY });

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
  return new Date(y, m - 1, d).getDay();
}

function formatLong(iso) {
  const [y, m, d] = iso.split('-').map(Number);
  const dt    = new Date(y, m - 1, d);
  const dag   = ['zondag','maandag','dinsdag','woensdag','donderdag','vrijdag','zaterdag'][dt.getDay()];
  const maand = ['januari','februari','maart','april','mei','juni','juli','augustus',
                 'september','oktober','november','december'][m - 1];
  return `${dag} ${d} ${maand}`;
}

function formatShort(iso) {
  const [y, m, d] = iso.split('-').map(Number);
  const dt    = new Date(y, m - 1, d);
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

// ── Weer (Amsterdam) ────────────────────────────────────────────

async function fetchWeather() {
  try {
    const res  = await fetch('https://wttr.in/Amsterdam?format=j1&lang=nl');
    const data = await res.json();
    const cur  = data.current_condition[0];
    const vandaag = data.weather[0];

    const beschrijving = cur.lang_nl?.[0]?.value || cur.weatherDesc[0].value;
    const temp    = cur.temp_C;
    const feel    = cur.FeelsLikeC;
    const maxTemp = vandaag.maxtempC;
    const minTemp = vandaag.mintempC;

    // Regenkans vanmiddag
    const uurlijks  = vandaag.hourly || [];
    const middag    = uurlijks.find(h => parseInt(h.time) >= 1200 && parseInt(h.time) <= 1500);
    const regenKans = middag ? parseInt(middag.chanceofrain) : 0;
    const regenTekst = regenKans >= 50
      ? `Vanmiddag ${regenKans}% kans op regen.`
      : regenKans >= 25
      ? `Kleine kans op regen vanmiddag (${regenKans}%).`
      : '';

    return {
      samenvatting: beschrijving,
      temp, feel, maxTemp, minTemp, regenTekst,
      tekst: `${beschrijving} · Nu ${temp}°C (voelt als ${feel}°C) · Min ${minTemp}° / Max ${maxTemp}°${regenTekst ? ' · ' + regenTekst : ''}`
    };
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
    const block  = m[1];
    const titleM = block.match(/<title>(?:<!\[CDATA\[)?(.*?)(?:\]\]>)?<\/title>/);
    const descM  = block.match(/<description>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?<\/description>/);
    if (!titleM) continue;
    const title = titleM[1].trim();
    const desc  = descM
      ? descM[1].replace(/<[^>]+>/g, '').replace(/&amp;/g,'&').replace(/&lt;/g,'<').replace(/&gt;/g,'>').trim().slice(0, 200)
      : '';
    if (title) items.push({ title, desc });
  }
  return items;
}

async function fetchNews() {
  try {
    const [algemeen, gezondheid] = await Promise.all([
      fetchFeed('https://feeds.nos.nl/nosnieuwsalgemeen', 2),
      fetchFeed('https://feeds.nos.nl/nosnieuwsgezondheid', 2),
    ]);
    return [...algemeen, ...gezondheid].filter(n => n.title);
  } catch {
    return [];
  }
}

// ── Claude: persoonlijke intro ──────────────────────────────────

async function generateIntro({ tasks, today, weather, dow, doneThisWeek, totalOpen }) {
  const dagNaam = ['zondag','maandag','dinsdag','woensdag','donderdag','vrijdag','zaterdag'][dow];
  const weekEnd = addDays(today, 7);

  const overdue  = tasks.filter(t => !t.done && t.deadline && t.deadline < today);
  const todayT   = tasks.filter(t => !t.done && t.deadline === today);
  const upcoming = tasks.filter(t => !t.done && t.deadline && t.deadline > today && t.deadline <= weekEnd);
  const highPrio = tasks.filter(t => !t.done && t.priority === 'hoog');

  const takenSamenvatting = [
    todayT.length    ? `Vandaag gepland: ${todayT.map(t=>t.title).join(', ')}` : 'Niets concreet gepland voor vandaag',
    overdue.length   ? `Te laat: ${overdue.map(t=>t.title).join(', ')}` : '',
    upcoming.length  ? `Komende week: ${upcoming.slice(0,3).map(t=>t.title).join(', ')}` : '',
    highPrio.length  ? `Hoge prioriteit: ${highPrio.map(t=>t.title).join(', ')}` : '',
    `Deze week al ${doneThisWeek} taken afgerond`,
    `Totaal open: ${totalOpen}`,
  ].filter(Boolean).join('\n');

  const weerContext = weather
    ? `Weer in Amsterdam: ${weather.samenvatting}, ${weather.temp}°C.${weather.regenTekst ? ' ' + weather.regenTekst : ''}`
    : '';

  const prompt = `Je schrijft een persoonlijke ochtendgroet voor Kees, een coassistent kindergeneeskunde.
Het is ${dagNaam} ${formatLong(today)}.

Takenoverzicht:
${takenSamenvatting}

${weerContext}

Schrijf 2-3 korte, natuurlijke zinnen in het Nederlands. Informeel maar niet kinderachtig. Geen aanhef ("Hoi Kees"), geen afsluiting. Verwijs naar specifieke taken als dat relevant is. Varieer van dag tot dag in toon. Wees concreet en persoonlijk, niet generiek.`;

  try {
    const response = await claude.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 150,
      messages: [{ role: 'user', content: prompt }],
    });
    return response.content[0].text.trim();
  } catch {
    return `Het is ${dagNaam} en je hebt ${totalOpen} open taken staan. Goed begin maken vandaag.`;
  }
}

// ── HTML ────────────────────────────────────────────────────────

function buildEmail({ tasks, today, weather, news, dow, intro }) {
  const weekStart = addDays(today, -(dow === 0 ? 6 : dow - 1));
  const weekEnd   = addDays(today, 7);

  const overdue  = sortTasks(tasks.filter(t => !t.done && t.deadline && t.deadline < today));
  const todayT   = sortTasks(tasks.filter(t => !t.done && t.deadline === today));
  const upcoming = sortTasks(tasks.filter(t =>
    !t.done && t.deadline && t.deadline > today && t.deadline <= weekEnd
  ));
  const highPrio = sortTasks(tasks.filter(t =>
    !t.done && t.priority === 'hoog' &&
    !overdue.some(x => x === t) && !todayT.some(x => x === t) && !upcoming.some(x => x === t)
  ));
  const vergeetNiet = [...overdue, ...highPrio];

  const totalDone    = tasks.filter(t => t.done).length;
  const totalAll     = tasks.length;
  const pct          = totalAll ? Math.round((totalDone / totalAll) * 100) : 0;
  const focusTaak    = todayT[0] || overdue[0] || highPrio[0] || null;

  const li = (t, showDate = false, kleur = '#374151') => {
    const date = showDate && t.deadline && t.deadline !== today
      ? ` <span style="color:#9CA3AF;font-size:12px;">${formatShort(t.deadline)}</span>` : '';
    const dot  = t.priority === 'hoog'
      ? `<span style="display:inline-block;width:6px;height:6px;background:#EF4444;border-radius:50%;margin-right:8px;vertical-align:middle;"></span>`
      : `<span style="display:inline-block;width:6px;height:6px;background:#D1D5DB;border-radius:50%;margin-right:8px;vertical-align:middle;"></span>`;
    return `<tr><td style="padding:7px 0;border-bottom:1px solid #F3F4F6;">
      ${dot}<span style="color:${kleur};font-size:14px;">${t.title}</span>${date}
    </td></tr>`;
  };

  const sectie = (label, items, showDate = false, kleur = '#374151', labelKleur = '#6B7280') => {
    if (!items.length) return '';
    return `
      <div style="margin-bottom:20px;">
        <div style="font-size:10px;font-weight:700;letter-spacing:.1em;text-transform:uppercase;
                    color:${labelKleur};margin-bottom:8px;">${label}</div>
        <table style="width:100%;border-collapse:collapse;">
          ${items.map(t => li(t, showDate, kleur)).join('')}
        </table>
      </div>`;
  };

  const nieuws = news.length ? `
    <div style="border-top:1px solid #E5E7EB;padding-top:20px;margin-top:4px;">
      <div style="font-size:10px;font-weight:700;letter-spacing:.1em;text-transform:uppercase;
                  color:#6B7280;margin-bottom:14px;">Nieuws</div>
      ${news.map((n, i) => `
        <div style="${i > 0 ? 'margin-top:14px;padding-top:14px;border-top:1px solid #F3F4F6;' : ''}">
          <div style="font-size:14px;font-weight:600;color:#111827;line-height:1.4;">${n.title}</div>
          ${n.desc ? `<div style="font-size:13px;color:#6B7280;margin-top:3px;line-height:1.5;">${n.desc}${n.desc.length >= 198 ? '…' : ''}</div>` : ''}
        </div>`).join('')}
    </div>` : '';

  const weerBlok = weather ? `
    <div style="border-top:1px solid #E5E7EB;padding-top:20px;margin-top:4px;">
      <div style="font-size:10px;font-weight:700;letter-spacing:.1em;text-transform:uppercase;
                  color:#6B7280;margin-bottom:8px;">Weer Amsterdam</div>
      <div style="font-size:14px;color:#374151;">${weather.tekst}</div>
    </div>` : '';

  const focusBlok = focusTaak ? `
    <div style="background:#F9FAFB;border:1px solid #E5E7EB;border-radius:8px;
                padding:14px 16px;margin-bottom:24px;">
      <div style="font-size:10px;font-weight:700;letter-spacing:.1em;text-transform:uppercase;
                  color:#9CA3AF;margin-bottom:6px;">Begin hier mee</div>
      <div style="font-size:16px;font-weight:600;color:#111827;">${focusTaak.title}</div>
    </div>` : '';

  const voortgang = `
    <div style="border-top:1px solid #E5E7EB;padding-top:16px;margin-top:4px;margin-bottom:20px;">
      <div style="display:flex;justify-content:space-between;margin-bottom:6px;">
        <span style="font-size:12px;color:#9CA3AF;">Voortgang</span>
        <span style="font-size:12px;color:#9CA3AF;">${totalDone} / ${totalAll} afgerond</span>
      </div>
      <div style="background:#F3F4F6;border-radius:99px;height:4px;">
        <div style="background:#111827;width:${pct}%;height:4px;border-radius:99px;transition:width .3s;"></div>
      </div>
    </div>`;

  return `<!DOCTYPE html>
<html lang="nl">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
</head>
<body style="margin:0;padding:0;background:#F9FAFB;
             font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,sans-serif;">

  <div style="max-width:540px;margin:40px auto;background:#FFFFFF;
              border:1px solid #E5E7EB;border-radius:12px;overflow:hidden;">

    <!-- HEADER -->
    <div style="padding:32px 36px 24px;border-bottom:2px solid #111827;">
      <div style="font-size:11px;font-weight:600;letter-spacing:.12em;text-transform:uppercase;
                  color:#9CA3AF;margin-bottom:8px;">
        Takenlijst · ${formatLong(today)}
      </div>
      <div style="font-size:26px;font-weight:700;color:#111827;line-height:1.2;">
        Goedemorgen, Kees
      </div>
    </div>

    <!-- BODY -->
    <div style="padding:28px 36px 32px;">

      <!-- Intro -->
      <p style="margin:0 0 24px;font-size:15px;line-height:1.7;color:#374151;">${intro}</p>

      <!-- Focus -->
      ${focusBlok}

      <!-- Taken -->
      ${sectie('Vandaag', todayT)}
      ${sectie('Deze week', upcoming, true)}
      ${vergeetNiet.length ? sectie('Vergeet niet', vergeetNiet, true, '#DC2626', '#DC2626') : ''}

      <!-- Voortgang -->
      ${voortgang}

      <!-- Weer + Nieuws -->
      ${weerBlok}
      ${nieuws}

      <!-- CTA -->
      <div style="text-align:center;margin-top:28px;">
        <a href="https://keeshehenkamp.github.io/Taken-lijst/"
           style="display:inline-block;background:#111827;color:#FFFFFF;
                  text-decoration:none;padding:11px 28px;border-radius:6px;
                  font-size:14px;font-weight:600;letter-spacing:.02em;">
          Open takenlijst →
        </a>
      </div>
    </div>
  </div>

  <div style="text-align:center;padding:16px 0 32px;font-size:11px;color:#9CA3AF;">
    Automatisch verstuurd · Takenlijst-app
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
    console.log('Geen Firestore-data — e-mail overgeslagen.');
    process.exit(0);
  }
  const { tasks = [] } = snap.data();

  const weekStart    = addDays(today, -(dow === 0 ? 6 : dow - 1));
  const doneThisWeek = tasks.filter(t => t.done && t.updatedAt >= weekStart).length;
  const totalOpen    = tasks.filter(t => !t.done).length;

  const [weather, news] = await Promise.all([fetchWeather(), fetchNews()]);

  const intro = await generateIntro({ tasks, today, weather, dow, doneThisWeek, totalOpen });

  const html = buildEmail({ tasks, today, weather, news, dow, intro });

  const transporter = nodemailer.createTransport({
    host: 'smtp.gmail.com', port: 465, secure: true,
    auth: { user: process.env.GMAIL_USER, pass: process.env.GMAIL_APP_PASSWORD },
  });

  await transporter.sendMail({
    from:    `"Takenlijst" <${process.env.GMAIL_USER}>`,
    to:      process.env.RECIPIENT_EMAIL,
    subject: `Goedemorgen Kees — ${formatLong(today)}`,
    html,
  });

  console.log(`✓ E-mail verstuurd voor ${today}`);
}

main().catch(err => {
  console.error('Fout bij versturen:', err);
  process.exit(1);
});
