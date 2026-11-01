require('dotenv').config();
const express = require('express');
const path = require('path');
const crypto = require('crypto');
const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL && !process.env.DATABASE_URL.includes('localhost')
    ? { rejectUnauthorized: false } : false
});

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const wrap = fn => (req, res) => fn(req, res).catch(e => {
  console.error(e);
  res.status(e.status || 500).json({ error: e.status ? e.message : 'Server error' });
});

const fail = (status, message, extra = {}) => Object.assign(new Error(message), { status }, extra);

// ---------- Unique voucher codes ----------
// Makes a new random code every redeem, e.g. DRINK-001-K7M2QX
// (letters/numbers that are easy to read: no 0/O or 1/I)
const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const CODE_RE = /^[A-Z0-9][A-Z0-9-]{2,60}$/;
function randomPart(len = 6) {
  const bytes = crypto.randomBytes(len);
  let s = '';
  for (let k = 0; k < len; k++) s += CODE_CHARS[bytes[k] % CODE_CHARS.length];
  return s;
}
async function uniqueCode(client, rawPrefix) {
  const prefix = String(rawPrefix || '').trim().toUpperCase().replace(/[^A-Z0-9-]/g, '') || 'VOUCHER';
  for (let tries = 0; tries < 10; tries++) {
    const code = prefix + '-' + randomPart();
    const { rows } = await client.query('SELECT 1 FROM redemptions WHERE voucher_code = $1', [code]);
    if (!rows.length) return code;
  }
  throw fail(500, 'Could not make a voucher code. Please try again.');
}

// ---------- Database setup (runs on every start, safe to repeat) ----------
async function init() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      user_id TEXT PRIMARY KEY,
      username TEXT NOT NULL,
      points INTEGER NOT NULL DEFAULT 0,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS items (
      item_id SERIAL PRIMARY KEY,
      name TEXT NOT NULL,
      voucher_code TEXT NOT NULL,
      points_required INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS redemptions (
      id SERIAL PRIMARY KEY,
      user_id TEXT NOT NULL,
      item_name TEXT NOT NULL,
      voucher_code TEXT NOT NULL,
      points_spent INTEGER NOT NULL,
      redeemed_at TIMESTAMPTZ DEFAULT NOW()
    );
  `);
  await pool.query(`
    ALTER TABLE users ADD COLUMN IF NOT EXISTS card_uid TEXT;
    ALTER TABLE items ADD COLUMN IF NOT EXISTS image_url TEXT;
    ALTER TABLE redemptions ADD COLUMN IF NOT EXISTS used_at TIMESTAMPTZ;
    CREATE UNIQUE INDEX IF NOT EXISTS users_card_uid_idx ON users (card_uid) WHERE card_uid IS NOT NULL;
  `);
  const { rows } = await pool.query('SELECT COUNT(*)::int AS n FROM items');
  if (rows[0].n === 0) {
    await pool.query(`INSERT INTO items (name, voucher_code, points_required) VALUES
      ('Free drink', 'DRINK-001', 10),
      ('Free snack', 'SNACK-001', 20)`);
  }
}

// ---------- User routes ----------
app.post('/api/login', wrap(async (req, res) => {
  const user_id = String(req.body.user_id || '').trim();
  if (!user_id) throw fail(400, 'Enter your user ID.');
  const { rows } = await pool.query('SELECT * FROM users WHERE user_id = $1', [user_id]);
  if (!rows.length) throw fail(404, 'Account not found. Use "Create account" first.');
  res.json(rows[0]);
}));

app.post('/api/register', wrap(async (req, res) => {
  const user_id = String(req.body.user_id || '').trim();
  const username = String(req.body.username || '').trim();
  if (!user_id || !username) throw fail(400, 'Enter both a user ID and a username.');
  if (user_id.length > 30 || username.length > 40) throw fail(400, 'User ID or username is too long.');
  const { rows } = await pool.query(
    'INSERT INTO users (user_id, username) VALUES ($1, $2) ON CONFLICT (user_id) DO NOTHING RETURNING *',
    [user_id, username]);
  if (!rows.length) throw fail(409, 'This user ID is already registered. Please log in instead.');
  res.json(rows[0]);
}));

app.get('/api/user/:id', wrap(async (req, res) => {
  const u = await pool.query('SELECT user_id, username, points FROM users WHERE user_id = $1', [req.params.id]);
  if (!u.rows.length) throw fail(404, 'User not found.');
  const h = await pool.query(
    `SELECT item_name, voucher_code, points_spent, redeemed_at, used_at FROM redemptions
     WHERE user_id = $1 ORDER BY redeemed_at DESC LIMIT 50`, [req.params.id]);
  res.json({ ...u.rows[0], history: h.rows });
}));

app.get('/api/items', wrap(async (req, res) => {
  const { rows } = await pool.query('SELECT item_id, name, points_required, image_url FROM items ORDER BY points_required, item_id');
  res.json(rows);
}));

app.post('/api/redeem', wrap(async (req, res) => {
  const { user_id, item_id } = req.body;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const u = (await client.query('SELECT * FROM users WHERE user_id = $1 FOR UPDATE', [user_id])).rows[0];
    const i = (await client.query('SELECT * FROM items WHERE item_id = $1', [item_id])).rows[0];
    if (!u || !i) throw fail(404, 'User or item not found.');
    if (u.points < i.points_required) throw fail(400, 'Not enough points.');
    const code = await uniqueCode(client, i.voucher_code);   // new code every redeem
    await client.query('UPDATE users SET points = points - $1 WHERE user_id = $2', [i.points_required, user_id]);
    await client.query(
      `INSERT INTO redemptions (user_id, item_name, voucher_code, points_spent) VALUES ($1, $2, $3, $4)`,
      [user_id, i.name, code, i.points_required]);
    await client.query('COMMIT');
    res.json({ voucher_code: code, item_name: i.name });
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}));

// ---------- Voucher check page (the QR code opens this) ----------
const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const manila = d => new Date(d).toLocaleString('en-PH', { timeZone: 'Asia/Manila' });

function verifyPage(code, r) {
  let state, title, note;
  if (!r) { state = 'bad'; title = 'NOT FOUND'; note = 'This voucher code is not valid.'; }
  else if (r.used_at) { state = 'warn'; title = 'ALREADY USED'; note = 'Used on ' + manila(r.used_at); }
  else { state = 'ok'; title = 'VALID'; note = 'Redeemed on ' + manila(r.redeemed_at); }
  const canUse = state === 'ok' && CODE_RE.test(code);
  return `<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Voucher check</title>
<style>
  :root { --ink:#17302b; --mute:#5d7570; --accent:#0f766e; }
  * { box-sizing:border-box; }
  body { margin:0; background:#f3f6f5; color:var(--ink); font:16px/1.5 system-ui, sans-serif; }
  main { max-width:420px; margin:0 auto; padding:32px 16px; }
  .card { background:#fff; border:1px solid #d6e0dd; border-radius:12px; padding:24px; text-align:center; }
  .badge { display:inline-block; padding:8px 20px; border-radius:999px; font-weight:700; font-size:1.3rem; letter-spacing:.04em; color:#fff; }
  .ok { background:#0f766e; } .warn { background:#b45309; } .bad { background:#b42318; }
  .code { font-size:1.3rem; font-weight:700; letter-spacing:.05em; margin:16px 0 4px; word-break:break-all; }
  .mute { color:var(--mute); font-size:.95rem; }
  button { margin-top:20px; background:var(--accent); color:#fff; border:0; border-radius:8px; padding:12px 20px; font:inherit; font-weight:600; cursor:pointer; }
  #out { margin-top:12px; font-weight:600; }
</style></head><body><main><div class="card">
  <div class="badge ${state}">${title}</div>
  <div class="code">${esc(code)}</div>
  ${r ? `<div>${esc(r.item_name)}</div>` : ''}
  <div class="mute">${esc(note)}</div>
  ${canUse ? '<button id="use">Mark as used (staff)</button><div id="out"></div>' : ''}
</div></main>
${canUse ? `<script>
document.getElementById('use').onclick = async function () {
  var out = document.getElementById('out');
  try {
    var r = await fetch('/admin/api/verify/' + encodeURIComponent(${JSON.stringify(code)}) + '/use', { method: 'POST' });
    if (!r.ok) { var d = await r.json().catch(function () { return {}; }); throw new Error(d.error || 'Staff login required.'); }
    location.reload();
  } catch (e) { out.textContent = e.message; }
};
</script>` : ''}
</body></html>`;
}

app.get('/verify/:code', wrap(async (req, res) => {
  const code = String(req.params.code || '').trim().toUpperCase();
  let r = null;
  if (CODE_RE.test(code)) {
    r = (await pool.query(
      'SELECT item_name, redeemed_at, used_at FROM redemptions WHERE voucher_code = $1 ORDER BY redeemed_at DESC LIMIT 1',
      [code])).rows[0] || null;
  }
  res.type('html').send(verifyPage(code, r));
}));

// ---------- Machine (ESP32) ----------
// The machine sends its secret in a header (x-machine-key, x-api-key, or Authorization)
// or in the JSON body (key or api_key). Any of these works.
function requireMachine(req, res, next) {
  const expected = (process.env.MACHINE_KEY || '').trim();
  if (!expected) return res.status(503).json({ error: 'MACHINE_KEY is not set on the server' });
  const auth = (req.get('authorization') || '').replace(/^Bearer\s+/i, '');
  const body = req.body || {};
  const sent = String(req.get('x-machine-key') || req.get('x-api-key') || auth || body.key || body.api_key || body.apiKey || '').trim();
  if (sent !== expected) return res.status(401).json({ error: 'bad machine key' });
  next();
}
const normUid = v => String(v || '').replace(/[\s:\-]/g, '').toUpperCase();
const cardOf = body => body.card_uid || body.uid || body.card || body.card_id || body.user_id;

async function findByCard(raw) {
  const { rows } = await pool.query(
    'SELECT user_id, username, points FROM users WHERE card_uid = $1 OR user_id = $2',
    [normUid(raw), String(raw || '').trim()]);
  return rows[0];
}

// Tap a card: returns the user and their points
app.post('/login', requireMachine, wrap(async (req, res) => {
  const u = await findByCard(cardOf(req.body));
  if (!u) throw fail(404, 'unknown card');
  res.json(u);
}));

// Add points to the card's owner after an item is sorted (the machine calls /points)
async function addPoints(req, res) {
  const body = req.body || {};
  const points = parseInt(body.points ?? body.point ?? body.amount ?? 2, 10);
  if (!Number.isInteger(points) || points < 1 || points > 100) throw fail(400, 'points must be 1-100');
  const raw = cardOf(body);
  const { rows } = await pool.query(
    `UPDATE users SET points = points + $1 WHERE card_uid = $2 OR user_id = $3
     RETURNING user_id, username, points`, [points, normUid(raw), String(raw || '').trim()]);
  if (!rows.length) throw fail(404, 'unknown card');
  res.json({ ...rows[0], added: points, item: body.item || null });
}
app.post('/points', requireMachine, wrap(addPoints));
app.post('/deposit', requireMachine, wrap(addPoints));

// ---------- Admin ----------
function requireAdmin(req, res, next) {
  const [type, encoded] = (req.headers.authorization || '').split(' ');
  const [user, ...rest] = Buffer.from(encoded || '', 'base64').toString().split(':');
  const pass = rest.join(':');
  if (process.env.ADMIN_USER && process.env.ADMIN_PASS &&
      type === 'Basic' && user === process.env.ADMIN_USER && pass === process.env.ADMIN_PASS) return next();
  res.set('WWW-Authenticate', 'Basic realm="Admin"').status(401).send('Admin login required');
}

app.get('/admin', requireAdmin, (req, res) => res.sendFile(path.join(__dirname, 'views', 'admin.html')));

app.get('/admin/api/users', requireAdmin, wrap(async (req, res) => {
  res.json((await pool.query('SELECT user_id, username, points, card_uid, created_at FROM users ORDER BY created_at DESC')).rows);
}));

app.get('/admin/api/redemptions', requireAdmin, wrap(async (req, res) => {
  res.json((await pool.query(
    `SELECT r.id, r.user_id, u.username, r.item_name, r.voucher_code, r.points_spent, r.redeemed_at, r.used_at
     FROM redemptions r LEFT JOIN users u ON u.user_id = r.user_id
     ORDER BY r.redeemed_at DESC LIMIT 500`)).rows);
}));

// Mark a voucher as used (from the Redemptions tab)
app.post('/admin/api/redemptions/:id/use', requireAdmin, wrap(async (req, res) => {
  const { rows } = await pool.query(
    'UPDATE redemptions SET used_at = NOW() WHERE id = $1 AND used_at IS NULL RETURNING id', [req.params.id]);
  if (!rows.length) throw fail(409, 'Voucher not found or already used.');
  res.json({ ok: true });
}));

// Mark a voucher as used (from the QR check page)
app.post('/admin/api/verify/:code/use', requireAdmin, wrap(async (req, res) => {
  const code = String(req.params.code || '').trim().toUpperCase();
  const { rows } = await pool.query(
    `UPDATE redemptions SET used_at = NOW() WHERE id = (
       SELECT id FROM redemptions WHERE voucher_code = $1 AND used_at IS NULL
       ORDER BY redeemed_at DESC LIMIT 1) RETURNING id`, [code]);
  if (!rows.length) throw fail(409, 'Voucher not found or already used.');
  res.json({ ok: true });
}));

app.get('/admin/api/items', requireAdmin, wrap(async (req, res) => {
  res.json((await pool.query('SELECT * FROM items ORDER BY item_id')).rows);
}));

app.post('/admin/api/items', requireAdmin, wrap(async (req, res) => {
  const { name, voucher_code, points_required, image_url } = req.body;
  if (!name || !voucher_code || !(points_required >= 0)) throw fail(400, 'Fill in name, voucher code and points.');
  res.json((await pool.query(
    'INSERT INTO items (name, voucher_code, points_required, image_url) VALUES ($1, $2, $3, $4) RETURNING *',
    [name, voucher_code, points_required, image_url || null])).rows[0]);
}));

app.put('/admin/api/items/:id', requireAdmin, wrap(async (req, res) => {
  const { name, voucher_code, points_required, image_url } = req.body;
  if (!name || !voucher_code || !(points_required >= 0)) throw fail(400, 'Fill in name, voucher code and points.');
  await pool.query('UPDATE items SET name = $1, voucher_code = $2, points_required = $3, image_url = $4 WHERE item_id = $5',
    [name, voucher_code, points_required, image_url || null, req.params.id]);
  res.json({ ok: true });
}));

app.delete('/admin/api/items/:id', requireAdmin, wrap(async (req, res) => {
  await pool.query('DELETE FROM items WHERE item_id = $1', [req.params.id]);
  res.json({ ok: true });
}));

// Link an RFID card UID to a user (empty value unlinks)
app.put('/admin/api/users/:id/card', requireAdmin, wrap(async (req, res) => {
  const uid = normUid(req.body.card_uid) || null;
  try {
    const r = await pool.query('UPDATE users SET card_uid = $1 WHERE user_id = $2', [uid, req.params.id]);
    if (!r.rowCount) throw fail(404, 'User not found.');
  } catch (e) {
    if (e.code === '23505') throw fail(409, 'That card is already linked to another user.');
    throw e;
  }
  res.json({ ok: true });
}));

// Add (or subtract, with a negative number) points for a user
app.post('/admin/api/users/:id/points', requireAdmin, wrap(async (req, res) => {
  const amount = parseInt(req.body.amount, 10);
  if (!Number.isInteger(amount)) throw fail(400, 'Enter a whole number.');
  const { rows } = await pool.query(
    'UPDATE users SET points = GREATEST(points + $1, 0) WHERE user_id = $2 RETURNING points', [amount, req.params.id]);
  if (!rows.length) throw fail(404, 'User not found.');
  res.json(rows[0]);
}));

init()
  .then(() => app.listen(process.env.PORT || 3000, () => console.log('Server running')))
  .catch(e => { console.error('Database setup failed:', e.message); process.exit(1); });
