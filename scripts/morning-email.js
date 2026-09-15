/* morning-email.js — dagelijkse briefing via GitHub Actions */

const admin     = require('firebase-admin');
const nodemailer = require('nodemailer');
const Anthropic  = require('@anthropic-ai/sdk');

const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
const db     = admin.firestore();
const claude = new Anthropic.default({ apiKey: process.env.ANTHROPIC_API_KEY });

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

// ── Weer ────────────────────────────────────────────────────────

async function fetchWeather() {
  try {
    const res  = await fetch('https://wttr.in/Amsterdam?format=j1&lang=nl');
    const data = await res.json();
    const cur  = data.current_condition[0];
    const dag  = data.weather[0];

    const beschrijving = cur.lang_nl?.[0]?.value || cur.weatherDesc[0].value;
    const temp    = cur.temp_C;
    const feel    = cur.FeelsLikeC;
    const maxTemp = dag.maxtempC;
    const minTemp = dag.mintempC;

    const middag    = (dag.hourly || []).find(h => parseInt(h.time) >= 1200 && parseInt(h.time) <= 1500);
    const regenKans = middag ? parseInt(middag.chanceofrain) : 0;
    const regenTekst = regenKans >= 50 ? ` Vanmiddag ${regenKans}% kans op regen.`
                     : regenKans >= 25 ? ` Kleine kans op regen vanmiddag.`
                     : '';

    return `${beschrijving} — ${temp}°C (voelt als ${feel}°C). Min ${minTemp}° / max ${maxTemp}°.${regenTekst}`;
  } catch {
    return null;
  }
}

// ── Nieuws ──────────────────────────────────────────────────────

function parseFeed(xml, count) {
  const items = [];
  // Probeer zowel CDATA als plain text titels/beschrijvingen
  const re = /<item>([\s\S]*?)<\/item>/g;
  let m;
  while ((m = re.exec(xml)) !== null && items.length < count) {
    const block = m[1];
    const titleM = block.match(/<title>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?<\/title>/);
    const descM  = block.match(/<description>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?<\/description>/);
    if (!titleM) continue;
    const clean = s => s.replace(/<[^>]+>/g,'').replace(/&amp;/g,'&').replace(/&lt;/g,'<')
                        .replace(/&gt;/g,'>').replace(/&quot;/g,'"').replace(/&#39;/g,"'").trim();
    const title = clean(titleM[1]);
    const desc  = descM ? clean(descM[1]) : '';
    if (title && title.length > 5) items.push({ title, desc });
  }
  return items;
}

async function fetchNews() {
  const feeds = [
    { url: 'https://feeds.nos.nl/nosnieuwsalgemeen',   count: 3, label: 'Algemeen' },
    { url: 'https://feeds.nos.nl/nosnieuwsgezondheid',  count: 2, label: 'Gezondheid' },
  ];

  const results = await Promise.allSettled(
    feeds.map(async f => {
      const res  = await fetch(f.url, { signal: AbortSignal.timeout(8000) });
      const text = await res.text();
      return parseFeed(text, f.count).map(a => ({ ...a, label: f.label }));
    })
  );

  return results
    .filter(r => r.status === 'fulfilled')
    .flatMap(r => r.value)
    .filter(n => n.title);
}

// ── Claude: samenvatting per artikel ───────────────────────────

async function summarizeArticle(title, rawDesc) {
  if (!rawDesc || rawDesc.length < 40) return rawDesc || '';
  try {
    const res = await claude.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 120,
      messages: [{
        role: 'user',
        content: `Vat dit nieuwsartikel samen in maximaal 2 vloeiende zinnen in het Nederlands. Geen opsomming, gewoon leesbare tekst. Titel: "${title}". Tekst: "${rawDesc}"`,
      }],
    });
    return res.content[0].text.trim();
  } catch {
    return rawDesc.slice(0, 300);
  }
}

// ── Claude: persoonlijke intro ──────────────────────────────────

async function generateIntro({ tasks, today, weather, dow }) {
  const weekEnd  = addDays(today, 7);
  const dagNaam  = ['zondag','maandag','dinsdag','woensdag','donderdag','vrijdag','zaterdag'][dow];

  const overdue  = tasks.filter(t => !t.done && t.deadline && t.deadline < today);
  const todayT   = tasks.filter(t => !t.done && t.deadline === today);
  const upcoming = tasks.filter(t => !t.done && t.deadline && t.deadline > today && t.deadline <= weekEnd);
  const highPrio = tasks.filter(t => !t.done && t.priority === 'hoog');
  const totalOpen = tasks.filter(t => !t.done).length;

  const context = [
    `Het is ${dagNaam} ${formatLong(today)}.`,
    todayT.length    ? `Vandaag gepland: ${todayT.map(t=>t.title).join(', ')}.` : 'Niets concreet voor vandaag.',
    overdue.length   ? `Te laat: ${overdue.map(t=>t.title).join(', ')}.` : '',
    upcoming.length  ? `Komende week: ${upcoming.slice(0,3).map(t=>t.title).join(', ')}.` : '',
    highPrio.length  ? `Hoge prioriteit: ${highPrio.map(t=>t.title).join(', ')}.` : '',
    `Totaal open: ${totalOpen} taken.`,
    weather ? `Weer Amsterdam: ${weather}` : '',
  ].filter(Boolean).join(' ');

  try {
    const res = await claude.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 160,
      messages: [{
        role: 'user',
        content: `Schrijf een persoonlijke ochtendgroet voor Kees, coassistent kindergeneeskunde. Informeel, warm, concreet. Geen aanhef of afsluiting. 2-3 zinnen. Varieer in toon. Verwijs naar specifieke taken als relevant.\n\n${context}`,
      }],
    });
    return res.content[0].text.trim();
  } catch {
    return `Het is ${dagNaam} en je hebt ${totalOpen} open taken. Goed begin maken.`;
  }
}

// ── HTML (clean, typografisch, geen app-stijl) ──────────────────

function buildEmail({ tasks, today, weather, news, dow, intro }) {
  const weekEnd     = addDays(today, 7);
  const overdue     = sortTasks(tasks.filter(t => !t.done && t.deadline && t.deadline < today));
  const todayT      = sortTasks(tasks.filter(t => !t.done && t.deadline === today));
  const upcoming    = sortTasks(tasks.filter(t =>
    !t.done && t.deadline && t.deadline > today && t.deadline <= weekEnd));
  const highPrio    = sortTasks(tasks.filter(t =>
    !t.done && t.priority === 'hoog' &&
    !overdue.includes(t) && !todayT.includes(t) && !upcoming.includes(t)));
  const vergeetNiet = [...overdue, ...highPrio];
  const focusTaak   = todayT[0] || overdue[0] || highPrio[0] || null;

  const S = (label, items, rood = false) => {
    if (!items.length) return '';
    const kleur     = rood ? '#991B1B' : '#1C1C1C';
    const labelKleur = rood ? '#991B1B' : '#6B6B6B';
    return `
      <tr><td style="padding:20px 0 0;">
        <div style="font-size:10px;letter-spacing:.12em;text-transform:uppercase;
                    color:${labelKleur};font-weight:600;margin-bottom:10px;
                    font-family:Arial,Helvetica,sans-serif;">${label}</div>
        ${items.map(t => {
          const date = (t.deadline && t.deadline !== today)
            ? `<span style="color:#9E9E9E;font-size:12px;margin-left:8px;">${formatShort(t.deadline)}</span>` : '';
          return `<div style="padding:7px 0;border-bottom:1px solid #EBEBEB;
                              font-size:14px;color:${kleur};line-height:1.5;
                              font-family:Arial,Helvetica,sans-serif;">
            ${t.title}${date}
          </div>`;
        }).join('')}
      </td></tr>`;
  };

  const focusBlok = focusTaak ? `
    <tr><td style="padding:24px 0 0;">
      <div style="border-left:2px solid #1C1C1C;padding:10px 0 10px 16px;">
        <div style="font-size:10px;letter-spacing:.12em;text-transform:uppercase;
                    color:#6B6B6B;font-weight:600;margin-bottom:6px;
                    font-family:Arial,Helvetica,sans-serif;">Begin hier mee</div>
        <div style="font-size:16px;color:#1C1C1C;font-family:Arial,Helvetica,sans-serif;">${focusTaak.title}</div>
      </div>
    </td></tr>` : '';

  const weerBlok = weather ? `
    <tr><td style="padding:28px 0 0;">
      <div style="font-size:10px;letter-spacing:.12em;text-transform:uppercase;
                  color:#6B6B6B;font-weight:600;margin-bottom:8px;
                  font-family:Arial,Helvetica,sans-serif;">Weer in Amsterdam</div>
      <div style="font-size:14px;color:#3D3D3D;line-height:1.6;
                  font-family:Arial,Helvetica,sans-serif;">${weather}</div>
    </td></tr>` : '';

  const nieuwsBlok = news.length ? `
    <tr><td style="padding:28px 0 0;">
      <div style="font-size:10px;letter-spacing:.12em;text-transform:uppercase;
                  color:#6B6B6B;font-weight:600;margin-bottom:16px;
                  font-family:Arial,Helvetica,sans-serif;">Nieuws</div>
      ${news.map((n, i) => `
        <div style="margin-bottom:${i < news.length - 1 ? '18px' : '0'};
                    ${i > 0 ? 'padding-top:18px;border-top:1px solid #EBEBEB;' : ''}">
          <div style="font-size:15px;font-weight:700;color:#1C1C1C;line-height:1.35;
                      margin-bottom:5px;font-family:Arial,Helvetica,sans-serif;">${n.title}</div>
          ${n.summary ? `<div style="font-size:13px;color:#555;line-height:1.65;
                                     font-family:Arial,Helvetica,sans-serif;">${n.summary}</div>` : ''}
          <div style="font-size:11px;color:#9E9E9E;margin-top:4px;
                      font-family:Arial,Helvetica,sans-serif;">${n.label}</div>
        </div>`).join('')}
    </td></tr>` : '';

  return `<!DOCTYPE html>
<html lang="nl">
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#FFFFFF;">

  <div style="max-width:560px;margin:0 auto;padding:52px 32px 64px;">

    <!-- Datum -->
    <div style="font-size:11px;letter-spacing:.1em;text-transform:uppercase;color:#9E9E9E;
                margin-bottom:20px;font-family:Arial,Helvetica,sans-serif;font-weight:600;">
      ${formatLong(today)}
    </div>

    <!-- Naam -->
    <div style="font-size:36px;color:#1C1C1C;line-height:1.1;margin-bottom:6px;
                font-family:Georgia,'Times New Roman',Times,serif;font-weight:400;">
      Goedemorgen,<br>Kees.
    </div>

    <!-- Scheidingslijn -->
    <div style="height:1px;background:#1C1C1C;margin:28px 0;"></div>

    <!-- Intro -->
    <div style="font-size:15px;color:#3D3D3D;line-height:1.75;
                font-family:Arial,Helvetica,sans-serif;">
      ${intro}
    </div>

    <!-- Taken -->
    <table style="width:100%;border-collapse:collapse;">
      ${focusBlok}
      ${S('Vandaag', todayT)}
      ${S('Deze week', upcoming, false)}
      ${vergeetNiet.length ? S('Vergeet niet', vergeetNiet, true) : ''}
      ${weerBlok}
      ${nieuwsBlok}
    </table>

    <!-- Footer -->
    <div style="margin-top:48px;padding-top:20px;border-top:1px solid #EBEBEB;">
      <a href="https://keeshehenkamp.github.io/Taken-lijst/"
         style="font-size:13px;color:#9E9E9E;text-decoration:none;
                font-family:Arial,Helvetica,sans-serif;">
        Takenlijst openen →
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
  if (!snap.exists) { console.log('Geen data.'); process.exit(0); }
  const { tasks = [] } = snap.data();

  // Alles parallel ophalen
  const [weather, rawNews] = await Promise.all([fetchWeather(), fetchNews()]);

  // Artikelen samenvatten via Claude (parallel)
  const news = await Promise.all(
    rawNews.map(async n => ({
      ...n,
      summary: await summarizeArticle(n.title, n.desc),
    }))
  );

  const intro = await generateIntro({ tasks, today, weather, dow });
  const html  = buildEmail({ tasks, today, weather, news, dow, intro });

  const transporter = nodemailer.createTransport({
    host: 'smtp.gmail.com', port: 465, secure: true,
    auth: { user: process.env.GMAIL_USER, pass: process.env.GMAIL_APP_PASSWORD },
  });

  await transporter.sendMail({
    from:    `"Dagoverzicht" <${process.env.GMAIL_USER}>`,
    to:      process.env.RECIPIENT_EMAIL,
    subject: `${formatLong(today)}`,
    html,
  });

  console.log(`✓ Verstuurd voor ${today}`);
}

main().catch(err => { console.error(err); process.exit(1); });
