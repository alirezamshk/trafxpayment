// Shared UI kit for the payment page and both panels (no build step, no framework).
'use strict';

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

// ------------------------------------------------------------------ icons (stroke, 24x24)
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
  pay: '<rect x="2" y="5" width="20" height="14" rx="2"/><path d="M2 10h20M6 15h4"/>',
};
const icon = (name, cls = '') => `<svg class="i ${cls}" viewBox="0 0 24 24" aria-hidden="true">${ICONS[name] || ''}</svg>`;

// ------------------------------------------------------------------ labels & formatting
const STATUS = {
  pending: ['در انتظار پرداخت', 'b-warn'], confirming: ['در حال تایید', 'b-info'], partially_paid: ['پرداخت ناقص', 'b-warn'],
  paid: ['پرداخت شده', 'b-ok'], expired: ['منقضی', 'b-muted'], cancelled: ['لغو شده', 'b-muted'],
  pending_approval: ['در انتظار تایید', 'b-warn'], approved: ['تایید شده', 'b-info'], sending: ['در حال ارسال', 'b-info'],
  sent: ['ارسال شده', 'b-info'], completed: ['تکمیل شده', 'b-ok'], failed: ['ناموفق', 'b-err'], rejected: ['رد شده', 'b-err'],
  confirmed: ['تایید شده', 'b-ok'], orphaned: ['نامعتبر', 'b-err'], delivered: ['تحویل شده', 'b-ok'],
};
const LEDGER = { payment: 'دریافت', fee: 'کارمزد درگاه', network_fee: 'کارمزد شبکه واریز', payout: 'تسویه', payout_fee: 'کارمزد شبکه تسویه', payout_reversal: 'برگشت تسویه', adjustment: 'اصلاحیه' };
const SCHEDULE = { daily: 'روزانه', weekly: 'هفتگی', manual: 'دستی (درخواستی)' };
const WEEKDAYS = ['یکشنبه', 'دوشنبه', 'سه‌شنبه', 'چهارشنبه', 'پنجشنبه', 'جمعه', 'شنبه'];
const NETWORK = { tron: 'TRON', ethereum: 'Ethereum', bsc: 'BNB Chain', polygon: 'Polygon', ton: 'TON' };

const badge = (s) => { const [t, c] = STATUS[s] || [s, 'b-muted']; return `<span class="badge ${c}">${esc(t)}</span>`; };
const fmtDate = (d) => (d ? new Date(d).toLocaleString('fa-IR', { dateStyle: 'medium', timeStyle: 'short' }) : '—');
const fmtDateShort = (d) => (d ? new Date(d).toLocaleDateString('fa-IR') : '—');
const short = (s, n = 6) => (s && s.length > n * 2 + 3 ? `${s.slice(0, n)}…${s.slice(-n)}` : s || '');
const num = (v) => `<span class="num">${esc(v ?? '—')}</span>`;
const fmtAmount = (v, maxFrac = 6) => {
  if (v === null || v === undefined || v === '') return '—';
  const neg = String(v).startsWith('-');
  const [w, f = ''] = String(v).replace('-', '').split('.');
  const whole = w.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  const frac = f.slice(0, maxFrac).replace(/0+$/, '');
  return (neg ? '-' : '') + (frac ? `${whole}.${frac}` : whole);
};
const assetLabel = (id) => {
  const [sym, std] = String(id || '').split('_');
  return std ? `${esc(sym)} <span class="muted small">${esc(std)}</span>` : esc(sym);
};

// ------------------------------------------------------------------ toast & modal
function toast(message, kind = 'ok') {
  let host = $('.toasts');
  if (!host) { host = document.createElement('div'); host.className = 'toasts'; document.body.append(host); }
  const t = document.createElement('div');
  t.className = `toast ${kind}`;
  t.innerHTML = `${icon(kind === 'err' ? 'alert' : 'checkCircle')}<span>${esc(message)}</span>`;
  host.append(t);
  setTimeout(() => t.remove(), 4200);
}

/** Generic modal. `body` is HTML; resolves with the clicked button's value (or null when dismissed). */
function modal({ title, body = '', ico = 'info', buttons = [{ label: 'باشه', value: true }], onOpen }) {
  return new Promise((resolve) => {
    const wrap = document.createElement('div');
    wrap.className = 'modal-backdrop';
    wrap.innerHTML = `<div class="modal" role="dialog" aria-modal="true">
      <div class="modal-head"><div class="ico">${icon(ico)}</div><h3>${esc(title)}</h3></div>
      <div class="modal-body">${body}</div>
      <div class="modal-foot">${buttons.map((b, i) => `<button class="btn ${b.cls || (i === buttons.length - 1 ? '' : 'secondary')}" data-i="${i}">${esc(b.label)}</button>`).join('')}</div>
    </div>`;
    const close = (v) => { wrap.remove(); document.removeEventListener('keydown', onKey); resolve(v); };
    const onKey = (e) => { if (e.key === 'Escape') close(null); };
    wrap.addEventListener('click', (e) => {
      if (e.target === wrap) return close(null);
      const b = e.target.closest('[data-i]');
      if (!b) return;
      const def = buttons[Number(b.dataset.i)];
      close(typeof def.value === 'function' ? def.value(wrap) : def.value);
    });
    document.addEventListener('keydown', onKey);
    document.body.append(wrap);
    onOpen?.(wrap);
    const first = wrap.querySelector('input, select, textarea');
    (first || wrap.querySelector('.modal-foot .btn:last-child'))?.focus();
  });
}

const confirmDialog = (title, text, { danger = false, ok = 'تایید' } = {}) =>
  modal({ title, body: `<p>${text}</p>`, ico: danger ? 'alert' : 'info', buttons: [{ label: 'انصراف', value: false }, { label: ok, value: true, cls: danger ? 'danger' : '' }] });

function promptDialog(title, { label = '', placeholder = '', value = '', help = '' } = {}) {
  return modal({
    title,
    body: `<label class="field"><span>${esc(label)}</span><input id="pd" value="${esc(value)}" placeholder="${esc(placeholder)}">${help ? `<span class="help">${help}</span>` : ''}</label>`,
    buttons: [{ label: 'انصراف', value: null }, { label: 'تایید', value: (w) => $('#pd', w).value.trim() }],
    onOpen: (w) => $('#pd', w).addEventListener('keydown', (e) => e.key === 'Enter' && w.querySelector('.modal-foot .btn:last-child').click()),
  });
}

function otpDialog(message) {
  return modal({
    title: 'تایید دومرحله‌ای',
    ico: 'shield',
    body: `<p>${esc(message || 'کد ۶ رقمی برنامه Google Authenticator را وارد کنید.')}</p>
      <input id="otp" class="otp-input" inputmode="numeric" autocomplete="one-time-code" maxlength="6" placeholder="••••••">`,
    buttons: [{ label: 'انصراف', value: null }, { label: 'تایید', value: (w) => $('#otp', w).value.trim() }],
    onOpen: (w) => {
      const i = $('#otp', w);
      i.addEventListener('input', () => { i.value = i.value.replace(/\D/g, ''); if (i.value.length === 6) w.querySelector('.modal-foot .btn:last-child').click(); });
    },
  });
}

// ------------------------------------------------------------------ API
/** JSON API call. If the server asks for a two-factor code, asks the user and retries. */
async function api(method, path, body, otp) {
  const opts = { method, headers: {}, credentials: 'same-origin' };
  if (otp) opts.headers['x-otp'] = otp;
  if (method !== 'GET') {
    opts.headers['content-type'] = 'application/json';
    opts.body = JSON.stringify(body ?? {});
  }
  const res = await fetch(path, opts);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const code = data?.error?.code;
    if (code === 'otp_required' || (code === 'otp_invalid' && otp)) {
      const entered = await otpDialog(code === 'otp_invalid' ? 'کد نادرست یا تکراری بود. کد جدید را وارد کنید.' : undefined);
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
function copyField(value, { lg = false, label = 'کپی' } = {}) {
  return `<div class="copy ${lg ? 'lg' : ''}"><span class="mono">${esc(value)}</span><button type="button" class="btn sm secondary" data-copy="${esc(value)}">${icon('copy')}${esc(label)}</button></div>`;
}
document.addEventListener('click', (e) => {
  const b = e.target.closest('[data-copy]');
  if (!b) return;
  navigator.clipboard.writeText(b.dataset.copy).then(() => toast('کپی شد'));
});

/** Table with an empty state. `rows` are arrays of HTML cells. */
function table(headers, rows, { empty = 'موردی وجود ندارد', emptyIcon = 'inbox' } = {}) {
  if (!rows.length) return `<div class="empty">${icon(emptyIcon)}<div>${esc(empty)}</div></div>`;
  return `<div class="table-wrap"><table><thead><tr>${headers.map((h) => `<th>${h}</th>`).join('')}</tr></thead>
    <tbody>${rows.map((r) => `<tr>${r.map((c) => `<td>${c ?? ''}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`;
}

const card = ({ title, desc = '', actions = '', body, flush = false, id = '' }) =>
  `<section class="card" ${id ? `id="${id}"` : ''}>${title ? `<div class="card-head"><div><h2>${title}</h2>${desc ? `<div class="desc">${desc}</div>` : ''}</div><div class="actions">${actions}</div></div>` : ''}
   <div class="card-body ${flush ? 'flush' : ''}">${body}</div></section>`;

const kpi = ({ label, value, unit = '', hint = '', ico = 'trend', tone = '' }) =>
  `<div class="kpi"><div class="label"><span class="ico ${tone}">${icon(ico)}</span>${esc(label)}</div>
   <div class="value">${value}${unit ? `<small>${esc(unit)}</small>` : ''}</div>${hint ? `<div class="hint">${hint}</div>` : ''}</div>`;

const field = (label, input, help = '') => `<label class="field"><span>${label}</span>${input}${help ? `<span class="help">${help}</span>` : ''}</label>`;
const alertBox = (kind, html, ico) => `<div class="alert ${kind}">${icon(ico || (kind === 'ok' ? 'checkCircle' : kind === 'info' ? 'info' : 'alert'))}<div>${html}</div></div>`;
const loading = () => `<div class="card"><div class="card-body stack"><div class="skeleton" style="width:40%"></div><div class="skeleton"></div><div class="skeleton" style="width:80%"></div></div></div>`;

function formData(form) { return Object.fromEntries(new FormData(form).entries()); }

/** Runs `fn` with the button disabled; shows errors as a toast. */
async function busy(btn, fn) {
  const old = btn?.innerHTML;
  if (btn) { btn.disabled = true; btn.innerHTML = 'لطفاً صبر کنید…'; }
  try { return await fn(); }
  catch (e) { toast(e.message, 'err'); }
  finally { if (btn && btn.isConnected) { btn.disabled = false; btn.innerHTML = old; } }
}

// ------------------------------------------------------------------ app shell (panels)
/**
 * Renders sidebar + topbar and routes between views by hash (#invoices ...).
 * nav: [{ id, label, icon } | { section }]; views: { id: async (el, ctx) => {} }
 */
function createShell({ product, subtitle, nav, views, user, onLogout }) {
  document.body.innerHTML = `
    <div class="shell">
      <aside class="sidebar" id="sidebar">
        <div class="brand"><div class="brand-logo">${icon('bolt')}</div><div>${esc(product)}<small>${esc(subtitle)}</small></div></div>
        <nav class="nav" id="nav">${nav.map((n) => (n.section ? `<div class="nav-label">${esc(n.section)}</div>` : `<button data-view="${n.id}">${icon(n.icon)}<span>${esc(n.label)}</span><span class="count hidden" id="count-${n.id}"></span></button>`)).join('')}</nav>
        <div class="sidebar-foot">
          <div class="user-chip"><div class="avatar">${esc((user.name || '?').slice(0, 1).toUpperCase())}</div>
            <div class="who"><b>${esc(user.name)}</b><span>${esc(user.role)}</span></div>
            <button class="btn ghost icon" id="logout" title="خروج">${icon('logout')}</button></div>
        </div>
      </aside>
      <main class="main">
        <header class="topbar">
          <button class="btn ghost icon menu-btn" id="menu">${icon('menu')}</button>
          <div><h1 id="page-title"></h1><div class="sub" id="page-sub"></div></div>
          <div class="actions" id="page-actions"></div>
        </header>
        <div class="content" id="view"></div>
      </main>
    </div>`;
  const sidebar = $('#sidebar');
  const closeMenu = () => { sidebar.classList.remove('open'); $('.scrim')?.remove(); };
  $('#menu').addEventListener('click', () => {
    sidebar.classList.add('open');
    const s = document.createElement('div'); s.className = 'scrim'; s.onclick = closeMenu; document.body.append(s);
  });
  $('#logout').addEventListener('click', onLogout);

  const ctx = {
    setHeader(title, sub = '', actions = '') { $('#page-title').textContent = title; $('#page-sub').innerHTML = sub; $('#page-actions').innerHTML = actions; },
    setCount(id, n) { const c = $(`#count-${id}`); if (c) { c.textContent = n; c.classList.toggle('hidden', !n); } },
    go(id) { if (location.hash === `#${id}`) render(); else location.hash = id; },
    refresh() { render(); },
  };
  async function render() {
    const first = nav.find((n) => n.id).id;
    const id = location.hash.slice(1) || first;
    $$('#nav button').forEach((b) => b.classList.toggle('active', b.dataset.view === id));
    const item = nav.find((n) => n.id === id);
    ctx.setHeader(item?.label || '');
    const el = $('#view');
    el.innerHTML = loading();
    closeMenu();
    try { await (views[id] || views[first])(el, ctx); }
    catch (e) {
      if (e.status === 401 && e.code === 'unauthorized') return location.reload();
      el.innerHTML = alertBox('err', esc(e.message));
    }
  }
  $('#nav').addEventListener('click', (e) => { const b = e.target.closest('[data-view]'); if (b) ctx.go(b.dataset.view); });
  window.addEventListener('hashchange', render);
  render();
  return ctx;
}

/** Full-page sign-in with optional 2FA step. Resolves after a successful login. */
function loginScreen({ title, subtitle, role, features }) {
  return new Promise((resolve) => {
    document.body.innerHTML = `
      <div class="auth">
        <div class="auth-side">
          <div class="brand" style="color:#fff"><div class="brand-logo" style="background:rgba(255,255,255,.18)">${icon('bolt')}</div><div>TrafxPayment<small style="color:rgba(255,255,255,.7)">Crypto payment gateway</small></div></div>
          <div><h2>${esc(subtitle)}</h2><ul>${features.map((f) => `<li>${icon('checkCircle')}${esc(f)}</li>`).join('')}</ul></div>
          <div class="small" style="opacity:.7">© TrafxPayment</div>
        </div>
        <div class="auth-form"><form class="auth-card stack" id="lf">
          <div><h1>${esc(title)}</h1><p class="muted">برای ادامه وارد شوید</p></div>
          ${field('ایمیل', '<input name="email" type="email" class="ltr" required autocomplete="username">')}
          ${field('رمز عبور', '<input name="password" type="password" class="ltr" required autocomplete="current-password">')}
          <div id="otp-wrap" class="hidden">${field('کد تایید دومرحله‌ای', '<input name="otp" class="otp-input" inputmode="numeric" maxlength="6" autocomplete="one-time-code">', 'کد ۶ رقمی Google Authenticator')}</div>
          <div id="lmsg"></div>
          <button class="btn block">ورود</button>
        </form></div>
      </div>`;
    $('#lf').addEventListener('submit', async (e) => {
      e.preventDefault();
      const d = formData(e.target);
      if (!d.otp) delete d.otp;
      const btn = e.submitter;
      btn.disabled = true;
      try {
        const res = await fetch('/api/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ...d, role }) });
        const data = await res.json().catch(() => ({}));
        if (res.ok) return resolve();
        const code = data?.error?.code;
        if (code === 'otp_required' || code === 'otp_invalid') {
          $('#otp-wrap').classList.remove('hidden');
          $('[name=otp]').value = '';
          $('[name=otp]').focus();
        }
        $('#lmsg').innerHTML = code === 'otp_required' ? alertBox('info', 'کد تایید دومرحله‌ای را وارد کنید.') : alertBox('err', esc(data?.error?.message || 'خطا در ورود'));
      } finally { btn.disabled = false; }
    });
  });
}

/** 2FA settings card body, shared by both panels. base = '/api/panel' | '/api/admin'. */
async function twoFactorSection(el, base, onChange) {
  const { enabled } = await api('GET', `${base}/2fa`);
  el.innerHTML = enabled
    ? `${alertBox('ok', 'تایید دومرحله‌ای <b>فعال</b> است. ورود و کارهای حساس به کد Google Authenticator نیاز دارند.', 'shield')}
       <div class="row" style="margin-top:12px"><button class="btn danger soft" id="tfa-off">غیرفعال کردن</button></div>`
    : `${alertBox('warn', 'تایید دومرحله‌ای <b>غیرفعال</b> است. برای امنیت حساب، حتماً فعالش کنید.')}
       <div class="row" style="margin-top:12px"><button class="btn" id="tfa-on">${icon('shield')}فعال‌سازی</button></div>`;
  $('#tfa-on', el)?.addEventListener('click', (e) => busy(e.currentTarget, async () => {
    const s = await api('POST', `${base}/2fa/setup`);
    const code = await modal({
      title: 'فعال‌سازی تایید دومرحله‌ای', ico: 'shield',
      body: `<ol class="small" style="padding-inline-start:18px;margin:0 0 10px">
          <li>برنامه Google Authenticator یا Authy را نصب کنید.</li>
          <li>این QR را اسکن کنید (یا کد زیر را دستی وارد کنید).</li>
          <li>کد ۶ رقمی را وارد کنید.</li></ol>
        <img src="${s.qr}" width="180" height="180" style="display:block;margin:6px auto;background:#fff;border-radius:10px;padding:6px" alt="QR">
        ${copyField(s.secret)}<div style="height:10px"></div>
        <input id="otp" class="otp-input" inputmode="numeric" maxlength="6" placeholder="••••••">`,
      buttons: [{ label: 'انصراف', value: null }, { label: 'فعال‌سازی', value: (w) => $('#otp', w).value.trim() }],
    });
    if (!code) return;
    await api('POST', `${base}/2fa/enable`, { code });
    toast('تایید دومرحله‌ای فعال شد');
    onChange?.();
  }));
  $('#tfa-off', el)?.addEventListener('click', async () => {
    const code = await otpDialog('برای غیرفعال‌سازی، کد فعلی را وارد کنید.');
    if (!code) return;
    try { await api('POST', `${base}/2fa/disable`, { code }); toast('غیرفعال شد'); onChange?.(); } catch (e) { toast(e.message, 'err'); }
  });
}

const AUDIT_FA = {
  login: 'ورود', 'login.failed': 'ورود ناموفق', '2fa.enabled': 'فعال‌سازی 2FA', '2fa.disabled': 'غیرفعال‌سازی 2FA',
  'settings.updated': 'تغییر تنظیمات', 'webhook_secret.rotated': 'تعویض کلید Webhook', 'password.changed': 'تغییر رمز',
  'payout.requested': 'درخواست تسویه', 'payout_address.set': 'ثبت آدرس تسویه', 'payout_address.deleted': 'حذف آدرس تسویه',
  'api_key.created': 'ساخت کلید API', 'api_key.revoked': 'ابطال کلید API', 'api_key.ips_changed': 'تغییر IPهای مجاز',
};
function auditTable(rows) {
  return table(['زمان', 'رویداد', 'کاربر', 'IP', 'جزئیات'], rows.map((r) => [
    fmtDate(r.created_at),
    `<b>${esc(AUDIT_FA[r.action] || r.action)}</b>`,
    `<span class="badge plain b-muted">${esc(r.actor_type)}</span>`,
    num(r.ip || '—'),
    `<span class="mono small muted">${esc(short(JSON.stringify(r.details || {}), 40))}</span>`,
  ]), { empty: 'رویدادی ثبت نشده' });
}
