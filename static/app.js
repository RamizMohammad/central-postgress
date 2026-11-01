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
  archive: '<rect x="3" y="4" width="18" height="4" rx="1"/><path d="M5 8v11a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1V8M10 12h4"/>',
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
  search: '<circle cx="11" cy="11" r="7"/><path d="M20 20l-3.5-3.5"/>',
  sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/>',
  moon: '<path d="M20 14.5A8.5 8.5 0 0 1 9.5 4a8.5 8.5 0 1 0 10.5 10.5z"/>',
  monitor: '<rect x="3" y="4" width="18" height="12" rx="2"/><path d="M8 20h8M12 16v4"/>',
  plug: '<path d="M9 3v5M15 3v5"/><path d="M6 8h12v3a6 6 0 0 1-12 0z"/><path d="M12 17v4"/>',
  server: '<rect x="3" y="4" width="18" height="7" rx="2"/><rect x="3" y="13" width="18" height="7" rx="2"/><path d="M7 7.5h.01M7 16.5h.01"/>',
  layers: '<path d="M12 3l9 5-9 5-9-5z"/><path d="M3 13l9 5 9-5"/>',
  activity: '<path d="M3 12h4l3-8 4 16 3-8h4"/>',
  gauge: '<path d="M4 18a9 9 0 1 1 16 0"/><path d="M12 13l4-4"/>',
  hdd: '<path d="M3 13l3-8h12l3 8v5a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1z"/><path d="M3 13h18M7 16h.01"/>',
  check: '<path d="M5 12.5l4.5 4.5L19 7.5"/>',
  alert: '<path d="M12 3l10 18H2z"/><path d="M12 10v5M12 18h.01"/>',
  info: '<circle cx="12" cy="12" r="9"/><path d="M12 11v6M12 7.5h.01"/>',
  chevron: '<path d="M9 6l6 6-6 6"/>',
  external: '<path d="M14 4h6v6M20 4l-9 9"/><path d="M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5"/>',
  terminal: '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M7 9l3 3-3 3M13 15h4"/>',
  lock: '<rect x="5" y="11" width="14" height="10" rx="2"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/>',
  folder: '<path d="M3 6a1 1 0 0 1 1-1h5l2 2h9a1 1 0 0 1 1 1v10a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1z"/>',
  book: '<path d="M4 4h6a3 3 0 0 1 3 3v13a2 2 0 0 0-2-2H4z"/><path d="M20 4h-6a3 3 0 0 0-3 3"/><path d="M20 4v14h-7"/>',
};
const GOOGLE_G = '<svg width="18" height="18" viewBox="0 0 48 48"><path fill="#FFC107" d="M43.6 20.5H42V20H24v8h11.3C33.7 32.7 29.2 36 24 36c-6.6 0-12-5.4-12-12s5.4-12 12-12c3.1 0 5.8 1.2 7.9 3.1l5.7-5.7C34 6.1 29.3 4 24 4 12.9 4 4 12.9 4 24s8.9 20 20 20 20-8.9 20-20c0-1.3-.1-2.6-.4-3.5z"/><path fill="#FF3D00" d="M6.3 14.7l6.6 4.8C14.7 15.1 19 12 24 12c3.1 0 5.8 1.2 7.9 3.1l5.7-5.7C34 6.1 29.3 4 24 4 16.3 4 9.7 8.3 6.3 14.7z"/><path fill="#4CAF50" d="M24 44c5.2 0 9.9-2 13.4-5.2l-6.2-5.2C29.2 35.1 26.7 36 24 36c-5.2 0-9.6-3.3-11.3-8l-6.5 5C9.5 39.6 16.2 44 24 44z"/><path fill="#1976D2" d="M43.6 20.5H42V20H24v8h11.3c-.8 2.2-2.2 4.2-4.1 5.6l6.2 5.2C37 39.2 44 34 44 24c0-1.3-.1-2.6-.4-3.5z"/></svg>';
function icon(name, size) {
  const s = size || 16;
  return h('span', {
    style: { display: 'inline-flex' },
    html: `<svg width="${s}" height="${s}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">${ICONS[name] || ''}</svg>`,
  });
}
const LOGO = '<svg width="28" height="28" viewBox="0 0 32 32"><rect width="32" height="32" rx="8" fill="#2f62ea"/><ellipse cx="16" cy="10" rx="8" ry="3.2" fill="white"/><path d="M8 10v12c0 1.8 3.6 3.2 8 3.2s8-1.4 8-3.2V10" fill="none" stroke="white" stroke-width="2.2"/><path d="M8 16c0 1.8 3.6 3.2 8 3.2s8-1.4 8-3.2" fill="none" stroke="white" stroke-width="2.2"/></svg>';

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
function until(ms) {
  const s = Math.max(0, (ms - Date.now()) / 1000);
  if (s < 3600) return Math.ceil(s / 60) + 'm';
  return Math.floor(s / 3600) + 'h ' + Math.floor((s % 3600) / 60) + 'm';
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
let inflight = 0;
let busyTimer = null;
function busy(delta) {
  inflight = Math.max(0, inflight + delta);
  if (inflight && !busyTimer) busyTimer = setTimeout(() => document.body.classList.add('busy'), 120);
  if (!inflight) { clearTimeout(busyTimer); busyTimer = null; document.body.classList.remove('busy'); }
}
async function api(method, path, body, opts2 = {}) {
  const quiet = path.startsWith('/api/backup/jobs/'); // polled every second; no progress bar
  if (!quiet) busy(1);
  try { return await apiCall(method, path, body, opts2); } finally { if (!quiet) busy(-1); }
}
async function apiCall(method, path, body, { raw = false } = {}) {
  const opts = { method, headers: { 'X-CP-Client': 'panel' }, credentials: 'same-origin' };
  if (body instanceof FormData) opts.body = body;
  else if (body !== undefined) { opts.body = JSON.stringify(body); opts.headers['Content-Type'] = 'application/json'; }
  const res = await fetch(path, opts);
  if (raw) return res;
  let data = null;
  const text = await res.text();
  try { data = text ? JSON.parse(text) : null; } catch { data = { detail: text }; }
  if (res.status === 401 && !path.startsWith('/api/auth/')) {
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
  const el = h('div', { class: 'toast ' + (type === 'error' ? 'error' : '') }, h('span', { class: 'ti' }, icon(type === 'error' ? 'alert' : 'check')),
    h('div', null, title ? h('div', { class: 't' }, title) : null, msg));
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
function modal({ title, body, size = '', actions = [], dismissable = true, drawer = false }) {
  let closeFn = null;
  const p = new Promise((resolve) => {
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
    const overlay = h('div', { class: 'overlay' + (drawer ? ' drawer' : ''), onmousedown: (e) => { if (e.target === overlay && dismissable) close(null); } }, m);
    document.body.appendChild(overlay);
    document.addEventListener('keydown', onKey);
    closeFn = close;
    const first = m.querySelector('input:not([type=checkbox]), textarea, select');
    if (first) setTimeout(() => first.focus(), 20);
  });
  p.close = (v = null) => closeFn && closeFn(v);
  return p;
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
  me: null,
  authCfg: null,
  serverVersion: null,
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
const IS_MAC = /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);

function parseRoute() {
  const parts = location.hash.replace(/^#\/?/, '').split('/').filter(Boolean).map(decodeURIComponent);
  if (!parts.length || parts[0] === 'overview') return { page: 'overview' };
  if (parts[0] === 'databases') return { page: 'databases' };
  if (parts[0] === 'roles') return { page: 'roles' };
  if (parts[0] === 'keys') return { page: 'keys' };
  if (parts[0] === 'backups') return { page: 'backups' };
  if (parts[0] === 'connect') return { page: 'connect' };
  if (parts[0] === 'redis') {
    if (parts[1] === 'p' && parts[2]) return { page: 'redisProject', project: parts[2], tab: parts[3] || 'browser' };
    return { page: 'redis' };
  }
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
  keys: () => '#/keys',
  backups: () => '#/backups',
  connect: () => '#/connect',
  redis: () => '#/redis',
  redisProject: (id, tab = 'browser') => `#/redis/p/${enc(id)}/${tab}`,
  db: (db) => `#/db/${enc(db)}`,
  sql: (db) => `#/db/${enc(db)}/sql`,
  table: (db, s, t, tab = 'data') => `#/db/${enc(db)}/t/${enc(s)}/${enc(t)}/${tab}`,
};
function go(hash) { if (location.hash === hash) route(); else location.hash = hash; }
window.addEventListener('hashchange', () => route());

// ============================================================ theme
const THEMES = { auto: ['monitor', 'System theme'], light: ['sun', 'Light theme'], dark: ['moon', 'Dark theme'] };
function applyTheme(t) {
  if (t === 'light' || t === 'dark') document.documentElement.setAttribute('data-theme', t);
  else document.documentElement.removeAttribute('data-theme');
  store.set('theme', t);
}
function themeButton() {
  const b = h('button', { type: 'button', class: 'btn ghost icon' });
  const paint = () => {
    const t = store.get('theme', 'auto');
    clear(b).appendChild(icon(THEMES[t][0]));
    b.title = THEMES[t][1] + ' (click to change)';
    b.setAttribute('aria-label', b.title);
  };
  b.addEventListener('click', () => {
    const order = ['auto', 'light', 'dark'];
    applyTheme(order[(order.indexOf(store.get('theme', 'auto')) + 1) % 3]);
    paint();
  });
  paint();
  return b;
}

// ============================================================ login
async function renderLogin(message) {
  $shell = null;
  const params = new URLSearchParams(location.search);
  if (params.get('auth_error')) {
    message = params.get('auth_error');
    history.replaceState(null, '', location.pathname + location.hash);
  }
  let cfg = state.authCfg;
  if (!cfg) {
    try { cfg = state.authCfg = await api('GET', '/api/auth/config'); } catch { cfg = { password: true, google: false }; }
  }
  clear($app);
  const err = h('div', { class: 'err', role: 'alert' }, message || '');
  let first = null;
  let form = null;
  if (cfg.password) {
    const user = h('input', { class: 'input', name: 'username', autocomplete: 'username', value: 'admin' });
    const pass = h('input', { class: 'input', name: 'password', type: 'password', autocomplete: 'current-password', placeholder: '••••••••' });
    const submit = h('button', { class: 'btn primary block', type: 'submit' }, 'Sign in');
    form = h('form', {
      onsubmit: async (e) => {
        e.preventDefault();
        submit.disabled = true; err.textContent = '';
        try {
          await api('POST', '/api/auth/login', { username: user.value, password: pass.value });
          await boot();
        } catch (ex) { err.textContent = ex.message; pass.select(); } finally { submit.disabled = false; }
      },
    }, field('Username', user), field('Password', pass), submit);
    first = user.value ? pass : user;
  }
  const google = cfg.google && h('a', { class: 'btn google', href: '/api/auth/google/start' }, h('span', { html: GOOGLE_G, style: { display: 'inline-flex' } }), 'Continue with Google');
  const card = h('div', { class: 'login-card' },
    h('div', { class: 'head' },
      h('span', { html: LOGO.replace(/28/g, '36') }),
      h('div', null, h('h1', null, 'Sign in to central-postgres'), h('p', null, 'PostgreSQL administration panel'))),
    h('div', { class: 'body' }, err, google, google && form && h('div', { class: 'divider' }, 'or use password'), form),
    h('div', { class: 'foot' }, icon('lock', 14), cfg.google ? 'Only approved Google accounts can sign in.' : 'Sessions are signed and expire automatically.'));
  $app.appendChild(h('div', { class: 'login' }, card, h('div', { class: 'login-under mono' }, location.host)));
  if (first) setTimeout(() => first.focus(), 20);
}

// ============================================================ shell
const $app = document.getElementById('app');
let $sidebar, $main, $shell, $content, $crumbs;

function renderShell() {
  clear($app);
  sidebarSig = '';
  $sidebar = h('aside', { class: 'sidebar' });
  $crumbs = h('div', { class: 'crumbs' });
  $content = h('div', { class: 'content' });
  const topbar = h('header', { class: 'topbar' },
    btn('', () => $shell.classList.toggle('nav-open'), { class: 'ghost icon menu-btn', icon: 'menu', title: 'Menu' }),
    $crumbs,
    h('div', { class: 'spacer' }),
    h('button', { type: 'button', class: 'search-btn', onclick: () => openPalette() }, icon('search', 14), h('span', { class: 'lbl' }, 'Jump to a table or page…'), h('kbd', null, IS_MAC ? '⌘K' : 'Ctrl K')),
    themeButton());
  $main = h('main', { class: 'main' }, topbar, $content);
  $shell = h('div', { class: 'shell', onclick: (e) => { if (e.target === $shell) $shell.classList.remove('nav-open'); } }, $sidebar, $main);
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

function initials(s) {
  const base = String(s || '?').split('@')[0].replace(/[._-]+/g, ' ').trim();
  const parts = base.split(/\s+/).filter(Boolean);
  return ((parts[0] || '?')[0] + (parts[1] ? parts[1][0] : (parts[0] || '').slice(1, 2))).toUpperCase();
}

let sidebarSig = '';
function syncSidebarActive() {
  if (!$sidebar) return;
  const r = parseRoute();
  $sidebar.querySelectorAll('.nav a[data-pages]').forEach((a) => a.classList.toggle('active', a.dataset.pages.split(',').includes(r.page)));
  $sidebar.querySelectorAll('.table-list a[data-t]').forEach((a) => {
    const name = a.dataset.t;
    a.classList.toggle('active', r.page === 'table' && r.db === state.db && r.schema === state.schema && r.table === name);
    a.setAttribute('href', link.table(state.db, state.schema, name, r.page === 'table' ? r.tab : 'data'));
  });
}

function renderSidebar() {
  if (!$sidebar) return;
  const sig = JSON.stringify([state.dbs.map(d => [d.name, d.can_connect]), state.db, state.schema,
    state.schemas.map(x => [x.name, x.tables]), state.tables.map(t => [t.name, t.kind, t.row_estimate]),
    state.serverVersion, state.me && [state.me.user, state.me.name]]);
  if (sig === sidebarSig && $sidebar.firstChild) return syncSidebarActive();
  sidebarSig = sig;
  const prevScroll = ($sidebar.querySelector('.side-scroll') || {}).scrollTop || 0;
  const r = parseRoute();
  const navItem = (href, ic, label, pages, attrs = {}) => h('a', Object.assign({ href, 'data-pages': pages || null }, attrs), icon(ic), label);
  const dbSel = select(state.dbs.filter(d => d.can_connect).map(d => d.name), state.db, {
    class: 'input sm', onchange: (e) => go(link.db(e.target.value)), 'aria-label': 'Database', title: 'Database',
  });
  const schemaSel = select(state.schemas.map(s => [s.name, `${s.name} (${s.tables})`]), state.schema, {
    class: 'input sm', 'aria-label': 'Schema', title: 'Schema',
    onchange: async (e) => {
      state.schema = e.target.value; store.set('schema', state.schema);
      await refreshTables();
      if (r.page === 'db') route();
    },
  });
  const listEl = h('div', { class: 'table-list' });
  const drawList = () => {
    clear(listEl);
    const f = state.tableFilter.toLowerCase();
    const items = state.tables.filter(t => !f || t.name.toLowerCase().includes(f));
    if (!items.length) listEl.appendChild(h('div', { class: 'empty' }, state.tables.length ? 'No match' : 'No tables in this schema'));
    const frag = document.createDocumentFragment();
    for (const t of items) {
      frag.appendChild(h('a', { href: link.table(state.db, state.schema, t.name, r.page === 'table' ? r.tab : 'data'), 'data-t': t.name, title: t.name },
        icon(t.kind === 'v' || t.kind === 'm' ? 'view' : 'table', 14), h('span', { class: 'nm' }, t.name),
        h('span', { class: 'count' }, t.kind === 'v' ? 'view' : (t.row_estimate ? shortNum(t.row_estimate) : ''))));
    }
    listEl.appendChild(frag);
    syncSidebarActive();
  };
  const filter = h('input', {
    class: 'input sm', placeholder: 'Filter tables', value: state.tableFilter, 'aria-label': 'Filter tables',
    oninput: (e) => { state.tableFilter = e.target.value; drawList(); },
  });
  drawList();

  const me = state.me || { user: state.user };
  const who = me.name && me.name !== me.user ? me.name : me.user;
  clear($sidebar);
  append($sidebar, [
    h('div', { class: 'brand' }, h('span', { html: LOGO }), h('div', null, 'central-postgres', h('small', null, state.serverVersion ? 'PostgreSQL ' + state.serverVersion : 'Database admin'))),
    h('div', { class: 'server-chip', title: 'Panel host' }, h('span', { class: 'dot' }), h('span', { class: 'mono' }, location.host)),
    h('div', { class: 'side-scroll' },
      h('nav', { class: 'nav' },
        h('div', { class: 'nav-label' }, 'Workspace'),
        navItem(link.overview(), 'home', 'Overview', 'overview'),
        navItem(link.databases(), 'db', 'Databases', 'databases,db'),
        navItem(link.sql(state.db), 'terminal', 'SQL console', 'sql'),
        h('div', { class: 'nav-label' }, 'Access'),
        navItem(link.roles(), 'users', 'Roles & permissions', 'roles'),
        navItem(link.keys(), 'key', 'API keys', 'keys'),
        h('div', { class: 'nav-label' }, 'Redis'),
        navItem(link.redis(), 'layers', 'Redis projects', 'redis,redisProject'),
        h('div', { class: 'nav-label' }, 'Operations'),
        navItem(link.backups(), 'archive', 'Backup & restore', 'backups'),
        navItem(link.connect(), 'plug', 'Connection guide', 'connect'),
        navItem('/api/docs', 'book', 'API reference', null, { target: '_blank', rel: 'noopener' })),
      h('div', { class: 'explorer' },
        h('div', { class: 'nav-label' }, 'Explorer', state.db && h('a', { href: link.db(state.db) }, 'Open database')),
        h('div', { class: 'explorer-sel' }, dbSel, schemaSel),
        h('div', { class: 'searchbox' }, icon('search', 13), filter)),
      listEl,
      state.db && h('div', { class: 'side-new' }, btn('New table', () => newTableModal(), { class: 'sm', icon: 'plus' }))),
    h('div', { class: 'side-foot' },
      h('div', { class: 'avatar', title: me.user }, initials(who)),
      h('div', { class: 'who' }, h('b', { title: me.user }, who), h('small', null, me.method === 'google' ? 'Google · ' + me.user : 'Password sign-in')),
      btn('', logout, { class: 'sm ghost icon', icon: 'logout', title: 'Sign out' })),
  ]);
  syncSidebarActive();
  const sc = $sidebar.querySelector('.side-scroll');
  if (sc) sc.scrollTop = prevScroll;
}

async function logout() {
  try { await POST('/api/auth/logout'); } catch { /* ignore */ }
  state.user = null; state.me = null;
  renderLogin();
}

/**
 * setMain({ crumbs: [[label, href]…], title, sub, badges, actions, tabs, body, flush })
 * Non-flush pages scroll as a whole; flush pages (data grid, SQL) manage their own scroll areas.
 */
function setMain(opts) {
  if (opts.loading) return pageLoading(opts);
  const { crumbs = [], title, sub = null, badges = null, actions = [], tabs = null, body, flush = false, monoTitle = false } = opts;
  // Same page re-rendered (refresh, save, filter): keep the scroll position.
  const same = $content.dataset.key === location.hash;
  const prevTop = $content.scrollTop;
  const oldGrid = $content.querySelector('.grid-wrap');
  const gTop = oldGrid ? oldGrid.scrollTop : 0;
  const gLeft = oldGrid ? oldGrid.scrollLeft : 0;
  clear($crumbs);
  append($crumbs, [crumbs.map((c) => [h('a', { href: c[1] }, c[0]), h('span', { class: 'sep' }, '/')]), h('span', { class: 'cur' }, title)]);
  const head = h('div', { class: 'page-head' },
    h('div', { class: 'titles' }, h('h1', { class: monoTitle ? 'mono-title' : null }, title, badges), sub && h('div', { class: 'sub' }, sub)),
    actions && actions.length ? h('div', { class: 'actions' }, actions) : null);
  clear($content);
  $content.className = 'content' + (flush ? ' flush' : '');
  if (flush) append($content, [head, tabs, body]);
  else $content.appendChild(h('div', { class: 'page' }, head, tabs, body));
  $content.dataset.key = location.hash;
  if (same) {
    $content.scrollTop = prevTop;
    const g = $content.querySelector('.grid-wrap');
    if (g && oldGrid) { g.scrollTop = gTop; g.scrollLeft = gLeft; }
  } else {
    $content.scrollTop = 0;
  }
  $shell.classList.remove('nav-open');
  document.title = `${title} · central-postgres`;
  return $content;
}

/**
 * Called by views before their data arrives. Instead of blanking the page, the current
 * content stays up (dimmed when it's a different page) while the top progress bar runs;
 * a spinner replaces it only if the new page takes longer than 400 ms.
 */
function pageLoading(opts) {
  const same = $content.dataset.key === location.hash;
  if (!$content.firstChild) return setMain(Object.assign({}, opts, { loading: false, body: loadingView() }));
  if (same) return $content;
  $content.classList.add('stale');
  const seq = renderSeq;
  const hash = location.hash;
  setTimeout(() => {
    if (seq === renderSeq && location.hash === hash && $content.dataset.key !== hash) {
      setMain(Object.assign({}, opts, { loading: false, body: loadingView() }));
      $content.dataset.key = '';
    }
  }, 400);
  return $content;
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
  const views = { overview: viewOverview, databases: viewDatabases, roles: viewRoles, keys: viewKeys, backups: viewBackups, connect: viewConnect, redis: viewRedis, redisProject: viewRedisProject, db: viewDb, sql: viewSql, table: viewTable };
  try {
    await views[r.page](r, seq);
  } catch (e) {
    if (seq !== renderSeq) return;
    toastErr(e);
    setMain({ title: 'Error', body: h('div', { class: 'error-box', style: { margin: 0 } }, e instanceof ApiError ? e.full : String(e)) });
  }
}

// ============================================================ command palette (⌘K)
function openPalette() {
  if (document.querySelector('.overlay.palette')) return;
  const pages = [
    ['Overview', link.overview(), 'home'], ['Databases', link.databases(), 'db'], ['SQL console', link.sql(state.db), 'terminal'],
    ['Roles & permissions', link.roles(), 'users'], ['API keys', link.keys(), 'key'], ['Backup & restore', link.backups(), 'archive'],
    ['Connection guide', link.connect(), 'plug'], ['Redis projects', link.redis(), 'layers'],
  ];
  const input = h('input', { placeholder: 'Search tables, databases and pages…', 'aria-label': 'Search', autocomplete: 'off', spellcheck: 'false' });
  const list = h('div', { class: 'palette-list' });
  let items = [];
  let active = 0;
  const overlay = h('div', { class: 'overlay palette', onmousedown: (e) => { if (e.target === overlay) close(); } },
    h('div', { class: 'modal', role: 'dialog', 'aria-modal': 'true' },
      h('div', { class: 'palette-input' }, icon('search', 18), input, h('kbd', null, 'esc')),
      list,
      h('div', { class: 'palette-foot' }, h('span', null, h('kbd', null, '↑'), ' ', h('kbd', null, '↓'), ' navigate'), h('span', null, h('kbd', null, '↵'), ' open'))));
  const close = () => { overlay.remove(); document.removeEventListener('keydown', onKey, true); };
  const pick = (it) => { close(); if (it) go(it.href); };
  const draw = () => {
    const q = input.value.trim().toLowerCase();
    const match = (s) => !q || s.toLowerCase().includes(q);
    const groups = [
      ['Tables in ' + (state.db || '') + '.' + state.schema, state.tables.filter(t => match(t.name)).slice(0, 30).map(t => ({ label: t.name, href: link.table(state.db, state.schema, t.name), ic: t.kind === 'v' || t.kind === 'm' ? 'view' : 'table', hint: t.row_estimate ? shortNum(t.row_estimate) + ' rows' : '' }))],
      ['Databases', state.dbs.filter(d => d.can_connect && match(d.name)).map(d => ({ label: d.name, href: link.db(d.name), ic: 'db', hint: fmtBytes(d.size_bytes) }))],
      ['Redis projects', (state.redisProjects || []).filter(p => match(p.id)).map(p => ({ label: p.id, href: link.redisProject(p.id), ic: 'layers', hint: p.keys != null ? fmtNum(p.keys) + ' keys' : '' }))],
      ['Pages', pages.filter(p => match(p[0])).map(p => ({ label: p[0], href: p[1], ic: p[2], hint: '' }))],
    ];
    clear(list);
    items = [];
    for (const [g, arr] of groups) {
      if (!arr.length) continue;
      list.appendChild(h('div', { class: 'palette-group' }, g));
      for (const it of arr) {
        const i = items.length;
        it.el = h('div', { class: 'palette-item', onmousemove: () => { if (active !== i) { active = i; paint(); } }, onclick: () => pick(it) }, icon(it.ic, 15), h('span', { class: 'mono' }, it.label), it.hint && h('span', { class: 'hint' }, it.hint));
        items.push(it);
        list.appendChild(it.el);
      }
    }
    if (!items.length) list.appendChild(h('div', { class: 'loading' }, 'Nothing found'));
    active = 0; paint();
  };
  const paint = () => items.forEach((it, i) => { it.el.classList.toggle('active', i === active); if (i === active) it.el.scrollIntoView({ block: 'nearest' }); });
  const onKey = (e) => {
    if (e.key === 'Escape') { e.preventDefault(); close(); }
    else if (e.key === 'ArrowDown') { e.preventDefault(); active = Math.min(items.length - 1, active + 1); paint(); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); active = Math.max(0, active - 1); paint(); }
    else if (e.key === 'Enter') { e.preventDefault(); pick(items[active]); }
  };
  input.addEventListener('input', draw);
  document.addEventListener('keydown', onKey, true);
  document.body.appendChild(overlay);
  draw();
  setTimeout(() => input.focus(), 10);
}
document.addEventListener('keydown', (e) => {
  if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k' && state.user && $shell) { e.preventDefault(); openPalette(); }
});

// ============================================================ overview
function statCard(label, ic, value, sub, extra) {
  return h('div', { class: 'card' }, h('div', { class: 'k' }, label, icon(ic)), h('div', { class: 'v' }, value), extra, sub != null && h('div', { class: 's' }, sub));
}

async function viewOverview(r, seq) {
  setMain({ title: 'Overview', body: null, loading: true });
  const o = await GET('/api/overview');
  if (seq !== renderSeq) return;
  const s = o.server;
  const st = o.stats || {};
  const version = (s.server_version || '').split(' ')[0];
  if (state.serverVersion !== version) { state.serverVersion = version; renderSidebar(); }
  const pct = Math.min(100, Math.round((s.connections / s.max_connections) * 100));
  const hit = st.cache_hit_pct;
  const hitBadge = hit == null ? null : hit >= 99 ? h('span', { class: 'badge ok' }, 'optimal') : hit >= 90 ? h('span', { class: 'badge warn' }, 'fair') : h('span', { class: 'badge danger' }, 'low');
  const maxSize = Math.max(1, ...o.databases.map(d => d.size_bytes || 0));
  const largest = [...o.databases].sort((a, b) => (b.size_bytes || 0) - (a.size_bytes || 0)).slice(0, 8);

  const actBody = o.activity.length ? h('div', { class: 'scroll-x' }, h('table', { class: 'list' },
    h('thead', null, h('tr', null, ['PID', 'Database', 'User', 'Application', 'State', 'Client', 'Connected', 'Query', ''].map(x => h('th', null, x)))),
    h('tbody', null, o.activity.map(a => h('tr', null,
      h('td', { class: 'mono' }, a.pid), h('td', null, a.datname), h('td', null, a.usename), h('td', { class: 'muted' }, a.application_name || '—'),
      h('td', null, h('span', { class: 'badge ' + (a.state === 'active' ? 'ok' : a.state && a.state.startsWith('idle in') ? 'warn' : '') }, a.state || '—')),
      h('td', { class: 'mono muted' }, a.client_addr || 'local'), h('td', { class: 'nowrap muted' }, since(a.backend_start)),
      h('td', { class: 'mono', style: { maxWidth: '360px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }, title: a.query }, a.query || ''),
      h('td', { class: 'actions' }, btn('Terminate', async () => {
        if (!await confirmDanger({ title: 'Terminate connection?', message: `This ends backend ${a.pid} (${a.usename} on ${a.datname}).`, confirmLabel: 'Terminate' })) return;
        try { await POST(`/api/connections/${a.pid}/terminate`); toast('Connection terminated'); route(); } catch (e) { toastErr(e); }
      }, { class: 'sm danger' }))))))) : h('div', { class: 'empty' }, 'No other connections right now.');

  const check = (label, sub, level, value) => h('div', null,
    h('span', { class: 'dot ' + (level === 'ok' ? '' : level) }),
    h('div', { class: 'k' }, label, h('small', null, sub)),
    h('span', { class: 'badge ' + (level === 'ok' ? 'ok' : level) }, value));
  const health = [
    check('Connection usage', `${s.connections} of ${s.max_connections} slots in use`, pct < 70 ? 'ok' : pct < 90 ? 'warn' : 'danger', pct + '%'),
    hit != null && check('Cache hit ratio', 'reads served from shared buffers (low right after a restart)', hit >= 99 ? 'ok' : hit >= 90 ? 'warn' : 'danger', hit.toFixed(1) + '%'),
    check('Idle in transaction', 'sessions holding a transaction open', st.idle_in_tx ? 'warn' : 'ok', String(st.idle_in_tx || 0)),
    check('Deadlocks', 'since statistics were last reset', st.deadlocks ? 'warn' : 'ok', fmtNum(st.deadlocks || 0)),
    check('Temp files', 'sorts and hashes spilled to disk', (st.temp_bytes || 0) > 1024 ** 3 ? 'warn' : 'ok', fmtBytes(st.temp_bytes || 0)),
  ];

  setMain({
    title: 'Overview',
    sub: h('span', null, h('span', { class: 'mono' }, 'PostgreSQL ' + version), ' · connected as ', h('strong', null, s.current_user), ' · up ', since(s.started_at)),
    badges: h('span', { class: 'badge ok' }, 'online'),
    actions: [btn('Refresh', () => route(), { icon: 'refresh' }), btn('SQL console', () => go(link.sql(state.db)), { icon: 'terminal' }), btn('New database', () => newDatabaseModal(), { class: 'primary', icon: 'plus' })],
    body: [
      h('div', { class: 'cards' },
        statCard('Server', 'server', [h('span', { class: 'dot' }), 'Healthy'], 'up ' + since(s.started_at)),
        statCard('PostgreSQL', 'layers', version, h('span', { class: 'badges' },
          s.is_superuser ? h('span', { class: 'badge warn' }, 'superuser') : h('span', { class: 'badge' }, s.current_user),
          s.can_create_db && h('span', { class: 'badge' }, 'createdb'))),
        statCard('Databases', 'db', o.databases.length, fmtBytes(o.total_size_bytes) + ' total'),
        statCard('Connections', 'activity', [String(s.connections), h('small', null, '/ ' + s.max_connections)],
          `${st.active ?? 0} active · ${st.idle_in_tx ?? 0} idle in tx · ${st.idle ?? 0} idle`,
          h('div', { class: 'bar' }, h('i', { style: { width: pct + '%', background: pct > 80 ? 'var(--danger)' : '' } }))),
        statCard('Cache hit ratio', 'gauge', [hit == null ? '—' : hit.toFixed(1) + '%', hitBadge], 'shared_buffers ' + (st.shared_buffers || '—')),
        statCard('Transactions', 'check', shortNum(st.commits || 0), `${shortNum(st.rollbacks || 0)} rollbacks · ${fmtNum(st.deadlocks || 0)} deadlocks`)),
      h('div', { class: 'cols' },
        h('div', { class: 'section' },
          h('div', { class: 'section-head' }, h('h3', null, 'Largest databases'), h('span', { class: 'count' }, o.databases.length),
            h('div', { class: 'actions' }, h('a', { href: link.databases(), class: 'small' }, 'View all →'))),
          h('div', { class: 'scroll-x' }, h('table', { class: 'list' },
            h('thead', null, h('tr', null, h('th', null, 'Database'), h('th', null, 'Owner'), h('th', null, 'Size'), h('th', { class: 'num' }, 'Conns'))),
            h('tbody', null, largest.map(d => h('tr', null,
              h('td', null, h('a', { href: link.db(d.name), class: 'name-cell mono' }, icon('db', 14), d.name)),
              h('td', { class: 'muted' }, d.owner || '—'),
              h('td', null, h('div', { class: 'size-cell' }, h('div', { class: 'bar' }, h('i', { style: { width: Math.max(1, ((d.size_bytes || 0) / maxSize) * 100) + '%' } })), h('span', null, fmtBytes(d.size_bytes)))),
              h('td', { class: 'num' }, d.connections ?? '—'))))))),
        h('div', { class: 'section' },
          h('div', { class: 'section-head' }, h('h3', null, 'Health checks')),
          h('div', { class: 'kv' }, health))),
      h('div', { class: 'section' },
        h('div', { class: 'section-head' }, h('h3', null, 'Active connections'), h('span', { class: 'count' }, o.activity.length)),
        actBody),
    ],
  });
}

// ============================================================ databases
async function viewDatabases(r, seq) {
  setMain({ title: 'Databases', body: null, loading: true });
  await loadDatabases();
  if (seq !== renderSeq) return;
  renderSidebar();
  const maxSize = Math.max(1, ...state.dbs.map(d => d.size_bytes || 0));
  const filter = h('input', { class: 'input sm', placeholder: 'Filter databases', style: { width: '220px' } });
  const tbody = h('tbody');
  const draw = () => {
    const f = filter.value.trim().toLowerCase();
    clear(tbody);
    for (const d of state.dbs.filter(x => !f || x.name.toLowerCase().includes(f))) {
      tbody.appendChild(h('tr', null,
        h('td', null, h('div', { class: 'name-cell' }, icon('db', 15),
          d.can_connect ? h('a', { href: link.db(d.name), class: 'mono' }, d.name) : h('span', { class: 'mono' }, d.name),
          d.is_default && h('span', { class: 'badge accent' }, 'default'),
          d.protected && !d.is_default && h('span', { class: 'badge' }, 'protected'),
          !d.can_connect && h('span', { class: 'badge warn' }, 'no access')),
        d.comment && h('div', { class: 'faint small', style: { paddingLeft: '23px' } }, d.comment)),
        h('td', { class: 'muted' }, d.owner),
        h('td', null, h('div', { class: 'size-cell' }, h('div', { class: 'bar' }, h('i', { style: { width: Math.max(1, ((d.size_bytes || 0) / maxSize) * 100) + '%' } })), h('span', null, fmtBytes(d.size_bytes)))),
        h('td', { class: 'num' }, d.connections),
        h('td', { class: 'muted mono small' }, d.encoding),
        h('td', { class: 'actions' },
          d.can_connect && btn('SQL', () => go(link.sql(d.name)), { class: 'sm ghost', icon: 'terminal' }),
          d.can_connect && btn('Backup', () => backupModal(d.name), { class: 'sm ghost', icon: 'download' }),
          btn('Edit', () => editDatabaseModal(d), { class: 'sm ghost', icon: 'edit' }),
          !d.protected && btn('Drop', () => dropDatabase(d), { class: 'sm danger' }))));
    }
    if (!tbody.children.length) tbody.appendChild(h('tr', null, h('td', { colspan: '6', class: 'faint', style: { textAlign: 'center', padding: '24px' } }, 'No match')));
  };
  filter.addEventListener('input', draw);
  draw();
  setMain({
    title: 'Databases',
    sub: `${state.dbs.length} databases on this server · one database and one owner role per app keeps services isolated`,
    actions: [btn('Refresh', () => route(), { icon: 'refresh' }), btn('New database', () => newDatabaseModal(), { class: 'primary', icon: 'plus' })],
    body: h('div', { class: 'section' },
      h('div', { class: 'section-head' }, h('h3', null, 'All databases'), h('span', { class: 'count' }, state.dbs.length), h('div', { class: 'actions' }, filter)),
      h('div', { class: 'scroll-x' }, h('table', { class: 'list' },
        h('thead', null, h('tr', null, h('th', null, 'Name'), h('th', null, 'Owner'), h('th', null, 'Size'), h('th', { class: 'num' }, 'Conns'), h('th', null, 'Encoding'), h('th', null, ''))),
        tbody))),
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
    drawer: true,
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
    drawer: true,
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
  setMain({ title: 'Roles & permissions', body: null, loading: true });
  const roles = await GET('/api/roles');
  if (seq !== renderSeq) return;
  setMain({
    title: 'Roles & permissions',
    sub: 'Postgres login and group roles. Grant read, write or full access per database schema.',
    actions: [btn('Refresh', () => route(), { icon: 'refresh' }), btn('New role', () => newRoleModal(), { class: 'primary', icon: 'plus' })],
    body: [
      h('div', { class: 'section' }, h('div', { style: { overflowX: 'auto' } }, h('table', { class: 'list' },
        h('thead', null, h('tr', null, ['Role', 'Attributes', 'Member of', 'Owns databases', ''].map(x => h('th', null, x)))),
        h('tbody', null, roles.map(ro => h('tr', null,
          h('td', null, h('div', { class: 'name-cell' }, h('span', { class: 'avatar', style: { width: '26px', height: '26px', fontSize: '10.5px' } }, ro.name.slice(0, 2).toUpperCase()), h('span', { class: 'mono' }, ro.name), ro.is_current && h('span', { class: 'badge accent' }, 'you'))),
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
    drawer: true,
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
    drawer: true,
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
    drawer: true,
    body: [h('div', { class: 'grid2' }, field('Database', dbSel), field('Schema', schemaSel)), field('Access level', level)],
    actions: [{ label: 'Cancel' }, { label: 'Apply', primary: true, onClick: () => POST(`/api/db/${enc(dbSel.value)}/grant`, { role, level: level.value, schema: schemaSel.value }) }],
  });
  if (res) {
    toast(`Updated access for ${role}`);
    await modal({ title: 'Statements executed', size: 'mid', body: h('pre', { class: 'code' }, res.statements.join(';\n') + ';'), actions: [{ label: 'Close', primary: true }] });
  }
}

// ============================================================ full-server backup & restore
const KIND_LABEL = { bundle: ['Full server', 'accent'], dump: ['Database dump', ''], sql: ['SQL file', ''], unknown: ['Unknown', 'warn'] };

async function viewBackups(r, seq) {
  setMain({ title: 'Backup & restore', body: null, loading: true });
  const [st, files] = await Promise.all([GET('/api/backup/status'), GET('/api/backup/files')]);
  if (seq !== renderSeq) return;
  const job = st.job;
  const running = job && (job.status === 'running' || job.status === 'queued');
  const toolsBad = !st.tools.ok;

  const jobBox = job ? jobPanel(job, seq) : null;
  const auto = st.auto.every_hours > 0
    ? h('div', null, h('div', { class: 'v', style: { fontSize: '17px' } }, `every ${st.auto.every_hours}h`),
      h('div', { class: 's' }, `keeps last ${st.auto.keep}` + (st.auto.next_run ? ` · next in ${until(st.auto.next_run * 1000)}` : '')))
    : h('div', null, h('div', { class: 'v', style: { fontSize: '17px' } }, 'off'), h('div', { class: 's' }, 'set AUTO_BACKUP_HOURS in .env'));

  setMain({
    title: 'Backup & restore',
    sub: 'Full-server bundles (every database, roles, passwords and API keys) or single-database dumps.',
    actions: [
      btn('Refresh', () => route(), { icon: 'refresh' }),
      btn('Upload backup', () => uploadBackup(st), { icon: 'upload', disabled: running }),
      btn('Create full backup', () => fullBackupModal(st), { class: 'primary', icon: 'archive', disabled: running || toolsBad }),
    ],
    body: [
      toolsBad && h('div', { class: 'callout', style: { marginBottom: '16px' } }, st.tools.message),
      h('div', { class: 'cards' },
        h('div', { class: 'card' }, h('div', { class: 'k' }, 'Server'), h('div', { class: 'v', style: { fontSize: '17px' } }, 'PostgreSQL ' + st.server.major),
          h('div', { class: 's' }, st.server.user + (st.server.superuser ? ' · superuser' : ' · not superuser'))),
        h('div', { class: 'card' }, h('div', { class: 'k' }, 'Backup folder'), h('div', { class: 'v', style: { fontSize: '17px' } }, fmtBytes(st.disk.free_bytes) + ' free'),
          h('div', { class: 's mono' }, st.backup_dir)),
        h('div', { class: 'card' }, h('div', { class: 'k' }, 'Automatic backups'), auto),
        h('div', { class: 'card' }, h('div', { class: 'k' }, 'Tools'), h('div', { class: 'v', style: { fontSize: '17px' } }, st.tools.versions.pg_dump ? 'pg_dump ' + st.tools.versions.pg_dump : 'missing'),
          h('div', { class: 's' }, st.tools.ok ? 'ready' : 'see note above'))),
      jobBox,
      h('div', { class: 'section' },
        h('div', { class: 'section-head' }, h('h3', null, 'Backups on this server'), h('span', { class: 'count' }, files.length)),
        files.length ? h('div', { style: { overflowX: 'auto' } }, h('table', { class: 'list' },
          h('thead', null, h('tr', null, ['Backup', 'Type', 'Contents', 'Size', 'Created', ''].map(x => h('th', null, x)))),
          h('tbody', null, files.map(f => {
            const [label, cls] = KIND_LABEL[f.kind] || KIND_LABEL.unknown;
            return h('tr', null,
              h('td', null, h('span', { class: 'mono', style: { fontSize: '12.5px' } }, f.name), f.error && h('div', { class: 'faint', style: { fontSize: '12px' } }, f.error)),
              h('td', null, h('span', { class: 'badge ' + cls }, label)),
              h('td', { class: 'muted', style: { fontSize: '12.5px', maxWidth: '340px' } },
                f.kind === 'bundle' ? [
                  h('div', null, `${f.databases.length} database${f.databases.length === 1 ? '' : 's'}: `, f.databases.join(', ')),
                  h('div', { class: 'faint' }, (f.includes_roles ? 'roles' + (f.includes_passwords ? ' + passwords' : ' (no passwords)') : 'no roles') + ' · from PostgreSQL ' + f.source.server_major),
                ] : f.kind === 'unknown' ? '—' : 'one database'),
              h('td', { class: 'num nowrap' }, fmtBytes(f.size_bytes)),
              h('td', { class: 'nowrap muted' }, since(f.created_at || f.modified) + ' ago'),
              h('td', { class: 'actions' },
                f.kind !== 'unknown' && btn('Restore…', () => restoreModal(f.name), { class: 'sm primary', disabled: running }),
                btn('', () => download(`/api/backup/files/${enc(f.name)}`), { class: 'sm icon', icon: 'download', title: 'Download' }),
                btn('', async () => {
                  if (!await confirmDanger({ title: 'Delete this backup?', message: f.name, confirmLabel: 'Delete' })) return;
                  try { await DEL(`/api/backup/files/${enc(f.name)}`); toast('Deleted'); route(); } catch (e) { toastErr(e); }
                }, { class: 'sm icon danger', icon: 'trash', title: 'Delete' })));
          })))) :
          h('div', { class: 'empty' }, 'No backups yet. Create a full backup, or upload one from another server.')),
      h('div', { class: 'section' },
        h('div', { class: 'section-head' }, h('h3', null, 'Moving to a new server')),
        h('div', { class: 'section-body', style: { lineHeight: 1.7 } },
          h('ol', { style: { margin: 0, paddingLeft: '20px' } },
            h('li', null, 'Here: ', h('strong', null, 'Create full backup'), ', then download it (', icon('download', 13), ').'),
            h('li', null, 'On the new server: deploy this panel pointed at an empty Postgres, sign in, open ', h('strong', null, 'Backup & restore'), '.'),
            h('li', null, h('strong', null, 'Upload backup'), ' → ', h('strong', null, 'Restore'), '. Roles, passwords, databases, owners, grants, settings and API keys come back as they were.')),
          h('p', { class: 'faint', style: { margin: '8px 0 0', fontSize: '12.5px' } }, 'Full backups contain password hashes and all your data: store and share them like secrets.'))),
    ],
  });
}

function jobPanel(job, seq) {
  const bar = h('i', { style: { width: '0%' } });
  const status = h('span', { class: 'badge' });
  const step = h('span', { class: 'muted' });
  const logEl = h('pre', { class: 'code', style: { maxHeight: '260px', fontSize: '12px', whiteSpace: 'pre-wrap' } });
  const extra = h('div', { class: 'row', style: { gap: '8px' } });
  const box = h('div', { class: 'section' },
    h('div', { class: 'section-head' }, h('h3', null, job.title), status, step),
    h('div', { class: 'section-body stack', style: { gap: '10px' } }, h('div', { class: 'bar', style: { marginTop: 0 } }, bar), logEl, extra));
  let offset = 0;
  const lines = [];
  const paint = (j) => {
    const pct = j.total ? Math.round((j.done / j.total) * 100) : (j.status === 'done' ? 100 : 5);
    bar.style.width = (j.status === 'done' ? 100 : pct) + '%';
    bar.style.background = j.status === 'failed' ? 'var(--danger)' : j.status === 'done' ? 'var(--ok)' : '';
    status.className = 'badge ' + ({ done: 'ok', failed: 'danger', running: 'accent' }[j.status] || '');
    status.textContent = j.status + (j.warnings ? ` · ${j.warnings} warning${j.warnings === 1 ? '' : 's'}` : '');
    step.textContent = j.step || (j.finished ? 'finished ' + since(new Date(j.finished * 1000).toISOString()) + ' ago' : '');
    lines.push(...j.log);
    offset = j.log_offset;
    const nearBottom = logEl.scrollTop + logEl.clientHeight >= logEl.scrollHeight - 30;
    logEl.textContent = lines.join('\n') || 'Starting…';
    if (nearBottom) logEl.scrollTop = logEl.scrollHeight;
    clear(extra);
    if (j.status === 'done' && j.result && j.result.file) {
      extra.appendChild(btn('Download ' + j.result.file, () => download(`/api/backup/files/${enc(j.result.file)}`), { class: 'sm primary', icon: 'download' }));
    }
  };
  // first paint: fetch whole log
  (async () => {
    try {
      let j = await GET(`/api/backup/jobs/${enc(job.id)}?since=0`);
      paint(j);
      while ((j.status === 'running' || j.status === 'queued') && seq === renderSeq) {
        await new Promise(res => setTimeout(res, 900));
        if (seq !== renderSeq) return;
        j = await GET(`/api/backup/jobs/${enc(job.id)}?since=${offset}`);
        paint(j);
        if (j.status === 'done' || j.status === 'failed') {
          toast(j.status === 'done' ? `${j.title}: done` + (j.warnings ? ` with ${j.warnings} warning(s)` : '') : `${j.title} failed`, j.status === 'done' ? 'ok' : 'error');
          setTimeout(() => { if (seq === renderSeq) route(); }, 600);
          if (j.kind === 'restore') { loadDatabases().then(() => loadSchemaAndTables()).then(() => renderSidebar()).catch(() => {}); }
        }
      }
    } catch (e) {
      if (e.status === 404) { logEl.textContent = 'This job is no longer available (the server restarted).'; return; }
      toastErr(e);
    }
  })();
  return box;
}

async function fullBackupModal(st) {
  const dbs = (await GET('/api/databases')).filter(d => d.can_connect);
  const boxes = dbs.map(d => {
    const c = checkbox(d.name, true);
    c.dataset.db = d.name;
    return h('div', { class: 'row', style: { justifyContent: 'space-between', gap: '8px' } }, c,
      h('span', { class: 'faint', style: { fontSize: '12px' } },
        d.name === 'postgres' ? 'panel settings & API keys · ' : '', fmtBytes(d.size_bytes)));
  });
  const roles = checkbox('Roles / users, memberships and role settings', true);
  const pw = checkbox('Include password hashes (so users keep their passwords)', st.server.superuser, { disabled: !st.server.superuser });
  roles.input.addEventListener('change', () => { pw.input.disabled = !roles.input.checked || !st.server.superuser; });
  const total = dbs.reduce((a, d) => a + (d.size_bytes || 0), 0);
  const res = await modal({
    title: 'Create full backup',
    size: 'mid',
    body: [
      field('Databases', h('div', { class: 'stack', style: { gap: '6px' } },
        h('div', null, btn('All', () => boxes.forEach(b => { b.firstChild.input.checked = true; }), { class: 'sm ghost' }),
          btn('None', () => boxes.forEach(b => { b.firstChild.input.checked = false; }), { class: 'sm ghost' })),
        boxes)),
      roles, pw,
      !st.server.superuser && h('div', { class: 'callout' }, 'The panel is not connected as a superuser, so password hashes can\'t be read. Users will need new passwords after a restore.'),
      h('p', { class: 'faint', style: { margin: 0, fontSize: '12.5px' } },
        `About ${fmtBytes(total)} of data, usually much smaller compressed. Free space: ${fmtBytes(st.disk.free_bytes)}. The backup runs in the background; you can leave this page.`),
    ],
    actions: [{ label: 'Cancel' }, {
      label: 'Start backup', primary: true, onClick: () => {
        const selected = boxes.filter(b => b.firstChild.input.checked).map(b => b.firstChild.dataset.db);
        if (!selected.length) { toast('Pick at least one database', 'error'); return false; }
        return POST('/api/backup/full', {
          databases: selected.length === dbs.length ? null : selected,
          include_roles: roles.input.checked, include_passwords: pw.input.checked && !pw.input.disabled,
        });
      },
    }],
  });
  if (res) { toast('Backup started'); route(); }
}

function uploadBackup(st) {
  const input = h('input', { type: 'file', accept: '.tar,.dump,.backup,.sql', style: { display: 'none' } });
  document.body.appendChild(input);
  input.addEventListener('change', async () => {
    const file = input.files[0];
    input.remove();
    if (!file) return;
    if (file.size > st.upload_max_bytes) { toast(`File is larger than the ${fmtBytes(st.upload_max_bytes)} upload limit`, 'error'); return; }
    const bar = h('i', { style: { width: '0%' } });
    const label = h('div', { class: 'muted' }, 'Starting…');
    let xhr;
    const closeP = modal({
      title: `Uploading ${file.name}`, dismissable: false,
      body: [h('div', { class: 'bar' }, bar), label],
      actions: [{ label: 'Cancel', onClick: () => { xhr && xhr.abort(); } }],
    });
    try {
      const result = await new Promise((resolve, reject) => {
        xhr = new XMLHttpRequest();
        xhr.open('POST', `/api/backup/upload?filename=${enc(file.name)}`);
        xhr.setRequestHeader('X-CP-Client', 'panel');
        xhr.setRequestHeader('Content-Type', 'application/octet-stream');
        const t0 = Date.now();
        xhr.upload.onprogress = (e) => {
          if (!e.lengthComputable) return;
          bar.style.width = Math.round((e.loaded / e.total) * 100) + '%';
          const rate = e.loaded / Math.max(1, (Date.now() - t0) / 1000);
          label.textContent = `${fmtBytes(e.loaded)} of ${fmtBytes(e.total)} · ${fmtBytes(rate)}/s`;
        };
        xhr.upload.onload = () => { label.textContent = 'Checking the file…'; };
        xhr.onload = () => {
          let data = null;
          try { data = JSON.parse(xhr.responseText); } catch { data = { detail: xhr.responseText.slice(0, 300) || `HTTP ${xhr.status}` }; }
          if (xhr.status >= 200 && xhr.status < 300) resolve(data); else reject(new ApiError(xhr.status, data));
        };
        xhr.onerror = () => reject(new Error('Upload failed (network error). If the file is big, check nginx client_max_body_size for /api/backup/upload.'));
        xhr.onabort = () => reject(new Error('Upload cancelled'));
        xhr.send(file);
      });
      closeP.close();
      toast('Uploaded');
      route();
      restoreModal(result.name, result);
    } catch (e) {
      closeP.close();
      if (e.message !== 'Upload cancelled') toastErr(e, 'Upload failed');
    }
  });
  input.click();
}

async function restoreModal(name, preloaded) {
  let info;
  try { info = preloaded || await GET(`/api/backup/files/${enc(name)}/inspect`); } catch (e) { toastErr(e); return; }
  const t = info.target;
  const toolsMissing = !t.tools.ok && /Missing/.test(t.tools.message);
  if (info.kind === 'bundle') return restoreBundleModal(info, toolsMissing);
  return restoreFileModal(info, toolsMissing);
}

async function restoreBundleModal(info, toolsMissing) {
  const m = info.manifest;
  const t = info.target;
  const roles = info.roles || [];
  const newRoles = roles.filter(r => !r.exists && !r.skipped);
  const existingRoles = roles.filter(r => r.exists && !r.skipped);
  const skippedRoles = roles.filter(r => r.skipped);
  const md5 = roles.filter(r => r.md5_password && !r.skipped);

  const doRoles = checkbox(`Recreate roles / users (${newRoles.length} new` + (existingRoles.length ? `, ${existingRoles.length} already here` : '') + ')', roles.length > 0, { disabled: !roles.length });
  const doPw = checkbox('Restore their passwords', m.includes_passwords, { disabled: !m.includes_passwords });
  const updRoles = checkbox(`Also update the ${existingRoles.length} role(s) that already exist here (attributes${m.includes_passwords ? ' and passwords' : ''})`, false, { disabled: !existingRoles.length });

  const rows = info.databases.map(d => {
    const opts = d.exists
      ? [['skip', 'Skip (keep what is here)'], ['merge', 'Merge: overwrite objects from the backup'], ...(d.protected ? [] : [['replace', 'Replace: drop and restore']])]
      : [['create', 'Create'], ['skip', 'Skip']];
    const def = d.exists ? (d.name === 'postgres' ? 'merge' : 'skip') : 'create';
    const sel = select(opts, def, { class: 'input sm' });
    const target = h('input', { class: 'input sm mono', value: d.name, title: 'Restore under a different name', style: { width: '150px' } });
    const syncT = () => { target.disabled = sel.value !== 'create'; };
    sel.addEventListener('change', syncT); syncT();
    const tr = h('tr', null,
      h('td', null, h('strong', null, d.name), d.name === 'postgres' && h('div', { class: 'faint', style: { fontSize: '11.5px' } }, 'panel settings & API keys'),
        d.comment && h('div', { class: 'faint', style: { fontSize: '11.5px' } }, d.comment)),
      h('td', { class: 'muted' }, d.owner),
      h('td', { class: 'num nowrap' }, fmtBytes(d.size_bytes)),
      h('td', null, d.exists ? h('span', { class: 'badge warn' }, d.protected ? 'exists · protected' : 'exists here') : h('span', { class: 'badge ok' }, 'new')),
      h('td', null, sel), h('td', null, target));
    return { d, sel, target, tr };
  });

  const res = await modal({
    title: 'Restore full backup',
    size: 'wide',
    body: [
      toolsMissing && h('div', { class: 'callout' }, info.target.tools.message),
      h('div', { class: 'callout info' },
        `Backup from PostgreSQL ${m.source.server_major} (${m.source.user}), made ${since(m.created_at)} ago → into PostgreSQL ${t.server_major} as ${t.user}` + (t.superuser ? ' (superuser)' : '') + '.'),
      t.server_major < m.source.server_major && h('div', { class: 'callout' }, `This server runs an older PostgreSQL (${t.server_major}) than the backup (${m.source.server_major}). Restoring to an older version can fail for newer features.`),
      h('div', { class: 'stack', style: { gap: '6px' } },
        h('h3', null, 'Roles'),
        roles.length ? [doRoles, h('div', { style: { paddingLeft: '22px' }, class: 'stack' }, doPw, updRoles)] : h('div', { class: 'muted' }, 'This backup has no roles.'),
        skippedRoles.length > 0 && h('div', { class: 'faint', style: { fontSize: '12.5px' } }, `Left untouched: ${skippedRoles.map(r => r.name).join(', ')} (the admin role on this server).`),
        md5.length > 0 && h('div', { class: 'faint', style: { fontSize: '12.5px' } }, `${md5.length} role(s) use old MD5 password hashes. They log in only if this server's pg_hba.conf allows md5.`)),
      h('div', { class: 'stack', style: { gap: '6px' } },
        h('h3', null, 'Databases'),
        h('div', { style: { overflowX: 'auto' } }, h('table', { class: 'list' },
          h('thead', null, h('tr', null, ['Database', 'Owner', 'Size', 'Here', 'Action', 'Restore as'].map(x => h('th', null, x)))),
          h('tbody', null, rows.map(x => x.tr))))),
      h('p', { class: 'faint', style: { margin: 0, fontSize: '12.5px' } }, 'Runs in the background with a live log. Errors on single objects are logged as warnings and the restore keeps going.'),
    ],
    actions: [{ label: 'Cancel' }, {
      label: 'Start restore', primary: true, onClick: async () => {
        if (toolsMissing) { toast(info.target.tools.message, 'error'); return false; }
        const dbs = rows.map(x => ({ name: x.d.name, action: x.sel.value, target: x.sel.value === 'create' ? x.target.value.trim() : null }));
        const active = dbs.filter(d => d.action !== 'skip');
        if (!active.length && !doRoles.input.checked) { toast('Nothing selected', 'error'); return false; }
        const risky = active.filter(d => d.action === 'replace' || d.action === 'merge');
        if (risky.length) {
          const ok = await confirmDanger({
            title: 'Overwrite existing databases?',
            message: risky.map(d => `${d.name}: ${d.action === 'replace' ? 'dropped and restored' : 'objects from the backup overwrite what is here'}`).join(' · '),
            typeToConfirm: 'RESTORE', confirmLabel: 'Restore',
          });
          if (!ok) return false;
        }
        return POST('/api/backup/restore', {
          file: info.name, roles: doRoles.input.checked, passwords: doPw.input.checked,
          update_existing_roles: updRoles.input.checked, databases: dbs,
        });
      },
    }],
  });
  if (res) { toast('Restore started'); go(link.backups()); }
}

async function restoreFileModal(info, toolsMissing) {
  const target = h('input', { class: 'input mono', value: info.suggested_database || '' });
  const action = select([['create', 'Create a new database'], ['replace', 'Replace: drop it first if it exists'], ['merge', 'Merge into the existing database']], 'create');
  const note = h('div', { class: 'faint', style: { fontSize: '12.5px' } });
  const sync = () => {
    const ex = (info.exists || []).includes(target.value.trim());
    note.textContent = ex ? `“${target.value.trim()}” already exists here.` : 'A new database will be created.';
    if (ex && action.value === 'create') action.value = 'merge';
  };
  target.addEventListener('input', sync); sync();
  const res = await modal({
    title: `Restore ${info.kind === 'dump' ? 'database dump' : 'SQL file'}`,
    body: [
      toolsMissing && h('div', { class: 'callout' }, info.target.tools.message),
      h('p', { class: 'mono', style: { margin: 0, fontSize: '12.5px' } }, info.name, ' · ', fmtBytes(info.size_bytes)),
      field('Restore into database', target), note, field('If it exists', action),
      info.kind === 'sql' && h('p', { class: 'faint', style: { margin: 0, fontSize: '12.5px' } }, 'The SQL file runs with psql; statements that fail are logged and skipped.'),
    ],
    actions: [{ label: 'Cancel' }, {
      label: 'Start restore', primary: true, onClick: async () => {
        if (toolsMissing) { toast(info.target.tools.message, 'error'); return false; }
        const tname = target.value.trim();
        if (!tname) { toast('Enter a database name', 'error'); return false; }
        if (action.value === 'replace' && (info.exists || []).includes(tname)) {
          if (!await confirmDanger({ title: `Drop and restore ${tname}?`, message: 'Everything currently in it is deleted first.', typeToConfirm: tname, confirmLabel: 'Replace' })) return false;
        }
        return POST('/api/backup/restore', { file: info.name, target: tname, action: action.value });
      },
    }],
  });
  if (res) { toast('Restore started'); go(link.backups()); }
}

// ============================================================ app keys (external API access)
const ACCESS_INFO = {
  read: ['Read only', 'SELECT on every table in the chosen schemas'],
  write: ['Read & write', 'SELECT, INSERT, UPDATE, DELETE — no schema changes'],
  full: ['Full', 'Everything incl. CREATE / ALTER / DROP tables in the chosen schemas'],
};
function apiBase() { return location.origin; }

async function viewKeys(r, seq) {
  setMain({ title: 'API keys', body: null, loading: true });
  const showRevoked = store.get('keysShowRevoked', false);
  const keys = await GET(`/api/keys${qs({ include_revoked: showRevoked ? 'true' : '' })}`);
  if (seq !== renderSeq) return;
  const statusBadge = (k) => h('span', { class: 'badge ' + ({ active: 'ok', expired: 'warn', revoked: 'danger' }[k.status] || '') }, k.status);
  const accessBadge = (a) => h('span', { class: 'badge ' + (a === 'full' ? 'warn' : a === 'write' ? 'accent' : '') }, ACCESS_INFO[a][0]);
  setMain({
    title: 'API keys',
    sub: 'Scoped keys for external apps. Each key is its own restricted Postgres role on one database.',
    actions: [btn('Refresh', () => route(), { icon: 'refresh' }), btn('New API key', () => newKeyModal(), { class: 'primary', icon: 'plus' })],
    body: [
      h('div', { class: 'callout info', style: { marginBottom: '16px' } },
        'API keys let external apps query one database over HTTPS: ',
        h('code', null, `POST ${apiBase()}/v1/query`), '. Each key runs as its own restricted Postgres role, so it can only reach the database and schemas you pick.'),
      h('div', { class: 'section' },
        h('div', { class: 'section-head' }, h('h3', null, 'Keys'), h('span', { class: 'count' }, keys.length),
          h('div', { class: 'actions' }, checkbox('Show revoked', showRevoked, { onchange: (e) => { store.set('keysShowRevoked', e.target.checked); route(); } }))),
        keys.length ? h('div', { style: { overflowX: 'auto' } }, h('table', { class: 'list' },
          h('thead', null, h('tr', null, ['Name', 'Database', 'Access', 'Limits', 'Last used', 'Status', ''].map(x => h('th', null, x)))),
          h('tbody', null, keys.map(k => h('tr', null,
            h('td', null, h('strong', null, k.name), h('div', { class: 'mono faint', style: { fontSize: '11.5px' } }, k.prefix)),
            h('td', null, h('a', { href: link.db(k.database) }, k.database), h('div', { class: 'faint', style: { fontSize: '12px' } }, (k.schemas || []).join(', '))),
            h('td', null, accessBadge(k.access)),
            h('td', { class: 'muted', style: { fontSize: '12.5px' } },
              h('div', null, k.rate_limit_per_min ? `${fmtNum(k.rate_limit_per_min)}/min` : 'no rate limit', ' · ', `${fmtNum(k.max_rows)} rows`),
              h('div', null, k.allowed_ips.length ? 'IPs: ' + k.allowed_ips.join(', ') : 'any IP'),
              k.expires_at && h('div', null, 'expires ' + new Date(k.expires_at).toLocaleDateString())),
            h('td', { class: 'muted nowrap', style: { fontSize: '12.5px' } }, k.last_used_at ? since(k.last_used_at) + ' ago' : 'never',
              k.last_used_ip && h('div', { class: 'mono faint' }, k.last_used_ip), k.use_count ? h('div', { class: 'faint' }, fmtNum(k.use_count) + (k.use_count === 1 ? ' call' : ' calls')) : null),
            h('td', null, statusBadge(k)),
            h('td', { class: 'actions' }, k.status !== 'revoked' && [
              btn('Usage', () => keyUsageModal(k, null), { class: 'sm' }),
              btn('Edit', () => editKeyModal(k), { class: 'sm' }),
              btn('Re-sync', async () => {
                try { const res = await POST(`/api/keys/${enc(k.id)}/sync`); toast(res.warnings.length ? 'Synced with warnings:\n' + res.warnings.join('\n') : 'Grants re-applied'); } catch (e) { toastErr(e); }
              }, { class: 'sm', title: 'Re-apply permissions, e.g. after creating tables as another user' }),
              btn('Revoke', async () => {
                if (!await confirmDanger({ title: `Revoke "${k.name}"?`, message: 'Apps using this key stop working immediately. Tables it created are handed to the database owner.', confirmLabel: 'Revoke key' })) return;
                try { const res = await DEL(`/api/keys/${enc(k.id)}`); toast('Key revoked' + (res.warnings.length ? '\n' + res.warnings.join('\n') : '')); route(); } catch (e) { toastErr(e); }
              }, { class: 'sm danger' })])))))) :
          h('div', { class: 'empty' }, 'No keys yet. ', h('a', { href: '#', onclick: (e) => { e.preventDefault(); newKeyModal(); } }, 'Create one'), ' for an app that needs the database from outside this server.')),
      h('div', { class: 'section' },
        h('div', { class: 'section-head' }, h('h3', null, 'Connect your app'),
          h('div', { class: 'desc' }, 'Swap YOUR_API_KEY for a key from above. Ready-to-paste clients for curl, Python and Node.')),
        h('div', { class: 'section-body stack', style: { gap: '10px' } }, apiGuide(null, null))),
      h('p', { class: 'faint', style: { fontSize: '12.5px' } }, 'Admin keys from API_KEYS in .env still work on /api/* (full control). Give apps these scoped keys instead. Interactive docs: ', h('a', { href: '/api/docs#/data%20API%20(app%20keys)', target: '_blank' }, '/api/docs')),
    ],
  });
}

async function newKeyModal() {
  const name = h('input', { class: 'input', placeholder: 'e.g. saathi-mobile-backend', autocomplete: 'off' });
  const dbSel = select(state.dbs.filter(d => d.can_connect && !['template0', 'template1'].includes(d.name)).map(d => d.name), state.db);
  const access = select(Object.entries(ACCESS_INFO).map(([k, v]) => [k, `${v[0]} — ${v[1]}`]), 'read');
  const schemaBox = h('div', { class: 'row', style: { gap: '6px 14px' } });
  const loadSchemas = async () => {
    clear(schemaBox).appendChild(h('span', { class: 'faint' }, 'Loading…'));
    try {
      const ss = await GET(`/api/db/${enc(dbSel.value)}/schemas`);
      clear(schemaBox); append(schemaBox, ss.map(s => checkbox(s.name, s.name === 'public')));
    } catch (e) { clear(schemaBox); toastErr(e); }
  };
  dbSel.addEventListener('change', loadSchemas); loadSchemas();
  const ips = h('input', { class: 'input mono', placeholder: 'any — or e.g. 203.0.113.7, 10.0.0.0/8' });
  const expires = select([['', 'Never'], ['30', '30 days'], ['90', '90 days'], ['180', '180 days'], ['365', '1 year']], '');
  const rate = h('input', { class: 'input', type: 'number', value: '600', min: '0' });
  const maxRows = h('input', { class: 'input', type: 'number', value: '10000', min: '1', max: '100000' });
  const res = await modal({
    title: 'New API key',
    drawer: true,
    body: [
      h('div', { class: 'grid2' }, field('Name', name, 'which app uses it'), field('Database', dbSel)),
      field('Access', access),
      field('Schemas', schemaBox),
      field('Allowed IPs', ips, 'optional, comma-separated IPs or CIDR ranges'),
      h('div', { class: 'grid2' }, field('Expires', expires), field('Requests per minute', rate, '0 = unlimited')),
      field('Max rows per query', maxRows),
    ],
    actions: [{ label: 'Cancel' }, {
      label: 'Create key', primary: true, onClick: () => POST('/api/keys', {
        name: name.value.trim(), database: dbSel.value, access: access.value,
        schemas: [...schemaBox.querySelectorAll('label.check')].filter(l => l.input && l.input.checked).map(l => l.textContent),
        allowed_ips: ips.value.split(',').map(x => x.trim()).filter(Boolean),
        expires_in_days: expires.value ? Number(expires.value) : null,
        rate_limit_per_min: Number(rate.value || 0), max_rows: Number(maxRows.value || 10000),
      }),
    }],
  });
  if (!res) return;
  if (res.warnings && res.warnings.length) toast(res.warnings.join('\n'), 'error', 'Created, with warnings');
  await keyUsageModal(res, res.key);
  route();
}

// Ready-to-paste client code for the /v1 data API, shown on the API keys page and in each key's Usage dialog.
function apiSamples(key, base) {
  const curl = `# What this key can do
curl ${base}/v1/me -H "Authorization: Bearer ${key}"

# Tables and columns it can use
curl ${base}/v1/tables -H "Authorization: Bearer ${key}"

# One statement, values passed as $1, $2…
curl -X POST ${base}/v1/query \\
  -H "Authorization: Bearer ${key}" \\
  -H "Content-Type: application/json" \\
  -d '{"sql": "SELECT * FROM users WHERE id = $1", "params": [1]}'

# Several statements, all-or-nothing
curl -X POST ${base}/v1/transaction \\
  -H "Authorization: Bearer ${key}" \\
  -H "Content-Type: application/json" \\
  -d '{"statements": [
        {"sql": "UPDATE accounts SET balance = balance - $1 WHERE id = $2", "params": [50, 1]},
        {"sql": "UPDATE accounts SET balance = balance + $1 WHERE id = $2", "params": [50, 2]}
      ]}'`;

  const py = `# pip install requests
import os
import requests

API = "${base}/v1"
KEY = os.environ.get("CENTRAL_PG_KEY", "${key}")  # keep the key in an env var


class DBError(Exception):
    def __init__(self, status, detail):
        self.status = status
        self.detail = detail if isinstance(detail, dict) else {"error": detail}
        super().__init__(f"{status}: {self.detail.get('error')}")


class CentralPG:
    def __init__(self, api=API, key=KEY, timeout=30):
        self.api = api.rstrip("/")
        self.s = requests.Session()
        self.s.headers["Authorization"] = f"Bearer {key}"
        self.timeout = timeout

    def _call(self, method, path, body=None):
        r = self.s.request(method, self.api + path, json=body, timeout=self.timeout)
        data = r.json() if r.content else {}
        if not r.ok:
            raise DBError(r.status_code, data.get("detail", r.text))
        return data

    def query(self, sql, *params, limit=None):
        """Rows as a list of dicts."""
        return self._call("POST", "/query", {"sql": sql, "params": list(params), "limit": limit})["rows"]

    def one(self, sql, *params):
        """First row or None."""
        rows = self.query(sql, *params, limit=1)
        return rows[0] if rows else None

    def execute(self, sql, *params):
        """INSERT / UPDATE / DELETE: number of rows affected."""
        return self._call("POST", "/query", {"sql": sql, "params": list(params)})["rows_affected"]

    def transaction(self, *statements):
        """statements: (sql, [params]) tuples. All succeed or none apply."""
        body = {"statements": [{"sql": s, "params": list(p)} for s, p in statements]}
        return self._call("POST", "/transaction", body)["results"]

    def tables(self):
        return self._call("GET", "/tables")

    def me(self):
        return self._call("GET", "/me")


db = CentralPG()

users = db.query("SELECT id, email FROM users WHERE created_at > $1", "2026-01-01")
user = db.one("SELECT * FROM users WHERE id = $1", 42)
new = db.one("INSERT INTO users (email) VALUES ($1) RETURNING id", "a@x.com")
n = db.execute("UPDATE users SET active = $1 WHERE id = $2", False, 42)
db.transaction(
    ("UPDATE accounts SET balance = balance - $1 WHERE id = $2", [50, 1]),
    ("UPDATE accounts SET balance = balance + $1 WHERE id = $2", [50, 2]),
)

try:
    db.query("SELECT * FROM missing_table")
except DBError as e:
    print(e.status, e.detail.get("pg_code"), e.detail.get("error"))`;

  const js = `// Node 18+ (built-in fetch). Works in Deno / Bun / edge runtimes too.
const API = "${base}/v1";
const KEY = process.env.CENTRAL_PG_KEY ?? "${key}"; // keep the key on the server, never in browser code

class DBError extends Error {
  constructor(status, detail) {
    const d = typeof detail === "object" && detail ? detail : { error: detail };
    super(\`\${status}: \${d.error}\`);
    this.status = status;
    this.detail = d;
  }
}

async function call(method, path, body) {
  const res = await fetch(API + path, {
    method,
    headers: { Authorization: \`Bearer \${KEY}\`, "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new DBError(res.status, data.detail ?? res.statusText);
  return data;
}

export const db = {
  /** Rows as an array of objects. */
  query: async (sql, params = [], limit) => (await call("POST", "/query", { sql, params, limit })).rows,
  /** First row or null. */
  one: async (sql, params = []) => (await db.query(sql, params, 1))[0] ?? null,
  /** INSERT / UPDATE / DELETE: number of rows affected. */
  execute: async (sql, params = []) => (await call("POST", "/query", { sql, params })).rows_affected,
  /** [[sql, params], …]: all succeed or none apply. */
  transaction: async (statements) =>
    (await call("POST", "/transaction", { statements: statements.map(([sql, params = []]) => ({ sql, params })) })).results,
  tables: () => call("GET", "/tables"),
  me: () => call("GET", "/me"),
};

// usage
const users = await db.query("SELECT id, email FROM users WHERE created_at > $1", ["2026-01-01"]);
const user = await db.one("SELECT * FROM users WHERE id = $1", [42]);
const created = await db.one("INSERT INTO users (email) VALUES ($1) RETURNING id", ["a@x.com"]);
const n = await db.execute("UPDATE users SET active = $1 WHERE id = $2", [false, 42]);
await db.transaction([
  ["UPDATE accounts SET balance = balance - $1 WHERE id = $2", [50, 1]],
  ["UPDATE accounts SET balance = balance + $1 WHERE id = $2", [50, 2]],
]);

try {
  await db.query("SELECT * FROM missing_table");
} catch (e) {
  if (e instanceof DBError) console.error(e.status, e.detail.pg_code, e.detail.error);
}`;

  const responses = `POST /v1/query  →  200
{
  "command": "SELECT",
  "columns": [{"name": "id", "type": "int4"}, {"name": "email", "type": "text"}],
  "rows": [{"id": 1, "email": "a@x.com"}],
  "row_count": 1,
  "rows_affected": null,        // set for INSERT / UPDATE / DELETE
  "truncated": false,           // true when more rows existed than limit / max_rows
  "duration_ms": 1.84
}

POST /v1/transaction  →  200
{ "results": [ …one /v1/query result per statement… ], "committed": true }

Errors  →  4xx, body: { "detail": … }
  400  bad SQL or parameter   {"detail": {"error": "relation \\"x\\" does not exist", "pg_code": "42P01", "statement": 0}}
  401  missing / wrong / revoked / expired key
  403  IP not allowed, or the key's role lacks the privilege (pg_code 42501)
  429  rate limit reached; wait for the Retry-After header

Notes
  • Values always go in "params" ($1, $2…), never pasted into the SQL string.
  • One statement per /v1/query. Use /v1/transaction for several.
  • Read-only keys run inside a READ ONLY transaction.
  • Dates/timestamps come back as ISO-8601 strings; numeric, uuid and json/jsonb as strings
    (parse json columns yourself, e.g. json.loads / JSON.parse).`;

  return { curl, Python: py, 'Node / JS': js, Responses: responses };
}

function apiGuide(k, fullKey) {
  const samples = apiSamples(fullKey || 'YOUR_API_KEY', apiBase());
  const seg = h('div', { class: 'seg' });
  const tabsEl = h('div', { class: 'row', style: { gap: '8px' } }, seg, h('span', { class: 'grow' }), btn('Copy', () => copyText(samples[current]), { class: 'sm', icon: 'copy' }));
  const pre = h('pre', { class: 'code', style: { maxHeight: '380px' } });
  let current = 'Python';
  const draw = () => {
    clear(seg);
    for (const name of Object.keys(samples)) seg.appendChild(h('button', { type: 'button', class: name === current ? 'active' : '', onclick: () => { current = name; draw(); } }, name));
    pre.textContent = samples[current];
  };
  draw();
  return [
    k && h('p', { style: { margin: 0 } }, 'Database ', h('code', null, k.database), ' · access ', h('strong', null, ACCESS_INFO[k.access][0]), ' · schemas ', h('code', null, (k.schemas || []).join(', '))),
    tabsEl, pre,
    h('div', { class: 'faint', style: { fontSize: '12.5px', lineHeight: 1.6 } },
      h('div', null, h('code', null, 'POST /v1/query'), ' — one statement, ', h('code', null, '$1, $2'), ' placeholders + ', h('code', null, 'params'), '. Optional ', h('code', null, 'limit'), ', ', h('code', null, '"row_format": "arrays"'), '.'),
      h('div', null, h('code', null, 'POST /v1/transaction'), ' — ', h('code', null, '{"statements": [{"sql": …, "params": […]}, …]}'), ', all-or-nothing.'),
      h('div', null, h('code', null, 'GET /v1/tables'), ' — tables and columns the key can use · ', h('code', null, 'GET /v1/me'), ' — key info.'),
      h('div', null, 'Auth: ', h('code', null, 'Authorization: Bearer cpk_…'), ' or ', h('code', null, 'X-API-Key: cpk_…'), '. Always pass user input through ', h('code', null, 'params'), ', never by building SQL strings.')),
  ];
}

function keyUsageModal(k, fullKey) {
  return modal({
    title: fullKey ? 'API key created' : `Using "${k.name}"`,
    size: 'wide',
    dismissable: !fullKey,
    body: [
      fullKey && field('Your API key', secretBox(fullKey)),
      fullKey && h('div', { class: 'callout' }, 'Copy it now. Only a hash is stored, so it can never be shown again. Lost it? Revoke and create a new one.'),
      ...apiGuide(k, fullKey),
    ],
    actions: [{ label: fullKey ? "I've saved it" : 'Close', primary: true }],
  });
}

async function editKeyModal(k) {
  const name = h('input', { class: 'input', value: k.name });
  const ips = h('input', { class: 'input mono', value: k.allowed_ips.join(', '), placeholder: 'any' });
  const rate = h('input', { class: 'input', type: 'number', value: String(k.rate_limit_per_min), min: '0' });
  const maxRows = h('input', { class: 'input', type: 'number', value: String(k.max_rows), min: '1' });
  const expires = select([['', 'Keep current'], ['0', 'Never'], ['30', '30 days from now'], ['90', '90 days from now'], ['365', '1 year from now']], '');
  const res = await modal({
    title: `Edit key "${k.name}"`,
    drawer: true,
    body: [field('Name', name), field('Allowed IPs', ips, 'comma-separated; empty = any'),
      h('div', { class: 'grid2' }, field('Requests per minute', rate), field('Max rows per query', maxRows)),
      field('Expiry', expires, k.expires_at ? 'currently ' + new Date(k.expires_at).toLocaleDateString() : 'currently never'),
      h('p', { class: 'faint', style: { margin: 0, fontSize: '12.5px' } }, 'Database and access level are fixed. Create a new key to change them.')],
    actions: [{ label: 'Cancel' }, {
      label: 'Save', primary: true, onClick: () => PATCH(`/api/keys/${enc(k.id)}`, {
        name: name.value.trim() || null,
        allowed_ips: ips.value.split(',').map(x => x.trim()).filter(Boolean),
        rate_limit_per_min: Number(rate.value || 0), max_rows: Number(maxRows.value || 1),
        expires_in_days: expires.value === '' ? null : Number(expires.value),
      }),
    }],
  });
  if (res) { toast('Key updated'); route(); }
}

// ============================================================ Central Redis
const R_TABS = [['browser', 'Browser'], ['console', 'Console'], ['keys', 'API keys'], ['usage', 'Usage'], ['settings', 'Settings']];
const R_TYPES = { string: 'STR', list: 'LST', hash: 'HSH', set: 'SET', zset: 'ZST', stream: 'STM' };
const rPath = (id) => `/api/redis/projects/${enc(id)}`;

function fmtTtl(s) {
  if (s == null) return '—';
  if (s < 60) return s + 's';
  if (s < 3600) return Math.floor(s / 60) + 'm ' + (s % 60) + 's';
  if (s < 86400) return Math.floor(s / 3600) + 'h ' + Math.floor((s % 3600) / 60) + 'm';
  return Math.floor(s / 86400) + 'd ' + Math.floor((s % 86400) / 3600) + 'h';
}
function fmtUptime(sec) { return since(new Date(Date.now() - sec * 1000).toISOString()); }
function typeBadge(t) { return h('span', { class: 'badge mono', title: t }, R_TYPES[t] || String(t || '—').slice(0, 3).toUpperCase()); }
function pretty(v) { return typeof v === 'string' ? v : JSON.stringify(v, null, 2); }

function redisDisabledView(st) {
  return h('div', { class: 'section' },
    h('div', { class: 'section-head' }, h('h3', null, st.enabled ? 'Cannot reach Redis' : 'Redis is not configured')),
    h('div', { class: 'section-body stack' },
      st.error && h('div', { class: 'error-box', style: { margin: 0 } }, st.error),
      h('p', { style: { margin: 0 } }, 'Set ', h('code', null, 'REDIS_URL'), ' in the server\'s ', h('code', null, '.env'), ' and redeploy:'),
      codeBlock('REDIS_URL=redis://central-redis:6379/0\n# with a password:  redis://:PASSWORD@central-redis:6379/0'),
      h('p', { class: 'muted', style: { margin: 0 } }, 'Both containers must share a Docker network:'),
      codeBlock('docker network connect proxy_network central-redis')));
}

// ---------- projects home
async function viewRedis(r, seq) {
  setMain({ title: 'Redis', loading: true });
  const [st, projects] = await Promise.all([GET('/api/redis/status'), GET('/api/redis/projects').catch(() => [])]);
  if (seq !== renderSeq) return;
  state.redisProjects = projects;
  const i = st.info || {};
  const memPct = i.maxmemory ? Math.min(100, Math.round((i.used_memory / i.maxmemory) * 100)) : null;

  const cards = st.connected ? h('div', { class: 'cards' },
    statCard('Server', 'server', [h('span', { class: 'dot' }), 'Connected'], `${st.ping_ms} ms ping · up ${fmtUptime(i.uptime_in_seconds || 0)}`),
    statCard('Redis', 'layers', i.redis_version || '—', h('span', { class: 'badges' }, h('span', { class: 'badge' }, i.role || 'master'), h('span', { class: 'badge mono' }, st.url_host))),
    statCard('Memory', 'hdd', i.used_memory_human || '—', i.maxmemory ? `of ${i.maxmemory_human} · ${i.maxmemory_policy}` : 'no maxmemory limit',
      memPct != null && h('div', { class: 'bar' }, h('i', { style: { width: memPct + '%', background: memPct > 85 ? 'var(--danger)' : '' } }))),
    statCard('Keys', 'key', fmtNum(st.dbsize), `${fmtNum(i.expired_keys)} expired · ${fmtNum(i.evicted_keys)} evicted`),
    statCard('Clients', 'activity', fmtNum(i.connected_clients), `${fmtNum(i.instantaneous_ops_per_sec)} ops/s now`),
    statCard('Hit rate', 'gauge', st.hit_rate == null ? '—' : st.hit_rate + '%', `${shortNum(i.keyspace_hits || 0)} hits · ${shortNum(i.keyspace_misses || 0)} misses`)) : redisDisabledView(st);

  const rows = projects.map(p => h('tr', null,
    h('td', null, h('a', { href: link.redisProject(p.id), class: 'name-cell mono' }, icon('layers', 14), p.id),
      p.name && p.name !== p.id && h('div', { class: 'faint small', style: { paddingLeft: '22px' } }, p.name)),
    h('td', { class: 'num' }, p.keys == null ? '—' : fmtNum(p.keys)),
    h('td', { class: 'num' }, p.bytes == null ? '—' : fmtBytes(p.bytes)),
    h('td', { class: 'num' }, p.requests_24h == null ? '—' : fmtNum(p.requests_24h),
      p.errors_24h ? h('span', { class: 'badge danger', style: { marginLeft: '6px' } }, p.errors_24h + ' err') : null),
    h('td', { class: 'num' }, p.key_count),
    h('td', { class: 'muted nowrap' }, p.last_used_at ? since(p.last_used_at) + ' ago' : 'never'),
    h('td', null, p.imported_from && h('span', { class: 'badge' }, 'imported')),
    h('td', { class: 'actions' },
      btn('Browse', () => go(link.redisProject(p.id, 'browser')), { class: 'sm ghost', icon: 'search' }),
      btn('Keys', () => go(link.redisProject(p.id, 'keys')), { class: 'sm ghost', icon: 'key' }))));

  setMain({
    title: 'Redis',
    sub: 'Central Redis: one isolated namespace per project, sk_live_ API keys, REST endpoints at /redis/{project}/…',
    badges: st.connected ? h('span', { class: 'badge ok' }, 'online') : h('span', { class: 'badge danger' }, 'offline'),
    actions: [btn('Refresh', () => route(), { icon: 'refresh' }), btn('Import from MongoDB', () => redisImportModal(), { icon: 'upload' }),
      btn('New project', () => redisNewProject(), { class: 'primary', icon: 'plus', disabled: !st.connected })],
    body: [cards,
      h('div', { class: 'section' },
        h('div', { class: 'section-head' }, h('h3', null, 'Projects'), h('span', { class: 'count' }, projects.length)),
        projects.length ? h('div', { class: 'scroll-x' }, h('table', { class: 'list' },
          h('thead', null, h('tr', null, h('th', null, 'Project'), h('th', { class: 'num' }, 'Keys'), h('th', { class: 'num' }, 'Memory'),
            h('th', { class: 'num' }, 'Requests 24h'), h('th', { class: 'num' }, 'API keys'), h('th', null, 'Last used'), h('th', null, ''), h('th', null, ''))),
          h('tbody', null, rows))) :
          h('div', { class: 'empty' }, 'No projects yet. ', h('a', { href: '#', onclick: (e) => { e.preventDefault(); redisNewProject(); } }, 'Create one'),
            ', or ', h('a', { href: '#', onclick: (e) => { e.preventDefault(); redisImportModal(); } }, 'import them'), ' from the old MongoDB.')),
      st.connected && Object.keys(st.keyspace || {}).length > 0 && h('div', { class: 'section' },
        h('div', { class: 'section-head' }, h('h3', null, 'Keyspace')),
        h('div', { class: 'kv' }, Object.entries(st.keyspace).map(([db, v]) => h('div', null, h('div', { class: 'k mono' }, db),
          h('span', { class: 'v' }, `${fmtNum(v.keys)} keys · ${fmtNum(v.expires)} with TTL`))))),
    ],
  });
}

async function redisNewProject() {
  const id = h('input', { class: 'input mono', placeholder: 'checkout_svc', autocomplete: 'off' });
  const name = h('input', { class: 'input', placeholder: 'Checkout service' });
  const desc = h('input', { class: 'input', placeholder: 'optional' });
  const res = await modal({
    title: 'New Redis project', drawer: true,
    body: [field('Project ID', id, 'lowercase letters, numbers, underscores; becomes the URL and key prefix'), field('Name', name), field('Description', desc),
      h('div', { class: 'callout info' }, 'Every key is stored as ', h('code', null, 'project_id:key'), ', so projects can never read each other\'s data. A first API key is created for you.')],
    actions: [{ label: 'Cancel' }, { label: 'Create project', primary: true, onClick: () => POST('/api/redis/projects', { project_id: id.value, name: name.value, description: desc.value }) }],
  });
  if (!res) return;
  await redisShowKey(res.api_key, res.project.id, 'Project created');
  go(link.redisProject(res.project.id, 'browser'));
}

async function redisImportModal() {
  const uri = h('input', { class: 'input mono', placeholder: 'mongodb+srv://user:pass@cluster…/  (blank = REDIS_IMPORT_MONGODB_URI)' });
  const db = h('input', { class: 'input mono', value: 'central_redis' });
  const res = await modal({
    title: 'Import from the old MongoDB',
    body: [h('p', { style: { margin: 0 } }, 'Copies every project and API key from the standalone Central Redis service. Keys are imported as their SHA-256 digests, so existing clients keep working after they switch to the new base URL. Running it again skips anything already imported.'),
      field('MONGODB_URI', uri), field('Database', db, 'MONGODB_DB of the old service')],
    actions: [{ label: 'Cancel' }, { label: 'Import', primary: true, onClick: () => POST('/api/redis/import', { mongodb_uri: uri.value, database: db.value }) }],
  });
  if (!res) return;
  toast(`Imported ${res.projects_added} project(s) and ${res.keys_added} key(s)` + (res.skipped ? ` · ${res.skipped} skipped` : ''), 'ok', 'Import finished');
  route();
}

function redisSamples(key, base) {
  const curl = `# write (value can be any JSON; ttl in seconds is optional)
curl -X POST ${base}/set/cart:42 \\
  -H "x-api-key: ${key}" \\
  -H "Content-Type: application/json" \\
  -d '{"value": {"items": 3}, "ttl": 3600}'

# read
curl ${base}/get/cart:42 -H "x-api-key: ${key}"

# list keys (SCAN; pass cursor back until "done": true)
curl "${base}/keys?pattern=cart:*" -H "x-api-key: ${key}"`;
  const py = `import os, requests

BASE = "${base}"
H = {"x-api-key": os.environ.get("CENTRAL_REDIS_KEY", "${key}")}

requests.post(f"{BASE}/set/cart:42", json={"value": {"items": 3}, "ttl": 3600}, headers=H).raise_for_status()
cart = requests.get(f"{BASE}/get/cart:42", headers=H).json()["value"]
requests.post(f"{BASE}/incr/views", json={"by": 1}, headers=H)
requests.post(f"{BASE}/hset/user:1", json={"mapping": {"name": "Asha", "plan": "pro"}}, headers=H)`;
  const js = `const BASE = "${base}";
const KEY = process.env.CENTRAL_REDIS_KEY ?? "${key}";
const call = (method, path, body) => fetch(BASE + path, {
  method, headers: { "x-api-key": KEY, "Content-Type": "application/json" },
  body: body ? JSON.stringify(body) : undefined,
}).then(r => r.ok ? r.json() : Promise.reject(r));

await call("POST", "/set/cart:42", { value: { items: 3 }, ttl: 3600 });
const { value } = await call("GET", "/get/cart:42");
await call("POST", "/lpush/queue", { values: ["job-1", "job-2"] });`;
  const ops = `Strings  GET  /get/{key}            POST /set/{key} {value, ttl?}     DELETE /delete/{key}
         POST /expire/{key} {ttl}   GET  /ttl/{key}   POST /incr/{key} {by}
         POST /mset {pairs, ttl?}   POST /mget ["k1","k2"]
Lists    POST /lpush|rpush/{key} {values}   GET /lrange/{key}?start&end   DELETE /lpop|rpop/{key}
Hashes   POST /hset/{key} {mapping}  GET /hget/{key}/{field}  GET /hgetall/{key}  DELETE /hdel/{key}/{field}
Sets     POST /sadd/{key} {members}  GET /smembers/{key}  POST /srem/{key} {members}
Keys     GET /keys?pattern&cursor&limit   GET /scan (+ type, ttl, size)   DELETE /flush

Header: x-api-key: sk_live_…  (or Authorization: Bearer sk_live_…)
Errors: 401 bad key · 404 unknown project · 409 wrong type (e.g. GET on a list) · 422 bad body`;
  return { curl, Python: py, 'Node / JS': js, Reference: ops };
}

function samplesBlock(samples) {
  const seg = h('div', { class: 'seg' });
  let current = Object.keys(samples)[0];
  const pre = h('pre', { class: 'code', style: { maxHeight: '340px' } });
  const draw = () => {
    clear(seg);
    for (const n of Object.keys(samples)) seg.appendChild(h('button', { type: 'button', class: n === current ? 'active' : '', onclick: () => { current = n; draw(); } }, n));
    pre.textContent = samples[current];
  };
  draw();
  return [h('div', { class: 'row', style: { gap: '8px' } }, seg, h('span', { class: 'grow' }), btn('Copy', () => copyText(samples[current]), { class: 'sm', icon: 'copy' })), pre];
}

function redisShowKey(key, projectId, title = 'API key created') {
  const base = location.origin + '/redis/' + projectId;
  return modal({
    title, size: 'wide', dismissable: false,
    body: [field('API key', secretBox(key)),
      h('div', { class: 'callout' }, 'Copy it now. Only a SHA-256 hash is stored, so it can never be shown again.'),
      field('Base URL', secretBox(base)), ...samplesBlock(redisSamples(key, base))],
    actions: [{ label: "I've saved it", primary: true }],
  });
}

// ---------- project page
async function viewRedisProject(r, seq) {
  const tab = R_TABS.some(t => t[0] === r.tab) ? r.tab : 'browser';
  const seg = h('div', { class: 'seg' }, R_TABS.map(([k, l]) => h('a', { href: link.redisProject(r.project, k), class: k === tab ? 'active' : '' }, l)));
  const crumbs = [['Redis', link.redis()]];
  setMain({ title: r.project, crumbs, flush: tab === 'browser' || tab === 'console', monoTitle: true, actions: [seg], loading: true });
  const p = await GET(rPath(r.project));
  if (seq !== renderSeq) return;
  const sub = `${fmtNum(p.stats.keys)}${p.stats.truncated ? '+' : ''} keys · ${fmtBytes(p.stats.bytes)} · ${fmtNum(p.usage_24h.requests)} requests in 24h`;
  const head = { title: r.project, crumbs, sub, monoTitle: true, actions: [seg], badges: p.name !== p.id ? h('span', { class: 'badge' }, p.name) : null };
  const views = { browser: redisBrowser, console: redisConsole, keys: redisKeysTab, usage: redisUsage, settings: redisSettings };
  return views[tab](p, head, seq, r);
}

async function redisBrowser(p, head, seq) {
  const g = state.redisBrowse && state.redisBrowse.project === p.id ? state.redisBrowse : (state.redisBrowse = { project: p.id, pattern: '*', type: 'all', open: null });
  const pattern = h('input', { class: 'input sm mono search', value: g.pattern, placeholder: 'pattern, e.g. user:*', 'aria-label': 'Key pattern' });
  const typeSel = select([['all', 'All types'], ['string', 'Strings'], ['list', 'Lists'], ['hash', 'Hashes'], ['set', 'Sets'], ['zset', 'Sorted sets']], g.type, { class: 'input sm', style: { width: 'auto' } });
  const tbody = h('tbody');
  const more = btn('Load more', () => load(), { class: 'sm' });
  const countEl = h('span', { class: 'muted small' });
  const gridArea = h('div', { class: 'grid-area' });
  let cursor = 0;
  let shown = 0;
  let panel = null;
  let openTr = null;

  const apply = () => { g.pattern = pattern.value.trim() || '*'; g.type = typeSel.value; reset(); };
  pattern.addEventListener('keydown', (e) => { if (e.key === 'Enter') apply(); });
  typeSel.addEventListener('change', apply);

  async function load() {
    more.disabled = true;
    try {
      const res = await GET(`${rPath(p.id)}/browse${qs({ pattern: g.pattern, cursor, limit: 100, type: g.type })}`);
      cursor = res.cursor;
      const frag = document.createDocumentFragment();
      for (const k of res.keys) {
        const tr = h('tr', { onclick: () => openKey(k.key, tr) },
          h('td', { class: 'mono' }, k.key), h('td', null, typeBadge(k.type)),
          h('td', { class: 'mono muted' }, k.persistent ? '∞' : fmtTtl(k.ttl)),
          h('td', { class: 'num muted' }, k.size == null ? '—' : fmtBytes(k.size)));
        if (g.open === k.key) setTimeout(() => openKey(k.key, tr), 0);
        frag.appendChild(tr);
      }
      tbody.appendChild(frag);
      shown += res.keys.length;
      countEl.textContent = `${fmtNum(shown)} key${shown === 1 ? '' : 's'}` + (res.done ? '' : ' · more available');
      more.style.display = res.done ? 'none' : '';
      if (!shown && res.done) tbody.appendChild(h('tr', null, h('td', { colspan: '4', class: 'faint', style: { textAlign: 'center', padding: '28px' } }, g.pattern === '*' && g.type === 'all' ? 'This project has no keys yet.' : 'No keys match.')));
    } catch (e) { toastErr(e); } finally { more.disabled = false; }
  }
  function reset() { clear(tbody); cursor = 0; shown = 0; closeKey(); load(); }

  function closeKey() { if (panel) panel.remove(); if (openTr) openTr.classList.remove('open'); panel = null; openTr = null; g.open = null; }
  async function openKey(key, tr) {
    closeKey();
    g.open = key;
    openTr = tr; if (tr) tr.classList.add('open');
    let entry = null;
    if (key != null) {
      try { entry = await GET(`${rPath(p.id)}/keys/${enc(key)}`); } catch (e) { toastErr(e); closeKey(); return; }
    }
    const isNew = !entry;
    const keyIn = h('input', { class: 'input mono', value: key || '', placeholder: 'key name', disabled: !isNew });
    const tSel = select(['string', 'list', 'hash', 'set'], entry ? entry.type : 'string', { class: 'input sm', disabled: entry && !['string', 'list', 'hash', 'set'].includes(entry.type) });
    const val = h('textarea', { class: 'input', rows: 12, spellcheck: 'false', style: { minHeight: '220px' } });
    val.value = entry ? pretty(entry.value) : '';
    const hint = h('div', { class: 'faint small' });
    const syncHint = () => { hint.textContent = { string: 'Text, or any JSON value.', list: 'JSON array, e.g. ["a", "b"]', hash: 'JSON object, e.g. {"name": "Asha"}', set: 'JSON array of members' }[tSel.value]; };
    tSel.addEventListener('change', syncHint); syncHint();
    const ttlIn = h('input', { class: 'input sm mono', type: 'number', min: '0', placeholder: 'none', value: entry && entry.ttl ? String(entry.ttl) : '' });
    const parseVal = () => {
      const raw = val.value;
      if (tSel.value === 'string') { try { const j = JSON.parse(raw); return typeof j === 'string' ? raw : j; } catch { return raw; } }
      let j;
      try { j = JSON.parse(raw || (tSel.value === 'hash' ? '{}' : '[]')); } catch { throw new Error('Value must be valid JSON for a ' + tSel.value); }
      if (tSel.value === 'hash' && (typeof j !== 'object' || Array.isArray(j) || j === null)) throw new Error('A hash needs a JSON object');
      if (tSel.value !== 'hash' && !Array.isArray(j)) throw new Error(`A ${tSel.value} needs a JSON array`);
      return j;
    };
    const save = btn(isNew ? 'Create key' : 'Save', async () => {
      const name = keyIn.value.trim();
      if (!name) { toast('Enter a key name', 'error'); return; }
      let value;
      try { value = parseVal(); } catch (e) { toast(e.message, 'error'); return; }
      save.disabled = true;
      try {
        await api('PUT', `${rPath(p.id)}/keys/${enc(name)}`, { type: tSel.value, value, ttl: ttlIn.value ? Number(ttlIn.value) : null });
        toast(isNew ? 'Key created' : 'Saved');
        g.open = name;
        reset();
      } catch (e) { toastErr(e, 'Save failed'); } finally { save.disabled = false; }
    }, { class: 'primary' });
    const meta = entry ? h('div', { class: 'kv', style: { margin: '0 -16px', borderBottom: '1px solid var(--border)' } },
      h('div', null, h('div', { class: 'k' }, 'Type'), typeBadge(entry.type)),
      h('div', null, h('div', { class: 'k' }, 'TTL'), h('span', { class: 'v' }, entry.persistent ? 'no expiry' : fmtTtl(entry.ttl))),
      h('div', null, h('div', { class: 'k' }, 'Size'), h('span', { class: 'v' }, entry.size == null ? '—' : fmtBytes(entry.size))),
      entry.length != null && h('div', null, h('div', { class: 'k' }, 'Length'), h('span', { class: 'v' }, fmtNum(entry.length) + (entry.length > 1000 ? ' (first 1,000 shown)' : '')))) : null;
    panel = h('aside', { class: 'rowpanel', 'aria-label': 'Key details' },
      h('div', { class: 'rowpanel-head' }, icon('key'), h('h2', { class: 'mono', style: { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }, title: key || '' }, key || 'New key'),
        entry && btn('', () => copyText(pretty(entry.value)), { class: 'sm ghost icon', icon: 'copy', title: 'Copy value' }),
        btn('', closeKey, { class: 'sm ghost icon', icon: 'x', title: 'Close' })),
      h('div', { class: 'rowpanel-body stack', style: { paddingTop: '12px', gap: '12px' } },
        meta,
        isNew && field('Key', keyIn),
        h('div', { class: 'grid2' }, field('Type', tSel), field('TTL (seconds)', ttlIn, entry ? 'saving resets it' : '')),
        field('Value', val), hint,
        entry && h('div', { class: 'row', style: { gap: '6px' } },
          btn('Remove expiry', async () => { try { await POST(`${rPath(p.id)}/ttl/${enc(key)}`, { ttl: null }); toast('Expiry removed'); openKey(key, tr); } catch (e) { toastErr(e); } }, { class: 'sm', disabled: entry.persistent }),
          btn('Expire in 1h', async () => { try { await POST(`${rPath(p.id)}/ttl/${enc(key)}`, { ttl: 3600 }); toast('Expires in 1 hour'); openKey(key, tr); } catch (e) { toastErr(e); } }, { class: 'sm' }))),
      h('div', { class: 'rowpanel-foot' },
        entry && btn('', async () => {
          if (!await confirmDanger({ title: `Delete ${key}?`, message: 'The key and its value are removed immediately.' })) return;
          try { await DEL(`${rPath(p.id)}/keys/${enc(key)}`); toast('Key deleted'); reset(); } catch (e) { toastErr(e); }
        }, { class: 'danger icon', icon: 'trash', title: 'Delete key' }),
        h('span', { class: 'grow' }), save));
    gridArea.appendChild(panel);
    if (isNew) setTimeout(() => keyIn.focus(), 20);
  }

  const toolbar = h('div', { class: 'toolbar' },
    h('div', { class: 'searchbox' }, icon('search', 13), pattern), typeSel,
    btn('', () => reset(), { class: 'sm ghost icon', icon: 'refresh', title: 'Refresh' }), countEl,
    h('span', { class: 'grow' }),
    btn('Flush all', async () => {
      if (!await confirmDanger({ title: `Delete every key in ${p.id}?`, message: 'All data in this project is removed. API keys and settings stay.', typeToConfirm: p.id, confirmLabel: 'Flush project' })) return;
      try { const res = await POST(`${rPath(p.id)}/flush`); toast(`Deleted ${fmtNum(res.deleted)} keys`); reset(); } catch (e) { toastErr(e); }
    }, { class: 'sm danger', icon: 'trash' }),
    btn('New key', () => openKey(null, null), { class: 'sm primary', icon: 'plus' }));
  gridArea.appendChild(h('div', { class: 'grid-wrap' },
    h('table', { class: 'grid clickable' },
      h('thead', null, h('tr', null, ['Key', 'Type', 'TTL', 'Size'].map(x => h('th', null, h('div', { class: 'h', style: { cursor: 'default' } }, h('span', { class: 'n' }, x)))))),
      tbody),
    h('div', { style: { padding: '12px 20px' } }, more)));
  setMain(Object.assign({}, head, { flush: true, body: [toolbar, gridArea] }));
  load();
}

const CONSOLE_BODIES = {
  set: { value: { hello: 'world' }, ttl: 3600 }, expire: { ttl: 60 }, incr: { by: 1 },
  mset: { pairs: { a: 1, b: 2 } }, mget: { keys: ['a', 'b'] }, lpush: { values: ['x'] }, rpush: { values: ['x'] },
  lrange: { start: 0, end: -1 }, hset: { mapping: { field: 'value' } }, sadd: { members: ['x'] }, srem: { members: ['x'] },
  keys: { pattern: '*', cursor: 0, limit: 50 }, scan: { pattern: '*', cursor: 0, limit: 50 },
};

async function redisConsole(p, head, seq) {
  const ops = state.redisOps || (state.redisOps = await GET('/api/redis/console/operations'));
  if (seq !== renderSeq) return;
  const opSel = h('select', { class: 'input sm mono', style: { width: 'auto' } },
    Object.entries(ops.groups).map(([g, list]) => h('optgroup', { label: g }, list.map(o => h('option', { value: o }, o)))));
  opSel.value = store.get('rconsole:op', 'get');
  const keyIn = h('input', { class: 'input sm mono', placeholder: 'key', style: { width: '240px' } });
  const fieldIn = h('input', { class: 'input sm mono', placeholder: 'field', style: { width: '160px' } });
  const bodyIn = h('textarea', { class: 'editor', spellcheck: 'false', style: { height: '150px', minHeight: '110px' } });
  const reqLine = h('span', { class: 'mono small muted' });
  const runBtn = btn('Send', () => run(), { class: 'sm primary', icon: 'play', title: (IS_MAC ? '⌘' : 'Ctrl') + ' + Enter' });
  const out = h('div', { class: 'results' }, h('div', { class: 'loading' }, h('span', { class: 'faint' }, 'Runs exactly like the public API, and is counted in Usage.')));
  const sync = () => {
    const spec = ops.specs[opSel.value];
    keyIn.style.display = spec.needs_key ? '' : 'none';
    fieldIn.style.display = spec.path.includes('{field}') ? '' : 'none';
    const b = CONSOLE_BODIES[opSel.value];
    bodyIn.style.display = b ? '' : 'none';
    if (b && bodyIn.dataset.op !== opSel.value) { bodyIn.value = JSON.stringify(b, null, 2); bodyIn.dataset.op = opSel.value; }
    reqLine.textContent = `${spec.method} /redis/${p.id}${spec.path.replace('{key}', keyIn.value || '{key}').replace('{field}', fieldIn.value || '{field}')}`;
    store.set('rconsole:op', opSel.value);
  };
  opSel.addEventListener('change', sync); keyIn.addEventListener('input', sync); fieldIn.addEventListener('input', sync);
  const onKey = (e) => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey || e.target.tagName === 'INPUT')) { e.preventDefault(); run(); } };
  [bodyIn, keyIn, fieldIn].forEach(x => x.addEventListener('keydown', onKey));
  sync();

  async function run() {
    let body = {};
    if (bodyIn.style.display !== 'none' && bodyIn.value.trim()) {
      try { body = JSON.parse(bodyIn.value); } catch { toast('Body must be valid JSON', 'error'); return; }
    }
    if (opSel.value === 'flush' && !await confirmDanger({ title: `Flush ${p.id}?`, message: 'Every key in this project is deleted.', typeToConfirm: p.id, confirmLabel: 'Flush' })) return;
    runBtn.disabled = true;
    try {
      const res = await POST(`${rPath(p.id)}/console`, { operation: opSel.value, key: keyIn.value, field: fieldIn.value, body });
      const ok = res.status < 400;
      clear(out).appendChild(h('div', { class: 'result-meta' },
        h('span', { class: ok ? 'ok' : '', style: ok ? null : { color: 'var(--danger)', fontWeight: 600 } }, (ok ? '✓ ' : '✕ ') + res.status),
        h('span', { class: 'mono' }, res.method + ' ' + res.path), h('span', null, res.duration_ms + ' ms'), h('span', { class: 'grow' }),
        btn('Copy', () => copyText(JSON.stringify(res.result, null, 2)), { class: 'sm', icon: 'copy' })));
      out.appendChild(h('pre', { class: 'code', style: { margin: '14px 20px', maxHeight: 'none' } }, JSON.stringify(res.result, null, 2)));
    } catch (e) { clear(out).appendChild(h('div', { class: 'error-box' }, e instanceof ApiError ? e.full : String(e))); } finally { runBtn.disabled = false; }
  }

  setMain(Object.assign({}, head, {
    flush: true,
    body: h('div', { class: 'sql-layout' },
      h('div', { class: 'editor-wrap' },
        h('div', { class: 'editor-bar', style: { borderBottom: '1px solid var(--border)' } }, opSel, keyIn, fieldIn, runBtn, h('span', { class: 'grow' }), reqLine),
        bodyIn),
      out),
  }));
  (keyIn.style.display !== 'none' ? keyIn : bodyIn).focus();
}

async function redisKeysTab(p, head, seq) {
  const keys = await GET(`${rPath(p.id)}/api-keys`);
  if (seq !== renderSeq) return;
  const base = location.origin + '/redis/' + p.id;
  const newKey = async () => {
    const name = h('input', { class: 'input', placeholder: 'e.g. production backend' });
    const res = await modal({ title: 'New API key', body: field('Name', name), actions: [{ label: 'Cancel' }, { label: 'Create key', primary: true, onClick: () => POST(`${rPath(p.id)}/api-keys`, { name: name.value }) }] });
    if (res) { await redisShowKey(res.api_key, p.id); route(); }
  };
  setMain(Object.assign({}, head, {
    body: [
      h('div', { class: 'section' },
        h('div', { class: 'section-head' }, h('h3', null, 'API keys'), h('span', { class: 'count' }, keys.length),
          h('div', { class: 'actions' }, btn('New API key', newKey, { class: 'sm primary', icon: 'plus' }))),
        keys.length ? h('div', { class: 'scroll-x' }, h('table', { class: 'list' },
          h('thead', null, h('tr', null, ['Name', 'Key', 'Created', 'Last used', ''].map(x => h('th', null, x)))),
          h('tbody', null, keys.map(k => h('tr', null,
            h('td', null, h('strong', null, k.name)),
            h('td', { class: 'mono muted' }, k.masked),
            h('td', { class: 'muted nowrap' }, since(k.created_at) + ' ago', k.rotated_at && h('div', { class: 'faint small' }, 'rotated ' + since(k.rotated_at) + ' ago')),
            h('td', { class: 'muted nowrap' }, k.last_used_at ? since(k.last_used_at) + ' ago' : 'never'),
            h('td', { class: 'actions' },
              btn('Rotate', async () => {
                if (!await confirmDanger({ title: `Rotate "${k.name}"?`, message: 'A new key replaces this one. Clients using the old key stop working immediately.', confirmLabel: 'Rotate' })) return;
                try { const res = await POST(`${rPath(p.id)}/api-keys/${enc(k.id)}/rotate`); await redisShowKey(res.api_key, p.id, 'Key rotated'); route(); } catch (e) { toastErr(e); }
              }, { class: 'sm' }),
              btn('Revoke', async () => {
                if (!await confirmDanger({ title: `Revoke "${k.name}"?`, message: 'Clients using this key get 401 immediately.', confirmLabel: 'Revoke' })) return;
                try { await DEL(`${rPath(p.id)}/api-keys/${enc(k.id)}`); toast('Key revoked'); route(); } catch (e) { toastErr(e); }
              }, { class: 'sm danger' }))))))) :
          h('div', { class: 'empty' }, 'No keys. Create one to call this project from an app.')),
      h('div', { class: 'section' },
        h('div', { class: 'section-head' }, h('h3', null, 'Connect your app'), h('div', { class: 'desc' }, 'Base URL ', h('code', null, base), '. Swap YOUR_API_KEY for a key from above.')),
        h('div', { class: 'section-body stack', style: { gap: '10px' } }, samplesBlock(redisSamples('YOUR_API_KEY', base)))),
    ],
  }));
}

function barChart(points) {
  const W = 900, H = 160, pad = 24;
  const max = Math.max(1, ...points.map(p => p.requests));
  const bw = (W - pad) / Math.max(1, points.length);
  const bars = points.map((p, i) => {
    const hReq = (p.requests / max) * (H - 30);
    const hErr = (p.errors / max) * (H - 30);
    const x = pad + i * bw + 1;
    return `<g><title>${new Date(p.at).toLocaleString()}\n${p.requests} requests, ${p.errors} errors, avg ${p.avg_ms} ms</title>` +
      `<rect x="${x}" y="${H - 20 - hReq}" width="${Math.max(1, bw - 2)}" height="${hReq}" rx="2" fill="var(--accent)" opacity=".85"/>` +
      (p.errors ? `<rect x="${x}" y="${H - 20 - hErr}" width="${Math.max(1, bw - 2)}" height="${hErr}" rx="2" fill="var(--danger)"/>` : '') + '</g>';
  }).join('');
  const lbl = (p) => p.at.length <= 10 ? p.at.slice(5) : new Date(p.at).getHours() + ':00';
  const ticks = points.length ? [0, Math.floor(points.length / 2), points.length - 1].map(i => `<text x="${pad + i * bw + bw / 2}" y="${H - 4}" text-anchor="middle" font-size="10" fill="var(--faint)">${lbl(points[i])}</text>`).join('') : '';
  return h('div', { style: { width: '100%' }, html: `<svg viewBox="0 0 ${W} ${H}" width="100%" height="${H}" preserveAspectRatio="none" role="img" aria-label="Requests over time">` +
    `<text x="0" y="12" font-size="10" fill="var(--faint)">${fmtNum(max)}</text><line x1="${pad}" x2="${W}" y1="${H - 20}" y2="${H - 20}" stroke="var(--border)"/>${bars}${ticks}</svg>` });
}

async function redisUsage(p, head, seq, r) {
  const range = store.get('rusage:range', '24h');
  const u = await GET(`${rPath(p.id)}/usage${qs({ range })}`);
  if (seq !== renderSeq) return;
  const s = u.summary;
  const rangeSeg = h('div', { class: 'seg' }, ['24h', '7d', '30d'].map(x => h('button', { type: 'button', class: x === range ? 'active' : '', onclick: () => { store.set('rusage:range', x); route(); } }, x)));
  const entryRow = (e) => h('tr', null,
    h('td', { class: 'muted nowrap' }, since(new Date(e.t).toISOString()) + ' ago'),
    h('td', { class: 'mono' }, e.m), h('td', { class: 'mono' }, e.p),
    h('td', null, h('span', { class: 'badge ' + (e.s >= 400 ? 'danger' : 'ok') }, e.s)),
    h('td', { class: 'num muted' }, e.d + ' ms'), h('td', { class: 'muted' }, e.e || ''));
  const logTable = (rows, empty) => rows.length ? h('div', { class: 'scroll-x' }, h('table', { class: 'list' },
    h('thead', null, h('tr', null, ['When', 'Method', 'Path', 'Status', 'Time', 'Error'].map(x => h('th', null, x)))),
    h('tbody', null, rows.map(entryRow)))) : h('div', { class: 'empty' }, empty);
  setMain(Object.assign({}, head, {
    body: [
      h('div', { class: 'row', style: { marginBottom: '16px' } }, rangeSeg, h('span', { class: 'faint small' }, 'Percentiles are histogram bucket edges, so they are upper bounds.')),
      h('div', { class: 'cards' },
        statCard('Requests', 'activity', fmtNum(s.requests), `${fmtNum(s.errors)} errors · ${s.error_rate}%`),
        statCard('Avg latency', 'gauge', s.avg_ms + ' ms', `p50 ≤ ${s.percentiles.p50} ms`),
        statCard('p95 / p99', 'gauge', `${s.percentiles.p95} / ${s.percentiles.p99}`, 'milliseconds'),
        statCard('Keys', 'key', fmtNum(p.stats.keys), fmtBytes(p.stats.bytes) + (p.stats.exact ? '' : ' (estimated)'))),
      h('div', { class: 'section' }, h('div', { class: 'section-head' }, h('h3', null, 'Requests'), h('div', { class: 'desc' }, 'Blue: all requests · red: errors')),
        h('div', { class: 'section-body' }, barChart(u.series))),
      h('div', { class: 'cols' },
        h('div', { class: 'section' }, h('div', { class: 'section-head' }, h('h3', null, 'Operations')),
          Object.keys(s.operations).length ? h('table', { class: 'list' }, h('tbody', null, Object.entries(s.operations).map(([o, n]) => h('tr', null,
            h('td', { class: 'mono' }, o), h('td', null, h('div', { class: 'size-cell' }, h('div', { class: 'bar' }, h('i', { style: { width: (n / Math.max(...Object.values(s.operations))) * 100 + '%' } })), h('span', null, fmtNum(n)))))))) :
            h('div', { class: 'empty' }, 'No requests in this range.')),
        h('div', { class: 'section' }, h('div', { class: 'section-head' }, h('h3', null, 'Largest keys')),
          u.top_keys.length ? h('table', { class: 'list' }, h('tbody', null, u.top_keys.map(k => h('tr', null,
            h('td', { class: 'mono' }, k.key), h('td', null, typeBadge(k.type)), h('td', { class: 'num' }, fmtBytes(k.size)))))) :
            h('div', { class: 'empty' }, 'No keys.'))),
      h('div', { class: 'section' }, h('div', { class: 'section-head' }, h('h3', null, 'Recent errors'), h('span', { class: 'count' }, u.errors.length)), logTable(u.errors, 'No errors recorded.')),
      h('div', { class: 'section' }, h('div', { class: 'section-head' }, h('h3', null, 'Recent requests'), h('span', { class: 'count' }, u.recent.length)), logTable(u.recent, 'No requests yet.')),
    ],
  }));
  void r;
}

async function redisSettings(p, head) {
  const name = h('input', { class: 'input', value: p.name });
  const desc = h('input', { class: 'input', value: p.description || '' });
  const ttl = h('input', { class: 'input mono', type: 'number', min: '0', value: String(p.default_ttl || 0) });
  const applyTtl = checkbox('Apply the default TTL to keys written from the browser without one', p.apply_default_ttl);
  const saveBtn = btn('Save changes', async () => {
    saveBtn.disabled = true;
    try {
      await PATCH(rPath(p.id), { name: name.value, description: desc.value, default_ttl: Number(ttl.value || 0), apply_default_ttl: applyTtl.input.checked });
      toast('Saved'); route();
    } catch (e) { toastErr(e); } finally { saveBtn.disabled = false; }
  }, { class: 'primary' });
  setMain(Object.assign({}, head, {
    body: [
      h('div', { class: 'section' }, h('div', { class: 'section-head' }, h('h3', null, 'Project')),
        h('div', { class: 'section-body stack', style: { maxWidth: '640px' } },
          field('Project ID', secretBox(p.id), 'fixed: it is the URL and the key prefix'),
          field('Base URL', secretBox(p.base_url)),
          h('div', { class: 'grid2' }, field('Name', name), field('Default TTL (seconds)', ttl, '0 = none')),
          field('Description', desc), applyTtl, h('div', null, saveBtn))),
      h('div', { class: 'section', style: { borderColor: 'var(--danger)' } },
        h('div', { class: 'section-head' }, h('h3', { style: { color: 'var(--danger)' } }, 'Danger zone')),
        h('div', { class: 'kv' },
          h('div', null, h('div', { class: 'k' }, 'Flush all keys', h('small', null, 'Deletes every key in this project. API keys and settings stay.')),
            btn('Flush', async () => {
              if (!await confirmDanger({ title: `Flush ${p.id}?`, message: 'Every key in this project is deleted.', typeToConfirm: p.id, confirmLabel: 'Flush' })) return;
              try { const res = await POST(`${rPath(p.id)}/flush`); toast(`Deleted ${fmtNum(res.deleted)} keys`); route(); } catch (e) { toastErr(e); }
            }, { class: 'sm danger' })),
          h('div', null, h('div', { class: 'k' }, 'Delete project', h('small', null, 'Removes all data, metrics and API keys. Clients get 404.')),
            btn('Delete', async () => {
              if (!await confirmDanger({ title: `Delete project ${p.id}?`, message: 'All keys, metrics and API keys are permanently removed.', typeToConfirm: p.id, confirmLabel: 'Delete project' })) return;
              try { const res = await DEL(rPath(p.id)); toast(`Project deleted (${fmtNum(res.keys_deleted)} keys removed)`); go(link.redis()); } catch (e) { toastErr(e); }
            }, { class: 'sm danger solid' })))),
    ],
  }));
}

// ============================================================ connection guide
function copyField(label, value) {
  return h('div', { class: 'copy-field' }, h('label', null, label), h('span', { title: value }, value),
    btn('', () => copyText(value), { class: 'sm ghost icon', icon: 'copy', title: 'Copy' }));
}
function codeBlock(text) {
  const b = btn('', () => copyText(text), { class: 'sm icon', icon: 'copy', title: 'Copy' });
  Object.assign(b.style, { position: 'absolute', top: '6px', right: '6px' });
  return h('div', { style: { position: 'relative' } }, h('pre', { class: 'code' }, text), b);
}

async function viewConnect(r, seq) {
  setMain({ title: 'Connection guide', body: null, loading: true });
  const c = await GET('/api/connection-info');
  if (seq !== renderSeq) return;
  const db = state.db || c.database;
  const site = location.hostname;
  const card = (ic, title, desc, ...body) => h('div', { class: 'section guide-card' },
    h('div', { class: 'section-head' }, icon(ic, 18), h('h3', null, title), h('div', { class: 'desc' }, desc)),
    h('div', { class: 'section-body' }, body));

  setMain({
    title: 'Connection guide',
    sub: 'How apps, scripts and SQL clients reach this server. Port 5432 is never exposed to the internet.',
    actions: [btn('Create API key', () => go(link.keys()), { icon: 'key' }), btn('API reference', () => window.open('/api/docs', '_blank'), { icon: 'external' })],
    body: [
      h('div', { class: 'section' },
        h('div', { class: 'section-head' }, h('h3', null, 'Connection details')),
        h('div', { class: 'section-body copy-grid' },
          copyField('Panel', location.origin),
          copyField('Data API', location.origin + '/v1'),
          copyField('Redis API', location.origin + '/redis/{project}'),
          copyField('DB host', `${c.host}:${c.port}`),
          copyField('Database', db),
          c.public_host && copyField('Public host', `${c.public_host}:${c.public_port || 5432}`))),
      h('div', { class: 'guide-grid' },
        card('server', 'Containers on the same server', 'Fastest. Join the same Docker network and use the container name.',
          h('ol', { class: 'steps' },
            h('li', null, 'Put the app on the same Docker network as Postgres (', h('code', null, 'proxy_network'), ').'),
            h('li', null, 'Create a database with its own owner user under ', h('a', { href: link.databases() }, 'Databases'), '.'),
            h('li', null, 'Set the app\'s ', h('code', null, 'DATABASE_URL'), ':')),
          codeBlock(`postgresql://USER:PASSWORD@${c.host}:${c.port}/${db}`)),
        card('key', 'HTTP data API with an API key', 'For apps outside this server: scoped to one database, revocable, rate-limited.',
          h('ol', { class: 'steps' },
            h('li', null, 'Create a key under ', h('a', { href: link.keys() }, 'API keys'), ' (read, write or full access).'),
            h('li', null, 'Call the API from your backend, never from browser or mobile code.')),
          codeBlock(`curl -X POST ${location.origin}/v1/query \\\n  -H "Authorization: Bearer cpk_…" \\\n  -H "Content-Type: application/json" \\\n  -d '{"sql": "SELECT now()", "params": []}'`)),
        card('terminal', 'DBeaver / psql over an SSH tunnel', 'Full SQL client features. Needs 5432 bound to 127.0.0.1 on the server.',
          h('ol', { class: 'steps' },
            h('li', null, 'New connection → PostgreSQL. Host ', h('code', null, 'localhost'), ', port ', h('code', null, '5432'), ', database ', h('code', null, db), '.'),
            h('li', null, 'SSH tab: tick ', h('strong', null, 'Use SSH Tunnel'), ', host ', h('code', null, site), ', port 22, public-key auth.'),
            h('li', null, 'Leave SSL off (the tunnel encrypts), then Test Connection.')),
          h('div', { class: 'faint small' }, 'Same thing from a terminal:'),
          codeBlock(`ssh -N -L 15432:127.0.0.1:5432 user@${site}\npsql "postgresql://USER:PASSWORD@localhost:15432/${db}"`)),
        card('layers', 'Central Redis API', 'Key-value storage per project over HTTPS, with sk_live_ keys from Redis projects.',
          h('ol', { class: 'steps' },
            h('li', null, 'Create a project under ', h('a', { href: link.redis() }, 'Redis projects'), '; its first key is shown once.'),
            h('li', null, 'Send it as ', h('code', null, 'x-api-key'), '. Keys are stored as ', h('code', null, 'project:key'), ' in the shared Redis.')),
          codeBlock(`curl -X POST ${location.origin}/redis/PROJECT/set/cart:42 \\\n  -H "x-api-key: sk_live_…" -H "Content-Type: application/json" \\\n  -d '{"value": {"items": 3}, "ttl": 3600}'`)),
        card('shield', 'Tailscale', 'Private network between your own machines, with no SSH step.',
          h('ol', { class: 'steps' },
            h('li', null, 'Publish Postgres on the server\'s Tailscale IP only: ', h('code', null, 'ports: ["100.x.y.z:5432:5432"]'), '.'),
            h('li', null, 'Connect from any device on your tailnet to ', h('code', null, '100.x.y.z:5432'), ' as a plain connection.')),
          h('div', { class: 'callout' }, 'Docker-published ports bypass ufw. Never publish 5432 on 0.0.0.0; filter in the DOCKER-USER chain if you ever must.'))),
    ],
  });
}

// ============================================================ database home
async function viewDb(r, seq) {
  setMain({ title: r.db, crumbs: [['Databases', link.databases()]], body: null, loading: true });
  const [schemas, exts] = await Promise.all([GET(`/api/db/${enc(r.db)}/schemas`), GET(`/api/db/${enc(r.db)}/extensions`)]);
  state.schemas = schemas;
  if (seq !== renderSeq) return;
  renderSidebar();
  const installed = exts.filter(e => e.installed_version);
  const available = exts.filter(e => !e.installed_version);
  const extSel = select(available.map(e => [e.name, `${e.name} ${e.default_version || ''}`]), null, { class: 'input sm', style: { width: '220px' } });

  const tablesSection = h('div', { class: 'section' },
    h('div', { class: 'section-head' }, h('h3', null, 'Tables in ', h('code', null, state.schema)), h('span', { class: 'count' }, state.tables.length),
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
    drawer: true,
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
const KIND_NAME = { r: 'table', p: 'partitioned', v: 'view', m: 'mat. view', f: 'foreign' };
async function viewTable(r, seq) {
  const seg = h('div', { class: 'seg' },
    ['data', 'structure', 'ddl'].map(t => h('a', { href: link.table(r.db, r.schema, r.table, t), class: r.tab === t ? 'active' : '' }, { data: 'Data', structure: 'Structure', ddl: 'Definition' }[t])));
  const crumbs = [[r.db, link.db(r.db)], [r.schema, link.db(r.db)]];
  if (r.tab === 'structure') return viewStructure(r, seq, seg, crumbs);
  if (r.tab === 'ddl') return viewDdl(r, seq, seg, crumbs);
  return viewData(r, seq, seg, crumbs);
}
const tblPath = (r) => `/api/db/${enc(r.db)}/tables/${enc(r.schema)}/${enc(r.table)}`;
const FILTER_OPS = [['eq', '='], ['neq', '≠'], ['lt', '<'], ['lte', '≤'], ['gt', '>'], ['gte', '≥'], ['contains', 'contains'], ['ilike', 'ILIKE'], ['like', 'LIKE'], ['not_like', 'NOT LIKE'], ['in', 'in (a,b,c)'], ['is_null', 'is null'], ['not_null', 'is not null']];

// ---------- data grid
async function viewData(r, seq, seg, crumbs) {
  const key = `${r.db}|${r.schema}|${r.table}`;
  const g = state.grids[key] || (state.grids[key] = { limit: store.get('pageSize', 50), offset: 0, sort: null, order: 'asc', q: '', filters: [], showFilters: false, openKey: null });
  g.selected = new Map();
  const tbl = state.tables.find(t => t.name === r.table) || {};
  const title = `${r.schema}.${r.table}`;
  const kindBadge = h('span', { class: 'badge' }, KIND_NAME[tbl.kind] || 'table');
  const queryBtn = btn('Query', () => { store.set('sql:' + r.db, `SELECT *\nFROM ${qi(r.schema)}.${qi(r.table)}\nLIMIT 100;`); go(link.sql(r.db)); }, { icon: 'terminal' });

  setMain({ title, crumbs, badges: kindBadge, flush: true, monoTitle: true, actions: [seg, queryBtn], body: null, loading: true });
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
  const search = h('input', { class: 'input sm search', placeholder: 'Search rows…', value: g.q, 'aria-label': 'Search rows', onkeydown: (e) => { if (e.key === 'Enter') { g.q = search.value; g.offset = 0; route(); } } });
  const nf = activeFilters(g).length;
  const toolbar = h('div', { class: 'toolbar' },
    h('div', { class: 'searchbox' }, icon('search', 13), search),
    btn(nf ? `Filters (${nf})` : 'Filter', () => { g.showFilters = !g.showFilters; if (g.showFilters && !g.filters.length) g.filters.push({ column: cols[0].name, op: 'eq', value: '' }); route(); }, { class: 'sm' + (nf ? ' primary' : ''), icon: 'filter' }),
    g.sort && h('span', { class: 'chip' }, icon('chevron', 12), g.sort, h('span', { class: 'op' }, g.order.toUpperCase()), h('button', { title: 'Clear sort', onclick: () => { g.sort = null; g.offset = 0; route(); } }, icon('x', 12))),
    btn('', () => route(), { class: 'sm ghost icon', icon: 'refresh', title: 'Refresh' }),
    h('span', { class: 'grow' }),
    btn('Export CSV', () => download(`${tblPath(r)}/export`), { class: 'sm', icon: 'download' }),
    data.editable && btn('Import CSV', () => importCsvModal(r, cols), { class: 'sm', icon: 'upload' }),
    data.editable && btn('Insert row', () => insertRow(), { class: 'sm primary', icon: 'plus' }));

  // --- active filters as chips, or the filter editor
  let filtersEl = null;
  if (g.showFilters) {
    filtersEl = h('div', { class: 'filters' },
      g.filters.map((f, i) => {
        const val = h('input', { class: 'input sm val mono', value: f.value ?? '', placeholder: 'value', oninput: (e) => { f.value = e.target.value; }, onkeydown: (e) => { if (e.key === 'Enter') { g.offset = 0; g.showFilters = false; route(); } } });
        const opSel = select(FILTER_OPS, f.op, { class: 'input sm', onchange: (e) => { f.op = e.target.value; val.style.display = f.op.endsWith('null') ? 'none' : ''; } });
        val.style.display = f.op.endsWith('null') ? 'none' : '';
        return h('div', { class: 'frow' },
          h('span', { class: 'faint small', style: { width: '42px' } }, i ? 'and' : 'where'),
          select(cols.map(c => c.name), f.column, { class: 'input sm mono', onchange: (e) => { f.column = e.target.value; } }),
          opSel, val,
          btn('', () => { g.filters.splice(i, 1); if (!g.filters.length) g.showFilters = false; g.offset = 0; route(); }, { class: 'sm ghost icon', icon: 'x', title: 'Remove' }));
      }),
      h('div', { class: 'frow' },
        h('span', { style: { width: '42px' } }),
        btn('Add condition', () => { g.filters.push({ column: cols[0].name, op: 'eq', value: '' }); route(); }, { class: 'sm', icon: 'plus' }),
        btn('Apply', () => { g.offset = 0; g.showFilters = false; route(); }, { class: 'sm primary' }),
        g.filters.length ? btn('Clear all', () => { g.filters = []; g.showFilters = false; g.offset = 0; route(); }, { class: 'sm ghost' }) : null));
  } else if (nf) {
    const opLabel = Object.fromEntries(FILTER_OPS);
    filtersEl = h('div', { class: 'chips' }, h('span', { class: 'lbl' }, 'Filters'),
      activeFilters(g).map(f => h('span', { class: 'chip' }, f.column, h('span', { class: 'op' }, opLabel[f.op] || f.op), !f.op.endsWith('null') && h('span', { class: 'val' }, `'${f.value}'`),
        h('button', { title: 'Remove filter', onclick: () => { g.filters.splice(g.filters.indexOf(f), 1); g.offset = 0; route(); } }, icon('x', 12)))),
      btn('Edit', () => { g.showFilters = true; route(); }, { class: 'sm ghost', icon: 'plus' }));
  }

  // --- selection bar
  const selbar = h('div', { class: 'selbar', style: { display: 'none' } });
  const updateSel = () => {
    const n = g.selected.size;
    selbar.style.display = n ? '' : 'none';
    if (!n) return;
    clear(selbar);
    append(selbar, [
      h('span', null, `${n} row${n > 1 ? 's' : ''} selected`),
      btn('Export selection', () => exportRows([...g.selected.values()]), { class: 'sm ghost', icon: 'download' }),
      data.editable && btn('Delete selected', () => deleteSelected(), { class: 'sm danger', icon: 'trash' }),
      h('span', { class: 'grow' }),
      btn('Clear selection', () => { headChk.checked = false; headChk.dispatchEvent(new Event('change')); }, { class: 'sm ghost', icon: 'x' }),
    ]);
  };

  // --- grid
  const gridArea = h('div', { class: 'grid-area' });
  let panel = null;
  let openTr = null;
  const headChk = h('input', { type: 'checkbox', 'aria-label': 'Select all' });
  const tbody = h('tbody');
  const chks = [];
  const frag = document.createDocumentFragment();
  data.rows.forEach((row, i) => {
    const chk = h('input', { type: 'checkbox', 'aria-label': 'Select row', onclick: (e) => e.stopPropagation() });
    const tr = h('tr', { onclick: () => openRow(row, tr, g.offset + i + 1) },
      h('td', { class: 'chk', onclick: (e) => { if (e.target !== chk) chk.click(); e.stopPropagation(); } }, chk),
      h('td', { class: 'rn' }, g.offset + i + 1),
      cols.map(c => {
        const v = row[c.name];
        if (v == null) return h('td', { class: 'null' }, 'NULL');
        let cls = '';
        if (c.category === 'N') cls = 'numv';
        if (c.category === 'B') cls = v === 'true' ? 'bool-t' : 'bool-f';
        return h('td', { class: cls, title: v.length > 40 ? v.slice(0, 2000) : null }, v.length > 300 ? v.slice(0, 300) + '…' : v);
      }));
    chk.addEventListener('change', () => {
      if (chk.checked) g.selected.set(rowKey(row), row); else g.selected.delete(rowKey(row));
      tr.classList.toggle('sel', chk.checked);
      headChk.checked = g.selected.size === data.rows.length && data.rows.length > 0;
      updateSel();
    });
    chks.push(chk);
    if (g.openKey && rowKey(row) === g.openKey) setTimeout(() => openRow(row, tr, g.offset + i + 1), 0);
    frag.appendChild(tr);
  });
  tbody.appendChild(frag);
  headChk.addEventListener('change', () => { chks.forEach(c => { if (c.checked !== headChk.checked) { c.checked = headChk.checked; c.dispatchEvent(new Event('change')); } }); });

  const thead = h('thead', null, h('tr', null,
    h('th', { class: 'chk' }, headChk),
    h('th', null, h('div', { class: 'h', style: { cursor: 'default' } }, h('span', { class: 'n' }, '#'), h('span', { class: 't' }, ' '))),
    cols.map(c => h('th', null, h('div', {
      class: 'h', title: 'Sort by ' + c.name,
      onclick: () => {
        if (g.sort !== c.name) { g.sort = c.name; g.order = 'asc'; } else if (g.order === 'asc') g.order = 'desc'; else { g.sort = null; }
        g.offset = 0; route();
      },
    },
    h('span', { class: 'n' }, c.name, c.primary_key && h('span', { class: 'pk', title: 'Primary key' }, 'PK'), g.sort === c.name && h('span', { class: 'arrow' }, g.order === 'asc' ? '↑' : '↓')),
    h('span', { class: 't' }, c.type))))));
  gridArea.appendChild(h('div', { class: 'grid-wrap' },
    data.rows.length ? h('table', { class: 'grid clickable' }, thead, tbody) :
      h('div', { class: 'loading', style: { flexDirection: 'column' } }, g.q || nf ? 'No rows match.' : 'This table is empty.', data.editable && btn('Insert row', () => insertRow(), { class: 'sm', icon: 'plus' }))));

  // --- pager
  const from = data.rows.length ? g.offset + 1 : 0;
  const to = g.offset + data.rows.length;
  const pages = Math.max(1, Math.ceil(data.total / g.limit));
  const page = Math.floor(g.offset / g.limit) + 1;
  const pageSize = select(['25', '50', '100', '250', '500', '1000'], String(g.limit), {
    class: 'input sm', 'aria-label': 'Rows per page', onchange: (e) => { g.limit = Number(e.target.value); store.set('pageSize', g.limit); g.offset = 0; route(); },
  });
  const pager = h('div', { class: 'pager' },
    h('span', null, 'Rows ', h('strong', null, `${fmtNum(from)}–${fmtNum(to)}`), ` of ${data.total_exact ? '' : '~'}${fmtNum(data.total)}`),
    !data.editable && h('span', { class: 'badge' }, 'read-only'),
    data.editable && !pk.length && h('span', { class: 'badge warn', title: 'Rows are identified by their physical location (ctid). Add a primary key for reliable editing.' }, 'no primary key'),
    h('span', { class: 'grow' }),
    h('span', null, 'Per page'), pageSize,
    btn('', () => { g.offset = Math.max(0, g.offset - g.limit); route(); }, { class: 'sm icon', icon: 'chevron', title: 'Previous page', disabled: g.offset === 0 }),
    h('span', { class: 'nowrap' }, `Page ${fmtNum(page)} of ${data.total_exact ? '' : '~'}${fmtNum(pages)}`),
    btn('', () => { g.offset += g.limit; route(); }, { class: 'sm icon', icon: 'chevron', title: 'Next page', disabled: to >= data.total || data.rows.length < g.limit }),
    h('span', { class: 'vsep' }),
    h('span', { class: 'ok' }, '● '), h('span', null, `${data.duration_ms} ms`));
  pager.querySelector('[title="Previous page"] svg').style.transform = 'rotate(180deg)';

  const sub = `${data.total_exact ? '' : '~'}${fmtNum(data.total)} rows · ${cols.length} columns` + (tbl.size_bytes != null ? ` · ${fmtBytes(tbl.size_bytes)}` : '');
  setMain({ title, crumbs, badges: kindBadge, sub, flush: true, monoTitle: true, actions: [seg, queryBtn], body: [toolbar, filtersEl, selbar, gridArea, pager] });

  function closeRow() {
    if (panel) panel.remove();
    if (openTr) openTr.classList.remove('open');
    panel = null; openTr = null; g.openKey = null;
  }
  function openRow(row, tr, n) {
    closeRow();
    g.openKey = rowKey(row);
    openTr = tr; tr.classList.add('open');
    const form = rowForm(data, row);
    const ident = pk.length ? { key: Object.fromEntries(pk.map(k => [k, row[k]])) } : { ctid: row.__ctid };
    const save = btn('Save changes', async () => {
      const values = form.collect();
      if (!Object.keys(values).length) { toast('No changes'); return; }
      save.disabled = true;
      try { await PATCH(`${tblPath(r)}/rows`, Object.assign({}, ident, { values })); toast('Row saved'); route(); } catch (e) { toastErr(e, 'Save failed'); } finally { save.disabled = false; }
    }, { class: 'primary' });
    panel = h('aside', { class: 'rowpanel', 'aria-label': 'Row details' },
      h('div', { class: 'rowpanel-head' }, icon('file'), h('h2', null, `Row ${fmtNum(n)}`),
        btn('JSON', () => copyText(JSON.stringify(Object.fromEntries(Object.entries(row).filter(([k]) => k !== '__ctid')), null, 2)), { class: 'sm', icon: 'copy', title: 'Copy row as JSON' }),
        btn('', closeRow, { class: 'sm ghost icon', icon: 'x', title: 'Close' })),
      h('div', { class: 'rowpanel-body' }, form.body),
      data.editable && h('div', { class: 'rowpanel-foot' },
        btn('', async () => {
          if (!await confirmDanger({ title: 'Delete this row?', message: 'This cannot be undone.' })) return;
          try { await DEL(`${tblPath(r)}/rows`, pk.length ? { keys: [ident.key] } : { ctids: [row.__ctid] }); toast('Row deleted'); closeRow(); route(); } catch (e) { toastErr(e, 'Delete failed'); }
        }, { class: 'danger icon', icon: 'trash', title: 'Delete row' }),
        btn('Duplicate', () => {
          const copy = Object.assign({}, row);
          for (const c of data.columns) if (c.primary_key && (c.identity || c.default)) delete copy[c.name];
          rowEditorPrefilled(r, data, copy);
        }, { icon: 'copy' }),
        h('span', { class: 'grow' }),
        save));
    gridArea.appendChild(panel);
  }

  async function insertRow() {
    const form = rowForm(data, null);
    const res = await modal({
      title: `Insert into ${r.table}`, drawer: true, body: form.body,
      actions: [{ label: 'Cancel' }, { label: 'Insert row', primary: true, onClick: () => POST(`${tblPath(r)}/rows`, { values: form.collect() }) }],
    });
    if (res) { toast('Row inserted'); route(); }
  }

  function exportRows(rows) {
    const q = (s) => /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
    const lines = [cols.map(c => q(c.name)).join(',')].concat(rows.map(row => cols.map(c => row[c.name] == null ? '' : q(String(row[c.name]))).join(',')));
    const url = URL.createObjectURL(new Blob([lines.join('\n')], { type: 'text/csv' }));
    const a = h('a', { href: url, download: `${r.table}-selection.csv` }); document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

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

// ---------- row form (used by the row panel and the insert drawer)
function rowForm(data, row) {
  const isNew = !row;
  const fields = [];
  const body = h('div', null, data.columns.map(c => {
    const generated = c.generated === 's' || c.identity === 'a';
    const hasDefault = c.default != null || c.identity || c.generated;
    const cur = row ? row[c.name] : null;
    let input;
    if (c.category === 'B') {
      input = select([['true', 'true'], ['false', 'false']], cur ?? 'true', { class: 'input sm mono' });
    } else {
      input = h('textarea', { class: 'input', rows: 1, spellcheck: 'false', value: cur ?? '' });
      const grow = () => { input.style.height = 'auto'; input.style.height = Math.min(260, Math.max(32, input.scrollHeight + 2)) + 'px'; };
      input.addEventListener('input', grow);
      setTimeout(grow, 0);
    }
    if (!data.editable) input.disabled = true;
    const nullBox = c.nullable && data.editable ? h('input', { type: 'checkbox', checked: !isNew && cur == null }) : null;
    const defBox = isNew && hasDefault ? h('input', { type: 'checkbox', checked: true }) : null;
    const wrap = h('div', { class: 'edit-field' },
      h('div', { class: 'fhead' }, h('span', null, c.name), c.primary_key && h('span', { class: 'pk' }, 'PK'), h('span', { class: 'ty' }, c.type + (c.nullable ? '' : ' · not null'))),
      input,
      (defBox || nullBox) && h('div', { class: 'opts' },
        defBox && h('label', { class: 'check' }, defBox, 'use default'),
        nullBox && h('label', { class: 'check' }, nullBox, 'NULL')));
    const sync = () => {
      const off = (nullBox && nullBox.checked) || (defBox && defBox.checked) || (!isNew && generated) || !data.editable;
      input.disabled = !!off;
      wrap.classList.toggle('is-null', !!off && data.editable);
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
  return { body, collect };
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
async function viewStructure(r, seq, seg, crumbs) {
  setMain({ title: r.table, crumbs, actions: [seg], body: null, loading: true });
  const t = await GET(tblPath(r));
  if (seq !== renderSeq) return;
  const isTable = t.kind === 'r' || t.kind === 'p';
  const st = t.stats;
  const P = tblPath(r);
  const reload = () => route();

  const colSection = h('div', { class: 'section' },
    h('div', { class: 'section-head' }, h('h3', null, 'Columns'), h('span', { class: 'count' }, t.columns.length),
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
    h('div', { class: 'section-head' }, h('h3', null, 'Indexes'), h('span', { class: 'count' }, t.indexes.length),
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
    h('div', { class: 'section-head' }, h('h3', null, 'Constraints'), h('span', { class: 'count' }, t.constraints.length),
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
    title: r.table, crumbs,
    badges: h('span', { class: 'badge' }, KIND_NAME[t.kind] || t.kind),
    sub: (st.comment ? st.comment + ' · ' : '') + `${r.schema}.${r.table} · owner ${st.owner}`,
    actions: [seg],
    body: [
      h('div', { class: 'cards' },
        h('div', { class: 'card' }, h('div', { class: 'k' }, 'Rows (estimate)'), h('div', { class: 'v' }, t.kind === 'v' ? '—' : fmtNum(st.row_estimate))),
        h('div', { class: 'card' }, h('div', { class: 'k' }, 'Total size'), h('div', { class: 'v' }, fmtBytes(st.total_bytes)), h('div', { class: 's' }, `data ${fmtBytes(st.table_bytes)} · indexes ${fmtBytes(st.index_bytes)}`)),
        h('div', { class: 'card' }, h('div', { class: 'k' }, 'Owner'), h('div', { class: 'v', style: { fontSize: '17px' } }, st.owner)),
        h('div', { class: 'card' }, h('div', { class: 'k' }, 'Last analyzed'), h('div', { class: 'v', style: { fontSize: '17px' } }, (st.last_analyze || st.last_autoanalyze) ? since(st.last_analyze || st.last_autoanalyze) + ' ago' : 'never'))),
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
    drawer: true,
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
    drawer: true,
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
    title: `New constraint on ${r.table}`, drawer: true,
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
async function viewDdl(r, seq, seg, crumbs) {
  setMain({ title: r.table, crumbs, actions: [seg], body: null, loading: true });
  const t = await GET(tblPath(r));
  if (seq !== renderSeq) return;
  setMain({
    title: r.table, crumbs,
    sub: 'CREATE statement reconstructed from the catalog',
    actions: [seg, btn('Copy', () => copyText(t.ddl), { icon: 'copy' }), btn('Open in SQL console', () => { store.set('sql:' + r.db, t.ddl); go(link.sql(r.db)); }, { icon: 'terminal' })],
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
  const results = h('div', { class: 'results' },
    h('div', { class: 'loading' }, h('span', { class: 'faint' }, 'Run a query to see results here. ', h('kbd', null, IS_MAC ? '⌘' : 'Ctrl'), ' ', h('kbd', null, '↵'), ' runs the selection or everything.')));
  const runBtn = btn('Run', () => run(), { class: 'sm primary', icon: 'play', title: (IS_MAC ? '⌘' : 'Ctrl') + ' + Enter' });

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
      h('span', { class: 'faint small' }, 'Database'),
      select(state.dbs.filter(d => d.can_connect).map(d => d.name), db, { class: 'input sm mono', style: { width: 'auto' }, onchange: (e) => go(link.sql(e.target.value)), 'aria-label': 'Database' }),
    ],
    body: h('div', { class: 'sql-layout' },
      h('div', { class: 'editor-wrap' }, editor,
        h('div', { class: 'editor-bar' },
          runBtn,
          btn('Explain analyze', () => run('EXPLAIN (ANALYZE, BUFFERS) '), { class: 'sm', title: 'Runs the query with EXPLAIN ANALYZE — it really executes!' }),
          h('span', { class: 'vsep' }),
          limit, snippets,
          h('span', { class: 'grow' }),
          btn('History', showHistory, { class: 'sm ghost', icon: 'history' }),
          btn('Open .sql', () => fileIn.click(), { class: 'sm ghost', icon: 'file' }), fileIn,
          btn('Clear', () => { editor.value = ''; store.set('sql:' + db, ''); editor.focus(); }, { class: 'sm ghost', icon: 'x' }))),
      results),
  });
  editor.focus();
}

// ============================================================ boot
async function boot() {
  try {
    const me = await api('GET', '/api/auth/me');
    state.user = me.user;
    state.me = me;
  } catch (e) {
    renderLogin(e.status === 401 ? undefined : e.message);
    return;
  }
  renderShell();
  GET('/api/redis/projects?stats=false').then((ps) => { state.redisProjects = ps; }).catch(() => {});
  GET('/api/connection-info').then((c) => { if (c.server_version) { state.serverVersion = c.server_version; renderSidebar(); } }).catch(() => {});
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
