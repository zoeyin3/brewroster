/* ============================================================
   Shared helpers: escaping, toasts, icons, clock, small formatters
   ============================================================ */
const APP = { role: null, profile: null, settings: null, tz: 'Australia/Sydney', clock0: null, busy: false };

function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (m) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[m]; }); }
function plural(n, a, b) { return n === 1 ? a : (b || a + 's'); }
function $(id) { return document.getElementById(id); }

function toast(msg, kind) {
  const t = $('toast'); if (!t) return;
  t.className = 'toast show ' + (kind || ''); t.textContent = msg;
  clearTimeout(toast._t); toast._t = setTimeout(function () { t.className = 'toast'; }, kind === 'bad' ? 6000 : 4200);
}
function errText(e) {
  if (!e) return 'Something went wrong.';
  let m = String(e.message || e);
  if (/staff_private_email_uq/.test(m)) m = 'Someone on the team already uses that email address.';
  else if (/violates row-level security/i.test(m)) m = 'You do not have permission to do that.';
  else if (/jwt expired|invalid jwt/i.test(m)) m = 'Your session has ended. Please sign in again.';
  return m.length > 220 ? m.slice(0, 220) + '…' : m;
}

/* ---------- clock (server time in the cafe's time zone) ---------- */
async function syncClock() {
  const c = await SB.rpc('cafe_clock');
  APP.clock0 = { today: c.today, minutes: c.minutes, t: performance.now() };
  if (c.timezone) APP.tz = c.timezone;
  applyClock();
}
function applyClock() {
  if (!APP.clock0) return;
  let m = APP.clock0.minutes + (performance.now() - APP.clock0.t) / 60000, d = APP.clock0.today;
  while (m >= 1440) { m -= 1440; d = addDays(d, 1); }
  setClock(d, m);
}
function clockText() {
  const m = Math.floor(NOW_HOUR * 60), h = Math.floor(m / 60);
  return h12(h) + ':' + String(m % 60).padStart(2, '0') + ' ' + ampm(h);
}
function greeting() { const h = Math.floor(NOW_HOUR); return h < 12 ? 'Good morning' : h < 17 ? 'Good afternoon' : 'Good evening'; }
function fmtAt(ts) {
  if (!ts) return '';
  const d = new Date(ts);
  try {
    const time = d.toLocaleTimeString('en-AU', { hour: 'numeric', minute: '2-digit', timeZone: APP.tz }).replace(/\s?([ap])m/i, function (m, x) { return ' ' + x.toLowerCase() + 'm'; });
    const day = d.toLocaleDateString('en-CA', { timeZone: APP.tz });
    return day === TODAY ? time : dLabel(day) + ', ' + time;
  } catch (e) { return ''; }
}
function weeksFrom(today) { const w0 = weekStartOf(today); return [w0, addDays(w0, 7), addDays(w0, 14), addDays(w0, 21)]; }

/* ---------- icons ---------- */
const ICONS = {
  home: '<path d="M3.5 9.5 10 4l6.5 5.5V16a1 1 0 0 1-1 1h-3.5v-4.5h-4V17H4.5a1 1 0 0 1-1-1z"/>',
  demand: '<path d="M4 16V9M10 16V4M16 16v-5"/>',
  leave: '<rect x="3" y="4.5" width="14" height="12" rx="2"/><path d="M3 8.5h14M7 3v3M13 3v3"/>',
  cover: '<path d="M4 4.5h12a1.5 1.5 0 0 1 1.5 1.5v6a1.5 1.5 0 0 1-1.5 1.5H9.5L6 16.5V13.5H4A1.5 1.5 0 0 1 2.5 12V6A1.5 1.5 0 0 1 4 4.5z"/>',
  roster: '<path d="M3 5h14M3 10h14M3 15h14"/><path d="M7 3v14M13 3v14" opacity=".45"/>',
  team: '<circle cx="8" cy="7" r="3"/><path d="M2.5 16c.5-3 2.7-4.5 5.5-4.5s5 1.5 5.5 4.5M14 4.5a2.6 2.6 0 0 1 0 5M15 11.8c1.6.6 2.6 2 2.9 4.2"/>',
  bot: '<path d="M10 2.5v2.2M5 7h10a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V9a2 2 0 0 1 2-2z"/><circle cx="7.6" cy="11.4" r=".6"/><circle cx="12.4" cy="11.4" r=".6"/>',
  shifts: '<rect x="3" y="4.5" width="14" height="12" rx="2"/><path d="M3 8.5h14M7 3v3M13 3v3M7.5 12.2l1.6 1.6 3.4-3.4"/>',
  open: '<path d="M4 4.5h12a1.5 1.5 0 0 1 1.5 1.5v6a1.5 1.5 0 0 1-1.5 1.5H9.5L6 16.5V13.5H4A1.5 1.5 0 0 1 2.5 12V6A1.5 1.5 0 0 1 4 4.5z"/>',
  me: '<circle cx="10" cy="7" r="3.2"/><path d="M3.8 16.5c.6-3.2 3-5 6.2-5s5.6 1.8 6.2 5"/>',
  chat: '<path d="M4 4.5h12a1 1 0 0 1 1 1v7a1 1 0 0 1-1 1H9.5L6 17v-3.5H4a1 1 0 0 1-1-1v-7a1 1 0 0 1 1-1z"/>',
  standby: '<path d="M5.2 14V9.2a4.8 4.8 0 0 1 9.6 0V14l1.4 1.5H3.8z"/><path d="M8.4 17.5a1.7 1.7 0 0 0 3.2 0"/>'
};
// the Brewroster mark: a cup with steam
function logo() { return '<span class="logo"><svg viewBox="0 0 32 32" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M7.5 13.5h13v5.2a5.8 5.8 0 0 1-5.8 5.8h-1.4a5.8 5.8 0 0 1-5.8-5.8z"/><path d="M20.5 15.2h1.5a2.8 2.8 0 0 1 0 5.6h-2"/><path d="M11.2 5.6c-1.3 1.5 1.3 2.8 0 4.4M16.2 5.6c-1.3 1.5 1.3 2.8 0 4.4"/></svg></span>'; }
function initialsOf(name) { return String(name || '?').split(/\s+/).filter(Boolean).map(function (w) { return w[0]; }).join('').slice(0, 2).toUpperCase() || '?'; }
// a short fade when someone switches tabs (not on background refreshes, which would flicker)
function swapAnim() { const v = $('view'); if (!v) return; v.classList.remove('swap'); void v.offsetWidth; v.classList.add('swap'); }
function openProfile() {
  const p = APP.profile || {}, u = SB.auth.user() || {}, name = p.display_name || u.email || '';
  const cafe = (APP.settings && APP.settings.cafe_name) || '';
  showModal('<div class="pf"><span class="avatar xl">' + esc(initialsOf(name)) + '</span><b>' + esc(name) + '</b><span class="muted">' + esc(u.email || '') + '</span>' +
    '<span class="chips" style="justify-content:center"><span class="chip">' + (APP.role === 'owner' ? 'Owner' : 'Employee') + '</span>' + (cafe ? '<span class="chip line">' + esc(cafe) + '</span>' : '') + '</span></div>' +
    '<div class="sheet-acts"><button class="btn danger block" data-act="signOut">Sign out</button><button class="btn block" data-act="closeModal">Close</button></div>', 'sheet');
}

function ic(n, size) { return '<svg width="' + (size || 18) + '" height="' + (size || 18) + '" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' + ICONS[n] + '</svg>'; }

/* ---------- modal ---------- */
function showModal(html, cls) { $('modal').innerHTML = '<div class="scrim" data-act="closeModal" id="scrim"><div class="modal ' + (cls || '') + '" role="dialog" aria-modal="true">' + html + '</div></div>'; const f = $('modal').querySelector('input,select,textarea'); if (f) f.focus(); }
function hideModal() { $('modal').innerHTML = ''; }
function modalOpen() { return !!$('modal') && $('modal').innerHTML !== ''; }
// is the person in the middle of typing into a field? (polling must not wipe what they typed)
function editingField() {
  const a = document.activeElement;
  return !!(a && a !== document.body && /^(INPUT|TEXTAREA|SELECT)$/.test(a.tagName) && $('view') && $('view').contains(a));
}

// Escape closes whichever sheet or dialog is open (the profile sheet included)
document.addEventListener('keydown', function (e) {
  if (e.key !== 'Escape' || !modalOpen()) return;
  hideModal();
  try { if (typeof E !== 'undefined') E.modal = null; } catch (x) { /* employee app not loaded */ }
  try { if (typeof state !== 'undefined') state.modal = null; } catch (x) { /* owner app not loaded */ }
});
