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


/* ------------------------------------------------ central accounts --- */
/* The same module every one of these apps carries. Kept inline so this stays a
   single-file server. */
const central = (() => {
/* Central accounts — the same file in every app.
 *
 * One account works everywhere: My Apps holds the passwords and the plans, and
 * each app asks it. The app proves itself with a slug and a secret that live in
 * its environment variables, never in this source.
 *
 * Three things this deliberately does:
 *
 *  - Never locks anybody out. My Apps runs on a free plan that sleeps, so the
 *    first call after an idle spell can take the best part of a minute. Calls
 *    retry once, and every caller is expected to fall back to its own local
 *    password if central cannot be reached at all.
 *
 *  - Tells the app whether an account exists (`known`), which the generic
 *    "wrong email or password" message hides from the browser. That is what
 *    lets an app recognise an old local-only account and migrate it, without
 *    letting a stranger discover which emails are registered. It is safe here
 *    because the caller had to present the app secret to ask.
 *
 *  - Reports `unavailable` rather than pretending a failure is a wrong
 *    password, so the caller can tell "no" apart from "couldn't ask".
 */

const URL_BASE = (process.env.MY_APPS_URL || '').replace(/\/+$/, '');
const SLUG = process.env.MY_APPS_SLUG || '';
const SECRET = process.env.MY_APPS_SECRET || '';

const enabled = () => Boolean(URL_BASE && SLUG && SECRET);

async function call(path, body, { timeout = 12000, retry = true } = {}) {
  if (!enabled()) {
    return { ok: false, unavailable: true, status: 503, error: 'Central accounts are not configured' };
  }
  try {
    const res = await fetch(URL_BASE + path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(Object.assign({ slug: SLUG, secret: SECRET }, body)),
      signal: AbortSignal.timeout(timeout)
    });
    /* Insist on a JSON answer. If the other end is an older build that has no
       such route, it may well answer 200 with an HTML sign-in page — and
       treating that as "yes, signed in" would be the worst possible bug. */
    const isJson = (res.headers.get('content-type') || '').includes('application/json');
    const data = isJson ? await res.json().catch(() => null) : null;
    if (!data || typeof data !== 'object') {
      return { ok: false, unavailable: true, status: res.status,
               error: 'Accounts service gave an answer this app did not understand' };
    }
    if (res.ok) return Object.assign({ ok: true }, data);
    // 5xx is central having a bad day, not an answer about this account.
    if (res.status >= 500) {
      if (retry) return call(path, body, { timeout: 25000, retry: false });
      return { ok: false, unavailable: true, status: res.status, error: 'Accounts service is unavailable' };
    }
    return Object.assign({ ok: false, status: res.status, error: data.error || 'Rejected' }, data);
  } catch (e) {
    // A cold start on the free plan looks exactly like a timeout. Wait longer once.
    if (retry) return call(path, body, { timeout: 40000, retry: false });
    return { ok: false, unavailable: true, status: 503, error: 'Accounts service is unreachable' };
  }
}

/* Wake My Apps up before anyone needs it.
 *
 * On the free plan it sleeps after fifteen idle minutes and takes the best part
 * of a minute to come back. Signing in would then take that minute. So the page
 * that shows the sign-in form pings it first: by the time an email and password
 * have been typed, it is already awake. Fire and forget — a failure here means
 * nothing, the sign-in path handles being unable to reach it. */
let lastWarm = 0;
function warm() {
  if (!enabled() || Date.now() - lastWarm < 60000) return;
  lastWarm = Date.now();
  fetch(URL_BASE + '/healthz', { signal: AbortSignal.timeout(45000) }).catch(() => {});
}

const login = (email, password) => call('/api/v1/auth/login', { email, password });

const register = ({ email, password, name, code }) =>
  call('/api/v1/auth/register', { email, password, name, code });

const changePassword = ({ email, oldPassword, newPassword }) =>
  call('/api/v1/auth/change-password', { email, oldPassword, newPassword });

const status = ({ email }) => call('/api/v1/status', { account: email });

return { enabled, warm, login, register, changePassword, status, call };

})();

const PORT = process.env.PORT || 10000;
const SECRET = process.env.JWT_SECRET || 'dev-secret-change-me';
/* ---------------- database ----------------
 * Postgres, shared with the other IntAlsoft apps. The shim below keeps the
 * call shape the app already used — prepare(sql).get/all/run(args) — so the
 * queries read the same as before. What changed is that every one of them is
 * now a promise, because a network database cannot answer instantly the way a
 * local file could.
 *
 * Two translations happen here rather than in 150 call sites:
 *   ?  ->  $1, $2 ...        Postgres numbers its placeholders
 *   run() -> lastInsertRowid  by asking for the new id back on the way in
 */
const { Pool, Client } = require('pg');
const DATABASE_URL = process.env.DATABASE_URL || '';
if (!DATABASE_URL) {
  console.error('DATABASE_URL is not set — this app now stores its data in Postgres.');
  process.exit(1);
}
const SSL = /localhost|127\.0\.0\.1|sslmode=disable/.test(DATABASE_URL)
  ? false : { rejectUnauthorized: false };

/* This database is shared with the other IntAlsoft apps, and app tables collide:
 * ServeTrack has a `users` table and so does this one, meaning entirely
 * different things. Postgres schemas exist for exactly this — each app gets its
 * own namespace inside the one database, so `users` here and `users` there are
 * different tables and neither can touch the other.
 *
 * search_path is set at connection startup, so every query in this file lands
 * in this app's namespace without a single table name changing. */
const DB_SCHEMA = (process.env.DB_SCHEMA || 'scheduler').toLowerCase();
if (!/^[a-z_][a-z0-9_]*$/.test(DB_SCHEMA)) {
  console.error(`DB_SCHEMA "${DB_SCHEMA}" is not a valid identifier.`);
  process.exit(1);
}

const pool = new Pool({
  connectionString: DATABASE_URL,
  ssl: SSL,
  max: 8,
  idleTimeoutMillis: 30000,
  options: `-c search_path=${DB_SCHEMA}`
});
pool.on('error', e => console.error('postgres pool error:', e.message));

/* The schema itself has to exist before any pooled connection can point at it,
 * so this one runs on its own connection with the default path. */
async function ensureSchema() {
  const c = new Client({ connectionString: DATABASE_URL, ssl: SSL });
  await c.connect();
  try {
    await c.query(`CREATE SCHEMA IF NOT EXISTS ${DB_SCHEMA}`);
    console.log(`Using the "${DB_SCHEMA}" schema in the shared database.`);
  } finally {
    await c.end();
  }
}

// Tables whose inserts should hand back the new row id.
const ID_TABLES = new Set(['schools', 'users', 'programs', 'reservations',
                           'photos', 'support_messages', 'email_log']);

const toPg = sql => { let i = 0; return sql.replace(/\?/g, () => '$' + (++i)); };

function withReturning(sql) {
  if (!/^\s*insert\s+into/i.test(sql)) return sql;
  if (/returning/i.test(sql)) return sql;
  const m = sql.match(/^\s*insert\s+into\s+([a-z_]+)/i);
  if (!m || !ID_TABLES.has(m[1].toLowerCase())) return sql;
  return sql.replace(/;?\s*$/, ' RETURNING id');
}

/* Transactions need every query inside them to travel on the SAME connection,
   or BEGIN and the work land on different ones and nothing is atomic. Rather
   than thread a client through every function, the current client is kept in
   async-local storage — it follows the awaits by itself. */
const { AsyncLocalStorage } = require('async_hooks');
const txStore = new AsyncLocalStorage();
const runner = () => txStore.getStore() || pool;

const db = {
  async exec(sql) { await runner().query(sql); },
  prepare(sql) {
    const text = toPg(withReturning(sql));
    return {
      async get(...a) { return (await runner().query(text, a)).rows[0]; },
      async all(...a) { return (await runner().query(text, a)).rows; },
      async run(...a) {
        const r = await runner().query(text, a);
        return {
          changes: r.rowCount,
          lastInsertRowid: r.rows && r.rows[0] ? r.rows[0].id : undefined
        };
      }
    };
  },
  /* All of it, or none of it. Anything that throws inside rolls the whole
     thing back, which is the point of grouping the statements at all. */
  async transaction(fn) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const out = await txStore.run(client, fn);
      await client.query('COMMIT');
      return out;
    } catch (e) {
      try { await client.query('ROLLBACK'); } catch (_) { /* connection already gone */ }
      throw e;
    } finally {
      client.release();
    }
  }
};

/* ---------------- schema ----------------
   Run once at boot, before anything serves. Every statement is written so a
   second run is harmless, which is what makes a redeploy safe.               */
const SCHEMA = `
CREATE TABLE IF NOT EXISTS schools(
  id SERIAL PRIMARY KEY,
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
  id SERIAL PRIMARY KEY,
  school_id INTEGER NOT NULL,
  role TEXT NOT NULL CHECK(role IN ('student','teacher','admin')),
  name TEXT NOT NULL, email TEXT NOT NULL UNIQUE, pass_hash TEXT NOT NULL,
  grade TEXT DEFAULT '', student_id TEXT DEFAULT '', id_photo TEXT DEFAULT '',
  status TEXT DEFAULT 'pending' CHECK(status IN ('pending','approved','rejected')),
  created TEXT DEFAULT to_char(now(),'YYYY-MM-DD HH24:MI:SS')
);
CREATE TABLE IF NOT EXISTS programs(
  id SERIAL PRIMARY KEY,
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
  id SERIAL PRIMARY KEY,
  program_id INTEGER NOT NULL,
  student_id INTEGER NOT NULL,
  date TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('reserved','waitlist','cancelled')),
  attended INTEGER,              -- NULL=not marked, 1=present, 0=no-show
  created TEXT DEFAULT to_char(now(),'YYYY-MM-DD HH24:MI:SS'),
  UNIQUE(program_id, student_id, date)
);
CREATE TABLE IF NOT EXISTS photos(
  id SERIAL PRIMARY KEY,
  school_id INTEGER NOT NULL,
  caption TEXT DEFAULT '', data TEXT NOT NULL
);
`;

const MIGRATIONS = [
  "ALTER TABLE users   ADD COLUMN IF NOT EXISTS student_id   TEXT DEFAULT ''",
  "ALTER TABLE users   ADD COLUMN IF NOT EXISTS id_photo     TEXT DEFAULT ''",
  "ALTER TABLE schools ADD COLUMN IF NOT EXISTS plan         TEXT DEFAULT 'free'",
  "ALTER TABLE schools ADD COLUMN IF NOT EXISTS stripe_sub   TEXT DEFAULT ''",
  "ALTER TABLE schools ADD COLUMN IF NOT EXISTS plan_expires TEXT DEFAULT ''",
  "ALTER TABLE schools ADD COLUMN IF NOT EXISTS slug         TEXT DEFAULT ''",
  "ALTER TABLE schools ADD COLUMN IF NOT EXISTS created      TEXT DEFAULT ''",
  `CREATE TABLE IF NOT EXISTS support_messages(
     id SERIAL PRIMARY KEY,
     school_id INTEGER, user_id INTEGER, message TEXT NOT NULL,
     status TEXT DEFAULT 'open',
     created TEXT DEFAULT to_char(now(),'YYYY-MM-DD HH24:MI:SS'))`,
  `CREATE TABLE IF NOT EXISTS email_log(
     id SERIAL PRIMARY KEY, recipient TEXT, subject TEXT,
     ok INTEGER DEFAULT 0, error TEXT DEFAULT '', ms INTEGER DEFAULT 0,
     created TEXT DEFAULT to_char(now(),'YYYY-MM-DD HH24:MI:SS'))`,
  `CREATE TABLE IF NOT EXISTS redeemed_codes(
     code TEXT PRIMARY KEY, school_id INTEGER,
     redeemed TEXT DEFAULT to_char(now(),'YYYY-MM-DD HH24:MI:SS'))`,
  "UPDATE schools SET created=to_char(now(),'YYYY-MM-DD HH24:MI:SS') WHERE created=''",
];

async function migrate() {
  await db.exec(SCHEMA);
  for (const sql of MIGRATIONS) await db.exec(sql);
}

/* Slugs predate multi-tenancy, so schools created before it have none. */
async function backfillSlugs() {
  const rows = await db.prepare("SELECT id,name FROM schools WHERE slug=''").all();
  for (const row of rows) {
    await db.prepare('UPDATE schools SET slug=? WHERE id=?').run(await slugify(row.name), row.id);
  }
}

const RESERVED_SLUGS = ['owner', 'office', 'admin', 'api', 'mockup', 'demo-x', 'login', 'signup', 'static', 'assets'];
async function slugify(name) {
  let base = String(name).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'school';
  if (RESERVED_SLUGS.includes(base)) base += '-school';
  let slug = base, n = 2;
  while (await db.prepare('SELECT 1 x FROM schools WHERE slug=?').get(slug)) slug = base + '-' + (n++);
  return slug;
}
/* The slug backfill and the redeemed_codes table now live in migrate() and
   backfillSlugs(), which boot() runs before the app serves anything. */

/* ---------------- plans ---------------- */
/* Free-tier ceilings. Tune per instance with FREE_PROGRAMS / FREE_TEACHERS /
   FREE_STUDENTS env vars — no code change needed. Set any to 0 for unlimited.   */
const FREE_LIMITS = {
  programs: Number(process.env.FREE_PROGRAMS || 3),
  teachers: Number(process.env.FREE_TEACHERS || 3),
  students: Number(process.env.FREE_STUDENTS || 10),
};
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
      connectionTimeout: 10000, greetingTimeout: 10000, socketTimeout: 15000,
    });
    mailer.verify()
      .then(() => console.log('email: ready as', GMAIL_USER))
      .catch(e => { LAST_EMAIL_ERROR = e.message; console.error('email: NOT working —', e.message); });
  } catch (e) { console.error('gmail init failed:', e.message); }
}
let LAST_EMAIL_ERROR = '';
const EMAIL_TIMEOUT_MS = 20000;
async function sendEmail(to, subject, html) {
  const started = Date.now();
  try {
    await Promise.race([
      rawSend(to, subject, html),
      new Promise((_, rej) => setTimeout(() => rej(new Error('timed out after 20s')), EMAIL_TIMEOUT_MS)),
    ]);
    await db.prepare('INSERT INTO email_log(recipient,subject,ok,ms) VALUES(?,?,1,?)')
      .run(to, subject, Date.now() - started);
    LAST_EMAIL_ERROR = '';
  } catch (e) {
    LAST_EMAIL_ERROR = e.message;
    await db.prepare('INSERT INTO email_log(recipient,subject,ok,error,ms) VALUES(?,?,0,?,?)')
      .run(to, subject, String(e.message).slice(0, 300), Date.now() - started);
    throw e;
  }
}
async function rawSend(to, subject, html) {
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
async function userLink(req, user, query) {
  const school = user && user.school_id ? await q.school.get(user.school_id) : null;
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
async function planUsage(schoolId) {
  const row = await db.prepare('SELECT plan, plan_expires FROM schools WHERE id=?').get(schoolId) || {};
  let plan = row.plan || 'free';
  if (plan === 'pro' && row.plan_expires && row.plan_expires < todayISO()) {
    await db.prepare("UPDATE schools SET plan='free', plan_expires='' WHERE id=?").run(schoolId);
    plan = 'free';
  }
  return {
    plan, plan_expires: plan === 'pro' ? (row.plan_expires || '') : '',
    limits: plan === 'free' ? FREE_LIMITS : null,
    programs: (await db.prepare('SELECT COUNT(*)::int c FROM programs WHERE school_id=?').get(schoolId)).c,
    teachers: (await db.prepare("SELECT COUNT(*)::int c FROM users WHERE school_id=? AND role='teacher' AND status='approved'").get(schoolId)).c,
    students: (await db.prepare("SELECT COUNT(*)::int c FROM users WHERE school_id=? AND role='student' AND status='approved'").get(schoolId)).c,
  };
}
async function planBlocked(schoolId, kind, verb) {
  const u = await planUsage(schoolId);
  if (u.plan !== 'free') return null;
  const v = verb || 'add';
  if (kind === 'programs' && FREE_LIMITS.programs > 0 && u.programs >= FREE_LIMITS.programs)
    return `Free plan limit reached (${FREE_LIMITS.programs} classes/programs). Upgrade to ${v} more.`;
  if (kind === 'teachers' && FREE_LIMITS.teachers > 0 && u.teachers >= FREE_LIMITS.teachers)
    return `Free plan limit reached (${FREE_LIMITS.teachers} teachers). Upgrade to ${v} more.`;
  if (kind === 'students' && FREE_LIMITS.students > 0 && u.students >= FREE_LIMITS.students)
    return `Free plan limit reached (${FREE_LIMITS.students} students). Upgrade to ${v} more.`;
  return null;
}

/* ---------------- seed (only when empty) ---------------- */
async function seedIfEmpty() {
if (!(await db.prepare('SELECT COUNT(*)::int c FROM schools').get()).c) {
  const s = await db.prepare("INSERT INTO schools(name,subtitle,slug) VALUES(?,?,?)")
    .run('Demo Elementary', 'Try the scheduler here — demo school', 'demo');
  const sid = s.lastInsertRowid;
  await db.prepare('INSERT INTO settings(school_id) VALUES(?)').run(sid);
  const hash = p => bcrypt.hashSync(p, 10);
  const admin = await db.prepare("INSERT INTO users(school_id,role,name,email,pass_hash,status) VALUES(?,?,?,?,?,?)")
    .run(sid, 'admin', 'School Admin', 'admin@demo.school', hash('admin123'), 'approved');
  const teach = await db.prepare("INSERT INTO users(school_id,role,name,email,pass_hash,status) VALUES(?,?,?,?,?,?)")
    .run(sid, 'teacher', 'Coach Rivera', 'rivera@demo.school', hash('teach123'), 'approved');
  await db.prepare("INSERT INTO users(school_id,role,name,email,pass_hash,grade,student_id,status) VALUES(?,?,?,?,?,?,?,?)")
    .run(sid, 'student', 'Maya Torres', 'maya@demo.school', hash('learn123'), '5', 'S-1001', 'approved');
  const today = new Date(); const iso = d => d.toISOString().slice(0, 10);
  const start = new Date(today); start.setDate(start.getDate() - 14);
  const end = new Date(today); end.setDate(end.getDate() + 90);
  const P = db.prepare("INSERT INTO programs(school_id,name,type,teacher_id,room,capacity,days,time_start,time_end,date_start,date_end,emoji) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)");
  await P.run(sid, 'Chess Club', 'afterschool', teach.lastInsertRowid, 'Rm 104', 16, '1,3', '15:30', '16:30', iso(start), iso(end), '♟️');
  await P.run(sid, 'Track & Field', 'afterschool', teach.lastInsertRowid, 'Field', 24, '2,4', '15:30', '17:00', iso(start), iso(end), '🏃');
  await P.run(sid, 'Robotics Lab', 'class', teach.lastInsertRowid, 'STEM Lab', 3, '3', '15:30', '17:00', iso(start), iso(end), '🤖');
}
}

/* ---------------- stripe (optional — enabled when env keys are set) ---------------- */
const STRIPE_KEY = process.env.STRIPE_SECRET_KEY || '';
const STRIPE_PRICE = process.env.STRIPE_PRICE_ID || '';
const STRIPE_WH = process.env.STRIPE_WEBHOOK_SECRET || '';
let stripe = null;
if (STRIPE_KEY) { try { stripe = require('stripe')(STRIPE_KEY); } catch (e) { console.error('stripe init failed:', e.message); } }

/* ---------------- demo school (for learning & testing) --------------------
   Runs on every boot, creates only what's missing, and never touches a real
   school. Unlimited plan so nobody hits a wall while learning the app.        */
const DEMO_PASSWORD = process.env.DEMO_PASSWORD || 'learn123';
const DEMO_ACCOUNTS = [
  { role: 'admin',   email: 'admin@demo.com',   name: 'Demo Admin' },
  { role: 'teacher', email: 'teacher@demo.com', name: 'Demo Teacher' },
  { role: 'student', email: 'student@demo.com', name: 'Demo Student', grade: '5', student_id: 'S-0001' },
];
async function ensureDemo() {
  if (String(process.env.DEMO_SCHOOL || 'on') === 'off') return null;
  let school = await db.prepare("SELECT * FROM schools WHERE slug='demo'").get();
  if (!school) {
    const r = await db.prepare("INSERT INTO schools(name,subtitle,slug,plan,created) VALUES(?,?,?,?,to_char(now(),'YYYY-MM-DD HH24:MI:SS'))")
      .run('Demo Elementary', 'Try everything here — nothing you do affects a real school', 'demo', 'pro');
    await db.prepare('INSERT INTO settings(school_id) VALUES(?)').run(r.lastInsertRowid);
    school = await db.prepare("SELECT * FROM schools WHERE slug='demo'").get();
  }
  /* always unlimited — a demo that hits a paywall teaches the wrong lesson */
  await db.prepare("UPDATE schools SET plan='pro', plan_expires='' WHERE id=?").run(school.id);
  const hash = bcrypt.hashSync(DEMO_PASSWORD, 10);
  for (const a of DEMO_ACCOUNTS) {
    if (!await q.userByEmail.get(a.email)) {
      await db.prepare(`INSERT INTO users(school_id,role,name,email,pass_hash,grade,student_id,status)
        VALUES(?,?,?,?,?,?,?, 'approved')`)
        .run(school.id, a.role, a.name, a.email, hash, a.grade || '', a.student_id || '');
    }
  }
  return school;
}

/* ---------------- helpers ---------------- */
const app = express();
app.set('trust proxy', 1);   // Render terminates TLS — without this, emailed links come out as http://

/* Stripe webhook needs the RAW body, so register it before the JSON parser */
app.post('/api/stripe/webhook', express.raw({ type: 'application/json' }), async (req, res) => {
  if (!stripe || !STRIPE_WH) return res.status(400).end();
  let event;
  try { event = stripe.webhooks.constructEvent(req.body, req.headers['stripe-signature'], STRIPE_WH); }
  catch (err) { return res.status(400).send(`Webhook error: ${err.message}`); }
  if (event.type === 'checkout.session.completed') {
    const s = event.data.object;
    const schoolId = Number(s.metadata && s.metadata.school_id);
    if (schoolId) {
      await db.prepare("UPDATE schools SET plan='pro', stripe_sub=?, plan_expires='' WHERE id=?")
        .run(s.subscription || '', schoolId);
      const sch = await db.prepare('SELECT name FROM schools WHERE id=?').get(schoolId);
      notify(`💳 New subscription: ${sch ? sch.name : 'school #' + schoolId} is now on Unlimited!`);
    }
  }
  if (event.type === 'customer.subscription.deleted') {
    const sub = event.data.object;
    await db.prepare("UPDATE schools SET plan='free', stripe_sub='' WHERE stripe_sub=?").run(sub.id);
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
  reservedCount: db.prepare("SELECT COUNT(*)::int c FROM reservations WHERE program_id=? AND date=? AND status='reserved'"),
  waitCount: db.prepare("SELECT COUNT(*)::int c FROM reservations WHERE program_id=? AND date=? AND status='waitlist'"),
  myRes: db.prepare("SELECT * FROM reservations WHERE student_id=? AND date=? AND status IN ('reserved','waitlist')"),
};

/* The demo school needs the query helpers above, so boot() runs it — see the
   bottom of this file, where everything is ordered. */

function ownerAuth(req, res, next) {
  try {
    const p = jwt.verify(req.cookies.tok, SECRET);
    if (!p.owner) throw 0;
    next();
  } catch { res.status(401).json({ error: 'Owner login required.' }); }
}

function auth(roles) {
  return async (req, res, next) => {
    try {
      const tok = req.cookies.tok;
      const { uid } = jwt.verify(tok, SECRET);
      const u = await q.user.get(uid);
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

async function attendanceStats(studentId) {
  const rows = await db.prepare(
    "SELECT attended FROM reservations WHERE student_id=? AND status='reserved' AND date<? ").all(studentId, todayISO());
  const marked = rows.filter(r => r.attended !== null);
  const present = marked.filter(r => r.attended === 1).length;
  const pct = marked.length ? Math.round(100 * present / marked.length) : 100;
  return { pct, attended: present, missed: marked.length - present };
}

/* ---------------- public ---------------- */
app.post('/api/register-school', async (req, res) => {
  const { school_name, subtitle, admin_name, admin_email, admin_password } = req.body || {};
  if (!school_name || !admin_name || !admin_email || !admin_password)
    return res.status(400).json({ error: 'School name, your name, email, and password are all required.' });
  if (await q.userByEmail.get(admin_email))
    return res.status(409).json({ error: 'That email already has an account. Log in instead.' });
  const slug = await slugify(school_name);
  const s = await db.prepare("INSERT INTO schools(name,subtitle,slug,created) VALUES(?,?,?,to_char(now(),'YYYY-MM-DD HH24:MI:SS'))")
    .run(school_name.trim(), (subtitle || '').trim(), slug);
  await db.prepare('INSERT INTO settings(school_id) VALUES(?)').run(s.lastInsertRowid);
  const a = await db.prepare("INSERT INTO users(school_id,role,name,email,pass_hash,status) VALUES(?,?,?,?,?,'approved')")
    .run(s.lastInsertRowid, 'admin', admin_name.trim(), admin_email.trim(), bcrypt.hashSync(admin_password, 10));
  centralEnrol(admin_email.trim(), admin_password, admin_name.trim());
  res.cookie('tok', jwt.sign({ uid: a.lastInsertRowid }, SECRET, { expiresIn: '30d' }),
    { httpOnly: true, sameSite: 'lax', maxAge: 30 * 864e5 });
  notify(`🏫 New school registered: ${school_name.trim()} (/${slug}) — admin ${admin_name.trim()} <${admin_email.trim()}>`);
  res.json({ ok: true, slug });
});

app.get('/api/slug/:slug', async (req, res) => {
  const school = await db.prepare('SELECT id,name,subtitle,slug FROM schools WHERE slug=?').get(req.params.slug.toLowerCase());
  if (!school) return res.status(404).json({ error: 'School not found' });
  const programs = await db.prepare(
    `SELECT p.*, u.name teacher FROM programs p LEFT JOIN users u ON u.id=p.teacher_id WHERE p.school_id=? ORDER BY p.name`
  ).all(school.id);
  const photos = await db.prepare('SELECT id,caption,data FROM photos WHERE school_id=?').all(school.id);
  res.json({ school, programs, photos });
});

app.get('/api/schools/:id/public', auth(), async (req, res) => {
  if (Number(req.params.id) !== req.user.school_id) return res.status(403).json({ error: 'Not your school.' });
  const school = await q.school.get(req.params.id);
  if (!school) return res.status(404).json({ error: 'School not found' });
  const programs = await db.prepare(
    `SELECT p.*, u.name teacher FROM programs p LEFT JOIN users u ON u.id=p.teacher_id WHERE p.school_id=? ORDER BY p.name`
  ).all(school.id);
  const photos = await db.prepare('SELECT id,caption,data FROM photos WHERE school_id=?').all(school.id);
  res.json({ school, programs, photos });
});

app.post('/api/signup', async (req, res) => {
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
  if (await q.userByEmail.get(email)) return res.status(409).json({ error: 'That email already has an account.' });
  if (role === 'student' && await db.prepare(
    "SELECT 1 x FROM users WHERE school_id=? AND role='student' AND student_id=? AND student_id<>''")
    .get(school_id, student_id.trim()))
    return res.status(409).json({ error: 'That Student ID is already registered at this school.' });
  await db.prepare('INSERT INTO users(school_id,role,name,email,pass_hash,grade,student_id,id_photo) VALUES(?,?,?,?,?,?,?,?)')
    .run(school_id, role, name.trim(), email.trim(), bcrypt.hashSync(password, 10), grade || '',
      role === 'student' ? student_id.trim() : '', role === 'student' ? id_photo : '');
  // The account they just made is their one account everywhere. Never overwrite
  // an existing central account: signing up must not be a way to take one over.
  centralEnrol(email.trim(), password, name.trim());
  res.json({ ok: true, message: 'Account created — an administrator must approve it before you can continue.' });
});

/* Create the central account if there is none; leave any existing one alone. */
async function centralEnrol(email, password, name) {
  if (!central.enabled()) return;
  try {
    const made = await central.register({ email, password, name });
    if (!made.ok && made.status !== 409) console.warn('Central enrol failed for ' + email + ': ' + made.error);
  } catch (e) { console.warn('Central enrol threw for ' + email + ': ' + e.message); }
}

/* An administrator deliberately setting a password: create the central account
   or reset it, so the new password works in every app straight away. */
async function centralReset(email, password, name) {
  if (!central.enabled()) return;
  try {
    const made = await central.register({ email, password, name });
    if (made.ok) return;
    if (made.status === 409) {
      const set = await central.call('/api/v1/auth/admin-set-password', { email, newPassword: password });
      if (!set.ok) console.warn('Central reset failed for ' + email + ': ' + set.error);
      return;
    }
    console.warn('Central reset failed for ' + email + ': ' + made.error);
  } catch (e) { console.warn('Central reset threw for ' + email + ': ' + e.message); }
}

/* Sign in.
 *
 * One account works across every app, so My Apps holds the password. The school
 * record still lives here — being a teacher at a particular school is this
 * app's business, not My Apps' — so somebody with a central account but no
 * place at a school is told to speak to their administrator rather than let in.
 *
 * This app has real users on it, so nothing about it may become more fragile:
 * if My Apps cannot be reached, the password stored here is used instead, and
 * accounts that predate central sign-in keep working and are moved across the
 * first time they sign in successfully.
 */
function issueSchedulerSession(res, u) {
  res.cookie('tok', jwt.sign({ uid: u.id }, SECRET, { expiresIn: '30d' }),
    { httpOnly: true, sameSite: 'lax', maxAge: 30 * 864e5 });
}
const setLocalPassword = async (id, pw) =>
  await db.prepare('UPDATE users SET pass_hash=? WHERE id=?').run(bcrypt.hashSync(pw, 10), id);

app.post('/api/login', async (req, res) => {
  const { email, password } = req.body || {};
  const u = email && await q.userByEmail.get(email);
  const localOk = () => u && u.pass_hash && bcrypt.compareSync(password || '', u.pass_hash);
  const WRONG = { error: 'Wrong email or password.' };
  const NO_SCHOOL = { error: 'That account is not set up at a school yet — ask your school administrator to add you.' };

  if (!central.enabled()) {
    if (!localOk()) return res.status(401).json(WRONG);
    issueSchedulerSession(res, u);
    return res.json({ ok: true });
  }

  let c = await central.login(email, password);
  if (c.ok && !c.user) {
    c = { ok: false, unavailable: true, error: 'Accounts service gave an answer this app did not understand' };
  }

  if (c.ok) {
    if (!u) return res.status(403).json(NO_SCHOOL);
    await setLocalPassword(u.id, password);     // mirror, so an outage cannot lock anyone out
    issueSchedulerSession(res, u);
    return res.json({ ok: true });
  }
  if (c.unavailable) {
    if (!localOk()) return res.status(401).json(WRONG);
    console.warn('My Apps unreachable (' + c.error + ') — ' + email + ' signed in against the local password');
    issueSchedulerSession(res, u);
    return res.json({ ok: true });
  }
  if (c.suspended) return res.status(401).json({ error: 'That account has been suspended.' });
  if (c.known) return res.status(401).json(WRONG);

  // Central has never seen it: an account from before central sign-in existed.
  if (!localOk()) return res.status(401).json(WRONG);
  const enrol = await central.register({ email, password, name: u.name });
  console.log(enrol.ok ? 'Enrolled ' + email + ' with My Apps'
    : 'Could not enrol ' + email + ' with My Apps: ' + enrol.error);
  issueSchedulerSession(res, u);
  res.json({ ok: true });
});
app.post('/api/logout', (_req, res) => { res.clearCookie('tok'); res.json({ ok: true }); });

/* ---------------- forgot / reset password ---------------- */
app.post('/api/forgot', async (req, res) => {
  const email = ((req.body || {}).email || '').trim();
  const u = email && await q.userByEmail.get(email);
  if (u && emailEnabled()) {
    try {
      const token = jwt.sign({ reset: u.id }, SECRET, { expiresIn: '30m' });
      const link = await userLink(req, u, '?reset=' + token);
      await sendEmail(u.email, 'Reset your School Scheduler password',
        `<p>Hi ${u.name},</p><p>Tap the link below to set a new password (valid 30 minutes):</p>
         <p><a href="${link}">Reset my password</a></p>
         <p style="color:#667;font-size:12px">If the button doesn't work, copy this address into your browser:<br>${link}</p>
         <p>If you didn't ask for this, you can ignore this email.</p>`);
      return res.json({ ok: true, sent: true, message: 'Check your email for a reset link (valid 30 minutes).' });
    } catch (e) { console.error(e); /* fall through to manual guidance */ }
  }
  if (u && !emailEnabled() && u.role === 'admin') {
    await db.prepare('INSERT INTO support_messages(school_id,user_id,message) VALUES(?,?,?)')
      .run(u.school_id, u.id, `PASSWORD RESET REQUEST — admin ${u.name} <${u.email}> asked to reset their password.`);
    notify(`🔐 Password reset requested by admin ${u.name} <${u.email}>`);
  }
  /* generic response: no email-service configured, or unknown address (don't reveal which) */
  res.json({ ok: true, sent: false,
    message: 'Students & teachers: ask your school administrator to reset your password. ' +
             'School administrators: your reset request has been sent to support.' });
});

app.post('/api/reset', async (req, res) => {
  const { token, password } = req.body || {};
  if (!password || password.length < 4) return res.status(400).json({ error: 'Pick a longer password.' });
  try {
    const p = jwt.verify(token, SECRET);
    if (!p.reset) throw 0;
    const u = await q.user.get(p.reset);
    if (!u) throw 0;
    await db.prepare('UPDATE users SET pass_hash=? WHERE id=?').run(bcrypt.hashSync(password, 10), u.id);
    /* They proved they own the mailbox, so this is their password everywhere. */
    centralReset(u.email, password, u.name);
    /* sign them straight in — they just proved they own the mailbox */
    res.cookie('tok', jwt.sign({ uid: u.id }, SECRET, { expiresIn: '30d' }),
      { httpOnly: true, sameSite: 'lax', maxAge: 30 * 864e5 });
    const school = await q.school.get(u.school_id);
    res.json({ ok: true, signedIn: true, role: u.role, name: u.name,
      slug: school ? school.slug : null,
      message: `Password saved — welcome, ${u.name}.` });
  } catch { res.status(400).json({ error: 'That reset link is invalid or expired. Request a new one.' }); }
});

/* Practice sandbox.
   Entering swaps your session to the demo school's admin and remembers who you
   really are in a separate cookie, so leaving puts you back exactly where you
   were — no logging out, no touching your real school's data.                 */
app.post('/api/sandbox/enter', auth(), async (req, res) => {
  const demo = await db.prepare("SELECT * FROM schools WHERE slug='demo'").get();
  if (!demo) return res.status(404).json({ error: 'The practice school is not available on this instance.' });
  if (req.user.school_id === demo.id) return res.status(400).json({ error: 'You are already in the practice school.' });
  const demoAdmin = await db.prepare("SELECT * FROM users WHERE school_id=? AND role='admin' ORDER BY id LIMIT 1").get(demo.id);
  if (!demoAdmin) return res.status(404).json({ error: 'The practice school has no admin account.' });
  res.cookie('home', jwt.sign({ uid: req.user.id }, SECRET, { expiresIn: '1d' }),
    { httpOnly: true, sameSite: 'lax', maxAge: 864e5 });
  res.cookie('tok', jwt.sign({ uid: demoAdmin.id }, SECRET, { expiresIn: '1d' }),
    { httpOnly: true, sameSite: 'lax', maxAge: 864e5 });
  res.json({ ok: true, slug: demo.slug });
});

app.post('/api/sandbox/exit', async (req, res) => {
  try {
    const { uid } = jwt.verify(req.cookies.home || '', SECRET);
    const u = await q.user.get(uid);
    if (!u) throw 0;
    const school = await q.school.get(u.school_id);
    res.clearCookie('home');
    res.cookie('tok', jwt.sign({ uid: u.id }, SECRET, { expiresIn: '30d' }),
      { httpOnly: true, sameSite: 'lax', maxAge: 30 * 864e5 });
    const usage = await planUsage(u.school_id);
    res.json({ ok: true, slug: school ? school.slug : '', school: school ? school.name : '',
      plan: usage.plan, atLimit: usage.plan === 'free' });
  } catch { res.status(400).json({ error: 'No practice session to leave.' }); }
});

app.get('/api/me', auth(), async (req, res) => {
  const { pass_hash, ...u } = req.user;
  let sandbox = null;
  try {
    const { uid } = jwt.verify(req.cookies.home || '', SECRET);
    const home = await q.user.get(uid);
    if (home) {
      const hs = await q.school.get(home.school_id);
      sandbox = { home: hs ? hs.name : 'your school', slug: hs ? hs.slug : '' };
    }
  } catch (_) { /* not in a practice session */ }
  const school = await q.school.get(u.school_id);
  res.json({ ...u, school, settings: await q.settings.get(u.school_id),
    sandbox, isDemo: !!(school && school.slug === 'demo') });
});

/* ---------------- student ---------------- */
app.get('/api/student/calendar', auth(['student']), approvedOnly, async (req, res) => {
  const st = await q.settings.get(req.user.school_id);
  const from = req.query.from || todayISO();
  const dTo = new Date(from); dTo.setDate(dTo.getDate() + (Number(req.query.days) || st.window_days) - 1);
  const to = dTo.toISOString().slice(0, 10);
  const programs = await db.prepare(
    `SELECT p.*, u.name teacher FROM programs p LEFT JOIN users u ON u.id=p.teacher_id WHERE p.school_id=?`
  ).all(req.user.school_id);
  const mine = await db.prepare(
    "SELECT * FROM reservations WHERE student_id=? AND status IN ('reserved','waitlist')").all(req.user.id);
  const byKey = {}; mine.forEach(r => byKey[r.program_id + '|' + r.date] = r);
  const days = {};
  for (const p of programs)
    for (const date of programDates(p, from, to)) {
      const reserved = (await q.reservedCount.get(p.id, date)).c;
      const r = byKey[p.id + '|' + date];
      (days[date] = days[date] || []).push({
        program_id: p.id, name: p.name, emoji: p.emoji, type: p.type, room: p.room,
        time_start: p.time_start, time_end: p.time_end, teacher: p.teacher,
        capacity: p.capacity, reserved, open: p.capacity - reserved,
        mine: r ? r.status : null, waitlist: (await q.waitCount.get(p.id, date)).c,
      });
    }
  Object.values(days).forEach(a => a.sort((x, y) => x.time_start.localeCompare(y.time_start)));
  res.json({ from, to, days, stats: await attendanceStats(req.user.id), settings: st });
});

app.post('/api/student/reserve', auth(['student']), approvedOnly, async (req, res) => {
  const { program_id, date } = req.body || {};
  const p = await q.program.get(program_id);
  if (!p || p.school_id !== req.user.school_id) return res.status(404).json({ error: 'Program not found.' });
  if (date < todayISO()) return res.status(400).json({ error: 'That date is in the past.' });
  const st = await q.settings.get(req.user.school_id);
  const max = new Date(); max.setDate(max.getDate() + st.window_days - 1);
  if (date > max.toISOString().slice(0, 10))
    return res.status(400).json({ error: `You can only reserve within the next ${st.window_days} days.` });
  if (!programDates(p, date, date).length) return res.status(400).json({ error: 'Program does not meet that day.' });
  if (await q.myRes.get(req.user.id, date) && await db.prepare(
    "SELECT 1 x FROM reservations WHERE student_id=? AND program_id=? AND date=? AND status IN ('reserved','waitlist')")
    .get(req.user.id, program_id, date))
    return res.status(409).json({ error: 'You already have a spot or waitlist place for this session.' });

  // overlap guard against other reserved sessions that day
  const others = await db.prepare(
    `SELECT r.*, p2.name, p2.time_start ts, p2.time_end te FROM reservations r JOIN programs p2 ON p2.id=r.program_id
     WHERE r.student_id=? AND r.date=? AND r.status='reserved' AND r.program_id<>?`).all(req.user.id, date, program_id);
  for (const o of others)
    if (overlaps(p.time_start, p.time_end, o.ts, o.te))
      return res.status(409).json({ error: `Schedule conflict: overlaps ${o.name} (${o.ts}–${o.te}). Cancel that first.` });

  const full = (await q.reservedCount.get(p.id, date)).c >= p.capacity;
  const belowThreshold = (await attendanceStats(req.user.id)).pct < st.threshold;
  if (!full && belowThreshold && st.limitation === 'waitlist_only')
    return res.status(403).json({ error: `Your attendance is below ${st.threshold}% — you can only join waitlists until it improves.` });

  const status = full ? 'waitlist' : 'reserved';
  await db.prepare(`INSERT INTO reservations(program_id,student_id,date,status) VALUES(?,?,?,?)
     ON CONFLICT (program_id, student_id, date) DO UPDATE SET status=EXCLUDED.status`)
    .run(program_id, req.user.id, date, status);
  res.json({ ok: true, status, position: full ? (await q.waitCount.get(p.id, date)).c : null });
});

app.post('/api/student/cancel', auth(['student']), approvedOnly, async (req, res) => {
  const { program_id, date } = req.body || {};
  const r = await db.prepare(
    "SELECT * FROM reservations WHERE student_id=? AND program_id=? AND date=? AND status IN ('reserved','waitlist')")
    .get(req.user.id, program_id, date);
  if (!r) return res.status(404).json({ error: 'No reservation found.' });
  await db.prepare("UPDATE reservations SET status='cancelled' WHERE id=?").run(r.id);
  let promoted = null;
  const st = await q.settings.get(req.user.school_id);
  if (r.status === 'reserved' && st.autopromote) {
    const next = await db.prepare(
      "SELECT * FROM reservations WHERE program_id=? AND date=? AND status='waitlist' ORDER BY created LIMIT 1")
      .get(program_id, date);
    if (next) {
      await db.prepare("UPDATE reservations SET status='reserved' WHERE id=?").run(next.id);
      promoted = (await q.user.get(next.student_id)).name;
    }
  }
  res.json({ ok: true, promoted });
});

app.get('/api/student/history', auth(['student']), approvedOnly, async (req, res) => {
  const rows = await db.prepare(
    `SELECT r.date, r.attended, p.name, p.emoji, p.time_start, p.time_end FROM reservations r
     JOIN programs p ON p.id=r.program_id
     WHERE r.student_id=? AND r.status='reserved' AND r.date<? ORDER BY r.date DESC LIMIT 60`)
    .all(req.user.id, todayISO());
  res.json({ history: rows, stats: await attendanceStats(req.user.id) });
});

/* ---------------- teacher ---------------- */
app.get('/api/teacher/calendar', auth(['teacher']), approvedOnly, async (req, res) => {
  const from = req.query.from || todayISO();
  const dTo = new Date(from); dTo.setDate(dTo.getDate() + 13);
  const to = dTo.toISOString().slice(0, 10);
  const programs = await db.prepare('SELECT * FROM programs WHERE teacher_id=?').all(req.user.id);
  const days = {};
  for (const p of programs)
    for (const date of programDates(p, from, to)) {
      const reserved = (await q.reservedCount.get(p.id, date)).c;
      const marked = (await db.prepare(
        "SELECT COUNT(*)::int c FROM reservations WHERE program_id=? AND date=? AND status='reserved' AND attended IS NOT NULL")
        .get(p.id, date)).c;
      (days[date] = days[date] || []).push({
        program_id: p.id, name: p.name, emoji: p.emoji, room: p.room,
        time_start: p.time_start, time_end: p.time_end, capacity: p.capacity,
        reserved, waitlist: (await q.waitCount.get(p.id, date)).c, attendanceDone: marked > 0 && marked >= reserved,
      });
    }
  Object.values(days).forEach(a => a.sort((x, y) => x.time_start.localeCompare(y.time_start)));
  res.json({ from, to, days, programs: programs.map(p => p.name) });
});

app.get('/api/teacher/roster', auth(['teacher', 'admin']), approvedOnly, async (req, res) => {
  const { program_id, date } = req.query;
  const p = await q.program.get(program_id);
  if (!p) return res.status(404).json({ error: 'Program not found.' });
  if (req.user.role === 'teacher' && p.teacher_id !== req.user.id)
    return res.status(403).json({ error: 'Not your program.' });
  const roster = await db.prepare(
    `SELECT r.id res_id, r.status, r.attended, u.id student_id, u.name, u.grade, u.student_id id_number FROM reservations r
     JOIN users u ON u.id=r.student_id WHERE r.program_id=? AND r.date=? AND r.status IN ('reserved','waitlist')
     ORDER BY r.status DESC, r.created`).all(program_id, date);
  for (const r of roster) r.attendance_pct = (await attendanceStats(r.student_id)).pct;
  res.json({ program: p.name, capacity: p.capacity, date, roster });
});

app.post('/api/teacher/attendance', auth(['teacher']), approvedOnly, async (req, res) => {
  const { program_id, date, records } = req.body || {};
  const p = await q.program.get(program_id);
  if (!p || p.teacher_id !== req.user.id) return res.status(403).json({ error: 'Not your program.' });
  if (!Array.isArray(records) || !records.length) return res.status(400).json({ error: 'No records.' });
  const upd = db.prepare(
    "UPDATE reservations SET attended=? WHERE program_id=? AND student_id=? AND date=? AND status='reserved'");
  await db.transaction(async () => {
    for (const r of records) {
      await upd.run(r.present ? 1 : 0, program_id, r.student_id, date);
    }
  });
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

app.post('/api/admin/upgrade', ...adm, async (req, res) => {
  const code = ((req.body || {}).code || '').trim().toUpperCase();
  // permanent code
  if (code === UPGRADE_CODE.toUpperCase()) {
    await db.prepare("UPDATE schools SET plan='pro', plan_expires='' WHERE id=?").run(req.user.school_id);
    return res.json({ ok: true, message: 'Upgraded! Unlimited classes, teachers, and students are now enabled.' });
  }
  // signed trial code: PRO-<days>D-<nonce>-<sig>
  const m = code.match(/^PRO-(\d{1,4})D-([A-Z0-9]{4,12})-([A-F0-9]{6})$/);
  if (m) {
    const [, days, nonce, sig] = m;
    if (trialSig(days, nonce) !== sig)
      return res.status(400).json({ error: 'That upgrade code is not valid. Contact support to purchase a subscription.' });
    if (await db.prepare('SELECT 1 x FROM redeemed_codes WHERE code=?').get(code))
      return res.status(400).json({ error: 'That code has already been used.' });
    const exp = new Date(); exp.setDate(exp.getDate() + Number(days));
    const expISO = exp.toISOString().slice(0, 10);
    await db.prepare('INSERT INTO redeemed_codes(code,school_id) VALUES(?,?)').run(code, req.user.school_id);
    await db.prepare("UPDATE schools SET plan='pro', plan_expires=? WHERE id=?").run(expISO, req.user.school_id);
    return res.json({ ok: true, message: `Unlimited unlocked for ${days} days — active until ${expISO}. After that, the school returns to the free plan automatically.` });
  }
  res.status(400).json({ error: 'That upgrade code is not valid. Contact support to purchase a subscription.' });
});

app.get('/api/admin/overview', ...adm, async (req, res) => {
  const sid = req.user.school_id;
  const pending = (await db.prepare("SELECT COUNT(*)::int c FROM users WHERE school_id=? AND status='pending'").get(sid)).c;
  const reservations = (await db.prepare(
    `SELECT COUNT(*)::int c FROM reservations r JOIN programs p ON p.id=r.program_id
     WHERE p.school_id=? AND r.status='reserved' AND r.date>=?`).get(sid, todayISO())).c;
  const att = (await db.prepare(
    `SELECT (AVG(r.attended)*100)::float a FROM reservations r JOIN programs p ON p.id=r.program_id
     WHERE p.school_id=? AND r.attended IS NOT NULL`).get(sid)).a;
  res.json({ pending, reservations, attendance: att === null ? null : Math.round(att), usage: await planUsage(sid) });
});

app.get('/api/admin/pending', ...adm, async (req, res) => {
  res.json(await db.prepare(
    "SELECT id,role,name,email,grade,student_id,id_photo,created FROM users WHERE school_id=? AND status='pending' ORDER BY created")
    .all(req.user.school_id));
});
app.post('/api/admin/approve', ...adm, async (req, res) => {
  const { user_id, approve } = req.body || {};
  const u = await q.user.get(user_id);
  if (!u || u.school_id !== req.user.school_id) return res.status(404).json({ error: 'User not found.' });
  if (approve) {
    const block = await planBlocked(req.user.school_id, u.role === 'teacher' ? 'teachers' : 'students', 'approve');
    if (block) return res.status(403).json({ error: block, upgrade: true });
  }
  await db.prepare('UPDATE users SET status=? WHERE id=?').run(approve ? 'approved' : 'rejected', user_id);

  /* tell them — being approved in silence is indistinguishable from being ignored */
  let emailed = false;
  if (approve && emailEnabled()) {
    const school = await q.school.get(req.user.school_id);
    const link = appBase(req) + (school && school.slug ? '/' + school.slug : '/');
    try {
      await sendEmail(u.email, `You're approved at ${school ? school.name : 'your school'}`,
        `<p>Hi ${u.name},</p>
         <p>Your account at <b>${school ? school.name : 'your school'}</b> has been approved${u.role === 'teacher' ? ' — your classes are ready for you' : ' — you can start reserving classes and afterschool programs'}.</p>
         <p><a href="${link}">Open ${school ? school.name : 'the scheduler'}</a></p>
         <p style="color:#667;font-size:12px">Sign in with the email and password you chose when you signed up.<br>${link}</p>`);
      emailed = true;
    } catch (e) { console.error('approval email failed for', u.email, '—', e.message); }
  }
  res.json({ ok: true, emailed });
});

app.get('/api/admin/users', ...adm, async (req, res) => {
  const rows = await db.prepare(
    "SELECT id,role,name,email,grade,student_id,status FROM users WHERE school_id=? ORDER BY role,name").all(req.user.school_id);
  for (const r of rows.filter(r => r.role === 'student')) {
    r.attendance_pct = (await attendanceStats(r.id)).pct;
  }
  res.json(rows);
});
app.put('/api/admin/users/:id', ...adm, async (req, res) => {
  const u = await q.user.get(req.params.id);
  if (!u || u.school_id !== req.user.school_id) return res.status(404).json({ error: 'User not found.' });
  const { name, grade, status } = req.body || {};
  if (status === 'approved' && u.status !== 'approved') {
    const block = await planBlocked(req.user.school_id, u.role === 'teacher' ? 'teachers' : 'students');
    if (block) return res.status(403).json({ error: block, upgrade: true });
  }
  await db.prepare('UPDATE users SET name=COALESCE(?,name), grade=COALESCE(?,grade), status=COALESCE(?,status) WHERE id=?')
    .run(name, grade, status, u.id);
  res.json({ ok: true });
});
/* ---------------- roster building: add one · import a list · invite ------- */
/* Admin-created people are pre-approved (the admin vouches for them) and have no
   password until they accept an invite or the admin hands them a temp one.      */
async function createPerson(schoolId, role, row) {
  const name = String(row.name || '').trim();
  const email = String(row.email || '').trim();
  if (!name && !email) return { skipped: 'blank row' };
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return { skipped: `no valid email (${name || 'unnamed'})` };
  if (await q.userByEmail.get(email)) return { skipped: `${email} already has an account` };
  const sid = String(row.student_id || '').trim();
  if (role === 'student' && sid && await db.prepare(
    "SELECT 1 x FROM users WHERE school_id=? AND role='student' AND student_id=? AND student_id<>''").get(schoolId, sid))
    return { skipped: `Student ID ${sid} already registered` };
  const temp = tempPassword();
  const r = await db.prepare(`INSERT INTO users(school_id,role,name,email,pass_hash,grade,student_id,status)
    VALUES(?,?,?,?,?,?,?, 'approved')`)
    .run(schoolId, role, name || email.split('@')[0], email, bcrypt.hashSync(temp, 10),
      String(row.grade || '').trim(), role === 'student' ? sid : '');
  centralEnrol(email, temp, name || email.split('@')[0]);
  return { id: r.lastInsertRowid, name: name || email.split('@')[0], email, temp };
}
let INVITE_REQ = null;   // set just before invites so links use the real host
async function sendInvite(user, schoolName, whoAdded) {
  const token = jwt.sign({ reset: user.id }, SECRET, { expiresIn: '14d' });
  const link = INVITE_REQ ? await userLink(INVITE_REQ, user, '?reset=' + token)
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
  const block = await planBlocked(req.user.school_id, role === 'teacher' ? 'teachers' : 'students');
  if (block) return res.status(403).json({ error: block, upgrade: true });
  const made = await createPerson(req.user.school_id, role, b);
  if (made.skipped) return res.status(409).json({ error: made.skipped });
  let invited = false, mailError = '';
  if (b.invite !== false && emailEnabled()) {
    try {
      INVITE_REQ = req;
      await sendInvite({ ...made, role, school_id: req.user.school_id }, (await q.school.get(req.user.school_id)).name, req.user.name);
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

  const usage = await planUsage(req.user.school_id);
  const cap = usage.limits ? (role === 'teacher' ? usage.limits.teachers - usage.teachers
    : usage.limits.students - usage.students) : Infinity;

  const added = [], skipped = [];
  let blockedByPlan = 0;
  for (const row of rows) {
    if (added.length >= cap) { blockedByPlan++; continue; }
    const made = await createPerson(req.user.school_id, role, row);
    if (made.skipped) skipped.push(made.skipped); else added.push(made);
  }
  let invited = 0, mailError = '';
  const willEmail = b.invite !== false && emailEnabled() && added.length > 0;
  if (willEmail) {
    /* fire these off after we reply — 30 invites must not hold the page hostage */
    const school = (await q.school.get(req.user.school_id)).name;
    const host = req.get('host'), by = req.user.name, sid = req.user.school_id;
    setImmediate(async () => {
      for (const p of added) {
        try {
          INVITE_REQ = { get: () => host };
          await sendInvite({ ...p, role, school_id: sid }, school, by);
        } catch (e) { console.error('invite failed for', p.email, '—', e.message); }
      }
    });
    invited = added.length;   /* queued; the email log records what actually happened */
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
app.post('/api/admin/people/preview', ...adm, async (req, res) => {
  const rows = parseRoster(String((req.body || {}).text || ''));
  const seen = new Set();
  const marked = [];
  for (const r of rows) {
    const problem = !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(r.email || '') ? 'no valid email'
      : await q.userByEmail.get(r.email) ? 'already has an account'
        : seen.has(r.email.toLowerCase()) ? 'duplicate in this list' : '';
    if (r.email) seen.add(r.email.toLowerCase());
    marked.push({ ...r, problem });
  }
  res.json({ rows: marked, ok: marked.filter(r => !r.problem).length, problems: marked.filter(r => r.problem).length });
});

/* Remove people in bulk. Students lose their reservations; teachers are unassigned
   from their programs (the programs survive, just without a teacher).            */
app.post('/api/admin/people/remove', ...adm, async (req, res) => {
  const ids = (req.body || {}).ids;
  if (!Array.isArray(ids) || !ids.length) return res.status(400).json({ error: 'Nobody selected.' });
  if (ids.length > 500) return res.status(400).json({ error: 'Too many at once — do it in batches of 500.' });
  const people = [];
  for (const id of ids) {
    const u = await q.user.get(id);
    if (u && u.school_id === req.user.school_id && u.role !== 'admin') people.push(u);
  }
  if (!people.length) return res.status(400).json({ error: 'Nothing removable in that selection.' });

  let unassigned = 0, reservations = 0;
  await db.transaction(async () => {
    for (const u of people) {
      if (u.role === 'teacher') {
        unassigned += (await db.prepare('UPDATE programs SET teacher_id=NULL WHERE teacher_id=? AND school_id=?')
          .run(u.id, req.user.school_id)).changes;
      } else {
        reservations += (await db.prepare('DELETE FROM reservations WHERE student_id=?').run(u.id)).changes;
      }
      await db.prepare('DELETE FROM users WHERE id=?').run(u.id);
    }
  });
  const kind = people[0].role === 'teacher' ? 'teacher' : 'student';
  res.json({
    ok: true, removed: people.length, unassigned, reservations,
    message: `${people.length} ${kind}${people.length === 1 ? '' : 's'} removed` +
      (unassigned ? ` · ${unassigned} program${unassigned === 1 ? '' : 's'} left without a teacher` : '') +
      (reservations ? ` · ${reservations} reservation${reservations === 1 ? '' : 's'} deleted` : '') + '.',
  });
});

app.post('/api/admin/resetpw', ...adm, async (req, res) => {
  const u = await q.user.get((req.body || {}).user_id);
  if (!u || u.school_id !== req.user.school_id || u.role === 'admin')
    return res.status(400).json({ error: 'Cannot reset that account here.' });
  const temp = tempPassword();
  await db.prepare('UPDATE users SET pass_hash=? WHERE id=?').run(bcrypt.hashSync(temp, 10), u.id);
  centralReset(u.email, temp, u.name);
  res.json({ ok: true, name: u.name, temp });
});

app.delete('/api/admin/users/:id', ...adm, async (req, res) => {
  const u = await q.user.get(req.params.id);
  if (!u || u.school_id !== req.user.school_id || u.role === 'admin')
    return res.status(400).json({ error: 'Cannot delete this user.' });
  await db.prepare('DELETE FROM users WHERE id=?').run(u.id);
  if (u.role === 'teacher') await db.prepare('UPDATE programs SET teacher_id=NULL WHERE teacher_id=?').run(u.id);
  else await db.prepare('DELETE FROM reservations WHERE student_id=?').run(u.id);
  res.json({ ok: true });
});

app.get('/api/admin/programs', ...adm, async (req, res) => {
  res.json(await db.prepare(
    `SELECT p.*, u.name teacher FROM programs p LEFT JOIN users u ON u.id=p.teacher_id
     WHERE p.school_id=? ORDER BY p.name`).all(req.user.school_id));
});
app.post('/api/admin/programs', ...adm, async (req, res) => {
  const block = await planBlocked(req.user.school_id, 'programs');
  if (block) return res.status(403).json({ error: block, upgrade: true });
  const b = req.body || {};
  for (const k of ['name', 'type', 'days', 'time_start', 'time_end', 'date_start', 'date_end'])
    if (!b[k]) return res.status(400).json({ error: `Missing ${k}.` });
  const r = await db.prepare(
    `INSERT INTO programs(school_id,name,type,teacher_id,room,capacity,days,time_start,time_end,date_start,date_end,emoji)
     VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`)
    .run(req.user.school_id, b.name, b.type, b.teacher_id || null, b.room || '', b.capacity || 20,
      b.days, b.time_start, b.time_end, b.date_start, b.date_end, b.emoji || '📚');
  res.json({ ok: true, id: r.lastInsertRowid });
});
app.put('/api/admin/programs/:id', ...adm, async (req, res) => {
  const p = await q.program.get(req.params.id);
  if (!p || p.school_id !== req.user.school_id) return res.status(404).json({ error: 'Program not found.' });
  const b = req.body || {};
  await db.prepare(
    `UPDATE programs SET name=COALESCE(?,name), type=COALESCE(?,type), teacher_id=COALESCE(?,teacher_id),
     room=COALESCE(?,room), capacity=COALESCE(?,capacity), days=COALESCE(?,days),
     time_start=COALESCE(?,time_start), time_end=COALESCE(?,time_end),
     date_start=COALESCE(?,date_start), date_end=COALESCE(?,date_end), emoji=COALESCE(?,emoji) WHERE id=?`)
    .run(b.name, b.type, b.teacher_id, b.room, b.capacity, b.days, b.time_start, b.time_end,
      b.date_start, b.date_end, b.emoji, p.id);
  res.json({ ok: true });
});
app.delete('/api/admin/programs/:id', ...adm, async (req, res) => {
  const p = await q.program.get(req.params.id);
  if (!p || p.school_id !== req.user.school_id) return res.status(404).json({ error: 'Program not found.' });
  await db.prepare('DELETE FROM programs WHERE id=?').run(p.id);
  await db.prepare('DELETE FROM reservations WHERE program_id=?').run(p.id);
  res.json({ ok: true });
});

app.get('/api/admin/gettingstarted', ...adm, async (req, res) => {
  const school = await q.school.get(req.user.school_id);
  const isDemo = school && school.slug === 'demo';
  const base = appBase(req);
  res.json({
    school: school ? school.name : '', slug: school ? school.slug : '',
    link: base + '/' + (school ? school.slug : ''),
    isDemo,
    /* test logins are only meaningful — and only shown — on the demo school */
    accounts: isDemo ? DEMO_ACCOUNTS.map(a => ({ role: a.role, email: a.email, password: DEMO_PASSWORD })) : [],
    counts: {
      programs: (await db.prepare('SELECT COUNT(*)::int c FROM programs WHERE school_id=?').get(req.user.school_id)).c,
      students: (await db.prepare("SELECT COUNT(*)::int c FROM users WHERE school_id=? AND role='student' AND status='approved'").get(req.user.school_id)).c,
      teachers: (await db.prepare("SELECT COUNT(*)::int c FROM users WHERE school_id=? AND role='teacher' AND status='approved'").get(req.user.school_id)).c,
      reservations: (await db.prepare(`SELECT COUNT(*)::int c FROM reservations r JOIN programs p ON p.id=r.program_id
        WHERE p.school_id=? AND r.status='reserved'`).get(req.user.school_id)).c,
      attendance: (await db.prepare(`SELECT COUNT(*)::int c FROM reservations r JOIN programs p ON p.id=r.program_id
        WHERE p.school_id=? AND r.attended IS NOT NULL`).get(req.user.school_id)).c,
    },
  });
});

app.get('/api/admin/settings', ...adm, async (req, res) => res.json(await q.settings.get(req.user.school_id)));
app.put('/api/admin/settings', ...adm, async (req, res) => {
  const b = req.body || {};
  await db.prepare(
    `UPDATE settings SET window_days=COALESCE(?,window_days), threshold=COALESCE(?,threshold),
     limitation=COALESCE(?,limitation), autopromote=COALESCE(?,autopromote) WHERE school_id=?`)
    .run(b.window_days, b.threshold, b.limitation, b.autopromote, req.user.school_id);
  res.json({ ok: true });
});

app.put('/api/admin/school', ...adm, async (req, res) => {
  const { name, subtitle } = req.body || {};
  await db.prepare('UPDATE schools SET name=COALESCE(?,name), subtitle=COALESCE(?,subtitle) WHERE id=?')
    .run(name, subtitle, req.user.school_id);
  res.json({ ok: true });
});

app.post('/api/admin/photos', ...adm, async (req, res) => {
  const { caption, data } = req.body || {};
  if (!data || !data.startsWith('data:image')) return res.status(400).json({ error: 'Send a data:image URL.' });
  if (data.length > 4e6) return res.status(400).json({ error: 'Image too large (max ~3MB).' });
  const r = await db.prepare('INSERT INTO photos(school_id,caption,data) VALUES(?,?,?)')
    .run(req.user.school_id, caption || '', data);
  res.json({ ok: true, id: r.lastInsertRowid });
});
app.delete('/api/admin/photos/:id', ...adm, async (req, res) => {
  await db.prepare('DELETE FROM photos WHERE id=? AND school_id=?').run(req.params.id, req.user.school_id);
  res.json({ ok: true });
});

/* ---------------- support (school admins → owner) ---------------- */
app.post('/api/support', auth(['admin']), approvedOnly, async (req, res) => {
  const msg = ((req.body || {}).message || '').trim();
  if (!msg) return res.status(400).json({ error: 'Write a message first.' });
  if (msg.length > 4000) return res.status(400).json({ error: 'Message too long.' });
  await db.prepare('INSERT INTO support_messages(school_id,user_id,message) VALUES(?,?,?)')
    .run(req.user.school_id, req.user.id, msg);
  const school = await q.school.get(req.user.school_id);
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

app.get('/api/owner/overview', ownerAuth, async (_req, res) => {
  const schools = await db.prepare(`
    SELECT s.id, s.name, s.slug, s.plan, s.plan_expires, s.created,
      (SELECT COUNT(*)::int FROM programs p WHERE p.school_id=s.id) programs,
      (SELECT COUNT(*)::int FROM users u WHERE u.school_id=s.id AND u.role='teacher' AND u.status='approved') teachers,
      (SELECT COUNT(*)::int FROM users u WHERE u.school_id=s.id AND u.role='student' AND u.status='approved') students,
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
  const support = await db.prepare(`
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
app.get('/api/owner/setup', ownerAuth, async (req, res) => {
  const base = process.env.APP_URL || `${req.protocol}://${req.get('host')}`;
  const demoSchool = await db.prepare("SELECT * FROM schools WHERE slug='demo'").get();
  const demoAccounts = [
    { role: 'School admin', email: 'admin@demo.school', password: 'admin123' },
    { role: 'Teacher', email: 'rivera@demo.school', password: 'teach123' },
    { role: 'Student', email: 'maya@demo.school', password: 'learn123' },
  ];
  for (const a of demoAccounts) a.exists = !!await q.userByEmail.get(a.email);
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

app.get('/api/owner/emailstatus', ownerAuth, async (_req, res) => {
  const log = await db.prepare('SELECT * FROM email_log ORDER BY created DESC LIMIT 25').all();
  res.json({
    enabled: emailEnabled(), via: mailer ? 'gmail' : (RESEND_KEY ? 'resend' : null),
    from: GMAIL_USER || EMAIL_FROM || null,
    lastError: LAST_EMAIL_ERROR || '',
    sent24h: (await db.prepare("SELECT COUNT(*)::int c FROM email_log WHERE ok=1 AND created>=datetime('now','-1 day')").get()).c,
    failed24h: (await db.prepare("SELECT COUNT(*)::int c FROM email_log WHERE ok=0 AND created>=datetime('now','-1 day')").get()).c,
    log,
  });
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

app.post('/api/owner/resetpw', ownerAuth, async (req, res) => {
  const admin = await db.prepare("SELECT * FROM users WHERE school_id=? AND role='admin' ORDER BY id LIMIT 1")
    .get((req.body || {}).school_id);
  if (!admin) return res.status(404).json({ error: 'No admin account found for that school.' });
  const temp = tempPassword();
  await db.prepare('UPDATE users SET pass_hash=? WHERE id=?').run(bcrypt.hashSync(temp, 10), admin.id);
  centralReset(admin.email, temp, admin.name);
  res.json({ ok: true, name: admin.name, email: admin.email, temp });
});

app.post('/api/owner/support/:id/close', ownerAuth, async (req, res) => {
  await db.prepare("UPDATE support_messages SET status='closed' WHERE id=?").run(req.params.id);
  res.json({ ok: true });
});

/* ---------------- partner API (read-only, for Int-AI-lisoft HQ) ------------ */
const PARTNER_KEY = process.env.PARTNER_KEY || '';
app.get('/api/partner/summary', async (req, res) => {
  if (!PARTNER_KEY || req.get('X-Partner-Key') !== PARTNER_KEY)
    return res.status(401).json({ error: 'bad partner key' });
  const week = new Date(Date.now() - 7 * 864e5).toISOString().slice(0, 19).replace('T', ' ');
  const schools = await db.prepare('SELECT id, plan, plan_expires, created FROM schools').all();
  res.json({
    app: 'After-School Scheduler', company: 'Int-AI-lisoft', at: new Date().toISOString(),
    kpis: {
      schools: schools.length,
      trialsWeek: schools.filter(s => (s.created || '') >= week).length,
      activeTrials: schools.filter(s => s.plan === 'pro' && s.plan_expires).length,
      subscribers: schools.filter(s => s.plan === 'pro' && !s.plan_expires).length,
      students: (await db.prepare("SELECT COUNT(*)::int c FROM users WHERE role='student' AND status='approved'").get()).c,
      users: (await db.prepare('SELECT COUNT(*)::int c FROM users').get()).c,
      openSupport: (await db.prepare("SELECT COUNT(*)::int c FROM support_messages WHERE status='open'").get()).c,
    },
    services: { email: emailEnabled(), stripe: !!(stripe && STRIPE_PRICE) },
  });
});

/* ---------------- static ---------------- */
const PUBLIC_FILES = ['sw.js', 'icon-192.png', 'icon-512.png', 'apple-touch-icon.png'];
PUBLIC_FILES.forEach(f => app.get('/' + f, (_req, res) => res.sendFile(path.join(__dirname, f))));

/* The manifest is generated per page. Saving /office to the home screen should
   reopen /office — a fixed start_url sent everyone back to the storefront.     */
app.get('/manifest.webmanifest', async (req, res) => {
  const raw = String(req.query.start || '/').split('?')[0];
  const seg = raw.replace(/^\/+|\/+$/g, '').toLowerCase();
  let start = '/', name = 'School Scheduler', short = 'Scheduler';
  if (seg === 'office' || seg === 'owner') {
    start = '/' + seg; name = 'Scheduler Office'; short = 'Office';
  } else if (seg) {
    const school = await db.prepare('SELECT name, slug FROM schools WHERE slug=?').get(seg);
    if (school) { start = '/' + school.slug; name = school.name; short = school.name.slice(0, 12); }
  }
  res.type('application/manifest+json').json({
    name, short_name: short, description: 'Classes and afterschool programs.',
    start_url: start, scope: '/', display: 'standalone', orientation: 'portrait',
    background_color: '#EDF2FB', theme_color: '#0B4FD3',
    icons: [
      { src: '/icon-192.png', sizes: '192x192', type: 'image/png' },
      { src: '/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any maskable' },
    ],
  });
});
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
<meta name="theme-color" content="#0B4FD3">
<meta name="apple-mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-status-bar-style" content="default">
<meta name="apple-mobile-web-app-title" content="Scheduler">
<link rel="apple-touch-icon" href="/apple-touch-icon.png">
<style>body{margin:0;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Arial,sans-serif;background:#EDF2FB}</style>
</head>
<body><script src="/ui.js?v=${Date.now()}"></script></body>
</html>`;
const sendApp = (_req, res) => {
  // Loading a page is the earliest warning that somebody is about to sign in,
  // so this is where My Apps gets woken from its free-plan nap.
  central.warm();
  return fs.existsSync(UI_JS) ? res.type('html').send(SHELL) : res.sendFile(path.join(__dirname, 'index.html'));
};
/* ------------------------------------------------------------- privacy --- */
const PRIVACY_PAGE = `<!doctype html><html><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>School Scheduler — Privacy</title>
<style>body{margin:0;padding:28px 18px;background:#EDF2FB;color:#101822;
font:16px/1.65 -apple-system,"Segoe UI",Roboto,Arial,sans-serif}main{max-width:660px;margin:0 auto;
background:#fff;border:1px solid #DBE4F2;border-radius:14px;padding:24px 22px}
h1{font-size:26px;margin:0 0 4px;color:#0B4FD3}
h2{font-size:18px;margin:26px 0 6px;color:#101822}
p,li{margin:8px 0}a{color:#0A3FA8}.d{color:#5A6A80;font-size:14px}</style></head><body><main>
<h1>School Scheduler Privacy Statement</h1>
<p class="d">Last updated 31 August 2026</p>

<h2>Each school's data belongs to that school</h2>
<p>Every school on the Scheduler is separate. Its programs, teachers, students
and reservations are visible only to accounts at that school, and only after the
school's own administrator has approved them.</p>

<h2>Students</h2>
<p>Because many students are minors, this is the part we are most careful with.
A student sign-up asks for a name, grade, student ID and a photo of the school
ID. The photo exists for exactly one purpose: so the school's administrator can
check the person is really their student before approving the account. It is
shown to that school's administrator and to no one else. Students see programs
and their own reservations — never other students' details.</p>

<h2>What the platform operator can see</h2>
<p>The operator's console shows which schools exist, their administrators'
contact details, their plan, and support messages administrators send. It is
not a window into a school's student records; those are worked with through the
school's own screens by the school's own staff.</p>

<h2>What we store</h2>
<ul>
<li><b>Accounts:</b> name, email, and a scrambled (hashed) password that cannot
be read back. The same account works across our connected apps.</li>
<li><b>School records:</b> the programs, schedules and reservations the school
creates.</li>
<li><b>Emails we send:</b> invites and password-reset links go to the address on
the account, and only for those purposes.</li>
</ul>

<h2>Cookies and tracking</h2>
<p>One cookie, used to keep you signed in. No advertising, no trackers, no
analytics, and no data is ever sold or shared for marketing.</p>

<h2>Your choices</h2>
<p>Anyone can change their password at any time; a school administrator can
reset or remove their school's accounts, and removing an account deletes its
reservations. For questions or deletion requests, contact
<a href="mailto:steve.smith@buddyrents.com">steve.smith@buddyrents.com</a>.</p>

<p class="d">If this statement changes, the date above changes with it.</p>
</main></body></html>`;
app.get('/privacy', (_req, res) => res.type('html').send(PRIVACY_PAGE));

app.get(['/owner', '/office'], sendApp);
app.get('/', sendApp);
/* per-school pages: /<slug> serves the app, which reads the slug client-side */
app.get('/:slug', async (req, res) => {
  const exists = await db.prepare('SELECT 1 x FROM schools WHERE slug=?').get(req.params.slug.toLowerCase());
  if (exists) return sendApp(req, res);
  res.redirect('/');
});
app.use((err, _req, res, _next) => { console.error(err); res.status(500).json({ error: 'Server error.' }); });

/* ------------- one-time import from the old SQLite file -------------
 * This app used to keep everything in a file on a Render disk. That disk is
 * still mounted, so the very first boot after the move copies what is in it
 * into Postgres and then never looks again. It only runs when Postgres has no
 * schools at all, so it can never overwrite live data, and a missing file or a
 * missing better-sqlite3 is not an error — it just means there is nothing to
 * bring across.
 *
 * Once you have confirmed the data arrived, the disk can be detached and this
 * function becomes dead weight you are welcome to delete.
 */
/* Rows come from one of two places, and the shape is the same either way:
   a table name pointing at a list of rows. */
async function loadRows(rows, table) {
  for (const row of rows) {
    const cols = Object.keys(row);
    const marks = cols.map((_, i) => '$' + (i + 1)).join(',');
    await pool.query(
      `INSERT INTO ${table}(${cols.join(',')}) VALUES(${marks}) ON CONFLICT DO NOTHING`,
      cols.map(c => row[c]));
  }
}

/* Put every SERIAL counter past the ids just inserted, or the next insert
   collides with an imported row. */
async function advanceSequences() {
  for (const table of ['schools', 'users', 'programs', 'reservations',
                       'photos', 'support_messages', 'email_log']) {
    await pool.query(
      `SELECT setval(pg_get_serial_sequence('${table}','id'),
                     COALESCE((SELECT MAX(id) FROM ${table}), 1))`);
  }
}

/* ------------- one-time import from an exported JSON file -------------
 * When the old service ran on a disk this one cannot see, its data comes across
 * as a file instead: export it from the old service's owner console, drop
 * legacy-data.json in beside this file, and the first boot loads it. Like the
 * SQLite path, it only runs into an empty database.
 */
async function importFromJson() {
  /* Both spellings, because a hyphen does not always survive the trip through
     a phone: the file may arrive as legacydata.json. */
  const file = ['legacy-data.json', 'legacydata.json']
    .map(n => path.join(__dirname, n))
    .find(f => fs.existsSync(f));
  if (!file) return false;

  let doc;
  try { doc = JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch (e) { console.error('legacy-data.json could not be read:', e.message); return false; }
  if (!doc || !doc.tables) { console.error('legacy-data.json has no tables in it.'); return false; }

  const ORDER = ['schools', 'settings', 'users', 'programs', 'reservations',
                 'photos', 'support_messages', 'email_log', 'redeemed_codes'];
  let moved = 0;
  try {
    for (const table of ORDER) {                 // parents before children
      const rows = doc.tables[table];
      if (!Array.isArray(rows) || !rows.length) continue;
      await loadRows(rows, table);
      moved += rows.length;
      console.log(`  imported ${rows.length} row(s) from ${table}`);
    }
    await advanceSequences();
    console.log(`Imported ${moved} row(s) from legacy-data.json (exported ${doc.exported_at || 'unknown date'}).`);
    return true;
  } catch (e) {
    console.error('Import from legacy-data.json failed:', e.message);
    return false;
  }
}

async function importFromSqlite() {
  const existing = await db.prepare('SELECT COUNT(*)::int c FROM schools').get();
  if (Number(existing.c) > 0) return;          // Postgres already has data — leave it alone

  // A JSON export wins: it is the deliberate one, taken off the live service.
  if (await importFromJson()) return;

  const legacyPath = process.env.DB_PATH || path.join(__dirname, 'data', 'app.db');
  if (!fs.existsSync(legacyPath)) return;

  let Sqlite;
  try { Sqlite = require('better-sqlite3'); }
  catch { console.log('Old database file found but better-sqlite3 is not installed — skipping import.'); return; }

  let old;
  try { old = new Sqlite(legacyPath, { readonly: true }); }
  catch (e) { console.error('Could not open the old database file:', e.message); return; }

  /* Parents before children, so every foreign key has something to point at.
     Ids are carried across unchanged — reservations reference programs by id,
     and renumbering would quietly break every one of them. */
  const TABLES = ['schools', 'settings', 'users', 'programs', 'reservations',
                  'photos', 'support_messages', 'email_log', 'redeemed_codes'];
  let moved = 0;
  try {
    for (const table of TABLES) {
      let rows;
      try { rows = old.prepare(`SELECT * FROM ${table}`).all(); }
      catch { continue; }                       // table did not exist in the old file
      if (!rows.length) continue;
      await loadRows(rows, table);
      moved += rows.length;
      console.log(`  imported ${rows.length} row(s) from ${table}`);
    }
    await advanceSequences();
    console.log(`Imported ${moved} row(s) from the old SQLite database.`);
  } catch (e) {
    console.error('Import from the old database failed:', e.message);
  } finally {
    try { old.close(); } catch (_) {}
  }
}

/* ------------- tidying up after the collision -------------
 * A first attempt at this move ran without a schema of its own and left tables
 * loose in `public`, plus two unused columns on ServeTrack's users table. This
 * removes them.
 *
 * Two safety rails, because this is the only destructive code in the file:
 *   - it does nothing unless CLEAN_PUBLIC_STRAYS is set to 1, so it is a
 *     deliberate one-off rather than something that fires on every deploy;
 *   - it refuses to run unless this app's own schema already holds the data,
 *     so it can never drop the only copy of anything.
 * The two columns are safe to drop: they were added by that failed run, they
 * are unused, and ServeTrack names its columns explicitly in every query.
 */
async function cleanPublicStrays() {
  if (process.env.CLEAN_PUBLIC_STRAYS !== '1') return;

  const mine = await db.prepare('SELECT COUNT(*)::int c FROM schools').get();
  if (!mine || Number(mine.c) === 0) {
    console.log('Skipping cleanup: this app has no data of its own yet.');
    return;
  }

  const c = new Client({ connectionString: DATABASE_URL, ssl: SSL });
  await c.connect();
  try {
    for (const t of ['redeemed_codes', 'email_log', 'support_messages', 'photos',
                     'reservations', 'programs', 'settings', 'schools']) {
      const { rowCount } = await c.query(
        `SELECT 1 FROM information_schema.tables
         WHERE table_schema='public' AND table_name=$1`, [t]);
      if (!rowCount) continue;
      await c.query(`DROP TABLE public.${t} CASCADE`);
      console.log(`  dropped stray public.${t}`);
    }
    for (const col of ['student_id', 'id_photo']) {
      const { rowCount } = await c.query(
        `SELECT 1 FROM information_schema.columns
         WHERE table_schema='public' AND table_name='users' AND column_name=$1`, [col]);
      if (!rowCount) continue;
      await c.query(`ALTER TABLE public.users DROP COLUMN ${col}`);
      console.log(`  removed the unused ${col} column from ServeTrack's users table`);
    }
    console.log('Cleanup done — you can unset CLEAN_PUBLIC_STRAYS now.');
  } catch (e) {
    console.error('Cleanup failed (harmless, the strays are just clutter):', e.message);
  } finally {
    await c.end();
  }
}

/* ---------------- boot ----------------
 * Nothing may serve a request before the schema exists, so the listener only
 * opens once the database is ready. If that fails, the process exits rather
 * than accepting traffic it cannot answer — a service that is plainly down is
 * easier to diagnose than one that half works.
 */
async function boot() {
  await ensureSchema();
  await migrate();
  /* The import has to come before anything that writes: it only runs when
     Postgres is empty, and seeding a demo school first would make it look
     occupied and silently skip the real data. */
  await importFromSqlite();
  await backfillSlugs();
  await seedIfEmpty();
  try { await ensureDemo(); } catch (e) { console.error('demo setup:', e.message); }
  try { await cleanPublicStrays(); } catch (e) { console.error('cleanup:', e.message); }
}

boot().then(() => {
  app.listen(PORT, '0.0.0.0', () => console.log(`Scheduler running on :${PORT} (Postgres)`));
}).catch(e => {
  console.error('Could not start — database setup failed:', e.message);
  process.exit(1);
});
