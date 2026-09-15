/* morning-email.js — dagelijkse briefing via GitHub Actions */

const admin      = require('firebase-admin');
const nodemailer = require('nodemailer');

// De SDK exporteert afhankelijk van de versie op verschillende manieren.
const SDK       = require('@anthropic-ai/sdk');
const Anthropic = SDK.Anthropic || SDK.default || SDK;

const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
const db = admin.firestore();

if (!process.env.ANTHROPIC_API_KEY) {
  console.warn('! ANTHROPIC_API_KEY ontbreekt — teksten vallen terug op sjablonen.');
}
const claude = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

const MODEL = 'claude-haiku-4-5-20251001';

// ── Datum ───────────────────────────────────────────────────────

const DAGEN  = ['zondag','maandag','dinsdag','woensdag','donderdag','vrijdag','zaterdag'];
const MAANDEN = ['januari','februari','maart','april','mei','juni','juli','augustus',
                 'september','oktober','november','december'];

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
  return `${DAGEN[new Date(y, m-1, d).getDay()]} ${d} ${MAANDEN[m-1]}`;
}

function formatShort(iso) {
  const [y, m, d] = iso.split('-').map(Number);
  const kort = ['zo','ma','di','wo','do','vr','za'][new Date(y, m-1, d).getDay()];
  return `${kort} ${d} ${MAANDEN[m-1].slice(0,3)}`;
}

function daysBetween(fromIso, toIso) {
  const a = new Date(fromIso.slice(0,10) + 'T12:00:00Z');
  const b = new Date(toIso.slice(0,10) + 'T12:00:00Z');
  return Math.round((b - a) / 86400000);
}

function sortTasks(tasks) {
  const rang = { hoog: 0, midden: 1, laag: 2 };
  return [...tasks].sort((a, b) => {
    const pa = rang[a.priority] ?? 99, pb = rang[b.priority] ?? 99;
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
    const res  = await fetch('https://wttr.in/Amsterdam?format=j1&lang=nl',
                             { signal: AbortSignal.timeout(8000) });
    const data = await res.json();
    const nu   = data.current_condition[0];
    const dag  = data.weather[0];

    const middag    = (dag.hourly || []).find(h => +h.time >= 1200 && +h.time <= 1500);
    const regenKans = middag ? +middag.chanceofrain : 0;

    return {
      beschrijving: nu.lang_nl?.[0]?.value || nu.weatherDesc[0].value,
      temp: nu.temp_C, feel: nu.FeelsLikeC,
      min: dag.mintempC, max: dag.maxtempC,
      regenKans,
    };
  } catch (e) {
    console.warn('Weer ophalen mislukt:', e.message);
    return null;
  }
}

// ── Nieuws ──────────────────────────────────────────────────────

function clean(s) {
  return s.replace(/<[^>]+>/g, '')
          .replace(/&amp;/g,'&').replace(/&lt;/g,'<').replace(/&gt;/g,'>')
          .replace(/&quot;/g,'"').replace(/&#39;/g,"'").replace(/&nbsp;/g,' ')
          .replace(/\s+/g,' ').trim();
}

async function fetchNews() {
  const urls = [
    'https://feeds.nos.nl/nosnieuwsalgemeen',
    'https://feeds.nos.nl/nosnieuwsgezondheid',
  ];

  const perFeed = await Promise.allSettled(urls.map(async url => {
    const res  = await fetch(url, { signal: AbortSignal.timeout(8000) });
    const xml  = await res.text();
    const out  = [];
    const re   = /<item>([\s\S]*?)<\/item>/g;
    let m;
    while ((m = re.exec(xml)) !== null) {
      const blok   = m[1];
      const titleM = blok.match(/<title>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?<\/title>/);
      const descM  = blok.match(/<description>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?<\/description>/);
      if (!titleM) continue;
      const title = clean(titleM[1]);
      if (title.length < 6) continue;
      out.push({ title, desc: descM ? clean(descM[1]) : '' });
    }
    return out;
  }));

  // Feeds afwisselend samenvoegen, dubbele titels eruit, max 3.
  const lijsten = perFeed.filter(r => r.status === 'fulfilled').map(r => r.value);
  const gemengd = [];
  for (let i = 0; i < 5; i++) {
    for (const lijst of lijsten) if (lijst[i]) gemengd.push(lijst[i]);
  }
  const gezien = new Set();
  return gemengd.filter(n => !gezien.has(n.title) && gezien.add(n.title)).slice(0, 3);
}

// ── Claude ──────────────────────────────────────────────────────

async function vraagClaude(prompt, maxTokens) {
  const res = await claude.messages.create({
    model: MODEL,
    max_tokens: maxTokens,
    messages: [{ role: 'user', content: prompt }],
  });
  return res.content[0].text.trim();
}

async function summarizeArticle({ title, desc }) {
  if (!desc || desc.length < 40) return desc;
  try {
    return await vraagClaude(
      `Vat dit nieuwsbericht samen in precies twee vloeiende Nederlandse zinnen. ` +
      `Geen opsomming, geen herhaling van de kop, geen inleidende woorden.\n\n` +
      `Kop: ${title}\nBericht: ${desc}`, 200);
  } catch (e) {
    console.warn('Samenvatten mislukt:', e.message);
    // Terugval: eerste twee zinnen in plaats van het hele bericht.
    return (desc.match(/[^.!?]+[.!?]+/g) || [desc]).slice(0, 2).join(' ').trim();
  }
}

/**
 * Zoekt wat er vandaag opvalt aan de lijst. Dit is het ruwe materiaal voor de
 * openingstekst: dingen die je aan de lijst zelf niet ziet.
 */
function signalen({ today, todayT, overdue, upcoming, blijftLiggen, afgerondRecent }) {
  const uit = [];

  if (overdue.length) {
    const ergste = overdue.reduce((a, b) =>
      daysBetween(a.deadline, today) > daysBetween(b.deadline, today) ? a : b);
    uit.push(`"${ergste.title}" is ${daysBetween(ergste.deadline, today)} dagen over de deadline.`);
  }
  if (blijftLiggen.length) {
    const oudste = blijftLiggen[0];
    uit.push(`"${oudste.title}" staat er al ${oudste.dagen} dagen in zonder deadline.`);
  }
  if (todayT.length >= 3) uit.push(`Er vallen ${todayT.length} deadlines op vandaag.`);
  if (!todayT.length && !overdue.length) uit.push('Vandaag staat er niets met een deadline.');
  if (!afgerondRecent) uit.push('De afgelopen zeven dagen is er niets afgevinkt.');

  // Meerdere taken op dezelfde dag verderop in de week.
  const perDag = {};
  upcoming.forEach(t => { perDag[t.deadline] = (perDag[t.deadline] || 0) + 1; });
  for (const [datum, n] of Object.entries(perDag)) {
    if (n >= 3) uit.push(`Op ${formatLong(datum)} vallen ${n} deadlines samen.`);
  }

  return uit;
}

async function schrijfDagtekst({ today, todayT, overdue, upcoming, blijftLiggen,
                                 afgerondRecent }) {
  const opvallend = signalen({ today, todayT, overdue, upcoming, blijftLiggen, afgerondRecent });

  const prompt =
    `Je schrijft de opening van een ochtendmail aan Kees, coassistent kindergeneeskunde.\n\n` +
    `Onder jouw tekst staat al een overzichtelijk lijstje met al zijn taken. ` +
    `Noem die taken dus NIET op en herhaal geen aantallen — dat leest hij zelf. ` +
    `Jouw taak is om het enige op te merken wat in dat lijstje niet te zien is.\n\n` +
    `Schrijf na "Goedemorgen Kees." één alinea van hooguit twee zinnen. ` +
    `Soms is één zin genoeg — op een dag zonder bijzonderheden mag je het kort houden.\n\n` +
    `Toon: nuchter, zoals een collega die even iets aanstipt. ` +
    `Geen aanmoediging, geen complimenten, geen uitroeptekens, geen "succes" of "lekker bezig". ` +
    `Geen inleidende voegwoorden als "daarnaast", "verder" of "kortom". ` +
    `Geen advies over hoe hij zijn dag moet indelen, tenzij het echt voor de hand ligt.\n\n` +
    `Schrijf niets over het weer — dat staat elders in de mail.\n\n` +
    (opvallend.length
      ? `Wat opvalt:\n${opvallend.map(s => `- ${s}`).join('\n')}\n\n`
      : `Er valt vandaag weinig op. Houd het dan bij één neutrale zin.\n\n`) +
    `Vandaag is het ${formatLong(today)}.`;

  try {
    return await vraagClaude(prompt, 250);
  } catch (e) {
    console.warn('Dagtekst mislukt:', e.message);
    return `Goedemorgen Kees.\n\n${opvallend[0] || 'Een dag zonder bijzonderheden.'}`;
  }
}

async function schrijfWeekterugblik({ today, afgerond, nogOpen, overdue }) {
  const feiten = [
    afgerond.length ? `Deze week afgerond: ${afgerond.map(t=>t.title).join('; ')}.`
                    : 'Deze week is er niets afgevinkt.',
    nogOpen.length  ? `Staat nog open: ${nogOpen.map(t=>t.title).join('; ')}.` : '',
    overdue.length  ? `Over de deadline: ${overdue.map(t=>t.title).join('; ')}.` : '',
  ].filter(Boolean).join('\n');

  try {
    return await vraagClaude(
      `Je schrijft de opening van de vrijdagmail aan Kees, coassistent kindergeneeskunde. ` +
      `Blik kort terug op zijn week: wat is er gelukt, wat bleef liggen.\n\n` +
      `Onder jouw tekst staat al een lijstje met de openstaande taken, dus som die niet op. ` +
      `Begin met "Goedemorgen Kees." en schrijf daarna hooguit drie zinnen.\n\n` +
      `Toon: nuchter en feitelijk, zoals iemand die de week even naloopt. ` +
      `Geen complimenten, geen aanmoediging, geen uitroeptekens, geen weekendwensen. ` +
      `Als er weinig is gebeurd, schrijf dat gewoon — verzin er geen positieve draai omheen.\n\n` +
      `Feiten:\n${feiten}`, 300);
  } catch (e) {
    console.warn('Terugblik mislukt:', e.message);
    return `Goedemorgen Kees.\n\nJe hebt deze week ${afgerond.length} taken afgerond.`;
  }
}

// ── HTML ────────────────────────────────────────────────────────

const SERIF = "Georgia,'Iowan Old Style','Times New Roman',Times,serif";

function alineas(tekst) {
  return tekst.split(/\n\s*\n/).map(p => `
    <p style="margin:0 0 18px;font-size:17px;line-height:1.72;color:#24231F;
              font-family:${SERIF};">${p.replace(/\n/g,' ').trim()}</p>`).join('');
}

function lijst(kop, regels) {
  if (!regels.length) return '';
  return `
    <p style="margin:26px 0 10px;font-size:15px;font-style:italic;color:#8A857B;
              font-family:${SERIF};">${kop}</p>
    ${regels.map(r => `
      <p style="margin:0 0 7px;font-size:16px;line-height:1.5;color:#24231F;
                font-family:${SERIF};">
        <span style="color:#B8B2A6;">—</span>&nbsp; ${r.tekst}${
          r.bij ? `<span style="color:#8A857B;font-size:14px;">&nbsp; ${r.bij}</span>` : ''}
      </p>`).join('')}`;
}

function buildEmail({ today, dagtekst, vandaag, dezeWeek, blijftLiggen, vergeetNiet,
                      weerRegel, news, preheader }) {
  return `<!DOCTYPE html>
<html lang="nl">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="color-scheme" content="light dark">
<meta name="supported-color-schemes" content="light dark">
</head>
<body style="margin:0;padding:0;background:#F2F0EB;">

  <div style="display:none;max-height:0;overflow:hidden;opacity:0;">${preheader}</div>

  <div style="max-width:600px;margin:0 auto;padding:44px 28px 56px;background:#FFFEFB;">

    <p style="margin:0 0 34px;font-size:14px;font-style:italic;color:#8A857B;
              font-family:${SERIF};">${formatLong(today)}</p>

    ${alineas(dagtekst)}

    ${lijst('Vandaag', vandaag)}
    ${lijst('Verder deze week', dezeWeek)}
    ${lijst('Vergeet niet', vergeetNiet)}
    ${lijst('Blijft liggen', blijftLiggen)}

    ${weerRegel ? `
      <p style="margin:30px 0 0;font-size:15px;line-height:1.6;color:#8A857B;
                font-family:${SERIF};font-style:italic;">${weerRegel}</p>` : ''}

    ${news.length ? `
      <div style="border-top:1px solid #E2DED5;margin-top:38px;padding-top:30px;">
        ${news.map(n => `
          <p style="margin:0 0 20px;font-size:16px;line-height:1.68;color:#3A3830;
                    font-family:${SERIF};">
            <span style="font-weight:bold;color:#24231F;">${n.title}</span><br>${n.summary}
          </p>`).join('')}
      </div>` : ''}

    <p style="margin:34px 0 0;">
      <a href="https://keeshehenkamp.github.io/Taken-lijst/"
         style="font-size:14px;font-style:italic;color:#8A857B;text-decoration:none;
                font-family:${SERIF};">je takenlijst openen</a>
    </p>

  </div>
</body>
</html>`;
}

// ── Hoofdprogramma ──────────────────────────────────────────────

/**
 * Bepaalt of deze aanloop de mail van vandaag moet versturen.
 * De workflow draait twee keer zodat 07:00 Amsterdam in zomer- én wintertijd
 * geraakt wordt; alleen de aanloop die er als eerste bij is doet het werk.
 * Een handmatige run via GitHub verstuurt altijd, voor het testen.
 */
async function magVersturen(today, marker) {
  if (process.env.GITHUB_EVENT_NAME === 'workflow_dispatch') return true;

  const uurNL = +new Date().toLocaleString('en-US',
    { timeZone: 'Europe/Amsterdam', hour: 'numeric', hour12: false });
  if (uurNL < 7) {
    console.log(`Nog geen zeven uur in Amsterdam (${uurNL}:00) — overgeslagen.`);
    return false;
  }

  const snap = await marker.get();
  if (snap.exists && snap.data().lastSent === today) {
    console.log('Vandaag al verstuurd — overgeslagen.');
    return false;
  }
  return true;
}

async function main() {
  const today = todayNL();
  const dow   = dayOfWeek(today);
  const isVrijdag = dow === 5;

  const marker = db.collection('meta').doc('morning-email');
  if (!await magVersturen(today, marker)) return;

  const snap = await db.collection('users').doc(process.env.USER_UID).get();
  if (!snap.exists) { console.log('Geen data — overgeslagen.'); return; }
  const { tasks = [] } = snap.data();

  const weekEnd   = addDays(today, 7);
  const weekStart = addDays(today, -(dow === 0 ? 6 : dow - 1));
  const open      = tasks.filter(t => !t.done);

  const overdue  = sortTasks(open.filter(t => t.deadline && t.deadline < today));
  const todayT   = sortTasks(open.filter(t => t.deadline === today));
  const upcoming = sortTasks(open.filter(t => t.deadline && t.deadline > today && t.deadline <= weekEnd));
  const highPrio = sortTasks(open.filter(t =>
    t.priority === 'hoog' && !overdue.includes(t) && !todayT.includes(t) && !upcoming.includes(t)));

  // Zonder deadline en ouder dan 14 dagen.
  const blijftLiggen = open
    .filter(t => !t.deadline && t.createdAt)
    .map(t => ({ ...t, dagen: daysBetween(t.createdAt, today) }))
    .filter(t => t.dagen >= 14)
    .sort((a, b) => b.dagen - a.dagen)
    .slice(0, 4);

  const [weather, rawNews] = await Promise.all([fetchWeather(), fetchNews()]);
  const news = await Promise.all(
    rawNews.map(async n => ({ ...n, summary: await summarizeArticle(n) }))
  );

  const zevenDagen    = addDays(today, -7);
  const afgerondRecent = tasks.some(t => t.done && t.doneAt && t.doneAt.slice(0,10) >= zevenDagen);

  const dagtekst = isVrijdag
    ? await schrijfWeekterugblik({
        today,
        afgerond: tasks.filter(t => t.done && t.doneAt && t.doneAt.slice(0,10) >= weekStart),
        nogOpen:  [...todayT, ...upcoming],
        overdue,
      })
    : await schrijfDagtekst({ today, todayT, overdue, upcoming, blijftLiggen, afgerondRecent });

  const weerRegel = weather
    ? `${weather.beschrijving}, nu ${weather.temp}° en vanmiddag tot ${weather.max}°` +
      `${weather.regenKans >= 40 ? `, ${weather.regenKans}% kans op regen` : ''}.`
    : '';

  const html = buildEmail({
    today,
    dagtekst,
    weerRegel,
    vandaag:     todayT.map(t => ({ tekst: t.title, bij: '' })),
    dezeWeek:    upcoming.map(t => ({ tekst: t.title, bij: formatShort(t.deadline) })),
    vergeetNiet: [...overdue, ...highPrio].map(t => ({
      tekst: t.title,
      bij:   t.deadline ? `${daysBetween(t.deadline, today)} dagen te laat` : 'hoge prioriteit',
    })),
    blijftLiggen: blijftLiggen.map(t => ({ tekst: t.title, bij: `${t.dagen} dagen` })),
    news,
    preheader: todayT.length
      ? `${todayT[0].title}${todayT.length > 1 ? ` en ${todayT.length - 1} andere` : ''}`
      : (overdue.length ? `${overdue.length} taken over de deadline` : 'Niets gepland vandaag'),
  });

  const onderwerp = isVrijdag
    ? `De week van ${formatShort(weekStart)}`
    : todayT.length
      ? `${todayT.length} ${todayT.length === 1 ? 'taak' : 'taken'} — ${todayT[0].title}`
      : (overdue.length ? `${overdue.length} taken over de deadline` : 'Niets gepland vandaag');

  await nodemailer.createTransport({
    host: 'smtp.gmail.com', port: 465, secure: true,
    auth: { user: process.env.GMAIL_USER, pass: process.env.GMAIL_APP_PASSWORD },
  }).sendMail({
    from:    `"Ochtend" <${process.env.GMAIL_USER}>`,
    to:      process.env.RECIPIENT_EMAIL,
    subject: onderwerp,
    html,
  });

  await marker.set({ lastSent: today });
  console.log(`✓ Verstuurd voor ${today} — ${news.length} artikelen`);
}

main()
  .then(() => process.exit(0))
  .catch(err => { console.error('Mislukt:', err); process.exit(1); });
