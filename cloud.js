/* Lucky Bienie - lapisan cloud: login Supabase + sinkron data antar perangkat.
   Aplikasi tetap bekerja dari penyimpanan lokal (offline-first). Setiap perubahan dibandingkan
   dengan keadaan terakhir yang diketahui server, lalu hanya selisihnya yang dikirim. */
(function () {
  "use strict";
  var EMAIL_DOMAIN = "luckybienie.app";
  var LSK = "lb_cloud_v2", LSME = "lb_me_v2", LSCFG = "lb_cfg_v2", SKEY = "lb_pos_v1";
  var COLS = ["products", "sales", "held", "shifts", "sup", "cus", "buys", "exps", "pays", "mv", "rets", "audit", "promos", "jm", "lp"];
  var COUNTERS = { products: ["stock"], promos: ["used"], _n: ["v", "pn"] };   // nilai yang dikirim sebagai selisih
  var SINGLE = { _cfg: 1, _shift: 1, _n: 1 };
  var BATCH = 150;

  var sb = null, started = false, me = null, base = {}, last = null, inflight = null, dev = "";
  var pushing = false, pushTimer = null, pullTimer = null, retryMs = 0, chan = null, tick = null, pendingRefresh = false, refTimer = null;
  var st = { online: true, ok: true, pending: 0, busy: false, err: "" };

  /* ---------- util ---------- */
  var gid = function () { return Math.random().toString(36).slice(2, 10) + Date.now().toString(36); };
  var canon = function (o) {
    if (o === null || typeof o !== "object") return JSON.stringify(o === undefined ? null : o);
    if (Array.isArray(o)) return "[" + o.map(canon).join(",") + "]";
    return "{" + Object.keys(o).sort().filter(function (k) { return o[k] !== undefined; })
      .map(function (k) { return JSON.stringify(k) + ":" + canon(o[k]); }).join(",") + "}";
  };
  var hash = function (s) {   // cyrb53
    var a = 0xdeadbeef, b = 0x41c6ce57, i, c;
    for (i = 0; i < s.length; i++) { c = s.charCodeAt(i); a = Math.imul(a ^ c, 2654435761); b = Math.imul(b ^ c, 1597334677); }
    a = Math.imul(a ^ (a >>> 16), 2246822507) ^ Math.imul(b ^ (b >>> 13), 3266489909);
    b = Math.imul(b ^ (b >>> 16), 2246822507) ^ Math.imul(a ^ (a >>> 13), 3266489909);
    return (4294967296 * (2097151 & b) + (a >>> 0)).toString(36);
  };
  var strip = function (c, o) {
    var k = COUNTERS[c]; if (!k) return o;
    var x = {}; Object.keys(o).forEach(function (f) { if (k.indexOf(f) < 0) x[f] = o[f]; }); return x;
  };
  var counts = function (c, o) { var r = {}; (COUNTERS[c] || []).forEach(function (k) { r[k] = Number(o[k]) || 0; }); return r; };
  var sameCn = function (a, b) { return Object.keys(a).every(function (k) { return (a[k] || 0) === ((b || {})[k] || 0); }); };
  var lsGet = function (k) { try { return JSON.parse(localStorage.getItem(k)); } catch (e) { return null; } };
  var lsSet = function (k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) {} };
  var withTimeout = function (p, ms) {
    return new Promise(function (res, rej) {
      var t = setTimeout(function () { rej(new Error("timeout")); }, ms);
      p.then(function (v) { clearTimeout(t); res(v); }, function (e) { clearTimeout(t); rej(e); });
    });
  };
  var isNet = function (e) { return !e || !e.code; };   // galat jaringan tidak punya kode Postgres

  /* ---------- konfigurasi ---------- */
  function config() {
    var c = lsGet(LSCFG);
    if (!(c && c.url && c.key)) c = window.LB_CONFIG || {};
    return c.url && c.key ? { url: String(c.url).replace(/\/+$/, ""), key: String(c.key).trim() } : null;
  }
  function client() {
    if (sb) return sb;
    var c = config(); if (!c || !window.supabase) return null;
    sb = window.supabase.createClient(c.url, c.key, { auth: { persistSession: true, autoRefreshToken: true, storageKey: "lb-auth" } });
    return sb;
  }
  function setupV() {
    var m = document.getElementById("main"); document.getElementById("nav").style.display = "none";
    m.innerHTML = '<div style="min-height:100%;display:grid;place-items:center"><div class="card" style="width:min(420px,100%);border-top:4px solid var(--g);border-right:4px solid var(--p)">' +
      '<h2>Hubungkan ke cloud</h2><div class="k">Isi sekali. Nilai ada di Supabase: Project Settings, API.</div>' +
      '<label>Project URL</label><input id="cu" placeholder="https://xxxx.supabase.co">' +
      '<label>Publishable / anon key</label><input id="ck" placeholder="sb_publishable_... atau eyJ...">' +
      '<div id="ce" style="color:var(--er);font-size:13px;min-height:18px;margin-top:6px"></div>' +
      '<button class="b" style="width:100%;margin-top:6px" onclick="CL.saveSetup()">Simpan dan lanjut</button></div></div>';
  }
  function saveSetup() {
    var u = document.getElementById("cu").value.trim(), k = document.getElementById("ck").value.trim();
    if (!/^https:\/\/.+/.test(u) || k.length < 20) { document.getElementById("ce").textContent = "URL harus diawali https:// dan key harus diisi"; return; }
    lsSet(LSCFG, { url: u, key: k }); location.reload();
  }

  /* ---------- cache sinkron ---------- */
  function persist() { lsSet(LSK, { base: base, last: last, dev: dev, inflight: inflight, url: (config() || {}).url }); }
  function loadCache() {
    var c = lsGet(LSK) || {};
    dev = c.dev || "";
    if (!dev) { dev = String.fromCharCode(65 + Math.floor(Math.random() * 26)) + Math.floor(Math.random() * 10); }
    if (c.url && c.url === (config() || {}).url) { base = c.base || {}; last = c.last || null; inflight = c.inflight || null; }
    else { base = {}; last = null; inflight = null; }
    persist();
  }
  function persistState() { try { localStorage.setItem(SKEY, JSON.stringify(S)); } catch (e) {} persist(); }

  /* ---------- catatan lokal ---------- */
  function ensureIds() { COLS.forEach(function (c) { (S[c] || []).forEach(function (o) { if (o && !o.id) o.id = gid(); }); }); }
  function recs() {
    var out = [];
    COLS.forEach(function (c) { (S[c] || []).forEach(function (o) { out.push({ c: c, id: o.id, o: o }); }); });
    out.push({ c: "_cfg", id: "cfg", o: S.cfg });
    out.push({ c: "_shift", id: "cur", o: { s: S.shift || null } });
    out.push({ c: "_n", id: "n", o: { v: S.n || 0, pn: S.pn || 0 } });
    return out;
  }
  function canWrite(c) {
    var r = me && me.role;
    if (!r || r === "auditor") return false;
    if (r === "akuntan") return c === "jm" || c === "audit";
    if (c === "_cfg") return r === "owner";
    return true;
  }

  /* ---------- kirim perubahan ---------- */
  function build() {
    ensureIds();
    var items = [], meta = [], seen = {}, i, all = recs(), full = true;
    for (i = 0; i < all.length; i++) {
      var r = all[i], key = r.c + "|" + r.id; seen[key] = 1;
      if (!canWrite(r.c)) continue;
      var h = hash(canon(strip(r.c, r.o))), cn = counts(r.c, r.o), b = base[r.c] && base[r.c][r.id];
      if (!b) { items.push({ c: r.c, id: r.id, data: r.o }); meta.push({ c: r.c, id: r.id, h: h, cn: cn, nw: true }); }
      else {
        var d = {}, has = false;
        (COUNTERS[r.c] || []).forEach(function (k) { var dv = (cn[k] || 0) - ((b.cn || {})[k] || 0); if (dv) { d[k] = dv; has = true; } });
        if (b.h !== h || has) {
          var it = { c: r.c, id: r.id };
          if (b.h !== h) it.data = r.o; else it.po = true;
          if (has) it.d = d;
          items.push(it); meta.push({ c: r.c, id: r.id, h: h, cn: cn, d: d });
        }
      }
      if (items.length >= BATCH) { full = false; break; }
    }
    if (full) {
      COLS.forEach(function (c) {
        if (c === "audit" || !base[c]) return;
        Object.keys(base[c]).forEach(function (id) {
          if (items.length < BATCH && !seen[c + "|" + id] && canWrite(c)) { items.push({ c: c, id: id, del: true, data: {} }); meta.push({ c: c, id: id, del: true }); }
        });
      });
    }
    return items.length ? { bid: gid() + gid(), items: items, meta: meta } : null;
  }
  function commit(job) {
    job.meta.forEach(function (m) {
      if (m.del) { if (base[m.c]) delete base[m.c][m.id]; }
      else {
        var bb = base[m.c] && base[m.c][m.id];
        if (!bb || m.nw) (base[m.c] || (base[m.c] = {}))[m.id] = { h: m.h, cn: m.cn };
        else { bb.h = m.h; bb.cn = bb.cn || {}; Object.keys(m.d || {}).forEach(function (k) { bb.cn[k] = (bb.cn[k] || 0) + m.d[k]; }); }   // nilai server yang diketahui + yang sudah terkirim
      }
    });
    inflight = null; persist();
  }
  async function rpcPush(job) {
    var ctrl = typeof AbortController !== "undefined" ? new AbortController() : null;
    var t = setTimeout(function () { if (ctrl) ctrl.abort(); }, 25000);
    try {
      var q = sb.rpc("lb_push", { p_bid: job.bid, p_items: job.items });
      if (ctrl && q.abortSignal) q = q.abortSignal(ctrl.signal);
      var res = await q; return res.error || null;
    } catch (e) { return { message: String(e && e.message || e), code: "" }; }
    finally { clearTimeout(t); }
  }
  async function push() {
    if (!sb || !me || pushing) return;
    pushing = true; st.busy = true; badge();
    try {
      for (var guard = 0; guard < 400; guard++) {
        var job = inflight || (function () { var j = build(); if (j) { inflight = j; persist(); } return j; })();
        if (!job) { st.pending = 0; break; }
        st.pending = job.items.length;
        var err = await rpcPush(job);
        if (!err) { commit(job); st.ok = true; st.err = ""; retryMs = 0; continue; }
        if (isNet(err)) { st.ok = false; st.err = "offline"; throw err; }
        // ditolak server: jangan ulang terus, selaraskan dengan data server
        st.err = err.message || "ditolak";
        var sent = job; inflight = null;
        sent.meta.forEach(function (m) { if (m.del) { if (base[m.c]) delete base[m.c][m.id]; } else { (base[m.c] || (base[m.c] = {}))[m.id] = { h: m.h, cn: m.cn }; } });
        persist();
        try { toast("Gagal sinkron: " + st.err); } catch (e) {}
        await forceRows(sent.meta.filter(function (m) { return !m.del; }));
      }
    } catch (e) {
      retryMs = Math.min(60000, (retryMs || 4000) * 2);
      setTimeout(push, retryMs);
    } finally { pushing = false; st.busy = false; badge(); }
  }
  function dirty() {
    if (!me || !sb) return;
    clearTimeout(pushTimer); pushTimer = setTimeout(push, 500);
  }

  /* ---------- terima perubahan ---------- */
  function applyRemote(r, force) {
    var c = r.collection, id = r.id, D = r.data || {}, b;
    if (SINGLE[c]) return applySingle(c, D, force);
    if (COLS.indexOf(c) < 0) return false;
    if (!S[c]) S[c] = [];
    var arr = S[c], i = -1, k;
    for (k = 0; k < arr.length; k++) { if (arr[k].id === id) { i = k; break; } }
    var L = i >= 0 ? arr[i] : null;
    b = base[c] && base[c][id];
    if (r.deleted) { if (L) arr.splice(i, 1); if (b) delete base[c][id]; return !!L; }
    var cn = counts(c, D), rh = hash(canon(strip(c, D))), cs = COUNTERS[c] || [];
    if (L) {
      if (!force && b && b.h === rh && sameCn(b.cn, cn)) return false;       // gema dari kiriman sendiri
      var ld = !!b && hash(canon(strip(c, L))) !== b.h;                          // ada ubahan lokal yang belum terkirim
      if (!force && ld) {
        cs.forEach(function (f) { L[f] = (cn[f] || 0) + ((Number(L[f]) || 0) - ((b.cn || {})[f] || 0)); });
        b.cn = cn; return true;
      }
      var un = {};
      cs.forEach(function (f) { un[f] = force ? 0 : (Number(L[f]) || 0) - ((b && b.cn && b.cn[f]) || 0); });
      Object.keys(L).forEach(function (f) { delete L[f]; });
      Object.keys(D).forEach(function (f) { L[f] = D[f]; });
      cs.forEach(function (f) { L[f] = (cn[f] || 0) + (un[f] || 0); });
      (base[c] || (base[c] = {}))[id] = { h: hash(canon(strip(c, L))), cn: cn };
      return true;
    }
    if (b && !force) return false;                                               // dihapus lokal, penghapusan menunggu dikirim
    var nu = {}; Object.keys(D).forEach(function (f) { nu[f] = D[f]; });
    arr.push(nu);
    (base[c] || (base[c] = {}))[id] = { h: hash(canon(strip(c, nu))), cn: cn };
    return true;
  }
  function applySingle(c, D, force) {
    var id = c === "_cfg" ? "cfg" : c === "_shift" ? "cur" : "n";
    var b = base[c] && base[c][id], cur, rh, ld;
    if (c === "_cfg") {
      cur = S.cfg || {}; rh = hash(canon(D)); ld = !!b && hash(canon(cur)) !== b.h;
      if (!force && b && b.h === rh) return false;
      if (!force && ld) return false;
      S.cfg = {}; Object.keys(D).forEach(function (f) { S.cfg[f] = D[f]; }); S.cfg.ptsPer = S.cfg.ptsPer || 10000;
      (base[c] || (base[c] = {}))[id] = { h: hash(canon(S.cfg)), cn: {} };
      return true;
    }
    if (c === "_shift") {
      cur = { s: S.shift || null }; rh = hash(canon({ s: D.s || null })); ld = !!b && hash(canon(cur)) !== b.h;
      if (!force && b && b.h === rh) return false;
      if (!force && ld) return false;
      S.shift = D.s || null;
      (base[c] || (base[c] = {}))[id] = { h: hash(canon({ s: S.shift })), cn: {} };
      return true;
    }
    var cn = { v: Number(D.v) || 0, pn: Number(D.pn) || 0 };
    if (!force && b && sameCn(b.cn || {}, cn)) return false;
    var uv = force ? 0 : (S.n || 0) - ((b && b.cn && b.cn.v) || 0), up = force ? 0 : (S.pn || 0) - ((b && b.cn && b.cn.pn) || 0);
    S.n = cn.v + uv; S.pn = cn.pn + up;
    (base[c] || (base[c] = {}))[id] = { h: hash(canon({})), cn: cn };
    return true;
  }
  function sortArrays() {
    COLS.forEach(function (c) {
      var a = S[c]; if (!a || a.length < 2 || typeof a[0].ts !== "number") return;
      a.sort(function (x, y) { return (x.ts || 0) - (y.ts || 0); });
    });
  }
  function finish(changed) {
    if (!changed) return;
    sortArrays(); persistState(); refresh();
  }
  async function fetchAll(filter) {
    var rows = [], from = 0, q;
    for (;;) {
      q = sb.from("lb_records").select("collection,id,data,deleted,updated_at").order("updated_at").order("collection").order("id").range(from, from + 999);
      if (filter) q = filter(q);
      var res = await q; if (res.error) throw res.error;
      rows = rows.concat(res.data || []);
      if (!res.data || res.data.length < 1000) break;
      from += 1000;
    }
    return rows;
  }
  function maxTs(rows) { var m = last; rows.forEach(function (r) { if (!m || r.updated_at > m) m = r.updated_at; }); return m; }
  async function fullPull() {
    var rows = await fetchAll();
    COLS.forEach(function (c) { S[c] = []; });
    base = {};
    rows.forEach(function (r) { if (!r.deleted) applyRemote(r, true); });
    last = maxTs(rows);
    if (!rows.length && me && me.role === "owner" && typeof seed === "function") {   // proyek baru: mulai dengan produk contoh
      var d = seed(); S.products = d.products; S.cfg = d.cfg; S.cfg.ptsPer = S.cfg.ptsPer || 10000; S.n = 0;
    }
    sortArrays(); persistState();
  }
  async function incPull() {
    var since = new Date(new Date(last).getTime() - 3000).toISOString();
    var rows = await fetchAll(function (q) { return q.gte("updated_at", since); });
    var ch = false; rows.forEach(function (r) { if (applyRemote(r, false)) ch = true; });
    last = maxTs(rows); persist(); finish(ch);
  }
  async function pull() {
    if (!sb || !me) return;
    try {
      if (!last) { await fullPull(); refresh(); } else await incPull();
      st.ok = true; badge();
    } catch (e) { st.ok = false; badge(); throw e; }
  }
  async function forceRows(metas) {
    try {
      var by = {}; metas.forEach(function (m) { (by[m.c] || (by[m.c] = [])).push(m.id); });
      var ch = false;
      for (var c in by) {
        var res = await sb.from("lb_records").select("collection,id,data,deleted").eq("collection", c).in("id", by[c]);
        var got = {}; (res.data || []).forEach(function (r) { got[r.id] = 1; if (applyRemote(r, true)) ch = true; });
        by[c].forEach(function (id) {
          if (!got[id] && S[c]) { var n = S[c].length; S[c] = S[c].filter(function (o) { return o.id !== id; }); if (S[c].length !== n) ch = true; if (base[c]) delete base[c][id]; }
        });
      }
      finish(ch);
    } catch (e) {}
  }
  /* Ambil penghitung terbaru sebelum membuat nomor nota (menekan kemungkinan nomor kembar antar HP) */
  async function syncN() {
    if (!sb || !me || !navigator.onLine) return;
    try {
      await withTimeout((async function () {
        await push();
        var res = await sb.from("lb_records").select("collection,id,data,deleted").eq("collection", "_n").eq("id", "n").maybeSingle();
        if (res.data) applyRemote(res.data, false);
      })(), 2500);
    } catch (e) {}
  }
  var noSuffix = function () { return navigator.onLine && st.ok ? "" : "-" + dev; };

  /* ---------- refresh tampilan ---------- */
  function refresh() { clearTimeout(refTimer); refTimer = setTimeout(doRefresh, 200); }
  function uiBusy() {
    var md = document.getElementById("md"), a = document.activeElement;
    return (md && md.innerHTML.trim() !== "") || (a && /^(INPUT|TEXTAREA|SELECT)$/.test(a.tagName));
  }
  function doRefresh() {
    if (!me || typeof go !== "function") return;
    if (uiBusy()) { pendingRefresh = true; return; }
    pendingRefresh = false;
    try {
      cart = cart.filter(function (c) { return S.products.some(function (p) { return p.id === c.id; }); });
      if (view === "pos") { lp(); rc(); } else go(view);
      nav();
    } catch (e) {}
  }
  function afterClose() { if (pendingRefresh) setTimeout(doRefresh, 100); }
  document.addEventListener("focusout", function () { if (pendingRefresh) setTimeout(doRefresh, 400); });

  /* ---------- lencana status ---------- */
  function badge() {
    var el = document.getElementById("cbadge");
    if (!el) { el = document.createElement("div"); el.id = "cbadge"; el.style.cssText = "position:fixed;top:8px;right:10px;z-index:8;font-size:12px;padding:4px 10px;border-radius:99px;pointer-events:none;border:1px solid var(--bd);background:var(--bg);color:var(--t2)"; document.body.appendChild(el); }
    if (!me) { el.style.display = "none"; return; }
    el.style.display = "";
    var off = !navigator.onLine || !st.ok;
    el.textContent = off ? "Offline" + (st.pending ? " · " + st.pending + " menunggu kirim" : "") : st.busy && st.pending ? "Mengirim " + st.pending + "…" : "Tersinkron";
    el.style.color = off ? "var(--er)" : "var(--ok)";
  }

  /* ---------- sesi dan pengguna ---------- */
  async function fetchProfile(id) {
    var res = await sb.from("lb_profiles").select("*").eq("id", id).maybeSingle();
    if (res.error) throw res.error;
    return res.data ? { id: res.data.id, name: res.data.name, user: res.data.username, role: res.data.role, active: res.data.active ? 1 : 0, email: res.data.email } : null;
  }
  async function loadUsers() {
    var res = await sb.from("lb_profiles").select("*").order("created_at");
    if (res.error) return;
    S.users = (res.data || []).map(function (r) { return { id: r.id, name: r.name, user: r.username, role: r.role, active: r.active ? 1 : 0, email: r.email }; });
    persistState();
  }
  async function login(u, pw) {
    if (!client()) throw new Error("Cloud belum dikonfigurasi");
    var email = u.indexOf("@") >= 0 ? u : u + "@" + EMAIL_DOMAIN;
    var res = await sb.auth.signInWithPassword({ email: email, password: pw });
    if (res.error) {
      if (/invalid/i.test(res.error.message)) throw new Error("Username atau password salah");
      throw new Error(navigator.onLine ? res.error.message : "Tidak ada koneksi internet");
    }
    var p = await fetchProfile(res.data.user.id);
    if (!p || !p.active) { await sb.auth.signOut(); throw new Error("Akun belum terdaftar atau dinonaktifkan"); }
    me = p; lsSet(LSME, p); await loadUsers();
    return p;
  }
  async function resume() {
    if (!client()) return null;
    var res = await sb.auth.getSession();
    if (!res.data || !res.data.session) { lsSet(LSME, null); return null; }
    var cached = lsGet(LSME);
    try {
      var p = await withTimeout(fetchProfile(res.data.session.user.id), cached ? 3000 : 15000);
      if (!p || !p.active) { await logout(true); return null; }
      me = p; lsSet(LSME, p); loadUsers();
      return p;
    } catch (e) {
      if (cached && cached.id === res.data.session.user.id) { me = cached; return cached; }   // offline: pakai profil tersimpan
      return null;
    }
  }
  async function logout(skipPush) {
    if (!skipPush) { try { await withTimeout(push(), 3000); } catch (e) {} }
    stop(); me = null; lsSet(LSME, null);
    try { await sb.auth.signOut(); } catch (e) {}
    badge();
  }
  async function changePw(oldp, newp) {
    var s = await sb.auth.getSession(); var mail = s.data.session && s.data.session.user.email;
    var chk = await sb.auth.signInWithPassword({ email: mail, password: oldp });
    if (chk.error) throw new Error("Password lama salah");
    var up = await sb.auth.updateUser({ password: newp });
    if (up.error) throw new Error(up.error.message);
  }
  async function api(method, body) {
    var s = await sb.auth.getSession(); var tok = s.data.session && s.data.session.access_token;
    if (!tok) throw new Error("Sesi berakhir, silakan masuk lagi");
    var r = await fetch("/api/users", { method: method, headers: { "Content-Type": "application/json", Authorization: "Bearer " + tok }, body: JSON.stringify(body) });
    var j = {}; try { j = await r.json(); } catch (e) {}
    if (!r.ok) throw new Error(j.error || "Gagal (" + r.status + "). Pastikan aplikasi dibuka dari alamat Vercel.");
    return j;
  }

  /* ---------- siklus hidup ---------- */
  async function start() {
    if (started || !sb || !me) return;
    started = true; loadCache(); st.pending = 0;
    if (navigator.onLine) {
      try { await withTimeout(pull(), last ? 5000 : 30000); } catch (e) { st.ok = false; }
    } else st.ok = false;
    subscribe();
    tick = setInterval(function () { if (navigator.onLine) { pull().catch(function () {}); } push(); }, 25000);
    window.addEventListener("online", onOnline);
    document.addEventListener("visibilitychange", onVis);
    push(); badge();
  }
  function onOnline() { st.ok = true; pull().catch(function () {}); push(); badge(); }
  function onVis() { if (!document.hidden && navigator.onLine) { pull().catch(function () {}); push(); } }
  function subscribe() {
    try {
      chan = sb.channel("lb-records").on("postgres_changes", { event: "*", schema: "public", table: "lb_records" }, function (p) {
        var r = p.new; if (!r || !r.collection) return;
        try { finish(applyRemote(r, false)); } catch (e) {}
      }).subscribe(function (s) { if (s === "SUBSCRIBED" && last) pull().catch(function () {}); });
    } catch (e) {}
  }
  function stop() {
    started = false; clearInterval(tick); clearTimeout(pushTimer);
    window.removeEventListener("online", onOnline); document.removeEventListener("visibilitychange", onVis);
    try { if (chan) sb.removeChannel(chan); } catch (e) {}
    chan = null;
  }
  window.addEventListener("offline", function () { st.ok = false; badge(); });

  /* ---------- restore dan reset ---------- */
  async function restore(d) {
    if (me.role !== "owner") throw new Error("Hanya owner");
    await push(); await pull();
    COLS.forEach(function (c) { S[c] = Array.isArray(d[c]) ? d[c] : []; });
    S.cfg = d.cfg; S.cfg.ptsPer = S.cfg.ptsPer || 10000; S.shift = d.shift || null; S.n = d.n || 0; S.pn = d.pn || 0;
    ensureIds(); persistState(); await push();
    if (inflight || st.err === "offline") throw new Error("Data tersimpan di perangkat, akan dikirim saat online");
  }
  function resetLocal() {
    try { localStorage.removeItem(LSK); localStorage.removeItem(SKEY); localStorage.removeItem(SKEY + "_cart"); } catch (e) {}
    location.reload();
  }

  window.CL = {
    configured: function () { return !!config() && !!window.supabase; },
    setupV: setupV, saveSetup: saveSetup, resume: resume, login: login, logout: logout, changePw: changePw,
    api: api, loadUsers: loadUsers, start: start, dirty: dirty, push: push, pull: pull, syncN: syncN, noSuffix: noSuffix,
    afterClose: afterClose, restore: restore, resetLocal: resetLocal, badge: badge,
    _t: { applyRemote: applyRemote, build: build, state: function () { return { base: base, last: last, inflight: inflight }; }, hash: hash, canon: canon }
  };
  document.addEventListener("DOMContentLoaded", function () { var c = client(); if (c) c.auth.onAuthStateChange(function (ev) { if (ev === "SIGNED_OUT" && me) { me = null; try { location.reload(); } catch (e) {} } }); });
})();
