/* ============================================================
   Data layer: load everything for a role from Supabase and map it
   into the shapes the screens use.
   ============================================================ */
let WEEKS = [];

function byKey(rows, k) { const o = {}; rows.forEach(function (r) { o[r[k]] = r; }); return o; }
function toLeave(r) {
  return { id: r.id, staffId: r.staff_id, from: r.from_day, to: r.to_day, type: r.type, reason: r.reason || r.type, submitted: r.submitted, status: r.status, via: 'Staff app', msg: r.message || r.reason || '' };
}

/* ---------------------------- owner ---------------------------- */
async function loadOwnerData(opts) {
  opts = opts || {};
  await syncClock();
  try { await SB.rpc('escalate_due_cover'); } catch (e) { /* not critical */ }
  WEEKS = weeksFrom(TODAY);
  const from = WEEKS[0], to = addDays(WEEKS[3], 6), since = addDays(TODAY, -7);
  const q = await Promise.all([
    SB.select('settings'),
    SB.select('staff', { order: 'sort.asc,name.asc' }),
    SB.select('staff_private'),
    opts.pos === false ? null : SB.select('pos_hourly', { day: 'gte.' + addDays(TODAY, -56), order: 'day.asc', limit: 5000 }),
    SB.select('weather', { day: 'gte.' + addDays(TODAY, -14), order: 'day.asc', limit: 2000 }),
    SB.select('events', { order: 'day.asc', limit: 500 }),
    SB.select('leave_requests', { order: 'from_day.asc', limit: 1000 }),
    SB.select('rosters', { week_start: ['gte.' + from, 'lte.' + to] }),
    SB.select('shifts', { day: ['gte.' + from, 'lte.' + to], limit: 3000 }),
    SB.select('cover_requests', { day: 'gte.' + since, order: 'day.asc,start_h.asc', limit: 1000 }),
    SB.select('chat_messages', { order: 'created_at.desc', limit: 30 }),
    SB.select('standby_alerts', { day: 'gte.' + since, limit: 2000 }),
    SB.select('profiles', { select: 'staff_id,role', role: 'eq.employee' })
  ]);
  return q;
}

function applyOwnerData(q) {
  const settings = q[0][0] || {}, staffRows = q[1], priv = byKey(q[2], 'staff_id');
  APP.settings = settings; if (settings.timezone) APP.tz = settings.timezone;
  state.cap = settings.cap || 20; state.minStaff = settings.min_staff || 2;
  state.factors = { weather: settings.use_weather !== false, events: settings.use_events !== false, school: settings.use_school !== false };

  const all = staffRows.map(function (r) { return personFromRow(r, priv[r.id]); });
  state.allStaff = all; state.allById = byKey(all, 'id');
  setStaff(all.filter(function (p) { return p.active; }));
  const byId = byKey(STAFF, 'id');

  if (q[3]) {
    state.hist = q[3].map(function (r) { return { d: r.day, dow: dowOf(r.day), h: r.hour, tx: r.tx, sales: Number(r.sales) }; });
    state.baseline = buildBaseline(state.hist);
  }

  WEATHER = {}; q[4].forEach(function (r) { WEATHER[r.day] = { c: r.summary, t: r.temp, m: Number(r.mult) }; });
  EVENTS = []; SCHOOL = [];
  q[5].forEach(function (r) {
    const e = { id: r.id, date: r.day, name: r.name, short: r.short_name || r.name, from: r.from_h, to: r.to_h, m: Number(r.mult) };
    (r.kind === 'school' ? SCHOOL : EVENTS).push(e);
  });

  state.leaves = q[6].map(toLeave);

  // rosters and shifts
  const rosterRows = q[7], shiftRows = q[8];
  state.rosters = {}; state.explain = {};
  WEEKS.forEach(function (ws) {
    const row = rosterRows.find(function (r) { return r.week_start === ws; });
    if (!row) { state.rosters[ws] = emptyRoster(); return; }
    const r = { shifts: {}, source: row.source, status: row.status === 'uploaded' ? 'approved' : 'draft', stale: false, sb: {}, ids: {} };
    weekDays(ws).forEach(function (d) { r.shifts[d] = {}; });
    shiftRows.forEach(function (s) {
      if (s.week_start !== ws || !byId[s.staff_id]) return;
      r.shifts[s.day][s.staff_id] = [s.start_h, s.end_h];
      r.ids[s.day + '|' + s.staff_id] = s.id;
      if (s.via !== 'roster') r.sb[s.day + '|' + s.staff_id] = s.via === 'chat' ? 'chat' : true;
    });
    state.rosters[ws] = r; state.explain[ws] = row.explain || null;
  });

  // cover requests
  state.covers = q[9]; state.late = []; state.posted = {};
  const keyOf = {};
  q[9].forEach(function (c) {
    if (c.day < WEEKS[0]) return;
    if (c.kind === 'gap') {
      const k = 'G' + c.day + '-' + c.start_h; keyOf[c.id] = k;
      if (c.status === 'open') state.posted[k] = { at: fmtAt(c.created_at), id: c.id, phase: c.phase };
      return;
    }
    if (!state.allById[c.staff_id]) return;
    keyOf[c.id] = 'C' + c.id;
    state.late.push({ id: c.id, kind: c.kind, phase: c.phase, staffId: c.staff_id, date: c.day, shift: [c.w_from, c.w_to], reason: c.reason || '', msg: c.message || '',
      at: fmtAt(c.created_at), status: c.status, coveredBy: c.covered_by, via: c.covered_via || (c.kind === 'optout' ? 'chat' : 'standby') });
  });

  // standby calls
  state.alerts = {}; state.log = [];
  const replies = [];
  q[11].forEach(function (a) {
    const gk = keyOf[a.cover_id]; if (!gk) return;
    state.alerts[gk + '|' + a.staff_id] = { id: a.id, status: a.status };
    if (a.status === 'accepted' || a.status === 'declined') replies.push(a);
  });
  replies.sort(function (a, b) { return String(b.responded_at).localeCompare(String(a.responded_at)); });
  replies.slice(0, 4).forEach(function (a) {
    const s = state.allById[a.staff_id]; if (!s) return;
    state.log.push(a.status === 'accepted'
      ? { ok: true, text: s.first + ' accepted ' + dLabel(a.day) + ', ' + hRange(a.from_h, a.to_h) + '. Added to the roster.' }
      : { ok: false, text: s.first + ' cannot make ' + dLabel(a.day) + ', ' + hRange(a.from_h, a.to_h) + '.' });
  });

  state.linked = {}; q[12].forEach(function (p) { if (p.staff_id) state.linked[p.staff_id] = true; });
  state.chat = q[10].slice().reverse().map(function (m) { return { t: m.kind, text: m.body, at: fmtAt(m.created_at), who: m.author || '' }; });
}

/* ---------------------------- weather (live, optional) ---------------------------- */
function mapWx(day, code, tmax) {
  let c = code === 0 ? 'Sunny' : code <= 2 ? 'Fine' : code === 3 ? 'Cloudy' : (code === 45 || code === 48) ? 'Fog' : code <= 57 ? 'Drizzle' : code <= 67 ? 'Rain' : code <= 77 ? 'Snow' : code <= 82 ? 'Showers' : code <= 86 ? 'Snow showers' : 'Storms';
  const M = { Sunny: 1.03, Fine: 1.03, Cloudy: 0.98, Fog: 0.97, Drizzle: 0.94, Rain: 0.90, Showers: 0.93, Snow: 0.85, 'Snow showers': 0.88, Storms: 0.88 };
  let m = M[c];
  if (tmax >= 33 && m > 0.97) { c = 'Hot'; m = 0.97; }
  return { day: day, summary: c, temp: Math.round(tmax), mult: m, source: 'open-meteo' };
}
// Pulls the 16-day forecast once a day and stores it, so staff and Rosterbot share the same numbers.
async function refreshLiveWeather() {
  const s = APP.settings;
  if (!s || s.use_weather === false || s.lat == null || s.lng == null) return false;
  const key = 'brewroster.wx.' + TODAY;
  try { if (localStorage.getItem(key)) return false; } catch (e) { /* ignore */ }
  const url = 'https://api.open-meteo.com/v1/forecast?latitude=' + encodeURIComponent(s.lat) + '&longitude=' + encodeURIComponent(s.lng) +
    '&daily=weather_code,temperature_2m_max&timezone=' + encodeURIComponent(APP.tz) + '&forecast_days=16';
  const res = await fetch(url);
  if (!res.ok) return false;
  const j = await res.json();
  if (!j.daily || !j.daily.time) return false;
  const rows = j.daily.time.map(function (d, i) { return mapWx(d, j.daily.weather_code[i], j.daily.temperature_2m_max[i]); });
  await SB.insert('weather', rows, { upsert: 'day', minimal: true });
  try { localStorage.setItem(key, '1'); } catch (e) { /* ignore */ }
  return true;
}

/* ---------------------------- employee ---------------------------- */
async function loadEmployeeData() {
  await syncClock();
  try { await SB.rpc('escalate_due_cover'); } catch (e) { /* not critical */ }
  WEEKS = weeksFrom(TODAY);
  const from = addDays(WEEKS[0], -7), to = addDays(WEEKS[3], 6), me = APP.profile.staff_id;
  return Promise.all([
    SB.select('settings'),
    SB.select('staff', { order: 'sort.asc,name.asc' }),
    SB.select('staff_private', { staff_id: 'eq.' + me }),
    SB.select('rosters', { week_start: ['gte.' + from, 'lte.' + to] }),
    SB.select('shifts', { day: ['gte.' + from, 'lte.' + to], limit: 3000 }),
    SB.select('open_shifts', { day: 'gte.' + addDays(TODAY, -7), order: 'day.asc,start_h.asc', limit: 500 }),
    SB.select('chat_messages', { order: 'created_at.desc', limit: 60 }),
    SB.select('leave_requests', { order: 'from_day.asc', limit: 200 }),
    SB.select('standby_alerts', { order: 'sent_at.desc', limit: 50 })
  ]);
}
