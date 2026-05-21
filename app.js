/* ================================================================
   TAKENLIJST — app.js
   Opgebouwd in secties:
     1. State & localStorage
     2. Datumherkenning
     3. Chat-flow (invoer → categorie → prioriteit → opslaan)
     4. Taakbeheer (render, sort, filter, CRUD)
     5. Categoriebeheer
     6. Export / Import
     7. Event-listeners (initialisatie onderaan)
     8. Cloud-sync (Firebase Authentication + Firestore)
   ================================================================ */

import {
  signInWithGoogle, signOutUser, onAuthChange,
  fetchRemoteState, pushRemoteState, subscribeRemoteState
} from './firebase-sync.js';

/* ── 1. STATE & LOCALSTORAGE ──────────────────────────────────── */

const STORAGE_KEYS = {
  tasks:      'todoapp_tasks',
  categories: 'todoapp_categories',
};

const DEFAULT_CATEGORIES = ['Werk', 'Studie', 'Coschappen Aruba', 'Pieternel', 'Persoonlijk'];

// Laad vanuit localStorage of gebruik standaardwaarden
let state = {
  tasks:      loadJSON(STORAGE_KEYS.tasks,      []),
  categories: loadJSON(STORAGE_KEYS.categories, DEFAULT_CATEGORIES),
};

function loadJSON(key, fallback) {
  try {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : fallback;
  } catch {
    return fallback;
  }
}

function persist() {
  localStorage.setItem(STORAGE_KEYS.tasks,      JSON.stringify(state.tasks));
  localStorage.setItem(STORAGE_KEYS.categories, JSON.stringify(state.categories));

  // Als de gebruiker is ingelogd én we zijn niet bezig een remote-update
  // toe te passen, ook naar Firestore schrijven. Zie sectie 8 onderaan.
  if (cloud.user && !cloud.isApplyingRemote) {
    pushRemoteState(cloud.user.uid, state).catch(err =>
      console.warn('Cloud-sync mislukt:', err)
    );
  }
}

/* Geeft een uniek id terug op basis van huidige tijdstempel + willekeurig getal */
function uid() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
}

/* ── 2. DATUMHERKENNING ───────────────────────────────────────── */

const MAANDEN = {
  januari: 1, jan: 1,
  februari: 2, feb: 2,
  maart: 3, mrt: 3,
  april: 4, apr: 4,
  mei: 5,
  juni: 6, jun: 6,
  juli: 7, jul: 7,
  augustus: 8, aug: 8,
  september: 9, sep: 9, sept: 9,
  oktober: 10, okt: 10,
  november: 11, nov: 11,
  december: 12, dec: 12,
};

const WEEKDAGEN = {
  maandag: 1,
  dinsdag: 2,
  woensdag: 3,
  donderdag: 4,
  vrijdag: 5, vr: 5,
  zaterdag: 6, za: 6,
  zondag: 0,
  // Korte vormen "ma", "di", "wo", "do", "zo" zijn weggelaten omdat ze te
  // vaak als gewoon Nederlands woord voorkomen en valse matches geven.
};

/**
 * Formatteert een Date-object als YYYY-MM-DD (lokale tijdzone).
 */
function toISODate(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${dd}`;
}

/**
 * Geeft vandaag als Date-object (middernacht lokale tijd).
 */
function today() {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d;
}

/**
 * Voorzetsels en woordgroepen die rond een datum mogen staan en samen met
 * de datum uit de titel verwijderd worden. ("tandarts bellen op 25 mei"
 * → "tandarts bellen".)
 */
const PREP_RE =
  /(^\s*|\s+)(?:het\s+weekend\s+van|in\s+de\s+week\s+van|aankomende|komende|op|voor|vanaf|tegen|uiterlijk|rond|tot)\s*(\s+|$)/gi;

/**
 * Ruimt voorzetsels op die aan begin of einde van de titel zijn blijven
 * staan nadat de datum verwijderd is.
 */
function cleanTitle(t) {
  if (!t) return '';
  let prev;
  do {
    prev = t;
    t = t.replace(PREP_RE, ' ').replace(/\s{2,}/g, ' ').trim();
  } while (t !== prev);
  // Zorg dat de overgebleven titel met een hoofdletter begint
  return autoCapitalizeText(t);
}

/**
 * Probeert een deadline te herkennen in de invoertekst.
 * Geeft { deadline: 'YYYY-MM-DD' | null, title: string } terug.
 * De datum (en eventuele voorzetsels eromheen) wordt uit de tekst verwijderd.
 */
function parseDateFromText(raw) {
  const text = raw.trim();
  const lower = text.toLowerCase();
  let deadline = null;
  let title = text;

  // Hulpfunctie: verwijder een stuk uit de originele string (hoofdletterongevoelig)
  function stripMatch(pattern) {
    // Verwijder het patroon inclusief eventuele voor- of naliggende voorzetsels
    // ("voor", "op", "tegen") en extra spaties
    const prep = '(?:voor|op|tegen|uiterlijk)?\\s*';
    const re = new RegExp(prep + pattern + '\\b', 'i');
    title = text.replace(re, '').replace(/\s{2,}/g, ' ').trim();
  }

  // — "vandaag"
  if (/\bvandaag\b/i.test(lower)) {
    deadline = toISODate(today());
    stripMatch('vandaag');
    return { deadline, title: cleanTitle(title) };
  }

  // — "morgen"
  if (/\bmorgen\b/i.test(lower)) {
    const d = today(); d.setDate(d.getDate() + 1);
    deadline = toISODate(d);
    stripMatch('morgen');
    return { deadline, title: cleanTitle(title) };
  }

  // — "overmorgen"
  if (/\bovermorgen\b/i.test(lower)) {
    const d = today(); d.setDate(d.getDate() + 2);
    deadline = toISODate(d);
    stripMatch('overmorgen');
    return { deadline, title: cleanTitle(title) };
  }

  // — "aankomende/komende/volgende week/deze week + weekdag"
  //    bijv. "aankomende zaterdag", "volgende week donderdag"
  const compoundMatch = lower.match(
    /\b(aankomende|komende|volgende\s+week|deze\s+week)\s+(maandag|dinsdag|woensdag|donderdag|vrijdag|zaterdag|zondag)\b/
  );
  if (compoundMatch) {
    const prefix  = compoundMatch[1];
    const dagNaam = compoundMatch[2];
    const dagNr   = WEEKDAGEN[dagNaam];
    const d = today();
    let diff = (dagNr - d.getDay() + 7) % 7;
    if (diff === 0) diff = 7;       // "aankomende donderdag" op een donderdag = volgende donderdag
    d.setDate(d.getDate() + diff);
    if (/volgende/.test(prefix)) {  // "volgende week donderdag" = nog een week erbij
      d.setDate(d.getDate() + 7);
    }
    deadline = toISODate(d);
    title = text.replace(new RegExp(compoundMatch[0], 'i'), '')
                .replace(/\s{2,}/g, ' ').trim();
    return { deadline, title: cleanTitle(title) };
  }

  // — "volgende week" zonder weekdag erachter
  if (/\bvolgende\s+week\b/i.test(lower)) {
    const d = today(); d.setDate(d.getDate() + 7);
    deadline = toISODate(d);
    title = text.replace(/\bvolgende\s+week\b/i, '').replace(/\s{2,}/g, ' ').trim();
    return { deadline, title: cleanTitle(title) };
  }

  // — "over N dagen/weken/maanden"
  const overMatch = lower.match(/\bover\s+(\d+|een|één)\s+(dag(?:en)?|week(?:en)?|maand(?:en)?)\b/);
  if (overMatch) {
    const n = overMatch[1] === 'een' || overMatch[1] === 'één' ? 1 : parseInt(overMatch[1], 10);
    const unit = overMatch[2];
    const d = today();
    if (unit.startsWith('dag'))   d.setDate(d.getDate() + n);
    if (unit.startsWith('week'))  d.setDate(d.getDate() + n * 7);
    if (unit.startsWith('maand')) d.setMonth(d.getMonth() + n);
    deadline = toISODate(d);
    title = text.replace(overMatch[0], '').replace(/\s{2,}/g, ' ').trim();
    return { deadline, title: cleanTitle(title) };
  }

  // — Weekdagnamen (komende weekdag)
  for (const [dag, dagNr] of Object.entries(WEEKDAGEN)) {
    // Alleen gehele woorden; "do" en "di" etc. ook herkennen
    const re = new RegExp(`\\b${dag}\\b`, 'i');
    if (re.test(lower)) {
      const d = today();
      let diff = (dagNr - d.getDay() + 7) % 7;
      if (diff === 0) diff = 7; // Dezelfde dag = volgende week
      d.setDate(d.getDate() + diff);
      deadline = toISODate(d);
      title = text.replace(re, '').replace(/\s{2,}/g, ' ').trim();
      return { deadline, title: cleanTitle(title) };
    }
  }

  // — Expliciete datum: "25 mei", "25 mei 2025"
  for (const [naam, nr] of Object.entries(MAANDEN)) {
    const re = new RegExp(`\\b(\\d{1,2})\\s+${naam}(?:\\s+(\\d{4}))?\\b`, 'i');
    const m = lower.match(re);
    if (m) {
      const dag   = parseInt(m[1], 10);
      const jaar  = m[2] ? parseInt(m[2], 10) : new Date().getFullYear();
      const d     = new Date(jaar, nr - 1, dag);
      if (!isNaN(d.getTime())) {
        deadline = toISODate(d);
        title = text.replace(re, '').replace(/\s{2,}/g, ' ').trim();
        return { deadline, title: cleanTitle(title) };
      }
    }
  }

  // — Numeriek: "25-05", "25/05", "25-05-2025", "25/05/2025"
  const numRe = /\b(\d{1,2})[-\/](\d{1,2})(?:[-\/](\d{4}))?\b/;
  const numM = text.match(numRe);
  if (numM) {
    const dag   = parseInt(numM[1], 10);
    const maand = parseInt(numM[2], 10);
    const jaar  = numM[3] ? parseInt(numM[3], 10) : new Date().getFullYear();
    const d     = new Date(jaar, maand - 1, dag);
    if (!isNaN(d.getTime()) && maand >= 1 && maand <= 12) {
      deadline = toISODate(d);
      title = text.replace(numRe, '').replace(/\s{2,}/g, ' ').trim();
      return { deadline, title: cleanTitle(title) };
    }
  }

  return { deadline: null, title: cleanTitle(title) };
}

/**
 * Herkent een prioriteit in vrije tekst en haalt die woordgroep uit de titel.
 * Geeft { priority: 'hoog' | 'midden' | 'laag' | null, title } terug.
 * Bijv. "boodschappen met hoge prioriteit" → priority 'hoog', titel "boodschappen".
 */
function parsePriorityFromText(text) {
  let title = text;
  let priority = null;

  // Volgorde is belangrijk: "niet belangrijk" vóór "belangrijk".
  const patterns = [
    { re: /\b(?:met\s+)?(?:een\s+)?niet\s+belangrijke?\b/i,                                   prio: 'laag'   },
    { re: /\b(?:met\s+)?(?:een\s+)?(?:lage|laag)\s+prioriteit\b/i,                            prio: 'laag'   },
    { re: /\b(?:met\s+)?(?:een\s+)?(?:hoge|hoog)\s+prioriteit\b/i,                            prio: 'hoog'   },
    { re: /\b(?:met\s+)?(?:een\s+)?(?:middelmatige|gemiddelde|normale|midden)\s+prioriteit\b/i, prio: 'midden' },
    { re: /\b(?:heel\s+|zeer\s+)?belangrijke?\b/i,                                            prio: 'hoog'   },
    { re: /\burgent\b/i,                                                                      prio: 'hoog'   },
  ];

  for (const { re, prio } of patterns) {
    if (re.test(title)) {
      priority = prio;
      title = title.replace(re, ' ').replace(/\s{2,}/g, ' ').trim();
      break;
    }
  }

  return { priority, title: cleanTitle(title) };
}

/**
 * Formatteert een YYYY-MM-DD datum naar Nederlandse weergave, bijv. "vr 23 mei".
 */
function formatDate(iso) {
  if (!iso) return '';
  const [y, m, d] = iso.split('-').map(Number);
  const dt = new Date(y, m - 1, d);
  const dagen = ['zo', 'ma', 'di', 'wo', 'do', 'vr', 'za'];
  const maanden = ['jan', 'feb', 'mrt', 'apr', 'mei', 'jun', 'jul', 'aug', 'sep', 'okt', 'nov', 'dec'];
  return `${dagen[dt.getDay()]} ${d} ${maanden[m - 1]}`;
}

/**
 * Geeft de deadline-status terug: 'overdue', 'urgent' (vandaag/morgen) of null.
 */
function deadlineStatus(iso) {
  if (!iso) return null;
  const [y, m, d] = iso.split('-').map(Number);
  const dl = new Date(y, m - 1, d);
  const t  = today();
  if (dl < t) return 'overdue';
  const morgen = new Date(t); morgen.setDate(t.getDate() + 1);
  if (dl <= morgen) return 'urgent';
  return null;
}

/**
 * Zet eerste letter en letter na elke ".", "!", "?" om naar hoofdletter.
 * Wordt aangeroepen bij elk input-event op gekoppelde velden.
 */
function autoCapitalizeText(text) {
  return text.replace(/(^|[.!?]\s+)([a-zà-ÿ])/g,
    (_, prefix, letter) => prefix + letter.toUpperCase());
}

/**
 * Koppelt automatische hoofdletter-correctie aan een input of textarea.
 * Cursorpositie blijft behouden tijdens typen.
 */
function bindAutoCap(el) {
  el.addEventListener('input', () => {
    const pos = el.selectionStart;
    const before = el.value;
    const after  = autoCapitalizeText(before);
    if (after !== before) {
      el.value = after;
      el.setSelectionRange(pos, pos);
    }
  });
}

/**
 * Bullet-continuation: als de regel waar de cursor staat met "- " begint
 * en er staat tekst achter, voegt deze functie een "\n- " in. Staat er
 * alleen "- " (lege bullet), dan wordt die verwijderd zodat de gebruiker
 * uit lijstmodus stapt. Roept deze functie alleen aan bij plain Enter.
 *
 * Geeft true terug als de bullet-actie is uitgevoerd; anders false (en
 * mag de aanroeper Enter behandelen zoals normaal).
 */
function handleBulletEnter(el) {
  const pos = el.selectionStart;
  const value = el.value;
  const lineStart = value.lastIndexOf('\n', pos - 1) + 1;
  const line = value.substring(lineStart, pos);

  if (!line.startsWith('- ')) return false;

  if (line === '- ') {
    // Lege bullet — weghalen, uit lijstmodus
    el.value = value.substring(0, lineStart) + value.substring(pos);
    el.selectionStart = el.selectionEnd = lineStart;
  } else {
    // Continueer met nieuwe bullet op nieuwe regel
    const insert = '\n- ';
    el.value = value.substring(0, pos) + insert + value.substring(pos);
    el.selectionStart = el.selectionEnd = pos + insert.length;
  }
  return true;
}

/* ── 3. CHAT-FLOW ─────────────────────────────────────────────── */

// Bewaar tijdelijk de staat van de lopende invoer.
// step bepaalt welke stap getoond wordt: 'category' | 'priority' | 'notes'
let chatState = {
  active:   false,
  rawInput: '',
  title:    '',
  deadline: null,
  category: null,
  priority: null,
  notes:    '',
  step:     null,
};

// Onthoud de getypte notitie zodat die bewaard blijft bij Terug/opnieuw renderen
let chatNotesValue = '';

// Verwijzing naar de actieve sneltoets-listener (1-9), zodat we die kunnen opruimen
let currentChoiceKeyHandler = null;

const chatMessages = document.getElementById('chat-messages');
const chatInput    = document.getElementById('chat-input');
const chatForm     = document.getElementById('chat-form');

function clearChoiceKeyHandler() {
  if (currentChoiceKeyHandler) {
    document.removeEventListener('keydown', currentChoiceKeyHandler);
    currentChoiceKeyHandler = null;
  }
}

/**
 * Voegt een nieuw bericht toe aan de chatweergave.
 * type: 'system' | 'user' | 'bot'
 * content: string (HTML) of een DOM-element
 */
function addChatMessage(type, content) {
  const bubble = document.createElement('div');
  bubble.className = `chat-bubble chat-bubble--${type}`;
  if (typeof content === 'string') {
    bubble.innerHTML = content;
  } else {
    bubble.appendChild(content);
  }
  chatMessages.appendChild(bubble);
  chatMessages.scrollTop = chatMessages.scrollHeight;
  return bubble;
}

/**
 * Toont multiplechoice-knoppen als los element in de chat.
 * opties: [{ label, value }]
 * onKeuze(value): callback zodra de gebruiker klikt
 */
function addChoiceBubble(vraag, opties, onKeuze) {
  clearChoiceKeyHandler(); // eventuele vorige listener opruimen

  const wrapper = document.createElement('div');
  wrapper.innerHTML = `<div style="margin-bottom:.4rem;font-size:.88rem;">${vraag}</div>`;
  const row = document.createElement('div');
  row.className = 'chat-choices';

  const buttons = [];

  opties.forEach(({ label, value }, idx) => {
    const btn = document.createElement('button');
    btn.className = 'choice-btn';
    if (idx < 9) {
      btn.innerHTML = `<span class="choice-key">${idx + 1}</span> ${label}`;
    } else {
      btn.textContent = label;
    }
    btn.addEventListener('click', () => {
      clearChoiceKeyHandler();
      onKeuze(value);
    });
    buttons.push(btn);
    row.appendChild(btn);
  });

  // Sneltoetsen 1-9 om een keuze te maken zonder muis
  const keyHandler = (e) => {
    const ae = document.activeElement;
    if (ae && (ae.tagName === 'INPUT' || ae.tagName === 'TEXTAREA') && !ae.disabled) return;
    if (!/^[1-9]$/.test(e.key)) return;
    const idx = parseInt(e.key, 10) - 1;
    if (idx >= buttons.length) return;
    e.preventDefault();
    buttons[idx].click();
  };
  document.addEventListener('keydown', keyHandler);
  currentChoiceKeyHandler = keyHandler;

  wrapper.appendChild(row);
  addChatMessage('bot', wrapper);
}

/**
 * Verwerkt de eerste invoer: herkent datum en start de keuze-flow.
 */
function handleChatSubmit(rawInput) {
  if (!rawInput.trim()) return;
  if (chatState.active) {
    chatInput.disabled = false;
    return;
  }

  const { deadline, title } = parseDateFromText(rawInput);
  chatState = {
    active: true, rawInput, title: title || rawInput, deadline,
    category: null, priority: null, notes: '', step: 'category',
  };
  chatNotesValue = '';
  renderChatFlow();
}

/**
 * Annuleert de lopende invoer volledig en ruimt de chat op.
 */
function resetChat() {
  clearChoiceKeyHandler();
  chatState = { active: false, rawInput: '', title: '', deadline: null,
                category: null, priority: null, notes: '', step: null };
  chatNotesValue = '';
  chatMessages.innerHTML = '';
  chatInput.disabled = false;
}

/**
 * Gaat één stap terug in de flow (categorie ← prioriteit ← notities).
 */
function goBackStep() {
  if (chatState.step === 'priority') {
    chatState.category = null;
    chatState.step = 'category';
  } else if (chatState.step === 'notes') {
    chatState.priority = null;
    chatState.step = 'priority';
  }
  renderChatFlow();
}

/**
 * Tekent de hele chat-conversatie opnieuw op basis van chatState.
 * Hierdoor kunnen we eenvoudig terug-/annuleer-acties ondersteunen.
 */
function renderChatFlow() {
  clearChoiceKeyHandler();
  chatMessages.innerHTML = '';
  if (!chatState.active) return;

  // Controlebalk: Terug (vanaf stap 2) en Annuleren
  const bar = document.createElement('div');
  bar.className = 'chat-control-bar';

  if (chatState.step === 'priority' || chatState.step === 'notes') {
    const backBtn = document.createElement('button');
    backBtn.className = 'chat-control-btn';
    backBtn.innerHTML = '&#8592; Terug';
    backBtn.addEventListener('click', goBackStep);
    bar.appendChild(backBtn);
  }

  const cancelBtn = document.createElement('button');
  cancelBtn.className = 'chat-control-btn chat-control-btn--cancel';
  cancelBtn.innerHTML = '&times; Annuleren';
  cancelBtn.addEventListener('click', resetChat);
  bar.appendChild(cancelBtn);
  chatMessages.appendChild(bar);

  // Ingevoerde taak + herkende datum
  addChatMessage('user', escapeHtml(chatState.rawInput));
  const datumTekst = chatState.deadline
    ? `Deadline herkend: <strong>${formatDate(chatState.deadline)}</strong>`
    : 'Geen deadline herkend.';
  addChatMessage('bot',
    `Taak: <strong>${escapeHtml(chatState.title)}</strong><br>${datumTekst}`);

  // Reeds gemaakte keuzes als context tonen
  if (chatState.step !== 'category') {
    addChatMessage('bot', `Categorie: <strong>${chatState.category || 'Geen categorie'}</strong>`);
  }
  if (chatState.step === 'notes') {
    const p = chatState.priority;
    addChatMessage('bot', `Prioriteit: <strong>${p.charAt(0).toUpperCase() + p.slice(1)}</strong>`);
  }

  // Stap-specifieke inhoud
  if (chatState.step === 'category') {
    const opts = state.categories.map(c => ({ label: c, value: c }));
    opts.push({ label: 'Geen categorie', value: '' });
    addChoiceBubble('Welke categorie?', opts, (cat) => {
      chatState.category = cat;
      chatState.step = 'priority';
      renderChatFlow();
    });
  } else if (chatState.step === 'priority') {
    addChoiceBubble('Welke prioriteit?', [
      { label: 'Hoog',   value: 'hoog'   },
      { label: 'Midden', value: 'midden' },
      { label: 'Laag',   value: 'laag'   },
    ], (prio) => {
      chatState.priority = prio;
      chatState.step = 'notes';
      renderChatFlow();
    });
  } else if (chatState.step === 'notes') {
    showNotesStep();
  }
}

/**
 * Toont de optionele notities-stap met textarea + Overslaan/Toevoegen.
 */
function showNotesStep() {
  const wrapper = document.createElement('div');
  const label = document.createElement('div');
  label.style.cssText = 'margin-bottom:.4rem;font-size:.88rem;';
  label.textContent = 'Notities? (optioneel)';
  wrapper.appendChild(label);

  const ta = document.createElement('textarea');
  ta.className = 'chat-notes-input';
  ta.rows = 3;
  ta.value = chatNotesValue;
  ta.setAttribute('autocapitalize', 'sentences');
  ta.addEventListener('input', () => { chatNotesValue = ta.value; });
  wrapper.appendChild(ta);

  const row = document.createElement('div');
  row.className = 'chat-choices';

  const skipBtn = document.createElement('button');
  skipBtn.className = 'choice-btn';
  skipBtn.textContent = 'Overslaan';

  const addBtn = document.createElement('button');
  addBtn.className = 'choice-btn';
  addBtn.textContent = 'Toevoegen';

  let done = false;
  const finish = (notes) => {
    if (done) return;
    done = true;
    chatState.notes = notes;
    commitTask();
  };

  skipBtn.addEventListener('click', () => finish(''));
  addBtn .addEventListener('click', () => finish(ta.value.trim()));

  bindAutoCap(ta);

  ta.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') { e.preventDefault(); finish(''); return; }
    if (e.key !== 'Enter') return;
    if (e.metaKey || e.ctrlKey) { e.preventDefault(); finish(ta.value.trim()); return; }
    if (e.shiftKey) return; // gewone nieuwe regel
    if (handleBulletEnter(ta)) { e.preventDefault(); chatNotesValue = ta.value; return; }
    e.preventDefault();
    finish(ta.value.trim());
  });

  row.appendChild(skipBtn);
  row.appendChild(addBtn);
  wrapper.appendChild(row);

  addChatMessage('bot', wrapper);
  setTimeout(() => ta.focus(), 50);
}

/**
 * Voegt direct een taak toe zónder vragen (gebruikt door de spraak-snelkoppeling
 * via ?quickadd=...). Krijgt standaard categorie "Persoonlijk" (indien aanwezig)
 * en prioriteit "Midden". De gebruiker kan dit achteraf aanpassen.
 */
function quickAddTask(text) {
  // Eerst datum eruit halen, dan prioriteit uit de overgebleven titel
  const dateResult = parseDateFromText(text);
  const prioResult = parsePriorityFromText(dateResult.title);

  const title    = prioResult.title;
  const deadline = dateResult.deadline;
  const priority = prioResult.priority || 'midden';
  if (!title || !title.trim()) return;

  const cat = state.categories.includes('Persoonlijk') ? 'Persoonlijk' : '';
  const task = {
    id:        uid(),
    title,
    deadline,
    category:  cat,
    priority,
    notes:     '',
    done:      false,
    createdAt: new Date().toISOString(),
  };

  state.tasks.push(task);
  persist();
  renderAll();

  const datum = deadline ? ` (${formatDate(deadline)})` : '';
  const prioTekst = priority !== 'midden' ? `, ${priority} prioriteit` : '';
  showToast(`Toegevoegd: ${title}${datum}${prioTekst}`);
}

/**
 * Toont kort een melding onderin het scherm.
 */
function showToast(message) {
  let toast = document.getElementById('toast');
  if (!toast) {
    toast = document.createElement('div');
    toast.id = 'toast';
    toast.className = 'toast';
    document.body.appendChild(toast);
  }
  toast.textContent = message;
  toast.classList.add('visible');
  clearTimeout(toast._timer);
  toast._timer = setTimeout(() => toast.classList.remove('visible'), 3500);
}

/**
 * Voegt de taak definitief toe aan de lijst na het doorlopen van de chat-flow.
 */
function commitTask() {
  const task = {
    id:        uid(),
    title:     chatState.title,
    deadline:  chatState.deadline,
    category:  chatState.category,
    priority:  chatState.priority,
    notes:     chatState.notes || '',
    done:      false,
    createdAt: new Date().toISOString(),
  };

  state.tasks.push(task);
  persist();
  renderTasks();
  renderStats();

  resetChat();
  chatInput.focus();
}

/* ── 4. TAAKBEHEER ────────────────────────────────────────────── */

const PRIORITY_ORDER = { hoog: 0, midden: 1, laag: 2 };

/**
 * Sorteert openstaande taken: eerst op prioriteit, dan op deadline (vroegste eerst).
 * Taken zonder deadline komen achteraan.
 */
function sortTasks(tasks) {
  return [...tasks].sort((a, b) => {
    const pa = PRIORITY_ORDER[a.priority] ?? 99;
    const pb = PRIORITY_ORDER[b.priority] ?? 99;
    if (pa !== pb) return pa - pb;
    if (a.deadline && b.deadline) return a.deadline.localeCompare(b.deadline);
    if (a.deadline) return -1;
    if (b.deadline) return 1;
    return 0;
  });
}

/**
 * Filtert de takenlijst op basis van het zoekveld.
 */
function applyFilters(tasks) {
  const search = document.getElementById('filter-search').value.trim().toLowerCase();
  return tasks.filter(t => {
    if (search && !t.title.toLowerCase().includes(search)) return false;
    return true;
  });
}

/**
 * Bepaalt in welk tijdvak een taak valt: 'overdue', 'today', 'tomorrow',
 * 'thisWeek', 'later', 'none' (geen deadline) of 'done'.
 */
const MAANDEN_KORT = ['jan', 'feb', 'mrt', 'apr', 'mei', 'jun',
                      'jul', 'aug', 'sep', 'okt', 'nov', 'dec'];

function taskBucket(task) {
  if (task.done) return 'done';
  if (!task.deadline) return 'none';

  const [y, m, d] = task.deadline.split('-').map(Number);
  const dl = new Date(y, m - 1, d);
  const t = today();
  const diff = Math.round((dl - t) / 86400000);

  if (diff < 0)  return 'overdue';
  if (diff === 0) return 'today';
  if (diff === 1) return 'tomorrow';
  if (diff <= 7)  return 'thisWeek';
  return 'later';
}

// Volgorde en weergavetitel van de tijdvakken
const BUCKETS = [
  { key: 'overdue',  title: 'Te laat',        modifier: 'overdue' },
  { key: 'today',    title: 'Vandaag',        modifier: '' },
  { key: 'tomorrow', title: 'Morgen',         modifier: '' },
  { key: 'thisWeek', title: 'Deze week',      modifier: '' },
  { key: 'later',    title: 'Later',          modifier: '' },
  { key: 'none',     title: 'Geen deadline',  modifier: '' },
  { key: 'done',     title: 'Afgerond',       modifier: 'done' },
];

/**
 * Bouwt het datumblok dat vooraan elke taak komt.
 */
function buildDateBlock(task) {
  const wrap = document.createElement('div');
  wrap.className = 'date-block';

  if (!task.deadline) {
    wrap.classList.add('date-block--none');
    const day = document.createElement('span');
    day.className = 'date-day';
    day.textContent = '—';
    wrap.appendChild(day);
    return wrap;
  }

  const [y, m, d] = task.deadline.split('-').map(Number);

  // Kleurvariant op basis van urgentie (alleen voor openstaande taken)
  if (!task.done) {
    const status = deadlineStatus(task.deadline);
    if (status === 'overdue') wrap.classList.add('date-block--overdue');
    if (status === 'urgent')  wrap.classList.add('date-block--urgent');
  }

  const month = document.createElement('span');
  month.className = 'date-month';
  month.textContent = MAANDEN_KORT[m - 1];

  const day = document.createElement('span');
  day.className = 'date-day';
  day.textContent = d;

  wrap.appendChild(month);
  wrap.appendChild(day);
  return wrap;
}

/**
 * Bouwt één taakkaart als <li>-element.
 * Layout: [datumblok] [checkbox] [titel + meta] [acties]
 */
function buildTaskCard(task) {
  const li = document.createElement('li');
  li.className = 'task-card' + (task.done ? ' done' : '');
  li.dataset.id = task.id;
  li.dataset.priority = task.priority;

  // 1. Datumblok vooraan
  li.appendChild(buildDateBlock(task));

  // 2. Checkbox
  const cb = document.createElement('input');
  cb.type = 'checkbox';
  cb.className = 'task-checkbox';
  cb.checked = task.done;
  cb.setAttribute('aria-label', 'Taak afvinken');
  cb.addEventListener('change', () => toggleTask(task.id));
  li.appendChild(cb);

  // 3. Titel + meta-badges
  const body = document.createElement('div');
  body.className = 'task-body';

  const titleEl = document.createElement('div');
  titleEl.className = 'task-title';
  titleEl.textContent = task.title;
  body.appendChild(titleEl);

  const meta = document.createElement('div');
  meta.className = 'task-meta';

  if (task.category) {
    const b = document.createElement('span');
    b.className = 'task-badge';
    b.textContent = task.category;
    meta.appendChild(b);
  }

  if (task.priority) {
    const b = document.createElement('span');
    b.className = `task-badge task-badge--priority-${task.priority}`;
    b.textContent = task.priority.charAt(0).toUpperCase() + task.priority.slice(1);
    meta.appendChild(b);
  }

  body.appendChild(meta);
  li.appendChild(body);

  // 4. Actieknoppen (potlood + prullenbak)
  const actions = document.createElement('div');
  actions.className = 'task-actions';

  const btnEdit = document.createElement('button');
  btnEdit.className = 'btn-icon';
  btnEdit.title = 'Bewerken';
  btnEdit.setAttribute('aria-label', 'Bewerken');
  btnEdit.innerHTML = `
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none"
         stroke="currentColor" stroke-width="1.5"
         stroke-linecap="round" stroke-linejoin="round">
      <path d="M11 1.5l3.5 3.5L5 14.5H1.5V11L11 1.5z"/>
    </svg>`;
  btnEdit.addEventListener('click', (e) => {
    e.stopPropagation();
    openEditModal(task.id);
  });

  const btnDel = document.createElement('button');
  btnDel.className = 'btn-icon';
  btnDel.title = 'Verwijderen';
  btnDel.setAttribute('aria-label', 'Verwijderen');
  btnDel.innerHTML = `
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none"
         stroke="currentColor" stroke-width="1.5"
         stroke-linecap="round" stroke-linejoin="round">
      <path d="M2.5 4h11M6 4V2.5h4V4M4 4.5l.7 9.5h6.6l.7-9.5M6.5 7v5M9.5 7v5"/>
    </svg>`;
  btnDel.addEventListener('click', (e) => {
    e.stopPropagation();
    confirmDeleteTask(task.id);
  });

  actions.appendChild(btnEdit);
  actions.appendChild(btnDel);
  li.appendChild(actions);

  // 5. Uitklap-toggle + notities-blok (alleen als er notities zijn)
  if (task.notes && task.notes.trim()) {
    const expand = document.createElement('button');
    expand.className = 'task-expand';
    expand.title = 'Notities tonen';
    expand.setAttribute('aria-label', 'Notities tonen');
    expand.innerHTML = `
      <svg width="12" height="12" viewBox="0 0 12 12" fill="none"
           stroke="currentColor" stroke-width="1.75"
           stroke-linecap="round" stroke-linejoin="round">
        <path d="M3 4.5l3 3 3-3"/>
      </svg>`;
    expand.addEventListener('click', (e) => {
      e.stopPropagation();
      li.classList.toggle('expanded');
    });
    actions.appendChild(expand);

    const notes = document.createElement('div');
    notes.className = 'task-notes';
    notes.textContent = task.notes;
    li.appendChild(notes);

    // Klik op de taakkaart zelf toggelt ook de notities (handig op mobiel)
    li.classList.add('has-notes');
    li.addEventListener('click', (e) => {
      // Negeer klikken op interactieve elementen (checkbox, knoppen)
      if (e.target.closest('input, button')) return;
      li.classList.toggle('expanded');
    });
  }

  return li;
}

/**
 * Hertekent de volledige takenlijst, gegroepeerd per tijdvak.
 */
function renderTasks() {
  const container = document.getElementById('task-groups');
  const emptyState = document.getElementById('empty-state');
  container.innerHTML = '';

  const filtered = applyFilters(state.tasks);

  if (filtered.length === 0) {
    emptyState.style.display = '';
    return;
  }
  emptyState.style.display = 'none';

  // Groepeer in buckets
  const grouped = {};
  filtered.forEach(t => {
    const b = taskBucket(t);
    (grouped[b] ??= []).push(t);
  });

  // Render elke bucket in vaste volgorde, sla lege buckets over
  BUCKETS.forEach(({ key, title, modifier }) => {
    const tasks = grouped[key];
    if (!tasks || tasks.length === 0) return;

    const sorted = sortTasks(tasks);

    const group = document.createElement('section');
    group.className = 'task-group' + (modifier ? ` task-group--${modifier}` : '');

    const header = document.createElement('div');
    header.className = 'task-group-header';

    const h2 = document.createElement('h2');
    h2.className = 'task-group-title';
    h2.textContent = title;
    header.appendChild(h2);

    const count = document.createElement('span');
    count.className = 'task-group-count';
    count.textContent = tasks.length;
    header.appendChild(count);

    group.appendChild(header);

    const ul = document.createElement('ul');
    ul.className = 'task-list';
    sorted.forEach(t => ul.appendChild(buildTaskCard(t)));
    group.appendChild(ul);

    container.appendChild(group);
  });
}

/**
 * Hertekent de statistieken bovenaan.
 */
function renderStats() {
  const open   = state.tasks.filter(t => !t.done).length;
  const done   = state.tasks.filter(t => t.done).length;
  const overdue = state.tasks.filter(t =>
    !t.done && t.deadline && deadlineStatus(t.deadline) === 'overdue'
  ).length;

  document.getElementById('stat-open').textContent   = open;
  document.getElementById('stat-done').textContent   = done;
  document.getElementById('stat-overdue').textContent = overdue;
}

/**
 * Wisselt de done-status van een taak.
 */
function toggleTask(id) {
  const task = state.tasks.find(t => t.id === id);
  if (task) {
    task.done = !task.done;
    persist();
    renderTasks();
    renderStats();
  }
}

/**
 * Opent de bevestigingsdialoog voor het verwijderen van een taak.
 */
function confirmDeleteTask(id) {
  const task = state.tasks.find(t => t.id === id);
  if (!task) return;
  openConfirm(`Taak "${task.title}" definitief verwijderen?`, () => {
    state.tasks = state.tasks.filter(t => t.id !== id);
    persist();
    renderTasks();
    renderStats();
  });
}

/* ── Taak bewerken ────────────────────────────────────────────── */

let editingTaskId = null;

function openEditModal(id) {
  const task = state.tasks.find(t => t.id === id);
  if (!task) return;
  editingTaskId = id;

  document.getElementById('edit-title').value    = task.title;
  document.getElementById('edit-priority').value = task.priority || 'midden';
  document.getElementById('edit-deadline').value = task.deadline || '';
  document.getElementById('edit-notes').value    = task.notes || '';

  // Vul categorie-dropdown
  const sel = document.getElementById('edit-category');
  sel.innerHTML = '<option value="">Geen categorie</option>';
  state.categories.forEach(c => {
    const opt = document.createElement('option');
    opt.value = c;
    opt.textContent = c;
    if (c === task.category) opt.selected = true;
    sel.appendChild(opt);
  });

  document.getElementById('modal-edit-task').style.display = 'flex';
}

function saveEditTask() {
  const task = state.tasks.find(t => t.id === editingTaskId);
  if (!task) return;

  task.title    = document.getElementById('edit-title').value.trim() || task.title;
  task.category = document.getElementById('edit-category').value;
  task.priority = document.getElementById('edit-priority').value;
  task.deadline = document.getElementById('edit-deadline').value || null;
  task.notes    = document.getElementById('edit-notes').value.trim();

  persist();
  renderTasks();
  renderStats();
  document.getElementById('modal-edit-task').style.display = 'none';
  editingTaskId = null;
}

/* ── 5. CATEGORIEBEHEER ───────────────────────────────────────── */

/**
 * Hertekent de lijst in het categorie-beheerscherm.
 */
function renderCategories() {
  const list = document.getElementById('category-list');
  list.innerHTML = '';

  state.categories.forEach((cat, idx) => {
    const li = document.createElement('li');
    li.className = 'category-item';

    const nameSpan = document.createElement('span');
    nameSpan.className = 'category-name';
    nameSpan.textContent = cat;
    li.appendChild(nameSpan);

    // Hernoem-knop
    const btnRename = document.createElement('button');
    btnRename.className = 'btn btn-ghost btn-sm';
    btnRename.textContent = 'Naam wijzigen';
    btnRename.addEventListener('click', () => startRename(li, idx, nameSpan, btnRename));
    li.appendChild(btnRename);

    // Verwijder-knop
    const btnDel = document.createElement('button');
    btnDel.className = 'btn btn-ghost btn-sm';
    btnDel.textContent = 'Verwijderen';
    btnDel.addEventListener('click', () => handleDeleteCategory(idx));
    li.appendChild(btnDel);

    list.appendChild(li);
  });
}

/**
 * Laat de naam inline bewerken.
 */
function startRename(li, idx, nameSpan, btnRename) {
  const input = document.createElement('input');
  input.className = 'category-name-input';
  input.value = state.categories[idx];
  li.replaceChild(input, nameSpan);
  input.focus();

  const btnSave = document.createElement('button');
  btnSave.className = 'btn btn-primary btn-sm';
  btnSave.textContent = 'Opslaan';

  const btnCancel = document.createElement('button');
  btnCancel.className = 'btn btn-ghost btn-sm';
  btnCancel.textContent = 'Annuleren';

  li.replaceChild(btnSave, btnRename);

  // Voeg annuleer in na opslaan
  btnSave.insertAdjacentElement('afterend', btnCancel);

  const doSave = () => {
    const newName = input.value.trim();
    if (!newName) return;
    const oldName = state.categories[idx];
    state.categories[idx] = newName;
    // Hernoem ook in taken
    state.tasks.forEach(t => { if (t.category === oldName) t.category = newName; });
    persist();
    renderCategories();
    updateCategoryFilters();
  };

  btnSave.addEventListener('click', doSave);
  input.addEventListener('keydown', e => { if (e.key === 'Enter') doSave(); });
  btnCancel.addEventListener('click', renderCategories);
}

/**
 * Verwerkt verwijdering van een categorie; vraagt wat te doen met eventuele taken.
 */
function handleDeleteCategory(idx) {
  const cat = state.categories[idx];
  const tasksInCat = state.tasks.filter(t => t.category === cat);

  if (tasksInCat.length === 0) {
    openConfirm(`Categorie "${cat}" verwijderen?`, () => {
      state.categories.splice(idx, 1);
      persist();
      renderCategories();
      updateCategoryFilters();
    });
    return;
  }

  // Er zijn taken — toon speciale dialoog
  const modal = document.getElementById('modal-delete-category');
  document.getElementById('delete-category-msg').textContent =
    `De categorie "${cat}" bevat ${tasksInCat.length} taak(en). Wat wil je doen?`;

  const target = document.getElementById('delete-category-target');
  target.innerHTML = '';
  state.categories.filter((_, i) => i !== idx).forEach(c => {
    const opt = document.createElement('option');
    opt.value = c;
    opt.textContent = c;
    target.appendChild(opt);
  });
  const optNone = document.createElement('option');
  optNone.value = '';
  optNone.textContent = 'Geen categorie';
  target.appendChild(optNone);

  modal.style.display = 'flex';

  // Knoppen
  const btnMove = document.getElementById('btn-delete-cat-move');
  const btnDel  = document.getElementById('btn-delete-cat-delete-tasks');
  const btnCan  = document.getElementById('btn-delete-cat-cancel');

  const cleanup = () => { modal.style.display = 'none'; };

  const moveHandler = () => {
    const dest = target.value;
    tasksInCat.forEach(t => { t.category = dest; });
    state.categories.splice(idx, 1);
    persist();
    renderCategories();
    renderTasks();
    updateCategoryFilters();
    cleanup();
  };

  const deleteTasksHandler = () => {
    state.tasks = state.tasks.filter(t => t.category !== cat);
    state.categories.splice(idx, 1);
    persist();
    renderCategories();
    renderTasks();
    renderStats();
    updateCategoryFilters();
    cleanup();
  };

  // Vervang listeners (voorkom stapeling)
  btnMove.replaceWith(btnMove.cloneNode(true));
  btnDel.replaceWith(btnDel.cloneNode(true));
  btnCan.replaceWith(btnCan.cloneNode(true));

  document.getElementById('btn-delete-cat-move').addEventListener('click', moveHandler);
  document.getElementById('btn-delete-cat-delete-tasks').addEventListener('click', deleteTasksHandler);
  document.getElementById('btn-delete-cat-cancel').addEventListener('click', cleanup);
}

/**
 * Vult de categorie-filter-dropdowns bij in de filtersbalk en de bewerkingsmodal.
 */
function updateCategoryFilters() {
  // De filter-dropdown is verwijderd; functie blijft als no-op om alle
  // bestaande aanroepers werkend te houden zonder kruisreferenties te breken.
}

/* ── 6. HULPFUNCTIES & ALGEMENE MODALS ───────────────────────── */

/**
 * Ontsnapt HTML-speciale tekens om XSS te voorkomen.
 */
function escapeHtml(str) {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

let confirmCallback = null;

/**
 * Toont een algemene bevestigingsdialoog.
 */
function openConfirm(message, onYes) {
  document.getElementById('confirm-message').textContent = message;
  confirmCallback = onYes;
  document.getElementById('modal-confirm').style.display = 'flex';
}

/**
 * Hertekent alles (na import of initialisatie).
 */
function renderAll() {
  updateCategoryFilters();
  renderCategories();
  renderTasks();
  renderStats();
  maybeShowBriefing();
}

/* ── Ochtend-briefing ─────────────────────────────────────────
   Toont één keer per dag bij de eerste open een overzicht met:
   - Taken die te laat zijn
   - Taken voor vandaag
   - Openstaande Hoog-prio taken
   Zodra getoond wordt de datum in localStorage bewaard zodat
   hij die dag niet opnieuw verschijnt.
─────────────────────────────────────────────────────────────── */

const BRIEFING_KEY = 'takenlijst:lastBriefing';

// Een "nieuwe dag" voor de briefing begint pas om 04:00. Zo krijg je 's nachts
// (bijv. om 02:00) niet alvast de briefing van morgen — handig als je laat werkt.
const BRIEFING_DAY_CUTOFF_HOUR = 4;

function logicalTodayISO() {
  const now = new Date();
  if (now.getHours() < BRIEFING_DAY_CUTOFF_HOUR) {
    now.setDate(now.getDate() - 1);
  }
  return toISODate(now);
}

function greetingForHour(h) {
  if (h < 6)  return 'Goedenacht';
  if (h < 12) return 'Goedemorgen';
  if (h < 18) return 'Goedemiddag';
  return 'Goedenavond';
}

function formatBriefingDate(d) {
  const dagen = ['zondag', 'maandag', 'dinsdag', 'woensdag',
                 'donderdag', 'vrijdag', 'zaterdag'];
  const maanden = ['januari', 'februari', 'maart', 'april', 'mei', 'juni',
                   'juli', 'augustus', 'september', 'oktober', 'november', 'december'];
  return `${dagen[d.getDay()]} ${d.getDate()} ${maanden[d.getMonth()]}`;
}

function maybeShowBriefing() {
  const todayISO = logicalTodayISO();
  if (localStorage.getItem(BRIEFING_KEY) === todayISO) return;

  // Verzamel relevante taken
  const overdue = state.tasks.filter(t =>
    !t.done && t.deadline && deadlineStatus(t.deadline) === 'overdue'
  );
  const todayTasks = state.tasks.filter(t =>
    !t.done && taskBucket(t) === 'today'
  );
  const highOpen = state.tasks.filter(t =>
    !t.done && t.priority === 'hoog' &&
    !overdue.includes(t) && !todayTasks.includes(t)
  );

  // Niets om te melden? Sla over zonder de vlag te zetten — we proberen het
  // bij een volgende render opnieuw (bijv. nadat remote-data is binnengekomen).
  if (overdue.length === 0 && todayTasks.length === 0 && highOpen.length === 0) {
    return;
  }

  // Vul de modal
  const now = new Date();
  document.getElementById('briefing-greeting').textContent = greetingForHour(now.getHours());
  document.getElementById('briefing-date').textContent = formatBriefingDate(now);

  renderBriefingSection('overdue', overdue);
  renderBriefingSection('today',   todayTasks);
  renderBriefingSection('high',    highOpen);

  // Lege staat — komt niet voor (we returnen hierboven al), maar voor de zekerheid
  document.getElementById('briefing-empty').style.display = 'none';

  document.getElementById('modal-briefing').style.display = 'flex';
  localStorage.setItem(BRIEFING_KEY, todayISO);
}

function renderBriefingSection(kind, tasks) {
  const section = document.getElementById(`briefing-${kind}-section`);
  const list    = document.getElementById(`briefing-${kind}-list`);
  list.innerHTML = '';

  if (tasks.length === 0) {
    section.style.display = 'none';
    return;
  }
  section.style.display = '';

  // Sorteer op prioriteit + deadline voor leesbaarheid
  sortTasks(tasks).forEach(t => {
    const li = document.createElement('li');
    const title = document.createElement('span');
    title.textContent = t.title;
    const meta = document.createElement('span');
    meta.className = 'briefing-meta';
    const parts = [];
    if (t.category) parts.push(t.category);
    if (t.deadline) parts.push(formatDate(t.deadline));
    meta.textContent = parts.join(' · ');
    li.appendChild(title);
    li.appendChild(meta);
    list.appendChild(li);
  });
}


/* ── EVENT-LISTENERS ─────────────────────────────────────────── */

// Automatische hoofdletters op alle tekstvelden in de app
bindAutoCap(chatInput);
bindAutoCap(document.getElementById('edit-title'));
bindAutoCap(document.getElementById('edit-notes'));
bindAutoCap(document.getElementById('category-input'));

// Automatische opsomming in de notities-textarea van de edit-modal
document.getElementById('edit-notes').addEventListener('keydown', (e) => {
  if (e.key !== 'Enter' || e.shiftKey || e.metaKey || e.ctrlKey) return;
  if (handleBulletEnter(e.target)) e.preventDefault();
});

// Chat
chatForm.addEventListener('submit', e => {
  e.preventDefault();
  const val = chatInput.value;
  chatInput.value = '';
  chatInput.disabled = true;
  handleChatSubmit(val);
});

// Zoeken: klap het invoerveld open bij klik op het vergrootglas;
// klap weer dicht als het veld leeg is en focus verdwijnt.
const filterSearchInput = document.getElementById('filter-search');
const searchWrap        = document.getElementById('search-wrap');

filterSearchInput.addEventListener('input', renderTasks);

document.getElementById('btn-search-toggle').addEventListener('click', () => {
  searchWrap.classList.add('expanded');
  filterSearchInput.focus();
});
filterSearchInput.addEventListener('blur', () => {
  if (!filterSearchInput.value) searchWrap.classList.remove('expanded');
});


// Categoriebeheer
document.getElementById('btn-categories').addEventListener('click', () => {
  renderCategories();
  document.getElementById('modal-categories').style.display = 'flex';
});
document.getElementById('btn-close-categories').addEventListener('click', () => {
  document.getElementById('modal-categories').style.display = 'none';
});
document.getElementById('category-add-form').addEventListener('submit', e => {
  e.preventDefault();
  const input = document.getElementById('category-input');
  const naam  = input.value.trim();
  if (!naam || state.categories.includes(naam)) return;
  state.categories.push(naam);
  persist();
  renderCategories();
  updateCategoryFilters();
  input.value = '';
});

// Taak bewerken
document.getElementById('btn-save-edit').addEventListener('click', saveEditTask);
document.getElementById('btn-cancel-edit').addEventListener('click', () => {
  document.getElementById('modal-edit-task').style.display = 'none';
});
document.getElementById('btn-close-edit').addEventListener('click', () => {
  document.getElementById('modal-edit-task').style.display = 'none';
});

// Bevestigingsdialoog
document.getElementById('btn-confirm-yes').addEventListener('click', () => {
  document.getElementById('modal-confirm').style.display = 'none';
  if (confirmCallback) { confirmCallback(); confirmCallback = null; }
});
document.getElementById('btn-confirm-no').addEventListener('click', () => {
  document.getElementById('modal-confirm').style.display = 'none';
  confirmCallback = null;
});

// Sluitknoppen ochtend-briefing
document.getElementById('btn-close-briefing').addEventListener('click', () => {
  document.getElementById('modal-briefing').style.display = 'none';
});
document.getElementById('btn-briefing-ok').addEventListener('click', () => {
  document.getElementById('modal-briefing').style.display = 'none';
});

// Sluit modals bij klikken buiten het venster
document.querySelectorAll('.modal-overlay').forEach(overlay => {
  overlay.addEventListener('click', e => {
    if (e.target === overlay) overlay.style.display = 'none';
  });
});

// Escape-toets sluit open modals
document.addEventListener('keydown', e => {
  if (e.key === 'Escape') {
    document.querySelectorAll('.modal-overlay').forEach(m => {
      m.style.display = 'none';
    });
  }
});

/* ================================================================
   8. CLOUD-SYNC (Firebase Authentication + Firestore)

   Twee modi:
     - Uitgelogd: alleen localStorage (zelfde gedrag als voorheen)
     - Ingelogd:  Firestore is leidend, localStorage dient als cache

   Bij inloggen wordt gekeken of er zowel lokaal als in de cloud al
   data staat. Als beide gevuld zijn krijgt de gebruiker een keuze.
   Anders gebeurt het automatisch: lege cloud → upload lokaal,
   lege lokaal → download cloud.
   ================================================================ */

// Globale cloud-status; door persist() gebruikt om eventueel naar Firestore te schrijven
const cloud = {
  user: null,
  unsubscribe: null,   // listener-opruimer als we ingelogd zijn
  isApplyingRemote: false, // voorkomt dat een binnenkomende update opnieuw geüpload wordt
};

/**
 * Vervangt de huidige state door nieuwe data en hertekent alles,
 * zonder dat dit een upload triggert (gebruikt voor remote-updates
 * en migratie-keuzes).
 */
function applyRemoteState(remote) {
  cloud.isApplyingRemote = true;
  state.tasks      = remote.tasks      || [];
  state.categories = remote.categories || [];
  // Cache lokaal zodat de app ook offline meteen up-to-date is
  localStorage.setItem(STORAGE_KEYS.tasks,      JSON.stringify(state.tasks));
  localStorage.setItem(STORAGE_KEYS.categories, JSON.stringify(state.categories));
  renderAll();
  cloud.isApplyingRemote = false;
}

/**
 * Wordt aangeroepen zodra een gebruiker is ingelogd. Bepaalt de juiste
 * migratie-strategie, schrijft eventueel lokale data naar de cloud en
 * start vervolgens de realtime listener voor inkomende wijzigingen.
 */
async function onSignedIn(user) {
  cloud.user = user;
  updateAuthUI(user);

  try {
    const remote = await fetchRemoteState(user.uid);
    // Cloud is altijd leidend. Lokale wijzigingen worden alleen geüpload
    // als de cloud nog leeg is (eerste keer inloggen op een nieuw apparaat).
    if (remote && remote.tasks.length > 0) {
      applyRemoteState(remote);
    } else if (state.tasks.length > 0) {
      // Cloud is leeg maar we hebben hier al taken — upload ze
      await pushRemoteState(user.uid, state);
    } else if (remote) {
      // Cloud bestaat, geen taken nergens; sync alleen de categorieën
      applyRemoteState(remote);
    } else {
      // Allereerste keer inloggen ooit — upload onze defaults
      await pushRemoteState(user.uid, state);
    }

    // Start realtime listener: wijzigingen op andere apparaten verschijnen direct
    cloud.unsubscribe = subscribeRemoteState(user.uid, (remoteState) => {
      if (!remoteState) return;
      // Voorkom loop: alleen toepassen als er echt iets veranderd is
      const same =
        JSON.stringify(remoteState.tasks)      === JSON.stringify(state.tasks) &&
        JSON.stringify(remoteState.categories) === JSON.stringify(state.categories);
      if (!same) applyRemoteState(remoteState);
    });

    // Pas nu (na sync) een eventuele snelkoppeling-actie verwerken
    processPendingURLAction();
  } catch (err) {
    console.warn('Fout tijdens cloud-synchronisatie:', err);
    // Ook bij een sync-fout de snelkoppeling-actie alsnog lokaal verwerken
    processPendingURLAction();
    alert('Kon niet synchroniseren met de cloud. Je werkt nu lokaal verder.');
  }
}

/**
 * Wordt aangeroepen na uitloggen: ruim listener op, val terug op localStorage.
 */
function onSignedOut() {
  if (cloud.unsubscribe) {
    cloud.unsubscribe();
    cloud.unsubscribe = null;
  }
  cloud.user = null;
  updateAuthUI(null);
  // Lokale data blijft staan; er wordt simpelweg niets meer geüpload.

  // Niet ingelogd: eventuele snelkoppeling-actie meteen lokaal verwerken
  processPendingURLAction();
}

/**
 * Update de header: toon "Inloggen" of de naam van de gebruiker met "Uitloggen".
 */
function updateAuthUI(user) {
  const btnIn   = document.getElementById('btn-sign-in');
  const info    = document.getElementById('user-info');
  const nameEl  = document.getElementById('user-name');
  if (user) {
    btnIn.style.display   = 'none';
    info.style.display    = '';
    nameEl.textContent    = user.displayName || user.email || 'Ingelogd';
  } else {
    btnIn.style.display   = '';
    info.style.display    = 'none';
    nameEl.textContent    = '';
  }
}

/**
 * Bindt knoppen en start de auth-listener.
 */
function initCloudSync() {
  document.getElementById('btn-sign-in').addEventListener('click', async () => {
    try {
      await signInWithGoogle();
      // De rest gaat via onAuthChange hieronder
    } catch (err) {
      if (err.code !== 'auth/popup-closed-by-user' &&
          err.code !== 'auth/cancelled-popup-request') {
        console.warn('Inloggen mislukt:', err);
        alert('Inloggen is niet gelukt: ' + (err.message || err.code));
      }
    }
  });

  document.getElementById('btn-sign-out').addEventListener('click', async () => {
    await signOutUser();
    // De rest gaat via onAuthChange hieronder
  });

  // Reageert op zowel handmatig inloggen als automatisch herstel bij paginalading
  onAuthChange((user) => {
    if (user) onSignedIn(user);
    else      onSignedOut();
  });
}

/* ── SPRAAK-SNELKOPPELING (URL-parameters) ────────────────────────
   ?quickadd=<tekst>  → voegt direct toe, geen vragen (voor Siri/Shortcut)
   ?add=<tekst>       → vult de chat en doorloopt de gewone flow
   De actie wordt pas verwerkt nadat de cloud-sync is afgerond, zodat
   de taak niet wordt overschreven door binnenkomende cloud-data.
─────────────────────────────────────────────────────────────────── */
let pendingURLAction = null;

/**
 * Leest ?quickadd= / ?add= uit de URL en zet het klaar als actie.
 * Geeft true terug als er een actie gevonden is. Schoont de URL daarna op.
 */
function queueURLAction() {
  const params = new URLSearchParams(location.search);
  const quick  = params.get('quickadd');
  const ask    = params.get('add');
  if (quick)     pendingURLAction = { text: quick, auto: true };
  else if (ask)  pendingURLAction = { text: ask,   auto: false };
  else           return false;
  history.replaceState({}, '', location.pathname);
  return true;
}

function processPendingURLAction() {
  if (!pendingURLAction) return;
  const { text, auto } = pendingURLAction;
  pendingURLAction = null;
  if (auto) {
    quickAddTask(text);
  } else {
    handleChatSubmit(text);
  }
}

// Eerste keer bij laden
queueURLAction();

// Als het tabblad opnieuw getoond wordt (bijv. doordat de snelkoppeling een
// bestaand tabblad hergebruikt of vanuit de bfcache), opnieuw de URL checken.
window.addEventListener('pageshow', () => {
  if (queueURLAction()) processPendingURLAction();
});
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && queueURLAction()) {
    processPendingURLAction();
  }
});

/* ── INITIALISATIE ────────────────────────────────────────────── */
renderAll();
initCloudSync();

// Vangnet: mocht Firebase niet (op tijd) reageren, verwerk de
// snelkoppeling-actie alsnog na 3 seconden. Is hij al verwerkt, dan is
// pendingURLAction null en gebeurt er niets.
if (pendingURLAction) {
  setTimeout(processPendingURLAction, 3000);
}
