/* morning-email.js — dagelijkse ochtendmail via GitHub Actions
 *
 * Opbouw van de mail: begroeting, Taken, Weer, Nieuws.
 * Lokaal bekijken zonder iets te versturen:  PREVIEW=1 node morning-email.js
 * (schrijft preview.html met voorbeeldtaken).
 */

const PREVIEW = process.env.PREVIEW === '1';
const MODEL   = process.env.ANTHROPIC_MODEL || 'claude-haiku-4-5-20251001';
const WEER_PLAATS = process.env.WEER_PLAATS || 'Amsterdam';
const APP_URL = 'https://keeshehenkamp.github.io/Taken-lijst/';

// Meldingen over onderdelen die mislukten; komen onderaan de mail te staan,
// zodat een storing niet ongemerkt blijft.
const storingen = [];

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
  const [, m, d] = iso.split('-').map(Number);
  return `${DAGEN[dayOfWeek(iso)]} ${d} ${MAANDEN[m-1]}`;
}
function formatShort(iso) {
  const [, m, d] = iso.split('-').map(Number);
  return `${DAGEN[dayOfWeek(iso)].slice(0,2)} ${d} ${MAANDEN[m-1].slice(0,3)}`;
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
const dagen = n => `${n} ${n === 1 ? 'dag' : 'dagen'}`;
const taken = n => `${n} ${n === 1 ? 'taak' : 'taken'}`;

function esc(s) {
  return String(s ?? '').replace(/&/g,'&amp;').replace(/</g,'&lt;')
                        .replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

// ── Weer ────────────────────────────────────────────────────────

function weerIcoon(code) {
  code = +code;
  if (code === 113) return '☀️';
  if (code === 116) return '⛅';
  if (code === 119 || code === 122) return '☁️';
  if ([143, 248, 260].includes(code)) return '🌫️';
  if ([200, 386, 389, 392, 395].includes(code)) return '⛈️';
  if ([179, 182, 185, 227, 230, 281, 284, 311, 314, 317, 320, 323, 326, 329, 332,
       335, 338, 350, 362, 365, 368, 371, 374, 377].includes(code)) return '🌨️';
  return '🌧️';
}

async function fetchWeather() {
  try {
    const res  = await fetch(`https://wttr.in/${encodeURIComponent(WEER_PLAATS)}?format=j1&lang=nl`,
                             { signal: AbortSignal.timeout(8000) });
    const data = await res.json();
    const nu   = data.current_condition[0];
    const dag  = data.weather[0];
    const uur  = t => (dag.hourly || []).find(h => +h.time === t);
    const deel = (naam, t) => {
      const h = uur(t);
      return h && { naam, icoon: weerIcoon(h.weatherCode), temp: h.tempC, regen: +h.chanceofrain };
    };
    return {
      plaats: WEER_PLAATS,
      icoon: weerIcoon(nu.weatherCode),
      beschrijving: nu.lang_nl?.[0]?.value || nu.weatherDesc[0].value,
      temp: nu.temp_C, min: dag.mintempC, max: dag.maxtempC,
      wind: nu.windspeedKmph,
      delen: [deel('Ochtend', 900), deel('Middag', 1500), deel('Avond', 2100)].filter(Boolean),
    };
  } catch (e) {
    if (PREVIEW) return {
      plaats: WEER_PLAATS, icoon: '☁️', beschrijving: 'Geheel bewolkt', temp: 16, min: 12, max: 22, wind: 14,
      delen: [{ naam:'Ochtend', icoon:'☁️', temp:15, regen:10 },
              { naam:'Middag',  icoon:'⛅', temp:22, regen:20 },
              { naam:'Avond',   icoon:'🌧️', temp:17, regen:65 }],
    };
    storingen.push(`Weer ophalen mislukt: ${e.message}`);
    return null;
  }
}

// ── Nieuws ──────────────────────────────────────────────────────

function clean(s) {
  return s.replace(/<[^>]+>/g, ' ')
          .replace(/&amp;/g,'&').replace(/&lt;/g,'<').replace(/&gt;/g,'>')
          .replace(/&quot;/g,'"').replace(/&#39;/g,"'").replace(/&nbsp;/g,' ')
          .replace(/\s+/g,' ').trim();
}

/** Eerste n hele zinnen. Een punt telt alleen als zinseinde wanneer er een
 *  spatie en een hoofdletter op volgen, zodat "170.000" heel blijft. */
function eersteZinnen(tekst, n) {
  const zinnen = tekst.split(/(?<=[.!?])\s+(?=[A-ZÀ-Ý'"‘“])/);
  return zinnen.slice(0, n).join(' ').trim();
}

async function fetchNews() {
  const urls = [
    'https://feeds.nos.nl/nosnieuwsalgemeen',
    'https://feeds.nos.nl/nosnieuwsgezondheid',
  ];
  const perFeed = await Promise.allSettled(urls.map(async url => {
    const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
    const xml = await res.text();
    const out = [];
    const re  = /<item>([\s\S]*?)<\/item>/g;
    let m;
    while ((m = re.exec(xml)) !== null) {
      const blok   = m[1];
      const veld   = naam => blok.match(
        new RegExp(`<${naam}>(?:<!\\[CDATA\\[)?([\\s\\S]*?)(?:\\]\\]>)?<\\/${naam}>`));
      const titleM = veld('title');
      if (!titleM) continue;
      const title = clean(titleM[1]);
      if (title.length < 6) continue;
      const descM = veld('description'), linkM = veld('link');
      const imgM  = blok.match(/<enclosure[^>]*url="([^"]+)"/);
      out.push({
        title,
        summary: descM ? eersteZinnen(clean(descM[1]), 2) : '',
        link: linkM ? clean(linkM[1]) : 'https://nos.nl',
        image: imgM ? imgM[1].replace(/&amp;/g, '&') : '',
      });
    }
    return out;
  }));

  const lijsten = perFeed.filter(r => r.status === 'fulfilled').map(r => r.value);
  if (!lijsten.length || !lijsten.some(l => l.length)) {
    if (PREVIEW) return [
      { title: 'Voorbeeldkop van het belangrijkste nieuws van vanochtend', link: 'https://nos.nl', image: '',
        summary: 'Dit is een voorbeeldtekst van twee zinnen. In de echte mail staat hier de inleiding van het NOS-bericht.' },
      { title: 'Tweede voorbeeldkop, wat korter', link: 'https://nos.nl', image: '',
        summary: 'Het aantal komt uit op bijna 170.000 per jaar. Getallen met een punt blijven nu heel.' },
      { title: 'Derde voorbeeldkop uit de gezondheidsrubriek', link: 'https://nos.nl', image: '',
        summary: 'Korte samenvatting van het derde bericht.' },
    ];
    storingen.push('Nieuws ophalen mislukt.');
    return [];
  }
  const gemengd = [];
  for (let i = 0; i < 5; i++) for (const lijst of lijsten) if (lijst[i]) gemengd.push(lijst[i]);
  const gezien = new Set();
  return gemengd.filter(n => !gezien.has(n.title) && gezien.add(n.title)).slice(0, 4);
}

// ── Openingstekst door Claude ───────────────────────────────────

async function vraagClaude(prompt, maxTokens) {
  if (!process.env.ANTHROPIC_API_KEY) throw new Error('ANTHROPIC_API_KEY ontbreekt');
  const SDK       = require('@anthropic-ai/sdk');
  const Anthropic = SDK.Anthropic || SDK.default || SDK;
  const claude    = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  const res = await claude.messages.create({
    model: MODEL, max_tokens: maxTokens,
    messages: [{ role: 'user', content: prompt }],
  });
  return res.content[0].text.trim();
}

const TOON =
  `Toon: nuchter en feitelijk, zoals een collega die even iets aanstipt. ` +
  `Geen aanmoediging, geen complimenten, geen uitroeptekens, geen advies. ` +
  `Schrijf niets over het weer of het nieuws; dat staat elders in de mail. ` +
  `Begin niet met een begroeting; die staat er al boven.`;

async function schrijfOpening(g) {
  const regels = (kop, lijst, bij) => lijst.length
    ? `${kop}:\n${lijst.map(t => `- ${t.title}${bij ? ` (${bij(t)})` : ''}`).join('\n')}\n` : '';
  const feiten =
    regels('Vandaag', g.todayT) +
    regels('Verder deze week', g.upcoming, t => formatLong(t.deadline)) +
    regels('Kort over de deadline', g.overdueRecent, t => `${dagen(daysBetween(t.deadline, g.today))} te laat`) +
    (g.overdueOud.length ? `Staat al langer dan een week open: ${g.overdueOud.length} taken.\n` : '') +
    (g.afgerond.length ? `Afgelopen zeven dagen afgerond: ${g.afgerond.map(t => t.title).join('; ')}.\n`
                       : 'Afgelopen zeven dagen is er niets afgevinkt.\n');

  const opdracht = g.isVrijdag
    ? `Blik in hooguit drie zinnen terug op zijn week: wat is er gelukt en wat bleef liggen.`
    : `Schrijf hooguit twee zinnen over wat er vandaag toe doet. Onder jouw tekst staat het ` +
      `volledige takenoverzicht, dus som de taken niet op en herhaal geen aantallen. ` +
      `Begin niet elke dag over de taken die al weken openstaan; noem die alleen op maandag. ` +
      `Is er weinig bijzonders, dan is één korte zin genoeg.`;

  const noodtekst = g.todayT.length
    ? `Vandaag ${g.todayT.length === 1 ? 'staat er één taak' : `staan er ${g.todayT.length} taken`} op de planning.`
    : 'Vandaag staat er niets met een deadline.';
  if (PREVIEW) return noodtekst;

  try {
    return await vraagClaude(
      `Je schrijft de korte opening van de ochtendmail aan Kees, coassistent kindergeneeskunde. ` +
      `${opdracht}\n\n${TOON}\n\nVandaag is het ${formatLong(g.today)}.\n\n${feiten}`, 300);
  } catch (e) {
    storingen.push(`De openingstekst kon niet door Claude geschreven worden (${e.status || ''} ${e.message}).`.replace('( ', '('));
    return noodtekst;
  }
}

// ── HTML ────────────────────────────────────────────────────────

const FONT = "-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif";
const K = { tekst:'#1A1D21', zacht:'#667085', lijn:'#E4E7EC', vlak:'#F2F4F7',
            rood:'#D92D20', oranje:'#DC6803', groen:'#079455', blauw:'#1570EF', nieuws:'#E3120B' };

const kaart = inhoud => `
  <tr><td style="padding:0 0 16px;">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0"
           style="background:#FFFFFF;border:1px solid ${K.lijn};border-radius:12px;">
      <tr><td style="padding:22px 24px;">${inhoud}</td></tr>
    </table>
  </td></tr>`;

const sectieKop = (titel, rechts = '') => `
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr>
    <td style="font:700 12px ${FONT};letter-spacing:1.2px;text-transform:uppercase;color:${K.zacht};">${titel}</td>
    <td align="right" style="font:400 12px ${FONT};color:${K.zacht};">${rechts}</td>
  </tr></table>`;

function taakGroep(kop, kleur, rijen) {
  if (!rijen.length) return '';
  return `
    <p style="margin:18px 0 6px;font:700 15px ${FONT};color:${K.tekst};">
      <span style="color:${kleur};">●</span>&nbsp; ${kop}
      <span style="font-weight:400;color:${K.zacht};">&nbsp;${rijen.length}</span>
    </p>
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
      ${rijen.map(r => `
      <tr>
        <td style="padding:9px 0;border-top:1px solid ${K.lijn};font:400 16px/1.4 ${FONT};color:${K.tekst};">
          ${esc(r.titel)}${r.hoog ? ` <span style="font:700 11px ${FONT};color:${K.rood};">&nbsp;HOOG</span>` : ''}
        </td>
        <td align="right" valign="top" style="padding:11px 0 9px 12px;border-top:1px solid ${K.lijn};
            font:400 13px ${FONT};color:${r.kleur || K.zacht};white-space:nowrap;">${esc(r.bij || '')}</td>
      </tr>`).join('')}
    </table>`;
}

function takenSectie(g) {
  const rij = (t, bij, kleur) => ({ titel: t.title, hoog: t.priority === 'hoog', bij, kleur });
  const groepen =
    taakGroep('Vandaag', K.blauw, g.todayT.map(t => rij(t, ''))) +
    taakGroep('Te laat', K.rood, g.overdueToon.map(t =>
      rij(t, `${dagen(daysBetween(t.deadline, g.today))} te laat`, K.rood))) +
    taakGroep('Deze week', K.groen, g.upcoming.map(t => rij(t, formatShort(t.deadline)))) +
    taakGroep('Hoge prioriteit, geen deadline', K.oranje, g.highPrio.map(t => rij(t, ''))) +
    taakGroep('Blijft liggen', K.zacht, g.blijftLiggen.map(t => rij(t, `${dagen(t.dagen)} oud`)));

  const oud = g.overdueVerborgen.length ? `
    <p style="margin:16px 0 0;padding:12px 14px;background:${K.vlak};border-radius:8px;
              font:400 14px/1.5 ${FONT};color:${K.zacht};">
      <strong style="color:${K.tekst};">${taken(g.overdueVerborgen.length)} al langer dan een week te laat:</strong>
      ${g.overdueVerborgen.map(t => esc(t.title)).join(' · ')}
    </p>` : '';

  const leeg = !groepen && !oud
    ? `<p style="margin:14px 0 0;font:400 16px ${FONT};color:${K.zacht};">Geen openstaande taken met een deadline.</p>` : '';

  return kaart(`
    ${sectieKop('Taken', `<a href="${APP_URL}" style="color:${K.blauw};text-decoration:none;">Takenlijst openen</a>`)}
    ${groepen}${oud}${leeg}`);
}

function weerSectie(w) {
  if (!w) return '';
  return kaart(`
    ${sectieKop('Weer', esc(w.plaats))}
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin-top:12px;"><tr>
      <td width="64" style="font-size:46px;line-height:1;">${w.icoon}</td>
      <td>
        <div style="font:700 30px ${FONT};color:${K.tekst};">${w.temp}°</div>
        <div style="font:400 14px ${FONT};color:${K.zacht};">${esc(w.beschrijving)} · ${w.min}° tot ${w.max}° · wind ${w.wind} km/u</div>
      </td>
    </tr></table>
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin-top:16px;"><tr>
      ${w.delen.map(d => `
      <td align="center" width="${Math.floor(100 / w.delen.length)}%"
          style="padding:12px 4px;background:${K.vlak};border:3px solid #FFFFFF;border-radius:10px;">
        <div style="font:700 12px ${FONT};color:${K.zacht};text-transform:uppercase;letter-spacing:.8px;">${d.naam}</div>
        <div style="font-size:28px;line-height:1.5;">${d.icoon}</div>
        <div style="font:700 17px ${FONT};color:${K.tekst};">${d.temp}°</div>
        <div style="font:400 12px ${FONT};color:${d.regen >= 40 ? K.blauw : K.zacht};">💧 ${d.regen}%</div>
      </td>`).join('')}
    </tr></table>`);
}

function nieuwsSectie(news) {
  if (!news.length) return '';
  const [kop, ...rest] = news;
  return `
  <tr><td style="padding:0 0 16px;">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0"
           style="background:#FFFFFF;border:1px solid ${K.lijn};border-radius:12px;overflow:hidden;">
      <tr><td style="background:${K.nieuws};padding:10px 24px;font:700 13px ${FONT};letter-spacing:1.2px;
                     text-transform:uppercase;color:#FFFFFF;">Nieuws
        <span style="font-weight:400;letter-spacing:0;text-transform:none;opacity:.85;">&nbsp;· bron: NOS</span></td></tr>
      ${kop.image ? `<tr><td><a href="${esc(kop.link)}"><img src="${esc(kop.image)}" width="600" alt=""
           style="display:block;width:100%;height:auto;border:0;"></a></td></tr>` : ''}
      <tr><td style="padding:18px 24px 6px;">
        <a href="${esc(kop.link)}" style="font:800 22px/1.25 ${FONT};color:${K.tekst};text-decoration:none;">${esc(kop.title)}</a>
        <p style="margin:8px 0 12px;font:400 15px/1.55 ${FONT};color:#344054;">${esc(kop.summary)}</p>
      </td></tr>
      ${rest.map(n => `
      <tr><td style="padding:0 24px;">
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0"
               style="border-top:1px solid ${K.lijn};"><tr>
          ${n.image ? `<td width="112" valign="top" style="padding:14px 14px 14px 0;">
            <a href="${esc(n.link)}"><img src="${esc(n.image)}" width="112" alt=""
               style="display:block;width:112px;height:auto;border:0;border-radius:6px;"></a></td>` : ''}
          <td valign="top" style="padding:14px 0;">
            <a href="${esc(n.link)}" style="font:700 16px/1.3 ${FONT};color:${K.tekst};text-decoration:none;">${esc(n.title)}</a>
            <p style="margin:5px 0 0;font:400 14px/1.5 ${FONT};color:${K.zacht};">${esc(n.summary)}</p>
          </td>
        </tr></table>
      </td></tr>`).join('')}
      <tr><td style="height:8px;"></td></tr>
    </table>
  </td></tr>`;
}

function buildEmail({ g, opening, weather, news, preheader }) {
  return `<!DOCTYPE html>
<html lang="nl">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="color-scheme" content="light">
</head>
<body style="margin:0;padding:0;background:${K.vlak};">
  <div style="display:none;max-height:0;overflow:hidden;opacity:0;">${esc(preheader)}</div>
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${K.vlak};">
  <tr><td align="center" style="padding:24px 12px 40px;">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:600px;">
      <tr><td style="padding:8px 8px 22px;">
        <div style="font:700 12px ${FONT};letter-spacing:1.2px;text-transform:uppercase;color:${K.zacht};">${formatLong(g.today)}</div>
        <div style="margin-top:6px;font:800 28px/1.2 ${FONT};color:${K.tekst};">Goedemorgen Kees</div>
        <p style="margin:10px 0 0;font:400 17px/1.55 ${FONT};color:#344054;">${esc(opening)}</p>
      </td></tr>
      ${takenSectie(g)}
      ${weerSectie(weather)}
      ${nieuwsSectie(news)}
      ${storingen.length ? `<tr><td style="padding:4px 8px;font:400 12px/1.5 ${FONT};color:${K.oranje};">
        Let op: ${storingen.map(esc).join(' ')}</td></tr>` : ''}
    </table>
  </td></tr>
  </table>
</body>
</html>`;
}

// ── Hoofdprogramma ──────────────────────────────────────────────

/** Meerdere geplande aanlopen per ochtend; alleen de eerste na 04:00 NL
 *  verstuurt. Een handmatige run via GitHub verstuurt altijd. */
async function magVersturen(today, marker) {
  if (process.env.GITHUB_EVENT_NAME === 'workflow_dispatch') return true;
  const uurNL = +new Date().toLocaleString('en-US',
    { timeZone: 'Europe/Amsterdam', hour: 'numeric', hour12: false });
  if (uurNL < 4) { console.log(`Nog geen vier uur in Amsterdam (${uurNL}:00) — overgeslagen.`); return false; }
  const snap = await marker.get();
  if (snap.exists && snap.data().lastSent === today) { console.log('Vandaag al verstuurd — overgeslagen.'); return false; }
  return true;
}

function groepeer(tasks, today) {
  const dow     = dayOfWeek(today);
  const weekEnd = addDays(today, 7);
  const open    = tasks.filter(t => !t.done);

  const overdue  = sortTasks(open.filter(t => t.deadline && t.deadline < today));
  const todayT   = sortTasks(open.filter(t => t.deadline === today));
  const upcoming = sortTasks(open.filter(t => t.deadline && t.deadline > today && t.deadline <= weekEnd))
                     .sort((a, b) => a.deadline.localeCompare(b.deadline));
  const highPrio = sortTasks(open.filter(t => t.priority === 'hoog' && !t.deadline));

  // Taken die meer dan een week te laat zijn, staan alleen op maandag voluit
  // in de lijst; op andere dagen als één samenvattende regel.
  const overdueRecent = overdue.filter(t => daysBetween(t.deadline, today) <= 7);
  const overdueOud    = overdue.filter(t => daysBetween(t.deadline, today) > 7);
  const maandag       = dow === 1;

  const blijftLiggen = open
    .filter(t => !t.deadline && t.createdAt && t.priority !== 'hoog')
    .map(t => ({ ...t, dagen: daysBetween(t.createdAt, today) }))
    .filter(t => t.dagen >= 14)
    .sort((a, b) => b.dagen - a.dagen)
    .slice(0, 4);

  const zevenDagen = addDays(today, -7);
  const afgerond   = tasks.filter(t => t.done && t.doneAt && t.doneAt.slice(0,10) >= zevenDagen);

  return { today, isVrijdag: dow === 5, todayT, upcoming, highPrio, blijftLiggen, afgerond,
           overdue, overdueRecent, overdueOud,
           overdueToon:      maandag ? overdue : overdueRecent,
           overdueVerborgen: maandag ? [] : overdueOud };
}

function voorbeeldTaken(today) {
  return [
    { title: 'Onderzoeken afspraak Liron', deadline: today },
    { title: 'Verslag poli inleveren', deadline: addDays(today, -2), priority: 'hoog' },
    { title: 'Presentatie voorbereiden', deadline: addDays(today, 3) },
    { title: 'Boek terugbrengen', deadline: addDays(today, 5) },
    { title: 'FKR kindergeneeskunde afmaken', deadline: addDays(today, -22) },
    { title: 'Checken bijwerkingen opdracht', deadline: addDays(today, -22) },
    { title: 'Laten weten aan Marjanne en Carolyn', deadline: addDays(today, -25) },
    { title: 'Pak bij Pelger opnieuw opmeten', createdAt: addDays(today, -136) },
  ];
}

async function main() {
  const today = todayNL();
  let db, marker, tasks;

  if (PREVIEW) {
    tasks = voorbeeldTaken(today);
  } else {
    const admin = require('firebase-admin');
    admin.initializeApp({ credential: admin.credential.cert(JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT)) });
    db     = admin.firestore();
    marker = db.collection('meta').doc('morning-email');
    if (!await magVersturen(today, marker)) return;
    const snap = await db.collection('users').doc(process.env.USER_UID).get();
    if (!snap.exists) { console.log('Geen data — overgeslagen.'); return; }
    tasks = snap.data().tasks || [];
  }

  const g = groepeer(tasks, today);
  const [weather, news, opening] = await Promise.all([fetchWeather(), fetchNews(), schrijfOpening(g)]);

  // Onderwerp en voorvertoning komen uit dezelfde telling, zodat ze altijd kloppen.
  const delen = [];
  if (g.todayT.length)  delen.push(`${taken(g.todayT.length)} vandaag`);
  if (g.overdue.length) delen.push(`${g.overdue.length} te laat`);
  const onderwerp = `${formatShort(today)} — ${delen.join(', ') || 'niets gepland'}`;
  const preheader = g.todayT.length ? g.todayT.map(t => t.title).join(' · ') : opening;

  const html = buildEmail({ g, opening, weather, news, preheader });

  if (PREVIEW) {
    require('fs').writeFileSync('preview.html', html);
    console.log(`Voorbeeld geschreven naar preview.html — onderwerp: ${onderwerp}`);
    return;
  }

  const nodemailer = require('nodemailer');
  await nodemailer.createTransport({
    host: 'smtp.gmail.com', port: 465, secure: true,
    auth: { user: process.env.GMAIL_USER, pass: process.env.GMAIL_APP_PASSWORD },
  }).sendMail({
    from: `"Ochtend" <${process.env.GMAIL_USER}>`,
    to: process.env.RECIPIENT_EMAIL,
    subject: onderwerp,
    html,
  });

  await marker.set({ lastSent: today });
  console.log(`✓ Verstuurd voor ${today} — ${news.length} artikelen` +
              (storingen.length ? ` — storingen: ${storingen.join(' | ')}` : ''));
}

main()
  .then(() => process.exit(0))
  .catch(err => { console.error('Mislukt:', err); process.exit(1); });
