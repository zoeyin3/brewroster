/* ============================================================
   Brewroster logic: dates, POS history, forecast, optimiser
   Pure logic, no DOM access. TODAY / STAFF / WEATHER / EVENTS are filled from the database.
   ============================================================ */

/* ---------- dates ---------- */
const DOW = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
const DOW_LONG = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];
const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
function pd(s) { const p = s.split('-').map(Number); return new Date(Date.UTC(p[0], p[1] - 1, p[2])); }
function fd(d) { return d.toISOString().slice(0, 10); }
function addDays(s, n) { const d = pd(s); d.setUTCDate(d.getUTCDate() + n); return fd(d); }
function dowOf(s) { return (pd(s).getUTCDay() + 6) % 7; }
function dayNum(s) { return pd(s).getUTCDate(); }
function monOf(s) { return MON[pd(s).getUTCMonth()]; }
function dLabel(s) { return DOW[dowOf(s)] + ' ' + dayNum(s) + ' ' + monOf(s); }
function dShort(s) { return dayNum(s) + ' ' + monOf(s); }
function weekDays(ws) { return [0, 1, 2, 3, 4, 5, 6].map(function (i) { return addDays(ws, i); }); }
function weekStartOf(s) { return addDays(s, -dowOf(s)); }
function daysBetween(a, b) { return Math.round((pd(b) - pd(a)) / 864e5); }

/* ---------- opening hours ---------- */
const OPEN_H = 7;
const MIN_LEN = 2;
const MAX_LEN = 8;
const WALK = 0.6; // share of customers who walk away from a long queue
function closeH(dow) { return dow < 5 ? 15 : 14; }
function openHours(dow) { const a = []; for (let h = OPEN_H; h < closeH(dow); h++) a.push(h); return a; }
function ampm(h) { return h >= 12 ? 'pm' : 'am'; }
function h12(h) { return h > 12 ? h - 12 : h; }
function hFmt(h) { return h12(h) + ampm(h); }
function hRange(a, b) { return ampm(a) === ampm(b) ? h12(a) + '–' + h12(b) + ampm(b) : hFmt(a) + '–' + hFmt(b); }
function hColon(h) { return h12(h) + ':00' + ampm(h); }

/* ---------- typical cafe pattern (used until real POS history exists) ---------- */
const BASE_TX = {
  wk: [52, 72, 62, 41, 38, 57, 34, 18],
  fri: [55, 76, 66, 46, 42, 62, 38, 20],
  sat: [30, 52, 74, 82, 72, 54, 32],
  sun: [26, 46, 70, 78, 68, 50, 28]
};
const TICKET = [9.6, 10.4, 12.8, 14.2, 15.0, 16.8, 15.4, 13.2];
function baseFor(dow, h) {
  const k = dow < 4 ? 'wk' : dow === 4 ? 'fri' : dow === 5 ? 'sat' : 'sun';
  return BASE_TX[k][h - OPEN_H];
}
// rows: [{d, dow, h, tx, sales}]. Hours with no history fall back to a typical cafe pattern.
function buildBaseline(rows) {
  const b = [0, 1, 2, 3, 4, 5, 6].map(function () { return {}; });
  rows.forEach(function (r) {
    if (r.h < OPEN_H || r.h >= closeH(r.dow)) return;
    const c = b[r.dow][r.h] || (b[r.dow][r.h] = { sumTx: 0, sumSales: 0, n: 0, min: 1e9, max: 0, vals: [] });
    c.sumTx += r.tx; c.sumSales += r.sales; c.n++; c.min = Math.min(c.min, r.tx); c.max = Math.max(c.max, r.tx); c.vals.push(r.tx);
  });
  for (let dow = 0; dow < 7; dow++) {
    openHours(dow).forEach(function (h) {
      const c = b[dow][h];
      if (c) { c.tx = c.sumTx / c.n; c.ticket = c.sumSales / c.sumTx; c.sales = c.sumSales / c.n; }
      else {
        const tx = baseFor(dow, h), tk = TICKET[h - OPEN_H] + (dow >= 5 ? 1.4 : 0);
        b[dow][h] = { sumTx: 0, sumSales: 0, n: 0, min: tx, max: tx, vals: [tx], tx: tx, ticket: tk, sales: tx * tk, fallback: true };
      }
    });
  }
  return b;
}
function peakList(baseline) {
  const out = [];
  for (let dow = 0; dow < 7; dow++) openHours(dow).forEach(function (h) { out.push({ dow: dow, h: h, tx: baseline[dow][h].tx }); });
  out.sort(function (a, b) { return b.tx - a.tx; });
  return out;
}

/* ---------- outside signals (loaded from the database) ---------- */
let WEATHER = {};   // 'YYYY-MM-DD' -> { c: 'Sunny', t: 24, m: 1.02 }
let EVENTS = [];    // { id, date, name, short, from, to, m }
let SCHOOL = [];    // same shape, for school dates
function dayFactors(date) {
  return {
    weather: WEATHER[date] || null,
    events: EVENTS.filter(function (e) { return e.date === date; }),
    school: SCHOOL.filter(function (e) { return e.date === date; })
  };
}

/* ---------- clock and staff ---------- */
const NOTICE_DAYS = 14;
const STANDBY_HOURS = 48;
let TODAY = '2026-01-01';
let NOW_HOUR = 9;
function setClock(today, minutes) { TODAY = today; NOW_HOUR = minutes / 60; }
function hoursUntil(date, hour) { return daysBetween(TODAY, date) * 24 + hour - NOW_HOUR; }
// leave: 14+ days ahead. standby: within 48 hours. optout: in between (shift goes to the team chat)
function noticeTier(date, startHour) {
  if (daysBetween(TODAY, date) >= NOTICE_DAYS) return 'leave';
  return hoursUntil(date, startHour) <= STANDBY_HOURS ? 'standby' : 'optout';
}
function standbyOpens(date, startHour) { return { date: addDays(date, -2), hour: startHour }; }
// STAFF holds the active team. Each person: { id, name, first, initials, role, skills, barista, rate, max, avail, standbyDays, email }
const STAFF = [];
function personFromRow(r, p) {
  const parts = String(r.name || '?').trim().split(/\s+/);
  return {
    id: r.id, name: r.name, role: r.role_title || '', skills: r.skills || [], barista: !!r.barista, active: r.active !== false, sort: r.sort || 0,
    first: parts[0], initials: (parts[0][0] + (parts.length > 1 ? parts[parts.length - 1][0] : '')).toUpperCase(),
    email: p ? p.email : null, rate: p ? Number(p.rate) : 0, max: p ? Number(p.max_hours) : 0,
    avail: p ? p.avail : [null, null, null, null, null, null, null], standbyDays: p ? p.standby_days.map(Boolean) : [false, false, false, false, false, false, false]
  };
}
function setStaff(list) { STAFF.length = 0; list.forEach(function (x) { STAFF.push(x); }); }

/* ---------- context ---------- */
function mkCtx(st) {
  const byId = {}; STAFF.forEach(function (s) { byId[s.id] = s; });
  const avgRate = STAFF.reduce(function (a, s) { return a + s.rate; }, 0) / (STAFF.length || 1);
  return {
    staff: STAFF, byId: byId, avgRate: avgRate, leaves: st.leaves, planPending: st.planPending,
    cap: st.cap, minStaff: st.minStaff, baseline: st.baseline, factors: st.factors, late: st.late || []
  };
}
function leaveOn(ctx, id, date) {
  let found = null;
  for (let i = 0; i < ctx.leaves.length; i++) {
    const l = ctx.leaves[i];
    if (l.staffId !== id || date < l.from || date > l.to) continue;
    if (l.status === 'approved') return 'approved';
    if (l.status === 'pending' && ctx.planPending) found = 'pending';
  }
  const late = ctx.late || [];
  for (let j = 0; j < late.length; j++) { if (late[j].staffId === id && late[j].date === date) return 'late'; }
  return found;
}
function leaveRaw(ctx, id, date) {
  let found = null;
  for (let i = 0; i < ctx.leaves.length; i++) {
    const l = ctx.leaves[i];
    if (l.staffId !== id || date < l.from || date > l.to) continue;
    if (l.status === 'approved') return 'approved';
    if (l.status === 'pending') found = 'pending';
  }
  return found;
}

/* ---------- forecast ---------- */
function needFor(tx, ctx) { return Math.min(6, Math.max(ctx.minStaff, Math.ceil(tx / ctx.cap))); }
function forecastDay(date, ctx) {
  const dow = dowOf(date), f = dayFactors(date), out = [];
  openHours(dow).forEach(function (h) {
    const b = ctx.baseline[dow][h]; let m = 1;
    if (ctx.factors.weather && f.weather) m *= f.weather.m;
    if (ctx.factors.events) f.events.forEach(function (e) { if (h >= e.from && h < e.to) m *= e.m; });
    if (ctx.factors.school) f.school.forEach(function (e) { if (h >= e.from && h < e.to) m *= e.m; });
    const tx = Math.round(b.tx * m), need = needFor(tx, ctx);
    out.push({ h: h, tx: tx, base: Math.round(b.tx), ticket: b.ticket, need: need, bneed: need >= 4 ? 2 : 1 });
  });
  return out;
}

/* ---------- evaluation ---------- */
function evalDay(date, shifts, ctx) {
  const fc = forecastDay(date, ctx), eff = {}, clashes = [], lates = [];
  Object.keys(shifts).forEach(function (id) { const lv = leaveOn(ctx, id, date); if (lv === 'late') lates.push(id); else if (lv) clashes.push(id); else eff[id] = shifts[id]; });
  let labour = 0, hours = 0;
  Object.keys(eff).forEach(function (id) { const len = eff[id][1] - eff[id][0]; hours += len; labour += len * ctx.byId[id].rate; });
  const cov = fc.map(function (x) {
    let have = 0, hb = 0;
    Object.keys(eff).forEach(function (id) {
      const sh = eff[id];
      if (x.h >= sh[0] && x.h < sh[1]) { have++; if (ctx.byId[id].barista) hb++; }
    });
    const lostTx = Math.max(0, x.tx - have * ctx.cap) * WALK;
    return {
      h: x.h, tx: x.tx, base: x.base, ticket: x.ticket, have: have, hb: hb, need: x.need, bneed: x.bneed,
      short: Math.max(0, x.need - have), over: Math.max(0, have - x.need), bshort: Math.max(0, x.bneed - hb),
      lostTx: lostTx, lostSales: lostTx * x.ticket, sales: x.tx * x.ticket
    };
  });
  return { date: date, cov: cov, labour: labour, hours: hours, clashes: clashes, lates: lates, eff: eff };
}
function evalWeek(ws, roster, ctx) {
  const days = weekDays(ws).map(function (d) { return evalDay(d, roster.shifts[d] || {}, ctx); });
  const t = { days: days, labour: 0, hours: 0, shortHours: 0, shortfall: 0, overHours: 0, lostSales: 0, forecastSales: 0, forecastTx: 0, clashes: 0, lates: 0, bshortHours: 0 };
  days.forEach(function (d) {
    t.labour += d.labour; t.hours += d.hours; t.clashes += d.clashes.length; t.lates += d.lates.length;
    d.cov.forEach(function (c) {
      if (c.short > 0) t.shortHours++;
      if (c.bshort > 0) t.bshortHours++;
      t.shortfall += c.short; t.overHours += c.over; t.lostSales += c.lostSales; t.forecastSales += c.sales; t.forecastTx += c.tx;
    });
  });
  t.wasted = t.overHours * ctx.avgRate;
  t.labourPct = t.forecastSales ? t.labour / t.forecastSales * 100 : 0;
  return t;
}
function weekHours(ws, roster, ctx, id) {
  let t = 0;
  weekDays(ws).forEach(function (d) {
    const sh = roster.shifts[d] && roster.shifts[d][id];
    if (sh && !leaveOn(ctx, id, d)) t += sh[1] - sh[0];
  });
  return t;
}

/* ---------- optimiser ---------- */
const W_COVER = 4, W_BAR = 4, W_OVER = 1.6, W_COST = 0.012, W_FAIR = 1.5;
function solveDay(info, ctx, used) {
  const dow = info.dow, close = closeH(dow), hours = openHours(dow);
  const need = {}, bneed = {}, have = {}, hb = {};
  info.fc.forEach(function (x) { need[x.h] = x.need; bneed[x.h] = x.bneed; have[x.h] = 0; hb[x.h] = 0; });
  const shifts = {};
  for (let guard = 0; guard < 40; guard++) {
    let best = null;
    info.avail.forEach(function (s) {
      if (shifts[s.id]) return;
      const av = s.avail[dow], remaining = s.max - used[s.id];
      const lo = Math.max(av[0], hours[0]), hi = Math.min(av[1], close);
      for (let st = lo; st + MIN_LEN <= hi; st++) {
        for (let len = MIN_LEN; len <= MAX_LEN && st + len <= hi && len <= remaining; len++) {
          let cover = 0, over = 0, bc = 0;
          for (let h = st; h < st + len; h++) {
            if (have[h] < need[h]) cover++; else over++;
            if (s.barista && hb[h] < bneed[h]) bc++;
          }
          const score = W_COVER * cover + W_BAR * bc - W_OVER * over - W_COST * s.rate * len - W_FAIR * ((used[s.id] + len) / s.max);
          if (!best || score > best.score + 1e-9) best = { s: s, st: st, len: len, score: score, cover: cover, bc: bc };
        }
      }
    });
    if (!best || best.score <= 0 || (best.cover === 0 && best.bc === 0)) break;
    shifts[best.s.id] = [best.st, best.st + best.len];
    used[best.s.id] += best.len;
    for (let h = best.st; h < best.st + best.len; h++) { have[h]++; if (best.s.barista) hb[h]++; }
  }
  // trim edges that are pure overstaffing
  Object.keys(shifts).forEach(function (id) {
    const s = ctx.byId[id], sh = shifts[id];
    function removable(h) { return have[h] > need[h] && !(s.barista && hb[h] <= bneed[h]); }
    while (sh[1] - sh[0] > MIN_LEN && removable(sh[0])) { have[sh[0]]--; if (s.barista) hb[sh[0]]--; sh[0]++; used[id]--; }
    while (sh[1] - sh[0] > MIN_LEN && removable(sh[1] - 1)) { have[sh[1] - 1]--; if (s.barista) hb[sh[1] - 1]--; sh[1]--; used[id]--; }
  });
  return shifts;
}
function optimiseWeek(ws, ctx) {
  const days = weekDays(ws), used = {};
  ctx.staff.forEach(function (s) { used[s.id] = 0; });
  const infos = days.map(function (date) {
    const dow = dowOf(date), fc = forecastDay(date, ctx);
    const avail = ctx.staff.filter(function (s) { return s.avail[dow] && !leaveOn(ctx, s.id, date); });
    return { date: date, dow: dow, fc: fc, avail: avail, total: fc.reduce(function (a, x) { return a + x.need; }, 0) };
  });
  const order = infos.slice().sort(function (a, b) {
    return (b.total / (b.avail.length || 1)) - (a.total / (a.avail.length || 1)) || a.date.localeCompare(b.date);
  });
  const shifts = {}; days.forEach(function (d) { shifts[d] = {}; });
  order.forEach(function (info) { shifts[info.date] = solveDay(info, ctx, used); });
  return { shifts: shifts, source: 'ai', status: 'draft', stale: false, sb: {} };
}

/* ---------- last week's pattern, copied forward (what the owner would do from habit) ---------- */
function copyForward(prev, ws, prevWs) {
  const shifts = {};
  weekDays(ws).forEach(function (d, i) {
    const src = prev.shifts[addDays(prevWs, i)] || {};
    shifts[d] = {};
    Object.keys(src).forEach(function (id) { shifts[d][id] = src[id].slice(); });
  });
  return { shifts: shifts, source: 'copied', status: 'draft', stale: false, sb: {} };
}
function cloneRoster(r) {
  const shifts = {};
  Object.keys(r.shifts).forEach(function (d) {
    shifts[d] = {};
    Object.keys(r.shifts[d]).forEach(function (id) { shifts[d][id] = r.shifts[d][id].slice(); });
  });
  return { shifts: shifts, source: r.source, status: r.status, stale: r.stale, sb: Object.assign({}, r.sb || {}) };
}

/* ---------- gaps and standby ---------- */
function findGaps(ws, roster, ctx) {
  const gaps = [];
  weekDays(ws).forEach(function (date) {
    const ev = evalDay(date, roster.shifts[date] || {}, ctx); let cur = null;
    ev.cov.forEach(function (c) {
      const bad = c.short > 0 || c.bshort > 0;
      if (bad) {
        if (!cur) cur = { date: date, from: c.h, to: c.h + 1, short: c.short, bshort: c.bshort, lost: c.lostSales };
        else { cur.to = c.h + 1; cur.short = Math.max(cur.short, c.short); cur.bshort = Math.max(cur.bshort, c.bshort); cur.lost += c.lostSales; }
      } else if (cur) { gaps.push(cur); cur = null; }
    });
    if (cur) gaps.push(cur);
  });
  return gaps;
}
function standbyFor(gap, ws, roster, ctx, mode) {
  const dow = dowOf(gap.date), close = closeH(dow);
  let from = gap.from, to = gap.to;
  while (to - from < MIN_LEN) { if (to < close) to++; else if (from > OPEN_H) from--; else break; }
  const len = to - from, list = [];
  ctx.staff.forEach(function (s) {
    if (mode !== 'chat' && !s.standbyDays[dow]) return;
    const lv = leaveOn(ctx, s.id, gap.date);
    if (lv === 'late') return;
    const existing = roster.shifts[gap.date] && roster.shifts[gap.date][s.id];
    const wk = weekHours(ws, roster, ctx, s.id), av = s.avail[dow];
    let why = '';
    if (lv) why = lv === 'approved' ? 'On approved leave' : 'Leave requested';
    else if (existing) why = 'Already rostered ' + hRange(existing[0], existing[1]);
    else if (wk + len > s.max) why = 'At weekly limit (' + wk + 'h of ' + s.max + 'h)';
    list.push({ s: s, from: from, to: to, len: len, wk: wk, free: !why, why: why, inWin: !!(av && av[0] <= from && av[1] >= to), cost: len * s.rate });
  });
  list.sort(function (a, b) {
    // same order the automatic alerts use: free first, then fewest hours worked that week
    return (b.free - a.free) || (a.wk - b.wk) || (a.s.name < b.s.name ? -1 : a.s.name > b.s.name ? 1 : 0);
  });
  return list;
}
function lateImpact(l, ws, roster, ctx) {
  const ev = evalDay(l.date, roster.shifts[l.date] || {}, ctx);
  const o = { shortHours: 0, shortfall: 0, lost: 0, bshortHours: 0, from: null, to: null };
  ev.cov.forEach(function (c) {
    if (c.h < l.shift[0] || c.h >= l.shift[1]) return;
    if (c.short > 0) { o.shortHours++; o.shortfall += c.short; if (o.from === null) o.from = c.h; o.to = c.h + 1; }
    if (c.bshort > 0) o.bshortHours++;
    o.lost += c.lostSales;
  });
  o.needs = o.shortHours > 0 || o.bshortHours > 0;
  return o;
}
/* ---------- leave impact ---------- */
const impactCache = {};
function leaveImpact(req, ctx) {
  const key = JSON.stringify([req.id, req.from, req.to, ctx.leaves.map(function (l) { return [l.id, l.status]; }), ctx.planPending, ctx.cap, ctx.minStaff, ctx.factors, ctx.staff.map(function (s) { return s.max; })]);
  if (impactCache[key]) return impactCache[key];
  const out = { extraShortfall: 0, extraLost: 0, extraCost: 0, extraB: 0, cover: {}, gaps: [] };
  const base = ctx.leaves.filter(function (l) { return l.id !== req.id; });
  const withReq = base.concat([Object.assign({}, req, { status: 'approved' })]);
  const c0 = Object.assign({}, ctx, { leaves: base }), c1 = Object.assign({}, ctx, { leaves: withReq });
  for (let ws = weekStartOf(req.from); ws <= weekStartOf(req.to); ws = addDays(ws, 7)) {
    const r0 = optimiseWeek(ws, c0), r1 = optimiseWeek(ws, c1);
    const e0 = evalWeek(ws, r0, c0), e1 = evalWeek(ws, r1, c1);
    out.extraShortfall += e1.shortfall - e0.shortfall;
    out.extraLost += e1.lostSales - e0.lostSales;
    out.extraCost += e1.labour - e0.labour;
    out.extraB += e1.bshortHours - e0.bshortHours;
    ctx.staff.forEach(function (s) {
      const d = weekHours(ws, r1, c1, s.id) - weekHours(ws, r0, c0, s.id);
      if (s.id !== req.staffId) out.cover[s.id] = (out.cover[s.id] || 0) + d;
    });
    const hitDays = {};
    e1.days.forEach(function (d1, i) {
      const sh0 = e0.days[i].cov.reduce(function (a, c) { return a + c.short; }, 0);
      const sh1 = d1.cov.reduce(function (a, c) { return a + c.short; }, 0);
      const b0 = e0.days[i].cov.filter(function (c) { return c.bshort > 0; }).length, b1 = d1.cov.filter(function (c) { return c.bshort > 0; }).length;
      if (sh1 > sh0 || b1 > b0) hitDays[d1.date] = true;
    });
    findGaps(ws, r1, c1).forEach(function (g) { if (hitDays[g.date]) out.gaps.push(g); });
  }
  out.extraLost = Math.max(0, out.extraLost);
  out.coverList = Object.keys(out.cover).map(function (id) { return { s: ctx.byId[id], h: out.cover[id] }; })
    .filter(function (x) { return x.h >= 2; }).sort(function (a, b) { return b.h - a.h; }).slice(0, 3);
  out.level = out.extraShortfall <= 0 && out.extraB <= 0 && out.extraLost < 30 ? 'safe' : (out.extraShortfall >= 4 || out.extraLost >= 150 ? 'risk' : 'watch');
  impactCache[key] = out;
  return out;
}

/* ---------- explanation of what the optimiser changed ---------- */
function money(n) { return '$' + Math.round(n).toLocaleString('en-AU'); }
function explain(ws, before, after, ctx) {
  const out = [], days = weekDays(ws);
  const eb = evalWeek(ws, before, ctx), ea = evalWeek(ws, after, ctx);
  const removed = {};
  days.forEach(function (d) {
    Object.keys(before.shifts[d] || {}).forEach(function (id) {
      if (leaveOn(ctx, id, d) && leaveOn(ctx, id, d) !== 'late' && !(after.shifts[d] && after.shifts[d][id])) (removed[id] = removed[id] || []).push(DOW[dowOf(d)]);
    });
  });
  const names = Object.keys(removed);
  if (names.length) {
    out.push({ ok: true, text: 'Took ' + names.map(function (id) { return ctx.byId[id].first + ' (' + removed[id].join(', ') + ')'; }).join(', ').replace(/, ([^,]*)$/, ' and $1') + ' off the roster while they are away.' });
  }
  const fixes = [];
  days.forEach(function (d) {
    const cb = evalDay(d, before.shifts[d] || {}, ctx), ca = evalDay(d, after.shifts[d] || {}, ctx), imp = [];
    ca.cov.forEach(function (c, i) { if (cb.cov[i].short > c.short) imp.push(i); });
    const sb = cb.cov.reduce(function (a, c) { return a + c.short; }, 0), sa = ca.cov.reduce(function (a, c) { return a + c.short; }, 0);
    if (sb - sa >= 2 && imp.length) {
      const pk = imp.reduce(function (a, i) { return ca.cov[i].tx > ca.cov[a].tx ? i : a; }, imp[0]);
      fixes.push({ gain: sb - sa, text: DOW[dowOf(d)] + ' ' + hRange(ca.cov[imp[0]].h, ca.cov[imp[imp.length - 1]].h + 1) + ': ' + ca.cov[pk].have + ' on at the busiest hour (about ' + ca.cov[pk].tx + ' transactions), up from ' + cb.cov[pk].have + '.' });
    }
  });
  fixes.sort(function (a, b) { return b.gain - a.gain; }).slice(0, 3).forEach(function (f) { out.push({ ok: true, text: 'Filled short-staffed hours. ' + f.text }); });
  if (eb.overHours - ea.overHours >= 2) out.push({ ok: true, text: 'Trimmed ' + (eb.overHours - ea.overHours) + ' staff-hours of quiet-time overstaffing, saving about ' + money(eb.wasted - ea.wasted) + ' in wages.' });
  const gaps = findGaps(ws, after, ctx);
  if (gaps.length) out.push({ ok: false, text: gaps.length + (gaps.length === 1 ? ' gap' : ' gaps') + ' left that the team cannot cover (' + gaps.slice(0, 3).map(function (g) { return DOW[dowOf(g.date)] + ' ' + hRange(g.from, g.to); }).join(', ') + '). Standby staff are suggested.' });
  return { items: out, before: eb, after: ea };
}
