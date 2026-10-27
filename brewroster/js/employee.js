/* ============================================================
   Brewroster: employee app (phone first)
   Roster, team chat (with open shifts), leave requests and standby.
   ============================================================ */
const E = {
  tab: 'shifts', sub: 'mine', weekIdx: 0, staff: {}, me: null, priv: null, up: {}, shifts: [], covers: [], chat: [], leaves: [], alerts: [], sig: '', modal: null
};

function pad2(n) { return String(n).padStart(2, '0'); }
function person(id) { return E.staff[id] || { id: id, name: 'Someone', first: 'Someone', initials: '?' }; }
function myId() { return APP.profile.staff_id; }
function myShifts() { return E.shifts.filter(function (s) { return s.staffId === myId(); }); }
function coverOf(staffId, day) { return E.covers.find(function (c) { return c.staff_id === staffId && c.day === day && (c.kind === 'late' || c.kind === 'optout'); }); }
function shiftHours(s) { return s.e - s.s; }
function myLeaveOn(day) { return E.leaves.some(function (l) { return l.status === 'approved' && day >= l.from_day && day <= l.to_day; }); }
function weekHoursMine(ws) {
  let t = 0;
  E.shifts.forEach(function (s) { if (s.staffId === myId() && weekStartOf(s.day) === ws && !coverOf(s.staffId, s.day)) t += shiftHours(s); });
  return t;
}
// why can't I take this cover? returns '' when I can
function blocker(c) {
  if (c.staff_id === myId()) return 'This is your own shift.';
  if (E.shifts.some(function (s) { return s.staffId === myId() && s.day === c.day; })) return 'You already have a shift that day.';
  if (myLeaveOn(c.day)) return 'You are on approved leave that day.';
  const max = E.priv ? Number(E.priv.max_hours) : 0;
  if (max && weekHoursMine(weekStartOf(c.day)) + (c.w_to - c.w_from) > max) return 'That would take you over your ' + max + ' hour weekly limit.';
  return '';
}
function liveCover(c) { return c.status === 'open' && hoursUntil(c.day, c.w_to) > 0; }
function myCalls() {
  return E.alerts.filter(function (a) {
    if (a.status !== 'sent') return false;
    const c = E.covers.find(function (x) { return x.id === a.cover_id; });
    return !c || (c.status === 'open' && hoursUntil(a.day, a.to_h) > 0);
  });
}
function openForTeam() { return E.covers.filter(function (c) { return liveCover(c) && c.phase === 'chat' && c.staff_id !== myId(); }); }
function mineOpen() { return E.covers.filter(function (c) { return c.staff_id === myId() && c.status === 'open' && hoursUntil(c.day, c.w_to) > 0; }); }

/* ---------- data ---------- */
function applyEmployeeData(q) {
  APP.settings = q[0][0] || {}; if (APP.settings.timezone) APP.tz = APP.settings.timezone;
  E.staff = {}; q[1].forEach(function (r) { E.staff[r.id] = personFromRow(r, null); });
  E.priv = q[2][0] || null; E.me = E.staff[myId()] || null;
  E.up = {}; q[3].forEach(function (r) { if (r.status === 'uploaded') E.up[r.week_start] = true; });
  E.shifts = q[4].map(function (s) { return { id: s.id, day: s.day, staffId: s.staff_id, s: s.start_h, e: s.end_h, via: s.via }; });
  E.covers = q[5];
  E.chat = q[6].slice().reverse().map(function (m) { return { t: m.kind, text: m.body, at: fmtAt(m.created_at), who: m.author || '' }; });
  E.leaves = q[7];
  E.alerts = q[8];
}
function sigOfE(q) { return Math.floor(NOW_HOUR * 4) + JSON.stringify(q); }
async function reloadE() { const q = await loadEmployeeData(); applyEmployeeData(q); E.sig = sigOfE(q); }
async function afterChangeE() { await reloadE(); render(); }

/* ---------- small pieces ---------- */
function ehead(title, sub) { return '<header class="ehead"><h1>' + title + '</h1>' + (sub ? '<p>' + sub + '</p>' : '') + '</header>'; }
function empty(title, text) { return '<div class="empty-state"><b>' + title + '</b>' + text + '</div>'; }
function whenText(day, a, b) { return dLabel(day) + ', ' + hRange(a, b); }
function relDay(day) {
  const n = daysBetween(TODAY, day);
  return n === 0 ? 'Today' : n === 1 ? 'Tomorrow' : n < 7 ? DOW_LONG[dowOf(day)] : '';
}
function statusChips(s) {
  const c = coverOf(s.staffId, s.day);
  if (!c) return s.via === 'chat' ? '<span class="chip line">Picked up from chat</span>' : s.via === 'standby' ? '<span class="chip line">Standby</span>' : '';
  if (c.status === 'covered') return '<span class="chip ok">Covered by ' + esc(person(c.covered_by).first) + '</span>';
  if (c.status === 'closed') return '<span class="chip ok">Sorted</span>';
  return c.phase === 'chat' ? '<span class="chip warn">In the team chat</span>' : '<span class="chip bad">Standby: finding cover</span>';
}

/* ---------- SHIFTS ---------- */
function myShiftCard(s) {
  const c = coverOf(s.staffId, s.day), rel = relDay(s.day), started = hoursUntil(s.day, s.s) <= 0;
  let act = '';
  if (!c && !started) act = '<button class="btn sm" data-act="cantMake" data-id="' + s.id + '">I can\'t make it</button>';
  else if (!c && started) act = '<span class="small">In progress</span>';
  return '<article class="shiftcard' + (c ? ' cancelled' : '') + '"><div class="sc-date"><b>' + DOW[dowOf(s.day)] + '</b><span>' + dayNum(s.day) + '</span><small>' + monOf(s.day) + '</small></div>' +
    '<div class="sc-main"><b>' + hRange(s.s, s.e) + '</b><span>' + (rel ? rel + ' · ' : '') + shiftHours(s) + ' hours</span><div class="chips">' + statusChips(s) + '</div></div><div class="sc-act">' + act + '</div></article>';
}
function mineList() {
  const list = myShifts().filter(function (s) { return hoursUntil(s.day, s.e) > 0; }).sort(function (a, b) { return a.day.localeCompare(b.day) || a.s - b.s; });
  if (!list.length) return empty('No shifts coming up', 'When your manager uploads the next roster, your shifts will show here.');
  const wk = weekHoursMine(weekStartOf(TODAY));
  return '<p class="small" style="margin:0 0 10px">' + list.length + ' ' + plural(list.length, 'shift') + ' coming up. This week: ' + wk + ' hours' + (E.priv ? ' of up to ' + E.priv.max_hours : '') + '.</p><div class="list">' + list.map(myShiftCard).join('') + '</div>';
}
function teamWeek() {
  const ws = WEEKS[E.weekIdx], days = weekDays(ws);
  const sw = '<div class="wk"><button class="icon-btn" data-act="eweek" data-d="-1" aria-label="Previous week"' + (E.weekIdx === 0 ? ' disabled' : '') + '>‹</button><span>' + weekLabel(ws) + '<small>' + (ws === WEEKS[0] ? 'This week' : ws === WEEKS[1] ? 'Next week' : '') + '</small></span><button class="icon-btn" data-act="eweek" data-d="1" aria-label="Next week"' + (E.weekIdx === WEEKS.length - 1 ? ' disabled' : '') + '>›</button></div>';
  if (!E.up[ws]) return '<div style="display:flex;justify-content:center;margin-bottom:12px">' + sw + '</div>' + empty('Not published yet', 'The roster for this week has not been uploaded. Your manager uploads each week\'s roster once leave is sorted.');
  const cards = days.map(function (d) {
    const rows = E.shifts.filter(function (s) { return s.day === d; }).sort(function (a, b) { return a.s - b.s || person(a.staffId).name.localeCompare(person(b.staffId).name); });
    const body = rows.length ? rows.map(function (s) {
      const c = coverOf(s.staffId, s.day), me = s.staffId === myId();
      return '<div class="trow' + (me ? ' me' : '') + (c ? ' cancelled' : '') + '"><span class="avatar sm2">' + esc(person(s.staffId).initials) + '</span><span class="tn">' + esc(me ? 'You' : person(s.staffId).name) + '</span><span class="tt">' + hRange(s.s, s.e) + '</span>' + (c ? '<span class="chip ' + (c.status === 'open' ? 'warn' : 'ok') + '">' + (c.status === 'open' ? 'Needs cover' : 'Covered') + '</span>' : '') + '</div>';
    }).join('') : '<div class="small">Nobody rostered</div>';
    return '<section class="panel daycard' + (d === TODAY ? ' today' : '') + (d < TODAY ? ' past' : '') + '"><h3>' + DOW_LONG[dowOf(d)] + ' <small>' + dShort(d) + '</small>' + (d === TODAY ? ' <span class="chip solid">Today</span>' : '') + '</h3>' + body + '</section>';
  }).join('');
  return '<div style="display:flex;justify-content:center;margin-bottom:12px">' + sw + '</div><div class="list">' + cards + '</div>';
}
function weekLabel(ws) {
  const end = addDays(ws, 6);
  return monOf(ws) === monOf(end) ? 'Mon ' + dayNum(ws) + ' – Sun ' + dShort(end) : 'Mon ' + dShort(ws) + ' – Sun ' + dShort(end);
}
function vShifts() {
  const calls = myCalls().length;
  const banner = calls ? '<div class="banner warn"><div><b>' + calls + ' ' + plural(calls, 'shift call') + ' waiting for you.</b> Dana needs cover and thought of you.</div><button class="btn sm primary" data-act="etab" data-t="standby">Reply</button></div>' : '';
  const sub = '<div class="tabs"><button class="tab" role="tab" aria-selected="' + (E.sub === 'mine') + '" data-act="esub" data-t="mine">My shifts</button><button class="tab" role="tab" aria-selected="' + (E.sub === 'team') + '" data-act="esub" data-t="team">Whole team</button></div>';
  return ehead('Roster', 'Hi ' + esc(E.me ? E.me.first : '') + ' · ' + DOW_LONG[dowOf(TODAY)] + ' ' + dayNum(TODAY) + ' ' + MONTH_LONG[pd(TODAY).getUTCMonth()]) + banner + sub + (E.sub === 'mine' ? mineList() : teamWeek()) +
    '<p class="small foot">Can\'t work a shift? Tap <b>I can\'t make it</b>. Shifts 14 or more days away need a leave request instead.</p>';
}
const MONTH_LONG = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

/* ---------- OPEN SHIFTS ---------- */
function callCard(a) {
  const c = E.covers.find(function (x) { return x.id === a.cover_id; });
  return '<article class="panel call"><div class="req-top"><span class="avatar">' + ic('bot', 18) + '</span><div class="who"><b>Can you cover this shift?</b><span>Dana is looking for cover within the next 48 hours.</span></div></div>' +
    '<div class="bigwhen">' + whenText(a.day, a.from_h, a.to_h) + '</div><div class="small">' + (a.to_h - a.from_h) + ' hours · normal pay</div>' +
    '<div class="actions"><button class="btn primary" data-act="callYes" data-id="' + a.id + '">Yes, I can work it</button><button class="btn" data-act="callNo" data-id="' + a.id + '">Not this time</button></div></article>';
}
function openCard(c) {
  const bl = blocker(c), who = person(c.staff_id);
  return '<article class="panel call"><div class="req-top"><div class="who"><b>' + whenText(c.day, c.w_from, c.w_to) + '</b><span>' + (c.w_to - c.w_from) + ' hours · ' + esc(who.first) + ' can no longer work it · normal pay</span></div></div>' +
    '<div class="actions">' + (bl ? '<span class="small">' + esc(bl) + '</span>' : '<button class="btn primary" data-act="register" data-id="' + c.id + '">Register for this shift</button>') + '</div></article>';
}
function fold(title, hint, body) {
  return '<details class="fold"><summary><span>' + title + (hint ? ' <small>' + hint + '</small>' : '') + '</span></summary><div class="fold-b">' + body + '</div></details>';
}
function bubble(m) {
  if (m.t === 'note') return '<div class="bub note">' + esc(m.text) + '</div>';
  if (m.t === 'msg') {
    const mine = E.me && m.who === E.me.name;
    return '<div class="bub ' + (mine ? 'mine' : 'them') + '"><span class="bub-h">' + esc(mine ? 'You' : (m.who || 'Someone')) + ' · ' + esc(m.at) + '</span>' + esc(m.text) + '</div>';
  }
  if (m.t === 'reg') return '<div class="bub reg"><span class="bub-h">Team · ' + esc(m.at) + '</span>' + esc(m.text) + '</div>';
  return '<div class="bub open"><span class="bub-h">Brewroster · ' + esc(m.at) + '</span>' + esc(m.text) + '</div>';
}
function vChat() {
  const opens = openForTeam().sort(function (a, b) { return a.day.localeCompare(b.day) || a.w_from - b.w_from; }), mine = mineOpen();
  let h = ehead('Team chat', 'Everyone on the team is here. Open shifts show up below, and anyone can register.');
  h += '<h2 class="sec">Open shifts</h2>' + (opens.length ? '<div class="list">' + opens.map(openCard).join('') + '</div>' : empty('Nothing open right now', 'When a teammate opts out of a shift, it shows up here and you can register.'));
  if (mine.length) h += '<h2 class="sec">Your cancelled shifts</h2><div class="list">' + mine.map(function (c) {
    return '<article class="panel call"><div class="who"><b>' + whenText(c.day, c.start_h, c.end_h) + '</b><span>' + (c.phase === 'chat' ? 'Posted to the team chat. If nobody takes it, it moves to Standby 48 hours before.' : 'Dana is calling standby staff.') + '</span></div></article>';
  }).join('') + '</div>';
  h += '<h2 class="sec">Messages</h2><section class="panel chatp"><div class="chat" id="chatbox">' + (E.chat.length ? E.chat.map(bubble).join('') : '<div class="bub note">Nothing posted yet. Say hello.</div>') + '</div>' +
    '<div class="composer"><input id="chat-in" type="text" maxlength="300" placeholder="Message the team" autocomplete="off" aria-label="Message the team"><button class="btn primary" data-act="sendChat">Send</button></div></section>';
  return h;
}

/* ---------- STANDBY ---------- */
function vStandby() {
  const calls = myCalls(), p = E.priv || { standby_days: [] };
  const on = [0, 1, 2, 3, 4, 5, 6].filter(function (i) { return p.standby_days && p.standby_days[i]; });
  const pills = [0, 1, 2, 3, 4, 5, 6].map(function (i) {
    return '<label class="daypill"><input type="checkbox" id="sb-' + i + '"' + (on.indexOf(i) >= 0 ? ' checked' : '') + '><span>' + DOW[i] + '</span></label>';
  }).join('');
  const picked = myShifts().filter(function (s) { return s.via === 'standby' && hoursUntil(s.day, s.e) > 0; }).sort(function (a, b) { return a.day.localeCompare(b.day); });
  let h = ehead('Standby', 'Be first in line when a day shift opens up at short notice.');
  if (calls.length) h += '<h2 class="sec">Called in for you</h2><div class="list">' + calls.map(callCard).join('') + '</div>';
  h += '<section class="panel"><h2 style="margin-bottom:4px">Put my name down</h2><p class="small" style="margin-bottom:12px">Standby is only for day shifts that open up within 48 hours. Tick the days you are happy to get a call. Dana calls the standby list first, and you can say yes or no each time.</p>' +
    '<div class="daypills" role="group" aria-label="Standby days">' + pills + '</div>' +
    '<p class="small" style="margin:12px 0 0">' + (on.length ? 'You are on the standby list for <b>' + on.map(function (i) { return DOW_LONG[i]; }).join(', ') + '</b>.' : 'You are not on the standby list yet.') + '</p>' +
    '<div class="actions" style="margin-top:12px"><button class="btn primary" data-act="saveStandby">Save standby days</button></div></section>';
  if (picked.length) h += '<h2 class="sec">Standby shifts you picked up</h2><div class="list">' + picked.map(myShiftCard).join('') + '</div>';
  return h;
}

/* ---------- LEAVE ---------- */
function leaveRow(l) {
  const n = daysBetween(l.from_day, l.to_day) + 1, chip = l.status === 'approved' ? '<span class="chip ok">Approved</span>' : l.status === 'declined' ? '<span class="chip bad">Declined</span>' : '<span class="chip warn">Waiting for Dana</span>';
  const range = l.from_day === l.to_day ? dLabel(l.from_day) : dLabel(l.from_day) + ' – ' + dLabel(l.to_day);
  return '<article class="panel call"><div class="req-top"><div class="who"><b>' + range + '</b><span>' + n + ' ' + plural(n, 'day') + ' · ' + esc(l.type) + (l.reason ? ' · ' + esc(l.reason) : '') + '</span></div>' + chip + '</div>' +
    (l.status === 'pending' ? '<div class="actions"><button class="btn sm" data-act="withdraw" data-id="' + l.id + '">Withdraw</button></div>' : '') + '</article>';
}
function vLeaveE() {
  const min = addDays(TODAY, NOTICE_DAYS);
  const form = '<section class="panel"><h2 style="margin-bottom:4px">Ask for leave</h2><p class="small" style="margin-bottom:14px">Leave needs at least ' + NOTICE_DAYS + ' days notice, so it is decided before the roster is made. Earliest day you can ask for: <b>' + dLabel(min) + '</b>.</p>' +
    '<div class="form"><div class="row"><label>First day<input id="lv-from" type="date" min="' + min + '"></label><label>Last day<input id="lv-to" type="date" min="' + min + '"></label></div>' +
    '<label>Type<select id="lv-type"><option>Annual</option><option>Personal</option><option>Study</option><option>Medical</option><option>Other</option></select></label>' +
    '<label>Reason (optional)<input id="lv-reason" type="text" maxlength="80" placeholder="Family trip"></label>' +
    '<label>Note to Dana (optional)<textarea id="lv-msg" rows="2" maxlength="300"></textarea></label>' +
    '<div class="actions"><button class="btn primary" data-act="sendLeave">Send request</button></div></div></section>';
  const mine = E.leaves.slice().sort(function (a, b) { return b.from_day.localeCompare(a.from_day); }).filter(function (l) { return l.to_day >= addDays(TODAY, -30); });
  return ehead('Leave') + form + '<h2 class="sec">Your requests</h2>' + (mine.length ? '<div class="list">' + mine.map(leaveRow).join('') + '</div>' : empty('No requests yet', 'Leave you ask for will be listed here with Dana\'s answer.'));
}

/* ---------- cancelling a shift ---------- */
function openCancel(id) {
  const s = E.shifts.find(function (x) { return x.id === id; }); if (!s) return;
  const h = hoursUntil(s.day, s.s), days = daysBetween(TODAY, s.day);
  E.modal = { shift: id };
  let note;
  if (days >= NOTICE_DAYS) note = '<div class="warnline">This shift is ' + NOTICE_DAYS + ' or more days away. Please send a leave request instead.</div>';
  else if (h > STANDBY_HOURS) note = '<div class="small">More than 48 hours away, so we will post it to the team chat. A teammate can register and you will not be paid for it. If nobody takes it, it moves to Standby 48 hours before the shift.</div>';
  else note = '<div class="warnline">This is within 48 hours. Dana will call standby staff to cover it. If you can, please also let Dana know by phone.</div>';
  showModal('<div><h2>Can\'t make it?</h2><p class="muted">' + whenText(s.day, s.s, s.e) + '</p></div>' + note +
    (days >= NOTICE_DAYS ? '' : '<div class="form"><label>Reason<select id="cx-reason"><option>Unwell</option><option>Family</option><option>Transport</option><option>Study</option><option>Appointment</option><option>Other</option></select></label><label>Anything Dana should know? (optional)<textarea id="cx-msg" rows="2" maxlength="300"></textarea></label></div>') +
    '<div class="acts"><div></div><div class="head-r"><button class="btn" data-act="closeModal">Keep my shift</button>' + (days >= NOTICE_DAYS ? '<button class="btn primary" data-act="etab" data-t="leave">Go to leave</button>' : '<button class="btn danger" data-act="confirmCancel">Confirm, I can\'t work it</button>') + '</div></div>');
}

/* ---------- shell ---------- */
const VIEWS = { shifts: vShifts, chat: vChat, leave: vLeaveE, standby: vStandby };
const TABS = [['shifts', 'Roster', 'shifts'], ['chat', 'Chat', 'chat'], ['leave', 'Leave', 'leave'], ['standby', 'Standby', 'standby']];
function renderTabs() {
  const nOpen = openForTeam().filter(function (c) { return !blocker(c); }).length, nCalls = myCalls().length;
  $('tabbar').innerHTML = TABS.map(function (t) {
    const n = t[0] === 'chat' ? nOpen : t[0] === 'standby' ? nCalls : 0;
    const b = n ? '<span class="badge' + (t[0] === 'standby' ? ' alert' : '') + '">' + n + '</span>' : '';
    return '<button data-act="etab" data-t="' + t[0] + '"' + (E.tab === t[0] ? ' aria-current="page"' : '') + '>' + ic(t[2], 22) + '<span>' + t[1] + '</span>' + b + '</button>';
  }).join('');
}
function render() {
  const open = Array.prototype.map.call(document.querySelectorAll('#view details'), function (e) { return e.open; });
  $('view').innerHTML = VIEWS[E.tab]();
  const ds = document.querySelectorAll('#view details'); if (ds.length === open.length) Array.prototype.forEach.call(ds, function (e, i) { e.open = open[i]; });
  renderTabs();
  const cb = $('chatbox'); if (cb) cb.scrollTop = cb.scrollHeight;
}
function toTop() { window.scrollTo(0, 0); }

/* ---------- actions ---------- */
const ACT = {
  etab: function (t) { E.tab = t.dataset.t; closeModalE(); render(); toTop(); },
  esub: function (t) { E.sub = t.dataset.t; render(); },
  eweek: function (t) { const i = E.weekIdx + Number(t.dataset.d); if (i >= 0 && i < WEEKS.length) { E.weekIdx = i; render(); } },
  closeModal: function (t, e) { if (t.id === 'scrim' && e.target !== t) return; closeModalE(); },
  cantMake: function (t) { openCancel(t.dataset.id); },
  confirmCancel: async function () {
    const id = E.modal && E.modal.shift, r = $('cx-reason') ? $('cx-reason').value : '', m = $('cx-msg') ? $('cx-msg').value.trim() : '';
    const res = await SB.rpc('cancel_shift', { p_shift: id, p_reason: r, p_msg: m || null });
    closeModalE(); await afterChangeE();
    toast(res.phase === 'chat' ? 'Done. Your shift was posted to the team chat.' : 'Done. Dana will find standby cover. Thank you for telling us.');
  },
  register: async function (t) {
    const res = await SB.rpc('register_open_shift', { p_cover: t.dataset.id });
    await afterChangeE(); E.tab = 'shifts'; E.sub = 'mine'; render(); toast('You\'re on for ' + whenText(res.day, res.from, res.to) + '. It is in your shifts now.');
  },
  callYes: async function (t) {
    const res = await SB.rpc('respond_standby_alert', { p_alert: t.dataset.id, p_accept: true });
    await afterChangeE();
    if (res.result === 'accepted') { E.tab = 'shifts'; E.sub = 'mine'; render(); toast('Thank you! You\'re on for ' + whenText(res.day, res.from, res.to) + '.'); }
    else toast('Thanks for being quick, but someone else has already taken that shift.');
  },
  callNo: async function (t) { await SB.rpc('respond_standby_alert', { p_alert: t.dataset.id, p_accept: false }); await afterChangeE(); toast('No problem. Thanks for letting Dana know.'); },
  sendLeave: async function () {
    const from = $('lv-from').value, to = $('lv-to').value || $('lv-from').value;
    if (!from) { toast('Pick the first day.', 'bad'); return; }
    if (daysBetween(TODAY, from) < NOTICE_DAYS) { toast('Leave needs at least ' + NOTICE_DAYS + ' days notice. The earliest day is ' + dLabel(addDays(TODAY, NOTICE_DAYS)) + '.', 'bad'); return; }
    if (to < from) { toast('The last day must be on or after the first day.', 'bad'); return; }
    await SB.rpc('request_leave', { p_from: from, p_to: to, p_type: $('lv-type').value, p_reason: $('lv-reason').value.trim(), p_msg: $('lv-msg').value.trim() });
    await afterChangeE(); toast('Request sent. Dana will decide before the roster for those days is made.');
  },
  withdraw: async function (t) { await SB.rpc('withdraw_leave', { p_id: t.dataset.id }); await afterChangeE(); toast('Request withdrawn.'); },
  sendChat: async function () {
    const inp = $('chat-in'), body = inp ? inp.value.trim() : '';
    if (!body) { toast('Type a message first.', 'bad'); return; }
    await SB.rpc('send_chat', { p_body: body });
    await afterChangeE();
  },
  saveStandby: async function () {
    const sb = [0, 1, 2, 3, 4, 5, 6].map(function (i) { return $('sb-' + i).checked; });
    await SB.rpc('update_my_standby', { p_standby: sb }); await afterChangeE();
    toast(sb.some(Boolean) ? 'Saved. You are on the standby list.' : 'Saved. You are not on the standby list.');
  },
  signOut: function () { return signOutNow(); }
};
function closeModalE() { E.modal = null; hideModal(); }
document.addEventListener('keydown', function (e) {
  if (e.key === 'Escape' && E.modal) closeModalE();
  if (e.key === 'Enter' && e.target && e.target.id === 'chat-in') { e.preventDefault(); const b = document.querySelector('[data-act=sendChat]'); if (b) b.click(); }
});
