/* School Classes & Afterschool Programs Scheduler — API + static server
 * Express + SQLite (better-sqlite3). Single process, deployable on Render (Docker).
 * NOTE: On Render's free tier the disk is ephemeral — data resets on each deploy.
 * Set DB_PATH to a persistent disk mount (or ask Claude to wire up Postgres) for production.
 */
const express = require('express');
const Database = require('better-sqlite3');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const cookieParser = require('cookie-parser');
const path = require('path');
const fs = require('fs');

const PORT = process.env.PORT || 10000;
const SECRET = process.env.JWT_SECRET || 'dev-secret-change-me';
const DB_PATH = process.env.DB_PATH || path.join(__dirname, 'data', 'app.db');
fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');

/* ---------------- schema ---------------- */
db.exec(`
CREATE TABLE IF NOT EXISTS schools(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL, subtitle TEXT DEFAULT '', plan TEXT DEFAULT 'free'
);
CREATE TABLE IF NOT EXISTS settings(
  school_id INTEGER PRIMARY KEY,
  window_days INTEGER DEFAULT 14,
  threshold INTEGER DEFAULT 80,
  limitation TEXT DEFAULT 'waitlist_only',
  autopromote INTEGER DEFAULT 1
);
CREATE TABLE IF NOT EXISTS users(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  school_id INTEGER NOT NULL,
  role TEXT NOT NULL CHECK(role IN ('student','teacher','admin')),
  name TEXT NOT NULL, email TEXT NOT NULL UNIQUE, pass_hash TEXT NOT NULL,
  grade TEXT DEFAULT '', student_id TEXT DEFAULT '', id_photo TEXT DEFAULT '',
  status TEXT DEFAULT 'pending' CHECK(status IN ('pending','approved','rejected')),
  created TEXT DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS programs(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  school_id INTEGER NOT NULL,
  name TEXT NOT NULL,
  type TEXT NOT NULL CHECK(type IN ('class','afterschool')),
  teacher_id INTEGER,
  room TEXT DEFAULT '', capacity INTEGER DEFAULT 20,
  days TEXT NOT NULL,            -- comma list of weekday numbers 0=Sun..6=Sat
  time_start TEXT NOT NULL,      -- "15:30"
  time_end TEXT NOT NULL,        -- "16:30"
  date_start TEXT NOT NULL,      -- "2026-08-10"
  date_end TEXT NOT NULL,
  emoji TEXT DEFAULT '📚'
);
CREATE TABLE IF NOT EXISTS reservations(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  program_id INTEGER NOT NULL,
  student_id INTEGER NOT NULL,
  date TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('reserved','waitlist','cancelled')),
  attended INTEGER,              -- NULL=not marked, 1=present, 0=no-show
  created TEXT DEFAULT (datetime('now')),
  UNIQUE(program_id, student_id, date)
);
CREATE TABLE IF NOT EXISTS photos(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  school_id INTEGER NOT NULL,
  caption TEXT DEFAULT '', data TEXT NOT NULL
);
`);
try { db.exec("ALTER TABLE users ADD COLUMN student_id TEXT DEFAULT ''"); } catch (_) { /* column exists */ }
try { db.exec("ALTER TABLE users ADD COLUMN id_photo TEXT DEFAULT ''"); } catch (_) { /* column exists */ }
try { db.exec("ALTER TABLE schools ADD COLUMN plan TEXT DEFAULT 'free'"); } catch (_) { /* column exists */ }
try { db.exec("ALTER TABLE schools ADD COLUMN stripe_sub TEXT DEFAULT ''"); } catch (_) { /* column exists */ }
try { db.exec("ALTER TABLE schools ADD COLUMN plan_expires TEXT DEFAULT ''"); } catch (_) { /* column exists */ }
try { db.exec("ALTER TABLE schools ADD COLUMN slug TEXT DEFAULT ''"); } catch (_) { /* column exists */ }
try { db.exec("ALTER TABLE schools ADD COLUMN created TEXT DEFAULT ''"); } catch (_) { /* column exists */ }
db.exec(`CREATE TABLE IF NOT EXISTS support_messages(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  school_id INTEGER, user_id INTEGER, message TEXT NOT NULL,
  status TEXT DEFAULT 'open', created TEXT DEFAULT (datetime('now'))
);`);
db.exec("UPDATE schools SET created=datetime('now') WHERE created=''");

const RESERVED_SLUGS = ['owner', 'office', 'admin', 'api', 'mockup', 'demo-x', 'login', 'signup', 'static', 'assets'];
function slugify(name) {
  let base = String(name).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'school';
  if (RESERVED_SLUGS.includes(base)) base += '-school';
  let slug = base, n = 2;
  while (db.prepare('SELECT 1 x FROM schools WHERE slug=?').get(slug)) slug = base + '-' + (n++);
  return slug;
}
/* backfill slugs for schools created before multi-tenancy */
db.prepare("SELECT id,name FROM schools WHERE slug=''").all()
  .forEach(s => db.prepare('UPDATE schools SET slug=? WHERE id=?').run(slugify(s.name), s.id));
db.exec(`CREATE TABLE IF NOT EXISTS redeemed_codes(
  code TEXT PRIMARY KEY, school_id INTEGER, redeemed TEXT DEFAULT (datetime('now'))
);`);

/* ---------------- plans ---------------- */
const FREE_LIMITS = { programs: 3, teachers: 3, students: 10 };
const UPGRADE_CODE = process.env.UPGRADE_CODE || 'SCHOOL-PRO-2026';
const CODE_SECRET = process.env.CODE_SECRET || 'scheduler-trial-secret';
const OWNER_EMAIL = process.env.OWNER_EMAIL || 'owner@demo.school';
const OWNER_PASSWORD = process.env.OWNER_PASSWORD || 'owner123';
const ALERT_WEBHOOK = process.env.ALERT_WEBHOOK_URL || '';
const RESEND_KEY = process.env.RESEND_API_KEY || '';
const EMAIL_FROM = process.env.EMAIL_FROM || '';
const GMAIL_USER = process.env.GMAIL_USER || process.env.EMAIL_USER || '';
const GMAIL_APP_PASSWORD = process.env.GMAIL_APP_PASSWORD || process.env.EMAIL_PASSWORD || '';
const emailEnabled = () => !!(GMAIL_USER && GMAIL_APP_PASSWORD) || !!(RESEND_KEY && EMAIL_FROM);
let mailer = null;
if (GMAIL_USER && GMAIL_APP_PASSWORD) {
  try {
    mailer = require('nodemailer').createTransport({
      service: 'gmail', auth: { user: GMAIL_USER, pass: GMAIL_APP_PASSWORD },
    });
  } catch (e) { console.error('gmail init failed:', e.message); }
}
async function sendEmail(to, subject, html) {
  if (mailer) {
    await mailer.sendMail({ from: `"School Scheduler" <${GMAIL_USER}>`, to, subject, html });
    return;
  }
  const r = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + RESEND_KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify({ from: EMAIL_FROM, to, subject, html }),
  });
  if (!r.ok) throw new Error('email send failed: ' + (await r.text()).slice(0, 200));
}
function appBase(req) {
  const configured = (process.env.APP_URL || '').replace(/\/+$/, '');
  if (configured) return configured;
  const host = req && req.get ? req.get('host') : '';
  return (host ? 'https://' + host : '');
}
function userLink(req, user, query) {
  const school = user && user.school_id ? q.school.get(user.school_id) : null;
  const path = school && school.slug && user.role !== 'admin' ? '/' + school.slug : '/';
  return appBase(req) + path + query;
}
function tempPassword() {
  const CH = 'abcdefghjkmnpqrstuvwxyz23456789';
  let s = '';
  require('crypto').randomBytes(10).forEach(b => s += CH[b % CH.length]);
  return s;
}
function notify(text) {
  if (!ALERT_WEBHOOK) return;
  fetch(ALERT_WEBHOOK, { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text, content: text }) }).catch(() => {});
}
const crypto = require('crypto');
function trialSig(days, nonce) {
  return crypto.createHmac('sha256', CODE_SECRET).update(days + '|' + nonce.toUpperCase())
    .digest('hex').slice(0, 6).toUpperCase();
}
function planUsage(schoolId) {
  const row = db.prepare('SELECT plan, plan_expires FROM schools WHERE id=?').get(schoolId) || {};
  let plan = row.plan || 'free';
  if (plan === 'pro' && row.plan_expires && row.plan_expires < todayISO()) {
    db.prepare("UPDATE schools SET plan='free', plan_expires='' WHERE id=?").run(schoolId);
    plan = 'free';
  }
  return {
    plan, plan_expires: plan === 'pro' ? (row.plan_expires || '') : '',
    limits: plan === 'free' ? FREE_LIMITS : null,
    programs: db.prepare('SELECT COUNT(*) c FROM programs WHERE school_id=?').get(schoolId).c,
    teachers: db.prepare("SELECT COUNT(*) c FROM users WHERE school_id=? AND role='teacher' AND status='approved'").get(schoolId).c,
    students: db.prepare("SELECT COUNT(*) c FROM users WHERE school_id=? AND role='student' AND status='approved'").get(schoolId).c,
  };
}
function planBlocked(schoolId, kind, verb) {
  const u = planUsage(schoolId);
  if (u.plan !== 'free') return null;
  const v = verb || 'add';
  if (kind === 'programs' && u.programs >= FREE_LIMITS.programs)
    return `Free plan limit reached (${FREE_LIMITS.programs} classes/programs). Upgrade to ${v} more.`;
  if (kind === 'teachers' && u.teachers >= FREE_LIMITS.teachers)
    return `Free plan limit reached (${FREE_LIMITS.teachers} teachers). Upgrade to ${v} more.`;
  if (kind === 'students' && u.students >= FREE_LIMITS.students)
    return `Free plan limit reached (${FREE_LIMITS.students} students). Upgrade to ${v} more.`;
  return null;
}

/* ---------------- seed (only when empty) ---------------- */
if (!db.prepare('SELECT COUNT(*) c FROM schools').get().c) {
  const s = db.prepare("INSERT INTO schools(name,subtitle,slug) VALUES(?,?,?)")
    .run('Demo Elementary', 'Try the scheduler here — demo school', 'demo');
  const sid = s.lastInsertRowid;
  db.prepare('INSERT INTO settings(school_id) VALUES(?)').run(sid);
  const hash = p => bcrypt.hashSync(p, 10);
  const admin = db.prepare("INSERT INTO users(school_id,role,name,email,pass_hash,status) VALUES(?,?,?,?,?,?)")
    .run(sid, 'admin', 'School Admin', 'admin@demo.school', hash('admin123'), 'approved');
  const teach = db.prepare("INSERT INTO users(school_id,role,name,email,pass_hash,status) VALUES(?,?,?,?,?,?)")
    .run(sid, 'teacher', 'Coach Rivera', 'rivera@demo.school', hash('teach123'), 'approved');
  db.prepare("INSERT INTO users(school_id,role,name,email,pass_hash,grade,student_id,status) VALUES(?,?,?,?,?,?,?,?)")
    .run(sid, 'student', 'Maya Torres', 'maya@demo.school', hash('learn123'), '5', 'S-1001', 'approved');
  const today = new Date(); const iso = d => d.toISOString().slice(0, 10);
  const start = new Date(today); start.setDate(start.getDate() - 14);
  const end = new Date(today); end.setDate(end.getDate() + 90);
  const P = db.prepare("INSERT INTO programs(school_id,name,type,teacher_id,room,capacity,days,time_start,time_end,date_start,date_end,emoji) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)");
  P.run(sid, 'Chess Club', 'afterschool', teach.lastInsertRowid, 'Rm 104', 16, '1,3', '15:30', '16:30', iso(start), iso(end), '♟️');
  P.run(sid, 'Track & Field', 'afterschool', teach.lastInsertRowid, 'Field', 24, '2,4', '15:30', '17:00', iso(start), iso(end), '🏃');
  P.run(sid, 'Robotics Lab', 'class', teach.lastInsertRowid, 'STEM Lab', 3, '3', '15:30', '17:00', iso(start), iso(end), '🤖');
}

/* ---------------- stripe (optional — enabled when env keys are set) ---------------- */
const STRIPE_KEY = process.env.STRIPE_SECRET_KEY || '';
const STRIPE_PRICE = process.env.STRIPE_PRICE_ID || '';
const STRIPE_WH = process.env.STRIPE_WEBHOOK_SECRET || '';
let stripe = null;
if (STRIPE_KEY) { try { stripe = require('stripe')(STRIPE_KEY); } catch (e) { console.error('stripe init failed:', e.message); } }

/* ---------------- helpers ---------------- */
const app = express();
app.set('trust proxy', 1);   // Render terminates TLS — without this, emailed links come out as http://

/* Stripe webhook needs the RAW body, so register it before the JSON parser */
app.post('/api/stripe/webhook', express.raw({ type: 'application/json' }), (req, res) => {
  if (!stripe || !STRIPE_WH) return res.status(400).end();
  let event;
  try { event = stripe.webhooks.constructEvent(req.body, req.headers['stripe-signature'], STRIPE_WH); }
  catch (err) { return res.status(400).send(`Webhook error: ${err.message}`); }
  if (event.type === 'checkout.session.completed') {
    const s = event.data.object;
    const schoolId = Number(s.metadata && s.metadata.school_id);
    if (schoolId) {
      db.prepare("UPDATE schools SET plan='pro', stripe_sub=?, plan_expires='' WHERE id=?")
        .run(s.subscription || '', schoolId);
      const sch = db.prepare('SELECT name FROM schools WHERE id=?').get(schoolId);
      notify(`💳 New subscription: ${sch ? sch.name : 'school #' + schoolId} is now on Unlimited!`);
    }
  }
  if (event.type === 'customer.subscription.deleted') {
    const sub = event.data.object;
    db.prepare("UPDATE schools SET plan='free', stripe_sub='' WHERE stripe_sub=?").run(sub.id);
  }
  res.json({ received: true });
});

app.use(express.json({ limit: '8mb' }));
app.use(cookieParser());

const todayISO = () => new Date().toISOString().slice(0, 10);
const q = {
  user: db.prepare('SELECT * FROM users WHERE id=?'),
  userByEmail: db.prepare('SELECT * FROM users WHERE lower(email)=lower(?)'),
  school: db.prepare('SELECT * FROM schools WHERE id=?'),
  settings: db.prepare('SELECT * FROM settings WHERE school_id=?'),
  program: db.prepare('SELECT * FROM programs WHERE id=?'),
  reservedCount: db.prepare("SELECT COUNT(*) c FROM reservations WHERE program_id=? AND date=? AND status='reserved'"),
  waitCount: db.prepare("SELECT COUNT(*) c FROM reservations WHERE program_id=? AND date=? AND status='waitlist'"),
  myRes: db.prepare("SELECT * FROM reservations WHERE student_id=? AND date=? AND status IN ('reserved','waitlist')"),
};

function ownerAuth(req, res, next) {
  try {
    const p = jwt.verify(req.cookies.tok, SECRET);
    if (!p.owner) throw 0;
    next();
  } catch { res.status(401).json({ error: 'Owner login required.' }); }
}

function auth(roles) {
  return (req, res, next) => {
    try {
      const tok = req.cookies.tok;
      const { uid } = jwt.verify(tok, SECRET);
      const u = q.user.get(uid);
      if (!u) throw 0;
      if (roles && !roles.includes(u.role)) return res.status(403).json({ error: 'Not allowed for your role.' });
      req.user = u; next();
    } catch { res.status(401).json({ error: 'Please log in.' }); }
  };
}
const approvedOnly = (req, res, next) =>
  req.user.status === 'approved' ? next() : res.status(403).json({ error: 'Account pending admin approval.' });

function programDates(p, from, to) {
  const days = p.days.split(',').map(Number);
  const out = [];
  const d = new Date(Math.max(new Date(from), new Date(p.date_start)));
  const stop = new Date(Math.min(new Date(to), new Date(p.date_end)));
  for (; d <= stop; d.setDate(d.getDate() + 1)) {
    if (days.includes(d.getDay())) out.push(d.toISOString().slice(0, 10));
  }
  return out;
}
const overlaps = (a1, a2, b1, b2) => a1 < b2 && b1 < a2;

function attendanceStats(studentId) {
  const rows = db.prepare(
    "SELECT attended FROM reservations WHERE student_id=? AND status='reserved' AND date<? ").all(studentId, todayISO());
  const marked = rows.filter(r => r.attended !== null);
  const present = marked.filter(r => r.attended === 1).length;
  const pct = marked.length ? Math.round(100 * present / marked.length) : 100;
  return { pct, attended: present, missed: marked.length - present };
}

/* ---------------- public ---------------- */
app.post('/api/register-school', (req, res) => {
  const { school_name, subtitle, admin_name, admin_email, admin_password } = req.body || {};
  if (!school_name || !admin_name || !admin_email || !admin_password)
    return res.status(400).json({ error: 'School name, your name, email, and password are all required.' });
  if (q.userByEmail.get(admin_email))
    return res.status(409).json({ error: 'That email already has an account. Log in instead.' });
  const slug = slugify(school_name);
  const s = db.prepare("INSERT INTO schools(name,subtitle,slug,created) VALUES(?,?,?,datetime('now'))")
    .run(school_name.trim(), (subtitle || '').trim(), slug);
  db.prepare('INSERT INTO settings(school_id) VALUES(?)').run(s.lastInsertRowid);
  const a = db.prepare("INSERT INTO users(school_id,role,name,email,pass_hash,status) VALUES(?,?,?,?,?,'approved')")
    .run(s.lastInsertRowid, 'admin', admin_name.trim(), admin_email.trim(), bcrypt.hashSync(admin_password, 10));
  res.cookie('tok', jwt.sign({ uid: a.lastInsertRowid }, SECRET, { expiresIn: '30d' }),
    { httpOnly: true, sameSite: 'lax', maxAge: 30 * 864e5 });
  notify(`🏫 New school registered: ${school_name.trim()} (/${slug}) — admin ${admin_name.trim()} <${admin_email.trim()}>`);
  res.json({ ok: true, slug });
});

app.get('/api/slug/:slug', (req, res) => {
  const school = db.prepare('SELECT id,name,subtitle,slug FROM schools WHERE slug=?').get(req.params.slug.toLowerCase());
  if (!school) return res.status(404).json({ error: 'School not found' });
  const programs = db.prepare(
    `SELECT p.*, u.name teacher FROM programs p LEFT JOIN users u ON u.id=p.teacher_id WHERE p.school_id=? ORDER BY p.name`
  ).all(school.id);
  const photos = db.prepare('SELECT id,caption,data FROM photos WHERE school_id=?').all(school.id);
  res.json({ school, programs, photos });
});

app.get('/api/schools/:id/public', auth(), (req, res) => {
  if (Number(req.params.id) !== req.user.school_id) return res.status(403).json({ error: 'Not your school.' });
  const school = q.school.get(req.params.id);
  if (!school) return res.status(404).json({ error: 'School not found' });
  const programs = db.prepare(
    `SELECT p.*, u.name teacher FROM programs p LEFT JOIN users u ON u.id=p.teacher_id WHERE p.school_id=? ORDER BY p.name`
  ).all(school.id);
  const photos = db.prepare('SELECT id,caption,data FROM photos WHERE school_id=?').all(school.id);
  res.json({ school, programs, photos });
});

app.post('/api/signup', (req, res) => {
  const { school_id, role, name, email, password, grade, student_id, id_photo } = req.body || {};
  if (!school_id || !['student', 'teacher'].includes(role) || !name || !email || !password)
    return res.status(400).json({ error: 'Missing required fields.' });
  if (role === 'student' && !(student_id || '').trim())
    return res.status(400).json({ error: 'Student ID is required to sign up as a student.' });
  if (role === 'student') {
    if (!id_photo || !id_photo.startsWith('data:image'))
      return res.status(400).json({ error: 'A photo of your school ID is required to sign up as a student.' });
    if (id_photo.length > 4e6)
      return res.status(400).json({ error: 'ID photo is too large — please retake or choose a smaller image.' });
  }
  if (q.userByEmail.get(email)) return res.status(409).json({ error: 'That email already has an account.' });
  if (role === 'student' && db.prepare(
    "SELECT 1 x FROM users WHERE school_id=? AND role='student' AND student_id=? AND student_id<>''")
    .get(school_id, student_id.trim()))
    return res.status(409).json({ error: 'That Student ID is already registered at this school.' });
  db.prepare('INSERT INTO users(school_id,role,name,email,pass_hash,grade,student_id,id_photo) VALUES(?,?,?,?,?,?,?,?)')
    .run(school_id, role, name.trim(), email.trim(), bcrypt.hashSync(password, 10), grade || '',
      role === 'student' ? student_id.trim() : '', role === 'student' ? id_photo : '');
  res.json({ ok: true, message: 'Account created — an administrator must approve it before you can continue.' });
});

app.post('/api/login', (req, res) => {
  const { email, password } = req.body || {};
  const u = email && q.userByEmail.get(email);
  if (!u || !u.pass_hash || !bcrypt.compareSync(password || '', u.pass_hash))
    return res.status(401).json({ error: 'Wrong email or password.' });
  res.cookie('tok', jwt.sign({ uid: u.id }, SECRET, { expiresIn: '30d' }),
    { httpOnly: true, sameSite: 'lax', maxAge: 30 * 864e5 });
  res.json({ ok: true });
});
app.post('/api/logout', (_req, res) => { res.clearCookie('tok'); res.json({ ok: true }); });

/* ---------------- forgot / reset password ---------------- */
app.post('/api/forgot', async (req, res) => {
  const email = ((req.body || {}).email || '').trim();
  const u = email && q.userByEmail.get(email);
  if (u && emailEnabled()) {
    try {
      const token = jwt.sign({ reset: u.id }, SECRET, { expiresIn: '30m' });
      const link = userLink(req, u, '?reset=' + token);
      await sendEmail(u.email, 'Reset your School Scheduler password',
        `<p>Hi ${u.name},</p><p>Tap the link below to set a new password (valid 30 minutes):</p>
         <p><a href="${link}">Reset my password</a></p>
         <p style="color:#667;font-size:12px">If the button doesn't work, copy this address into your browser:<br>${link}</p>
         <p>If you didn't ask for this, you can ignore this email.</p>`);
      return res.json({ ok: true, sent: true, message: 'Check your email for a reset link (valid 30 minutes).' });
    } catch (e) { console.error(e); /* fall through to manual guidance */ }
  }
  if (u && !emailEnabled() && u.role === 'admin') {
    db.prepare('INSERT INTO support_messages(school_id,user_id,message) VALUES(?,?,?)')
      .run(u.school_id, u.id, `PASSWORD RESET REQUEST — admin ${u.name} <${u.email}> asked to reset their password.`);
    notify(`🔐 Password reset requested by admin ${u.name} <${u.email}>`);
  }
  /* generic response: no email-service configured, or unknown address (don't reveal which) */
  res.json({ ok: true, sent: false,
    message: 'Students & teachers: ask your school administrator to reset your password. ' +
             'School administrators: your reset request has been sent to support.' });
});

app.post('/api/reset', (req, res) => {
  const { token, password } = req.body || {};
  if (!password || password.length < 4) return res.status(400).json({ error: 'Pick a longer password.' });
  try {
    const p = jwt.verify(token, SECRET);
    if (!p.reset) throw 0;
    const u = q.user.get(p.reset);
    if (!u) throw 0;
    db.prepare('UPDATE users SET pass_hash=? WHERE id=?').run(bcrypt.hashSync(password, 10), u.id);
    /* sign them straight in — they just proved they own the mailbox */
    res.cookie('tok', jwt.sign({ uid: u.id }, SECRET, { expiresIn: '30d' }),
      { httpOnly: true, sameSite: 'lax', maxAge: 30 * 864e5 });
    const school = q.school.get(u.school_id);
    res.json({ ok: true, signedIn: true, role: u.role, name: u.name,
      slug: school ? school.slug : null,
      message: `Password saved — welcome, ${u.name}.` });
  } catch { res.status(400).json({ error: 'That reset link is invalid or expired. Request a new one.' }); }
});

app.get('/api/me', auth(), (req, res) => {
  const { pass_hash, ...u } = req.user;
  res.json({ ...u, school: q.school.get(u.school_id), settings: q.settings.get(u.school_id) });
});

/* ---------------- student ---------------- */
app.get('/api/student/calendar', auth(['student']), approvedOnly, (req, res) => {
  const st = q.settings.get(req.user.school_id);
  const from = req.query.from || todayISO();
  const dTo = new Date(from); dTo.setDate(dTo.getDate() + (Number(req.query.days) || st.window_days) - 1);
  const to = dTo.toISOString().slice(0, 10);
  const programs = db.prepare(
    `SELECT p.*, u.name teacher FROM programs p LEFT JOIN users u ON u.id=p.teacher_id WHERE p.school_id=?`
  ).all(req.user.school_id);
  const mine = db.prepare(
    "SELECT * FROM reservations WHERE student_id=? AND status IN ('reserved','waitlist')").all(req.user.id);
  const byKey = {}; mine.forEach(r => byKey[r.program_id + '|' + r.date] = r);
  const days = {};
  for (const p of programs)
    for (const date of programDates(p, from, to)) {
      const reserved = q.reservedCount.get(p.id, date).c;
      const r = byKey[p.id + '|' + date];
      (days[date] = days[date] || []).push({
        program_id: p.id, name: p.name, emoji: p.emoji, type: p.type, room: p.room,
        time_start: p.time_start, time_end: p.time_end, teacher: p.teacher,
        capacity: p.capacity, reserved, open: p.capacity - reserved,
        mine: r ? r.status : null, waitlist: q.waitCount.get(p.id, date).c,
      });
    }
  Object.values(days).forEach(a => a.sort((x, y) => x.time_start.localeCompare(y.time_start)));
  res.json({ from, to, days, stats: attendanceStats(req.user.id), settings: st });
});

app.post('/api/student/reserve', auth(['student']), approvedOnly, (req, res) => {
  const { program_id, date } = req.body || {};
  const p = q.program.get(program_id);
  if (!p || p.school_id !== req.user.school_id) return res.status(404).json({ error: 'Program not found.' });
  if (date < todayISO()) return res.status(400).json({ error: 'That date is in the past.' });
  const st = q.settings.get(req.user.school_id);
  const max = new Date(); max.setDate(max.getDate() + st.window_days - 1);
  if (date > max.toISOString().slice(0, 10))
    return res.status(400).json({ error: `You can only reserve within the next ${st.window_days} days.` });
  if (!programDates(p, date, date).length) return res.status(400).json({ error: 'Program does not meet that day.' });
  if (q.myRes.get(req.user.id, date) && db.prepare(
    "SELECT 1 x FROM reservations WHERE student_id=? AND program_id=? AND date=? AND status IN ('reserved','waitlist')")
    .get(req.user.id, program_id, date))
    return res.status(409).json({ error: 'You already have a spot or waitlist place for this session.' });

  // overlap guard against other reserved sessions that day
  const others = db.prepare(
    `SELECT r.*, p2.name, p2.time_start ts, p2.time_end te FROM reservations r JOIN programs p2 ON p2.id=r.program_id
     WHERE r.student_id=? AND r.date=? AND r.status='reserved' AND r.program_id<>?`).all(req.user.id, date, program_id);
  for (const o of others)
    if (overlaps(p.time_start, p.time_end, o.ts, o.te))
      return res.status(409).json({ error: `Schedule conflict: overlaps ${o.name} (${o.ts}–${o.te}). Cancel that first.` });

  const full = q.reservedCount.get(p.id, date).c >= p.capacity;
  const belowThreshold = attendanceStats(req.user.id).pct < st.threshold;
  if (!full && belowThreshold && st.limitation === 'waitlist_only')
    return res.status(403).json({ error: `Your attendance is below ${st.threshold}% — you can only join waitlists until it improves.` });

  const status = full ? 'waitlist' : 'reserved';
  db.prepare("INSERT OR REPLACE INTO reservations(program_id,student_id,date,status) VALUES(?,?,?,?)")
    .run(program_id, req.user.id, date, status);
  res.json({ ok: true, status, position: full ? q.waitCount.get(p.id, date).c : null });
});

app.post('/api/student/cancel', auth(['student']), approvedOnly, (req, res) => {
  const { program_id, date } = req.body || {};
  const r = db.prepare(
    "SELECT * FROM reservations WHERE student_id=? AND program_id=? AND date=? AND status IN ('reserved','waitlist')")
    .get(req.user.id, program_id, date);
  if (!r) return res.status(404).json({ error: 'No reservation found.' });
  db.prepare("UPDATE reservations SET status='cancelled' WHERE id=?").run(r.id);
  let promoted = null;
  const st = q.settings.get(req.user.school_id);
  if (r.status === 'reserved' && st.autopromote) {
    const next = db.prepare(
      "SELECT * FROM reservations WHERE program_id=? AND date=? AND status='waitlist' ORDER BY created LIMIT 1")
      .get(program_id, date);
    if (next) {
      db.prepare("UPDATE reservations SET status='reserved' WHERE id=?").run(next.id);
      promoted = q.user.get(next.student_id).name;
    }
  }
  res.json({ ok: true, promoted });
});

app.get('/api/student/history', auth(['student']), approvedOnly, (req, res) => {
  const rows = db.prepare(
    `SELECT r.date, r.attended, p.name, p.emoji, p.time_start, p.time_end FROM reservations r
     JOIN programs p ON p.id=r.program_id
     WHERE r.student_id=? AND r.status='reserved' AND r.date<? ORDER BY r.date DESC LIMIT 60`)
    .all(req.user.id, todayISO());
  res.json({ history: rows, stats: attendanceStats(req.user.id) });
});

/* ---------------- teacher ---------------- */
app.get('/api/teacher/calendar', auth(['teacher']), approvedOnly, (req, res) => {
  const from = req.query.from || todayISO();
  const dTo = new Date(from); dTo.setDate(dTo.getDate() + 13);
  const to = dTo.toISOString().slice(0, 10);
  const programs = db.prepare('SELECT * FROM programs WHERE teacher_id=?').all(req.user.id);
  const days = {};
  for (const p of programs)
    for (const date of programDates(p, from, to)) {
      const reserved = q.reservedCount.get(p.id, date).c;
      const marked = db.prepare(
        "SELECT COUNT(*) c FROM reservations WHERE program_id=? AND date=? AND status='reserved' AND attended IS NOT NULL")
        .get(p.id, date).c;
      (days[date] = days[date] || []).push({
        program_id: p.id, name: p.name, emoji: p.emoji, room: p.room,
        time_start: p.time_start, time_end: p.time_end, capacity: p.capacity,
        reserved, waitlist: q.waitCount.get(p.id, date).c, attendanceDone: marked > 0 && marked >= reserved,
      });
    }
  Object.values(days).forEach(a => a.sort((x, y) => x.time_start.localeCompare(y.time_start)));
  res.json({ from, to, days, programs: programs.map(p => p.name) });
});

app.get('/api/teacher/roster', auth(['teacher', 'admin']), approvedOnly, (req, res) => {
  const { program_id, date } = req.query;
  const p = q.program.get(program_id);
  if (!p) return res.status(404).json({ error: 'Program not found.' });
  if (req.user.role === 'teacher' && p.teacher_id !== req.user.id)
    return res.status(403).json({ error: 'Not your program.' });
  const roster = db.prepare(
    `SELECT r.id res_id, r.status, r.attended, u.id student_id, u.name, u.grade, u.student_id id_number FROM reservations r
     JOIN users u ON u.id=r.student_id WHERE r.program_id=? AND r.date=? AND r.status IN ('reserved','waitlist')
     ORDER BY r.status DESC, r.created`).all(program_id, date);
  roster.forEach(r => r.attendance_pct = attendanceStats(r.student_id).pct);
  res.json({ program: p.name, capacity: p.capacity, date, roster });
});

app.post('/api/teacher/attendance', auth(['teacher']), approvedOnly, (req, res) => {
  const { program_id, date, records } = req.body || {};
  const p = q.program.get(program_id);
  if (!p || p.teacher_id !== req.user.id) return res.status(403).json({ error: 'Not your program.' });
  if (!Array.isArray(records) || !records.length) return res.status(400).json({ error: 'No records.' });
  const upd = db.prepare(
    "UPDATE reservations SET attended=? WHERE program_id=? AND student_id=? AND date=? AND status='reserved'");
  const tx = db.transaction(() => records.forEach(r => upd.run(r.present ? 1 : 0, program_id, r.student_id, date)));
  tx();
  res.json({ ok: true, saved: records.length });
});

/* ---------------- admin ---------------- */
const adm = [auth(['admin']), approvedOnly];

app.get('/api/admin/billing', ...adm, (_req, res) => {
  res.json({ stripeEnabled: !!(stripe && STRIPE_PRICE) });
});

app.post('/api/admin/checkout', ...adm, async (req, res) => {
  if (!stripe || !STRIPE_PRICE) return res.status(400).json({ error: 'Card payments are not set up — use an upgrade code instead.' });
  try {
    const base = process.env.APP_URL || `${req.protocol}://${req.get('host')}`;
    const session = await stripe.checkout.sessions.create({
      mode: 'subscription',
      line_items: [{ price: STRIPE_PRICE, quantity: 1 }],
      success_url: base + '/?upgraded=1',
      cancel_url: base + '/',
      metadata: { school_id: String(req.user.school_id) },
    });
    res.json({ url: session.url });
  } catch (e) { console.error(e); res.status(500).json({ error: 'Could not start checkout: ' + e.message }); }
});

app.post('/api/admin/upgrade', ...adm, (req, res) => {
  const code = ((req.body || {}).code || '').trim().toUpperCase();
  // permanent code
  if (code === UPGRADE_CODE.toUpperCase()) {
    db.prepare("UPDATE schools SET plan='pro', plan_expires='' WHERE id=?").run(req.user.school_id);
    return res.json({ ok: true, message: 'Upgraded! Unlimited classes, teachers, and students are now enabled.' });
  }
  // signed trial code: PRO-<days>D-<nonce>-<sig>
  const m = code.match(/^PRO-(\d{1,4})D-([A-Z0-9]{4,12})-([A-F0-9]{6})$/);
  if (m) {
    const [, days, nonce, sig] = m;
    if (trialSig(days, nonce) !== sig)
      return res.status(400).json({ error: 'That upgrade code is not valid. Contact support to purchase a subscription.' });
    if (db.prepare('SELECT 1 x FROM redeemed_codes WHERE code=?').get(code))
      return res.status(400).json({ error: 'That code has already been used.' });
    const exp = new Date(); exp.setDate(exp.getDate() + Number(days));
    const expISO = exp.toISOString().slice(0, 10);
    db.prepare('INSERT INTO redeemed_codes(code,school_id) VALUES(?,?)').run(code, req.user.school_id);
    db.prepare("UPDATE schools SET plan='pro', plan_expires=? WHERE id=?").run(expISO, req.user.school_id);
    return res.json({ ok: true, message: `Unlimited unlocked for ${days} days — active until ${expISO}. After that, the school returns to the free plan automatically.` });
  }
  res.status(400).json({ error: 'That upgrade code is not valid. Contact support to purchase a subscription.' });
});

app.get('/api/admin/overview', ...adm, (req, res) => {
  const sid = req.user.school_id;
  const pending = db.prepare("SELECT COUNT(*) c FROM users WHERE school_id=? AND status='pending'").get(sid).c;
  const reservations = db.prepare(
    `SELECT COUNT(*) c FROM reservations r JOIN programs p ON p.id=r.program_id
     WHERE p.school_id=? AND r.status='reserved' AND r.date>=?`).get(sid, todayISO()).c;
  const att = db.prepare(
    `SELECT AVG(r.attended)*100 a FROM reservations r JOIN programs p ON p.id=r.program_id
     WHERE p.school_id=? AND r.attended IS NOT NULL`).get(sid).a;
  res.json({ pending, reservations, attendance: att === null ? null : Math.round(att), usage: planUsage(sid) });
});

app.get('/api/admin/pending', ...adm, (req, res) => {
  res.json(db.prepare(
    "SELECT id,role,name,email,grade,student_id,id_photo,created FROM users WHERE school_id=? AND status='pending' ORDER BY created")
    .all(req.user.school_id));
});
app.post('/api/admin/approve', ...adm, (req, res) => {
  const { user_id, approve } = req.body || {};
  const u = q.user.get(user_id);
  if (!u || u.school_id !== req.user.school_id) return res.status(404).json({ error: 'User not found.' });
  if (approve) {
    const block = planBlocked(req.user.school_id, u.role === 'teacher' ? 'teachers' : 'students', 'approve');
    if (block) return res.status(403).json({ error: block, upgrade: true });
  }
  db.prepare('UPDATE users SET status=? WHERE id=?').run(approve ? 'approved' : 'rejected', user_id);
  res.json({ ok: true });
});

app.get('/api/admin/users', ...adm, (req, res) => {
  const rows = db.prepare(
    "SELECT id,role,name,email,grade,student_id,status FROM users WHERE school_id=? ORDER BY role,name").all(req.user.school_id);
  rows.filter(r => r.role === 'student').forEach(r => r.attendance_pct = attendanceStats(r.id).pct);
  res.json(rows);
});
app.put('/api/admin/users/:id', ...adm, (req, res) => {
  const u = q.user.get(req.params.id);
  if (!u || u.school_id !== req.user.school_id) return res.status(404).json({ error: 'User not found.' });
  const { name, grade, status } = req.body || {};
  if (status === 'approved' && u.status !== 'approved') {
    const block = planBlocked(req.user.school_id, u.role === 'teacher' ? 'teachers' : 'students');
    if (block) return res.status(403).json({ error: block, upgrade: true });
  }
  db.prepare('UPDATE users SET name=COALESCE(?,name), grade=COALESCE(?,grade), status=COALESCE(?,status) WHERE id=?')
    .run(name, grade, status, u.id);
  res.json({ ok: true });
});
/* ---------------- roster building: add one · import a list · invite ------- */
/* Admin-created people are pre-approved (the admin vouches for them) and have no
   password until they accept an invite or the admin hands them a temp one.      */
function createPerson(schoolId, role, row) {
  const name = String(row.name || '').trim();
  const email = String(row.email || '').trim();
  if (!name && !email) return { skipped: 'blank row' };
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return { skipped: `no valid email (${name || 'unnamed'})` };
  if (q.userByEmail.get(email)) return { skipped: `${email} already has an account` };
  const sid = String(row.student_id || '').trim();
  if (role === 'student' && sid && db.prepare(
    "SELECT 1 x FROM users WHERE school_id=? AND role='student' AND student_id=? AND student_id<>''").get(schoolId, sid))
    return { skipped: `Student ID ${sid} already registered` };
  const temp = tempPassword();
  const r = db.prepare(`INSERT INTO users(school_id,role,name,email,pass_hash,grade,student_id,status)
    VALUES(?,?,?,?,?,?,?, 'approved')`)
    .run(schoolId, role, name || email.split('@')[0], email, bcrypt.hashSync(temp, 10),
      String(row.grade || '').trim(), role === 'student' ? sid : '');
  return { id: r.lastInsertRowid, name: name || email.split('@')[0], email, temp };
}
let INVITE_REQ = null;   // set just before invites so links use the real host
async function sendInvite(user, schoolName, whoAdded) {
  const token = jwt.sign({ reset: user.id }, SECRET, { expiresIn: '14d' });
  const link = INVITE_REQ ? userLink(INVITE_REQ, user, '?reset=' + token)
    : (process.env.APP_URL || '') + '/?reset=' + token;
  await sendEmail(user.email, `You've been added to ${schoolName} on School Scheduler`,
    `<p>Hi ${user.name},</p>
     <p>${whoAdded} added you to <b>${schoolName}</b>${user.role === 'teacher' ? ' as a teacher' : ''}.</p>
     <p>Set your password and you're in — no approval needed:</p>
     <p><a href="${link}">Set my password</a></p>
     <p style="color:#667;font-size:12px">If the button doesn't work, copy this address into your browser:<br>${link}</p>
     <p style="color:#667">This link works for 14 days.</p>`);
}

app.post('/api/admin/people', ...adm, async (req, res) => {
  const b = req.body || {};
  const role = b.role === 'teacher' ? 'teacher' : 'student';
  const block = planBlocked(req.user.school_id, role === 'teacher' ? 'teachers' : 'students');
  if (block) return res.status(403).json({ error: block, upgrade: true });
  const made = createPerson(req.user.school_id, role, b);
  if (made.skipped) return res.status(409).json({ error: made.skipped });
  let invited = false, mailError = '';
  if (b.invite !== false && emailEnabled()) {
    try {
      INVITE_REQ = req;
      await sendInvite({ ...made, role, school_id: req.user.school_id }, q.school.get(req.user.school_id).name, req.user.name);
      invited = true;
    } catch (e) { mailError = e.message; }
  }
  res.json({ ok: true, person: { name: made.name, email: made.email }, invited, temp: invited ? null : made.temp, mailError });
});

/* Accepts either parsed rows or raw pasted/CSV text. Respects the plan limits and
   reports exactly what happened to every row.                                     */
app.post('/api/admin/people/bulk', ...adm, async (req, res) => {
  const b = req.body || {};
  const role = b.role === 'teacher' ? 'teacher' : 'student';
  let rows = Array.isArray(b.rows) ? b.rows : [];
  if (!rows.length && b.text) rows = parseRoster(String(b.text));
  if (!rows.length) return res.status(400).json({ error: 'Nothing to import — paste a list or choose a file.' });
  if (rows.length > 1000) return res.status(400).json({ error: 'That is over 1000 rows — split the file.' });

  const usage = planUsage(req.user.school_id);
  const cap = usage.limits ? (role === 'teacher' ? usage.limits.teachers - usage.teachers
    : usage.limits.students - usage.students) : Infinity;

  const added = [], skipped = [];
  let blockedByPlan = 0;
  for (const row of rows) {
    if (added.length >= cap) { blockedByPlan++; continue; }
    const made = createPerson(req.user.school_id, role, row);
    if (made.skipped) skipped.push(made.skipped); else added.push(made);
  }
  let invited = 0, mailError = '';
  if (b.invite !== false && emailEnabled() && added.length) {
    const school = q.school.get(req.user.school_id).name;
    for (const p of added) {
      try { INVITE_REQ = req; await sendInvite({ ...p, role, school_id: req.user.school_id }, school, req.user.name); invited++; }
      catch (e) { mailError = e.message; }
    }
  }
  res.json({
    ok: true, role, added: added.length, invited, skipped, blockedByPlan,
    /* temp passwords only matter when we could not email them */
    credentials: invited === added.length ? [] : added.map(p => ({ name: p.name, email: p.email, temp: p.temp })),
    mailError,
    limitNote: blockedByPlan ? `${blockedByPlan} not added — the free plan allows ${role === 'teacher' ? FREE_LIMITS.teachers + ' teachers' : FREE_LIMITS.students + ' students'}. Upgrade to add the rest.` : '',
  });
});

/* Server-side parser so a paste, a CSV file and a tab-separated spreadsheet copy
   all behave the same. Recognises common header spellings; falls back to
   "email only" or "name, email" when there is no header row.                     */
function parseRoster(text) {
  const lines = String(text).split(/\r?\n/).map(l => l.trim()).filter(Boolean);
  if (!lines.length) return [];
  const split = l => l.includes('\t') ? l.split('\t') : (l.match(/("[^"]*"|[^,]+)/g) || []).map(s => s.replace(/^"|"$/g, ''));
  const norm = s => String(s || '').trim().toLowerCase().replace(/[^a-z]/g, '');
  const HEAD = {
    name: ['name', 'fullname', 'studentname', 'teachername', 'student', 'firstlast'],
    email: ['email', 'emailaddress', 'mail', 'schoolemail'],
    grade: ['grade', 'gradelevel', 'year', 'yearlevel'],
    student_id: ['studentid', 'id', 'idnumber', 'sid', 'studentnumber'],
    first: ['first', 'firstname', 'givenname'],
    last: ['last', 'lastname', 'surname', 'familyname'],
  };
  const cells0 = split(lines[0]).map(norm);
  const mapIdx = {};
  let hasHeader = false;
  cells0.forEach((c, i) => {
    for (const key of Object.keys(HEAD)) if (HEAD[key].includes(c) && mapIdx[key] === undefined) { mapIdx[key] = i; hasHeader = true; }
  });
  const body = hasHeader ? lines.slice(1) : lines;
  return body.map(line => {
    const cells = split(line).map(s => String(s).trim());
    if (!hasHeader) {
      const email = cells.find(c => /@/.test(c)) || '';
      const rest = cells.filter(c => c !== email);
      return { name: rest.slice(0, 2).join(' ').trim(), email, grade: rest[2] || '', student_id: rest[3] || '' };
    }
    const get = k => (mapIdx[k] !== undefined ? cells[mapIdx[k]] || '' : '');
    let name = get('name');
    if (!name && (mapIdx.first !== undefined || mapIdx.last !== undefined))
      name = [get('first'), get('last')].filter(Boolean).join(' ');
    return { name, email: get('email'), grade: get('grade'), student_id: get('student_id') };
  }).filter(r => r.email || r.name);
}
/* Preview endpoint so the admin sees what will happen before anything is created */
app.post('/api/admin/people/preview', ...adm, (req, res) => {
  const rows = parseRoster(String((req.body || {}).text || ''));
  const seen = new Set();
  const marked = rows.map(r => {
    const problem = !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(r.email || '') ? 'no valid email'
      : q.userByEmail.get(r.email) ? 'already has an account'
        : seen.has(r.email.toLowerCase()) ? 'duplicate in this list' : '';
    if (r.email) seen.add(r.email.toLowerCase());
    return { ...r, problem };
  });
  res.json({ rows: marked, ok: marked.filter(r => !r.problem).length, problems: marked.filter(r => r.problem).length });
});

/* Remove people in bulk. Students lose their reservations; teachers are unassigned
   from their programs (the programs survive, just without a teacher).            */
app.post('/api/admin/people/remove', ...adm, (req, res) => {
  const ids = (req.body || {}).ids;
  if (!Array.isArray(ids) || !ids.length) return res.status(400).json({ error: 'Nobody selected.' });
  if (ids.length > 500) return res.status(400).json({ error: 'Too many at once — do it in batches of 500.' });
  const people = ids.map(id => q.user.get(id))
    .filter(u => u && u.school_id === req.user.school_id && u.role !== 'admin');
  if (!people.length) return res.status(400).json({ error: 'Nothing removable in that selection.' });

  let unassigned = 0, reservations = 0;
  const tx = db.transaction(() => {
    for (const u of people) {
      if (u.role === 'teacher') {
        unassigned += db.prepare('UPDATE programs SET teacher_id=NULL WHERE teacher_id=? AND school_id=?')
          .run(u.id, req.user.school_id).changes;
      } else {
        reservations += db.prepare('DELETE FROM reservations WHERE student_id=?').run(u.id).changes;
      }
      db.prepare('DELETE FROM users WHERE id=?').run(u.id);
    }
  });
  tx();
  const kind = people[0].role === 'teacher' ? 'teacher' : 'student';
  res.json({
    ok: true, removed: people.length, unassigned, reservations,
    message: `${people.length} ${kind}${people.length === 1 ? '' : 's'} removed` +
      (unassigned ? ` · ${unassigned} program${unassigned === 1 ? '' : 's'} left without a teacher` : '') +
      (reservations ? ` · ${reservations} reservation${reservations === 1 ? '' : 's'} deleted` : '') + '.',
  });
});

app.post('/api/admin/resetpw', ...adm, (req, res) => {
  const u = q.user.get((req.body || {}).user_id);
  if (!u || u.school_id !== req.user.school_id || u.role === 'admin')
    return res.status(400).json({ error: 'Cannot reset that account here.' });
  const temp = tempPassword();
  db.prepare('UPDATE users SET pass_hash=? WHERE id=?').run(bcrypt.hashSync(temp, 10), u.id);
  res.json({ ok: true, name: u.name, temp });
});

app.delete('/api/admin/users/:id', ...adm, (req, res) => {
  const u = q.user.get(req.params.id);
  if (!u || u.school_id !== req.user.school_id || u.role === 'admin')
    return res.status(400).json({ error: 'Cannot delete this user.' });
  db.prepare('DELETE FROM users WHERE id=?').run(u.id);
  if (u.role === 'teacher') db.prepare('UPDATE programs SET teacher_id=NULL WHERE teacher_id=?').run(u.id);
  else db.prepare('DELETE FROM reservations WHERE student_id=?').run(u.id);
  res.json({ ok: true });
});

app.get('/api/admin/programs', ...adm, (req, res) => {
  res.json(db.prepare(
    `SELECT p.*, u.name teacher FROM programs p LEFT JOIN users u ON u.id=p.teacher_id
     WHERE p.school_id=? ORDER BY p.name`).all(req.user.school_id));
});
app.post('/api/admin/programs', ...adm, (req, res) => {
  const block = planBlocked(req.user.school_id, 'programs');
  if (block) return res.status(403).json({ error: block, upgrade: true });
  const b = req.body || {};
  for (const k of ['name', 'type', 'days', 'time_start', 'time_end', 'date_start', 'date_end'])
    if (!b[k]) return res.status(400).json({ error: `Missing ${k}.` });
  const r = db.prepare(
    `INSERT INTO programs(school_id,name,type,teacher_id,room,capacity,days,time_start,time_end,date_start,date_end,emoji)
     VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`)
    .run(req.user.school_id, b.name, b.type, b.teacher_id || null, b.room || '', b.capacity || 20,
      b.days, b.time_start, b.time_end, b.date_start, b.date_end, b.emoji || '📚');
  res.json({ ok: true, id: r.lastInsertRowid });
});
app.put('/api/admin/programs/:id', ...adm, (req, res) => {
  const p = q.program.get(req.params.id);
  if (!p || p.school_id !== req.user.school_id) return res.status(404).json({ error: 'Program not found.' });
  const b = req.body || {};
  db.prepare(
    `UPDATE programs SET name=COALESCE(?,name), type=COALESCE(?,type), teacher_id=COALESCE(?,teacher_id),
     room=COALESCE(?,room), capacity=COALESCE(?,capacity), days=COALESCE(?,days),
     time_start=COALESCE(?,time_start), time_end=COALESCE(?,time_end),
     date_start=COALESCE(?,date_start), date_end=COALESCE(?,date_end), emoji=COALESCE(?,emoji) WHERE id=?`)
    .run(b.name, b.type, b.teacher_id, b.room, b.capacity, b.days, b.time_start, b.time_end,
      b.date_start, b.date_end, b.emoji, p.id);
  res.json({ ok: true });
});
app.delete('/api/admin/programs/:id', ...adm, (req, res) => {
  const p = q.program.get(req.params.id);
  if (!p || p.school_id !== req.user.school_id) return res.status(404).json({ error: 'Program not found.' });
  db.prepare('DELETE FROM programs WHERE id=?').run(p.id);
  db.prepare('DELETE FROM reservations WHERE program_id=?').run(p.id);
  res.json({ ok: true });
});

app.get('/api/admin/settings', ...adm, (req, res) => res.json(q.settings.get(req.user.school_id)));
app.put('/api/admin/settings', ...adm, (req, res) => {
  const b = req.body || {};
  db.prepare(
    `UPDATE settings SET window_days=COALESCE(?,window_days), threshold=COALESCE(?,threshold),
     limitation=COALESCE(?,limitation), autopromote=COALESCE(?,autopromote) WHERE school_id=?`)
    .run(b.window_days, b.threshold, b.limitation, b.autopromote, req.user.school_id);
  res.json({ ok: true });
});

app.put('/api/admin/school', ...adm, (req, res) => {
  const { name, subtitle } = req.body || {};
  db.prepare('UPDATE schools SET name=COALESCE(?,name), subtitle=COALESCE(?,subtitle) WHERE id=?')
    .run(name, subtitle, req.user.school_id);
  res.json({ ok: true });
});

app.post('/api/admin/photos', ...adm, (req, res) => {
  const { caption, data } = req.body || {};
  if (!data || !data.startsWith('data:image')) return res.status(400).json({ error: 'Send a data:image URL.' });
  if (data.length > 4e6) return res.status(400).json({ error: 'Image too large (max ~3MB).' });
  const r = db.prepare('INSERT INTO photos(school_id,caption,data) VALUES(?,?,?)')
    .run(req.user.school_id, caption || '', data);
  res.json({ ok: true, id: r.lastInsertRowid });
});
app.delete('/api/admin/photos/:id', ...adm, (req, res) => {
  db.prepare('DELETE FROM photos WHERE id=? AND school_id=?').run(req.params.id, req.user.school_id);
  res.json({ ok: true });
});

/* ---------------- support (school admins → owner) ---------------- */
app.post('/api/support', auth(['admin']), approvedOnly, (req, res) => {
  const msg = ((req.body || {}).message || '').trim();
  if (!msg) return res.status(400).json({ error: 'Write a message first.' });
  if (msg.length > 4000) return res.status(400).json({ error: 'Message too long.' });
  db.prepare('INSERT INTO support_messages(school_id,user_id,message) VALUES(?,?,?)')
    .run(req.user.school_id, req.user.id, msg);
  const school = q.school.get(req.user.school_id);
  notify(`🛟 Support message from ${school.name} (${req.user.name} <${req.user.email}>): ${msg.slice(0, 300)}`);
  res.json({ ok: true, message: 'Sent! Support will reply to your account email.' });
});

/* ---------------- owner (platform operator) ---------------- */
app.post('/api/owner/login', (req, res) => {
  const { email, password } = req.body || {};
  if ((email || '').toLowerCase() !== OWNER_EMAIL.toLowerCase() || password !== OWNER_PASSWORD)
    return res.status(401).json({ error: 'Wrong owner credentials.' });
  res.cookie('tok', jwt.sign({ owner: true }, SECRET, { expiresIn: '7d' }),
    { httpOnly: true, sameSite: 'lax', maxAge: 7 * 864e5 });
  res.json({ ok: true });
});

app.get('/api/owner/overview', ownerAuth, (_req, res) => {
  const schools = db.prepare(`
    SELECT s.id, s.name, s.slug, s.plan, s.plan_expires, s.created,
      (SELECT COUNT(*) FROM programs p WHERE p.school_id=s.id) programs,
      (SELECT COUNT(*) FROM users u WHERE u.school_id=s.id AND u.role='teacher' AND u.status='approved') teachers,
      (SELECT COUNT(*) FROM users u WHERE u.school_id=s.id AND u.role='student' AND u.status='approved') students,
      (SELECT email FROM users u WHERE u.school_id=s.id AND u.role='admin' ORDER BY u.id LIMIT 1) admin_email,
      (SELECT name FROM users u WHERE u.school_id=s.id AND u.role='admin' ORDER BY u.id LIMIT 1) admin_name
    FROM schools s ORDER BY s.created DESC`).all();
  const weekAgo = new Date(Date.now() - 7 * 864e5).toISOString().slice(0, 10);
  const in7 = new Date(Date.now() + 7 * 864e5).toISOString().slice(0, 10);
  const alerts = [];
  schools.filter(s => s.created.slice(0, 10) >= weekAgo)
    .forEach(s => alerts.push({ type: 'new', text: `🏫 New school: ${s.name} (/${s.slug}) — ${s.admin_email || 'no admin'}`, when: s.created }));
  schools.filter(s => s.plan === 'pro' && s.plan_expires && s.plan_expires <= in7)
    .forEach(s => alerts.push({ type: 'trial', text: `⏳ Trial ending ${s.plan_expires}: ${s.name} — good time to follow up`, when: s.plan_expires }));
  const support = db.prepare(`
    SELECT m.*, s.name school, s.slug, u.name user_name, u.email user_email
    FROM support_messages m LEFT JOIN schools s ON s.id=m.school_id LEFT JOIN users u ON u.id=m.user_id
    ORDER BY m.status='open' DESC, m.created DESC LIMIT 100`).all();
  support.filter(m => m.status === 'open')
    .forEach(m => alerts.push({ type: 'support', text: `🛟 Open support from ${m.school}: "${m.message.slice(0, 80)}"`, when: m.created }));
  alerts.sort((a, b) => (b.when || '').localeCompare(a.when || ''));
  res.json({
    schools, support, alerts: alerts.slice(0, 20),
    kpis: {
      total: schools.length,
      newWeek: schools.filter(s => s.created.slice(0, 10) >= weekAgo).length,
      paid: schools.filter(s => s.plan === 'pro' && !s.plan_expires).length,
      trials: schools.filter(s => s.plan === 'pro' && s.plan_expires).length,
      students: schools.reduce((a, s) => a + s.students, 0),
      openSupport: support.filter(m => m.status === 'open').length,
    },
  });
});

app.post('/api/owner/gencodes', ownerAuth, (req, res) => {
  let { days, count } = req.body || {};
  days = Math.max(1, Math.min(3650, Number(days) || 30));
  count = Math.max(1, Math.min(50, Number(count) || 5));
  const CH = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const codes = [];
  for (let i = 0; i < count; i++) {
    let nonce = '';
    crypto.randomBytes(6).forEach(b => nonce += CH[b % CH.length]);
    codes.push(`PRO-${days}D-${nonce}-${trialSig(String(days), nonce)}`);
  }
  res.json({ days, codes });
});

/* Everything the operator needs to log in, demo, and check the instance is safe.
   Never returns real secrets — only whether each one is still on its default.   */
app.get('/api/owner/setup', ownerAuth, (req, res) => {
  const base = process.env.APP_URL || `${req.protocol}://${req.get('host')}`;
  const demoSchool = db.prepare("SELECT * FROM schools WHERE slug='demo'").get();
  const demoAccounts = [
    { role: 'School admin', email: 'admin@demo.school', password: 'admin123' },
    { role: 'Teacher', email: 'rivera@demo.school', password: 'teach123' },
    { role: 'Student', email: 'maya@demo.school', password: 'learn123' },
  ].map(a => ({ ...a, exists: !!q.userByEmail.get(a.email) }));
  res.json({
    owner: { email: OWNER_EMAIL, usingDefaultEmail: OWNER_EMAIL === 'owner@demo.school',
      usingDefaultPassword: OWNER_PASSWORD === 'owner123' },
    demo: { school: demoSchool ? demoSchool.name : null, slug: demoSchool ? demoSchool.slug : null,
      accounts: demoAccounts },
    env: [
      { key: 'OWNER_PASSWORD', label: 'Office password', ok: OWNER_PASSWORD !== 'owner123',
        warn: 'Still the default — anyone who reads the docs can open your office.' },
      { key: 'JWT_SECRET', label: 'Session secret', ok: SECRET !== 'dev-secret-change-me',
        warn: 'Still the default — logins could be forged.' },
      { key: 'CODE_SECRET', label: 'Access-code secret', ok: CODE_SECRET !== 'scheduler-trial-secret',
        warn: 'Still the default — anyone could mint free Pro codes.' },
      { key: 'DB_PATH', label: 'Persistent database', ok: !!process.env.DB_PATH,
        warn: 'Not set — data resets on every deploy.' },
      { key: 'EMAIL_USER', label: 'Email (invites & resets)', ok: emailEnabled(),
        warn: 'Not configured — no invite or reset emails go out.' },
      { key: 'STRIPE_SECRET_KEY', label: 'Card subscriptions', ok: !!(stripe && STRIPE_PRICE),
        warn: 'Not configured — upgrades happen by access code only.' },
      { key: 'ALERT_WEBHOOK_URL', label: 'Instant alerts', ok: !!ALERT_WEBHOOK,
        warn: 'Optional — set it to get pings in Slack/Discord or Int-AI-lisoft HQ.' },
      { key: 'PARTNER_KEY', label: 'HQ can read this app', ok: !!process.env.PARTNER_KEY,
        warn: 'Optional — needed for Int-AI-lisoft HQ to show this app\'s numbers.' },
    ],
    urls: { office: base + '/office', storefront: base + '/',
      demo: demoSchool ? base + '/' + demoSchool.slug : null },
  });
});

app.get('/api/owner/emailstatus', ownerAuth, (_req, res) => {
  res.json({ enabled: emailEnabled(), via: mailer ? 'gmail' : (RESEND_KEY ? 'resend' : null), from: GMAIL_USER || EMAIL_FROM || null });
});
app.post('/api/owner/testemail', ownerAuth, async (req, res) => {
  const to = ((req.body || {}).to || '').trim();
  if (!to) return res.status(400).json({ error: 'Enter an address to send the test to.' });
  if (!emailEnabled()) return res.status(400).json({ error: 'Email is not configured — set GMAIL_USER (or EMAIL_USER) and GMAIL_APP_PASSWORD (or EMAIL_PASSWORD) env vars.' });
  try {
    await sendEmail(to, 'School Scheduler — test email',
      '<p>✅ Email service is working. Password-reset links will be delivered from this address.</p>');
    res.json({ ok: true, message: 'Test email sent to ' + to + ' — check the inbox (and spam).' });
  } catch (e) { res.status(500).json({ error: 'Send failed: ' + e.message }); }
});

app.post('/api/owner/resetpw', ownerAuth, (req, res) => {
  const admin = db.prepare("SELECT * FROM users WHERE school_id=? AND role='admin' ORDER BY id LIMIT 1")
    .get((req.body || {}).school_id);
  if (!admin) return res.status(404).json({ error: 'No admin account found for that school.' });
  const temp = tempPassword();
  db.prepare('UPDATE users SET pass_hash=? WHERE id=?').run(bcrypt.hashSync(temp, 10), admin.id);
  res.json({ ok: true, name: admin.name, email: admin.email, temp });
});

app.post('/api/owner/support/:id/close', ownerAuth, (req, res) => {
  db.prepare("UPDATE support_messages SET status='closed' WHERE id=?").run(req.params.id);
  res.json({ ok: true });
});

/* ---------------- partner API (read-only, for Int-AI-lisoft HQ) ------------ */
const PARTNER_KEY = process.env.PARTNER_KEY || '';
app.get('/api/partner/summary', (req, res) => {
  if (!PARTNER_KEY || req.get('X-Partner-Key') !== PARTNER_KEY)
    return res.status(401).json({ error: 'bad partner key' });
  const week = new Date(Date.now() - 7 * 864e5).toISOString().slice(0, 19).replace('T', ' ');
  const schools = db.prepare('SELECT id, plan, plan_expires, created FROM schools').all();
  res.json({
    app: 'After-School Scheduler', company: 'Int-AI-lisoft', at: new Date().toISOString(),
    kpis: {
      schools: schools.length,
      trialsWeek: schools.filter(s => (s.created || '') >= week).length,
      activeTrials: schools.filter(s => s.plan === 'pro' && s.plan_expires).length,
      subscribers: schools.filter(s => s.plan === 'pro' && !s.plan_expires).length,
      students: db.prepare("SELECT COUNT(*) c FROM users WHERE role='student' AND status='approved'").get().c,
      users: db.prepare('SELECT COUNT(*) c FROM users').get().c,
      openSupport: db.prepare("SELECT COUNT(*) c FROM support_messages WHERE status='open'").get().c,
    },
    services: { email: emailEnabled(), stripe: !!(stripe && STRIPE_PRICE) },
  });
});

/* ---------------- static ---------------- */
const PUBLIC_FILES = ['manifest.webmanifest', 'sw.js', 'icon-192.png', 'icon-512.png', 'apple-touch-icon.png'];
PUBLIC_FILES.forEach(f => app.get('/' + f, (_req, res) => res.sendFile(path.join(__dirname, f))));
app.get('/ui.js', (_req, res) => res.sendFile(path.join(__dirname, 'ui.js')));

/* The page shell. The UI itself lives in ui.js (see build-ui.js) so the app can be
   deployed by uploading .js files — some browsers block .html downloads outright.
   If ui.js is missing we fall back to the old index.html, so nothing can break.   */
const UI_JS = path.join(__dirname, 'ui.js');
const SHELL = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>School Scheduler</title>
<link rel="manifest" href="/manifest.webmanifest">
<meta name="theme-color" content="#151b2c">
<meta name="apple-mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-status-bar-style" content="black-translucent">
<meta name="apple-mobile-web-app-title" content="Scheduler">
<link rel="apple-touch-icon" href="/apple-touch-icon.png">
<style>body{margin:0;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Arial,sans-serif;background:#f4f6fa}</style>
</head>
<body><script src="/ui.js?v=${Date.now()}"></script></body>
</html>`;
const sendApp = (_req, res) =>
  fs.existsSync(UI_JS) ? res.type('html').send(SHELL) : res.sendFile(path.join(__dirname, 'index.html'));
app.get(['/owner', '/office'], sendApp);
app.get('/', sendApp);
/* per-school pages: /<slug> serves the app, which reads the slug client-side */
app.get('/:slug', (req, res) => {
  const exists = db.prepare('SELECT 1 x FROM schools WHERE slug=?').get(req.params.slug.toLowerCase());
  if (exists) return sendApp(req, res);
  res.redirect('/');
});
app.use((err, _req, res, _next) => { console.error(err); res.status(500).json({ error: 'Server error.' }); });

app.listen(PORT, '0.0.0.0', () => console.log(`Scheduler running on :${PORT}`));
