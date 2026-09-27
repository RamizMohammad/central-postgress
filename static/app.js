/* central-postgres admin panel — no build step, no dependencies. */
'use strict';

// ============================================================ tiny DOM helpers
function h(tag, attrs, ...kids) {
  const el = document.createElement(tag);
  if (attrs) {
    for (const [k, v] of Object.entries(attrs)) {
      if (v == null || v === false) continue;
      if (k === 'class') el.className = v;
      else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
      else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2).toLowerCase(), v);
      else if (k === 'value') el.value = v;
      else if (k === 'checked') el.checked = !!v;
      else if (k === 'selected') el.selected = !!v;
      else if (k === 'disabled') el.disabled = !!v;
      else if (k === 'html') el.innerHTML = v; // only ever used with trusted constants (icons)
      else el.setAttribute(k, v === true ? '' : v);
    }
  }
  append(el, kids);
  return el;
}
function append(el, kids) {
  for (const k of kids.flat(Infinity)) {
    if (k == null || k === false || k === true) continue;
    el.appendChild(k instanceof Node ? k : document.createTextNode(String(k)));
  }
  return el;
}
function clear(el) { while (el.firstChild) el.removeChild(el.firstChild); return el; }

const ICONS = {
  db: '<ellipse cx="12" cy="5" rx="8" ry="3"/><path d="M4 5v14c0 1.7 3.6 3 8 3s8-1.3 8-3V5"/><path d="M4 12c0 1.7 3.6 3 8 3s8-1.3 8-3"/>',
  home: '<path d="M3 11l9-8 9 8"/><path d="M5 10v10h14V10"/>',
  users: '<circle cx="9" cy="8" r="3.5"/><path d="M2.5 20c.8-3.6 3.4-5.5 6.5-5.5s5.7 1.9 6.5 5.5"/><circle cx="17" cy="9" r="2.5"/><path d="M17 14c2.3 0 4 1.5 4.6 4.5"/>',
  sql: '<path d="M8 9l-4 3 4 3"/><path d="M16 9l4 3-4 3"/><path d="M13.5 6l-3 12"/>',
  table: '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M3 10h18M3 15h18M9 10v10"/>',
  view: '<path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  refresh: '<path d="M20 11a8 8 0 1 0-2.3 5.7"/><path d="M20 4v7h-7"/>',
  trash: '<path d="M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3"/>',
  edit: '<path d="M4 20h4L19 9l-4-4L4 16v4z"/>',
  download: '<path d="M12 4v11M7 10l5 5 5-5M5 20h14"/>',
  upload: '<path d="M12 20V9M7 14l5-5 5 5M5 4h14"/>',
  filter: '<path d="M3 5h18l-7 8v6l-4 2v-8z"/>',
  play: '<path d="M7 4l13 8-13 8z"/>',
  copy: '<rect x="8" y="8" width="12" height="12" rx="2"/><path d="M16 8V5a1 1 0 0 0-1-1H5a1 1 0 0 0-1 1v10a1 1 0 0 0 1 1h3"/>',
  x: '<path d="M6 6l12 12M18 6L6 18"/>',
  key: '<circle cx="8" cy="15" r="4"/><path d="M11 12l9-9M17 6l3 3"/>',
  menu: '<path d="M4 6h16M4 12h16M4 18h16"/>',
  logout: '<path d="M15 4h4v16h-4"/><path d="M10 8l-4 4 4 4M6 12h11"/>',
  shield: '<path d="M12 3l8 3v6c0 5-3.5 8-8 9-4.5-1-8-4-8-9V6z"/>',
  history: '<path d="M3 12a9 9 0 1 0 3-6.7"/><path d="M3 4v5h5M12 8v4l3 2"/>',
  file: '<path d="M6 3h8l5 5v13H6z"/><path d="M14 3v5h5"/>',
};
function icon(name, size) {
  const s = size || 16;
  return h('span', {
    style: { display: 'inline-flex' },
    html: `<svg width="${s}" height="${s}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">${ICONS[name] || ''}</svg>`,
  });
}
const LOGO = '<svg width="28" height="28" viewBox="0 0 32 32"><rect width="32" height="32" rx="8" fill="#4f7cff"/><ellipse cx="16" cy="10" rx="8" ry="3.2" fill="white"/><path d="M8 10v12c0 1.8 3.6 3.2 8 3.2s8-1.4 8-3.2V10" fill="none" stroke="white" stroke-width="2.2"/><path d="M8 16c0 1.8 3.6 3.2 8 3.2s8-1.4 8-3.2" fill="none" stroke="white" stroke-width="2.2"/></svg>';

function btn(label, onClick, opts = {}) {
  return h('button', {
    type: opts.type || 'button',
    class: 'btn ' + (opts.class || ''),
    onclick: onClick,
    title: opts.title,
    disabled: opts.disabled,
  }, opts.icon ? icon(opts.icon) : null, label);
}

// ============================================================ formatting
const nf = new Intl.NumberFormat();
function fmtNum(n) { return n == null ? '—' : nf.format(n); }
function fmtBytes(b) {
  if (b == null) return '—';
  const u = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0; let v = Number(b);
  while (v >= 1024 && i < u.length - 1) { v /= 1024; i++; }
  return (i === 0 ? v : v.toFixed(v < 10 ? 1 : 0)) + ' ' + u[i];
}
function shortNum(n) {
  if (n == null) return '';
  if (n < 1000) return String(n);
  if (n < 1e6) return (n / 1e3).toFixed(n < 1e4 ? 1 : 0) + 'k';
  if (n < 1e9) return (n / 1e6).toFixed(n < 1e7 ? 1 : 0) + 'M';
  return (n / 1e9).toFixed(1) + 'B';
}
function since(iso) {
  if (!iso) return '—';
  const s = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 60) return Math.floor(s) + 's';
  if (s < 3600) return Math.floor(s / 60) + 'm';
  if (s < 86400) return Math.floor(s / 3600) + 'h ' + Math.floor((s % 3600) / 60) + 'm';
  return Math.floor(s / 86400) + 'd ' + Math.floor((s % 86400) / 3600) + 'h';
}
const enc = encodeURIComponent;

// ============================================================ storage (best-effort)
const store = {
  get(k, d) { try { const v = localStorage.getItem('cp:' + k); return v == null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem('cp:' + k, JSON.stringify(v)); } catch { /* ignore */ } },
};

// ============================================================ API
class ApiError extends Error {
  constructor(status, body) {
    let msg = (body && (typeof body.detail === 'string' ? body.detail : JSON.stringify(body.detail))) || `HTTP ${status}`;
    super(msg);
    this.status = status;
    this.body = body || {};
  }
  get full() {
    const b = this.body;
    return [this.message, b.pg_detail && ('Detail: ' + b.pg_detail), b.pg_hint && ('Hint: ' + b.pg_hint)].filter(Boolean).join('\n');
  }
}
async function api(method, path, body, { raw = false } = {}) {
  const opts = { method, headers: { 'X-CP-Client': 'panel' }, credentials: 'same-origin' };
  if (body instanceof FormData) opts.body = body;
  else if (body !== undefined) { opts.body = JSON.stringify(body); opts.headers['Content-Type'] = 'application/json'; }
  const res = await fetch(path, opts);
  if (raw) return res;
  let data = null;
  const text = await res.text();
  try { data = text ? JSON.parse(text) : null; } catch { data = { detail: text }; }
  if (res.status === 401 && !path.startsWith('/api/auth/login')) {
    state.user = null;
    renderLogin('Your session ended. Please sign in again.');
    throw new ApiError(401, data);
  }
  if (!res.ok) {
    if (Array.isArray(data && data.detail)) data.detail = data.detail.map(d => `${(d.loc || []).slice(1).join('.')}: ${d.msg}`).join('\n');
    throw new ApiError(res.status, data);
  }
  return data;
}
const GET = (p) => api('GET', p);
const POST = (p, b) => api('POST', p, b ?? {});
const PATCH = (p, b) => api('PATCH', p, b ?? {});
const DEL = (p, b) => api('DELETE', p, b);
function qs(obj) {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(obj)) if (v != null && v !== '') p.set(k, v);
  const s = p.toString();
  return s ? '?' + s : '';
}
function download(url) {
  const a = h('a', { href: url, download: '' });
  document.body.appendChild(a); a.click(); a.remove();
}

// ============================================================ toasts & modals
function toast(msg, type = 'ok', title) {
  const el = h('div', { class: 'toast ' + (type === 'error' ? 'error' : '') }, title ? h('div', { class: 't' }, title) : null, msg);
  document.getElementById('toasts').appendChild(el);
  const all = document.querySelectorAll('#toasts .toast');
  if (all.length > 4) all[0].remove();
  setTimeout(() => el.remove(), type === 'error' ? 9000 : 2600);
}
function toastErr(e, title = 'Something went wrong') {
  if (e && e.status === 401) return;
  toast(e instanceof ApiError ? e.full : String(e && e.message || e), 'error', title);
}

/**
 * modal({ title, body, size, actions: [{label, primary, danger, left, onClick: async () => result|false }] })
 * Returns a promise resolving to the onClick result (or null when dismissed).
 * If onClick returns false (or throws), the modal stays open.
 */
function modal({ title, body, size = '', actions = [], dismissable = true }) {
  return new Promise((resolve) => {
    const prevFocus = document.activeElement;
    const close = (val) => { overlay.remove(); document.removeEventListener('keydown', onKey); resolve(val); prevFocus && prevFocus.focus && prevFocus.focus(); };
    const onKey = (e) => {
      if (e.key === 'Escape' && dismissable) close(null);
      if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { const p = foot.querySelector('.btn.primary'); p && p.click(); }
    };
    const foot = h('div', { class: 'modal-foot' });
    for (const a of actions) {
      const b = h('button', { type: 'button', class: 'btn ' + (a.primary ? 'primary ' : '') + (a.danger ? 'danger solid ' : '') + (a.left ? 'left ' : '') }, a.label);
      b.addEventListener('click', async () => {
        if (!a.onClick) return close(null);
        b.disabled = true;
        try {
          const r = await a.onClick();
          if (r !== false) close(r === undefined ? true : r);
        } catch (e) { toastErr(e); } finally { b.disabled = false; }
      });
      foot.appendChild(b);
    }
    const m = h('div', { class: 'modal ' + size, role: 'dialog', 'aria-modal': 'true' },
      h('div', { class: 'modal-head' }, h('h2', null, title), h('button', { class: 'btn ghost icon', onclick: () => close(null), 'aria-label': 'Close' }, icon('x'))),
      h('div', { class: 'modal-body' }, body),
      actions.length ? foot : null);
    const overlay = h('div', { class: 'overlay', onmousedown: (e) => { if (e.target === overlay && dismissable) close(null); } }, m);
    document.body.appendChild(overlay);
    document.addEventListener('keydown', onKey);
    const first = m.querySelector('input:not([type=checkbox]), textarea, select');
    if (first) setTimeout(() => first.focus(), 20);
  });
}
function confirmDanger({ title, message, confirmLabel = 'Delete', typeToConfirm = null, extra = null }) {
  const input = typeToConfirm ? h('input', { class: 'input mono', placeholder: typeToConfirm, autocomplete: 'off' }) : null;
  return modal({
    title,
    body: [h('p', { style: { margin: 0 } }, message),
      extra,
      typeToConfirm ? h('label', { class: 'field' }, h('span', null, 'Type ', h('code', null, typeToConfirm), ' to confirm'), input) : null],
    actions: [
      { label: 'Cancel' },
      {
        label: confirmLabel, danger: true, onClick: () => {
          if (typeToConfirm && input.value !== typeToConfirm) { toast('The name does not match', 'error'); return false; }
          return true;
        },
      },
    ],
  });
}
function field(label, input, hint) {
  return h('label', { class: 'field' }, h('span', null, label, hint ? h('span', { class: 'hint' }, ' — ' + hint) : null), input);
}
function checkbox(label, checked = false, attrs = {}) {
  const input = h('input', Object.assign({ type: 'checkbox', checked }, attrs));
  const el = h('label', { class: 'check' }, input, label);
  el.input = input;
  return el;
}
function select(options, value, attrs = {}) {
  return h('select', Object.assign({ class: 'input' }, attrs),
    options.map(o => {
      const [v, l] = Array.isArray(o) ? o : [o, o];
      return h('option', { value: v, selected: v === value }, l);
    }));
}
function copyText(text) {
  const done = () => toast('Copied to clipboard');
  if (navigator.clipboard && window.isSecureContext) return navigator.clipboard.writeText(text).then(done, () => fallback());
  fallback();
  function fallback() {
    const t = h('textarea', { style: { position: 'fixed', opacity: '0' } }); t.value = text;
    document.body.appendChild(t); t.select();
    try { document.execCommand('copy'); done(); } catch { toast('Copy failed', 'error'); }
    t.remove();
  }
}
function secretBox(value) {
  const input = h('input', { class: 'input', value, readonly: true, onfocus: (e) => e.target.select() });
  return h('div', { class: 'secret' }, input, btn('Copy', () => copyText(value), { icon: 'copy' }));
}

// ============================================================ state & routing
const state = {
  user: null,
  dbs: [],
  db: null,
  schema: store.get('schema', 'public'),
  schemas: [],
  tables: [],
  tableFilter: '',
  grids: {},
  defaultDb: null,
};
let renderSeq = 0;

function parseRoute() {
  const parts = location.hash.replace(/^#\/?/, '').split('/').filter(Boolean).map(decodeURIComponent);
  if (!parts.length || parts[0] === 'overview') return { page: 'overview' };
  if (parts[0] === 'databases') return { page: 'databases' };
  if (parts[0] === 'roles') return { page: 'roles' };
  if (parts[0] === 'db' && parts[1]) {
    const db = parts[1];
    if (parts[2] === 'sql') return { page: 'sql', db };
    if (parts[2] === 't' && parts[3] && parts[4]) return { page: 'table', db, schema: parts[3], table: parts[4], tab: parts[5] || 'data' };
    return { page: 'db', db };
  }
  return { page: 'overview' };
}
const link = {
  overview: () => '#/overview',
  databases: () => '#/databases',
  roles: () => '#/roles',
  db: (db) => `#/db/${enc(db)}`,
  sql: (db) => `#/db/${enc(db)}/sql`,
  table: (db, s, t, tab = 'data') => `#/db/${enc(db)}/t/${enc(s)}/${enc(t)}/${tab}`,
};
function go(hash) { if (location.hash === hash) route(); else location.hash = hash; }
window.addEventListener('hashchange', () => route());

// ============================================================ login
function renderLogin(message) {
  clear($app);
  const err = h('div', { class: 'err' }, message || '');
  const user = h('input', { class: 'input', name: 'username', autocomplete: 'username', value: 'admin' });
  const pass = h('input', { class: 'input', name: 'password', type: 'password', autocomplete: 'current-password' });
  const submit = h('button', { class: 'btn primary', type: 'submit', style: { height: '36px' } }, 'Sign in');
  const form = h('form', {
    onsubmit: async (e) => {
      e.preventDefault();
      submit.disabled = true; err.textContent = '';
      try {
        const r = await api('POST', '/api/auth/login', { username: user.value, password: pass.value });
        state.user = r.user;
        await boot();
      } catch (ex) { err.textContent = ex.message; pass.select(); } finally { submit.disabled = false; }
    },
  },
  h('div', { class: 'brand' }, h('span', { html: LOGO }), h('div', null, 'central-postgres', h('small', null, 'Database admin panel'))),
  field('Username', user), field('Password', pass), err, submit);
  $app.appendChild(h('div', { class: 'login' }, form));
  setTimeout(() => (user.value ? pass : user).focus(), 20);
}

// ============================================================ shell
const $app = document.getElementById('app');
let $sidebar, $main, $shell;

function renderShell() {
  clear($app);
  $sidebar = h('aside', { class: 'sidebar' });
  $main = h('main', { class: 'main' });
  $shell = h('div', { class: 'shell' }, $sidebar, $main);
  $app.appendChild($shell);
}

async function loadDatabases() {
  state.dbs = await GET('/api/databases');
  const def = state.dbs.find(d => d.is_default);
  state.defaultDb = def ? def.name : (state.dbs[0] && state.dbs[0].name);
  if (!state.db || !state.dbs.some(d => d.name === state.db)) state.db = store.get('db', state.defaultDb);
  if (!state.dbs.some(d => d.name === state.db)) state.db = state.defaultDb;
}
async function loadSchemaAndTables() {
  if (!state.db) return;
  try {
    state.schemas = await GET(`/api/db/${enc(state.db)}/schemas`);
  } catch (e) { state.schemas = []; state.tables = []; toastErr(e, `Cannot open database ${state.db}`); return; }
  if (!state.schemas.some(s => s.name === state.schema)) state.schema = (state.schemas[0] && state.schemas[0].name) || 'public';
  await refreshTables(false);
}
async function refreshTables(rerender = true) {
  try { state.tables = await GET(`/api/db/${enc(state.db)}/tables${qs({ schema: state.schema })}`); } catch (e) { state.tables = []; toastErr(e); }
  if (rerender) renderSidebar();
}

function renderSidebar() {
  const r = parseRoute();
  const navItem = (href, ic, label, active) => h('a', { href, class: active ? 'active' : '' }, icon(ic), label);
  const dbSel = select(state.dbs.map(d => d.name), state.db, {
    class: 'input sm',
    onchange: (e) => go(link.db(e.target.value)),
    'aria-label': 'Database',
  });
  const schemaSel = select(state.schemas.map(s => [s.name, `${s.name} (${s.tables})`]), state.schema, {
    class: 'input sm',
    onchange: async (e) => {
      state.schema = e.target.value; store.set('schema', state.schema);
      await refreshTables();
      if (r.page === 'db') route();
    },
    'aria-label': 'Schema',
  });
  const listEl = h('div', { class: 'table-list' });
  const drawList = () => {
    clear(listEl);
    const f = state.tableFilter.toLowerCase();
    const items = state.tables.filter(t => !f || t.name.toLowerCase().includes(f));
    if (!items.length) listEl.appendChild(h('div', { class: 'empty' }, state.tables.length ? 'No match' : 'No tables in this schema'));
    for (const t of items) {
      const active = r.page === 'table' && r.db === state.db && r.schema === state.schema && r.table === t.name;
      listEl.appendChild(h('a', { href: link.table(state.db, state.schema, t.name, r.page === 'table' ? r.tab : 'data'), class: active ? 'active' : '', title: t.name },
        icon(t.kind === 'v' || t.kind === 'm' ? 'view' : 'table', 14), h('span', { style: { overflow: 'hidden', textOverflow: 'ellipsis' } }, t.name),
        h('span', { class: 'count' }, t.kind === 'v' ? 'view' : (t.row_estimate ? shortNum(t.row_estimate) : ''))));
    }
  };
  const filter = h('input', {
    class: 'input sm', placeholder: 'Filter tables…', value: state.tableFilter,
    oninput: (e) => { state.tableFilter = e.target.value; drawList(); },
  });
  drawList();

  clear($sidebar);
  append($sidebar, [
    h('div', { class: 'brand' }, h('span', { html: LOGO }), h('div', null, 'central-postgres', h('small', null, state.dbs.length + ' databases'))),
    h('nav', { class: 'nav' },
      navItem(link.overview(), 'home', 'Overview', r.page === 'overview'),
      navItem(link.databases(), 'db', 'Databases', r.page === 'databases'),
      navItem(link.roles(), 'users', 'Roles & access', r.page === 'roles'),
      navItem(link.sql(state.db), 'sql', 'SQL console', r.page === 'sql')),
    h('div', { class: 'side-section' },
      h('div', { class: 'side-label' }, 'Database', h('a', { href: link.db(state.db), style: { fontSize: '11.5px' } }, 'open')),
      dbSel,
      h('div', { class: 'side-label' }, 'Schema'),
      schemaSel,
      h('div', { class: 'side-label' }, 'Tables', btn('New', () => newTableModal(), { class: 'sm ghost', icon: 'plus' })),
      filter),
    listEl,
    h('div', { class: 'side-foot' }, h('span', null, 'Signed in as ', h('strong', null, state.user)),
      btn('', logout, { class: 'sm ghost icon', icon: 'logout', title: 'Sign out' })),
  ]);
}

async function logout() {
  try { await POST('/api/auth/logout'); } catch { /* ignore */ }
  state.user = null;
  renderLogin();
}

function setMain({ crumbs = [], title, actions = [], tabs = null, body, flush = false }) {
  clear($main);
  const topbar = h('div', { class: 'topbar' },
    btn('', () => $shell.classList.toggle('nav-open'), { class: 'ghost icon menu-btn', icon: 'menu' }),
    h('div', { class: 'crumbs' }, crumbs.map((c) => [h('a', { href: c[1] }, c[0]), h('span', { class: 'sep' }, '/')]), h('strong', null, title)),
    h('div', { class: 'actions' }, actions));
  const content = h('div', { class: 'content' + (flush ? ' flush' : '') }, body);
  append($main, [topbar, tabs, content]);
  $shell.classList.remove('nav-open');
  return content;
}
function loadingView() { return h('div', { class: 'loading' }, h('span', { class: 'spinner' }), 'Loading…'); }

async function route() {
  if (!state.user) return;
  const r = parseRoute();
  const seq = ++renderSeq;
  if (r.db && r.db !== state.db) {
    state.db = r.db; store.set('db', r.db);
    await loadSchemaAndTables();
  }
  if (r.page === 'table' && r.schema !== state.schema) {
    state.schema = r.schema; store.set('schema', r.schema);
    await refreshTables(false);
  }
  if (seq !== renderSeq) return;
  renderSidebar();
  const views = { overview: viewOverview, databases: viewDatabases, roles: viewRoles, db: viewDb, sql: viewSql, table: viewTable };
  try {
    await views[r.page](r, seq);
  } catch (e) {
    if (seq !== renderSeq) return;
    toastErr(e);
    setMain({ title: 'Error', body: h('div', { class: 'error-box' }, e instanceof ApiError ? e.full : String(e)) });
  }
}

// ============================================================ overview
async function viewOverview(r, seq) {
  setMain({ title: 'Overview', body: loadingView() });
  const o = await GET('/api/overview');
  if (seq !== renderSeq) return;
  const s = o.server;
  const pct = Math.min(100, Math.round((s.connections / s.max_connections) * 100));
  const roleBadges = [
    s.is_superuser && h('span', { class: 'badge warn' }, 'superuser'),
    s.can_create_db && h('span', { class: 'badge' }, 'createdb'),
    s.can_create_role && h('span', { class: 'badge' }, 'createrole'),
  ];
  const maxSize = Math.max(1, ...o.databases.map(d => d.size_bytes || 0));
  const actBody = o.activity.length ? h('table', { class: 'list' },
    h('thead', null, h('tr', null, ['PID', 'Database', 'User', 'Application', 'State', 'Client', 'Connected', 'Query', ''].map(x => h('th', null, x)))),
    h('tbody', null, o.activity.map(a => h('tr', null,
      h('td', { class: 'mono' }, a.pid), h('td', null, a.datname), h('td', null, a.usename), h('td', { class: 'muted' }, a.application_name || '—'),
      h('td', null, h('span', { class: 'badge ' + (a.state === 'active' ? 'ok' : a.state && a.state.startsWith('idle in') ? 'warn' : '') }, a.state || '—')),
      h('td', { class: 'mono muted' }, a.client_addr || 'local'), h('td', { class: 'nowrap' }, since(a.backend_start)),
      h('td', { class: 'mono', style: { maxWidth: '380px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }, title: a.query }, a.query || ''),
      h('td', { class: 'actions' }, btn('Kill', async () => {
        if (!await confirmDanger({ title: 'Terminate connection?', message: `This ends backend ${a.pid} (${a.usename} on ${a.datname}).`, confirmLabel: 'Terminate' })) return;
        try { await POST(`/api/connections/${a.pid}/terminate`); toast('Connection terminated'); route(); } catch (e) { toastErr(e); }
      }, { class: 'sm danger' })))))) : h('div', { class: 'empty' }, 'No other connections');

  setMain({
    title: 'Overview',
    actions: [btn('Refresh', () => route(), { icon: 'refresh' }), btn('New database', () => newDatabaseModal(), { class: 'primary', icon: 'plus' })],
    body: [
      h('div', { class: 'cards' },
        h('div', { class: 'card' }, h('div', { class: 'k' }, 'PostgreSQL'), h('div', { class: 'v' }, (s.server_version || '').split(' ')[0]), h('div', { class: 's' }, 'up ' + since(s.started_at))),
        h('div', { class: 'card' }, h('div', { class: 'k' }, 'Connections'), h('div', { class: 'v' }, `${s.connections} / ${s.max_connections}`), h('div', { class: 'bar' }, h('i', { style: { width: pct + '%', background: pct > 80 ? 'var(--danger)' : '' } }))),
        h('div', { class: 'card' }, h('div', { class: 'k' }, 'Total size'), h('div', { class: 'v' }, fmtBytes(o.total_size_bytes)), h('div', { class: 's' }, o.databases.length + ' databases')),
        h('div', { class: 'card' }, h('div', { class: 'k' }, 'Connected as'), h('div', { class: 'v', style: { fontSize: '17px' } }, s.current_user), h('div', { class: 's badges' }, roleBadges))),
      h('div', { class: 'section' },
        h('div', { class: 'section-head' }, h('h3', null, 'Databases'), h('div', { class: 'actions' }, h('a', { href: link.databases() }, 'Manage →'))),
        h('table', { class: 'list' }, h('tbody', null, o.databases.map(d => h('tr', null,
          h('td', { style: { width: '30%' } }, h('a', { href: link.db(d.name) }, d.name)),
          h('td', null, h('div', { class: 'bar', style: { marginTop: 0 } }, h('i', { style: { width: Math.max(1, ((d.size_bytes || 0) / maxSize) * 100) + '%' } }))),
          h('td', { class: 'num', style: { width: '110px' } }, fmtBytes(d.size_bytes))))))),
      h('div', { class: 'section' },
        h('div', { class: 'section-head' }, h('h3', null, 'Active connections'), h('span', { class: 'muted' }, o.activity.length)),
        h('div', { style: { overflowX: 'auto' } }, actBody)),
      h('p', { class: 'faint', style: { fontSize: '12px' } }, s.version, ' · API docs at ', h('a', { href: '/api/docs', target: '_blank' }, '/api/docs')),
    ],
  });
}

// ============================================================ databases
async function viewDatabases(r, seq) {
  setMain({ title: 'Databases', body: loadingView() });
  await loadDatabases();
  if (seq !== renderSeq) return;
  renderSidebar();
  setMain({
    title: 'Databases',
    actions: [btn('Refresh', () => route(), { icon: 'refresh' }), btn('New database', () => newDatabaseModal(), { class: 'primary', icon: 'plus' })],
    body: h('div', { class: 'section' }, h('div', { style: { overflowX: 'auto' } }, h('table', { class: 'list' },
      h('thead', null, h('tr', null, h('th', null, 'Name'), h('th', null, 'Owner'), h('th', { class: 'num' }, 'Size'), h('th', { class: 'num' }, 'Conns'), h('th', null, 'Encoding'), h('th', null, ''))),
      h('tbody', null, state.dbs.map(d => h('tr', null,
        h('td', null, h('div', { class: 'row', style: { gap: '8px' } },
          d.can_connect ? h('a', { href: link.db(d.name), style: { fontWeight: 600 } }, d.name) : h('span', { style: { fontWeight: 600 } }, d.name),
          d.is_default && h('span', { class: 'badge accent' }, 'default'),
          d.protected && !d.is_default && h('span', { class: 'badge' }, 'protected'),
          !d.can_connect && h('span', { class: 'badge warn' }, 'no access')),
        d.comment && h('div', { class: 'faint', style: { fontSize: '12px' } }, d.comment)),
        h('td', null, d.owner), h('td', { class: 'num' }, fmtBytes(d.size_bytes)), h('td', { class: 'num' }, d.connections),
        h('td', { class: 'muted' }, d.encoding),
        h('td', { class: 'actions' },
          d.can_connect && btn('SQL', () => go(link.sql(d.name)), { class: 'sm' }),
          d.can_connect && btn('Backup', () => backupModal(d.name), { class: 'sm', icon: 'download' }),
          btn('Edit', () => editDatabaseModal(d), { class: 'sm' }),
          !d.protected && btn('Drop', () => dropDatabase(d), { class: 'sm danger' }))))))))
  });
}

async function newDatabaseModal() {
  let roles = [];
  try { roles = await GET('/api/roles'); } catch { /* optional */ }
  const name = h('input', { class: 'input mono', placeholder: 'my_app', autocomplete: 'off' });
  const mkUser = checkbox('Create a dedicated login user that owns this database', true);
  const uname = h('input', { class: 'input mono', placeholder: 'same as database name' });
  const upass = h('input', { class: 'input mono', placeholder: 'leave blank to generate a strong one' });
  const owner = select([['', '(me)'], ...roles.map(r => r.name)], '');
  const comment = h('input', { class: 'input', placeholder: 'optional' });
  const userBox = h('div', { class: 'grid2' }, field('User name', uname), field('Password', upass));
  const ownerBox = field('Owner', owner);
  const sync = () => { userBox.style.display = mkUser.input.checked ? '' : 'none'; ownerBox.style.display = mkUser.input.checked ? 'none' : ''; };
  mkUser.input.addEventListener('change', sync); sync();
  const res = await modal({
    title: 'New database',
    body: [field('Database name', name), mkUser, userBox, ownerBox, field('Comment', comment),
      h('div', { class: 'callout info' }, 'Tip: one database + one user per app keeps your services isolated from each other.')],
    actions: [{ label: 'Cancel' }, {
      label: 'Create database', primary: true, onClick: () => POST('/api/databases', {
        name: name.value.trim(),
        create_user: mkUser.input.checked,
        user_name: uname.value.trim() || null,
        user_password: upass.value || null,
        owner: mkUser.input.checked ? null : (owner.value || null),
        comment: comment.value || null,
      }),
    }],
  });
  if (!res) return;
  toast(`Database ${res.name} created`);
  await loadDatabases(); renderSidebar();
  if (res.connection_url) {
    await modal({
      title: 'Database ready',
      body: [
        h('p', { style: { margin: 0 } }, 'Database ', h('code', null, res.name), ' is owned by user ', h('code', null, res.user.name), '.'),
        field('Password', secretBox(res.user.password)),
        field('Connection URL', secretBox(res.connection_url), 'put this in your app\'s DATABASE_URL'),
        h('div', { class: 'callout' }, 'Copy the password now — it is not stored anywhere and will not be shown again. You can reset it later from Roles.'),
      ],
      actions: [{ label: 'Done', primary: true }],
      dismissable: false,
    });
  }
  go(link.db(res.name));
}

async function editDatabaseModal(d) {
  let roles = [];
  try { roles = await GET('/api/roles'); } catch { /* ignore */ }
  const name = h('input', { class: 'input mono', value: d.name, disabled: d.protected });
  const owner = select(roles.map(r => r.name), d.owner);
  const comment = h('input', { class: 'input', value: d.comment || '' });
  const res = await modal({
    title: `Edit ${d.name}`,
    body: [field('Name', name, d.protected ? 'protected' : 'renaming disconnects everyone'), field('Owner', owner), field('Comment', comment)],
    actions: [{ label: 'Cancel' }, {
      label: 'Save', primary: true, onClick: () => PATCH(`/api/databases/${enc(d.name)}`, {
        new_name: name.value.trim() !== d.name ? name.value.trim() : null,
        owner: owner.value !== d.owner ? owner.value : null,
        comment: comment.value !== (d.comment || '') ? comment.value : null,
      }),
    }],
  });
  if (res) { toast('Saved'); if (state.db === d.name && res.name !== d.name) { state.db = res.name; store.set('db', res.name); } route(); }
}

async function dropDatabase(d) {
  const dropOwner = checkbox(`Also drop its owner role "${d.owner}"`, false);
  const ok = await confirmDanger({
    title: `Drop database ${d.name}?`,
    message: 'This permanently deletes the database and all its data. Active connections are terminated.',
    typeToConfirm: d.name,
    confirmLabel: 'Drop database',
    extra: d.owner !== state.user ? dropOwner : null,
  });
  if (!ok) return;
  try {
    const r = await DEL(`/api/databases/${enc(d.name)}${qs({ drop_owner: dropOwner.input.checked ? 'true' : '' })}`);
    toast(`Dropped ${d.name}` + (r.dropped_role ? ` and role ${r.dropped_role}` : '') + (r.owner_not_dropped ? `\nOwner role kept: ${r.reason}` : ''));
    if (state.db === d.name) { state.db = null; store.set('db', null); }
    await loadDatabases(); await loadSchemaAndTables(); route();
  } catch (e) { toastErr(e); }
}

function backupModal(db) {
  const fmt = select([['plain', 'Plain SQL (.sql) — readable, restore with psql'], ['custom', 'Custom (.dump) — compressed, restore with pg_restore']], 'plain');
  const schemaOnly = checkbox('Structure only (no data)');
  return modal({
    title: `Back up ${db}`,
    body: [field('Format', fmt), schemaOnly, h('p', { class: 'faint', style: { margin: 0, fontSize: '12.5px' } }, 'Runs pg_dump on the server and downloads the result. Large databases can take a while.')],
    actions: [{ label: 'Cancel' }, {
      label: 'Download', primary: true, onClick: () => {
        download(`/api/databases/${enc(db)}/dump${qs({ format: fmt.value, schema_only: schemaOnly.input.checked ? 'true' : '' })}`);
        toast('Backup started — your browser will download it');
      },
    }],
  });
}

// ============================================================ roles
async function viewRoles(r, seq) {
  setMain({ title: 'Roles & access', body: loadingView() });
  const roles = await GET('/api/roles');
  if (seq !== renderSeq) return;
  setMain({
    title: 'Roles & access',
    actions: [btn('Refresh', () => route(), { icon: 'refresh' }), btn('New role', () => newRoleModal(), { class: 'primary', icon: 'plus' })],
    body: [
      h('div', { class: 'section' }, h('div', { style: { overflowX: 'auto' } }, h('table', { class: 'list' },
        h('thead', null, h('tr', null, ['Role', 'Attributes', 'Member of', 'Owns databases', ''].map(x => h('th', null, x)))),
        h('tbody', null, roles.map(ro => h('tr', null,
          h('td', null, h('strong', null, ro.name), ro.is_current && h('span', { class: 'badge accent', style: { marginLeft: '6px' } }, 'you')),
          h('td', null, h('span', { class: 'badges' },
            ro.login ? h('span', { class: 'badge ok' }, 'login') : h('span', { class: 'badge' }, 'group'),
            ro.superuser && h('span', { class: 'badge warn' }, 'superuser'),
            ro.createdb && h('span', { class: 'badge' }, 'createdb'),
            ro.createrole && h('span', { class: 'badge' }, 'createrole'),
            ro.connection_limit >= 0 && h('span', { class: 'badge' }, 'max ' + ro.connection_limit + ' conns'))),
          h('td', { class: 'muted' }, (ro.member_of || []).join(', ') || '—'),
          h('td', null, (ro.owns_databases || []).filter(x => !x.startsWith('template')).map((d, i) => [i ? ', ' : '', h('a', { href: link.db(d) }, d)])),
          h('td', { class: 'actions' },
            btn('Grant access', () => grantModal(ro.name), { class: 'sm', icon: 'shield' }),
            ro.login && btn('Reset password', () => resetPassword(ro.name), { class: 'sm', icon: 'key' }),
            btn('Edit', () => editRoleModal(ro), { class: 'sm' }),
            !ro.is_current && btn('Drop', () => dropRole(ro), { class: 'sm danger' })))))))),
      h('p', { class: 'faint', style: { fontSize: '12.5px' } }, 'Built-in pg_* roles are hidden. "Grant access" gives a role read, write or full access to every table in a schema, including tables created later.'),
    ],
  });
}

function showPassword(name, password) {
  return modal({
    title: `Password for ${name}`,
    body: [secretBox(password), h('div', { class: 'callout' }, 'Copy it now — it will not be shown again.')],
    actions: [{ label: 'Done', primary: true }],
    dismissable: false,
  });
}

async function newRoleModal() {
  const name = h('input', { class: 'input mono', autocomplete: 'off' });
  const pass = h('input', { class: 'input mono', placeholder: 'blank = generate' });
  const login = checkbox('Can log in', true);
  const createdb = checkbox('Can create databases');
  const createrole = checkbox('Can create roles');
  const limit = h('input', { class: 'input', type: 'number', placeholder: 'unlimited', min: '-1' });
  const res = await modal({
    title: 'New role',
    body: [h('div', { class: 'grid2' }, field('Name', name), field('Password', pass)),
      h('div', { class: 'row' }, login, createdb, createrole), field('Connection limit', limit)],
    actions: [{ label: 'Cancel' }, {
      label: 'Create role', primary: true, onClick: () => POST('/api/roles', {
        name: name.value.trim(), password: pass.value || null, login: login.input.checked,
        createdb: createdb.input.checked, createrole: createrole.input.checked,
        connection_limit: limit.value === '' ? null : Number(limit.value),
      }),
    }],
  });
  if (!res) return;
  toast(`Role ${res.name} created`);
  if (res.generated_password) await showPassword(res.name, res.generated_password);
  route();
}

async function editRoleModal(ro) {
  const name = h('input', { class: 'input mono', value: ro.name });
  const login = checkbox('Can log in', ro.login);
  const createdb = checkbox('Can create databases', ro.createdb);
  const createrole = checkbox('Can create roles', ro.createrole);
  const limit = h('input', { class: 'input', type: 'number', value: String(ro.connection_limit), min: '-1' });
  const pass = h('input', { class: 'input mono', placeholder: 'leave blank to keep' });
  const res = await modal({
    title: `Edit role ${ro.name}`,
    body: [field('Name', name, 'renaming clears an MD5 password'), h('div', { class: 'row' }, login, createdb, createrole),
      h('div', { class: 'grid2' }, field('Connection limit', limit, '-1 = unlimited'), field('New password', pass))],
    actions: [{ label: 'Cancel' }, {
      label: 'Save', primary: true, onClick: () => PATCH(`/api/roles/${enc(ro.name)}`, {
        new_name: name.value.trim() !== ro.name ? name.value.trim() : null,
        password: pass.value || null,
        login: login.input.checked !== ro.login ? login.input.checked : null,
        createdb: createdb.input.checked !== ro.createdb ? createdb.input.checked : null,
        createrole: createrole.input.checked !== ro.createrole ? createrole.input.checked : null,
        connection_limit: Number(limit.value) !== ro.connection_limit ? Number(limit.value) : null,
      }),
    }],
  });
  if (res) { toast('Role updated'); route(); }
}

async function resetPassword(name) {
  const ok = await confirmDanger({ title: `Reset password for ${name}?`, message: 'A new random password is generated. Apps using the old one will fail to connect until updated.', confirmLabel: 'Reset password' });
  if (!ok) return;
  try { const r = await PATCH(`/api/roles/${enc(name)}`, { generate_password: true }); await showPassword(name, r.generated_password); } catch (e) { toastErr(e); }
}

async function dropRole(ro) {
  const ok = await confirmDanger({ title: `Drop role ${ro.name}?`, message: 'Fails if the role still owns objects or holds privileges — drop or reassign those first.', confirmLabel: 'Drop role' });
  if (!ok) return;
  try { await DEL(`/api/roles/${enc(ro.name)}`); toast(`Dropped ${ro.name}`); route(); } catch (e) { toastErr(e, 'Could not drop role'); }
}

async function grantModal(role) {
  const dbSel = select(state.dbs.filter(d => d.can_connect).map(d => d.name), state.db);
  const schemaSel = select(['public'], 'public');
  const loadSchemas = async () => {
    try {
      const ss = await GET(`/api/db/${enc(dbSel.value)}/schemas`);
      clear(schemaSel); append(schemaSel, ss.map(s => h('option', { value: s.name }, s.name)));
    } catch (e) { toastErr(e); }
  };
  dbSel.addEventListener('change', loadSchemas); loadSchemas();
  const level = select([['read', 'Read only (SELECT)'], ['write', 'Read & write (SELECT, INSERT, UPDATE, DELETE)'], ['all', 'Full (all privileges + create tables)'], ['none', 'Revoke all']], 'read');
  const res = await modal({
    title: `Grant access to ${role}`,
    body: [h('div', { class: 'grid2' }, field('Database', dbSel), field('Schema', schemaSel)), field('Access level', level)],
    actions: [{ label: 'Cancel' }, { label: 'Apply', primary: true, onClick: () => POST(`/api/db/${enc(dbSel.value)}/grant`, { role, level: level.value, schema: schemaSel.value }) }],
  });
  if (res) {
    toast(`Updated access for ${role}`);
    await modal({ title: 'Statements executed', size: 'mid', body: h('pre', { class: 'code' }, res.statements.join(';\n') + ';'), actions: [{ label: 'Close', primary: true }] });
  }
}

// ============================================================ database home
async function viewDb(r, seq) {
  setMain({ title: r.db, crumbs: [['Databases', link.databases()]], body: loadingView() });
  const [schemas, exts] = await Promise.all([GET(`/api/db/${enc(r.db)}/schemas`), GET(`/api/db/${enc(r.db)}/extensions`)]);
  state.schemas = schemas;
  if (seq !== renderSeq) return;
  renderSidebar();
  const installed = exts.filter(e => e.installed_version);
  const available = exts.filter(e => !e.installed_version);
  const extSel = select(available.map(e => [e.name, `${e.name} ${e.default_version || ''}`]), null, { class: 'input sm', style: { width: '220px' } });

  const tablesSection = h('div', { class: 'section' },
    h('div', { class: 'section-head' }, h('h3', null, 'Tables in ', h('code', null, state.schema)), h('span', { class: 'muted' }, state.tables.length),
      h('div', { class: 'actions' }, btn('New table', () => newTableModal(), { class: 'sm primary', icon: 'plus' }))),
    state.tables.length ? h('div', { style: { overflowX: 'auto' } }, h('table', { class: 'list' },
      h('thead', null, h('tr', null, h('th', null, 'Name'), h('th', null, 'Type'), h('th', { class: 'num' }, 'Rows (est.)'), h('th', { class: 'num' }, 'Size'), h('th', null, 'Comment'), h('th', null, ''))),
      h('tbody', null, state.tables.map(t => h('tr', null,
        h('td', null, h('a', { href: link.table(r.db, state.schema, t.name), style: { fontWeight: 600 } }, t.name)),
        h('td', null, h('span', { class: 'badge' }, { r: 'table', p: 'partitioned', v: 'view', m: 'mat. view', f: 'foreign' }[t.kind] || t.kind)),
        h('td', { class: 'num' }, t.kind === 'v' ? '—' : fmtNum(t.row_estimate)), h('td', { class: 'num' }, fmtBytes(t.size_bytes)),
        h('td', { class: 'muted' }, t.comment || ''),
        h('td', { class: 'actions' }, btn('Data', () => go(link.table(r.db, state.schema, t.name, 'data')), { class: 'sm' }),
          btn('Structure', () => go(link.table(r.db, state.schema, t.name, 'structure')), { class: 'sm' }))))))) :
      h('div', { class: 'empty' }, 'No tables yet. ', h('a', { href: '#', onclick: (e) => { e.preventDefault(); newTableModal(); } }, 'Create the first one')));

  const schemaSection = h('div', { class: 'section' },
    h('div', { class: 'section-head' }, h('h3', null, 'Schemas'), h('div', { class: 'actions' }, btn('New schema', () => newSchemaModal(r.db), { class: 'sm', icon: 'plus' }))),
    h('table', { class: 'list' }, h('thead', null, h('tr', null, ['Name', 'Owner', 'Tables', ''].map(x => h('th', null, x)))),
      h('tbody', null, schemas.map(s => h('tr', null,
        h('td', null, h('a', { href: '#', onclick: async (e) => { e.preventDefault(); state.schema = s.name; store.set('schema', s.name); await refreshTables(); route(); } }, s.name), s.name === state.schema && h('span', { class: 'badge accent', style: { marginLeft: '6px' } }, 'selected')),
        h('td', { class: 'muted' }, s.owner), h('td', null, s.tables),
        h('td', { class: 'actions' },
          btn('Rename', () => renameSchema(r.db, s.name), { class: 'sm' }),
          btn('Drop', () => dropSchema(r.db, s), { class: 'sm danger' })))))));

  const extSection = h('div', { class: 'section' },
    h('div', { class: 'section-head' }, h('h3', null, 'Extensions'),
      h('div', { class: 'actions' }, available.length ? [extSel, btn('Install', async () => {
        try { await POST(`/api/db/${enc(r.db)}/extensions`, { name: extSel.value }); toast(`Installed ${extSel.value}`); route(); } catch (e) { toastErr(e, 'Install failed'); }
      }, { class: 'sm' })] : null)),
    h('table', { class: 'list' }, h('tbody', null, installed.map(e => h('tr', null,
      h('td', { style: { width: '200px' } }, h('strong', null, e.name), ' ', h('span', { class: 'faint' }, e.installed_version)),
      h('td', { class: 'muted' }, e.comment),
      h('td', { class: 'actions' }, e.name !== 'plpgsql' && btn('Remove', async () => {
        if (!await confirmDanger({ title: `Remove extension ${e.name}?`, message: 'Objects that depend on it will block removal.', confirmLabel: 'Remove' })) return;
        try { await DEL(`/api/db/${enc(r.db)}/extensions/${enc(e.name)}`); toast('Removed'); route(); } catch (err) { toastErr(err); }
      }, { class: 'sm danger' })))))));

  const dbInfo = state.dbs.find(d => d.name === r.db) || {};
  setMain({
    title: r.db,
    crumbs: [['Databases', link.databases()]],
    actions: [
      btn('SQL console', () => go(link.sql(r.db)), { icon: 'sql' }),
      btn('Backup', () => backupModal(r.db), { icon: 'download' }),
      btn('New table', () => newTableModal(), { class: 'primary', icon: 'plus' }),
    ],
    body: [
      h('div', { class: 'cards' },
        h('div', { class: 'card' }, h('div', { class: 'k' }, 'Size'), h('div', { class: 'v' }, fmtBytes(dbInfo.size_bytes))),
        h('div', { class: 'card' }, h('div', { class: 'k' }, 'Owner'), h('div', { class: 'v', style: { fontSize: '17px' } }, dbInfo.owner || '—')),
        h('div', { class: 'card' }, h('div', { class: 'k' }, 'Schemas'), h('div', { class: 'v' }, schemas.length)),
        h('div', { class: 'card' }, h('div', { class: 'k' }, 'Connections'), h('div', { class: 'v' }, dbInfo.connections ?? '—'))),
      tablesSection, schemaSection, extSection,
    ],
  });
}

async function newSchemaModal(db) {
  const name = h('input', { class: 'input mono' });
  const res = await modal({
    title: 'New schema', body: field('Name', name),
    actions: [{ label: 'Cancel' }, { label: 'Create', primary: true, onClick: () => POST(`/api/db/${enc(db)}/schemas`, { name: name.value.trim() }) }],
  });
  if (res) { toast(`Schema ${res.name} created`); state.schema = res.name; store.set('schema', res.name); await loadSchemaAndTables(); route(); }
}
async function renameSchema(db, s) {
  const name = h('input', { class: 'input mono', value: s });
  const res = await modal({
    title: `Rename schema ${s}`, body: field('New name', name),
    actions: [{ label: 'Cancel' }, { label: 'Rename', primary: true, onClick: () => PATCH(`/api/db/${enc(db)}/schemas/${enc(s)}`, { new_name: name.value.trim() }) }],
  });
  if (res) { if (state.schema === s) state.schema = res.name; await loadSchemaAndTables(); route(); }
}
async function dropSchema(db, s) {
  const cascade = checkbox('CASCADE — also drop every table and object inside it', false);
  const ok = await confirmDanger({ title: `Drop schema ${s.name}?`, message: `It contains ${s.tables} table(s).`, typeToConfirm: s.tables ? s.name : null, extra: cascade, confirmLabel: 'Drop schema' });
  if (!ok) return;
  try { await DEL(`/api/db/${enc(db)}/schemas/${enc(s.name)}${qs({ cascade: cascade.input.checked ? 'true' : '' })}`); toast('Schema dropped'); await loadSchemaAndTables(); route(); } catch (e) { toastErr(e); }
}

// ============================================================ create table
const COMMON_TYPES = ['bigint', 'integer', 'smallint', 'bigserial', 'serial', 'numeric(12,2)', 'real', 'double precision', 'boolean',
  'text', 'varchar(255)', 'char(1)', 'uuid', 'jsonb', 'json', 'date', 'timestamptz', 'timestamp', 'time', 'interval',
  'bytea', 'inet', 'cidr', 'text[]', 'integer[]', 'bigint[]', 'uuid[]', 'tsvector', 'vector(1536)'];
function typeInput(value = '') {
  const id = 'types-dl';
  if (!document.getElementById(id)) document.body.appendChild(h('datalist', { id }, COMMON_TYPES.map(t => h('option', { value: t }))));
  return h('input', { class: 'input sm mono', list: id, value, placeholder: 'type', autocomplete: 'off', spellcheck: 'false' });
}

async function newTableModal() {
  if (!state.db) return;
  const schemaSel = select(state.schemas.map(s => s.name), state.schema);
  const name = h('input', { class: 'input mono', placeholder: 'table_name', autocomplete: 'off' });
  const comment = h('input', { class: 'input', placeholder: 'optional' });
  const list = h('div', { class: 'coldefs' });
  const rows = [];
  const addRow = (def = {}) => {
    const r = {
      name: h('input', { class: 'input sm mono', value: def.name || '', placeholder: 'column_name', autocomplete: 'off' }),
      type: typeInput(def.type || ''),
      pk: h('input', { type: 'checkbox', checked: def.pk }),
      nn: h('input', { type: 'checkbox', checked: def.nn }),
      uq: h('input', { type: 'checkbox', checked: def.uq }),
      id: h('input', { type: 'checkbox', checked: def.id }),
      def: h('input', { class: 'input sm mono', value: def.def || '', placeholder: 'default, e.g. now()' }),
    };
    const lab = (inp, t) => h('label', { class: 'check', title: t }, inp);
    r.el = h('div', { class: 'coldef' }, r.name, r.type, lab(r.pk, 'Primary key'), lab(r.nn, 'Not null'), lab(r.uq, 'Unique'), lab(r.id, 'Identity (auto-increment)'), r.def,
      btn('', () => { r.el.remove(); rows.splice(rows.indexOf(r), 1); }, { class: 'sm ghost icon', icon: 'x', title: 'Remove column' }));
    rows.push(r); list.appendChild(r.el);
    return r;
  };
  addRow({ name: 'id', type: 'bigint', pk: true, id: true });
  addRow({ name: 'created_at', type: 'timestamptz', nn: true, def: 'now()' });
  addRow({});
  const preview = h('pre', { class: 'code', style: { display: 'none' } });
  const body = () => ({
    schema: schemaSel.value, name: name.value.trim(), comment: comment.value || null,
    columns: rows.filter(r => r.name.value.trim()).map(r => ({
      name: r.name.value.trim(), type: r.type.value.trim(), primary_key: r.pk.checked, nullable: !r.nn.checked,
      unique: r.uq.checked, identity: r.id.checked, default: r.def.value.trim() || null,
    })),
  });
  const res = await modal({
    title: `New table in ${state.db}`,
    size: 'wide',
    body: [
      h('div', { class: 'grid2' }, field('Schema', schemaSel), field('Table name', name)),
      h('div', { class: 'stack', style: { gap: '6px' } },
        h('div', { class: 'coldef-head' }, h('span', null, 'Column'), h('span', null, 'Type'), h('span', { class: 'c' }, 'PK'), h('span', { class: 'c', title: 'Not null' }, 'NN'), h('span', { class: 'c', title: 'Unique' }, 'UQ'), h('span', { class: 'c', title: 'Identity (auto-increment)' }, 'Auto'), h('span', null, 'Default'), h('span')),
        list,
        h('div', null, btn('Add column', () => addRow({}).name.focus(), { class: 'sm', icon: 'plus' }))),
      field('Comment', comment),
      h('p', { class: 'faint', style: { margin: 0, fontSize: '12.5px' } }, 'Foreign keys, checks and indexes can be added from the Structure tab once the table exists. Defaults are SQL expressions: use quotes for text, e.g. ', h('code', null, "'pending'"), '.'),
      preview,
    ],
    actions: [
      {
        label: 'Preview SQL', left: true, onClick: async () => {
          const r = await POST(`/api/db/${enc(state.db)}/tables/preview`, body());
          preview.textContent = r.sql; preview.style.display = '';
          return false;
        },
      },
      { label: 'Cancel' },
      { label: 'Create table', primary: true, onClick: () => POST(`/api/db/${enc(state.db)}/tables`, body()) },
    ],
  });
  if (!res) return;
  toast(`Table ${res.name} created`);
  state.schema = res.schema; store.set('schema', res.schema);
  await loadSchemaAndTables();
  go(link.table(state.db, res.schema, res.name, 'structure'));
}

// ============================================================ table view
async function viewTable(r, seq) {
  const tabs = h('div', { class: 'tabs' },
    ['data', 'structure', 'ddl'].map(t => h('a', { href: link.table(r.db, r.schema, r.table, t), class: r.tab === t ? 'active' : '' }, { data: 'Data', structure: 'Structure', ddl: 'SQL definition' }[t])));
  const crumbs = [[r.db, link.db(r.db)], [r.schema, link.db(r.db)]];
  if (r.tab === 'structure') return viewStructure(r, seq, tabs, crumbs);
  if (r.tab === 'ddl') return viewDdl(r, seq, tabs, crumbs);
  return viewData(r, seq, tabs, crumbs);
}
const tblPath = (r) => `/api/db/${enc(r.db)}/tables/${enc(r.schema)}/${enc(r.table)}`;

// ---------- data grid
async function viewData(r, seq, tabs, crumbs) {
  const key = `${r.db}|${r.schema}|${r.table}`;
  const g = state.grids[key] || (state.grids[key] = { limit: store.get('pageSize', 50), offset: 0, sort: null, order: 'asc', q: '', filters: [], showFilters: false });
  g.selected = new Map();

  const content = setMain({ title: r.table, crumbs, tabs, flush: true, body: loadingView() });
  let data;
  try {
    data = await GET(`${tblPath(r)}/rows${qs({
      limit: g.limit, offset: g.offset, sort: g.sort, order: g.order, q: g.q,
      filters: activeFilters(g).length ? JSON.stringify(activeFilters(g)) : null,
    })}`);
  } catch (e) {
    if (seq !== renderSeq) return;
    if (e.status === 400 && (g.filters.length || g.sort)) { g.filters = []; g.sort = null; toastErr(e, 'Filter reset'); return route(); }
    throw e;
  }
  if (seq !== renderSeq) return;

  const cols = data.columns;
  const pk = data.primary_key;
  const rowKey = (row) => pk.length ? JSON.stringify(pk.map(k => row[k])) : row.__ctid;

  // --- toolbar
  const search = h('input', { class: 'input sm search', placeholder: 'Search in rows…', value: g.q, onkeydown: (e) => { if (e.key === 'Enter') { g.q = search.value; g.offset = 0; route(); } } });
  const delBtn = btn('Delete', () => deleteSelected(), { class: 'sm danger', icon: 'trash', disabled: true });
  const updateDel = () => { delBtn.disabled = g.selected.size === 0; delBtn.lastChild.textContent = g.selected.size ? `Delete ${g.selected.size}` : 'Delete'; };
  const toolbar = h('div', { class: 'toolbar' },
    search,
    btn(activeFilters(g).length ? `Filters (${activeFilters(g).length})` : 'Filter', () => { g.showFilters = !g.showFilters; if (g.showFilters && !g.filters.length) g.filters.push({ column: cols[0].name, op: 'eq', value: '' }); route(); }, { class: 'sm' + (activeFilters(g).length ? ' primary' : ''), icon: 'filter' }),
    btn('', () => route(), { class: 'sm icon', icon: 'refresh', title: 'Refresh' }),
    h('span', { class: 'grow' }),
    data.editable && btn('Insert row', () => rowEditor(r, data, null), { class: 'sm primary', icon: 'plus' }),
    data.editable && delBtn,
    btn('Export CSV', () => download(`${tblPath(r)}/export`), { class: 'sm', icon: 'download' }),
    data.editable && btn('Import CSV', () => importCsvModal(r, cols), { class: 'sm', icon: 'upload' }));

  // --- filters
  let filtersEl = null;
  if (g.showFilters) {
    const OPS = [['eq', '='], ['neq', '≠'], ['lt', '<'], ['lte', '≤'], ['gt', '>'], ['gte', '≥'], ['contains', 'contains'], ['ilike', 'ILIKE'], ['like', 'LIKE'], ['not_like', 'NOT LIKE'], ['in', 'in (a,b,c)'], ['is_null', 'is null'], ['not_null', 'is not null']];
    filtersEl = h('div', { class: 'filters' },
      g.filters.map((f, i) => {
        const val = h('input', { class: 'input sm val mono', value: f.value ?? '', placeholder: 'value', oninput: (e) => { f.value = e.target.value; }, onkeydown: (e) => { if (e.key === 'Enter') { g.offset = 0; route(); } } });
        const opSel = select(OPS, f.op, { class: 'input sm', onchange: (e) => { f.op = e.target.value; val.style.display = f.op.endsWith('null') ? 'none' : ''; } });
        val.style.display = f.op.endsWith('null') ? 'none' : '';
        return h('div', { class: 'frow' },
          select(cols.map(c => c.name), f.column, { class: 'input sm', onchange: (e) => { f.column = e.target.value; } }),
          opSel, val,
          btn('', () => { g.filters.splice(i, 1); if (!g.filters.length) g.showFilters = false; g.offset = 0; route(); }, { class: 'sm ghost icon', icon: 'x' }));
      }),
      h('div', { class: 'frow' },
        btn('Add filter', () => { g.filters.push({ column: cols[0].name, op: 'eq', value: '' }); route(); }, { class: 'sm', icon: 'plus' }),
        btn('Apply', () => { g.offset = 0; route(); }, { class: 'sm primary' }),
        g.filters.length ? btn('Clear all', () => { g.filters = []; g.showFilters = false; g.offset = 0; route(); }, { class: 'sm ghost' }) : null));
  }

  // --- grid
  const headChk = h('input', { type: 'checkbox', 'aria-label': 'Select all' });
  const tbody = h('tbody');
  const trs = [];
  data.rows.forEach((row, i) => {
    const chk = h('input', { type: 'checkbox', onclick: (e) => e.stopPropagation() });
    const tr = h('tr', { ondblclick: () => rowEditor(r, data, row), title: data.editable ? 'Double-click to edit' : '' },
      data.editable ? h('td', { class: 'chk', onclick: (e) => { if (e.target !== chk) chk.click(); e.stopPropagation(); } }, chk) : null,
      h('td', { class: 'rn' }, g.offset + i + 1),
      cols.map(c => {
        const v = row[c.name];
        if (v == null) return h('td', { class: 'null' }, 'NULL');
        let cls = '';
        if (c.category === 'N') cls = 'numv';
        if (c.category === 'B') cls = v === 'true' ? 'bool-t' : 'bool-f';
        const shown = v.length > 300 ? v.slice(0, 300) + '…' : v;
        return h('td', { class: cls, title: v.length > 40 ? v.slice(0, 2000) : null }, shown);
      }));
    chk.addEventListener('change', () => {
      if (chk.checked) g.selected.set(rowKey(row), row); else g.selected.delete(rowKey(row));
      tr.classList.toggle('sel', chk.checked);
      headChk.checked = g.selected.size === data.rows.length && data.rows.length > 0;
      updateDel();
    });
    trs.push(chk);
    tbody.appendChild(tr);
  });
  headChk.addEventListener('change', () => { trs.forEach(c => { if (c.checked !== headChk.checked) { c.checked = headChk.checked; c.dispatchEvent(new Event('change')); } }); });

  const thead = h('thead', null, h('tr', null,
    data.editable ? h('th', { class: 'chk' }, headChk) : null,
    h('th', null, h('div', { class: 'h' }, h('span', { class: 'n' }, '#'), h('span', { class: 't' }, ' '))),
    cols.map(c => h('th', null, h('div', {
      class: 'h', title: 'Click to sort',
      onclick: () => {
        if (g.sort !== c.name) { g.sort = c.name; g.order = 'asc'; } else if (g.order === 'asc') g.order = 'desc'; else { g.sort = null; }
        g.offset = 0; route();
      },
    },
    h('span', { class: 'n' }, c.primary_key && h('span', { class: 'pk', title: 'Primary key' }, '🔑'), c.name, g.sort === c.name && h('span', { class: 'arrow' }, g.order === 'asc' ? '↑' : '↓')),
    h('span', { class: 't' }, c.type))))));
  const gridWrap = h('div', { class: 'grid-wrap' },
    data.rows.length ? h('table', { class: 'grid' }, thead, tbody) :
      h('div', { class: 'loading' }, g.q || activeFilters(g).length ? 'No rows match.' : 'This table is empty.', data.editable && btn('Insert row', () => rowEditor(r, data, null), { class: 'sm', icon: 'plus' })));

  // --- pager
  const from = data.rows.length ? g.offset + 1 : 0;
  const to = g.offset + data.rows.length;
  const pageSize = select(['25', '50', '100', '250', '500', '1000'], String(g.limit), {
    class: 'input sm', onchange: (e) => { g.limit = Number(e.target.value); store.set('pageSize', g.limit); g.offset = 0; route(); },
  });
  const pager = h('div', { class: 'pager' },
    h('span', null, `Rows ${fmtNum(from)}–${fmtNum(to)} of ${data.total_exact ? '' : '~'}${fmtNum(data.total)}`),
    h('span', { class: 'faint' }, `${data.duration_ms} ms`),
    !data.editable && h('span', { class: 'badge' }, 'read-only'),
    data.editable && !pk.length && h('span', { class: 'badge warn', title: 'Rows are identified by their physical location (ctid). Add a primary key for reliable editing.' }, 'no primary key'),
    h('span', { class: 'grow' }),
    h('span', null, 'Page size'), pageSize,
    btn('‹ Prev', () => { g.offset = Math.max(0, g.offset - g.limit); route(); }, { class: 'sm', disabled: g.offset === 0 }),
    btn('Next ›', () => { g.offset += g.limit; route(); }, { class: 'sm', disabled: to >= data.total || data.rows.length < g.limit }));

  const actions = [btn('Structure', () => go(link.table(r.db, r.schema, r.table, 'structure')), { icon: 'table' }),
    btn('Query', () => { store.set('sql:' + r.db, `SELECT *\nFROM ${qi(r.schema)}.${qi(r.table)}\nLIMIT 100;`); go(link.sql(r.db)); }, { icon: 'sql' })];
  const c2 = setMain({ title: r.table, crumbs, tabs, flush: true, actions, body: [toolbar, filtersEl, gridWrap, pager] });
  void content; void c2;

  async function deleteSelected() {
    const n = g.selected.size;
    if (!n) return;
    const ok = await confirmDanger({ title: `Delete ${n} row${n > 1 ? 's' : ''}?`, message: 'This cannot be undone.', confirmLabel: 'Delete' });
    if (!ok) return;
    const rowsSel = [...g.selected.values()];
    const payload = pk.length ? { keys: rowsSel.map(row => Object.fromEntries(pk.map(k => [k, row[k]]))) } : { ctids: rowsSel.map(row => row.__ctid) };
    try { const res = await DEL(`${tblPath(r)}/rows`, payload); toast(`Deleted ${res.deleted} row(s)`); route(); } catch (e) { toastErr(e, 'Delete failed'); }
  }
}
function activeFilters(g) {
  return g.filters.filter(f => f.column && (f.op.endsWith('null') || (f.value != null && f.value !== '')));
}
function qi(name) { return /^[a-z_][a-z0-9_]*$/.test(name) ? name : '"' + name.replace(/"/g, '""') + '"'; }

// ---------- row editor (insert + update)
async function rowEditor(r, data, row) {
  if (!data.editable) return;
  const isNew = !row;
  const pk = data.primary_key;
  const fields = [];
  const body = h('div', null, data.columns.map(c => {
    const generated = c.generated === 's' || c.identity === 'a';
    const hasDefault = c.default != null || c.identity || c.generated;
    const cur = row ? row[c.name] : null;
    let input;
    if (c.category === 'B') {
      input = select([['true', 'true'], ['false', 'false']], cur ?? 'true', { class: 'input sm' });
    } else {
      input = h('textarea', { class: 'input', rows: 1, spellcheck: 'false', value: cur ?? '' });
      const grow = () => { input.style.height = 'auto'; input.style.height = Math.min(260, Math.max(32, input.scrollHeight + 2)) + 'px'; };
      input.addEventListener('input', grow);
      setTimeout(grow, 0);
    }
    const nullBox = c.nullable ? h('input', { type: 'checkbox', checked: !isNew && cur == null }) : null;
    const defBox = isNew && hasDefault ? h('input', { type: 'checkbox', checked: true }) : null;
    const wrap = h('div', { class: 'edit-field' },
      h('div', { class: 'fname' }, c.primary_key ? '🔑 ' : '', c.name, h('small', null, c.type + (c.nullable ? '' : ' · not null'))),
      input,
      h('div', { class: 'opts' },
        defBox && h('label', { class: 'check' }, defBox, 'default'),
        nullBox && h('label', { class: 'check' }, nullBox, 'NULL')));
    const sync = () => {
      const off = (nullBox && nullBox.checked) || (defBox && defBox.checked) || (!isNew && generated);
      input.disabled = !!off;
      wrap.classList.toggle('is-null', !!off);
    };
    nullBox && nullBox.addEventListener('change', () => { if (nullBox.checked && defBox) defBox.checked = false; sync(); });
    defBox && defBox.addEventListener('change', () => { if (defBox.checked && nullBox) nullBox.checked = false; sync(); });
    input.addEventListener('input', () => { if (defBox) defBox.checked = false; if (nullBox) nullBox.checked = false; sync(); });
    if (isNew && generated) { input.disabled = true; if (defBox) defBox.disabled = true; }
    sync();
    fields.push({ c, input, nullBox, defBox, generated, orig: cur });
    return wrap;
  }));

  const collect = () => {
    const values = {};
    for (const f of fields) {
      if (f.generated) continue;
      if (f.defBox && f.defBox.checked) continue;
      const v = f.nullBox && f.nullBox.checked ? null : f.input.value;
      if (!isNew && v === f.orig) continue;
      values[f.c.name] = v;
    }
    return values;
  };
  const ident = () => pk.length ? { key: Object.fromEntries(pk.map(k => [k, row[k]])) } : { ctid: row.__ctid };

  const actions = [];
  if (!isNew) {
    actions.push({
      label: 'Delete row', left: true, onClick: async () => {
        if (!await confirmDanger({ title: 'Delete this row?', message: 'This cannot be undone.' })) return false;
        await DEL(`${tblPath(r)}/rows`, pk.length ? { keys: [ident().key] } : { ctids: [row.__ctid] });
        return 'deleted';
      },
    });
    actions.push({ label: 'Duplicate', onClick: () => 'duplicate' });
  }
  actions.push({ label: 'Cancel' });
  actions.push({
    label: isNew ? 'Insert' : 'Save', primary: true, onClick: async () => {
      const values = collect();
      if (isNew) return POST(`${tblPath(r)}/rows`, { values });
      if (!Object.keys(values).length) { toast('No changes'); return null; }
      return PATCH(`${tblPath(r)}/rows`, Object.assign(ident(), { values }));
    },
  });
  const res = await modal({ title: isNew ? `Insert into ${r.table}` : `Edit row in ${r.table}`, size: 'mid', body, actions });
  if (res === 'duplicate') {
    const copy = Object.assign({}, row);
    for (const c of data.columns) if (c.primary_key && (c.identity || c.default)) delete copy[c.name];
    return rowEditorPrefilled(r, data, copy);
  }
  if (res === 'deleted') { toast('Row deleted'); route(); } else if (res) { toast(isNew ? 'Row inserted' : 'Row saved'); route(); }
}
async function rowEditorPrefilled(r, data, values) {
  // Insert dialog with values copied from another row
  const res = await modal({
    title: `Insert copy into ${r.table}`,
    size: 'mid',
    body: h('div', { class: 'stack' },
      h('p', { class: 'muted', style: { margin: 0 } }, 'Edit the JSON below, then insert. Columns you remove use their default.'),
      h('textarea', { class: 'input', rows: 14, id: 'dup-json', value: JSON.stringify(Object.fromEntries(Object.entries(values).filter(([k]) => k !== '__ctid')), null, 2) })),
    actions: [{ label: 'Cancel' }, {
      label: 'Insert', primary: true, onClick: async () => {
        let v;
        try { v = JSON.parse(document.getElementById('dup-json').value); } catch { toast('Invalid JSON', 'error'); return false; }
        return POST(`${tblPath(r)}/rows`, { values: v });
      },
    }],
  });
  if (res) { toast('Row inserted'); route(); }
}

async function importCsvModal(r, cols) {
  const file = h('input', { type: 'file', accept: '.csv,text/csv', class: 'input', style: { paddingTop: '4px' } });
  const header = checkbox('First line is a header (columns matched by name)', true);
  const delim = h('input', { class: 'input mono', value: ',', maxlength: '1', style: { width: '70px' } });
  const trunc = checkbox('Empty the table first (TRUNCATE)');
  const res = await modal({
    title: `Import CSV into ${r.table}`,
    body: [field('CSV file', file), header, field('Delimiter', delim), trunc,
      h('p', { class: 'faint', style: { margin: 0, fontSize: '12.5px' } }, 'Columns: ', cols.map(c => c.name).join(', '), '. The import runs in one transaction — any bad row cancels the whole file.')],
    actions: [{ label: 'Cancel' }, {
      label: 'Import', primary: true, onClick: async () => {
        if (!file.files[0]) { toast('Choose a file first', 'error'); return false; }
        const fd = new FormData();
        fd.append('file', file.files[0]);
        fd.append('header', header.input.checked ? 'true' : 'false');
        fd.append('delimiter', delim.value || ',');
        fd.append('truncate_first', trunc.input.checked ? 'true' : 'false');
        return api('POST', `${tblPath(r)}/import`, fd);
      },
    }],
  });
  if (res) { toast(`Imported ${fmtNum(res.imported)} rows`); route(); }
}

// ---------- structure
async function viewStructure(r, seq, tabs, crumbs) {
  setMain({ title: r.table, crumbs, tabs, body: loadingView() });
  const t = await GET(tblPath(r));
  if (seq !== renderSeq) return;
  const isTable = t.kind === 'r' || t.kind === 'p';
  const st = t.stats;
  const P = tblPath(r);
  const reload = () => route();

  const colSection = h('div', { class: 'section' },
    h('div', { class: 'section-head' }, h('h3', null, 'Columns'), h('span', { class: 'muted' }, t.columns.length),
      h('div', { class: 'actions' }, isTable && btn('Add column', () => columnModal(r, null, reload), { class: 'sm primary', icon: 'plus' }))),
    h('div', { style: { overflowX: 'auto' } }, h('table', { class: 'list' },
      h('thead', null, h('tr', null, ['#', 'Name', 'Type', 'Nullable', 'Default', 'Comment', ''].map(x => h('th', null, x)))),
      h('tbody', null, t.columns.map(c => h('tr', null,
        h('td', { class: 'faint' }, c.position),
        h('td', null, h('strong', null, c.name), ' ', c.primary_key && h('span', { class: 'badge warn' }, 'PK'), ' ', c.identity && h('span', { class: 'badge' }, 'identity'), c.generated === 's' && h('span', { class: 'badge' }, 'generated')),
        h('td', { class: 'mono' }, c.type),
        h('td', null, c.nullable ? h('span', { class: 'muted' }, 'yes') : h('span', { class: 'badge' }, 'NOT NULL')),
        h('td', { class: 'mono muted', style: { maxWidth: '260px', overflow: 'hidden', textOverflow: 'ellipsis' }, title: c.default || '' }, c.default || ''),
        h('td', { class: 'muted' }, c.comment || ''),
        h('td', { class: 'actions' }, isTable && [
          btn('Edit', () => columnModal(r, c, reload), { class: 'sm' }),
          btn('Drop', async () => {
            const cascade = checkbox('CASCADE (also drop dependent views/constraints)');
            if (!await confirmDanger({ title: `Drop column ${c.name}?`, message: 'All data in this column is deleted.', extra: cascade, confirmLabel: 'Drop column' })) return;
            try { await DEL(`${P}/columns/${enc(c.name)}${qs({ cascade: cascade.input.checked ? 'true' : '' })}`); toast('Column dropped'); reload(); } catch (e) { toastErr(e); }
          }, { class: 'sm danger' })])))))));

  const idxSection = t.kind !== 'v' && h('div', { class: 'section' },
    h('div', { class: 'section-head' }, h('h3', null, 'Indexes'), h('span', { class: 'muted' }, t.indexes.length),
      h('div', { class: 'actions' }, btn('Add index', () => indexModal(r, t, reload), { class: 'sm', icon: 'plus' }))),
    t.indexes.length ? h('div', { style: { overflowX: 'auto' } }, h('table', { class: 'list' }, h('tbody', null, t.indexes.map(ix => h('tr', null,
      h('td', null, h('strong', null, ix.name), ' ', ix.is_primary ? h('span', { class: 'badge warn' }, 'primary') : ix.is_unique && h('span', { class: 'badge accent' }, 'unique')),
      h('td', { class: 'mono muted' }, ix.definition.replace(/^CREATE (UNIQUE )?INDEX \S+ ON \S+ /, '')),
      h('td', { class: 'num nowrap' }, fmtBytes(ix.size_bytes)),
      h('td', { class: 'actions' }, ix.backs_constraint ? h('span', { class: 'faint', style: { fontSize: '12px' } }, 'via constraint') : btn('Drop', async () => {
        if (!await confirmDanger({ title: `Drop index ${ix.name}?`, message: 'Queries that rely on it may get slower.', confirmLabel: 'Drop index' })) return;
        try { await DEL(`/api/db/${enc(r.db)}/indexes/${enc(r.schema)}/${enc(ix.name)}`); toast('Index dropped'); reload(); } catch (e) { toastErr(e); }
      }, { class: 'sm danger' }))))))) : h('div', { class: 'empty' }, 'No indexes'));

  const TYPE = { p: ['primary key', 'warn'], u: ['unique', 'accent'], c: ['check', ''], f: ['foreign key', 'ok'], x: ['exclusion', ''], t: ['trigger', ''] };
  const conSection = isTable && h('div', { class: 'section' },
    h('div', { class: 'section-head' }, h('h3', null, 'Constraints'), h('span', { class: 'muted' }, t.constraints.length),
      h('div', { class: 'actions' }, btn('Add constraint', () => constraintModal(r, t, reload), { class: 'sm', icon: 'plus' }))),
    t.constraints.length ? h('table', { class: 'list' }, h('tbody', null, t.constraints.map(k => h('tr', null,
      h('td', null, h('strong', null, k.name)),
      h('td', null, h('span', { class: 'badge ' + (TYPE[k.type] || ['', ''])[1] }, (TYPE[k.type] || [k.type])[0])),
      h('td', { class: 'mono muted' }, k.definition),
      h('td', { class: 'actions' }, btn('Drop', async () => {
        if (!await confirmDanger({ title: `Drop constraint ${k.name}?`, message: 'The rule stops being enforced.', confirmLabel: 'Drop constraint' })) return;
        try { await DEL(`${P}/constraints/${enc(k.name)}`); toast('Constraint dropped'); reload(); } catch (e) { toastErr(e); }
      }, { class: 'sm danger' })))))) : h('div', { class: 'empty' }, 'No constraints'),
    t.referenced_by.length ? h('div', { class: 'section-body', style: { borderTop: '1px solid var(--border)' } },
      h('div', { class: 'muted', style: { fontSize: '12.5px', marginBottom: '6px' } }, 'Referenced by'),
      t.referenced_by.map(x => h('div', { class: 'mono', style: { fontSize: '12px' } }, x.from_table, ' — ', x.definition))) : null);

  const tableActions = h('div', { class: 'section' },
    h('div', { class: 'section-head' }, h('h3', null, 'Manage')),
    h('div', { class: 'section-body row' },
      btn('Rename / move', () => renameTableModal(r, t), { icon: 'edit' }),
      btn('Comment', async () => {
        const c = h('input', { class: 'input', value: st.comment || '' });
        const ok = await modal({ title: 'Table comment', body: field('Comment', c), actions: [{ label: 'Cancel' }, { label: 'Save', primary: true, onClick: () => PATCH(P, { comment: c.value }) }] });
        if (ok) { toast('Saved'); reload(); }
      }),
      (t.kind === 'r' || t.kind === 'p' || t.kind === 'm') && btn('VACUUM ANALYZE', async () => { try { await POST(`${P}/maintenance${qs({ action: 'vacuum_analyze' })}`); toast('Vacuum + analyze done'); reload(); } catch (e) { toastErr(e); } }),
      t.kind === 'm' && btn('Refresh view', async () => { try { await POST(`${P}/maintenance${qs({ action: 'refresh' })}`); toast('Refreshed'); } catch (e) { toastErr(e); } }),
      h('span', { class: 'grow' }),
      isTable && btn('Truncate', async () => {
        const restart = checkbox('Restart identity / sequences', true);
        const cascade = checkbox('CASCADE (also truncate tables that reference this one)');
        if (!await confirmDanger({ title: `Empty ${r.table}?`, message: 'Deletes every row. The table structure stays.', typeToConfirm: r.table, extra: h('div', { class: 'stack', style: { gap: '6px' } }, restart, cascade), confirmLabel: 'Truncate' })) return;
        try { await POST(`${P}/truncate`, { restart_identity: restart.input.checked, cascade: cascade.input.checked }); toast('Table emptied'); refreshTables(); reload(); } catch (e) { toastErr(e); }
      }, { class: 'danger' }),
      btn('Drop ' + ({ v: 'view', m: 'view' }[t.kind] || 'table'), async () => {
        const cascade = checkbox('CASCADE (also drop views and foreign keys that depend on it)');
        if (!await confirmDanger({ title: `Drop ${r.schema}.${r.table}?`, message: 'The table and all its data are permanently deleted.', typeToConfirm: r.table, extra: cascade, confirmLabel: 'Drop' })) return;
        try { await DEL(`${P}${qs({ cascade: cascade.input.checked ? 'true' : '' })}`); toast('Dropped'); await refreshTables(); go(link.db(r.db)); } catch (e) { toastErr(e); }
      }, { class: 'danger solid' })));

  setMain({
    title: r.table, crumbs, tabs,
    actions: [btn('Data', () => go(link.table(r.db, r.schema, r.table, 'data')), { icon: 'table' })],
    body: [
      h('div', { class: 'cards' },
        h('div', { class: 'card' }, h('div', { class: 'k' }, 'Rows (estimate)'), h('div', { class: 'v' }, t.kind === 'v' ? '—' : fmtNum(st.row_estimate))),
        h('div', { class: 'card' }, h('div', { class: 'k' }, 'Total size'), h('div', { class: 'v' }, fmtBytes(st.total_bytes)), h('div', { class: 's' }, `data ${fmtBytes(st.table_bytes)} · indexes ${fmtBytes(st.index_bytes)}`)),
        h('div', { class: 'card' }, h('div', { class: 'k' }, 'Owner'), h('div', { class: 'v', style: { fontSize: '17px' } }, st.owner)),
        h('div', { class: 'card' }, h('div', { class: 'k' }, 'Last analyzed'), h('div', { class: 'v', style: { fontSize: '17px' } }, (st.last_analyze || st.last_autoanalyze) ? since(st.last_analyze || st.last_autoanalyze) + ' ago' : 'never'))),
      st.comment && h('p', { class: 'muted', style: { marginTop: 0 } }, st.comment),
      colSection, idxSection, conSection, tableActions,
    ],
  });
}

async function columnModal(r, c, done) {
  const isNew = !c;
  const name = h('input', { class: 'input mono', value: c ? c.name : '' });
  const type = typeInput(c ? c.type : '');
  type.classList.remove('sm');
  const using = h('input', { class: 'input mono', placeholder: `e.g. ${c ? c.name : 'col'}::integer` });
  const usingField = field('USING (conversion)', using, 'only needed when Postgres can\'t convert automatically');
  const nullable = checkbox('Allow NULL', c ? c.nullable : true);
  const def = h('input', { class: 'input mono', value: c ? (c.default || '') : '', placeholder: "SQL expression, e.g. 0, now(), 'draft'" });
  const unique = checkbox('Unique');
  const comment = h('input', { class: 'input', value: c ? (c.comment || '') : '' });
  if (!isNew) {
    usingField.style.display = 'none';
    type.addEventListener('input', () => { usingField.style.display = type.value.trim() !== c.type ? '' : 'none'; });
  }
  const res = await modal({
    title: isNew ? `Add column to ${r.table}` : `Edit column ${c.name}`,
    body: [h('div', { class: 'grid2' }, field('Name', name), field('Type', type)), isNew ? null : usingField,
      field('Default', def, c && c.identity ? 'identity column' : ''), h('div', { class: 'row' }, nullable, isNew && unique), field('Comment', comment),
      isNew && h('p', { class: 'faint', style: { margin: 0, fontSize: '12.5px' } }, 'Adding a NOT NULL column to a table with rows needs a default.')],
    actions: [{ label: 'Cancel' }, {
      label: isNew ? 'Add column' : 'Save', primary: true, onClick: () => {
        if (isNew) {
          return POST(`${tblPath(r)}/columns`, { name: name.value.trim(), type: type.value.trim(), nullable: nullable.input.checked, default: def.value.trim() || null, unique: unique.input.checked, comment: comment.value || null });
        }
        const body = {};
        if (name.value.trim() !== c.name) body.new_name = name.value.trim();
        if (type.value.trim() !== c.type) { body.type = type.value.trim(); if (using.value.trim()) body.using = using.value.trim(); }
        if (nullable.input.checked !== c.nullable) body.nullable = nullable.input.checked;
        if (def.value.trim() !== (c.default || '')) { if (def.value.trim()) body.default = def.value.trim(); else body.drop_default = true; }
        if (comment.value !== (c.comment || '')) body.comment = comment.value;
        if (!Object.keys(body).length) { toast('No changes'); return null; }
        return PATCH(`${tblPath(r)}/columns/${enc(c.name)}`, body);
      },
    }],
  });
  if (res) { toast(isNew ? 'Column added' : 'Column updated'); done(); }
}

function columnPicker(columns, selected = []) {
  const boxes = columns.map(c => checkbox(c.name, selected.includes(c.name)));
  const el = h('div', { class: 'row', style: { gap: '6px 14px' } }, boxes);
  el.value = () => boxes.filter(b => b.input.checked).map(b => b.input.parentElement.textContent);
  return el;
}

async function indexModal(r, t, done) {
  const cols = columnPicker(t.columns);
  const name = h('input', { class: 'input mono', placeholder: 'auto' });
  const method = select(['btree', 'hash', 'gin', 'gist', 'brin'], 'btree');
  const unique = checkbox('Unique');
  const conc = checkbox('Build CONCURRENTLY (no write lock; slower)');
  const where = h('input', { class: 'input mono', placeholder: 'optional partial-index condition, e.g. deleted_at IS NULL' });
  const res = await modal({
    title: `New index on ${r.table}`,
    body: [field('Columns', cols, 'index column order follows the table'), h('div', { class: 'grid2' }, field('Name', name), field('Method', method)),
      h('div', { class: 'row' }, unique, conc), field('Where', where), h('p', { class: 'faint', style: { margin: 0, fontSize: '12.5px' } }, 'Tip: use gin for jsonb, arrays and full-text search columns.')],
    actions: [{ label: 'Cancel' }, {
      label: 'Create index', primary: true, onClick: () => POST(`${tblPath(r)}/indexes`, {
        columns: cols.value(), name: name.value.trim() || null, method: method.value, unique: unique.input.checked, concurrently: conc.input.checked, where: where.value.trim() || null,
      }),
    }],
  });
  if (res) { toast(`Index ${res.name} created`); done(); }
}

async function constraintModal(r, t, done) {
  const type = select([['foreign_key', 'Foreign key'], ['unique', 'Unique'], ['check', 'Check'], ['primary_key', 'Primary key']], 'foreign_key');
  const name = h('input', { class: 'input mono', placeholder: 'auto' });
  const cols = columnPicker(t.columns);
  const expr = h('input', { class: 'input mono', placeholder: 'e.g. price >= 0' });
  const refSchema = select(state.schemas.map(s => s.name), r.schema);
  const refTable = select([], null);
  const refCols = h('input', { class: 'input mono', placeholder: 'id' });
  const onDel = select(['NO ACTION', 'RESTRICT', 'CASCADE', 'SET NULL', 'SET DEFAULT'], 'NO ACTION');
  const onUpd = select(['NO ACTION', 'RESTRICT', 'CASCADE', 'SET NULL', 'SET DEFAULT'], 'NO ACTION');
  const loadRefTables = async () => {
    try {
      const ts = await GET(`/api/db/${enc(r.db)}/tables${qs({ schema: refSchema.value })}`);
      clear(refTable); append(refTable, ts.filter(x => x.kind === 'r' || x.kind === 'p').map(x => h('option', { value: x.name }, x.name)));
    } catch (e) { toastErr(e); }
  };
  refSchema.addEventListener('change', loadRefTables); loadRefTables();
  const colsF = field('Columns', cols);
  const exprF = field('Check expression', expr);
  const fkF = h('div', { class: 'stack' }, h('div', { class: 'grid2' }, field('References schema', refSchema), field('References table', refTable)),
    field('Referenced column(s)', refCols, 'comma-separated, same count and order as the columns above'),
    h('div', { class: 'grid2' }, field('On delete', onDel), field('On update', onUpd)));
  const sync = () => {
    colsF.style.display = type.value === 'check' ? 'none' : '';
    exprF.style.display = type.value === 'check' ? '' : 'none';
    fkF.style.display = type.value === 'foreign_key' ? '' : 'none';
  };
  type.addEventListener('change', sync); sync();
  const res = await modal({
    title: `New constraint on ${r.table}`, size: 'mid',
    body: [h('div', { class: 'grid2' }, field('Type', type), field('Name', name)), colsF, exprF, fkF],
    actions: [{ label: 'Cancel' }, {
      label: 'Add constraint', primary: true, onClick: () => POST(`${tblPath(r)}/constraints`, {
        type: type.value, name: name.value.trim() || null, columns: cols.value(), expression: expr.value.trim() || null,
        ref_schema: refSchema.value, ref_table: refTable.value || null,
        ref_columns: refCols.value.split(',').map(s => s.trim()).filter(Boolean), on_delete: onDel.value, on_update: onUpd.value,
      }),
    }],
  });
  if (res) { toast('Constraint added'); done(); }
}

async function renameTableModal(r, t) {
  const name = h('input', { class: 'input mono', value: r.table });
  const schema = select(state.schemas.map(s => s.name), r.schema);
  const res = await modal({
    title: `Rename / move ${r.table}`,
    body: h('div', { class: 'grid2' }, field('Name', name), field('Schema', schema)),
    actions: [{ label: 'Cancel' }, {
      label: 'Save', primary: true, onClick: () => PATCH(tblPath(r), {
        new_name: name.value.trim() !== r.table ? name.value.trim() : null,
        new_schema: schema.value !== r.schema ? schema.value : null,
      }),
    }],
  });
  if (res) { toast('Saved'); state.schema = res.schema; await loadSchemaAndTables(); go(link.table(r.db, res.schema, res.name, 'structure')); }
}

// ---------- DDL
async function viewDdl(r, seq, tabs, crumbs) {
  setMain({ title: r.table, crumbs, tabs, body: loadingView() });
  const t = await GET(tblPath(r));
  if (seq !== renderSeq) return;
  setMain({
    title: r.table, crumbs, tabs,
    actions: [btn('Copy', () => copyText(t.ddl), { icon: 'copy' }), btn('Open in SQL console', () => { store.set('sql:' + r.db, t.ddl); go(link.sql(r.db)); }, { icon: 'sql' })],
    body: [h('pre', { class: 'code' }, t.ddl), h('p', { class: 'faint', style: { fontSize: '12.5px' } }, 'Reconstructed from the catalog. For an exact, restorable copy use Backup (pg_dump).')],
  });
}

// ============================================================ SQL console
async function viewSql(r) {
  const db = r.db;
  const editor = h('textarea', { class: 'editor', spellcheck: 'false', placeholder: 'SELECT * FROM my_table LIMIT 10;\n\nCtrl/⌘ + Enter runs the selection (or everything).' });
  editor.value = store.get('sql:' + db, '');
  editor.addEventListener('input', () => store.set('sql:' + db, editor.value));
  editor.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); run(); }
    if (e.key === 'Tab' && !e.shiftKey) {
      e.preventDefault();
      const s = editor.selectionStart;
      editor.setRangeText('  ', s, editor.selectionEnd, 'end');
    }
  });
  const limit = select([['100', '100 rows'], ['1000', '1,000 rows'], ['5000', '5,000 rows'], ['50000', '50,000 rows']], String(store.get('sqlLimit', '1000')), { class: 'input sm', style: { width: 'auto' }, onchange: (e) => store.set('sqlLimit', e.target.value) });
  const fileIn = h('input', { type: 'file', accept: '.sql,text/plain', style: { display: 'none' } });
  fileIn.addEventListener('change', async () => {
    const f = fileIn.files[0]; if (!f) return;
    if (f.size > 5 * 1024 * 1024) { toast('File is larger than 5 MB — use psql for big restores', 'error'); return; }
    editor.value = await f.text(); store.set('sql:' + db, editor.value); toast(`Loaded ${f.name}`);
  });
  const results = h('div', { style: { flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' } },
    h('div', { class: 'loading' }, h('span', { class: 'faint' }, 'Results appear here.')));
  const runBtn = btn('Run', () => run(), { class: 'primary', icon: 'play' });

  async function run(prefix = '') {
    const sel = editor.value.substring(editor.selectionStart, editor.selectionEnd);
    let sql = (sel.trim() ? sel : editor.value).trim();
    if (!sql) return;
    if (prefix) sql = prefix + sql.replace(/;\s*$/, '');
    runBtn.disabled = true;
    clear(results).appendChild(loadingView());
    const hist = store.get('history', []);
    store.set('history', [{ db, sql, at: Date.now() }, ...hist.filter(x => x.sql !== sql)].slice(0, 50));
    try {
      const res = await POST(`/api/db/${enc(db)}/sql`, { sql, limit: Number(limit.value) });
      showResult(res);
      if (/\b(create|drop|alter)\b/i.test(sql)) { refreshTables(); }
    } catch (e) {
      clear(results).appendChild(h('div', { class: 'error-box' }, e instanceof ApiError ? e.full + (e.body.pg_position ? `\nAt character ${e.body.pg_position}` : '') : String(e)));
      if (e.body && e.body.pg_position && !sel.trim()) {
        const p = Number(e.body.pg_position) - 1;
        editor.focus(); editor.setSelectionRange(p, Math.min(editor.value.length, p + 1));
      }
    } finally { runBtn.disabled = false; }
  }

  function showResult(res) {
    clear(results);
    if (res.kind !== 'rows') {
      results.appendChild(h('div', { class: 'result-meta' }, h('span', { class: 'ok' }, '✓ ' + (res.status || 'OK')), h('span', null, `${res.duration_ms} ms`)));
      return;
    }
    const exportCsv = () => {
      const esc = (v) => v == null ? '' : (typeof v === 'object' ? JSON.stringify(v) : String(v));
      const q = (s) => /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
      const lines = [res.columns.map(c => q(c.name)).join(',')].concat(res.rows.map(row => row.map(v => q(esc(v))).join(',')));
      const url = URL.createObjectURL(new Blob([lines.join('\n')], { type: 'text/csv' }));
      const a = h('a', { href: url, download: `query-${db}.csv` }); document.body.appendChild(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    };
    results.appendChild(h('div', { class: 'result-meta' },
      h('span', { class: 'ok' }, `✓ ${fmtNum(res.row_count)} row${res.row_count === 1 ? '' : 's'}`),
      res.truncated && h('span', { class: 'badge warn' }, `limited to ${fmtNum(res.row_count)}`),
      h('span', null, `${res.duration_ms} ms`), h('span', { class: 'grow' }),
      res.rows.length ? btn('Export CSV', exportCsv, { class: 'sm', icon: 'download' }) : null));
    const table = h('table', { class: 'grid' },
      h('thead', null, h('tr', null, h('th', null, h('div', { class: 'h' }, h('span', { class: 'n' }, '#'), h('span', { class: 't' }, ' '))),
        res.columns.map(c => h('th', null, h('div', { class: 'h', style: { cursor: 'default' } }, h('span', { class: 'n' }, c.name), h('span', { class: 't' }, c.type)))))),
      h('tbody', null, res.rows.map((row, i) => h('tr', null, h('td', { class: 'rn' }, i + 1), row.map(v => {
        if (v == null) return h('td', { class: 'null' }, 'NULL');
        const s = typeof v === 'object' ? JSON.stringify(v) : String(v);
        return h('td', { class: typeof v === 'number' ? 'numv' : typeof v === 'boolean' ? (v ? 'bool-t' : 'bool-f') : '', title: s.length > 40 ? s.slice(0, 2000) : null }, s.length > 300 ? s.slice(0, 300) + '…' : s);
      })))));
    results.appendChild(h('div', { class: 'grid-wrap' }, res.rows.length ? table : h('div', { class: 'loading' }, 'Query returned no rows.')));
  }

  const showHistory = () => {
    const hist = store.get('history', []);
    const box = h('div', { class: 'history' }, hist.length ? hist.map(x => h('button', {
      title: x.sql, onclick: () => { editor.value = x.sql; store.set('sql:' + db, x.sql); document.querySelector('.overlay .btn.ghost').click(); editor.focus(); },
    }, h('span', { class: 'faint' }, `[${x.db}] `), x.sql.replace(/\s+/g, ' '))) : h('div', { class: 'empty' }, 'No history yet'));
    modal({ title: 'Query history', size: 'mid', body: box, actions: [{ label: 'Clear history', left: true, onClick: () => { store.set('history', []); } }, { label: 'Close' }] });
  };

  const snippets = select([['', 'Snippets…'],
    ['SELECT table_name, pg_size_pretty(pg_total_relation_size(quote_ident(table_schema)||\'.\'||quote_ident(table_name))) AS size\nFROM information_schema.tables\nWHERE table_schema = \'public\'\nORDER BY pg_total_relation_size(quote_ident(table_schema)||\'.\'||quote_ident(table_name)) DESC;', 'Largest tables'],
    ['SELECT pid, usename, state, now() - query_start AS running_for, left(query, 200) AS query\nFROM pg_stat_activity\nWHERE state <> \'idle\' AND pid <> pg_backend_pid()\nORDER BY query_start;', 'Running queries'],
    ['SELECT relname, seq_scan, idx_scan, n_live_tup, n_dead_tup, last_autovacuum\nFROM pg_stat_user_tables\nORDER BY n_dead_tup DESC\nLIMIT 20;', 'Table health'],
    ['SELECT schemaname, relname, indexrelname, idx_scan, pg_size_pretty(pg_relation_size(indexrelid)) AS size\nFROM pg_stat_user_indexes\nWHERE idx_scan = 0\nORDER BY pg_relation_size(indexrelid) DESC;', 'Unused indexes'],
    ['CREATE VIEW my_view AS\nSELECT *\nFROM my_table\nWHERE true;', 'Create view'],
    ['BEGIN;\n\n-- your changes here\n\nCOMMIT;', 'Transaction'],
  ], '', {
    class: 'input sm', style: { width: 'auto' }, onchange: (e) => { if (e.target.value) { editor.value = e.target.value; store.set('sql:' + db, editor.value); e.target.value = ''; editor.focus(); } },
  });

  setMain({
    title: 'SQL console',
    crumbs: [[db, link.db(db)]],
    flush: true,
    actions: [
      select(state.dbs.filter(d => d.can_connect).map(d => d.name), db, { class: 'input sm', style: { width: 'auto' }, onchange: (e) => go(link.sql(e.target.value)), 'aria-label': 'Database' }),
    ],
    body: h('div', { class: 'sql-layout' },
      h('div', { class: 'editor-wrap' }, editor,
        h('div', { class: 'row', style: { gap: '8px' } },
          runBtn,
          btn('Explain', () => run('EXPLAIN (ANALYZE, BUFFERS) '), { class: '', title: 'Runs the query with EXPLAIN ANALYZE — it really executes!' }),
          limit, snippets,
          h('span', { class: 'grow' }),
          btn('History', showHistory, { class: 'sm ghost', icon: 'history' }),
          btn('Open .sql', () => fileIn.click(), { class: 'sm ghost', icon: 'file' }), fileIn,
          btn('Clear', () => { editor.value = ''; store.set('sql:' + db, ''); editor.focus(); }, { class: 'sm ghost' }))),
      results),
  });
  editor.focus();
}

// ============================================================ boot
async function boot() {
  try {
    const me = await api('GET', '/api/auth/me');
    state.user = me.user;
  } catch (e) {
    if (e.status !== 401) renderLogin(e.message);
    return;
  }
  renderShell();
  try {
    await loadDatabases();
    await loadSchemaAndTables();
  } catch (e) {
    toastErr(e, 'Cannot reach the database');
  }
  if (!location.hash) history.replaceState(null, '', '#/overview');
  route();
}
boot();
