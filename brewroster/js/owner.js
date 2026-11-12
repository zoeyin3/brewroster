/* ============================================================
   Brewroster: owner screens
   Rules: a roster is only built once its leave is decided; rosters are
   uploaded weekly; leave needs 14 days; opt-outs (48h to 14 days) go to the
   team chat; anything inside 48 hours goes to Standby.
   Everything here reads from and writes to Supabase (see data.js).
   ============================================================ */
const MONTH_LONG = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const state = {
  view: 'home', week: null, leaves: [], planPending: false, cap: 20, minStaff: 2,
  baseline: buildBaseline([]), hist: [], factors: { weather: true, events: true, school: true },
  rosters: {}, explain: {}, demandDay: 0, heat: { dow: 5, h: 10 }, leaveTab: 'pending', coverTab: 'chat',
  alerts: {}, log: [], late: [], posted: {}, chat: [], covers: [], allStaff: [], allById: {}, linked: {}, busy: false, modal: null, sig: ''
};

function ctx() { return mkCtx(state); }
function emptyRoster() { return { shifts: {}, source: 'none', status: 'draft', stale: false, sb: {}, ids: {} }; }
function firstName() { return String((APP.profile && APP.profile.display_name) || 'there').split(' ')[0]; }
function staffById(id) {
  return state.allById[id] || { id: id, name: 'Former team member', first: 'Someone', initials: '?', role: '', rate: 0, max: 0, avail: [], standbyDays: [] };
}
// the shift someone would work to cover a gap (at least MIN_LEN hours)
function gapWindow(gap) {
  const close = closeH(dowOf(gap.date)); let from = gap.from, to = gap.to;
  while (to - from < MIN_LEN) { if (to < close) to++; else if (from > OPEN_H) from--; else break; }
  return [from, to];
}
function noHistBanner() {
  return state.hist.length ? '' : '<div class="banner info"><div><b>No sales history yet.</b> Rosterbot is using a typical cafe pattern. Import your POS sales below and the forecast will learn your real busy periods.</div></div>';
}


const VIEWS = { home: vHome, roster: vRoster, leave: vLeave, cover: vCover, demand: vDemand, team: vTeam };
const NAV = [['home', 'Home'], ['roster', 'Roster'], ['leave', 'Leave requests'], ['cover', 'Shift cover'], ['demand', 'Demand'], ['team', 'Team']];

function R() { return state.rosters[state.week]; }

function isPast(d) { return d < TODAY; }

function weekLabel(ws) {
  const end = addDays(ws, 6);
  return monOf(ws) === monOf(end) ? 'Mon ' + dayNum(ws) + ' – Sun ' + dShort(end) : 'Mon ' + dShort(ws) + ' – Sun ' + dShort(end);
}

function weekTag(ws) { return ws === WEEKS[0] ? 'This week' : ws === WEEKS[1] ? 'Next week' : ''; }

function weekName(ws) { return weekTag(ws).toLowerCase() || 'the week of ' + dShort(ws); }

function leaveRange(l) {
  const n = daysBetween(l.from, l.to) + 1;
  const s = l.from === l.to ? dLabel(l.from) : (monOf(l.from) === monOf(l.to) ? DOW[dowOf(l.from)] + ' ' + dayNum(l.from) + ' – ' + dLabel(l.to) : dLabel(l.from) + ' – ' + dLabel(l.to));
  return { text: s, days: n };
}

function overlaps(l, ws) { return l.from <= addDays(ws, 6) && l.to >= ws; }

function pendingFor(ws) { return state.leaves.filter(function (l) { return l.status === 'pending' && overlaps(l, ws); }).length; }

function isBuilt(ws) { return state.rosters[ws].source !== 'none'; }

function isUp(ws) { return state.rosters[ws].status === 'approved'; }

function leaveLocked(l) { return WEEKS.some(function (ws) { return overlaps(l, ws) && isUp(ws); }); }

function byWhen(a, b) { return a.date.localeCompare(b.date) || a.shift[0] - b.shift[0]; }

function lates() { return state.late.filter(function (l) { return l.kind === 'late'; }); }

function optouts() { return state.late.filter(function (l) { return l.kind === 'optout'; }); }

function openAll() { return state.late.filter(function (l) { return l.status === 'open' && hoursUntil(l.date, l.shift[1]) > 0; }); }

function openLate() { return openAll().filter(function (l) { return l.phase === 'standby'; }).sort(byWhen); }

function openChat() { return openAll().filter(function (l) { return l.phase === 'chat'; }).sort(byWhen); }

function gapFromLate(l, imp) { return { date: l.date, from: l.shift[0], to: l.shift[1], short: imp.shortfall, bshort: imp.bshortHours > 0 ? 1 : 0, lost: imp.lost, key: 'C' + l.id, lateId: l.id }; }

function gapKey(g) { return g.key || 'G' + g.date + '-' + g.from; }

function rosterGaps(ws) {
  const open = state.late.filter(function (l) { return l.status !== 'covered'; });
  return findGaps(ws, state.rosters[ws], ctx()).filter(function (g) {
    return g.date > TODAY && !open.some(function (l) { return l.date === g.date && g.from < l.shift[1] && g.to > l.shift[0]; });
  }).map(function (g) { g.key = 'G' + g.date + '-' + g.from; return g; });
}

function gapTier(g) { return noticeTier(g.date, g.from); }

function standbyGaps() {
  let out = [];
  WEEKS.forEach(function (ws) { if (isBuilt(ws)) out = out.concat(rosterGaps(ws).filter(function (g) { return gapTier(g) === 'standby'; })); });
  return out;
}

function chatGaps() {
  let out = [];
  WEEKS.forEach(function (ws) { if (isUp(ws)) out = out.concat(rosterGaps(ws).filter(function (g) { return gapTier(g) !== 'standby'; })); });
  return out;
}

function findGapByKey(gk) {
  const c = ctx();
  if (gk[0] === 'C') {
    const l = state.late.find(function (x) { return 'C' + x.id === gk; });
    if (!l || l.status !== 'open') return null;
    const ws = weekStartOf(l.date), r = state.rosters[ws], imp = lateImpact(l, ws, r, c);
    return { gap: gapFromLate(l, imp), ws: ws, r: r, late: l };
  }
  const date = gk.slice(1, 11), ws = weekStartOf(date), r = state.rosters[ws];
  if (!r) return null;
  const g = rosterGaps(ws).find(function (x) { return gapKey(x) === gk; });
  return g ? { gap: g, ws: ws, r: r } : null;
}

function isDup(p) { return state.late.some(function (l) { return l.staffId === p.staffId && l.date === p.date; }); }

function lateRec(id, date) { return state.late.find(function (l) { return l.staffId === id && l.date === date; }); }

function untilText(date, hour) {
  const h = Math.round(hoursUntil(date, hour));
  return h < 48 ? h + ' hours before the shift' : daysBetween(TODAY, date) + ' days before the shift';
}

function openedText(l) { const o = standbyOpens(l.date, l.shift[0]); return dLabel(o.date) + ' at ' + hFmt(o.hour); }

function pageHead(title, sub, right) {
  return '<header class="head"><div><h1>' + title + '</h1>' + (sub ? '<p>' + sub + '</p>' : '') + '</div><div class="head-r">' + (right || '') + '</div></header>';
}

function kpi(label, value, sub, tone, cls) {
  return '<div class="kpi ' + (cls || '') + '"><div class="l">' + label + '</div><div class="v">' + value + '</div><div class="s ' + (tone || '') + '">' + sub + '</div></div>';
}

function dayChip(dayEv) {
  const sh = dayEv.cov.reduce(function (a, c) { return a + c.short; }, 0);
  if (dayEv.clashes.length) return '<span class="chip bad">On leave</span>';
  if (sh > 0) return '<span class="chip bad">' + sh + 'h short</span>';
  if (dayEv.lates.length) return '<span class="chip warn">' + dayEv.lates.length + ' cancelled</span>';
  return '<span class="chip ok">Covered</span>';
}

function ramp(t) {
  t = Math.max(0, Math.min(1, t));
  const a = [244, 247, 251], b = [24, 55, 99];
  const c = a.map(function (v, i) { return Math.round(v + (b[i] - v) * t); });
  return { bg: 'rgb(' + c.join(',') + ')', fg: t > 0.5 ? '#fff' : '#0B1F3A' };
}

function rulesBar(cur) {
  const b = function (key, a, t) { return '<div class="rb' + (cur === key ? ' on' : '') + '"><b>' + a + '</b>' + t + '</div>'; };
  return '<div class="rulesbar">' + b('leave', '14 days or more', 'Leave request, decided by you') + b('chat', '48 hours to 14 days', 'Opt-out, posted to the team chat') + b('standby', 'Under 48 hours', 'Late cancellation, goes to Standby') + '</div>';
}

function fold(title, hint, body) {
  return '<details class="fold"><summary><span>' + title + (hint ? ' <small>' + hint + '</small>' : '') + '</span></summary><div class="fold-b">' + body + '</div></details>';
}

function nextToUpload() { return WEEKS.find(function (ws) { return !isUp(ws); }); }

function weekSwitch() {
  const i = WEEKS.indexOf(state.week), tag = weekTag(state.week);
  return '<div class="wk"><button class="icon-btn" data-act="week" data-d="-1" aria-label="Previous week"' + (i === 0 ? ' disabled' : '') + '>‹</button><span>' + weekLabel(state.week) + (tag ? '<small>' + tag + '</small>' : '') + '</span><button class="icon-btn" data-act="week" data-d="1" aria-label="Next week"' + (i === WEEKS.length - 1 ? ' disabled' : '') + '>›</button></div>';
}

function vHome() {
  const c = ctx(), ws = WEEKS[0], r = state.rosters[ws], ev = evalWeek(ws, r, c);
  const rows = [];
  const nl = state.leaves.filter(function (l) { return l.status === 'pending'; }).length;
  if (nl) {
    const weeks = WEEKS.filter(function (w) { return pendingFor(w) > 0 && !isUp(w); }).map(function (w) { return dShort(w); });
    rows.push({ n: nl, tone: 'warn', t: plural(nl, 'leave request') + ' to decide', s: 'Rosters are only built once leave is decided. Waiting: week of ' + weeks.join(' and ') + '.', b: 'Review leave', go: ['leave'] });
  }
  const sb = openLate().length + standbyGaps().length;
  if (sb) rows.push({ n: sb, tone: 'bad', t: plural(sb, 'shift needs', 'shifts need') + ' cover in the next 48 hours', s: 'Standby staff are listed for each one.', b: 'Find cover', go: ['cover', 'standby'] });
  lateToReview().forEach(function (al) {
    rows.push({ n: al.event_count, tone: 'warn', t: 'Late opt-out alert: ' + esc(lateFirst(al)), s: lateSentence(al), b: 'Review', go: ['cover', 'standby'] });
  });
  const ch = openChat().length + chatGaps().length;
  if (ch) rows.push({ n: ch, tone: '', t: plural(ch, 'open shift') + ' in the team chat', s: 'Teammates can register. Nothing needed from you yet.', b: 'See chat', go: ['cover', 'chat'] });
  const nx = nextToUpload();
  if (nx) {
    const p = pendingFor(nx);
    rows.push(p ? { n: '!', tone: '', t: 'Roster for ' + weekName(nx) + ' is waiting on leave', s: p + ' ' + plural(p, 'request') + ' to decide first.', b: 'Review leave', go: ['leave'] } :
      !isBuilt(nx) ? { n: '!', tone: '', t: 'Roster for ' + weekName(nx) + ' is ready to build', s: 'Leave is decided. Rosterbot can build it now.', b: 'Build roster', go: ['roster', null, nx] } :
        { n: '!', tone: '', t: 'Roster for ' + weekName(nx) + ' is ready to upload', s: 'Check it, then upload it so staff can see it.', b: 'Review roster', go: ['roster', null, nx] });
  }
  const attn = rows.length ? rows.map(function (x) {
    return '<div class="attn-row"><span class="attn-n ' + x.tone + '">' + x.n + '</span><div><b>' + x.t.charAt(0).toUpperCase() + x.t.slice(1) + '</b><span class="s">' + x.s + '</span></div><button class="btn sm" data-act="go" data-v="' + x.go[0] + '"' + (x.go[1] ? ' data-tab="' + x.go[1] + '"' : '') + (x.go[2] ? ' data-week="' + x.go[2] + '"' : '') + '>' + x.b + '</button></div>';
  }).join('') : '<div class="attn-row"><div><b>All clear</b><span class="s">Nothing needs your attention right now.</span></div></div>';
  const days = ev.days.map(function (d, i) {
    const f = dayFactors(d.date), pk = d.cov.reduce(function (a, c2) { return c2.tx > a.tx ? c2 : a; }, d.cov[0]);
    return '<button class="day' + (isPast(d.date) ? ' past' : '') + '" data-act="goWeek" data-date="' + d.date + '"><div class="day-top"><b>' + DOW[i] + '</b><span>' + dShort(d.date) + '</span></div>' +
      '<div class="day-w">' + (f.weather ? f.weather.c + ' ' + f.weather.t + '°' : '') + '</div>' +
      '<div class="day-peak">Busiest <b>' + hRange(pk.h, pk.h + 1) + '</b></div>' + dayChip(d) + '</button>';
  }).join('');
  return pageHead(greeting() + ', ' + esc(firstName()), DOW_LONG[dowOf(TODAY)] + ' ' + dayNum(TODAY) + ' ' + MONTH_LONG[pd(TODAY).getUTCMonth()], '') +
    '<section class="panel"><div class="panel-h" style="margin-bottom:12px"><div><h2>Needs your attention</h2></div></div><div class="attn">' + attn + '</div></section>' +
    '<section class="panel"><div class="panel-h"><div><h2>This week</h2><p>' + weekLabel(ws) + '. Forecast from your POS history, weather and local events.</p></div><button class="btn sm" data-act="goWeek" data-date="' + ws + '">Open roster</button></div>' +
    '<div class="kpis" style="margin-bottom:16px">' +
    kpi('Forecast sales', money(ev.forecastSales), 'about ' + Math.round(ev.forecastTx).toLocaleString('en-AU') + ' transactions') +
    kpi('Labour cost', money(ev.labour), ev.labourPct.toFixed(1) + '% of sales') +
    kpi('Sales at risk', money(ev.lostSales), ev.shortHours ? ev.shortHours + ' short-staffed ' + plural(ev.shortHours, 'hour') : 'Every busy hour covered', ev.lostSales > 500 ? 'bad' : '', ev.lostSales > 500 ? 'alert' : '') + '</div>' +
    '<div class="days">' + days + '</div></section>';
}

function heatHTML() {
  const b = state.baseline;
  let max = 0, min = 1e9;
  for (let d = 0; d < 7; d++) openHours(d).forEach(function (h) { max = Math.max(max, b[d][h].tx); min = Math.min(min, b[d][h].tx); });
  let html = '<div class="heat"><div></div>' + DOW.map(function (d) { return '<div class="hh">' + d + '</div>'; }).join('');
  for (let h = OPEN_H; h < 15; h++) {
    html += '<div class="hl">' + hFmt(h) + '</div>';
    for (let d = 0; d < 7; d++) {
      if (h >= closeH(d)) { html += '<div class="closed">closed</div>'; continue; }
      const tx = b[d][h].tx, col = ramp((tx - min) / (max - min));
      const sel = state.heat.dow === d && state.heat.h === h ? ' sel' : '';
      html += '<button class="' + sel + '" data-act="heat" data-dow="' + d + '" data-h="' + h + '" style="background:' + col.bg + ';color:' + col.fg + '" aria-label="' + DOW[d] + ' ' + hFmt(h) + ', ' + Math.round(tx) + ' transactions">' + Math.round(tx) + '</button>';
    }
  }
  return html + '</div>';
}

function heatDetail() {
  const c = ctx(), d = state.heat.dow, h = state.heat.h, b = state.baseline[d][h];
  const need = needFor(b.tx, c);
  const vmax = Math.max.apply(null, b.vals);
  const bars = b.vals.map(function (v, i) { return '<i class="' + (i === b.vals.length - 1 ? 'hi' : '') + '" style="height:' + Math.round(v / vmax * 100) + '%" title="' + v + ' transactions"></i>'; }).join('');
  return '<h3>' + DOW_LONG[d] + ', ' + hRange(h, h + 1) + '</h3><p class="small" style="margin-top:2px">' + (b.n ? 'Average of ' + b.n + ' ' + DOW_LONG[d] + 's' : 'Typical cafe pattern. No sales history yet.') + '</p>' +
    '<dl class="stat-list"><dt>Transactions</dt><dd>' + Math.round(b.tx) + ' an hour</dd><dt>Sales</dt><dd>' + money(b.sales) + ' an hour</dd><dt>Staff needed</dt><dd>' + need + '</dd></dl>' +
    '<div class="small">One bar per week. The dark bar is the latest.</div><div class="mini">' + bars + '</div>';
}

function chartSVG(date, show) {
  const c = ctx(), r = R(), ev = evalDay(date, r.shifts[date] || {}, c), cov = ev.cov;
  const Wd = 760, Ht = 290, ml = 44, mr = 14, mt = 22, mb = 32, iw = Wd - ml - mr, ih = Ht - mt - mb;
  const maxV = Math.max.apply(null, cov.map(function (x) { return Math.max(x.tx, show ? x.have * c.cap : 0); }).concat([40]));
  const step = maxV > 120 ? 40 : 20, top = Math.ceil(maxV / step) * step;
  const y = function (v) { return mt + ih - (v / top) * ih; };
  const n = cov.length, bw = iw / n, barW = bw * 0.56;
  let s = '<svg class="chart" viewBox="0 0 ' + Wd + ' ' + Ht + '" role="img" aria-label="Forecast transactions per hour against rostered capacity">';
  for (let v = 0; v <= top; v += step) {
    s += '<line x1="' + ml + '" x2="' + (Wd - mr) + '" y1="' + y(v) + '" y2="' + y(v) + '" stroke="#DCE3EE" stroke-width="1"/><text class="ax" x="' + (ml - 8) + '" y="' + (y(v) + 4) + '" text-anchor="end">' + v + '</text>';
  }
  s += '<text class="ax" x="' + ml + '" y="12">Transactions per hour</text>';
  let path = '';
  cov.forEach(function (x, i) {
    const x0 = ml + i * bw, cx = x0 + bw / 2, served = show ? Math.min(x.tx, x.have * c.cap) : x.tx, excess = x.tx - served;
    s += '<rect x="' + (cx - barW / 2) + '" y="' + y(served) + '" width="' + barW + '" height="' + Math.max(0, y(0) - y(served)) + '" fill="#244680" rx="2"/>';
    if (excess > 0.5) s += '<rect x="' + (cx - barW / 2) + '" y="' + y(x.tx) + '" width="' + barW + '" height="' + (y(served) - y(x.tx)) + '" fill="#D9534A" rx="2"/>';
    s += '<text class="tt" x="' + cx + '" y="' + (y(Math.max(x.tx, show ? x.have * c.cap : 0)) - 7) + '" text-anchor="middle">' + x.tx + '</text>';
    s += '<text class="ax" x="' + cx + '" y="' + (Ht - 10) + '" text-anchor="middle">' + hFmt(x.h) + '</text>';
    if (show) { const cy = y(x.have * c.cap); path += (i === 0 ? 'M' : 'L') + x0.toFixed(1) + ' ' + cy.toFixed(1) + ' L' + (x0 + bw).toFixed(1) + ' ' + cy.toFixed(1) + ' '; }
  });
  if (show) s += '<path d="' + path + '" fill="none" stroke="#C9820A" stroke-width="2.5" stroke-linejoin="round"/>';
  return s + '</svg>';
}

function vDemandMain() {
  const c = ctx(), ws = state.week, r = R(), built = isBuilt(ws), days = weekDays(ws), date = days[state.demandDay];
  const ev = evalWeek(ws, r, c), dev = ev.days[state.demandDay], f = dayFactors(date);
  const total = state.hist.reduce(function (a, x) { return a + x.tx; }, 0);
  const tabs = days.map(function (d, i) {
    const sh = ev.days[i].cov.reduce(function (a, x) { return a + x.short; }, 0);
    return '<button class="tab" role="tab" aria-selected="' + (i === state.demandDay) + '" data-act="dday" data-i="' + i + '">' + (built ? '<span class="d ' + (sh > 2 ? 'bad' : sh > 0 ? 'warn' : '') + '"></span>' : '') + DOW[i] + ' ' + dayNum(d) + '</button>';
  }).join('');
  const sw = function (k, label) { return '<button class="switch" role="switch" aria-checked="' + state.factors[k] + '" data-act="factor" data-k="' + k + '"><span class="tr"></span>' + label + '</button>'; };
  const chips = [];
  if (f.weather) chips.push('<span class="chip ' + (state.factors.weather ? '' : 'line') + '">' + f.weather.c + ', ' + f.weather.t + '° · ' + (f.weather.m >= 1 ? '+' : '') + Math.round((f.weather.m - 1) * 100) + '%</span>');
  f.events.forEach(function (e) { chips.push('<span class="chip ' + (state.factors.events ? 'solid' : 'line') + '">' + esc(e.name) + ' · +' + Math.round((e.m - 1) * 100) + '%</span>'); });
  f.school.forEach(function (e) { chips.push('<span class="chip ' + (state.factors.school ? 'solid' : 'line') + '">' + esc(e.name) + ' · ' + Math.round((e.m - 1) * 100) + '%</span>'); });
  if (!chips.length) chips.push('<span class="chip line">No outside signals this day</span>');
  const sh = dev.cov.reduce(function (a, x) { return a + x.short; }, 0), lost = dev.cov.reduce(function (a, x) { return a + x.lostSales; }, 0);
  const totalDay = dev.cov.reduce(function (a, x) { return a + x.tx; }, 0);
  const note = '<b>' + DOW_LONG[state.demandDay] + '</b>: about ' + totalDay + ' transactions. ' + (!built ? 'No roster has been built for this week yet.' : sh > 0 ? 'The roster is ' + sh + ' staff-' + plural(sh, 'hour') + ' short, with about ' + money(lost) + ' in sales at risk (red).' : 'The roster covers demand all day.');
  return pageHead('Demand', (state.hist.length ? 'When customers arrive, from ' + total.toLocaleString('en-AU') + ' POS transactions (' + dShort(state.hist[0].d) + ' to ' + dShort(state.hist[state.hist.length - 1].d) + ').' : 'When customers usually arrive.'), weekSwitch()) +
    noHistBanner() + '<div class="cols"><section class="panel"><div class="panel-h"><div><h2>Busy periods</h2><p>Average transactions per hour. Darker is busier.</p></div></div><div class="hs">' + heatHTML() + '</div></section>' +
    '<section class="panel" id="heatdetail">' + heatDetail() + '</section></div>' +
    '<section class="panel"><div class="panel-h"><div><h2>Forecast for ' + weekLabel(ws) + '</h2><p>Expected transactions each hour' + (built ? ', against the staff on the roster' : '') + '.</p></div></div>' +
    '<div class="tabs" role="tablist">' + tabs + '</div><div class="chips" style="margin-top:14px">' + chips.join('') + '</div>' + chartSVG(date, built) +
    '<div class="legend"><span class="sw-row"><i class="sw-i" style="background:#244680"></i>Demand served</span>' + (built ? '<span class="sw-row"><i class="sw-i" style="background:#D9534A"></i>Not served</span><span class="sw-row"><i class="sw-i" style="background:#C9820A;height:3px"></i>Roster capacity</span>' : '') + '</div>' +
    '<p class="note">' + note + '</p></section>' +
    fold('Forecast settings', '', '<div class="switches"><span class="small" style="font-weight:600;text-transform:uppercase;letter-spacing:.06em">Signals</span>' + sw('weather', 'Weather') + sw('events', 'Local events') + sw('school', 'School calendar') + '</div>' +
      '<div class="rules"><label>Transactions one person serves per hour<span class="stepper"><button data-act="step" data-k="cap" data-d="-2" aria-label="Fewer">−</button><b>' + state.cap + '</b><button data-act="step" data-k="cap" data-d="2" aria-label="More">+</button></span></label>' +
      '<label>Minimum staff on shift<span class="stepper"><button data-act="step" data-k="minStaff" data-d="-1" aria-label="Fewer">−</button><b>' + state.minStaff + '</b><button data-act="step" data-k="minStaff" data-d="1" aria-label="More">+</button></span></label></div>' +
      '<p class="small" style="margin-top:12px">Weather comes from the Open-Meteo forecast for your cafe\'s location (set under Team, Cafe settings). Events and school dates are the ones you add below.</p>');
}

function impactHTML(l, c) {
  const im = leaveImpact(l, c), first = staffById(l.staffId).first;
  const who = im.coverList.map(function (x) { return x.s.first + ' (+' + x.h + 'h)'; }).join(', ');
  const gaps = im.gaps.map(function (g) { return DOW[dowOf(g.date)] + ' ' + hRange(g.from, g.to); }).join(', ');
  let title, text;
  if (im.level === 'safe') {
    title = 'Safe to approve';
    text = 'The roster stays fully covered with ' + first + ' away.' + (who ? ' Extra hours would go to ' + who + '.' : '');
  } else if (im.level === 'watch') {
    title = 'Approve, but expect a thin spot';
    text = (im.extraShortfall > 0 ? 'About ' + im.extraShortfall + ' ' + plural(im.extraShortfall, 'staff-hour') + ' would be short' : 'Only one barista would be on at a busy hour') + (gaps ? ' (' + gaps + ')' : '') + (im.extraLost >= 1 ? ', roughly ' + money(im.extraLost) + ' in sales at risk' : '') + '.';
  } else {
    title = 'Hard to cover';
    text = im.extraShortfall + ' staff-hours would be short' + (gaps ? ' (' + gaps + ')' : '') + ', roughly ' + money(im.extraLost) + ' in sales at risk. You could ask ' + first + ' about moving a day.';
  }
  return '<div class="impact ' + im.level + '"><b>' + title + '</b>' + text + '</div>';
}

function leaveCard(l) {
  const c = ctx(), s = staffById(l.staffId), rg = leaveRange(l), notice = daysBetween(l.submitted, l.from), lock = leaveLocked(l);
  let body = '', acts = '';
  if (l.status === 'pending') {
    body = impactHTML(l, c);
    acts = '<button class="btn primary" data-act="leave" data-id="' + l.id + '" data-to="approved">Approve</button><button class="btn danger" data-act="leave" data-id="' + l.id + '" data-to="declined">Decline</button>';
  } else if (lock) {
    acts = '<span class="small">Locked. The roster for this week is already uploaded.</span>';
  } else {
    const other = l.status === 'approved' ? 'declined' : 'approved';
    acts = '<button class="btn sm" data-act="leave" data-id="' + l.id + '" data-to="' + other + '">Change to ' + other + '</button>';
  }
  return '<article class="panel req"><div class="req-top"><span class="avatar">' + s.initials + '</span><div class="who"><b>' + s.name + '</b><span>' + s.role + '</span></div><div style="text-align:right"><div class="req-when">' + rg.text + '</div><div class="small">' + rg.days + ' ' + plural(rg.days, 'day') + ' · ' + l.type + ' · sent ' + notice + ' days ahead</div></div></div>' +
    '<div class="msg">' + esc(l.msg) + '</div>' + body + '<div class="actions">' + acts + (l.status !== 'pending' ? '<span class="chip ' + (l.status === 'approved' ? 'ok' : 'bad') + '">' + (l.status === 'approved' ? 'Approved' : 'Declined') + '</span>' : '') + '</div></article>';
}

function vLeave() {
  const c = ctx(), counts = { pending: 0, approved: 0, declined: 0 };
  state.leaves.forEach(function (l) { counts[l.status]++; });
  const list = state.leaves.filter(function (l) { return l.status === state.leaveTab; }).sort(function (a, b) { return a.from.localeCompare(b.from); });
  const names = { pending: 'To decide', approved: 'Approved', declined: 'Declined' };
  const tabs = ['pending', 'approved', 'declined'].map(function (t) {
    return '<button class="tab" role="tab" aria-selected="' + (state.leaveTab === t) + '" data-act="ltab" data-t="' + t + '">' + names[t] + ' (' + counts[t] + ')</button>';
  }).join('');
  const dates = []; for (let i = 0; i < 21; i++) dates.push(addDays(WEEKS[1], i));
  let away = '<div class="away"><div></div>' + dates.map(function (d) {
    return '<div class="h ' + (dowOf(d) >= 5 ? 'we' : '') + '">' + DOW[dowOf(d)][0] + '<small>' + dayNum(d) + '</small></div>';
  }).join('');
  STAFF.forEach(function (s) {
    away += '<div class="nm">' + s.first + '</div>' + dates.map(function (d) {
      const lv = leaveRaw(c, s.id, d);
      return '<div class="c ' + (lv || (dowOf(d) >= 5 ? 'we' : '')) + '" title="' + s.name + ', ' + dLabel(d) + (lv ? ', leave ' + lv : '') + '"></div>';
    }).join('');
  });
  away += '</div>';
  const waiting = WEEKS.filter(function (w) { return pendingFor(w) > 0 && !isUp(w); });
  return pageHead('Leave requests', 'Staff ask for leave at least ' + NOTICE_DAYS + ' days ahead. Decide each one before that week\'s roster is built, so the roster only ever includes people who can work.',
    '') +
    (lateToReview().length ? '<div class="banner info"><div><b>Late opt-out alert.</b> ' + lateToReview().length + ' ' + plural(lateToReview().length, 'person has', 'people have') + ' reached ' + lateData().threshold + ' or more late opt-outs this month. It is in Shift cover.</div><button class="btn sm" data-act="go" data-v="cover" data-tab="standby">Review</button></div>' : '') +
    (waiting.length ? '<div class="banner info"><div><b>Rosters waiting on leave:</b> ' + waiting.map(function (w) { return 'week of ' + dShort(w) + ' (' + pendingFor(w) + ')'; }).join(', ') + '.</div></div>' : '') +
    '<div class="tabs" role="tablist">' + tabs + '</div>' +
    (list.length ? '<div class="list">' + list.map(leaveCard).join('') + '</div>' :
      '<div class="empty-state"><b>' + (state.leaveTab === 'pending' ? 'Nothing to decide' : 'No ' + state.leaveTab + ' requests') + '</b>' + (state.leaveTab === 'pending' ? 'New requests from staff show up here.' : 'Requests you ' + (state.leaveTab === 'approved' ? 'approve' : 'decline') + ' are listed here.') + '</div>') +
    fold('Who is away', 'next three weeks', '<div class="hs">' + away + '</div><div class="keyrow"><span><i class="sw-i" style="background:#0B1F3A"></i>Approved</span><span><i class="sw-i" style="background:repeating-linear-gradient(135deg,#9DB0CC 0 3px,#fff 3px 6px);border:1px solid #9DB0CC"></i>Waiting for your decision</span></div>');
}

function cellHTML(s, date, r, c) {
  const sh = r.shifts[date] && r.shifts[date][s.id], lv = leaveOn(c, s.id, date), dow = dowOf(date), past = isPast(date) ? ' past' : '';
  const attr = 'data-act="edit" data-date="' + date + '" data-staff="' + s.id + '"';
  if (sh && lv === 'late') {
    const rec = lateRec(s.id, date), opt = rec && rec.kind === 'optout';
    if (opt && rec.status === 'open' && rec.phase === 'chat') return '<button class="cell optout' + past + '" data-act="goCover" data-tab="chat" title="' + s.name + ' opted out. The shift is in the team chat."><b>' + hRange(sh[0], sh[1]) + '</b><small>Opted out</small></button>';
    return '<button class="cell late' + past + '" data-act="goCover" data-tab="' + (opt && rec.via === 'chat' ? 'chat' : 'standby') + '" title="' + s.name + (opt ? ' opted out of this shift.' : ' cancelled this shift late.') + '"><b>' + hRange(sh[0], sh[1]) + '</b><small>' + (opt ? 'Opted out' : 'Cancelled') + '</small></button>';
  }
  if (sh && lv) return '<button class="cell clash' + past + '" ' + attr + ' title="' + s.name + ' is on approved leave. Select to remove this shift."><b>' + hRange(sh[0], sh[1]) + '</b><small>On leave</small></button>';
  if (sh) return '<button class="cell shift' + past + '" ' + attr + '>' + hRange(sh[0], sh[1]) + '<small>' + (sh[1] - sh[0]) + 'h' + (r.sb && r.sb[date + '|' + s.id] ? (r.sb[date + '|' + s.id] === 'chat' ? ' · team chat' : ' · standby') : '') + '</small></button>';
  if (lv) return '<div class="cell leave' + past + '">On leave</div>';
  if (!s.avail[dow]) return '<button class="cell na' + past + '" ' + attr + ' title="Not available this day">–</button>';
  return '<button class="cell empty' + past + '" ' + attr + ' title="Add a shift">+</button>';
}

function rosterGrid(ws, r, c) {
  const days = weekDays(ws);
  let g = '<div class="rg"><div class="h"><b>Team</b></div>' + days.map(function (d, i) {
    const f = dayFactors(d);
    return '<div class="h' + (isPast(d) ? ' past' : '') + '"><b>' + DOW[i] + '<span>' + dShort(d) + '</span></b>' + (f.weather ? f.weather.c + ' ' + f.weather.t + '°' : '') + (d === TODAY ? '<br><span class="chip solid">Today</span>' : '') + '</div>';
  }).join('') + '<div class="h"><b>Week</b></div>';
  STAFF.forEach(function (s) {
    const hrs = weekHours(ws, r, c, s.id);
    g += '<div class="n"><span class="avatar">' + s.initials + '</span><div><b>' + s.name + '</b><small>' + s.role + '</small></div></div>' + days.map(function (d) { return cellHTML(s, d, r, c); }).join('') +
      '<div class="tot"><b class="num">' + hrs + 'h <span class="small" style="font-weight:400">of ' + s.max + 'h</span></b><div class="bar"><i class="' + (hrs >= s.max ? 'full' : '') + '" style="width:' + Math.min(100, Math.round(hrs / s.max * 100)) + '%"></i></div></div>';
  });
  g += '</div>';
  return '<div class="hs rwide">' + g + '</div>' + rosterDayView(ws, r, c);
}

// On a phone the week grid is too wide, so the same cells are shown one day at a time.
function rosterDayView(ws, r, c) {
  const days = weekDays(ws);
  let i = state.rday; if (i == null || i < 0 || i > 6) { i = days.indexOf(TODAY); if (i < 0) i = 0; }
  const d = days[i], f = dayFactors(d), on = STAFF.filter(function (s) { return r.shifts[d] && r.shifts[d][s.id]; }).length;
  const pills = days.map(function (dd, k) {
    return '<button class="dpill' + (k === i ? ' on' : '') + (dd === TODAY ? ' today' : '') + '" data-act="rday" data-i="' + k + '" aria-pressed="' + (k === i) + '"><span>' + DOW[k] + '</span><b>' + dayNum(dd) + '</b></button>';
  }).join('');
  const rows = STAFF.map(function (s) {
    return '<div class="drow"><span class="avatar">' + s.initials + '</span><div class="dn"><b>' + s.name + '</b><small>' + s.role + '</small></div>' + cellHTML(s, d, r, c) + '</div>';
  }).join('');
  return '<div class="rday"><div class="dpills">' + pills + '</div><div class="dayline"><b>' + DOW_LONG[i] + ' ' + dShort(d) + '</b><span class="small">' + on + ' on' + (f.weather ? ' · ' + f.weather.c + ' ' + f.weather.t + '°' : '') + '</span></div>' + rows + '</div>';
}

function coverGrid(ws, ev) {
  const days = weekDays(ws);
  let cv = '<div class="rg"><div class="h"><b>Staff on / needed</b></div>' + days.map(function (d, i) { return '<div class="h"><b>' + DOW[i] + '</b></div>'; }).join('') + '<div class="h"></div>';
  for (let h = OPEN_H; h < 15; h++) {
    cv += '<div class="cv-l">' + hFmt(h) + '</div>';
    days.forEach(function (d, i) {
      const x = ev.days[i].cov.find(function (q) { return q.h === h; });
      if (!x) { cv += '<div class="cv closed">closed</div>'; return; }
      const cls = x.short > 0 ? 'short' : x.bshort > 0 ? 'nob' : x.over > 0 ? 'over' : '';
      cv += '<div class="cv ' + cls + (isPast(d) ? ' past' : '') + '" title="' + x.tx + ' transactions forecast. ' + x.have + ' on, ' + x.need + ' needed.">' + x.have + ' / ' + x.need + '<small>' + x.tx + ' tx</small></div>';
    });
    cv += '<div></div>';
  }
  cv += '</div>';
  return '<div class="hs">' + cv + '</div><p class="small" style="margin-top:12px">Red: short of staff. Red outline: a barista is missing. Amber: more staff than demand needs.</p>';
}

function vRoster() {
  const c = ctx(), ws = state.week, r = R(), built = isBuilt(ws), up = isUp(ws), pend = pendingFor(ws);
  const head = pageHead('Roster', 'The confirmed roster that staff see. Leave is decided first, so everyone on it can work.', weekSwitch());
  if (!built) {
    const away = state.leaves.filter(function (l) { return l.status === 'approved' && overlaps(l, ws); });
    const awayTxt = away.length ? 'Approved leave this week: ' + away.map(function (l) { return staffById(l.staffId).first + ' (' + leaveRange(l).text + ')'; }).join(', ') + '.' : 'Nobody is on approved leave this week.';
    if (pend) {
      const reqs = state.leaves.filter(function (l) { return l.status === 'pending' && overlaps(l, ws); });
      return head + '<section class="panel gate"><h2>Decide leave first</h2><p>The roster for ' + weekName(ws) + ' is built only after every leave request for it is approved or declined. ' + pend + ' ' + plural(pend, 'request is', 'requests are') + ' still waiting:</p>' +
        '<ul class="gate-l">' + reqs.map(function (l) { return '<li><b>' + staffById(l.staffId).name + '</b> ' + leaveRange(l).text + '</li>'; }).join('') + '</ul>' +
        '<div class="actions"><button class="btn primary" data-act="go" data-v="leave">Review leave requests</button><button class="btn" disabled>Build roster</button></div></section>';
    }
    return head + '<section class="panel gate"><h2>' + (state.busy ? 'Rosterbot is planning' : 'No roster yet for ' + weekName(ws)) + '</h2><p>Leave for this week is decided. Rosterbot builds the roster from your POS sales, the weather and local events, and the team\'s availability.</p><p class="small" style="margin-top:6px">' + awayTxt + '</p>' +
      '<div class="actions"><button class="btn primary" data-act="optimise"' + (state.busy ? ' disabled' : '') + '>' + (state.busy ? '<span class="spin"></span> Planning' : 'Build roster') + '</button></div></section>';
  }
  const ev = evalWeek(ws, r, c), gaps = rosterGaps(ws), ex = state.explain[ws];
  const notes = [];
  if (pend) notes.push('<div class="banner warn"><div><b>' + pend + ' new leave ' + plural(pend, 'request needs', 'requests need') + ' a decision</b> before this roster can be uploaded.</div><button class="btn sm primary" data-act="go" data-v="leave">Review leave</button></div>');
  const nCover = state.late.filter(function (l) { return l.status === 'open' && weekStartOf(l.date) === ws; });
  if (nCover.length) notes.push('<div class="banner bad"><div><b>' + nCover.length + ' ' + plural(nCover.length, 'shift needs', 'shifts need') + ' cover.</b> ' + nCover.map(function (l) { return staffById(l.staffId).first + ' ' + DOW[dowOf(l.date)]; }).join(', ') + '.</div><button class="btn sm primary" data-act="goCover" data-tab="' + (nCover.some(function (l) { return l.phase === 'standby'; }) ? 'standby' : 'chat') + '">See cover</button></div>');
  if (gaps.length) notes.push('<div class="banner info"><div><b>' + gaps.length + ' ' + plural(gaps.length, 'gap') + ' the team cannot cover:</b> ' + gaps.slice(0, 3).map(function (g) { return DOW[dowOf(g.date)] + ' ' + hRange(g.from, g.to); }).join(', ') + (gaps.length > 3 ? ' and more' : '') + '.' + (up ? '' : ' You can post them to the team chat once the roster is uploaded.') + '</div>' + (up ? '<button class="btn sm" data-act="goCover" data-tab="' + (gaps.every(function (g) { return gapTier(g) === 'standby'; }) ? 'standby' : 'chat') + '">See cover</button>' : '') + '</div>');
  const status = up ? '<span class="chip ok">Uploaded</span><span class="small">Staff can see this roster. Changes go through Shift cover.</span>' : '<span class="chip warn">Draft</span><span class="small">Staff cannot see it until you upload it.</span>';
  const optLabel = state.busy ? '<span class="spin"></span> Planning' : 'Rebuild';
  const actions = up ? '' : '<button class="btn" data-act="optimise"' + (state.busy ? ' disabled' : '') + '>' + optLabel + '</button><button class="btn primary" data-act="publish"' + (pend ? ' disabled' : '') + '>Approve and upload</button>';
  const sumLine = ex && !up ? '<p class="small">Compared with last week\'s roster: short-staffed hours ' + ex.before.shortHours + ' → ' + ex.after.shortHours + ', sales at risk ' + money(ex.before.lostSales) + ' → ' + money(ex.after.lostSales) + '.</p>' : '';
  return head + '<div class="statusrow"><div class="chips" style="align-items:center">' + status + '</div><div class="head-r">' + actions + '</div></div>' + notes.join('') +
    '<div class="kpis">' + kpi('Short-staffed hours', ev.shortHours, ev.shortHours ? ev.shortfall + ' staff-hours below demand' : 'Every busy hour covered', ev.shortHours ? 'bad' : 'good', ev.shortHours > 8 ? 'alert' : '') +
    kpi('Sales at risk', money(ev.lostSales), 'from queues in short-staffed hours', ev.lostSales > 500 ? 'bad' : '', ev.lostSales > 500 ? 'alert' : '') +
    kpi('Labour cost', money(ev.labour), ev.hours + ' staff-hours · ' + ev.labourPct.toFixed(1) + '% of sales') + '</div>' + sumLine +
    '<section class="panel"><div class="panel-h"><div><h2>Shifts</h2><p>Select any cell to add, change or remove a shift.</p></div></div>' + rosterGrid(ws, r, c) +
    '<div class="legend"><span class="sw-row"><i class="sw-i" style="background:#E9EFF8;border:1px solid #C4D1E6"></i>Shift</span><span class="sw-row"><i class="sw-i" style="background:#EEF0F3;border:1px solid #D5DAE1"></i>On leave</span><span class="sw-row"><i class="sw-i" style="background:#FBE9E7;border:1px solid #EBC3BF"></i>Cancelled</span><span class="sw-row"><i class="sw-i" style="background:#FBF0D9;border:1px solid #EBD3A2"></i>Opted out, in team chat</span></div></section>' +
    fold('Cover by hour', 'staff on against staff needed', coverGrid(ws, ev));
}

function eligibleLine(cands) {
  const free = cands.filter(function (x) { return x.free; });
  if (!free.length) return 'Nobody on the team is free for this shift.';
  const names = free.slice(0, 4).map(function (x) { return x.s.first; }).join(', ');
  return free.length + ' of ' + cands.length + ' teammates ' + plural(free.length, 'is', 'are') + ' free (' + names + (free.length > 4 ? ' and ' + (free.length - 4) + ' more' : '') + ').';
}

function chatPanel() {
  const msgs = state.chat.slice(-12).map(function (m) {
    if (m.t === 'note') return '<div class="bub note">' + esc(m.text) + '</div>';
    if (m.t === 'msg') {
      const mine = m.who === (APP.profile && APP.profile.display_name);
      return '<div class="bub ' + (mine ? 'mine' : 'them') + '"><span class="bub-h">' + esc(mine ? 'You' : (m.who || 'Someone')) + ' · ' + esc(m.at) + '</span>' + esc(m.text) + '</div>';
    }
    if (m.t === 'reg') return '<div class="bub reg"><span class="bub-h">Teammate · ' + esc(m.at) + '</span>' + esc(m.text) + '</div>';
    return '<div class="bub open"><span class="bub-h">Brewroster · ' + esc(m.at) + '</span>' + esc(m.text) + '</div>';
  }).join('');
  return '<section class="panel chatp"><div class="panel-h" style="margin-bottom:10px"><div><h2>Team chat</h2><p>All ' + STAFF.length + ' staff. Anyone can register for an open shift.</p></div></div>' +
    '<div class="chat">' + (msgs || '<div class="bub note">Nothing posted yet.</div>') + '</div>' +
    '<div class="composer"><input id="chat-in" type="text" maxlength="300" placeholder="Message the team" autocomplete="off" aria-label="Message the team"><button class="btn primary" data-act="sendChat">Send</button></div></section>';
}

function doneRows(via) {
  const rows = state.late.filter(function (l) { return l.status === 'covered' && (l.via || 'standby') === via; }).sort(byWhen);
  if (!rows.length) return '';
  return '<section class="panel"><h2 style="margin-bottom:6px">Covered</h2>' + rows.map(function (l) {
    return '<div class="rowline"><span class="chip ok">Filled</span><span><b>' + staffById(l.coveredBy).first + '</b> took ' + dLabel(l.date) + ', ' + hRange(l.shift[0], l.shift[1]) + ' from ' + staffById(l.staffId).first + (via === 'chat' ? ' via the team chat.' : ' via Standby.') + '</span></div>';
  }).join('') + '</section>';
}

function candRows(gap, ws, r, c) {
  const cands = standbyFor(gap, ws, r, c), gk = gapKey(gap);
  const free = cands.filter(function (x) { return x.free; }), off = cands.filter(function (x) { return !x.free; });
  const rows = free.map(function (x) {
    const key = gk + '|' + x.s.id, al = state.alerts[key];
    let act;
    if (!al) act = '<button class="btn sm" data-act="alert" data-key="' + key + '">Send alert</button>';
    else if (al.status === 'sent') act = '<span class="chip warn"><span class="spin"></span> Waiting</span>';
    else if (al.status === 'declined') act = '<span class="chip bad">Cannot make it</span>';
    else if (al.status === 'accepted') act = '<span class="chip ok">Accepted</span>';
    else act = '<span class="chip line">Closed</span>';
    return '<div class="cand"><span class="avatar">' + x.s.initials + '</span><div><b>' + x.s.name + '</b><div class="meta">' + x.s.role + ' · ' + x.wk + 'h of ' + x.s.max + 'h this week</div></div><div class="cost"><b>' + hRange(x.from, x.to) + '</b><br>' + money(x.cost) + '</div><div class="act">' + act + '</div></div>';
  }).join('');
  const offHtml = off.length ? '<details class="more"><summary>' + off.length + ' happy to work but not free</summary>' + off.map(function (x) { return '<div class="rowline"><b>' + x.s.first + '</b><span>' + esc(x.why) + '</span></div>'; }).join('') + '</details>' : '';
  return rows + offHtml;
}

function gapSection(gap, ws, r, c, title, chips, closeId) {
  const cands = standbyFor(gap, ws, r, c), free = cands.filter(function (x) { return x.free; }), dow = dowOf(gap.date);
  const canAll = free.some(function (x) { return !state.alerts[gapKey(gap) + '|' + x.s.id]; });
  return '<section class="panel gap"><div class="panel-h" style="margin-bottom:0"><div><h2>' + title + '</h2><div class="chips" style="margin-top:8px">' + chips + '</div>' +
    '<p style="margin-top:10px">' + (cands.length ? '<b>' + free.length + ' of ' + cands.length + '</b> ' + plural(cands.length, 'person who is', 'people who are') + ' happy to work ' + DOW_LONG[dow] + 's ' + plural(free.length, 'is', 'are') + ' free.' : 'Nobody has said they are happy to work ' + DOW_LONG[dow] + 's.') + '</p></div>' +
    '<div class="head-r">' + (canAll ? '<button class="btn sm primary" data-act="alertAll" data-gap="' + gapKey(gap) + '">Alert everyone who is free</button>' : '') + (closeId ? '<button class="btn sm" data-act="closeCover" data-id="' + closeId + '">Mark as covered</button>' : '') + '</div></div>' +
    (cands.length ? candRows(gap, ws, r, c) : '<div class="empty-state" style="margin-top:14px"><b>Nobody is on the standby list for ' + DOW_LONG[dow] + 's</b>Ask staff to turn on ' + DOW[dow] + ' under Team.<div style="margin-top:12px"><button class="btn sm" data-act="go" data-v="team">Open team</button></div></div>') + '</section>';
}

const NAV_SHORT = { leave: 'Leave', cover: 'Cover' };
function renderNav() {
  const pend = state.leaves.filter(function (l) { return l.status === 'pending'; }).length;
  const chatN = openChat().length + chatGaps().length, sbN = openLate().length + standbyGaps().length, cov = chatN + sbN;
  document.getElementById('nav').innerHTML = NAV.map(function (n) {
    const b = n[0] === 'leave' && pend ? '<span class="badge">' + pend + '</span>' : n[0] === 'cover' && cov ? '<span class="badge' + (sbN ? ' alert' : '') + '">' + cov + '</span>' : '';
    return '<button data-act="nav" data-v="' + n[0] + '"' + (state.view === n[0] ? ' aria-current="page"' : '') + '><span class="nl-full">' + n[1] + '</span><span class="nl-short">' + (NAV_SHORT[n[0]] || n[1]) + '</span>' + b + '</button>';
  }).join('');
}

function render() {
  const sc = Array.prototype.map.call(document.querySelectorAll('.hs'), function (e) { return e.scrollLeft; });
  const open = Array.prototype.map.call(document.querySelectorAll('details'), function (e) { return e.open; });
  document.getElementById('view').innerHTML = VIEWS[state.view]();
  Array.prototype.forEach.call(document.querySelectorAll('.hs'), function (e, i) { if (sc[i]) e.scrollLeft = sc[i]; });
  const ds = document.querySelectorAll('details'); if (ds.length === open.length) Array.prototype.forEach.call(ds, function (e, i) { e.open = open[i]; });
  renderNav();
}

function openModal(date, id) {
  const c = ctx(), r = R(), s = c.byId[id], dow = dowOf(date), sh = r.shifts[date] && r.shifts[date][id], av = s.avail[dow], lv = leaveOn(c, id, date);
  const close = closeH(dow);
  const def = sh || (av ? [av[0], Math.min(av[0] + 6, av[1], close)] : [OPEN_H, Math.min(OPEN_H + 6, close)]);
  state.modal = { date: date, id: id };
  const startOpts = openHours(dow).map(function (h) { return '<option value="' + h + '"' + (h === def[0] ? ' selected' : '') + '>' + hColon(h) + '</option>'; }).join('');
  const endOpts = []; for (let h = OPEN_H + 1; h <= close; h++) endOpts.push('<option value="' + h + '"' + (h === def[1] ? ' selected' : '') + '>' + hColon(h) + '</option>');
  const warns = [];
  const canCancel = isUp(weekStartOf(date)) && sh && !leaveOn(c, id, date) && noticeTier(date, sh[0]) !== 'leave' && hoursUntil(date, sh[0]) > 0;
  if (lv === 'approved') warns.push(s.first + ' is on approved leave this day.');
  else if (!av) warns.push(s.first + ' is not usually available on ' + DOW_LONG[dow] + 's.');
  else warns.push('Usually available ' + hRange(av[0], av[1]) + '.');
  const isWarn = lv || !av;
  document.getElementById('modal').innerHTML = '<div class="scrim" data-act="closeModal" id="scrim"><div class="modal" role="dialog" aria-modal="true" aria-label="Edit shift"><div><h2>' + s.name + '</h2><p class="muted">' + dLabel(date) + '</p></div>' +
    '<div class="' + (isWarn ? 'warnline' : 'small') + '">' + warns.join(' ') + '</div>' +
    '<div class="row"><label for="m-start">Start<select id="m-start">' + startOpts + '</select></label><label for="m-end">Finish<select id="m-end">' + endOpts.join('') + '</select></label></div>' +
    (canCancel ? '<div class="cancelbox"><label for="m-reason">Did ' + esc(s.first) + ' call to cancel?<input id="m-reason" type="text" maxlength="120" placeholder="Reason (optional)"></label><button class="btn sm" data-act="recordCancel">Record cancellation</button><span class="small">This opens the shift for cover and keeps a record.</span></div>' : '') +
    '<div class="acts"><div>' + (sh ? '<button class="btn danger" data-act="removeShift">Remove shift</button>' : '') + '</div><div class="head-r"><button class="btn" data-act="closeModal">Cancel</button><button class="btn primary" data-act="saveShift">Save shift</button></div></div></div></div>';
  const first = document.getElementById('m-start'); if (first) first.focus();
}

function closeModal() { state.modal = null; document.getElementById('modal').innerHTML = ''; }

function touchRoster(ws) { const r = state.rosters[ws]; r.source = 'manual'; state.explain[ws] = null; r.stale = false; }

function toTop() { window.scrollTo(0, 0); }


/* ---------- SHIFT COVER (team chat + standby) ---------- */
function optCard(l) {
  const c = ctx(), s = staffById(l.staffId), ws = weekStartOf(l.date), r = state.rosters[ws];
  const imp = lateImpact(l, ws, r, c), gap = gapFromLate(l, imp), cands = standbyFor(gap, ws, r, c, 'chat');
  const lvl = !imp.needs ? 'safe' : (imp.shortfall >= 4 || imp.lost >= 150 ? 'risk' : 'watch');
  const impact = '<div class="impact ' + lvl + '"><b>' + (imp.needs ? imp.shortfall + ' staff-' + plural(imp.shortfall, 'hour') + ' short without cover' : 'The rest of the roster still covers demand') + '</b>' + (imp.needs ? 'Roughly ' + money(imp.lost) + ' in sales at risk. ' : '') + eligibleLine(cands) + '</div>';
  return '<article class="panel req"><div class="req-top"><span class="avatar">' + esc(s.initials) + '</span><div class="who"><b>' + esc(s.name) + ' opted out</b><span>' + esc(l.reason || 'No reason given') + ' · ' + untilText(l.date, l.shift[0]) + '</span></div><div style="text-align:right"><div class="req-when">' + dLabel(l.date) + ', ' + hRange(l.shift[0], l.shift[1]) + '</div><span class="chip">In team chat</span></div></div>' +
    (l.msg ? '<div class="msg">' + esc(l.msg) + '</div>' : '') + impact +
    '<div class="actions"><button class="btn sm" data-act="closeCover" data-id="' + l.id + '">Mark as covered</button></div>' +
    '<p class="small">Waiting for a teammate to register. If nobody does, it moves to Standby on ' + openedText(l) + '. Registering pays the normal rate.</p></article>';
}
function gapChatCard(g) {
  const c = ctx(), ws = weekStartOf(g.date), r = state.rosters[ws], posted = state.posted[g.key], cands = standbyFor(g, ws, r, c, 'chat');
  const lvl = g.short >= 4 || g.lost >= 150 ? 'risk' : 'watch';
  return '<article class="panel req"><div class="req-top"><span class="avatar">' + ic('bot', 18) + '</span><div class="who"><b>Gap in the roster</b><span>Found by Rosterbot · ' + daysBetween(TODAY, g.date) + ' days away</span></div><div style="text-align:right"><div class="req-when">' + dLabel(g.date) + ', ' + hRange(g.from, g.to) + '</div>' + (posted ? '<span class="chip">In team chat</span>' : '<span class="chip line">Not posted</span>') + '</div></div>' +
    '<div class="impact ' + lvl + '"><b>' + (g.short ? g.short + ' ' + plural(g.short, 'person') + ' short' : 'A barista is missing') + '</b>Roughly ' + money(g.lost) + ' in sales at risk. ' + eligibleLine(cands) + '</div>' +
    '<div class="actions">' + (posted ? '<span class="small">Posted ' + esc(posted.at) + '. Waiting for a teammate to register.</span>' : '<button class="btn primary" data-act="postGap" data-key="' + g.key + '">Post to team chat</button>') + '</div></article>';
}
function chatTab() {
  const opens = openChat(), gaps = chatGaps(), n = opens.length + gaps.length;
  const list = n ? '<div class="list">' + opens.map(optCard).join('') + gaps.map(gapChatCard).join('') + '</div>' : '<div class="empty-state"><b>No open shifts</b>When a worker opts out of a shift more than 48 hours away, it is posted to the team chat and listed here.</div>';
  return '<div class="cols"><div class="stack">' + list + doneRows('chat') + '</div>' + chatPanel() + '</div>';
}
function standbyTab() {
  const c = ctx(), opens = openLate(), gaps = standbyGaps();
  const lateCards = opens.map(function (l) {
    const lws = weekStartOf(l.date), lr = state.rosters[lws], imp = lateImpact(l, lws, lr, c), gap = gapFromLate(l, imp), s = staffById(l.staffId);
    const chips = '<span class="chip ' + (l.kind === 'optout' ? 'warn' : 'bad') + '">' + esc(s.first) + (l.kind === 'optout' ? ' opted out, nobody registered' : ' cancelled') + (l.reason ? ' · ' + esc(l.reason) : '') + '</span>' + (imp.needs ? '<span class="chip line">' + money(imp.lost) + ' sales at risk</span>' : '<span class="chip ok">Still covered</span>') + (imp.bshortHours ? '<span class="chip line">Needs a barista</span>' : '');
    return gapSection(gap, lws, lr, c, dLabel(l.date) + ', ' + hRange(l.shift[0], l.shift[1]), chips, l.id);
  }).join('');
  const gapCards = gaps.map(function (g) {
    const chips = (g.short ? '<span class="chip bad">' + g.short + ' ' + plural(g.short, 'person') + ' short</span>' : '') + (g.bshort ? '<span class="chip line">Needs a barista</span>' : '') + '<span class="chip line">' + money(g.lost) + ' sales at risk</span>';
    const gws = weekStartOf(g.date);
    return gapSection(g, gws, state.rosters[gws], c, dLabel(g.date) + ', ' + hRange(g.from, g.to), chips);
  }).join('');
  const log = state.log.length ? '<section class="panel"><h2 style="margin-bottom:10px">Recent replies</h2><ul class="log">' + state.log.slice(0, 4).map(function (l) { return '<li><span class="chip ' + (l.ok === null ? 'line' : l.ok ? 'ok' : 'bad') + '">' + (l.ok === null ? 'Not needed' : l.ok ? 'Accepted' : 'Declined') + '</span><span>' + esc(l.text) + '</span></li>'; }).join('') + '</ul></section>' : '';
  const n = opens.length + gaps.length;
  return '<p class="note" style="margin-top:0">Standby is for day shifts starting within 48 hours (before ' + dLabel(addDays(TODAY, 2)) + ', ' + clockText() + '). You see everyone who is happy to work that day and who is free. Each alert reaches the person in their Brewroster app.</p>' +
    (n ? '<div class="list">' + lateCards + gapCards + '</div>' : '<div class="empty-state"><b>Nothing needs standby cover</b>If someone cancels a shift within 48 hours, it appears here with the people you can call.</div>') + doneRows('standby') + log;
}
function vCover() {
  const chatN = openChat().length + chatGaps().length, sbN = openLate().length + standbyGaps().length, tab = state.coverTab;
  const tabs = '<button class="tab" role="tab" aria-selected="' + (tab === 'chat') + '" data-act="covertab" data-t="chat">Team chat (' + chatN + ')</button><button class="tab" role="tab" aria-selected="' + (tab === 'standby') + '" data-act="covertab" data-t="standby">Standby (' + sbN + ')</button>';
  return pageHead('Shift cover', 'When someone cannot work a shift on the uploaded roster. The earlier they tell you, the less it costs.', '') +
    lateSection() + rulesBar(tab) + '<div class="tabs" role="tablist">' + tabs + '</div>' + (tab === 'chat' ? chatTab() : standbyTab());
}


/* ---------- DEMAND extras: events and POS import ---------- */
function eventsFold() {
  const all = EVENTS.map(function (e) { return Object.assign({ kind: 'event' }, e); }).concat(SCHOOL.map(function (e) { return Object.assign({ kind: 'school' }, e); }))
    .filter(function (e) { return e.date >= addDays(TODAY, -1); }).sort(function (a, b) { return a.date.localeCompare(b.date); });
  const rows = all.map(function (e) {
    const pct = Math.round((e.m - 1) * 100);
    return '<div class="rowline"><b>' + dLabel(e.date) + '</b><span>' + esc(e.name) + ' · ' + hRange(e.from, e.to) + ' · ' + (pct >= 0 ? '+' : '') + pct + '% ' + (e.kind === 'school' ? '(school)' : '') + '</span><button class="btn sm danger" data-act="delEvent" data-id="' + e.id + '" style="margin-left:auto">Remove</button></div>';
  }).join('');
  const hrs = function (id, def) { let o = ''; for (let h = 5; h <= 20; h++) o += '<option value="' + h + '"' + (h === def ? ' selected' : '') + '>' + hColon(h) + '</option>'; return '<select id="' + id + '">' + o + '</select>'; };
  const form = '<div class="form inline"><label>Date<input id="ev-date" type="date" min="' + TODAY + '" value="' + addDays(TODAY, 7) + '"></label><label>What<input id="ev-name" type="text" maxlength="60" placeholder="Saturday markets"></label>' +
    '<label>Type<select id="ev-kind"><option value="event">Local event</option><option value="school">School date</option></select></label>' +
    '<label>From' + hrs('ev-from', 9) + '</label><label>To' + hrs('ev-to', 13) + '</label><label>Change in customers (%)<input id="ev-pct" type="number" min="-60" max="100" step="1" value="15"></label>' +
    '<button class="btn primary" data-act="addEvent">Add</button></div>';
  return fold('Events and school dates', all.length + ' coming up', (rows || '<p class="small" style="margin-bottom:8px">Nothing added yet. Add markets, fun runs, school holidays or anything else that changes how busy you are.</p>') + '<div style="margin-top:14px">' + form + '</div>');
}
function importFold() {
  const n = state.hist.length;
  return fold('Import POS sales', n ? n.toLocaleString('en-AU') + ' hourly rows loaded' : 'none yet',
    '<p class="small" style="margin-bottom:10px">Upload or paste hourly sales from your POS as CSV with four columns: <b>date, hour, transactions, sales</b>. Example: <code>2026-10-14,7,48,462.50</code>. Rows for a date and hour that already exist are replaced. The last 8 weeks are used for the forecast.</p>' +
    '<div class="form"><label>CSV file<input id="pos-file" type="file" accept=".csv,text/csv,text/plain"></label><label>Or paste rows<textarea id="pos-csv" rows="5" placeholder="date,hour,transactions,sales&#10;2026-10-14,7,48,462.50"></textarea></label>' +
    '<div class="actions"><button class="btn primary" data-act="importPos">Import sales</button></div></div>');
}
function vDemand() { return vDemandMain() + eventsFold() + importFold(); }

/* ---------- TEAM ---------- */
function availDisplay(s) {
  return s.avail.map(function (a, i) { return '<div class="' + (a ? '' : 'off') + '"><b>' + DOW[i] + '</b>' + (a ? a[0] + '–' + a[1] : '–') + '</div>'; }).join('');
}
function personCard(s) {
  const sbd = s.standbyDays.map(function (on, i) { return '<button class="dchip" aria-pressed="' + on + '" data-act="standbyDay" data-id="' + s.id + '" data-d="' + i + '" aria-label="Happy to be called in on ' + DOW_LONG[i] + 's">' + DOW[i] + '</button>'; }).join('');
  const status = !s.email ? '<span class="chip warn">No email yet</span>' : state.linked[s.id] ? '<span class="chip ok">Signed in</span>' : '<span class="chip line">Not signed up yet</span>';
  return '<article class="person"><div class="pn"><b>' + esc(s.name) + '</b><span>' + esc(s.role) + (s.email ? ' · ' + esc(s.email) : '') + '</span></div>' +
    '<div class="pr">$' + s.rate + '/h</div><div class="pm">' + s.max + 'h</div>' +
    '<div class="pa" data-l="Usual availability">' + availDisplay(s) + '</div><span class="sp"></span>' +
    '<div class="ps" data-l="Happy to be called in on (Standby)">' + sbd + '</div><span class="sp"></span>' +
    '<div class="pst">' + status + '</div><div class="pe"><button class="btn sm" data-act="editStaff" data-id="' + s.id + '">Edit</button></div></article>';
}
function teamHead() {
  const d = DOW.map(function (x) { return '<span class="t-c">' + x + '</span>'; }).join('');
  return '<div class="trow-h trow-g"><span class="t-s3"></span><span class="grp">Usual availability</span><span></span><span class="grp">Happy to be called in on (Standby)</span></div>' +
    '<div class="trow-h"><span>Name</span><span>Rate</span><span>Max</span>' + d + '<span></span>' + d + '<span></span><span>Account</span><span></span></div>';
}
function cafeSettingsFold() {
  const s = APP.settings || {};
  return fold('Cafe settings', esc(s.cafe_name || ''),
    '<div class="form"><label>Cafe name<input id="cs-name" type="text" maxlength="60" value="' + esc(s.cafe_name || '') + '"></label>' +
    '<label>Time zone<input id="cs-tz" type="text" list="tzlist" value="' + esc(s.timezone || '') + '"><datalist id="tzlist">' + ['Australia/Sydney', 'Australia/Melbourne', 'Australia/Brisbane', 'Australia/Adelaide', 'Australia/Perth', 'Australia/Hobart', 'Australia/Darwin', 'Pacific/Auckland', 'Europe/London', 'America/New_York', 'America/Los_Angeles', 'America/Chicago'].map(function (z) { return '<option value="' + z + '">'; }).join('') + '</datalist></label>' +
    '<div class="row"><label>Latitude<input id="cs-lat" type="number" step="0.0001" value="' + (s.lat == null ? '' : s.lat) + '"></label><label>Longitude<input id="cs-lng" type="number" step="0.0001" value="' + (s.lng == null ? '' : s.lng) + '"></label></div>' +
    '<p class="small">Your location is used only to fetch the weather forecast for the Demand forecast.</p>' +
    '<div class="actions"><button class="btn primary" data-act="saveCafe">Save settings</button><button class="btn" data-act="useLocation">Use my location</button></div></div>' +
    lateSettingsBlock() +
    '<div style="margin-top:22px;padding-top:16px;border-top:1px solid var(--line)"><div class="small" style="margin-bottom:8px">Want to start again with the sample cafe? This replaces the team, sales, leave, rosters and chat with fresh sample data.</div><button class="btn danger" data-act="resetSample">Replace everything with sample data</button></div>');
}
function vTeam() {
  const inactive = state.allStaff.filter(function (p) { return !p.active; });
  const body = STAFF.length ? '<div class="team">' + teamHead() + STAFF.map(personCard).join('') + '</div>' :
    '<div class="empty-state"><b>Your team is empty</b>Add the people who work shifts. Each person signs in with the email you give them.<div style="margin-top:12px"><button class="btn primary" data-act="addStaff">Add a team member</button></div></div>';
  return pageHead('Team', STAFF.length + ' ' + plural(STAFF.length, 'person', 'people') + '. Usual availability and the days each person is happy to be called in at short notice.', '<button class="btn primary" data-act="addStaff">Add team member</button>') + body +
    (inactive.length ? fold('Former team members', inactive.length, inactive.map(function (p) { return '<div class="rowline"><b>' + esc(p.name) + '</b><span>' + esc(p.role) + '</span><button class="btn sm" data-act="restoreStaff" data-id="' + p.id + '" style="margin-left:auto">Add back</button></div>'; }).join('')) : '') +
    cafeSettingsFold();
}
function hourSel(id, lo, hi, def) { let o = ''; for (let h = lo; h <= hi; h++) o += '<option value="' + h + '"' + (h === def ? ' selected' : '') + '>' + hColon(h) + '</option>'; return '<select id="' + id + '">' + o + '</select>'; }
function openStaffModal(id) {
  const blank = { name: '', role: '', email: '', rate: 28, max: 24, barista: false, avail: [[7, 15], [7, 15], [7, 15], [7, 15], [7, 15], [7, 14], null], standbyDays: [false, false, false, false, false, false, false] };
  const s = id ? staffById(id) : blank;
  state.modal = { staff: id || null };
  const days = [0, 1, 2, 3, 4, 5, 6].map(function (i) {
    const a = s.avail[i];
    return '<div class="avrow"><label class="check"><input type="checkbox" id="av-on-' + i + '"' + (a ? ' checked' : '') + '> ' + DOW[i] + '</label>' + hourSel('av-s-' + i, 5, 14, a ? a[0] : 7) + '<span>to</span>' + hourSel('av-e-' + i, 6, 18, a ? a[1] : (i < 5 ? 15 : 14)) +
      '<label class="check sb"><input type="checkbox" id="sb-' + i + '"' + (s.standbyDays[i] ? ' checked' : '') + '> Standby</label></div>';
  }).join('');
  showModal('<div><h2>' + (id ? 'Edit ' + esc(s.first) : 'Add a team member') + '</h2></div><div class="form">' +
    '<label>Name<input id="f-name" type="text" maxlength="60" value="' + esc(s.name) + '"></label>' +
    '<label>Role<input id="f-role" type="text" maxlength="60" value="' + esc(s.role) + '" placeholder="Barista, Kitchen, Floor"></label>' +
    '<label>Email (they sign in with this)<input id="f-email" type="email" maxlength="120" value="' + esc(s.email || '') + '" placeholder="name@example.com"></label>' +
    '<div class="row"><label>Pay rate ($ an hour)<input id="f-rate" type="number" min="0" step="0.5" value="' + s.rate + '"></label><label>Most hours a week<input id="f-max" type="number" min="1" max="60" step="1" value="' + s.max + '"></label></div>' +
    '<label class="check"><input type="checkbox" id="f-bar"' + (s.barista ? ' checked' : '') + '> Can run the coffee machine (counts as a barista)</label>' +
    '<div><div class="small" style="margin-bottom:6px">Usual availability, and the days they are happy to be called in at short notice (Standby)</div><div class="avgrid">' + days + '</div></div></div>' +
    '<div class="acts"><div>' + (id ? '<button class="btn danger" data-act="removeStaff" data-id="' + id + '">Remove</button>' : '') + '</div><div class="head-r"><button class="btn" data-act="closeModal">Cancel</button><button class="btn primary" data-act="saveStaff">' + (id ? 'Save' : 'Add to team') + '</button></div></div>', 'wide');
}



/* ---------- LATE OPT-OUT ALERT (owner only) ----------
   Information for the owner's judgement. Nothing here changes a roster, messages anyone,
   or touches anyone's hours. Employees never load this data. */
function lateData() { return state.lateAlerts || { threshold: 3, window_h: 48, alerts: [] }; }
function lateList(st) { return lateData().alerts.filter(function (a) { return a.state === st; }); }
function lateToReview() { return lateList('open').filter(function (a) { return !a.watching; }); }
function lateFirst(a) { return String(a.staff_name || '').split(' ')[0]; }
function lateMonth(a) { return MONTH_LONG[Number(String(a.month).slice(5, 7)) - 1]; }
function lateSentence(a) {
  const n = a.event_count, w = lateData().window_h;
  return esc(lateFirst(a)) + ' has opted out of ' + n + ' ' + plural(n, 'shift') + ' with under ' + w + ' hours notice in ' + lateMonth(a) + '. Each one triggered standby.';
}
function lateNotice(h) { const n = Math.round(Number(h)); return n < 1 ? 'Under 1 hour notice' : n + ' ' + plural(n, 'hour') + ' notice'; }
function lateEventRow(e, live) {
  const cover = e.covered_by_name ? 'Covered by ' + esc(String(e.covered_by_name).split(' ')[0]) : e.covered_via === 'owner' ? 'Marked as covered by you' : e.status === 'open' ? 'Not covered yet' : 'No cover recorded';
  const side = e.excused ? '<span class="chip ok">Excused</span>' : (e.cost != null ? '<b>about ' + money(e.cost) + '</b>' : '');
  const acts = e.excused ? '<button class="btn sm" data-act="lateUnexcuse" data-id="' + e.id + '">Remove excuse</button>' : '<button class="btn sm" data-act="lateExcuse" data-id="' + e.id + '">Mark event as excused</button>';
  return '<div class="lev' + (e.excused ? ' excused' : '') + '"><div class="lev-main"><b>' + dLabel(e.day) + ', ' + hRange(e.start_h, e.end_h) + '</b>' +
    '<span>' + lateNotice(e.notice_hours) + ' · ' + cover + (e.by_owner ? ' · recorded by you' : '') + (e.cost != null && !e.excused ? ' · ' + e.cover_hours + ' h cover' : '') + '</span>' +
    (e.reason ? '<span class="lev-q">Reason given: ' + esc(e.reason) + '</span>' : '') +
    (e.note ? '<span class="lev-q">' + (e.excused ? 'Excused: ' : 'Your note: ') + esc(e.note) + '</span>' : (e.excused && e.excused_by ? '<span class="lev-q">Excused by ' + esc(e.excused_by) + '</span>' : '')) + '</div>' +
    (side ? '<div class="lev-side">' + side + '</div>' : '') +
    (live !== 'none' ? '<div class="lev-acts">' + acts + '<button class="btn sm" data-act="lateNote" data-id="' + e.id + '">' + (e.note ? 'Edit note' : 'Add a note') + '</button></div>' : '') + '</div>';
}
function lateCard(a) {
  const open = a.state === 'open', ev = a.events || [], counted = ev.filter(function (e) { return !e.excused; }), costed = counted.filter(function (e) { return e.cost != null; });
  const total = costed.reduce(function (s, e) { return s + Number(e.cost); }, 0), th = lateData().threshold;
  const cost = costed.length ? '<div class="late-total"><div><span>Estimated cost of cover (an estimate, not a payroll figure)</span><b>about ' + money(total) + '</b></div><p class="small">Each cover shift\'s hours multiplied by the pay rate of the person who worked it, across ' + costed.length + ' ' + plural(costed.length, 'event') + '.' +
    (costed.length < counted.length ? ' ' + (counted.length - costed.length) + ' ' + plural(counted.length - costed.length, 'event has', 'events have') + ' no cover recorded yet, so ' + (counted.length - costed.length === 1 ? 'it is' : 'they are') + ' left out.' : '') + '</p></div>' : '';
  const status = open ? (a.watching ? '<span class="chip line">Watching</span>' : '<span class="chip warn">To review</span>') :
    a.state === 'dismissed' ? '<span class="chip line">Dismissed</span>' : '<span class="chip ok">Closed</span>';
  const foot = open ? '<div class="actions"><button class="btn" data-act="lateWatch" data-id="' + a.id + '"' + (a.watching ? ' disabled' : '') + '>' + (a.watching ? 'Watching' : 'Keep watching') + '</button><button class="btn" data-act="lateDismiss" data-id="' + a.id + '">Dismiss alert</button></div>' :
    '<p class="small">' + (a.state === 'dismissed' ? 'Dismissed by ' + esc(a.dismissed_by_name || 'the owner') + (a.dismissed_on ? ' on ' + dLabel(a.dismissed_on) : '') + '.' :
      'Closed automatically. After excusing events the count is ' + a.event_count + ', below the alert level of ' + th + '. Remove an excuse to bring it back.') + '</p>';
  return '<section class="panel latecard" data-late="' + a.id + '"><div class="panel-h"><div><h2>Late opt-outs: ' + esc(lateFirst(a)) + ' · ' + lateMonth(a) + '</h2><p>' + (open ? lateSentence(a) : esc(lateFirst(a)) + ' opted out of ' + ev.length + ' ' + plural(ev.length, 'shift') + ' at short notice in ' + lateMonth(a) + (counted.length !== ev.length ? ' (' + counted.length + ' counted, ' + (ev.length - counted.length) + ' excused).' : '.')) + '</p></div>' + status + '</div>' +
    '<div class="levs">' + ev.map(function (e) { return lateEventRow(e); }).join('') + '</div>' + cost +
    '<p class="late-judge">This is a flag for your judgement, not a decision. Check the reason with the employee before acting.</p>' + foot + '</section>';
}
function lateSection() {
  if (!state.lateAlerts) return '';
  const open = lateList('open'), past = state.lateAlerts.alerts.filter(function (a) { return a.state !== 'open'; });
  return open.map(lateCard).join('') + (past.length ? fold('Earlier late opt-out alerts', past.length, past.map(lateCard).join('')) : '');
}
function lateSettingsBlock() {
  if (!state.lateAlerts) return '<div style="margin-top:22px;padding-top:16px;border-top:1px solid var(--line)"><div class="small">The late opt-out alert needs the latest database file. Run <b>schema.sql</b> in Supabase again to turn it on.</div></div>';
  const d = state.lateAlerts;
  return '<div style="margin-top:22px;padding-top:16px;border-top:1px solid var(--line)"><h3 style="margin-bottom:6px">Late opt-out alert</h3>' +
    '<p class="small" style="margin-bottom:12px">Flags to you, and only you, when one person keeps opting out at short notice, because each one sends a shift to standby. Counted per person, per calendar month. It is a prompt to check in, never a decision.</p>' +
    '<div class="form"><div class="row"><label>Alert after (opt-outs in a month)<input id="cs-late-n" type="number" min="2" max="20" step="1" value="' + d.threshold + '"></label>' +
    '<label>Short notice means under (hours)<input id="cs-late-h" type="number" min="1" max="48" step="1" value="' + d.window_h + '"></label></div>' +
    '<p class="small">Standby only starts within 48 hours, so you can shorten the notice window but not lengthen it.</p>' +
    '<div class="actions"><button class="btn primary" data-act="saveLateSettings">Save alert settings</button></div></div></div>';
}
function openLateSheet(id, mode) {
  let e = null, a = null;
  lateData().alerts.forEach(function (x) { (x.events || []).forEach(function (y) { if (y.id === id) { e = y; a = x; } }); });
  if (!e) { toast('That event could not be found. Reload and try again.', 'bad'); return; }
  state.modal = { late: id, mode: mode };
  const th = lateData().threshold, ex = mode === 'excuse';
  showModal('<div><h2>' + (ex ? 'Mark event as excused' : (e.note ? 'Edit note' : 'Add a note')) + '</h2><p class="muted">' + esc(lateFirst(a)) + ', ' + dLabel(e.day) + ', ' + hRange(e.start_h, e.end_h) + ' · ' + lateNotice(e.notice_hours) + '</p></div>' +
    '<div class="form">' + (ex ? '<p class="small">Excused events stay in the history but are not counted. If the count drops below ' + th + ', the alert closes by itself.</p>' : '') +
    '<label>' + (ex ? 'Reason (optional), for example illness' : 'Note, only you can see it') + '<textarea id="late-note" rows="4" maxlength="500">' + esc(e.note || '') + '</textarea></label></div>' +
    '<div class="acts"><div></div><div class="head-r"><button class="btn" data-act="closeModal">Cancel</button><button class="btn primary" data-act="' + (ex ? 'lateSaveExcuse' : 'lateSaveNote') + '">' + (ex ? 'Mark event as excused' : 'Save note') + '</button></div></div>');
}

/* ---------- saving to Supabase ---------- */
function sigOf(q) { return Math.floor(NOW_HOUR * 4) + JSON.stringify(q.map(function (x, i) { return i === 3 ? null : x; })); }
async function reload(opts) { const q = await loadOwnerData(opts); applyOwnerData(q); state.sig = sigOf(q); }
async function afterChange(opts) { await reload(Object.assign({ pos: false }, opts)); render(); }
function saveSettings(patch) { return SB.update('settings', { id: 'eq.1' }, patch); }

function runOptimise(ws) {
  const c = ctx(), after = optimiseWeek(ws, c), prevWs = addDays(ws, -7), prev = state.rosters[prevWs];
  let ex = null;
  if (prev && prev.source !== 'none') {
    const eb = evalWeek(ws, copyForward(prev, ws, prevWs), c), ea = evalWeek(ws, after, c);
    ex = { before: { shortHours: eb.shortHours, lostSales: eb.lostSales }, after: { shortHours: ea.shortHours, lostSales: ea.lostSales } };
  }
  state.rosters[ws] = after; state.explain[ws] = ex;
  return ex;
}
async function persistRoster(ws) {
  const r = state.rosters[ws], rows = [];
  weekDays(ws).forEach(function (d) {
    const day = r.shifts[d] || {};
    Object.keys(day).forEach(function (id) { rows.push({ day: d, staff_id: id, start_h: day[id][0], end_h: day[id][1] }); });
  });
  await SB.rpc('save_roster', { p_week: ws, p_source: r.source === 'manual' ? 'manual' : 'ai', p_shifts: rows, p_explain: state.explain[ws] || null });
}
async function setLeave(id, status) {
  const l = state.leaves.find(function (x) { return x.id === id; });
  if (!l) return;
  if (leaveLocked(l)) { toast('That roster is already uploaded, so this decision is locked.', 'bad'); return; }
  await SB.update('leave_requests', { id: 'eq.' + id }, { status: status });
  l.status = status;
  const s = staffById(l.staffId), rebuilt = [], ready = [];
  for (let i = 0; i < WEEKS.length; i++) {
    const ws = WEEKS[i];
    if (!overlaps(l, ws)) continue;
    if (isBuilt(ws) && state.rosters[ws].status === 'draft') { runOptimise(ws); await persistRoster(ws); rebuilt.push(dShort(ws)); }
    else if (!isBuilt(ws) && pendingFor(ws) === 0) ready.push(dShort(ws));
  }
  let msg = (status === 'approved' ? 'Approved ' : 'Declined ') + s.first + '\'s leave.';
  if (rebuilt.length) msg += ' Rosterbot rebuilt the roster for the week of ' + rebuilt.join(' and ') + '.';
  else if (ready.length) msg += ' The roster for the week of ' + ready.join(' and ') + ' can now be built.';
  await afterChange(); toast(msg);
}
async function doOptimise() {
  if (state.busy) return;
  state.busy = true; render();
  try {
    await new Promise(function (r) { setTimeout(r, 700); });
    const ws = state.week; runOptimise(ws); await persistRoster(ws); await reload({ pos: false });
    toast('Roster built for ' + weekLabel(ws) + '.');
  } catch (e) { toast(errText(e), 'bad'); try { await reload({ pos: false }); } catch (e2) { /* ignore */ } }
  finally { state.busy = false; render(); }
}
async function touchRosterDb(ws) { await SB.update('rosters', { week_start: 'eq.' + ws }, { source: 'manual', explain: null, updated_at: new Date().toISOString() }); }
async function coverIdFor(gk, phase) {
  if (gk[0] === 'C') return gk.slice(1);
  const found = findGapByKey(gk); if (!found) throw new Error('That gap has already been filled.');
  const g = found.gap, w = gapWindow(g);
  const r = await SB.rpc('owner_open_gap', { p_day: g.date, p_start: g.from, p_end: g.to, p_from: w[0], p_to: w[1], p_phase: phase });
  return r.id;
}
async function sendAlerts(gk, staffIds) {
  if (!staffIds.length) return 0;
  const id = await coverIdFor(gk, 'standby');
  return SB.rpc('owner_alert_standby', { p_cover: id, p_staff: staffIds });
}

/* sample data for a brand new cafe: seed, then build and upload this week's roster */
async function bootstrapSample() {
  await reload();
  const ws = WEEKS[0];
  if (pendingFor(ws) === 0 && !isBuilt(ws)) {
    runOptimise(ws); await persistRoster(ws); await SB.rpc('publish_roster', { p_week: ws });
  }
  await reload();
}

/* ---------- POS import ---------- */
function parseDateCell(s) {
  s = String(s).trim();
  let m = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(s);
  if (!m) { m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(s); if (m) m = [null, m[3], m[2], m[1]]; }
  if (!m) return null;
  const y = +m[1], mo = +m[2], d = +m[3], dt = new Date(Date.UTC(y, mo - 1, d));
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== mo - 1 || dt.getUTCDate() !== d) return null;
  return fd(dt);
}
function parseHourCell(s) {
  s = String(s).trim().toLowerCase();
  const m = /^(\d{1,2})(?::\d{2})?\s*(am|pm)?$/.exec(s);
  if (!m) return null;
  let h = +m[1]; if (m[2] === 'pm' && h < 12) h += 12; if (m[2] === 'am' && h === 12) h = 0;
  return h >= 0 && h <= 23 ? h : null;
}
function parsePos(text) {
  const rows = {}, errors = []; let n = 0;
  String(text).split(/\r?\n/).forEach(function (line, i) {
    if (!line.trim()) return;
    const c = line.split(/[,;\t]/);
    if (i === 0 && !parseDateCell(c[0])) return;           // header row
    const day = parseDateCell(c[0]), hour = parseHourCell(c[1] || ''), tx = parseInt(String(c[2] || '').replace(/[^\d]/g, ''), 10), sales = parseFloat(String(c[3] || '').replace(/[^0-9.\-]/g, ''));
    if (!day || hour === null || !(tx >= 0) || !(sales >= 0)) { if (errors.length < 5) errors.push('Line ' + (i + 1) + ': ' + line.trim().slice(0, 60)); return; }
    rows[day + '|' + hour] = { day: day, hour: hour, tx: tx, sales: sales }; n++;
  });
  return { rows: Object.keys(rows).map(function (k) { return rows[k]; }), errors: errors, lines: n };
}

/* ---------- actions ---------- */
function formVal(id) { const e = $(id); return e ? e.value.trim() : ''; }
const ACT = {
  nav: function (t) { state.view = t.dataset.v; render(); toTop(); swapAnim(); },
  rday: function (t) { state.rday = Number(t.dataset.i); render(); },
  profile: function () { openProfile(); },
  go: function (t) {
    state.view = t.dataset.v;
    if (t.dataset.tab) state.coverTab = t.dataset.tab;
    if (t.dataset.week) state.week = t.dataset.week;
    render(); toTop();
  },
  goCover: function (t) { state.view = 'cover'; state.coverTab = t.dataset.tab || 'standby'; render(); toTop(); },
  goWeek: function (t) { state.week = weekStartOf(t.dataset.date); state.view = 'roster'; render(); toTop(); },
  week: function (t) { const i = WEEKS.indexOf(state.week) + Number(t.dataset.d); if (i >= 0 && i < WEEKS.length) { state.week = WEEKS[i]; render(); } },
  heat: function (t) { state.heat = { dow: Number(t.dataset.dow), h: Number(t.dataset.h) }; render(); },
  dday: function (t) { state.demandDay = Number(t.dataset.i); render(); },
  factor: function (t) {
    const k = t.dataset.k; state.factors[k] = !state.factors[k]; render();
    const p = {}; p['use_' + k] = state.factors[k]; return saveSettings(p);
  },
  step: function (t) {
    const k = t.dataset.k, d = Number(t.dataset.d), lim = k === 'cap' ? [10, 40] : [1, 4];
    state[k] = Math.max(lim[0], Math.min(lim[1], state[k] + d)); render();
    return saveSettings(k === 'cap' ? { cap: state.cap } : { min_staff: state.minStaff });
  },
  ltab: function (t) { state.leaveTab = t.dataset.t; render(); },
  covertab: function (t) { state.coverTab = t.dataset.t; render(); },
  leave: function (t) { return setLeave(t.dataset.id, t.dataset.to); },
  optimise: function () { return doOptimise(); },
  publish: async function () {
    const ws = state.week, c = ctx(), ev = evalWeek(ws, R(), c);
    if (pendingFor(ws) > 0) { toast('Decide the leave requests for this week first.', 'bad'); return; }
    if (ev.clashes > 0) { toast('Remove ' + ev.clashes + ' ' + plural(ev.clashes, 'shift', 'shifts') + ' on approved leave before uploading.', 'bad'); return; }
    await SB.rpc('publish_roster', { p_week: ws });
    await afterChange(); toast('Roster for ' + weekLabel(ws) + ' uploaded. Staff can see it in their app now and can opt out of shifts.');
  },
  edit: function (t) {
    if (isPast(t.dataset.date)) { toast('That day has already passed.'); return; }
    openModal(t.dataset.date, t.dataset.staff);
  },
  closeModal: function (t, e) { if (t.id === 'scrim' && e.target !== t) return; closeModal(); },
  saveShift: async function () {
    const m = state.modal, s = Number($('m-start').value), e = Number($('m-end').value);
    if (e <= s) { toast('Finish time must be after the start.', 'bad'); return; }
    const ws = weekStartOf(m.date);
    await SB.insert('shifts', { day: m.date, staff_id: m.id, start_h: s, end_h: e }, { upsert: 'day,staff_id', minimal: true });
    await touchRosterDb(ws); closeModal();
    await afterChange();
    const c = ctx(), st = c.byId[m.id], hrs = weekHours(ws, state.rosters[ws], c, m.id);
    toast(hrs > st.max ? 'Saved. ' + st.first + ' is now over their ' + st.max + 'h weekly limit.' : 'Shift saved.', hrs > st.max ? 'bad' : '');
  },
  removeShift: async function () {
    const m = state.modal, ws = weekStartOf(m.date);
    await SB.remove('shifts', { day: 'eq.' + m.date, staff_id: 'eq.' + m.id });
    await touchRosterDb(ws); closeModal(); await afterChange(); toast('Shift removed.');
  },
  recordCancel: async function () {
    const m = state.modal, ws = weekStartOf(m.date), id = state.rosters[ws].ids[m.date + '|' + m.id];
    if (!id) { toast('That shift could not be found. Reload and try again.', 'bad'); return; }
    const res = await SB.rpc('owner_record_cancellation', { p_shift: id, p_reason: formVal('m-reason'), p_msg: null });
    closeModal(); await afterChange(); state.view = 'cover'; state.coverTab = res.phase === 'chat' ? 'chat' : 'standby'; render();
    toast(res.phase === 'chat' ? 'Recorded. The shift is posted to the team chat.' : 'Recorded. The shift is open in Standby.');
  },
  postGap: async function (t) {
    const found = findGapByKey(t.dataset.key); if (!found) { toast('That gap has already been filled.'); return; }
    const g = found.gap, w = gapWindow(g);
    await SB.rpc('owner_open_gap', { p_day: g.date, p_start: g.from, p_end: g.to, p_from: w[0], p_to: w[1], p_phase: 'chat' });
    await afterChange(); toast('Posted to the team chat. ' + STAFF.length + ' people can see it.');
  },
  closeCover: async function (t) {
    await SB.update('cover_requests', { id: 'eq.' + t.dataset.id }, { status: 'closed', covered_via: 'owner', covered_at: new Date().toISOString() });
    await afterChange(); toast('Marked as covered.');
  },
  alert: async function (t) {
    const k = t.dataset.key, i = k.lastIndexOf('|');
    await sendAlerts(k.slice(0, i), [k.slice(i + 1)]); await afterChange(); toast('Alert sent. They will see it in their Brewroster app.');
  },
  alertAll: async function (t) {
    const gk = t.dataset.gap, found = findGapByKey(gk); if (!found) return;
    const ids = standbyFor(found.gap, found.ws, found.r, ctx()).filter(function (x) { return x.free && !state.alerts[gk + '|' + x.s.id]; }).map(function (x) { return x.s.id; });
    const n = await sendAlerts(gk, ids); await afterChange(); toast(n + ' ' + plural(n, 'alert') + ' sent.');
  },
  standbyDay: function (t) {
    const s = staffById(t.dataset.id), d = Number(t.dataset.d); s.standbyDays[d] = !s.standbyDays[d]; render();
    return SB.update('staff_private', { staff_id: 'eq.' + s.id }, { standby_days: s.standbyDays });
  },
  addStaff: function () { openStaffModal(null); },
  editStaff: function (t) { openStaffModal(t.dataset.id); },
  saveStaff: async function () {
    const id = state.modal && state.modal.staff;
    const name = formVal('f-name'), role = formVal('f-role'), email = formVal('f-email').toLowerCase() || null, rate = parseFloat($('f-rate').value), max = parseInt($('f-max').value, 10), bar = $('f-bar').checked;
    if (!name) { toast('Please enter a name.', 'bad'); return; }
    if (email && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) { toast('That email address does not look right.', 'bad'); return; }
    if (!(rate >= 0) || !(max >= 1 && max <= 60)) { toast('Check the pay rate and the weekly hours.', 'bad'); return; }
    const avail = [], sb = [];
    for (let i = 0; i < 7; i++) {
      const on = $('av-on-' + i).checked, a = Number($('av-s-' + i).value), b = Number($('av-e-' + i).value);
      if (on && b <= a) { toast('Finish must be after start on ' + DOW_LONG[i] + '.', 'bad'); return; }
      avail.push(on ? [a, b] : null); sb.push($('sb-' + i).checked);
    }
    if (id) {
      await SB.update('staff', { id: 'eq.' + id }, { name: name, role_title: role, barista: bar });
      await SB.update('staff_private', { staff_id: 'eq.' + id }, { email: email, rate: rate, max_hours: max, avail: avail, standby_days: sb });
    } else {
      const rows = await SB.insert('staff', { name: name, role_title: role, barista: bar, skills: [], sort: state.allStaff.length + 1 });
      try { await SB.insert('staff_private', { staff_id: rows[0].id, email: email, rate: rate, max_hours: max, avail: avail, standby_days: sb }, { minimal: true }); }
      catch (e) { await SB.remove('staff', { id: 'eq.' + rows[0].id }); throw e; }
    }
    closeModal(); await afterChange(); toast(id ? 'Saved.' : name + ' was added. They can sign up with ' + (email || 'an email you add later') + '.');
  },
  removeStaff: async function (t) {
    const s = staffById(t.dataset.id);
    if (!confirm('Remove ' + s.name + ' from the team? Their past shifts stay on record. You can add them back later.')) return;
    await SB.update('staff', { id: 'eq.' + s.id }, { active: false }); closeModal(); await afterChange(); toast(s.first + ' was removed from the team.');
  },
  restoreStaff: async function (t) { await SB.update('staff', { id: 'eq.' + t.dataset.id }, { active: true }); await afterChange(); toast('Added back to the team.'); },
  saveCafe: async function () {
    const tz = formVal('cs-tz') || 'Australia/Sydney';
    try { new Intl.DateTimeFormat('en-AU', { timeZone: tz }); } catch (e) { toast('That time zone is not recognised. Try something like Australia/Sydney.', 'bad'); return; }
    const lat = formVal('cs-lat') === '' ? null : parseFloat(formVal('cs-lat')), lng = formVal('cs-lng') === '' ? null : parseFloat(formVal('cs-lng'));
    if ((lat !== null && !(lat >= -90 && lat <= 90)) || (lng !== null && !(lng >= -180 && lng <= 180))) { toast('Check the latitude and longitude.', 'bad'); return; }
    await saveSettings({ cafe_name: formVal('cs-name') || 'My Cafe', timezone: tz, lat: lat, lng: lng });
    try { localStorage.removeItem('brewroster.wx.' + TODAY); } catch (e) { /* ignore */ }
    await reload({ pos: false }); render(); setCafeName();
    try { if (await refreshLiveWeather()) await afterChange(); } catch (e) { /* weather is optional */ }
    toast('Cafe settings saved.');
  },
  useLocation: function () {
    if (!navigator.geolocation) { toast('Your browser cannot share a location.', 'bad'); return; }
    navigator.geolocation.getCurrentPosition(function (p) { $('cs-lat').value = p.coords.latitude.toFixed(4); $('cs-lng').value = p.coords.longitude.toFixed(4); }, function () { toast('Could not get your location. You can type it in instead.', 'bad'); });
  },
  resetSample: async function () {
    if (!confirm('Replace the team, sales, leave, rosters and chat with fresh sample data? This cannot be undone.')) return;
    await SB.rpc('seed_demo', { p_reset: true }); await bootstrapSample(); state.view = 'home'; render(); toast('Sample cafe loaded.');
  },
  addEvent: async function () {
    const day = formVal('ev-date'), name = formVal('ev-name'), kind = formVal('ev-kind'), from = Number(formVal('ev-from')), to = Number(formVal('ev-to')), pct = parseFloat(formVal('ev-pct'));
    if (!day || !name) { toast('Add a date and a name.', 'bad'); return; }
    if (to <= from) { toast('The end time must be after the start.', 'bad'); return; }
    if (!(pct >= -60 && pct <= 100)) { toast('The change should be between -60 and 100 percent.', 'bad'); return; }
    await SB.insert('events', { day: day, name: name, short_name: name.slice(0, 20), from_h: from, to_h: to, mult: Math.round((1 + pct / 100) * 100) / 100, kind: kind }, { minimal: true });
    await afterChange(); toast('Added. The forecast now includes it.');
  },
  delEvent: async function (t) { await SB.remove('events', { id: 'eq.' + t.dataset.id }); await afterChange(); toast('Removed.'); },
  importPos: async function () {
    const f = $('pos-file') && $('pos-file').files[0];
    const text = f ? await f.text() : formVal('pos-csv');
    if (!text.trim()) { toast('Choose a file or paste some rows first.', 'bad'); return; }
    const p = parsePos(text);
    if (!p.rows.length) { toast('No usable rows found. ' + (p.errors[0] || 'Each row needs date, hour, transactions, sales.'), 'bad'); return; }
    for (let i = 0; i < p.rows.length; i += 400) await SB.insert('pos_hourly', p.rows.slice(i, i + 400), { upsert: 'day,hour', minimal: true });
    await afterChange({ pos: true });
    toast('Imported ' + p.rows.length + ' hourly rows.' + (p.errors.length ? ' Skipped: ' + p.errors.join('; ') : ''), p.errors.length ? 'bad' : '');
  },
  sendChat: async function () {
    const inp = $('chat-in'), body = inp ? inp.value.trim() : '';
    if (!body) { toast('Type a message first.', 'bad'); return; }
    await SB.rpc('send_chat', { p_body: body });
    await afterChange();
  },
  lateExcuse: function (t) { openLateSheet(t.dataset.id, 'excuse'); },
  lateNote: function (t) { openLateSheet(t.dataset.id, 'note'); },
  lateSaveNote: async function () {
    const m = state.modal; if (!m || !m.late) return;
    await SB.rpc('late_event_note', { p_cover: m.late, p_note: formVal('late-note') });
    closeModal(); await afterChange(); toast('Note saved.');
  },
  lateSaveExcuse: async function () {
    const m = state.modal; if (!m || !m.late) return;
    const r = await SB.rpc('late_event_excuse', { p_cover: m.late, p_excused: true, p_note: formVal('late-note') || null });
    closeModal(); await afterChange();
    toast(r && r.state === 'closed' ? 'Marked as excused. The count is now below ' + lateData().threshold + ', so the alert has closed.' : 'Marked as excused.');
  },
  lateUnexcuse: async function (t) {
    const r = await SB.rpc('late_event_excuse', { p_cover: t.dataset.id, p_excused: false });
    await afterChange(); toast(r && r.state === 'open' ? 'Excuse removed. The alert is open again.' : 'Excuse removed.');
  },
  lateWatch: async function (t) {
    await SB.rpc('late_alert_watch', { p_alert: t.dataset.id });
    await afterChange(); toast('Okay. It stays here and comes back to your home list if there is another late opt-out.');
  },
  lateDismiss: async function (t) {
    await SB.rpc('late_alert_dismiss', { p_alert: t.dataset.id });
    await afterChange(); toast('Alert dismissed. Your name and the time are in the audit log.');
  },
  saveLateSettings: async function () {
    const n = parseInt(formVal('cs-late-n'), 10), h = parseInt(formVal('cs-late-h'), 10);
    if (!(n >= 2 && n <= 20)) { toast('Alert after must be between 2 and 20 late opt-outs.', 'bad'); return; }
    if (!(h >= 1 && h <= 48)) { toast('Short notice must be between 1 and 48 hours.', 'bad'); return; }
    await SB.rpc('late_save_settings', { p_threshold: n, p_window: h });
    await afterChange(); toast('Alert settings saved.');
  },
  signOut: function () { return signOutNow(); }
};
document.addEventListener('keydown', function (e) {
  if (e.key === 'Escape' && state.modal) closeModal();
  if (e.key === 'Enter' && e.target && e.target.id === 'chat-in') { e.preventDefault(); const b = document.querySelector('[data-act=sendChat]'); if (b) b.click(); }
});
