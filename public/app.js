// Shared UI kit (needs i18n.js loaded first). No build step, no framework.
'use strict';

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

// ------------------------------------------------------------------ icons (24x24 stroke)
const ICONS = {
  dashboard: '<rect x="3" y="3" width="7" height="9" rx="1.5"/><rect x="14" y="3" width="7" height="5" rx="1.5"/><rect x="14" y="12" width="7" height="9" rx="1.5"/><rect x="3" y="16" width="7" height="5" rx="1.5"/>',
  invoice: '<path d="M6 3h9l4 4v14l-3-2-2 2-2-2-2 2-2-2-2 2V3z"/><path d="M9 9h6M9 13h6"/>',
  payout: '<path d="M3 7h18v12H3z"/><path d="M3 11h18"/><path d="M7 15h3"/>',
  wallet: '<path d="M20 7V5a2 2 0 0 0-2-2H5a2 2 0 0 0 0 4h15v13H5a2 2 0 0 1-2-2V5"/><circle cx="16" cy="13.5" r="1.3"/>',
  key: '<circle cx="7.5" cy="15.5" r="4.5"/><path d="m10.7 12.3 9.3-9.3M17 6l3 3M14 9l2 2"/>',
  settings: '<circle cx="12" cy="12" r="3"/><path d="M12 2v3M12 19v3M4.2 4.2l2.1 2.1M17.7 17.7l2.1 2.1M2 12h3M19 12h3M4.2 19.8l2.1-2.1M17.7 6.3l2.1-2.1"/>',
  code: '<path d="m8 8-4 4 4 4M16 8l4 4-4 4M14 4l-4 16"/>',
  shield: '<path d="M12 3 4 6v6c0 5 3.5 8 8 9 4.5-1 8-4 8-9V6z"/><path d="m9 12 2 2 4-4"/>',
  users: '<circle cx="9" cy="8" r="3.5"/><path d="M2.5 20a6.5 6.5 0 0 1 13 0"/><path d="M16 4.5a3.5 3.5 0 0 1 0 7M18 14a6 6 0 0 1 3.5 6"/>',
  list: '<path d="M8 6h13M8 12h13M8 18h13"/><circle cx="3.5" cy="6" r="1"/><circle cx="3.5" cy="12" r="1"/><circle cx="3.5" cy="18" r="1"/>',
  coins: '<ellipse cx="9" cy="7" rx="6" ry="3"/><path d="M3 7v5c0 1.7 2.7 3 6 3s6-1.3 6-3V7"/><path d="M9 15v2c0 1.7 2.7 3 6 3s6-1.3 6-3v-5c0-1.7-2.7-3-6-3"/>',
  alert: '<path d="M12 3 2 20h20z"/><path d="M12 10v4M12 17.5v.01"/>',
  info: '<circle cx="12" cy="12" r="9"/><path d="M12 11v5M12 8v.01"/>',
  check: '<path d="m5 12 5 5L20 7"/>',
  checkCircle: '<circle cx="12" cy="12" r="9"/><path d="m8 12 3 3 5-6"/>',
  x: '<path d="M6 6l12 12M18 6 6 18"/>',
  copy: '<rect x="8" y="8" width="12" height="12" rx="2"/><path d="M16 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h2"/>',
  logout: '<path d="M15 4h3a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2h-3"/><path d="M10 17 5 12l5-5M5 12h11"/>',
  menu: '<path d="M4 6h16M4 12h16M4 18h16"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  refresh: '<path d="M20 11a8 8 0 1 0-2.3 5.7"/><path d="M20 4v7h-7"/>',
  clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
  lock: '<rect x="4" y="11" width="16" height="10" rx="2"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/>',
  external: '<path d="M14 4h6v6M20 4l-9 9"/><path d="M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5"/>',
  bolt: '<path d="M13 2 4 14h7l-1 8 9-12h-7z"/>',
  inbox: '<path d="M3 13h5l1.5 3h5L16 13h5"/><path d="M5 5h14l2 8v6H3v-6z"/>',
  trend: '<path d="m3 17 6-6 4 4 8-8"/><path d="M15 7h6v6"/>',
  globe: '<circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3a14 14 0 0 1 0 18M12 3a14 14 0 0 0 0 18"/>',
};
const icon = (name, cls = '') => `<svg class="i ${cls}" viewBox="0 0 24 24" aria-hidden="true">${ICONS[name] || ''}</svg>`;

// ------------------------------------------------------------------ formatting
const STATUS_TONE = {
  pending: 'b-warn', confirming: 'b-info', partially_paid: 'b-warn', paid: 'b-ok', expired: 'b-muted', cancelled: 'b-muted',
  pending_approval: 'b-warn', approved: 'b-info', sending: 'b-info', sent: 'b-info', completed: 'b-ok', failed: 'b-err',
  rejected: 'b-err', confirmed: 'b-ok', orphaned: 'b-err', delivered: 'b-ok',
};
const NETWORK = { tron: 'TRON', ethereum: 'Ethereum', bsc: 'BNB Chain', polygon: 'Polygon', ton: 'TON' };
const LOCALE = () => LANGS[LANG].locale;

const badge = (s) => `<span class="badge ${STATUS_TONE[s] || 'b-muted'}">${esc(t('st.' + s))}</span>`;
const fmtDate = (d) => (d ? new Date(d).toLocaleString(LOCALE(), { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : '—');
const fmtDay = (d) => new Date(d + 'T00:00:00Z').toLocaleDateString(LOCALE(), { month: 'short', day: 'numeric', timeZone: 'UTC' });
const short = (s, n = 6) => (s && s.length > n * 2 + 3 ? `${s.slice(0, n)}…${s.slice(-n)}` : s || '');
const fmtAmount = (v, maxFrac = 6) => {
  if (v === null || v === undefined || v === '') return '—';
  const neg = String(v).startsWith('-');
  const [w, f = ''] = String(v).replace('-', '').split('.');
  const whole = w.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  const frac = f.slice(0, maxFrac).replace(/0+$/, '');
  return (neg ? '−' : '') + (frac ? `${whole}.${frac}` : whole);
};
const num = (v, max) => `<span class="num">${esc(fmtAmount(v, max))}</span>`;
const pct = (v) => `<span class="num">${esc(String(v).replace(/\.?0+$/, ''))}%</span>`;
const assetLabel = (id) => {
  const [sym, std] = String(id || '').split('_');
  return `<span class="asset">${esc(sym)}${std ? `<span class="std">${esc(std)}</span>` : ''}</span>`;
};
const errText = (e) => (e?.code && I18N[LANG]['err.' + e.code] ? t('err.' + e.code) : e?.message || t('common.error'));

// ------------------------------------------------------------------ toast & dialogs
function toast(message, kind = 'ok') {
  let host = $('.toasts');
  if (!host) { host = document.createElement('div'); host.className = 'toasts'; host.setAttribute('role', 'status'); document.body.append(host); }
  const el = document.createElement('div');
  el.className = `toast ${kind}`;
  el.innerHTML = `${icon(kind === 'err' ? 'alert' : 'checkCircle')}<span>${esc(message)}</span>`;
  host.append(el);
  setTimeout(() => el.remove(), 4200);
}

/** Modal dialog. Resolves with the clicked button's value (a function receives the dialog element), or null when dismissed. */
function modal({ title, body = '', ico = 'info', tone = '', wide = false, buttons = [{ label: t('common.ok'), value: true }], onOpen }) {
  return new Promise((resolve) => {
    const wrap = document.createElement('div');
    wrap.className = 'modal-backdrop';
    wrap.innerHTML = `<div class="modal ${wide ? 'wide' : ''}" role="dialog" aria-modal="true" aria-label="${esc(title)}">
      <div class="modal-head"><div class="ico ${tone}">${icon(ico)}</div><h3>${esc(title)}</h3></div>
      <div class="modal-body">${body}</div>
      <div class="modal-foot">${buttons.map((b, i) => `<button class="btn ${b.cls || (i === buttons.length - 1 ? '' : 'secondary')}" data-i="${i}">${esc(b.label)}</button>`).join('')}</div></div>`;
    const close = (v) => { wrap.remove(); document.removeEventListener('keydown', onKey); resolve(v); };
    const onKey = (e) => { if (e.key === 'Escape' && wrap === $$('.modal-backdrop').pop()) close(null); };
    wrap.addEventListener('click', (e) => {
      if (e.target === wrap) return close(null);
      const b = e.target.closest('[data-i]');
      if (!b || b.closest('.modal-backdrop') !== wrap) return;
      const def = buttons[Number(b.dataset.i)];
      close(typeof def.value === 'function' ? def.value(wrap) : def.value);
    });
    wrap.addEventListener('submit', (e) => { e.preventDefault(); wrap.querySelector('.modal-foot .btn:last-child').click(); });
    document.addEventListener('keydown', onKey);
    document.body.append(wrap);
    onOpen?.(wrap);
    (wrap.querySelector('input:not([type=checkbox]), select, textarea') || wrap.querySelector('.modal-foot .btn:last-child'))?.focus();
  });
}

const confirmDialog = (title, text, { danger = false, ok = t('common.confirm') } = {}) =>
  modal({ title, body: `<p>${text}</p>`, ico: danger ? 'alert' : 'info', tone: danger ? 'danger' : '', buttons: [{ label: t('common.cancel'), value: false }, { label: ok, value: true, cls: danger ? 'danger' : '' }] });

function promptDialog(title, { label = '', placeholder = '', value = '', help = '', ltr = false } = {}) {
  return modal({
    title,
    body: `<form>${field(label, `<input id="pd" class="${ltr ? 'ltr' : ''}" value="${esc(value)}" placeholder="${esc(placeholder)}">`, help)}</form>`,
    buttons: [{ label: t('common.cancel'), value: null }, { label: t('common.confirm'), value: (w) => $('#pd', w).value.trim() }],
  });
}

function otpDialog(message) {
  return modal({
    title: t('otp.title'), ico: 'shield',
    body: `<form class="stack"><p>${esc(message || t('otp.prompt'))}</p><input id="otp" class="otp-input" inputmode="numeric" autocomplete="one-time-code" maxlength="6" aria-label="${esc(t('auth.otp'))}"></form>`,
    buttons: [{ label: t('common.cancel'), value: null }, { label: t('common.confirm'), value: (w) => $('#otp', w).value.trim() }],
    onOpen: (w) => {
      const i = $('#otp', w);
      i.addEventListener('input', () => { i.value = i.value.replace(/\D/g, ''); if (i.value.length === 6) w.querySelector('.modal-foot .btn:last-child').click(); });
    },
  });
}

// ------------------------------------------------------------------ API
/** JSON API call. When the server asks for a two-factor code, asks for it and retries. */
async function api(method, path, body, otp) {
  const opts = { method, headers: {}, credentials: 'same-origin' };
  if (otp) opts.headers['x-otp'] = otp;
  if (method !== 'GET') { opts.headers['content-type'] = 'application/json'; opts.body = JSON.stringify(body ?? {}); }
  const res = await fetch(path, opts);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const code = data?.error?.code;
    if (code === 'otp_required' || (code === 'otp_invalid' && otp)) {
      const entered = await otpDialog(code === 'otp_invalid' ? t('otp.wrong') : undefined);
      if (entered) return api(method, path, body, entered);
    }
    const err = new Error(data?.error?.message || `HTTP ${res.status}`);
    err.status = res.status;
    err.code = code;
    throw err;
  }
  return data;
}

// ------------------------------------------------------------------ building blocks
function copyField(value, { lg = false, label = t('common.copy') } = {}) {
  return `<div class="copy ${lg ? 'lg' : ''}"><span class="mono">${esc(value)}</span><button type="button" class="btn sm secondary" data-copy="${esc(value)}">${icon('copy')}${esc(label)}</button></div>`;
}
document.addEventListener('click', (e) => {
  const b = e.target.closest('[data-copy]');
  if (!b) return;
  navigator.clipboard?.writeText(b.dataset.copy).then(() => toast(t('common.copied')), () => toast(b.dataset.copy));
});

/** Table with an empty state. `rows` are arrays of HTML cells; `align` marks end-aligned (numeric) columns. */
function table(headers, rows, { empty = t('common.empty'), emptyIcon = 'inbox', end = [] } = {}) {
  if (!rows.length) return `<div class="empty">${icon(emptyIcon)}<div>${esc(empty)}</div></div>`;
  const cls = (i) => (end.includes(i) ? ' class="t-end"' : '');
  return `<div class="table-wrap"><table><thead><tr>${headers.map((h, i) => `<th${cls(i)}>${h}</th>`).join('')}</tr></thead>
    <tbody>${rows.map((r) => `<tr>${r.map((c, i) => `<td${cls(i)}>${c ?? ''}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`;
}

const panel = ({ title, desc = '', actions = '', body, flush = false, id = '' }) =>
  `<section class="panel" ${id ? `id="${id}"` : ''}>${title ? `<div class="panel-head"><div><h2>${title}</h2>${desc ? `<div class="desc">${desc}</div>` : ''}</div>${actions ? `<div class="actions">${actions}</div>` : ''}</div>` : ''}
   <div class="panel-body ${flush ? 'flush' : ''}">${body}</div></section>`;

/** Summary strip. items: [{ label, value, unit?, hint?, ico?, tone? ('tone-warn'|'tone-err') }] */
/** tone: 'tone-warn' | 'tone-err' colours the value. */
const stats = (items) =>
  `<div class="stats" style="--cols:${items.length}">${items.map((s) => `<div class="stat ${s.tone || ''}">
    <div class="label">${s.ico ? icon(s.ico) : ''}${esc(s.label)}</div>
    <div><span class="value">${s.value}</span>${s.unit ? `<span class="unit">${esc(s.unit)}</span>` : ''}</div>
    ${s.hint ? `<div class="hint">${s.hint}</div>` : ''}</div>`).join('')}</div>`;

const field = (label, input, help = '') => `<label class="field"><span>${label}</span>${input}${help ? `<span class="help">${help}</span>` : ''}</label>`;
const alertBox = (kind, html, ico) => `<div class="alert ${kind}" role="${kind === 'err' ? 'alert' : 'note'}">${icon(ico || (kind === 'ok' ? 'checkCircle' : kind === 'info' ? 'info' : 'alert'))}<div>${html}</div></div>`;
const loading = () => `<div class="panel"><div class="panel-body stack"><div class="skeleton" style="width:30%"></div><div class="skeleton"></div><div class="skeleton" style="width:75%"></div></div></div>`;
const formData = (form) => Object.fromEntries(new FormData(form).entries());
const tabsBar = (tabs, active) => `<div class="tabs" role="tablist">${tabs.map(([k, label]) => `<button role="tab" data-tab="${esc(k)}" class="${k === active ? 'active' : ''}" aria-selected="${k === active}">${esc(label)}</button>`).join('')}</div>`;

/** Runs `fn` with the button disabled; errors become a toast. */
async function busy(btn, fn) {
  const old = btn?.innerHTML;
  if (btn) { btn.disabled = true; btn.innerHTML = esc(t('common.wait')); }
  try { return await fn(); }
  catch (e) { toast(errText(e), 'err'); }
  finally { if (btn && btn.isConnected) { btn.disabled = false; btn.innerHTML = old; } }
}

// ------------------------------------------------------------------ bar chart (one series, daily)
/**
 * Daily bars anchored to a zero baseline, a faint grid with "nice" ticks, a hover tooltip per day.
 * data: [{ day: 'YYYY-MM-DD', volume, paid }]. Time runs left→right in both languages.
 */
function barChart(el, data) {
  const draw = () => {
    const W = Math.max(280, el.clientWidth), H = 190, padL = 44, padR = 8, padT = 10, padB = 24;
    const max = Math.max(...data.map((d) => d.volume), 0);
    const step = niceStep(max / 3 || 1);
    const top = Math.max(step * 3, step * Math.ceil(max / step));
    const y = (v) => padT + (H - padT - padB) * (1 - v / top);
    const slot = (W - padL - padR) / data.length;
    const bw = Math.max(4, Math.min(28, slot - 6));
    const ticks = []; for (let v = 0; v <= top + 1e-9; v += step) ticks.push(v);
    const labelEvery = Math.ceil(data.length / Math.max(2, Math.floor((W - padL) / 64)));
    const bars = data.map((d, i) => {
      const x = padL + i * slot + (slot - bw) / 2;
      const h = Math.max(d.volume > 0 ? 2 : 1, y(0) - y(d.volume));
      const r = Math.min(4, bw / 2, h);
      const yTop = y(0) - h;
      // rounded top corners only; flat on the baseline
      const path = `M${x},${y(0)} V${yTop + r} Q${x},${yTop} ${x + r},${yTop} H${x + bw - r} Q${x + bw},${yTop} ${x + bw},${yTop + r} V${y(0)} Z`;
      return `<rect class="hit" data-i="${i}" x="${padL + i * slot}" y="${padT}" width="${slot}" height="${H - padT - padB}"></rect>
        <path class="bar ${d.volume > 0 ? '' : 'zero'}" data-bar="${i}" d="${path}"><title>${fmtDay(d.day)}: ${d.volume}</title></path>
        ${(data.length - 1 - i) % labelEvery === 0 ? `<text class="axis-label" x="${x + bw / 2}" y="${H - 6}" text-anchor="middle">${esc(fmtDay(d.day))}</text>` : ''}`;
    }).join('');
    el.innerHTML = `<svg viewBox="0 0 ${W} ${H}" height="${H}" role="img" aria-label="${esc(t('ch.volume'))}" style="direction:ltr">
      ${ticks.map((v) => `<line class="grid-line" x1="${padL}" x2="${W - padR}" y1="${y(v)}" y2="${y(v)}"></line><text class="axis-label" x="${padL - 8}" y="${y(v) + 4}" text-anchor="end">${compact(v)}</text>`).join('')}
      ${bars}</svg><div class="chart-tip hidden"></div>`;
    const tip = $('.chart-tip', el);
    $$('.hit', el).forEach((h) => {
      h.addEventListener('mouseenter', () => {
        const i = Number(h.dataset.i), d = data[i];
        $$('.bar', el).forEach((b) => b.classList.toggle('hover', b.dataset.bar === String(i)));
        tip.innerHTML = `${esc(fmtDay(d.day))} · <b>$${esc(fmtAmount(d.volume.toFixed(2), 2))}</b> · ${esc(t('ch.paid', { n: d.paid }))}`;
        tip.style.left = `${((padL + i * slot + slot / 2) / W) * 100}%`;
        tip.style.top = `${y(d.volume)}px`;
        tip.classList.remove('hidden');
      });
      h.addEventListener('mouseleave', () => { tip.classList.add('hidden'); $$('.bar', el).forEach((b) => b.classList.remove('hover')); });
    });
  };
  draw();
  let last = el.clientWidth;
  const ro = new ResizeObserver(() => { if (Math.abs(el.clientWidth - last) > 4) { last = el.clientWidth; draw(); } });
  ro.observe(el);
}
function niceStep(raw) {
  const p = 10 ** Math.floor(Math.log10(raw));
  const n = raw / p;
  return (n <= 1 ? 1 : n <= 2 ? 2 : n <= 5 ? 5 : 10) * p;
}
function compact(v) { return v >= 1e6 ? `${+(v / 1e6).toFixed(1)}M` : v >= 1e3 ? `${+(v / 1e3).toFixed(1)}k` : String(+v.toFixed(2)); }

function volumePanel(data) {
  const total = data.reduce((s, d) => s + d.volume, 0);
  const id = `chart-${Math.random().toString(36).slice(2)}`;
  setTimeout(() => { const el = document.getElementById(id); if (el) barChart(el, data); });
  return panel({
    title: t('ch.volume'), desc: t('ch.volumeSub'),
    actions: `<div style="text-align:end"><div class="eyebrow">${esc(t('ch.total'))}</div><div class="chart-total">$${esc(fmtAmount(total.toFixed(2), 2))}</div></div>`,
    body: `<div class="chart" id="${id}"></div>`,
  });
}

// ------------------------------------------------------------------ app shell
/**
 * Sidebar + topbar; routes between views by hash (#invoices …).
 * nav: [{ id, label, icon } | { section }]; views: { id: async (el, ctx) => {} }
 */
function createShell({ subtitle, nav, views, user, onLogout }) {
  document.body.innerHTML = `
    <div class="shell">
      <aside class="sidebar" id="sidebar" aria-label="${esc(subtitle)}">
        <div class="brand"><div class="brand-mark">${icon('bolt')}</div><div><div class="brand-name">TrafxPayment</div><div class="brand-sub">${esc(subtitle)}</div></div></div>
        <nav class="nav" id="nav">${nav.map((n) => (n.section ? `<div class="nav-label eyebrow">${esc(n.section)}</div>` : `<button data-view="${n.id}">${icon(n.icon)}<span>${esc(n.label)}</span><span class="count hidden" id="count-${n.id}"></span></button>`)).join('')}</nav>
        <div class="sidebar-foot">
          ${langSwitch('btn ghost sm')}
          <div class="user-chip"><div class="avatar">${esc((user.name || '?').slice(0, 1).toUpperCase())}</div>
            <div class="who"><b>${esc(user.name)}</b><span>${esc(user.role)}</span></div>
            <button class="btn ghost icon" id="logout" title="${esc(t('common.logout'))}" aria-label="${esc(t('common.logout'))}">${icon('logout')}</button></div>
        </div>
      </aside>
      <main class="main">
        <header class="topbar">
          <button class="btn ghost icon menu-btn" id="menu" aria-label="menu">${icon('menu')}</button>
          <div class="titles"><h1 id="page-title"></h1><div class="sub" id="page-sub"></div></div>
          <div class="actions" id="page-actions"></div>
        </header>
        <div class="content" id="view"></div>
      </main>
    </div>`;
  const sidebar = $('#sidebar');
  const closeMenu = () => { sidebar.classList.remove('open'); $('.scrim')?.remove(); };
  $('#menu').addEventListener('click', () => { sidebar.classList.add('open'); const s = document.createElement('div'); s.className = 'scrim'; s.onclick = closeMenu; document.body.append(s); });
  $('#logout').addEventListener('click', onLogout);

  const ctx = {
    setHeader(title, sub = '', actions = '') { $('#page-title').textContent = title; $('#page-sub').innerHTML = sub; $('#page-actions').innerHTML = actions; document.title = `${title} · TrafxPayment`; },
    setCount(id, n) { const c = $(`#count-${id}`); if (c) { c.textContent = n; c.classList.toggle('hidden', !n); } },
    go(id) { if (location.hash === `#${id}`) render(); else location.hash = id; },
    refresh() { render(); },
  };
  async function render() {
    const first = nav.find((n) => n.id).id;
    const id = views[location.hash.slice(1)] ? location.hash.slice(1) : first;
    $$('#nav button').forEach((b) => { b.classList.toggle('active', b.dataset.view === id); b.toggleAttribute('aria-current', b.dataset.view === id); });
    ctx.setHeader(nav.find((n) => n.id === id)?.label || '');
    const el = $('#view');
    el.innerHTML = loading();
    closeMenu();
    try { await views[id](el, ctx); }
    catch (e) {
      if (e.status === 401 && e.code === 'unauthorized') return location.reload();
      el.innerHTML = alertBox('err', esc(errText(e)));
    }
  }
  $('#nav').addEventListener('click', (e) => { const b = e.target.closest('[data-view]'); if (b) ctx.go(b.dataset.view); });
  window.addEventListener('hashchange', render);
  render();
  return ctx;
}

/** Full-page sign-in with an optional 2FA step. Resolves after a successful sign-in. */
function loginScreen({ title, pitch, role }) {
  return new Promise((resolve) => {
    document.title = `${title} · TrafxPayment`;
    document.body.innerHTML = `
      <div class="auth">
        <div class="auth-side">
          <div class="brand" style="padding:0"><div class="brand-mark">${icon('bolt')}</div><div><div class="brand-name">TrafxPayment</div><div class="brand-sub">${esc(t('app.tagline'))}</div></div></div>
          <div class="stack" style="gap:28px">
            <h2>${esc(pitch)}</h2>
            <div class="receipt" dir="ltr">
              <div class="r-ok">${icon('checkCircle')}${esc(t('auth.mockTitle'))}</div>
              <div class="r-row"><span>Amount</span><b>249.90 USDT</b></div>
              <div class="r-row"><span>Network</span><b>TRON · TRC20</b></div>
              <div class="r-row"><span>Tx</span><b>7f3a…c91e</b></div>
              <div class="r-row"><span>19/19 ${esc(t('auth.mockConf'))}</span><b>✓</b></div>
              <div class="r-bar"></div>
            </div>
          </div>
          <div class="small" style="opacity:.55">© TrafxPayment</div>
        </div>
        <div class="auth-form">
          <div class="lang">${langSwitch('btn ghost sm')}</div>
          <form class="auth-card" id="lf" novalidate>
            <div><h1>${esc(title)}</h1><p class="muted">${esc(t('auth.continue'))}</p></div>
            ${field(t('auth.email'), '<input id="email" name="email" type="email" class="ltr" required autocomplete="username">')}
            ${field(t('auth.password'), '<input id="password" name="password" type="password" class="ltr" required autocomplete="current-password">')}
            <div id="otp-wrap" class="hidden">${field(t('auth.otp'), '<input id="otp" name="otp" class="otp-input" inputmode="numeric" maxlength="6" autocomplete="one-time-code">', t('auth.otpHelp'))}</div>
            <div id="lmsg"></div>
            <button class="btn block">${esc(t('auth.login'))}</button>
          </form>
        </div>
      </div>`;
    $('#lf').addEventListener('submit', async (e) => {
      e.preventDefault();
      const d = formData(e.target);
      if (!d.otp) delete d.otp;
      const btn = e.submitter || $('#lf .btn.block');
      btn.disabled = true;
      try {
        const res = await fetch('/api/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ...d, role }) });
        const data = await res.json().catch(() => ({}));
        if (res.ok) return resolve();
        const code = data?.error?.code;
        if (code === 'otp_required' || code === 'otp_invalid') { $('#otp-wrap').classList.remove('hidden'); $('#otp').value = ''; $('#otp').focus(); }
        $('#lmsg').innerHTML = code === 'otp_required' ? alertBox('info', esc(t('auth.otpNeeded'))) : alertBox('err', esc(errText({ code, message: data?.error?.message })));
      } finally { btn.disabled = false; }
    });
  });
}

/** 2FA settings block shared by both panels. base = '/api/panel' | '/api/admin'. */
async function twoFactorSection(el, base, onChange) {
  const { enabled } = await api('GET', `${base}/2fa`);
  el.innerHTML = enabled
    ? `<div class="stack">${alertBox('ok', t('tfa.on'), 'shield')}<div><button class="btn danger-soft" id="tfa-off">${esc(t('tfa.disable'))}</button></div></div>`
    : `<div class="stack">${alertBox('warn', t('tfa.off'))}<div><button class="btn" id="tfa-on">${icon('shield')}${esc(t('tfa.enable'))}</button></div></div>`;
  $('#tfa-on', el)?.addEventListener('click', (e) => busy(e.currentTarget, async () => {
    const s = await api('POST', `${base}/2fa/setup`);
    const code = await modal({
      title: t('tfa.setupTitle'), ico: 'shield',
      body: `<form class="stack"><ol class="small" style="margin:0;padding-inline-start:18px;display:grid;gap:2px"><li>${esc(t('tfa.step1'))}</li><li>${esc(t('tfa.step2'))}</li><li>${esc(t('tfa.step3'))}</li></ol>
        <img src="${s.qr}" width="176" height="176" style="display:block;margin:0 auto;background:#fff;border-radius:10px;padding:6px" alt="QR">
        ${copyField(s.secret)}<input id="otp" class="otp-input" inputmode="numeric" maxlength="6" aria-label="${esc(t('auth.otp'))}"></form>`,
      buttons: [{ label: t('common.cancel'), value: null }, { label: t('tfa.enable'), value: (w) => $('#otp', w).value.trim() }],
    });
    if (!code) return;
    await api('POST', `${base}/2fa/enable`, { code });
    toast(t('tfa.enabled'));
    onChange?.();
  }));
  $('#tfa-off', el)?.addEventListener('click', async () => {
    const code = await otpDialog(t('tfa.disablePrompt'));
    if (!code) return;
    try { await api('POST', `${base}/2fa/disable`, { code }); toast(t('tfa.disabledToast')); onChange?.(); } catch (e) { toast(errText(e), 'err'); }
  });
}

function auditTable(rows) {
  return table([t('au.time'), t('au.event'), t('au.actor'), t('au.ip'), t('au.details')], rows.map((r) => [
    `<span class="small text-2">${fmtDate(r.created_at)}</span>`,
    `<b>${esc(I18N[LANG]['au.' + r.action] ? t('au.' + r.action) : r.action)}</b>`,
    `<span class="badge plain b-muted">${esc(r.actor_type)}</span>`,
    `<span class="num small">${esc(r.ip || '—')}</span>`,
    `<span class="mono small muted">${esc(short(JSON.stringify(r.details || {}), 36))}</span>`,
  ]), { empty: t('au.empty') });
}
