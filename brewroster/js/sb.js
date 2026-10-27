/* ============================================================
   A tiny Supabase client: talks straight to the Supabase Auth
   (/auth/v1) and Data API (/rest/v1) over fetch. No SDK, no CDN,
   no build step. Same endpoints supabase-js uses.
   ============================================================ */
const SB = (function () {
  const KEY = 'brewroster.session';
  let cfg = { url: '', key: '' };
  let session = null;          // { access_token, refresh_token, expires_at, user }
  let refreshing = null;
  const listeners = [];

  function configure(url, key) { cfg = { url: String(url || '').replace(/\/+$/, ''), key: String(key || '') }; }
  function ready() { return !!(cfg.url && cfg.key); }
  function store() { try { if (session) localStorage.setItem(KEY, JSON.stringify(session)); else localStorage.removeItem(KEY); } catch (e) { /* private mode */ } }
  function restore() {
    try { const raw = localStorage.getItem(KEY); session = raw ? JSON.parse(raw) : null; } catch (e) { session = null; }
    return session;
  }
  function setSession(s) {
    if (s && s.access_token) {
      session = { access_token: s.access_token, refresh_token: s.refresh_token, user: s.user || (session && session.user) || null,
        expires_at: s.expires_at || (Math.floor(Date.now() / 1000) + (s.expires_in || 3600)) };
    } else session = null;
    store(); listeners.forEach(function (f) { try { f(session); } catch (e) { /* ignore */ } });
  }
  function onChange(f) { listeners.push(f); }

  function fail(res, body) {
    const msg = (body && (body.message || body.msg || body.error_description || body.error)) || ('Request failed (' + res.status + ')');
    const e = new Error(msg); e.status = res.status; e.code = body && (body.code || body.error_code); e.details = body && body.details; return e;
  }
  async function raw(path, opt) {
    opt = opt || {};
    const headers = Object.assign({ apikey: cfg.key, 'Content-Type': 'application/json' }, opt.headers || {});
    if (opt.auth !== false) headers.Authorization = 'Bearer ' + (session ? session.access_token : cfg.key);
    else headers.Authorization = 'Bearer ' + cfg.key;
    let res;
    try {
      res = await fetch(cfg.url + path, { method: opt.method || 'GET', headers: headers, body: opt.body === undefined ? undefined : JSON.stringify(opt.body) });
    } catch (e) { const err = new Error('Could not reach Supabase. Check your internet connection and the project URL.'); err.network = true; throw err; }
    let body = null; const text = await res.text();
    if (text) { try { body = JSON.parse(text); } catch (e) { body = text; } }
    return { res: res, body: body };
  }
  async function refresh() {
    if (!session || !session.refresh_token) return false;
    if (refreshing) return refreshing;
    refreshing = (async function () {
      const r = await raw('/auth/v1/token?grant_type=refresh_token', { method: 'POST', auth: false, body: { refresh_token: session.refresh_token } });
      if (!r.res.ok) { setSession(null); return false; }
      setSession(r.body); return true;
    })();
    try { return await refreshing; } finally { refreshing = null; }
  }
  async function call(path, opt) {
    const hadSession = !!session;
    const ended = function () { const e = new Error('Your session has ended. Please sign in again.'); e.status = 401; return e; };
    if (session && session.expires_at && session.expires_at - 30 < Date.now() / 1000) {
      if (!(await refresh())) throw ended();
    }
    let r = await raw(path, opt);
    if (r.res.status === 401 && session && r.body && /jwt|expired/i.test(String(r.body.message || ''))) {
      if (await refresh()) r = await raw(path, opt); else throw ended();
    }
    if (hadSession && !session) throw ended();
    if (!r.res.ok) throw fail(r.res, r.body);
    return r.body;
  }

  /* ---------- auth ---------- */
  const auth = {
    session: function () { return session; },
    user: function () { return session && session.user; },
    restore: restore,
    signUp: async function (email, password, name, portal) {
      const r = await raw('/auth/v1/signup', { method: 'POST', auth: false, body: { email: email, password: password, data: { name: name || '', portal: portal || '' } } });
      if (!r.res.ok) throw fail(r.res, r.body);
      if (r.body && r.body.access_token) { setSession(r.body); return { signedIn: true }; }
      return { signedIn: false, needsConfirm: true };
    },
    signIn: async function (email, password) {
      const r = await raw('/auth/v1/token?grant_type=password', { method: 'POST', auth: false, body: { email: email, password: password } });
      if (!r.res.ok) {
        const e = fail(r.res, r.body);
        if (/invalid login/i.test(e.message)) e.message = 'That email and password do not match.';
        if (/not confirmed/i.test(e.message)) e.message = 'Please confirm your email first. Check your inbox for the link.';
        throw e;
      }
      setSession(r.body); return true;
    },
    signOut: async function () {
      try { if (session) await raw('/auth/v1/logout', { method: 'POST' }); } catch (e) { /* ignore */ }
      setSession(null);
    },
    resetPassword: async function (email) {
      const r = await raw('/auth/v1/recover', { method: 'POST', auth: false, body: { email: email } });
      if (!r.res.ok) throw fail(r.res, r.body);
      return true;
    }
  };

  /* ---------- data API ---------- */
  function qs(params) {
    const p = [];
    Object.keys(params || {}).forEach(function (k) {
      const v = params[k];
      (Array.isArray(v) ? v : [v]).forEach(function (x) { if (x !== undefined && x !== null) p.push(encodeURIComponent(k) + '=' + encodeURIComponent(x)); });
    });
    return p.length ? '?' + p.join('&') : '';
  }
  // select('staff', { select: 'id,name', order: 'name.asc', day: ['gte.2026-01-01', 'lte.2026-02-01'] })
  async function select(table, params) {
    const rows = await call('/rest/v1/' + table + qs(Object.assign({ select: '*' }, params || {})), { headers: { Accept: 'application/json' } });
    return Array.isArray(rows) ? rows : [];
  }
  // insert rows; opts.upsert = 'col1,col2' makes it an upsert on those columns
  async function insert(table, rows, opts) {
    opts = opts || {};
    const prefer = ['return=' + (opts.minimal ? 'minimal' : 'representation')];
    let q = '';
    if (opts.upsert) { prefer.push('resolution=merge-duplicates'); q = '?on_conflict=' + encodeURIComponent(opts.upsert); }
    const out = await call('/rest/v1/' + table + q, { method: 'POST', headers: { Prefer: prefer.join(',') }, body: rows });
    return out;
  }
  async function update(table, filters, patch) {
    return call('/rest/v1/' + table + qs(filters), { method: 'PATCH', headers: { Prefer: 'return=representation' }, body: patch });
  }
  async function remove(table, filters) {
    return call('/rest/v1/' + table + qs(filters), { method: 'DELETE', headers: { Prefer: 'return=minimal' } });
  }
  async function rpc(fn, args) {
    return call('/rest/v1/rpc/' + fn, { method: 'POST', body: args || {} });
  }
  // eq('abc') -> 'eq.abc'
  function eq(v) { return 'eq.' + v; }

  return { configure: configure, ready: ready, auth: auth, select: select, insert: insert, update: update, remove: remove, rpc: rpc, eq: eq, onChange: onChange, url: function () { return cfg.url; } };
})();
