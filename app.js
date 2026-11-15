'use strict';
// Anti-framing (GitHub Pages kan geen X-Frame-Options sturen)
if (window.top !== window.self) { document.documentElement.hidden = true; throw new Error('framed'); }

const KEY = 'thuisonderhoud_v2', PREV = 'thuisonderhoud_prev';
const CATS = ['Verwarming','Ventilatie','Elektriciteit','Keuken','Badkamer','Tuin','Schoonmaak','Veiligheid','Algemeen'];
const PR = ['Hoog','Normaal','Laag'];
const U = { d:'dag', w:'week', m:'maand', y:'jaar' }, UP = { d:'dagen', w:'weken', m:'maanden', y:'jaar' };
const LBL = { open:'Gepland', late:'Te laat', today:'Vandaag', soon:'Binnenkort', done:'Afgerond', cancelled:'Geannuleerd' };
const MAXT = 5000, MAXFILE = 5 * 1024 * 1024, SOON = 14;
const has = (o, k) => Object.prototype.hasOwnProperty.call(o, k);

// ---------- DOM-helper (alleen textContent, nooit innerHTML) ----------
function h(tag, props, ...kids) {
  const e = document.createElement(tag);
  if (props) for (const k of Object.keys(props)) {
    const v = props[k];
    if (v == null || v === false) continue;
    if (k === 'class') e.className = v;
    else if (k === 'text') e.textContent = v;
    else if (k === 'data') { for (const d of Object.keys(v)) if (v[d] != null) e.dataset[d] = v[d]; }
    else if (k === 'for') e.htmlFor = v;
    else if (k.startsWith('aria-') || k === 'role') e.setAttribute(k, v);
    else e[k] = v;
  }
  for (const c of kids.flat()) {
    if (c == null || c === false) continue;
    e.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return e;
}
const $ = id => document.getElementById(id);

// ---------- Datum ----------
const pad = n => String(n).padStart(2, '0');
const iso = d => d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
const parse = s => { const [a, b, c] = s.split('-').map(Number); return new Date(a, b - 1, c); };
const dim = (y, m) => new Date(y, m + 1, 0).getDate();
const isDate = s => typeof s === 'string' && /^\d{4}-\d\d-\d\d$/.test(s) && iso(parse(s)) === s;
function addInt(s, n, u, day) {
  const d = parse(s);
  if (u === 'd') { d.setDate(d.getDate() + n); return iso(d); }
  if (u === 'w') { d.setDate(d.getDate() + 7 * n); return iso(d); }
  const mo = d.getMonth() + (u === 'y' ? 12 * n : n), y = d.getFullYear() + Math.floor(mo / 12), m = ((mo % 12) + 12) % 12;
  return y + '-' + pad(m + 1) + '-' + pad(Math.min(day || d.getDate(), dim(y, m)));
}
const T = () => iso(new Date());
const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
const fd = s => parse(s).toLocaleDateString('nl-NL', { day:'numeric', month:'short', year:'numeric' });

// ---------- Data (alles wordt gevalideerd) ----------
const clip = (v, n) => String(v == null ? '' : v).slice(0, n);
function norm(x) {
  x = x && typeof x === 'object' ? x : {};
  const d0 = String(x.due || x.date || x.datum || ''), due = isDate(d0) ? d0 : T();
  const rn = x.rep && typeof x.rep === 'object' ? Math.floor(+x.rep.n) : 0;
  const rep = rn > 0 && rn <= 999 && typeof x.rep.u === 'string' && has(U, x.rep.u) ? { n: rn, u: x.rep.u } : null;
  const day = +x.day >= 1 && +x.day <= 31 ? Math.floor(+x.day) : +due.slice(8, 10);
  const id = typeof x.id === 'string' && /^[A-Za-z0-9_-]{1,40}$/.test(x.id) ? x.id : uid();
  const st = ['open', 'done', 'cancelled'].includes(x.status) ? x.status : (x.done ? 'done' : 'open');
  return {
    id,
    name: clip(x.name || x.naam || x.title, 80).trim() || 'Naamloos',
    cat: clip(x.cat || x.categorie, 40) || 'Algemeen',
    due, rep, day,
    prio: [0, 1, 2].includes(+x.prio) ? +x.prio : 1,
    note: clip(x.note || x.notitie, 2000),
    status: st,
    created: Number.isFinite(+x.created) && +x.created > 0 ? +x.created : Date.now(),
    doneAt: isDate(x.doneAt) ? x.doneAt : null
  };
}
function normList(a) {
  const seen = new Set();
  return a.slice(0, MAXT).map(norm).filter(t => !seen.has(t.id) && seen.add(t.id));
}
function load() {
  try {
    const r = localStorage.getItem(KEY);
    if (r) return { tasks: normList(JSON.parse(r).tasks || []) };
    for (const k of ['tasks', 'taken', 'onderhoudTaken']) {
      const a = JSON.parse(localStorage.getItem(k) || 'null');
      if (Array.isArray(a)) return { tasks: normList(a) };
    }
  } catch (e) {}
  return { tasks: [] };
}

// ---------- Opslag (autosave: localStorage + IndexedDB-reservekopie) ----------
const idb = () => new Promise((res, rej) => {
  const r = indexedDB.open('thuisonderhoud', 1);
  r.onupgradeneeded = () => r.result.createObjectStore('k');
  r.onsuccess = () => res(r.result);
  r.onerror = () => rej();
});
function idbSet(v) { idb().then(d => { d.transaction('k', 'readwrite').objectStore('k').put(v, 'data'); }).catch(() => {}); }
function idbRecover() {
  try { if (localStorage.getItem(KEY)) return; } catch (e) {}
  idb().then(d => {
    const g = d.transaction('k').objectStore('k').get('data');
    g.onsuccess = () => {
      if (!g.result) return;
      try {
        const t = normList(JSON.parse(g.result).tasks || []);
        if (t.length) { S = { tasks: t }; save(); render(); toast('Gegevens hersteld uit reservekopie'); }
      } catch (e) {}
    };
  }).catch(() => {});
}
function save() {
  const j = JSON.stringify({ v: 2, tasks: S.tasks });
  try { localStorage.setItem(KEY, j); } catch (e) { toast('Opslaan mislukt (opslag vol?)'); }
  idbSet(j);
}
if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(() => {});
document.addEventListener('visibilitychange', () => { if (document.hidden) save(); });
addEventListener('pagehide', () => save());

// ---------- Installeren ----------
let deferred = null;
addEventListener('beforeinstallprompt', e => { e.preventDefault(); deferred = e; render(); });
addEventListener('appinstalled', () => { deferred = null; render(); toast('App geïnstalleerd'); });
const standalone = () => matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;

// ---------- State ----------
let S = load(), view = 'dashboard', editId = null, q = '', sort = 'date', undo = null, tt;
const find = id => S.tasks.find(t => t.id === id);
const O = t => t.status === 'open';
function stat(t) {
  if (t.status !== 'open') return t.status;
  const n = T();
  return t.due < n ? 'late' : t.due === n ? 'today' : t.due <= addInt(n, SOON, 'd') ? 'soon' : 'open';
}
const F = {
  dashboard: O, open: O, all: () => true,
  today: t => O(t) && t.due === T(),
  soon: t => O(t) && t.due > T() && t.due <= addInt(T(), SOON, 'd'),
  late: t => O(t) && t.due < T(),
  done: t => t.status === 'done', cancelled: t => t.status === 'cancelled', history: t => t.status === 'done'
};
const NAMES = { dashboard:'Dashboard', all:'Alle taken', open:'Open taken', today:'Vandaag', soon:'Binnenkort', late:'Te laat', done:'Afgeronde taken', cancelled:'Geannuleerde taken', history:'Onderhoudshistorie', form:'Nieuwe taak', settings:'Instellingen' };
const cnt = v => S.tasks.filter(F[v]).length;
const repTxt = t => t.rep ? 'Elke ' + (t.rep.n === 1 ? U[t.rep.u] : t.rep.n + ' ' + UP[t.rep.u]) : 'Eenmalig';

function complete(id) {
  const t = find(id);
  if (!t || t.status !== 'open') return;
  t.status = 'done'; t.doneAt = T();
  let nid = null;
  if (t.rep) {
    // volgende datum telt vanaf de dag van afvinken (te vroeg of te laat maakt niet uit)
    const n = { ...t, id: uid(), due: addInt(T(), t.rep.n, t.rep.u), day: +T().slice(8, 10), status: 'open', doneAt: null, created: Date.now() };
    if (!S.tasks.some(x => O(x) && x.name === n.name && x.cat === n.cat && x.due === n.due)) { S.tasks.push(n); nid = n.id; }
  }
  save(); undo = { id, nid }; toast('Taak afgerond', true); render();
}
function doUndo() {
  if (!undo) return;
  const t = find(undo.id);
  if (t) { t.status = 'open'; t.doneAt = null; }
  if (undo.nid) S.tasks = S.tasks.filter(x => x.id !== undo.nid);
  undo = null; save(); hideToast(); render();
}
function toast(m, u) {
  clearTimeout(tt);
  const e = $('toast');
  e.replaceChildren(h('span', { text: m }), u ? h('button', { type: 'button', data: { a: 'undo' }, text: 'Ongedaan maken' }) : null);
  e.classList.add('show');
  tt = setTimeout(hideToast, 5000);
}
function hideToast() { clearTimeout(tt); $('toast').classList.remove('show'); }

// ---------- Lijst ----------
function items() {
  let a = S.tasks.filter(has(F, view) ? F[view] : O);
  if (q) { const s = q.toLowerCase(); a = a.filter(t => (t.name + ' ' + t.cat + ' ' + t.note).toLowerCase().includes(s)); }
  const c = {
    date: (x, y) => x.due.localeCompare(y.due),
    name: (x, y) => x.name.localeCompare(y.name, 'nl'),
    prio: (x, y) => x.prio - y.prio || x.due.localeCompare(y.due),
    cat: (x, y) => x.cat.localeCompare(y.cat, 'nl') || x.due.localeCompare(y.due),
    new: (x, y) => y.created - x.created,
    old: (x, y) => x.created - y.created
  };
  return a.sort(view === 'history' ? (x, y) => (y.doneAt || '').localeCompare(x.doneAt || '') : (c[sort] || c.date));
}
function card(t) {
  const s = stat(t), hist = view === 'history';
  const bt = (a, txt, cls) => h('button', { type: 'button', class: 's' + (cls ? ' ' + cls : ''), data: { a, id: t.id }, text: txt });
  let btns = [];
  if (t.status === 'open') btns = [bt('done', '✓ Afvinken', 'pri'), bt('edit', 'Bewerken'), bt('cancel', 'Annuleren')];
  else if (t.status === 'cancelled') btns = [bt('restore', 'Herstellen', 'pri')];
  const dateTxt = t.status === 'done' ? '✔ Afgerond ' + fd(t.doneAt || t.due) + ' (gepland ' + fd(t.due) + ')' : '📅 ' + fd(t.due);
  return h('div', { class: 'card ' + s },
    h('div', { class: 'top' }, h('b', { text: t.name }), h('span', { class: 'b ' + s, text: LBL[s] })),
    h('div', { class: 'meta' },
      h('span', { text: t.cat }), h('span', { text: dateTxt }),
      h('span', { text: '🔁 ' + repTxt(t) }), h('span', { class: 'p' + t.prio, text: PR[t.prio] })),
    t.note ? h('div', { class: 'note', text: t.note }) : null,
    h('div', { class: 'btns' }, hist ? null : btns, bt('del', 'Verwijderen', 'dng')));
}
function renderList() {
  const l = $('list');
  if (!l) return;
  const a = items();
  l.replaceChildren(...(a.length ? a.map(card) : [h('div', { class: 'empty', text: 'Geen taken gevonden.' })]));
}

// ---------- Menu ----------
function drawer() {
  const I = [['dashboard', '🏠'], ['all', '📋'], ['open', '🔓'], ['today', '📅'], ['soon', '⏳'], ['late', '⚠️'], ['done', '✅'], ['cancelled', '🚫'], ['history', '🕘']];
  const link = (a, v, label, count, on) => h('a', { class: on ? 'on' : '', role: 'button', tabIndex: 0, data: { a, v } }, h('span', { text: label }), count != null ? h('i', { text: String(count) }) : null);
  $('drawer').replaceChildren(
    h('h2', { text: '🌿 Thuisonderhoud' }),
    ...I.map(([v, i]) => link('nav', v, i + ' ' + NAMES[v], v === 'all' ? S.tasks.length : cnt(v), view === v)),
    link('nav', 'form', '➕ Nieuwe taak', null, view === 'form'),
    link('nav', 'settings', '⚙️ Instellingen', null, view === 'settings'),
    link('export', null, '💾 Back-up maken', null, false),
    deferred && !standalone() ? link('install', null, '📲 App installeren', null, false) : null);
}

// ---------- Formulier ----------
function formEl() {
  const t = editId ? find(editId) : null, r = t && t.rep;
  const L = x => h('label', { text: x });
  const sel = (props, opts) => h('select', props, ...opts);
  return h('form', { id: 'f', autocomplete: 'off' },
    L('Naam van de taak'),
    h('input', { type: 'text', name: 'name', required: true, maxLength: 80, value: t ? t.name : '' }),
    L('Categorie'),
    sel({ name: 'cat' }, CATS.map(c => h('option', { value: c, selected: !!(t && t.cat === c), text: c }))),
    L(t ? 'Geplande datum' : 'Eerste uitvoerdatum'),
    h('input', { type: 'date', name: 'due', required: true, value: t ? t.due : T() }),
    L('Herhaling'),
    sel({ name: 'rep', id: 'rep' }, [h('option', { value: '0', text: 'Eenmalig' }), h('option', { value: '1', selected: !!r, text: 'Terugkerend' })]),
    h('div', { id: 'ri', class: r ? '' : 'hide' },
      L('Herhalingsinterval: elke…'),
      h('div', { class: 'row' },
        h('input', { type: 'number', name: 'n', min: 1, max: 999, value: String(r ? r.n : 1) }),
        sel({ name: 'u' }, Object.keys(UP).map(k => h('option', { value: k, selected: !!(r && r.u === k), text: UP[k] }))))),
    L('Prioriteit'),
    sel({ name: 'prio' }, PR.map((p, i) => h('option', { value: String(i), selected: (t ? t.prio : 1) === i, text: p }))),
    L('Notities'),
    h('textarea', { name: 'note', rows: 3, maxLength: 2000, value: t ? t.note : '' }),
    h('div', { class: 'btns' },
      h('button', { class: 's pri', type: 'submit', text: t ? 'Opslaan' : 'Taak toevoegen' }),
      h('button', { class: 's', type: 'button', data: { a: 'nav', v: 'dashboard' }, text: 'Annuleren' })));
}

function settingsEl() {
  const hd = x => h('h3', { text: x }), p = x => h('p', { class: 'h', text: x });
  const b = (a, txt, cls) => h('button', { type: 'button', class: 's' + (cls ? ' ' + cls : ''), data: { a }, text: txt });
  const app = standalone() ? [] : deferred
    ? [hd('App'), p('Installeer de app op je toestel; werkt daarna ook zonder internet.'), h('div', { class: 'btns' }, b('install', '📲 App installeren', 'pri'))]
    : [hd('App'), p('Installeren: Chrome/Android: menu ⋮ → "App installeren" (of het installeer-icoon naast de URL). iPhone/iPad (Safari): Deel-knop → "Zet op beginscherm".')];
  return [
    hd('Back-up'),
    p('Exporteer al je taken naar een JSON-bestand, of importeer een eerdere back-up.'),
    h('div', { class: 'btns' }, b('export', '💾 Back-up exporteren', 'pri'), b('pick', '📂 Back-up importeren')),
    h('input', { type: 'file', id: 'file', accept: '.json,application/json', class: 'hide' }),
    ...app,
    hd('Herstellen'),
    p('Bij importeren of wissen wordt eerst je huidige data bewaard. Hiermee zet je die terug.'),
    h('div', { class: 'btns' }, b('restorebk', '↩ Vorige gegevens herstellen')),
    hd('Gevaarlijke zone'),
    h('div', { class: 'btns' }, b('wipe', '🗑 Alle gegevens wissen', 'dng')),
    h('p', { class: 'h gap', text: 'Gegevens worden automatisch opgeslagen op dit toestel en niet naar een server gestuurd. Totaal: ' + S.tasks.length + ' taken.' })
  ];
}

function statBox(cls, key, label, extra) {
  return h('div', { class: 'stat ' + cls + (extra ? ' ' + extra : ''), data: { a: 'nav', v: key } }, h('b', { text: String(cnt(key)) }), h('span', { text: label }));
}

function render() {
  $('title').textContent = view === 'form' && editId ? 'Taak bewerken' : NAMES[view];
  drawer();
  const k = [];
  if (view === 'form') k.push(formEl());
  else if (view === 'settings') k.push(...settingsEl());
  else {
    if (view === 'dashboard') k.push(h('div', { class: 'stats' },
      statBox('today', 'today', 'Vandaag'),
      statBox('late', 'late', 'Te laat'),
      statBox('soon', 'soon', 'Binnenkort (' + SOON + ' dgn)', 'span2')));
    const bar = h('div', { class: 'bar' },
      h('input', { type: 'search', id: 'q', placeholder: 'Zoek op naam, categorie of notitie', value: q, maxLength: 100, 'aria-label': 'Zoeken' }));
    if (view !== 'history') {
      bar.append(h('select', { id: 'sort', 'aria-label': 'Sorteren' }, ...[['date', 'Datum'], ['name', 'Naam'], ['prio', 'Prioriteit'], ['cat', 'Categorie'], ['new', 'Nieuwste'], ['old', 'Oudste']]
        .map(([v, l]) => h('option', { value: v, selected: sort === v, text: 'Sorteer: ' + l }))));
      if (view !== 'dashboard') bar.append(h('select', { id: 'flt', 'aria-label': 'Filter' }, ...['all', 'open', 'today', 'soon', 'late', 'done', 'cancelled']
        .map(v => h('option', { value: v, selected: view === v, text: NAMES[v] }))));
    }
    k.push(bar, h('div', { id: 'list' }));
  }
  $('main').replaceChildren(...k);
  renderList();
}
function go(v, id) {
  if (!has(NAMES, v)) return;
  view = v; editId = id || null;
  q = view === 'history' || has(F, v) ? q : '';
  document.body.classList.remove('open');
  render(); scrollTo(0, 0);
}

// ---------- Back-up ----------
function exportData() {
  const b = new Blob([JSON.stringify({ app: 'thuisonderhoud', v: 2, exported: new Date().toISOString(), tasks: S.tasks }, null, 1)], { type: 'application/json' });
  const url = URL.createObjectURL(b), a = h('a', { href: url, download: 'thuisonderhoud-backup-' + T() + '.json' });
  document.body.append(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
  document.body.classList.remove('open'); toast('Back-up gemaakt');
}
function snap() { try { localStorage.setItem(PREV, localStorage.getItem(KEY) || JSON.stringify({ tasks: [] })); } catch (e) {} }

// ---------- Events ----------
document.addEventListener('click', e => {
  const el = e.target instanceof Element ? e.target.closest('[data-a]') : null;
  if (!el) return;
  const a = el.dataset.a, id = el.dataset.id, t = id ? find(id) : null;
  if (a === 'menu') document.body.classList.add('open');
  else if (a === 'close') document.body.classList.remove('open');
  else if (a === 'nav') go(el.dataset.v);
  else if (a === 'done') complete(id);
  else if (a === 'undo') doUndo();
  else if (a === 'edit' && t) go('form', id);
  else if (a === 'cancel' && t) { t.status = 'cancelled'; save(); toast('Taak geannuleerd'); render(); }
  else if (a === 'restore' && t) { t.status = 'open'; save(); toast('Taak hersteld'); render(); }
  else if (a === 'del' && t && confirm('"' + t.name + '" definitief verwijderen?')) { S.tasks = S.tasks.filter(x => x !== t); save(); render(); }
  else if (a === 'install') { if (deferred) { const d = deferred; d.prompt(); d.userChoice.finally(() => { deferred = null; render(); }); } document.body.classList.remove('open'); }
  else if (a === 'export') exportData();
  else if (a === 'pick') $('file').click();
  else if (a === 'restorebk') {
    const r = localStorage.getItem(PREV);
    if (!r) return toast('Geen eerdere gegevens beschikbaar');
    if (confirm('Huidige gegevens vervangen door de vorige versie?')) {
      try {
        const cur = localStorage.getItem(KEY), n = normList(JSON.parse(r).tasks || []);
        localStorage.setItem(PREV, cur || r); S = { tasks: n }; save(); render(); toast('Gegevens hersteld');
      } catch (x) { toast('Herstellen mislukt'); }
    }
  }
  else if (a === 'wipe' && confirm('ALLE taken en historie wissen? Dit kan niet ongedaan worden gemaakt (behalve via "Vorige gegevens herstellen").')) {
    snap(); S = { tasks: [] }; save(); render(); toast('Alle gegevens gewist');
  }
});
document.addEventListener('keydown', e => {
  if ((e.key === 'Enter' || e.key === ' ') && e.target instanceof Element && e.target.matches('#drawer a')) { e.preventDefault(); e.target.click(); }
});
document.addEventListener('input', e => { if (e.target.id === 'q') { q = e.target.value.slice(0, 100); renderList(); } });
document.addEventListener('change', e => {
  const i = e.target.id;
  if (i === 'sort') { sort = e.target.value; renderList(); }
  else if (i === 'flt') go(e.target.value);
  else if (i === 'rep') $('ri').classList.toggle('hide', e.target.value !== '1');
  else if (i === 'file') {
    const f = e.target.files[0];
    if (!f) return;
    if (f.size > MAXFILE) { e.target.value = ''; return toast('Bestand te groot'); }
    const r = new FileReader();
    r.onload = () => {
      try {
        const o = JSON.parse(String(r.result)), a = Array.isArray(o) ? o : o && o.tasks;
        if (!Array.isArray(a)) throw 0;
        const n = normList(a);
        if (!confirm(n.length + ' taken importeren? Huidige gegevens worden vervangen (vorige versie blijft herstelbaar).')) return;
        snap(); S = { tasks: n }; save(); render(); toast('Back-up geïmporteerd');
      } catch (x) { toast('Ongeldig back-upbestand'); }
    };
    r.readAsText(f);
  }
});
document.addEventListener('submit', e => {
  if (e.target.id !== 'f') return;
  e.preventDefault();
  const f = new FormData(e.target), name = String(f.get('name') || '').trim().slice(0, 80), due = String(f.get('due') || '');
  if (!name || !isDate(due)) return toast('Controleer naam en datum');
  const n = Math.min(999, Math.max(1, Math.floor(+f.get('n')) || 1)), u = String(f.get('u'));
  const rep = f.get('rep') === '1' && has(U, u) ? { n, u } : null;
  const cat = CATS.includes(f.get('cat')) ? f.get('cat') : 'Algemeen';
  if (S.tasks.some(x => O(x) && x.id !== editId && x.name.toLowerCase() === name.toLowerCase() && x.cat === cat && x.due === due)) return toast('Deze taak bestaat al');
  const d = { name, cat, due, rep, day: +due.slice(8, 10), prio: [0, 1, 2].includes(+f.get('prio')) ? +f.get('prio') : 1, note: String(f.get('note') || '').trim().slice(0, 2000) };
  if (editId && find(editId)) Object.assign(find(editId), d);
  else if (S.tasks.length < MAXT) S.tasks.push(norm({ ...d, id: uid(), status: 'open', created: Date.now() }));
  else return toast('Maximum aantal taken bereikt');
  save(); toast(editId ? 'Taak opgeslagen' : 'Taak toegevoegd'); go('dashboard');
});

render();
idbRecover();
if ('serviceWorker' in navigator && (location.protocol === 'https:' || location.hostname === 'localhost')) {
  addEventListener('load', () => navigator.serviceWorker.register('service-worker.js').catch(() => {}));
}
