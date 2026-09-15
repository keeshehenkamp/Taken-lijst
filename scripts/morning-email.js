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
    const desc = descM
      ? descM[1].replace(/<[^>]+>/g, '').replace(/&amp;/g,'&').replace(/&lt;/g,'<').replace(/&gt;/g,'>').trim()
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
  const weekEnd = addDays(today, 7);

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
  const focusTaak   = todayT[0] || overdue[0] || highPrio[0] || null;

  const taakregel = (t, showDate = false, rood = false) => {
    const date = showDate && t.deadline && t.deadline !== today
      ? `<span style="font-size:12px;color:#A3A3A3;margin-left:6px;">${formatShort(t.deadline)}</span>` : '';
    const kleur = rood ? '#B91C1C' : '#262626';
    return `
      <tr>
        <td style="padding:9px 0;border-bottom:1px solid #F5F5F5;vertical-align:top;">
          <span style="font-size:14px;color:${kleur};line-height:1.5;">${t.title}${date}</span>
        </td>
      </tr>`;
  };

  const sectie = (kop, items, showDate = false, rood = false) => {
    if (!items.length) return '';
    return `
      <div style="margin-bottom:24px;">
        <div style="font-size:11px;font-weight:600;color:${rood ? '#B91C1C' : '#A3A3A3'};
                    letter-spacing:.08em;text-transform:uppercase;margin-bottom:10px;">${kop}</div>
        <table style="width:100%;border-collapse:collapse;">
          ${items.map(t => taakregel(t, showDate, rood)).join('')}
        </table>
      </div>`;
  };

  const focusBlok = focusTaak ? `
    <div style="margin-bottom:28px;padding:16px 20px;background:#FAFAFA;border-radius:6px;">
      <div style="font-size:11px;font-weight:600;letter-spacing:.08em;text-transform:uppercase;
                  color:#A3A3A3;margin-bottom:6px;">Begin hier mee</div>
      <div style="font-size:16px;font-weight:500;color:#171717;">${focusTaak.title}</div>
    </div>` : '';

  const weerBlok = weather ? `
    <div style="padding-top:20px;margin-top:20px;border-top:1px solid #F5F5F5;">
      <div style="font-size:11px;font-weight:600;letter-spacing:.08em;text-transform:uppercase;
                  color:#A3A3A3;margin-bottom:8px;">Weer in Amsterdam</div>
      <div style="font-size:14px;color:#525252;line-height:1.6;">${weather.tekst}</div>
    </div>` : '';

  const nieuwsBlok = news.length ? `
    <div style="padding-top:20px;margin-top:20px;border-top:1px solid #F5F5F5;">
      <div style="font-size:11px;font-weight:600;letter-spacing:.08em;text-transform:uppercase;
                  color:#A3A3A3;margin-bottom:14px;">Nieuws</div>
      ${news.map((n, i) => `
        <div style="margin-bottom:${i < news.length - 1 ? '16px' : '0'};">
          <div style="font-size:14px;font-weight:600;color:#171717;line-height:1.4;margin-bottom:3px;">${n.title}</div>
          ${n.desc ? `<div style="font-size:13px;color:#737373;line-height:1.55;">${n.desc}</div>` : ''}
        </div>`).join('')}
    </div>` : '';

  return `<!DOCTYPE html>
<html lang="nl">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
</head>
<body style="margin:0;padding:0;background:#FFFFFF;
             font-family:Georgia,'Times New Roman',serif;">

  <div style="max-width:520px;margin:0 auto;padding:48px 24px 64px;">

    <!-- DATUM + NAAM -->
    <div style="font-family:-apple-system,BlinkMacSystemFont,'Helvetica Neue',sans-serif;
                font-size:11px;font-weight:500;letter-spacing:.1em;text-transform:uppercase;
                color:#A3A3A3;margin-bottom:12px;">
      ${formatLong(today)}
    </div>

    <div style="font-family:Georgia,'Times New Roman',serif;
                font-size:32px;font-weight:400;color:#171717;
                line-height:1.15;margin-bottom:4px;">
      Goedemorgen,<br>Kees.
    </div>

    <div style="height:1px;background:#E5E5E5;margin:24px 0;"></div>

    <!-- INTRO -->
    <p style="font-family:-apple-system,BlinkMacSystemFont,'Helvetica Neue',sans-serif;
              font-size:15px;line-height:1.75;color:#404040;margin:0 0 28px;">${intro}</p>

    <!-- FOCUS -->
    ${focusBlok}

    <!-- TAKEN -->
    <div style="font-family:-apple-system,BlinkMacSystemFont,'Helvetica Neue',sans-serif;">
      ${sectie('Vandaag', todayT)}
      ${sectie('Deze week', upcoming, true)}
      ${vergeetNiet.length ? sectie('Vergeet niet', vergeetNiet, true, true) : ''}
    </div>

    <!-- DIVIDER -->
    <div style="height:1px;background:#E5E5E5;margin:4px 0;"></div>

    <!-- WEER + NIEUWS -->
    <div style="font-family:-apple-system,BlinkMacSystemFont,'Helvetica Neue',sans-serif;">
      ${weerBlok}
      ${nieuwsBlok}
    </div>

    <!-- CTA -->
    <div style="margin-top:36px;">
      <a href="https://keeshehenkamp.github.io/Taken-lijst/"
         style="font-family:-apple-system,BlinkMacSystemFont,'Helvetica Neue',sans-serif;
                font-size:13px;color:#A3A3A3;text-decoration:underline;">
        Open takenlijst →
      </a>
    </div>

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
