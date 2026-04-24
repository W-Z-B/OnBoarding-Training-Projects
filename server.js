const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { query, migrate } = require("./db");

const PORT = process.env.PORT || 3000;
const ROOT = __dirname;
const TRAINER_PASSWORD = process.env.TRAINER_PASSWORD || "vpmo2026";
const TRAINER_FULL_NAME = process.env.TRAINER_FULL_NAME || "Wakeel Zacharias Boodhoo";
const isTrainerUser = (u) => u && u.full_name && u.full_name.trim().toLowerCase() === TRAINER_FULL_NAME.trim().toLowerCase();
const MAX_BODY = 10 * 1024 * 1024;
const SESSION_TTL_DAYS = 30;
const MIN_LEAD_DAYS = 2;

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js":   "application/javascript; charset=utf-8",
  ".css":  "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png":  "image/png",
  ".jpg":  "image/jpeg",
  ".jpeg": "image/jpeg",
  ".svg":  "image/svg+xml",
  ".ico":  "image/x-icon",
  ".webp": "image/webp",
  ".txt":  "text/plain; charset=utf-8"
};

/* ----- helpers ----- */
function send(res, status, body, headers = {}) {
  const isStr = typeof body === "string";
  res.writeHead(status, {
    "Content-Type": isStr ? "text/plain; charset=utf-8" : "application/json; charset=utf-8",
    ...headers
  });
  res.end(isStr ? body : JSON.stringify(body));
}
function json(res, status, obj, headers) { send(res, status, obj, headers); }
function readBody(req) {
  return new Promise((resolve, reject) => {
    let total = 0; const chunks = [];
    req.on("data", (c) => {
      total += c.length;
      if (total > MAX_BODY) { reject(new Error("body too large")); req.destroy(); return; }
      chunks.push(c);
    });
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      if (!raw) return resolve({});
      try { resolve(JSON.parse(raw)); } catch { reject(new Error("invalid JSON")); }
    });
    req.on("error", reject);
  });
}
function parseCookies(header) {
  const out = {};
  if (!header) return out;
  header.split(";").forEach(p => {
    const i = p.indexOf("=");
    if (i < 0) return;
    out[p.slice(0, i).trim()] = decodeURIComponent(p.slice(i + 1).trim());
  });
  return out;
}
function setCookie(res, name, value, opts = {}) {
  const parts = [`${name}=${encodeURIComponent(value)}`];
  if (opts.maxAge) parts.push(`Max-Age=${opts.maxAge}`);
  parts.push("Path=/", "HttpOnly", "SameSite=Lax");
  if (process.env.NODE_ENV !== "development") parts.push("Secure");
  res.setHeader("Set-Cookie", parts.join("; "));
}
function clearCookie(res, name) {
  res.setHeader("Set-Cookie", `${name}=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax${process.env.NODE_ENV !== "development" ? "; Secure" : ""}`);
}
function hashPassword(password, salt) {
  return crypto.scryptSync(password, salt, 64).toString("hex");
}
function timingSafeStrEq(a, b) {
  const ab = Buffer.from(a, "utf8"), bb = Buffer.from(b, "utf8");
  if (ab.length !== bb.length) return false;
  return crypto.timingSafeEqual(ab, bb);
}
function genToken() { return crypto.randomBytes(32).toString("hex"); }
function uid() { return crypto.randomUUID(); }
function validEmail(s) { return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s); }
function validPhone(s) { return /^[+\d][\d\s\-().]{5,}$/.test(s); }
function validUsername(s) { return /^[a-z0-9._-]{3,}$/i.test(s); }

async function getSessionUser(req) {
  const token = parseCookies(req.headers.cookie)["sid"];
  if (!token) return null;
  const { rows } = await query(
    `SELECT u.* FROM users u JOIN sessions s ON s.user_id = u.id
     WHERE s.token = $1 AND s.expires_at > NOW()`,
    [token]
  );
  const u = rows[0] || null;
  // Opportunistic last-seen update (best effort, doesn't block)
  if (u) query(`UPDATE users SET last_seen_at = NOW() WHERE id = $1`, [u.id]).catch(() => {});
  return u;
}

function publicUserListRow(u) {
  return {
    id: u.id, username: u.username, fullName: u.full_name,
    email: u.email, unit: u.unit, phone: u.phone,
    isTrainer: isTrainerUser(u),
    lastSeenAt: u.last_seen_at,
    hasVpmoApk: !!u.has_vpmo_apk,
    apkConfirmedAt: u.apk_confirmed_at,
    createdAt: u.created_at
  };
}

/* Ownership: only booking owner or trainer may mutate. */
async function canMutateBooking(user, bookingId) {
  if (!user) return null;
  const { rows } = await query(`SELECT user_id FROM bookings WHERE id = $1`, [bookingId]);
  if (!rows[0]) return { code: 404 };
  if (rows[0].user_id !== user.id && !isTrainerUser(user)) return { code: 403 };
  return { ok: true };
}

/* ----- Bulk serialization: avoids N+1 ----- */
function rowToBooking(row, teamByBooking, notesByBooking, matsByBooking) {
  return {
    id: row.id,
    fullName: row.full_name,
    email: row.email,
    phone: row.phone,
    unit: row.unit,
    level: row.level,
    role: row.role,
    attendees: row.attendees,
    date: row.date instanceof Date ? row.date.toISOString().slice(0,10) : row.date,
    time: row.time,
    duration: row.duration,
    format: row.format,
    notes: row.notes || "",
    status: row.status,
    completedAt: row.completed_at,
    cancelledAt: row.cancelled_at,
    postponedTo: row.postponed_to ? (row.postponed_to instanceof Date ? row.postponed_to.toISOString().slice(0,10) : row.postponed_to) : null,
    postponedTime: row.postponed_time,
    createdAt: row.created_at,
    teamMembers: (teamByBooking[row.id] || []).map(t => ({ id: t.id, name: t.name })),
    studyNotes: (notesByBooking[row.id] || []).map(n => ({ id: n.id, text: n.text, createdAt: n.created_at })),
    // Materials: metadata only — data is streamed via /api/materials/:id/download
    materials: (matsByBooking[row.id] || []).map(m => ({ id: m.id, name: m.name, size: m.size, type: m.mime, uploadedAt: m.uploaded_at, downloadUrl: `/api/materials/${m.id}/download` }))
  };
}

async function serializeBookings(rows) {
  if (rows.length === 0) return [];
  const ids = rows.map(r => r.id);
  const [team, notes, mats] = await Promise.all([
    query(`SELECT id, booking_id, name FROM team_members WHERE booking_id = ANY($1::text[]) ORDER BY created_at`, [ids]),
    query(`SELECT id, booking_id, text, created_at FROM study_notes WHERE booking_id = ANY($1::text[]) ORDER BY created_at DESC`, [ids]),
    query(`SELECT id, booking_id, name, size, mime, uploaded_at FROM materials WHERE booking_id = ANY($1::text[]) ORDER BY uploaded_at`, [ids])
  ]);
  const groupBy = (arr) => arr.reduce((acc, r) => ((acc[r.booking_id] = acc[r.booking_id] || []).push(r), acc), {});
  const teamByBooking = groupBy(team.rows);
  const notesByBooking = groupBy(notes.rows);
  const matsByBooking = groupBy(mats.rows);
  return rows.map(r => rowToBooking(r, teamByBooking, notesByBooking, matsByBooking));
}

async function serializeOneBooking(id) {
  const { rows } = await query(`SELECT * FROM bookings WHERE id = $1`, [id]);
  if (!rows[0]) return null;
  const [out] = await serializeBookings(rows);
  return out;
}

function publicUser(u) {
  return {
    id: u.id, username: u.username, email: u.email,
    fullName: u.full_name, phone: u.phone, unit: u.unit,
    isTrainer: isTrainerUser(u)
  };
}

/* ----- Routes ----- */
const routes = [];
const route = (method, pattern, handler) => routes.push({ method, pattern, handler });

/* AUTH */
route("POST", /^\/api\/auth\/signup$/, async (req, res) => {
  const body = await readBody(req);
  const fullName = (body.fullName || "").trim();
  const username = (body.username || "").trim().toLowerCase();
  const email = (body.email || "").trim();
  const phone = (body.phone || "").trim();
  const unit = (body.unit || "").trim();
  const password = body.password || "";

  if (!fullName || fullName.split(/\s+/).length < 2) return json(res, 400, { error: "Please enter your real full name." });
  if (!validUsername(username)) return json(res, 400, { error: "Username must be 3+ chars (letters, numbers, . _ -)." });
  if (!validEmail(email)) return json(res, 400, { error: "Invalid email." });
  if (!validPhone(phone)) return json(res, 400, { error: "Invalid phone number." });
  if (!unit) return json(res, 400, { error: "Choose your unit." });
  if (password.length < 6) return json(res, 400, { error: "Password must be at least 6 characters." });

  const salt = crypto.randomBytes(16).toString("hex");
  const passwordHash = hashPassword(password, salt);

  // Rely on DB uniqueness (race-safe) rather than a pre-SELECT.
  let user;
  try {
    const { rows } = await query(
      `INSERT INTO users (username, email, full_name, phone, unit, salt, password_hash)
       VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
      [username, email, fullName, phone, unit, salt, passwordHash]
    );
    user = rows[0];
  } catch (e) {
    if (e.code === "23505") return json(res, 409, { error: "Username or email already exists." });
    throw e;
  }

  const token = genToken();
  const expires = new Date(Date.now() + SESSION_TTL_DAYS * 86400 * 1000);
  await query(`INSERT INTO sessions (token, user_id, expires_at) VALUES ($1,$2,$3)`, [token, user.id, expires]);
  setCookie(res, "sid", token, { maxAge: SESSION_TTL_DAYS * 86400 });
  json(res, 200, { user: publicUser(user) });
});

route("POST", /^\/api\/auth\/login$/, async (req, res) => {
  const { username = "", password = "" } = await readBody(req);
  const u = username.trim().toLowerCase();
  const { rows } = await query(`SELECT * FROM users WHERE username = $1`, [u]);
  const user = rows[0];
  if (!user) return json(res, 401, { error: "Invalid username or password." });
  const hash = hashPassword(password, user.salt);
  if (!timingSafeStrEq(hash, user.password_hash)) return json(res, 401, { error: "Invalid username or password." });

  // Opportunistic expired-session cleanup
  query(`DELETE FROM sessions WHERE expires_at < NOW()`).catch(() => {});

  const token = genToken();
  const expires = new Date(Date.now() + SESSION_TTL_DAYS * 86400 * 1000);
  await query(`INSERT INTO sessions (token, user_id, expires_at) VALUES ($1,$2,$3)`, [token, user.id, expires]);
  setCookie(res, "sid", token, { maxAge: SESSION_TTL_DAYS * 86400 });
  json(res, 200, { user: publicUser(user) });
});

route("POST", /^\/api\/auth\/logout$/, async (req, res) => {
  const token = parseCookies(req.headers.cookie)["sid"];
  if (token) await query(`DELETE FROM sessions WHERE token = $1`, [token]);
  clearCookie(res, "sid");
  json(res, 200, { ok: true });
});

route("GET", /^\/api\/auth\/me$/, async (req, res) => {
  const user = await getSessionUser(req);
  if (!user) return json(res, 401, { error: "Not logged in" });
  json(res, 200, { user: publicUser(user) });
});

route("POST", /^\/api\/auth\/trainer$/, async (req, res) => {
  const user = await getSessionUser(req);
  if (!user) return json(res, 401, { error: "Login required" });
  if (!isTrainerUser(user)) return json(res, 403, { error: "Your account is not authorised for trainer access." });
  const { password = "" } = await readBody(req);
  if (!timingSafeStrEq(password, TRAINER_PASSWORD)) return json(res, 401, { error: "Wrong trainer password." });
  json(res, 200, { ok: true });
});

/* BOOKINGS */
route("GET", /^\/api\/bookings$/, async (req, res) => {
  const user = await getSessionUser(req);
  if (!user) return json(res, 401, { error: "Login required" });
  const url = new URL(req.url, "http://x");
  const scope = url.searchParams.get("scope") || "mine";
  let rows;
  if (scope === "all") {
    if (!isTrainerUser(user)) return json(res, 403, { error: "Not authorised." });
    ({ rows } = await query(`SELECT * FROM bookings ORDER BY date, "time"`));
  } else {
    ({ rows } = await query(`SELECT * FROM bookings WHERE user_id = $1 ORDER BY date, "time"`, [user.id]));
  }
  json(res, 200, { bookings: await serializeBookings(rows) });
});

route("POST", /^\/api\/bookings$/, async (req, res) => {
  const user = await getSessionUser(req);
  if (!user) return json(res, 401, { error: "Login required" });
  const b = await readBody(req);

  if (!b.level || !b.date || !b.time || !b.duration) return json(res, 400, { error: "Missing booking fields." });
  const dur = Number(b.duration);
  if (!(dur > 0 && dur <= 600)) return json(res, 400, { error: "Invalid duration." });

  // Minimum lead time: booking date must be at least MIN_LEAD_DAYS days ahead.
  // Trainer can bypass for rescheduling flexibility.
  if (!isTrainerUser(user)) {
    const earliest = new Date(); earliest.setHours(0,0,0,0);
    earliest.setDate(earliest.getDate() + MIN_LEAD_DAYS);
    const picked = new Date(b.date + "T00:00:00");
    if (picked < earliest) return json(res, 400, { error: `Please book at least ${MIN_LEAD_DAYS} days in advance.` });
  }
  // No weekend training
  {
    const picked = new Date(b.date + "T00:00:00");
    const dow = picked.getDay();
    if (dow === 0 || dow === 6) return json(res, 400, { error: "Training isn't scheduled on weekends — please pick a weekday." });
  }
  const role = b.role === "UnitHead" ? "UnitHead" : "Member";
  const teamMembers = role === "UnitHead" ? (Array.isArray(b.teamMembers) ? b.teamMembers : []) : [];
  const attendees = role === "UnitHead" ? teamMembers.length : Math.max(1, Number(b.attendees) || 1);
  if (role === "UnitHead" && teamMembers.length === 0) return json(res, 400, { error: "Add at least one team member." });

  // Conflict detection done in SQL for efficiency + consistency
  const { rows: exist } = await query(
    `SELECT id, "time", duration FROM bookings
     WHERE user_id = $1 AND date = $2
       AND status != 'Cancelled'`,
    [user.id, b.date]
  );
  const toMin = (t) => { const [h,m]=t.split(":").map(Number); return h*60+m; };
  const ns = toMin(b.time), ne = ns + dur;
  const conflict = exist.find(x => {
    const xs = toMin(x.time), xe = xs + x.duration;
    return ns < xe && xs < ne;
  });
  if (conflict) return json(res, 409, { error: `Time conflicts with your existing booking at ${conflict.time}.` });

  const id = uid();
  try {
    await query(
      `INSERT INTO bookings (id, user_id, full_name, email, phone, unit, level, role, attendees, date, "time", duration, format, notes, status)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,'Scheduled')`,
      [id, user.id, user.full_name, user.email, user.phone, user.unit, b.level, role, attendees, b.date, b.time, dur, b.format || "In-person", b.notes || ""]
    );
    for (const tm of teamMembers) {
      const name = String((tm && tm.name) || tm || "").trim();
      if (name) await query(`INSERT INTO team_members (id, booking_id, name) VALUES ($1,$2,$3)`, [uid(), id, name]);
    }
  } catch (e) {
    if (e.code === "23514") return json(res, 400, { error: "Invalid value for a booking field." });
    throw e;
  }
  json(res, 200, { booking: await serializeOneBooking(id) });
});

route("PATCH", /^\/api\/bookings\/([^/]+)$/, async (req, res, [, id]) => {
  const user = await getSessionUser(req);
  const auth = await canMutateBooking(user, id);
  if (!user) return json(res, 401, { error: "Login required" });
  if (!auth.ok) return json(res, auth.code, { error: auth.code === 404 ? "Not found" : "Not authorised." });

  const body = await readBody(req);
  const updates = [];
  const values = [];
  let i = 1;
  if (body.status && ["Scheduled","Completed","Cancelled","Postponed"].includes(body.status)) {
    // Only the trainer may mark a booking Completed
    if (body.status === "Completed" && !isTrainerUser(user)) {
      return json(res, 403, { error: "Only the trainer can mark a booking as Completed." });
    }
    updates.push(`status = $${i++}`); values.push(body.status);
    if (body.status === "Completed") updates.push(`completed_at = NOW()`);
    if (body.status === "Cancelled") updates.push(`cancelled_at = NOW()`);
    if (body.status === "Scheduled") updates.push(`completed_at = NULL`, `cancelled_at = NULL`, `postponed_to = NULL`, `postponed_time = NULL`);
  }
  if (body.postponedTo !== undefined) {
    if (body.postponedTo) {
      const d = new Date(body.postponedTo + "T00:00:00");
      const dow = d.getDay();
      if (dow === 0 || dow === 6) return json(res, 400, { error: "Postponed date must be a weekday." });
    }
    updates.push(`postponed_to = $${i++}`); values.push(body.postponedTo || null);
  }
  if (body.postponedTime !== undefined) { updates.push(`postponed_time = $${i++}`); values.push(body.postponedTime || null); }
  if (updates.length === 0) return json(res, 400, { error: "Nothing to update." });

  values.push(id);
  await query(`UPDATE bookings SET ${updates.join(", ")} WHERE id = $${i}`, values);
  json(res, 200, { booking: await serializeOneBooking(id) });
});

route("DELETE", /^\/api\/bookings\/([^/]+)$/, async (req, res, [, id]) => {
  const user = await getSessionUser(req);
  const auth = await canMutateBooking(user, id);
  if (!user) return json(res, 401, { error: "Login required" });
  if (!auth.ok) return json(res, auth.code, { error: auth.code === 404 ? "Not found" : "Not authorised." });
  await query(`DELETE FROM bookings WHERE id = $1`, [id]);
  json(res, 200, { ok: true });
});

/* NOTES */
route("POST", /^\/api\/bookings\/([^/]+)\/notes$/, async (req, res, [, id]) => {
  const user = await getSessionUser(req);
  const auth = await canMutateBooking(user, id);
  if (!user) return json(res, 401, { error: "Login required" });
  if (!auth.ok) return json(res, auth.code, { error: auth.code === 404 ? "Not found" : "Not authorised." });
  const { text = "" } = await readBody(req);
  if (!text.trim()) return json(res, 400, { error: "Empty note." });
  await query(`INSERT INTO study_notes (id, booking_id, text) VALUES ($1,$2,$3)`, [uid(), id, text.trim()]);
  json(res, 200, { booking: await serializeOneBooking(id) });
});

route("DELETE", /^\/api\/bookings\/([^/]+)\/notes\/([^/]+)$/, async (req, res, [, bid, nid]) => {
  const user = await getSessionUser(req);
  const auth = await canMutateBooking(user, bid);
  if (!user) return json(res, 401, { error: "Login required" });
  if (!auth.ok) return json(res, auth.code, { error: auth.code === 404 ? "Not found" : "Not authorised." });
  await query(`DELETE FROM study_notes WHERE id = $1 AND booking_id = $2`, [nid, bid]);
  json(res, 200, { booking: await serializeOneBooking(bid) });
});

/* MATERIALS */
route("POST", /^\/api\/bookings\/([^/]+)\/materials$/, async (req, res, [, id]) => {
  const user = await getSessionUser(req);
  const auth = await canMutateBooking(user, id);
  if (!user) return json(res, 401, { error: "Login required" });
  if (!auth.ok) return json(res, auth.code, { error: auth.code === 404 ? "Not found" : "Not authorised." });
  const { name, size, type, data } = await readBody(req);
  if (!name || !data) return json(res, 400, { error: "Missing file data." });
  await query(
    `INSERT INTO materials (id, booking_id, name, size, mime, data) VALUES ($1,$2,$3,$4,$5,$6)`,
    [uid(), id, name, Number(size) || 0, type || null, data]
  );
  json(res, 200, { booking: await serializeOneBooking(id) });
});

route("DELETE", /^\/api\/bookings\/([^/]+)\/materials\/([^/]+)$/, async (req, res, [, bid, mid]) => {
  const user = await getSessionUser(req);
  const auth = await canMutateBooking(user, bid);
  if (!user) return json(res, 401, { error: "Login required" });
  if (!auth.ok) return json(res, auth.code, { error: auth.code === 404 ? "Not found" : "Not authorised." });
  await query(`DELETE FROM materials WHERE id = $1 AND booking_id = $2`, [mid, bid]);
  json(res, 200, { booking: await serializeOneBooking(bid) });
});

// Stream material on demand (avoids including base64 blobs in list responses)
route("GET", /^\/api\/materials\/([^/]+)\/download$/, async (req, res, [, mid]) => {
  const user = await getSessionUser(req);
  if (!user) return json(res, 401, { error: "Login required" });
  const { rows } = await query(
    `SELECT m.*, b.user_id AS owner_id FROM materials m JOIN bookings b ON b.id = m.booking_id WHERE m.id = $1`,
    [mid]
  );
  const row = rows[0];
  if (!row) return json(res, 404, { error: "Not found" });
  if (row.owner_id !== user.id && !isTrainerUser(user)) return json(res, 403, { error: "Not authorised." });

  // Decode the data: URI into raw bytes
  const m = /^data:([^;,]+)?(?:;([^,]+))?,(.*)$/.exec(row.data);
  if (!m) return json(res, 500, { error: "Invalid stored material." });
  const mimeHint = m[1] || row.mime || "application/octet-stream";
  const encoding = (m[2] || "").toLowerCase();
  const payload = m[3];
  const buf = encoding === "base64" ? Buffer.from(payload, "base64") : Buffer.from(decodeURIComponent(payload), "utf8");

  res.writeHead(200, {
    "Content-Type": mimeHint,
    "Content-Length": buf.length,
    "Content-Disposition": `attachment; filename="${row.name.replace(/"/g, "")}"`,
    "Cache-Control": "private, max-age=60"
  });
  res.end(buf);
});

/* TEAM */
route("POST", /^\/api\/bookings\/([^/]+)\/team$/, async (req, res, [, id]) => {
  const user = await getSessionUser(req);
  const auth = await canMutateBooking(user, id);
  if (!user) return json(res, 401, { error: "Login required" });
  if (!auth.ok) return json(res, auth.code, { error: auth.code === 404 ? "Not found" : "Not authorised." });
  const { name = "" } = await readBody(req);
  if (!name.trim()) return json(res, 400, { error: "Empty name." });
  await query(`INSERT INTO team_members (id, booking_id, name) VALUES ($1,$2,$3)`, [uid(), id, name.trim()]);
  await query(`UPDATE bookings SET attendees = GREATEST(1, (SELECT COUNT(*) FROM team_members WHERE booking_id = $1)) WHERE id = $1`, [id]);
  json(res, 200, { booking: await serializeOneBooking(id) });
});

route("DELETE", /^\/api\/bookings\/([^/]+)\/team\/([^/]+)$/, async (req, res, [, bid, mid]) => {
  const user = await getSessionUser(req);
  const auth = await canMutateBooking(user, bid);
  if (!user) return json(res, 401, { error: "Login required" });
  if (!auth.ok) return json(res, auth.code, { error: auth.code === 404 ? "Not found" : "Not authorised." });
  await query(`DELETE FROM team_members WHERE id = $1 AND booking_id = $2`, [mid, bid]);
  await query(`UPDATE bookings SET attendees = GREATEST(1, (SELECT COUNT(*) FROM team_members WHERE booking_id = $1)) WHERE id = $1`, [bid]);
  json(res, 200, { booking: await serializeOneBooking(bid) });
});

/* USERS directory */
route("GET", /^\/api\/users$/, async (req, res) => {
  const user = await getSessionUser(req);
  if (!user) return json(res, 401, { error: "Login required" });
  let rows;
  if (isTrainerUser(user)) {
    ({ rows } = await query(`SELECT * FROM users ORDER BY full_name`));
  } else {
    // Trainees only see the trainer so they know who to chat with
    ({ rows } = await query(
      `SELECT * FROM users WHERE LOWER(TRIM(full_name)) = LOWER(TRIM($1)) OR id = $2 ORDER BY id = $2 DESC`,
      [TRAINER_FULL_NAME, user.id]
    ));
  }
  json(res, 200, { users: rows.map(publicUserListRow) });
});

/* APK tracking (trainer only) */
route("PATCH", /^\/api\/users\/([0-9]+)\/apk$/, async (req, res, [, uid]) => {
  const user = await getSessionUser(req);
  if (!user) return json(res, 401, { error: "Login required" });
  if (!isTrainerUser(user)) return json(res, 403, { error: "Trainer only." });
  const { hasVpmoApk } = await readBody(req);
  const flag = !!hasVpmoApk;
  const { rows } = await query(
    `UPDATE users SET has_vpmo_apk = $1, apk_confirmed_at = CASE WHEN $1 THEN NOW() ELSE NULL END
     WHERE id = $2 RETURNING *`,
    [flag, Number(uid)]
  );
  if (!rows[0]) return json(res, 404, { error: "User not found" });
  json(res, 200, { user: publicUserListRow(rows[0]) });
});

/* MESSAGES */
route("GET", /^\/api\/messages\/threads$/, async (req, res) => {
  const user = await getSessionUser(req);
  if (!user) return json(res, 401, { error: "Login required" });
  // For the current user, return distinct other-party user_ids with last message + unread count
  const { rows } = await query(
    `SELECT
       CASE WHEN sender_id = $1 THEN recipient_id ELSE sender_id END AS other_id,
       MAX(created_at) AS last_at,
       SUM(CASE WHEN recipient_id = $1 AND read_at IS NULL THEN 1 ELSE 0 END)::int AS unread
     FROM messages
     WHERE sender_id = $1 OR recipient_id = $1
     GROUP BY other_id
     ORDER BY last_at DESC`,
    [user.id]
  );
  json(res, 200, { threads: rows });
});

route("GET", /^\/api\/messages\/unread-count$/, async (req, res) => {
  const user = await getSessionUser(req);
  if (!user) return json(res, 401, { error: "Login required" });
  const { rows } = await query(
    `SELECT COUNT(*)::int AS n FROM messages WHERE recipient_id = $1 AND read_at IS NULL`,
    [user.id]
  );
  json(res, 200, { unread: rows[0].n });
});

route("GET", /^\/api\/messages\/([0-9]+)$/, async (req, res, [, otherId]) => {
  const user = await getSessionUser(req);
  if (!user) return json(res, 401, { error: "Login required" });
  const other = Number(otherId);

  // Trainees may only chat with the trainer
  if (!isTrainerUser(user)) {
    const { rows: tr } = await query(
      `SELECT id FROM users WHERE LOWER(TRIM(full_name)) = LOWER(TRIM($1)) LIMIT 1`,
      [TRAINER_FULL_NAME]
    );
    const trainerId = tr[0]?.id;
    if (!trainerId || other !== trainerId) return json(res, 403, { error: "You can only message the trainer." });
  }

  const { rows } = await query(
    `SELECT id, sender_id, recipient_id, text, forwarded_note_id, forwarded_booking_id, read_at, created_at
     FROM messages
     WHERE (sender_id = $1 AND recipient_id = $2) OR (sender_id = $2 AND recipient_id = $1)
     ORDER BY created_at`,
    [user.id, other]
  );
  // Mark any inbound messages as read
  await query(`UPDATE messages SET read_at = NOW() WHERE recipient_id = $1 AND sender_id = $2 AND read_at IS NULL`, [user.id, other]);
  json(res, 200, { messages: rows });
});

route("POST", /^\/api\/messages$/, async (req, res) => {
  const user = await getSessionUser(req);
  if (!user) return json(res, 401, { error: "Login required" });
  const { recipientId, text = "", forwardedNoteId = null, forwardedBookingId = null } = await readBody(req);
  const rid = Number(recipientId);
  if (!rid || rid === user.id) return json(res, 400, { error: "Invalid recipient." });
  if (!text.trim() && !forwardedNoteId) return json(res, 400, { error: "Empty message." });

  // Trainees may only DM the trainer
  if (!isTrainerUser(user)) {
    const { rows: tr } = await query(
      `SELECT id FROM users WHERE LOWER(TRIM(full_name)) = LOWER(TRIM($1)) LIMIT 1`,
      [TRAINER_FULL_NAME]
    );
    const trainerId = tr[0]?.id;
    if (!trainerId || rid !== trainerId) return json(res, 403, { error: "You can only message the trainer." });
  }

  // Recipient exists
  const { rowCount } = await query(`SELECT 1 FROM users WHERE id = $1`, [rid]);
  if (!rowCount) return json(res, 404, { error: "Recipient not found." });

  // If forwarding a note, expand the text on the server so the receiver sees context
  let finalText = text.trim();
  let bookingLink = forwardedBookingId || null;
  if (forwardedNoteId) {
    const { rows: n } = await query(
      `SELECT sn.text AS note_text, b.id AS booking_id, b.full_name AS booking_name, b.level, b.date, b."time"
       FROM study_notes sn JOIN bookings b ON b.id = sn.booking_id
       WHERE sn.id = $1`,
      [forwardedNoteId]
    );
    if (!n[0]) return json(res, 404, { error: "Note not found." });
    // Only the note's booking owner or trainer can forward it
    const auth = await canMutateBooking(user, n[0].booking_id);
    if (!auth.ok) return json(res, 403, { error: "Not authorised to forward this note." });
    bookingLink = n[0].booking_id;
    const header = `↗️ Forwarded note — ${n[0].level}, ${n[0].date} ${n[0].time} (${n[0].booking_name}):\n\n${n[0].note_text}`;
    finalText = finalText ? `${finalText}\n\n${header}` : header;
  }

  const id = uid();
  await query(
    `INSERT INTO messages (id, sender_id, recipient_id, text, forwarded_note_id, forwarded_booking_id)
     VALUES ($1,$2,$3,$4,$5,$6)`,
    [id, user.id, rid, finalText, forwardedNoteId, bookingLink]
  );
  const { rows } = await query(`SELECT * FROM messages WHERE id = $1`, [id]);
  json(res, 200, { message: rows[0] });
});

/* ----- Static files ----- */
function serveStatic(req, res) {
  const urlPath = decodeURIComponent((req.url || "/").split("?")[0]);
  let rel = urlPath === "/" ? "/index.html" : urlPath;
  const filePath = path.normalize(path.join(ROOT, rel));
  if (!filePath.startsWith(ROOT)) { res.writeHead(403); return res.end("Forbidden"); }
  fs.stat(filePath, (err, stat) => {
    if (err || !stat.isFile()) {
      const fallback = path.join(ROOT, "index.html");
      return fs.readFile(fallback, (e, buf) => {
        if (e) { res.writeHead(404); return res.end("Not found"); }
        res.writeHead(200, { "Content-Type": MIME[".html"] });
        res.end(buf);
      });
    }
    const ext = path.extname(filePath).toLowerCase();
    res.writeHead(200, {
      "Content-Type": MIME[ext] || "application/octet-stream",
      "Cache-Control": ext === ".html" ? "no-cache" : "public, max-age=3600"
    });
    fs.createReadStream(filePath).pipe(res);
  });
}

const server = http.createServer(async (req, res) => {
  try {
    if (req.url.startsWith("/api/")) {
      for (const r of routes) {
        if (r.method !== req.method) continue;
        const m = req.url.split("?")[0].match(r.pattern);
        if (m) { await r.handler(req, res, m); return; }
      }
      return json(res, 404, { error: "Not found" });
    }
    serveStatic(req, res);
  } catch (err) {
    console.error("Request error:", err);
    if (!res.headersSent) json(res, 500, { error: "Internal error" });
  }
});

(async () => {
  try {
    if (process.env.DATABASE_URL) await migrate();
    else console.warn("DATABASE_URL not set — starting without DB (API will 500).");
  } catch (e) {
    console.error("Migration failed:", e);
  }
  // Periodic expired-session cleanup (every 6 hours)
  setInterval(() => {
    if (process.env.DATABASE_URL) query(`DELETE FROM sessions WHERE expires_at < NOW()`).catch(() => {});
  }, 6 * 60 * 60 * 1000).unref();
  server.listen(PORT, () => console.log(`GPL VPMO training listening on :${PORT}`));
})();
