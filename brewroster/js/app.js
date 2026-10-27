/* ============================================================
   Boot: connect to Supabase, sign in, then load the owner or
   the employee app depending on who signed in.
   ============================================================ */
let pollTimer = null;

function loadScript(src) {
  return new Promise(function (resolve, reject) {
    const s = document.createElement('script'); s.src = src; s.onload = resolve; s.onerror = function () { reject(new Error('Could not load ' + src)); };
    document.head.appendChild(s);
  });
}
function root(html) { $('root').innerHTML = html; }
function brandBlock(sub) { return '<div class="authbrand"><span class="logo">B</span><div><b>Brewroster</b><small>' + (sub || 'Rosters for small cafes') + '</small></div></div>'; }

/* ---------- configuration ---------- */
async function readConfig() {
  const c = window.BREWROSTER_CONFIG || {};
  let url = c.SUPABASE_URL, key = c.SUPABASE_ANON_KEY;
  if (!url || !key) {
    try {
      const r = await fetch('/api/config', { headers: { Accept: 'application/json' } });
      if (r.ok && /json/.test(r.headers.get('content-type') || '')) { const j = await r.json(); url = url || j.url; key = key || j.key; }
    } catch (e) { /* no serverless function here, fine */ }
  }
  if (!url || !key) { try { url = url || localStorage.getItem('brewroster.url'); key = key || localStorage.getItem('brewroster.key'); } catch (e) { /* ignore */ } }
  return { url: url, key: key };
}

/* ---------- screens before sign-in ---------- */
function screenSetup(msg) {
  root('<div class="authwrap"><div class="authcard">' + brandBlock('Connect your database') +
    '<h1>Connect to Supabase</h1><p>Brewroster keeps everything in your own Supabase project. Paste its details here, or set them as environment variables on Vercel.</p>' +
    (msg ? '<div class="autherr">' + esc(msg) + '</div>' : '') +
    '<form id="setupform" class="form"><label>Project URL<input id="su-url" type="text" placeholder="https://abcdefgh.supabase.co" autocomplete="off"></label><label>Anon (public) key<input id="su-key" type="text" placeholder="eyJ…" autocomplete="off"></label>' +
    '<button class="btn primary" type="submit" style="justify-content:center">Save and continue</button></form>' +
    '<ol class="steps-l"><li>In Supabase, open <b>Project Settings, API</b>.</li><li>Copy the <b>Project URL</b> and the <b>anon public</b> key.</li><li>Never paste the service_role key.</li></ol></div></div>');
  $('setupform').addEventListener('submit', function (e) {
    e.preventDefault();
    const url = $('su-url').value.trim().replace(/\/+$/, ''), key = $('su-key').value.trim();
    if (!/^https?:\/\/.+/.test(url) || key.length < 20) { screenSetup('Please check the URL and the key.'); return; }
    try { localStorage.setItem('brewroster.url', url); localStorage.setItem('brewroster.key', key); } catch (err) { /* ignore */ }
    location.reload();
  });
}
/* The first thing everyone sees: which door are you using? */
function screenPortal(note, kind) {
  let last = ''; try { last = localStorage.getItem('brewroster.portal') || ''; } catch (e) { /* ignore */ }
  const tag = function (k) { return last === k ? '<em class="lasttag">Last used</em>' : ''; };
  root('<div class="authwrap"><div class="authcard wide">' + brandBlock() + '<h1>Welcome</h1><p>Choose how you are signing in.</p>' +
    (note ? '<div class="' + (kind === 'ok' ? 'authok' : 'autherr') + '" role="alert">' + esc(note) + '</div>' : '') +
    '<div class="portals">' +
    '<button class="portal" id="pt-employee" type="button"><span class="pt-ic">' + ic('me', 26) + '</span><b>Employee portal' + tag('employee') + '</b><span>See your roster, chat with the team, ask for leave and sign up for standby.</span><i>Continue ›</i></button>' +
    '<button class="portal" id="pt-owner" type="button"><span class="pt-ic">' + ic('roster', 26) + '</span><b>Owner portal' + tag('owner') + '</b><span>Build the roster, decide leave requests and cover shifts.</span><i>Continue ›</i></button>' +
    '</div></div></div>');
  $('pt-employee').addEventListener('click', function () { screenAuth('employee', 'in'); });
  $('pt-owner').addEventListener('click', function () { screenAuth('owner', 'in'); });
}
async function screenAuth(portal, mode, note, kind) {
  mode = mode || 'in';
  try { localStorage.setItem('brewroster.portal', portal); } catch (e) { /* ignore */ }
  const isOwner = portal === 'owner';
  let first = false; try { first = !(await SB.rpc('owner_exists')); } catch (e) { /* schema missing is reported later */ }
  // owners can only be created while the cafe has none; employees only once the cafe exists
  const canUp = isOwner ? first : !first;
  if (!canUp) mode = 'in';
  const up = mode === 'up';
  const name = isOwner ? 'Owner portal' : 'Employee portal';
  let intro;
  if (up) intro = isOwner ? 'You are the first person here, so this account becomes the cafe owner.' : 'Use the email address your manager added for you, so we can find your shifts.';
  else if (!isOwner && first) intro = 'This cafe has not been set up yet. The owner needs to create their account in the Owner portal first.';
  else intro = isOwner && first ? 'No owner account exists yet. Create it now.' : 'Welcome back.';
  const showForm = !(!isOwner && first);
  const sw = canUp ? '<button class="linkbtn" id="au-switch" type="button">' + (up ? 'I already have an account' : (isOwner ? 'Create the owner account' : 'Create an account')) + '</button>' : '';
  root('<div class="authwrap"><div class="authcard"><button class="linkbtn back" id="au-back" type="button">‹ Choose a different portal</button>' + brandBlock(name) +
    '<h1>' + (up ? (isOwner ? 'Create the owner account' : 'Create your account') : (isOwner ? 'Owner sign in' : 'Employee sign in')) + '</h1><p>' + intro + '</p>' +
    (note ? '<div class="' + (kind === 'ok' ? 'authok' : 'autherr') + '" id="authnote" role="alert">' + esc(note) + '</div>' : '') +
    (showForm ? '<form id="authform" class="form">' + (up ? '<label>Your name<input id="au-name" type="text" autocomplete="name" required maxlength="60"></label>' : '') +
    '<label>Email<input id="au-email" type="email" autocomplete="email" required></label>' +
    '<label>Password<input id="au-pass" type="password" autocomplete="' + (up ? 'new-password' : 'current-password') + '" required minlength="6"></label>' +
    '<button class="btn primary" type="submit" style="justify-content:center">' + (up ? 'Create account' : 'Sign in') + '</button></form>' : '') +
    (showForm ? '<div class="authlinks">' + sw + (up ? '' : '<button class="linkbtn" id="au-forgot" type="button">Forgot password?</button>') + '</div>' : '') + '</div></div>');
  $('au-back').addEventListener('click', function () { screenPortal(); });
  if ($('au-switch')) $('au-switch').addEventListener('click', function () { screenAuth(portal, up ? 'in' : 'up'); });
  if ($('au-forgot')) $('au-forgot').addEventListener('click', async function () {
    const em = $('au-email').value.trim();
    if (!em) { screenAuth(portal, 'in', 'Type your email first, then tap Forgot password.'); return; }
    try { await SB.auth.resetPassword(em); screenAuth(portal, 'in', 'If that email has an account, a reset link is on its way.', 'ok'); } catch (e) { screenAuth(portal, 'in', errText(e)); }
  });
  if (!showForm) return;
  $('authform').addEventListener('submit', async function (e) {
    e.preventDefault();
    const btn = e.target.querySelector('button[type=submit]'); btn.disabled = true; btn.textContent = 'One moment…';
    const email = $('au-email').value.trim(), pass = $('au-pass').value;
    try {
      if (up) {
        const r = await SB.auth.signUp(email, pass, $('au-name').value.trim(), portal);
        if (!r.signedIn) { screenAuth(portal, 'in', 'Almost there. Check your email for a confirmation link, then sign in.', 'ok'); return; }
      } else await SB.auth.signIn(email, pass);
      await enter(portal);
    } catch (err) {
      let m = errText(err);
      if (/database error saving new user/i.test(m)) m = isOwner ? 'This cafe already has an owner. Please use the Employee portal.' : 'Could not create the account. Check that the owner has set the cafe up.';
      screenAuth(portal, mode, m);
    }
  });
}
function screenWaiting() {
  const email = (SB.auth.user() && SB.auth.user().email) || '';
  root('<div class="authwrap"><div class="authcard">' + brandBlock() + '<h1>Almost there</h1><p>You are signed in as <b>' + esc(email) + '</b>, but that email is not on the team yet. Ask your manager to add it under Team, then check again.</p>' +
    '<div class="actions"><button class="btn primary" id="w-again">Check again</button><button class="btn" id="w-out">Sign out</button></div></div></div>');
  $('w-again').addEventListener('click', function () { enter(); });
  $('w-out').addEventListener('click', signOutNow);
}
function screenProblem(title, text, retry) {
  root('<div class="authwrap"><div class="authcard">' + brandBlock() + '<h1>' + esc(title) + '</h1><p>' + text + '</p><div class="actions">' + (retry ? '<button class="btn primary" id="p-retry">Try again</button>' : '') + '<button class="btn" id="p-out">Sign out</button></div></div></div>');
  if (retry) $('p-retry').addEventListener('click', function () { location.reload(); });
  $('p-out').addEventListener('click', signOutNow);
}
function screenOnboard() {
  const tz = (function () { try { return Intl.DateTimeFormat().resolvedOptions().timeZone || 'Australia/Sydney'; } catch (e) { return 'Australia/Sydney'; } })();
  root('<div class="authwrap"><div class="authcard wide">' + brandBlock('Set up your cafe') +
    '<h1>Welcome, ' + esc(firstName()) + '</h1><p>How would you like to start?</p><div class="choices">' +
    '<div class="choice"><h2>Try the sample cafe</h2><p>Little Wren Coffee: ten staff, eight weeks of sales, leave requests waiting for you, and this week\'s roster already uploaded. Staff sign up with the sample emails (for example <code>maya@littlewren.example</code>).</p><button class="btn primary" id="ob-sample">Load sample data</button></div>' +
    '<div class="choice"><h2>Start with my own cafe</h2><p>Enter a few details, then add your team and import your POS sales.</p>' +
    '<div class="form" style="width:100%"><label>Cafe name<input id="ob-name" type="text" maxlength="60" placeholder="My Cafe"></label><label>Time zone<input id="ob-tz" type="text" value="' + esc(tz) + '"></label><button class="btn" id="ob-own">Continue</button></div></div></div>' +
    '<div class="actions"><button class="linkbtn" id="ob-out">Sign out</button></div></div></div>');
  $('ob-out').addEventListener('click', signOutNow);
  $('ob-sample').addEventListener('click', async function (e) {
    const b = e.target; b.disabled = true; b.textContent = 'Setting up…';
    try { await SB.rpc('seed_demo', { p_reset: false }); await mountOwner(); await bootstrapSample(); state.week = WEEKS[1]; state.view = 'home'; render(); toast('Sample cafe loaded.'); }
    catch (err) { toast(errText(err), 'bad'); b.disabled = false; b.textContent = 'Load sample data'; }
  });
  $('ob-own').addEventListener('click', async function (e) {
    const tzv = $('ob-tz').value.trim() || 'Australia/Sydney';
    try { new Intl.DateTimeFormat('en-AU', { timeZone: tzv }); } catch (err) { toast('That time zone is not recognised. Try something like Australia/Sydney.', 'bad'); return; }
    e.target.disabled = true;
    try { await SB.update('settings', { id: 'eq.1' }, { cafe_name: $('ob-name').value.trim() || 'My Cafe', timezone: tzv, seeded: true }); await mountOwner(); state.view = 'team'; render(); toast('Now add your team.'); }
    catch (err) { toast(errText(err), 'bad'); e.target.disabled = false; }
  });
}

/* ---------- entering the app ---------- */
async function enter(portal) {
  root('<div class="loading">Loading…</div>');
  try {
    const uid = SB.auth.user() && SB.auth.user().id;
    const rows = await SB.select('profiles', { id: 'eq.' + uid });
    if (!rows.length) { screenProblem('Account not ready', 'Your account exists but has no profile yet. This usually means the database setup (schema.sql) has not been run on this Supabase project.', true); return; }
    APP.profile = rows[0]; APP.role = rows[0].role;
    if (portal && portal !== APP.role) {
      await SB.auth.signOut();
      screenPortal(APP.role === 'owner' ? 'That account belongs to the cafe owner. Please use the Owner portal.' : 'That is an employee account. Please use the Employee portal.');
      return;
    }
    if (APP.role === 'owner') {
      await loadScript('js/owner.js');
      const q = await loadOwnerData(); applyOwnerData(q);
      if (!STAFF.length && !APP.settings.seeded) { screenOnboard(); return; }
      await mountOwner(q);
    } else {
      if (!APP.profile.staff_id) { screenWaiting(); return; }
      await loadScript('js/employee.js');
      const q = await loadEmployeeData(); applyEmployeeData(q); E.sig = sigOfE(q);
      mountEmployee();
    }
  } catch (e) { bootFailed(e); }
}
function bootFailed(e) {
  if (e && e.status === 401) { SB.auth.signOut().then(function () { screenPortal('Please sign in again.'); }); return; }
  const m = String((e && e.message) || e);
  if (/schema cache|does not exist|PGRST20|42P01/i.test(m) || (e && (e.status === 404))) {
    screenProblem('Database not set up yet', 'Brewroster could not find its tables. In Supabase, open <b>SQL editor</b>, paste the contents of <code>supabase/schema.sql</code> and run it. Then try again.<br><br><span class="small">' + esc(m) + '</span>', true); return;
  }
  screenProblem('Something went wrong', esc(m), true);
}

async function mountOwner(q) {
  if (!q) { q = await loadOwnerData(); applyOwnerData(q); }
  state.sig = sigOf(q); state.week = state.week && WEEKS.indexOf(state.week) >= 0 ? state.week : WEEKS[1];
  const initials = String(APP.profile.display_name || 'O').split(/\s+/).map(function (w) { return w[0]; }).join('').slice(0, 2).toUpperCase();
  root('<div class="app"><aside class="side"><div class="brand"><span class="logo">B</span><div><b>Brewroster</b><small id="cafename"></small></div><span class="rolepill">Owner</span></div><nav class="nav" id="nav" aria-label="Main"></nav>' +
    '<div class="side-foot"><div class="owner"><span class="avatar">' + esc(initials) + '</span><div>' + esc(APP.profile.display_name || '') + '<small>Owner</small></div></div><button class="btn sm" data-act="signOut">Sign out</button></div></aside>' +
    '<main class="main"><div class="page" id="view"></div></main></div>');
  setCafeName(); render();
  startPolling(pollOwner);
  refreshLiveWeather().then(function (ok) { if (ok) return afterChange(); }).catch(function () { /* weather is optional */ });
}
function setCafeName() { const e = $('cafename'); if (e) e.textContent = (APP.settings && APP.settings.cafe_name) || ''; }
function mountEmployee() {
  E.tab = 'shifts'; E.weekIdx = 0;
  root('<div class="eapp"><aside class="eside"><div class="etop"><div class="ebrand"><span class="logo">B</span><div><b id="cafename"></b><small id="who"></small></div></div>' +
    '<div class="efoot"><span class="rolepill">Employee</span><button class="etop-out" data-act="signOut">Sign out</button></div></div>' +
    '<nav class="tabbar" id="tabbar" aria-label="Main"></nav></aside><main class="emain"><div id="view"></div></main></div>');
  $('cafename').textContent = (APP.settings && APP.settings.cafe_name) || 'Brewroster';
  $('who').textContent = E.me ? E.me.name : '';
  render();
  startPolling(pollEmployee);
}

/* ---------- keeping the screen fresh ---------- */
function startPolling(fn) {
  stopPolling();
  pollTimer = setInterval(function () { if (!document.hidden) fn(); }, 20000);
  document.addEventListener('visibilitychange', function () { if (!document.hidden && pollTimer) fn(); });
}
function stopPolling() { if (pollTimer) clearInterval(pollTimer); pollTimer = null; }
async function pollOwner() {
  if (APP.busy || modalOpen() || editingField() || state.busy) return;
  try {
    const q = await loadOwnerData({ pos: false }), sig = sigOf(q);
    if (APP.busy || modalOpen() || editingField()) return;
    if (sig !== state.sig) { applyOwnerData(q); state.sig = sig; render(); }
  } catch (e) { if (e && e.status === 401) signedOut(); }
}
async function pollEmployee() {
  if (APP.busy || modalOpen() || editingField()) return;
  try {
    const q = await loadEmployeeData(), sig = sigOfE(q);
    if (APP.busy || modalOpen() || editingField()) return;
    if (sig !== E.sig) { applyEmployeeData(q); E.sig = sig; render(); }
  } catch (e) { if (e && e.status === 401) signedOut(); }
}

/* ---------- signing out ---------- */
async function signOutNow() { stopPolling(); await SB.auth.signOut(); location.reload(); }
function signedOut() { stopPolling(); SB.auth.signOut().then(function () { location.reload(); }); }

/* ---------- one click handler for every [data-act] ---------- */
document.addEventListener('click', function (e) {
  const t = e.target.closest('[data-act]');
  if (!t || typeof ACT === 'undefined' || !ACT[t.dataset.act]) return;
  if (APP.busy) return;                       // a save is in flight: ignore stray clicks
  let r;
  try { r = ACT[t.dataset.act](t, e); } catch (err) { toast(errText(err), 'bad'); return; }
  if (r && typeof r.then === 'function') {
    APP.busy = true; t.classList.add('is-busy');
    r.catch(function (err) {
      if (err && err.status === 401) { toast('Your session has ended. Please sign in again.', 'bad'); signedOut(); return; }
      toast(errText(err), 'bad');
    }).then(function () { APP.busy = false; t.classList.remove('is-busy'); });
  }
});

/* ---------- start ---------- */
(async function boot() {
  try {
    const cfg = await readConfig();
    if (!cfg.url || !cfg.key) { screenSetup(); return; }
    SB.configure(cfg.url, cfg.key);
    if (SB.auth.restore() && SB.auth.user()) { await enter(); return; }
    screenPortal();
  } catch (e) { bootFailed(e); }
})();
