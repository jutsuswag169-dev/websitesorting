// EcoPoints server: serves the website (public/) + API for the website and the ESP32
const express = require("express");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const API_KEY = process.env.API_KEY || "change-me";          // same value goes in the ESP32 code
const DATA_FILE = process.env.DATA_FILE || path.join(__dirname, "data.json");
const PER_ITEM = 2;
const LABEL = { plastic_bottle: "Plastic bottle", aluminum_can: "Aluminum can", crumpled_paper: "Crumpled paper" };
const REWARDS = { tea: { n: "Free iced tea", cost: 10 }, snack: { n: "Snack voucher", cost: 20 },
                  supply: { n: "School supply set", cost: 30 }, meal: { n: "Meal discount coupon", cost: 50 } };

let db = { users: {} };
try { db = JSON.parse(fs.readFileSync(DATA_FILE, "utf8")); } catch (e) {}
const save = () => { try { fs.writeFileSync(DATA_FILE, JSON.stringify(db)); } catch (e) { console.error("save failed:", e.message); } };

const hash = (pin, salt) => crypto.scryptSync(String(pin), salt, 32).toString("hex");
const pub = u => ({ name: u.name, points: u.points, counts: u.counts, history: u.history.slice(-40) });
const norm = s => String(s || "").trim().toUpperCase();
const fails = {};   // simple brute-force guard: 5 wrong PINs = 10 minute lock

function auth(uid, pin) {
  uid = norm(uid);
  const f = fails[uid];
  if (f && f.n >= 5 && Date.now() - f.t < 600000) return { error: "Too many attempts. Try again in 10 minutes." };
  const u = db.users[uid];
  if (!u) return { error: "No account found for that card.", unknown: true };
  const a = Buffer.from(hash(pin, u.salt), "hex"), b = Buffer.from(u.hash, "hex");
  if (!crypto.timingSafeEqual(a, b)) {
    fails[uid] = { n: (f ? f.n : 0) + 1, t: Date.now() };
    return { error: "Wrong PIN." };
  }
  delete fails[uid];
  return { user: u };
}

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

// ---- ESP32 endpoints (protected by the API key; the server decides the points) ----
const needKey = (req, res, next) => req.get("x-api-key") === API_KEY ? next() : res.status(401).json({ error: "bad key" });

app.post("/login", needKey, (req, res) => {
  const u = db.users[norm(req.body.uid)];
  u ? res.json({ ok: true, name: u.name }) : res.status(404).json({ error: "unknown card" });
});

app.post("/points", needKey, (req, res) => {
  const u = db.users[norm(req.body.uid)], t = req.body.item;
  if (!u || !LABEL[t]) return res.status(400).json({ error: "bad request" });
  u.points += PER_ITEM;
  u.counts[t] = (u.counts[t] || 0) + 1;
  u.history.push({ ts: Date.now(), label: LABEL[t] + " deposited", pts: PER_ITEM });
  save();
  res.json({ ok: true, points: u.points });
});

// ---- Website endpoints ----
app.post("/api/register", (req, res) => {
  const uid = norm(req.body.uid), name = String(req.body.name || "").trim().slice(0, 40), pin = String(req.body.pin || "");
  if (!/^[A-Z0-9]{4,20}$/.test(uid)) return res.status(400).json({ error: "Card ID must be 4 to 20 letters or numbers." });
  if (!name) return res.status(400).json({ error: "Please enter your name." });
  if (!/^\d{4,8}$/.test(pin)) return res.status(400).json({ error: "PIN must be 4 to 8 digits." });
  if (db.users[uid]) return res.status(409).json({ error: "That card is already registered." });
  const salt = crypto.randomBytes(16).toString("hex");
  db.users[uid] = { name, salt, hash: hash(pin, salt), points: 0,
                    counts: { plastic_bottle: 0, aluminum_can: 0, crumpled_paper: 0 }, history: [] };
  save();
  res.json({ user: pub(db.users[uid]) });
});

app.post("/api/login", (req, res) => {
  const r = auth(req.body.uid, req.body.pin);
  r.error ? res.status(r.unknown ? 404 : 401).json(r) : res.json({ user: pub(r.user) });
});

app.post("/api/redeem", (req, res) => {
  const r = auth(req.body.uid, req.body.pin);
  if (r.error) return res.status(401).json(r);
  const rw = REWARDS[req.body.reward], u = r.user;
  if (!rw) return res.status(400).json({ error: "Unknown reward." });
  if (u.points < rw.cost) return res.status(400).json({ error: "Not enough points." });
  const code = "RVM-" + crypto.randomBytes(3).toString("hex").toUpperCase();
  u.points -= rw.cost;
  u.history.push({ ts: Date.now(), label: "Redeemed " + rw.n + " (" + code + ")", pts: -rw.cost });
  save();
  res.json({ code, user: pub(u) });
});

app.listen(process.env.PORT || 3000, () => console.log("EcoPoints server running"));
