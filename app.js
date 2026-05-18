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
 * Probeert een deadline te herkennen in de invoertekst.
 * Geeft { deadline: 'YYYY-MM-DD' | null, title: string } terug.
 * De datum wordt uit de tekst verwijderd; de rest wordt de titel.
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
    return { deadline, title };
  }

  // — "morgen"
  if (/\bmorgen\b/i.test(lower)) {
    const d = today(); d.setDate(d.getDate() + 1);
    deadline = toISODate(d);
    stripMatch('morgen');
    return { deadline, title };
  }

  // — "overmorgen"
  if (/\bovermorgen\b/i.test(lower)) {
    const d = today(); d.setDate(d.getDate() + 2);
    deadline = toISODate(d);
    stripMatch('overmorgen');
    return { deadline, title };
  }

  // — "volgende week"
  if (/\bvolgende\s+week\b/i.test(lower)) {
    const d = today(); d.setDate(d.getDate() + 7);
    deadline = toISODate(d);
    title = text.replace(/\bvolgende\s+week\b/i, '').replace(/\s{2,}/g, ' ').trim();
    return { deadline, title };
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
    return { deadline, title };
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
      return { deadline, title };
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
        return { deadline, title };
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
      return { deadline, title };
    }
  }

  return { deadline: null, title };
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

/* ── 3. CHAT-FLOW ─────────────────────────────────────────────── */

// Bewaar tijdelijk de staat van de lopende invoer
let chatState = {
  active:    false,  // Er is een vraag bezig
  title:     '',
  deadline:  null,
  category:  null,   // Wordt ingevuld na stap 1
  priority:  null,   // Wordt ingevuld na stap 2
};

const chatMessages = document.getElementById('chat-messages');
const chatInput    = document.getElementById('chat-input');
const chatForm     = document.getElementById('chat-form');

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
  const wrapper = document.createElement('div');
  wrapper.innerHTML = `<div style="margin-bottom:.4rem;font-size:.88rem;">${vraag}</div>`;
  const row = document.createElement('div');
  row.className = 'chat-choices';

  opties.forEach(({ label, value }) => {
    const btn = document.createElement('button');
    btn.className = 'choice-btn';
    btn.textContent = label;
    btn.addEventListener('click', () => {
      // Visueel tonen welke optie gekozen is
      row.querySelectorAll('.choice-btn').forEach(b => b.classList.remove('selected'));
      btn.classList.add('selected');
      // Knoppen uitschakelen zodat niet nogmaals geklikt kan worden
      row.querySelectorAll('.choice-btn').forEach(b => b.disabled = true);
      onKeuze(value);
    });
    row.appendChild(btn);
  });

  wrapper.appendChild(row);
  addChatMessage('bot', wrapper);
}

/**
 * Verwerkt de invoer van de gebruiker: herkent datum, toont bevestiging
 * en start de multiplechoice-flow voor categorie en prioriteit.
 */
function handleChatSubmit(rawInput) {
  if (!rawInput.trim()) return;
  if (chatState.active) {
    chatInput.disabled = false; // Herstel het invoerveld als de flow al bezig is
    return;
  }

  const { deadline, title } = parseDateFromText(rawInput);

  // Laat de gebruiker zien wat er ingevoerd is
  addChatMessage('user', escapeHtml(rawInput));

  // Toon herkenningsbevestiging
  const datumTekst = deadline
    ? `Deadline herkend: <strong>${formatDate(deadline)}</strong>`
    : 'Geen deadline herkend.';
  addChatMessage('bot',
    `Taak: <strong>${escapeHtml(title || rawInput)}</strong><br>${datumTekst}`
  );

  chatState = { active: true, title: title || rawInput, deadline, category: null, priority: null };

  // Stap 1: categorie kiezen
  const catOpties = state.categories.map(c => ({ label: c, value: c }));
  catOpties.push({ label: 'Geen categorie', value: '' });

  addChoiceBubble('Welke categorie?', catOpties, (cat) => {
    chatState.category = cat;

    // Stap 2: prioriteit kiezen
    addChoiceBubble('Welke prioriteit?', [
      { label: 'Hoog',   value: 'hoog'   },
      { label: 'Midden', value: 'midden' },
      { label: 'Laag',   value: 'laag'   },
    ], (prio) => {
      chatState.priority = prio;
      commitTask();
    });
  });
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
    done:      false,
    createdAt: new Date().toISOString(),
  };

  state.tasks.push(task);
  persist();
  renderTasks();
  renderStats();

  const catLabel = task.category || 'Geen categorie';
  addChatMessage('bot',
    `Taak toegevoegd: <strong>${escapeHtml(task.title)}</strong> — ${catLabel}, ${task.priority}`
    + (task.deadline ? `, deadline ${formatDate(task.deadline)}` : '')
  );

  chatState = { active: false, title: '', deadline: null, category: null, priority: null };
  chatInput.disabled = false;
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
 * Leest de huidige filterwaarden uit de UI.
 */
function getFilters() {
  return {
    search:   document.getElementById('filter-search').value.trim().toLowerCase(),
    category: document.getElementById('filter-category').value,
    priority: document.getElementById('filter-priority').value,
  };
}

/**
 * Filtert de takenlijst op basis van de actieve filters.
 */
function applyFilters(tasks) {
  const { search, category, priority } = getFilters();
  return tasks.filter(t => {
    if (search   && !t.title.toLowerCase().includes(search))   return false;
    if (category && t.category !== category)                    return false;
    if (priority && t.priority !== priority)                    return false;
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
  btnEdit.innerHTML = '&#9998;';
  btnEdit.addEventListener('click', () => openEditModal(task.id));

  const btnDel = document.createElement('button');
  btnDel.className = 'btn-icon';
  btnDel.title = 'Verwijderen';
  btnDel.innerHTML = '&#128465;';
  btnDel.addEventListener('click', () => confirmDeleteTask(task.id));

  actions.appendChild(btnEdit);
  actions.appendChild(btnDel);
  li.appendChild(actions);

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
  const sel = document.getElementById('filter-category');
  const current = sel.value;
  sel.innerHTML = '<option value="">Alle categorieën</option>';
  state.categories.forEach(c => {
    const opt = document.createElement('option');
    opt.value = c;
    opt.textContent = c;
    if (c === current) opt.selected = true;
    sel.appendChild(opt);
  });
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

// Chat
chatForm.addEventListener('submit', e => {
  e.preventDefault();
  const val = chatInput.value;
  chatInput.value = '';
  chatInput.disabled = true;
  handleChatSubmit(val);
});

// Filters
document.getElementById('filter-search').addEventListener('input', renderTasks);
document.getElementById('filter-category').addEventListener('change', renderTasks);
document.getElementById('filter-priority').addEventListener('change', renderTasks);
document.getElementById('btn-clear-filters').addEventListener('click', () => {
  document.getElementById('filter-search').value   = '';
  document.getElementById('filter-category').value = '';
  document.getElementById('filter-priority').value = '';
  renderTasks();
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
  } catch (err) {
    console.warn('Fout tijdens cloud-synchronisatie:', err);
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

/* ── INITIALISATIE ────────────────────────────────────────────── */
renderAll();
initCloudSync();
