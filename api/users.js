// Vercel Serverless Function: kelola akun staf Lucky Bienie (khusus Owner).
// Memakai service role key yang HANYA ada di environment variable Vercel (tidak pernah dikirim ke browser).
const URL_ = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL;
const KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const DOMAIN = "luckybienie.app";
const ROLES = ["owner", "manajer", "kasir", "auditor", "akuntan"];

async function sb(path, opt = {}) {
  const r = await fetch(URL_ + path, {
    ...opt,
    headers: { apikey: KEY, Authorization: "Bearer " + KEY, "Content-Type": "application/json", ...(opt.headers || {}) },
  });
  const t = await r.text();
  let j = {};
  try { j = t ? JSON.parse(t) : {}; } catch { j = { raw: t }; }
  return { ok: r.ok, status: r.status, j };
}

async function caller(req) {
  const tok = String(req.headers.authorization || "").replace(/^Bearer\s+/i, "");
  if (!tok) return null;
  const u = await fetch(URL_ + "/auth/v1/user", { headers: { apikey: KEY, Authorization: "Bearer " + tok } });
  if (!u.ok) return null;
  const user = await u.json();
  const p = await sb(`/rest/v1/lb_profiles?id=eq.${encodeURIComponent(user.id)}&select=id,role,active`);
  const row = Array.isArray(p.j) ? p.j[0] : null;
  return row && row.active && row.role === "owner" ? row : null;
}

const otherOwners = async (id) => {
  const r = await sb(`/rest/v1/lb_profiles?role=eq.owner&active=eq.true&id=neq.${encodeURIComponent(id)}&select=id`);
  return Array.isArray(r.j) ? r.j.length : 0;
};

module.exports = async (req, res) => {
  const send = (code, body) => res.status(code).json(body);
  try {
    if (!URL_ || !KEY) return send(500, { error: "Server belum dikonfigurasi: isi SUPABASE_URL dan SUPABASE_SERVICE_ROLE_KEY di Vercel" });
    const me = await caller(req);
    if (!me) return send(403, { error: "Hanya owner yang boleh mengelola pengguna" });
    const b = typeof req.body === "string" ? JSON.parse(req.body || "{}") : req.body || {};

    if (req.method === "POST") {
      const name = String(b.name || "").trim();
      const username = String(b.username || "").trim().toLowerCase();
      if (!name || !username) return send(400, { error: "Nama dan username wajib" });
      if (!ROLES.includes(b.role)) return send(400, { error: "Role tidak valid" });
      if (String(b.password || "").length < 6) return send(400, { error: "Password minimal 6 karakter" });
      const isMail = username.includes("@");
      if (!isMail && !/^[a-z0-9._-]{3,30}$/.test(username)) return send(400, { error: "Username 3-30 karakter: huruf kecil, angka, titik, minus" });
      const email = isMail ? username : `${username}@${DOMAIN}`;
      const r = await sb("/auth/v1/admin/users", {
        method: "POST",
        body: JSON.stringify({
          email, password: b.password, email_confirm: true,
          app_metadata: { lb_role: b.role, lb_username: isMail ? username.split("@")[0] : username, lb_name: name, lb_active: b.active !== false },
        }),
      });
      if (!r.ok) {
        const m = String(r.j.msg || r.j.message || r.j.error_description || "Gagal membuat akun");
        return send(400, { error: /already|registered|exists/i.test(m) ? "Username sudah dipakai" : m });
      }
      if (b.active === false) await sb(`/auth/v1/admin/users/${r.j.id}`, { method: "PUT", body: JSON.stringify({ ban_duration: "876000h" }) });
      return send(200, { id: r.j.id });
    }

    if (req.method === "PATCH") {
      const id = String(b.id || "");
      if (!id) return send(400, { error: "ID tidak valid" });
      const cur = await sb(`/rest/v1/lb_profiles?id=eq.${encodeURIComponent(id)}&select=id,role,active`);
      const t = Array.isArray(cur.j) ? cur.j[0] : null;
      if (!t) return send(404, { error: "Pengguna tidak ditemukan" });
      const role = b.role ?? t.role, active = b.active ?? t.active;
      if (!ROLES.includes(role)) return send(400, { error: "Role tidak valid" });
      if (id === me.id && !active) return send(400, { error: "Tidak bisa menonaktifkan akun sendiri" });
      if (t.role === "owner" && (role !== "owner" || !active) && (await otherOwners(id)) < 1) return send(400, { error: "Harus ada minimal satu owner aktif" });
      const upd = {};
      if (b.name !== undefined) upd.name = String(b.name).trim();
      upd.role = role; upd.active = !!active;
      const pr = await sb(`/rest/v1/lb_profiles?id=eq.${encodeURIComponent(id)}`, { method: "PATCH", headers: { Prefer: "return=minimal" }, body: JSON.stringify(upd) });
      if (!pr.ok) return send(400, { error: "Gagal menyimpan profil" });
      const au = { ban_duration: active ? "none" : "876000h" };
      if (b.password) {
        if (String(b.password).length < 6) return send(400, { error: "Password minimal 6 karakter" });
        au.password = b.password;
      }
      const ar = await sb(`/auth/v1/admin/users/${id}`, { method: "PUT", body: JSON.stringify(au) });
      if (!ar.ok) return send(400, { error: String(ar.j.msg || ar.j.message || "Gagal memperbarui akun") });
      return send(200, { ok: true });
    }

    return send(405, { error: "Metode tidak didukung" });
  } catch (e) {
    return send(500, { error: "Kesalahan server: " + (e && e.message ? e.message : e) });
  }
};
