// Shared helpers for the payment page and the panels.
const $ = (sel, root = document) => root.querySelector(sel);
const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

async function api(method, path, body) {
  const opts = { method, headers: {}, credentials: 'same-origin' };
  if (body !== undefined) {
    opts.headers['content-type'] = 'application/json';
    opts.body = JSON.stringify(body);
  } else if (method !== 'GET') {
    opts.headers['content-type'] = 'application/json';
    opts.body = '{}';
  }
  const res = await fetch(path, opts);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(data?.error?.message || `HTTP ${res.status}`);
    err.status = res.status;
    throw err;
  }
  return data;
}

const STATUS_FA = {
  pending: 'در انتظار پرداخت', confirming: 'در حال تایید', partially_paid: 'پرداخت ناقص', paid: 'پرداخت شده',
  expired: 'منقضی', cancelled: 'لغو شده', pending_approval: 'در انتظار تایید', approved: 'تایید شده',
  sending: 'در حال ارسال', sent: 'ارسال شده', completed: 'تکمیل شده', failed: 'ناموفق', rejected: 'رد شده',
  confirmed: 'تایید شده', orphaned: 'نامعتبر', delivered: 'تحویل شده',
};
const LEDGER_FA = { payment: 'دریافت', fee: 'کارمزد', payout: 'تسویه', payout_reversal: 'برگشت تسویه', adjustment: 'اصلاحیه' };
const SCHEDULE_FA = { daily: 'روزانه', weekly: 'هفتگی', manual: 'دستی (درخواستی)' };
const WEEKDAYS_FA = ['یکشنبه', 'دوشنبه', 'سه‌شنبه', 'چهارشنبه', 'پنجشنبه', 'جمعه', 'شنبه'];

const badge = (s) => `<span class="badge s-${esc(s)}">${esc(STATUS_FA[s] || s)}</span>`;
const fmtDate = (d) => (d ? new Date(d).toLocaleString('fa-IR') : '—');
const short = (s, n = 8) => (s && s.length > n * 2 + 3 ? `${s.slice(0, n)}…${s.slice(-n)}` : s || '');

function copyBox(value) {
  return `<div class="copy"><span class="mono">${esc(value)}</span><button class="small secondary" data-copy="${esc(value)}">کپی</button></div>`;
}
document.addEventListener('click', (e) => {
  const b = e.target.closest('[data-copy]');
  if (!b) return;
  navigator.clipboard.writeText(b.dataset.copy).then(() => {
    const t = b.textContent;
    b.textContent = 'کپی شد';
    setTimeout(() => (b.textContent = t), 1200);
  });
});

function table(headers, rows) {
  if (!rows.length) return '<p class="muted">موردی وجود ندارد.</p>';
  return `<div class="table-wrap"><table><thead><tr>${headers.map((h) => `<th>${h}</th>`).join('')}</tr></thead><tbody>${rows
    .map((r) => `<tr>${r.map((c) => `<td>${c}</td>`).join('')}</tr>`)
    .join('')}</tbody></table></div>`;
}

function showMsg(el, text, kind = 'err') {
  el.innerHTML = text ? `<div class="alert ${kind}">${esc(text)}</div>` : '';
}

function formData(form) {
  return Object.fromEntries(new FormData(form).entries());
}

function tabs(root, names, onShow) {
  root.innerHTML = names.map(([id, label]) => `<button data-tab="${id}">${label}</button>`).join('');
  const show = (id) => {
    root.querySelectorAll('button').forEach((b) => b.classList.toggle('active', b.dataset.tab === id));
    try { localStorage.setItem(root.id + ':tab', id); } catch {}
    onShow(id);
  };
  root.addEventListener('click', (e) => e.target.dataset.tab && show(e.target.dataset.tab));
  let initial = names[0][0];
  try { initial = localStorage.getItem(root.id + ':tab') || initial; } catch {}
  show(names.some((n) => n[0] === initial) ? initial : names[0][0]);
  return show;
}
