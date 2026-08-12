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

/* ---------------- plans ---------------- */
const FREE_LIMITS = { programs: 3, teachers: 3, students: 10 };
const UPGRADE_CODE = process.env.UPGRADE_CODE || 'SCHOOL-PRO-2026';
function planUsage(schoolId) {
  const plan = (db.prepare('SELECT plan FROM schools WHERE id=?').get(schoolId) || {}).plan || 'free';
  return {
    plan,
    limits: plan === 'free' ? FREE_LIMITS : null,
    programs: db.prepare('SELECT COUNT(*) c FROM programs WHERE school_id=?').get(schoolId).c,
    teachers: db.prepare("SELECT COUNT(*) c FROM users WHERE school_id=? AND role='teacher' AND status='approved'").get(schoolId).c,
    students: db.prepare("SELECT COUNT(*) c FROM users WHERE school_id=? AND role='student' AND status='approved'").get(schoolId).c,
  };
}
function planBlocked(schoolId, kind) {
  const u = planUsage(schoolId);
  if (u.plan !== 'free') return null;
  if (kind === 'programs' && u.programs >= FREE_LIMITS.programs)
    return `Free plan limit reached (${FREE_LIMITS.programs} classes/programs). Upgrade to add more.`;
  if (kind === 'teachers' && u.teachers >= FREE_LIMITS.teachers)
    return `Free plan limit reached (${FREE_LIMITS.teachers} teachers). Upgrade to approve more.`;
  if (kind === 'students' && u.students >= FREE_LIMITS.students)
    return `Free plan limit reached (${FREE_LIMITS.students} students). Upgrade to approve more.`;
  return null;
}

/* ---------------- seed (only when empty) ---------------- */
if (!db.prepare('SELECT COUNT(*) c FROM schools').get().c) {
  const s = db.prepare("INSERT INTO schools(name,subtitle) VALUES(?,?)")
    .run('Lincoln Elementary', 'Jefferson County Schools · Classes & Afterschool Programs');
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

/* ---------------- helpers ---------------- */
const app = express();
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
app.get('/api/schools', (_req, res) => {
  res.json(db.prepare('SELECT id,name,subtitle FROM schools ORDER BY name').all());
});
app.get('/api/schools/:id/public', (req, res) => {
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
  if (!u || !bcrypt.compareSync(password || '', u.pass_hash))
    return res.status(401).json({ error: 'Wrong email or password.' });
  res.cookie('tok', jwt.sign({ uid: u.id }, SECRET, { expiresIn: '30d' }),
    { httpOnly: true, sameSite: 'lax', maxAge: 30 * 864e5 });
  res.json({ ok: true });
});
app.post('/api/logout', (_req, res) => { res.clearCookie('tok'); res.json({ ok: true }); });

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

app.post('/api/admin/upgrade', ...adm, (req, res) => {
  const { code } = req.body || {};
  if ((code || '').trim() !== UPGRADE_CODE)
    return res.status(400).json({ error: 'That upgrade code is not valid. Contact support to purchase a subscription.' });
  db.prepare("UPDATE schools SET plan='pro' WHERE id=?").run(req.user.school_id);
  res.json({ ok: true, message: 'Upgraded! Unlimited classes, teachers, and students are now enabled.' });
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
    const block = planBlocked(req.user.school_id, u.role === 'teacher' ? 'teachers' : 'students');
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
app.delete('/api/admin/users/:id', ...adm, (req, res) => {
  const u = q.user.get(req.params.id);
  if (!u || u.school_id !== req.user.school_id || u.role === 'admin')
    return res.status(400).json({ error: 'Cannot delete this user.' });
  db.prepare('DELETE FROM users WHERE id=?').run(u.id);
  db.prepare('DELETE FROM reservations WHERE student_id=?').run(u.id);
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
app.post('/api/admin/schools', ...adm, (req, res) => {   // new location under same district
  const { name, subtitle } = req.body || {};
  if (!name) return res.status(400).json({ error: 'Name required.' });
  const r = db.prepare('INSERT INTO schools(name,subtitle) VALUES(?,?)').run(name, subtitle || '');
  db.prepare('INSERT INTO settings(school_id) VALUES(?)').run(r.lastInsertRowid);
  res.json({ ok: true, id: r.lastInsertRowid });
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

/* ---------------- static ---------------- */
app.get('/mockup', (_req, res) => res.sendFile(path.join(__dirname, 'mockup.html')));
app.get('/', (_req, res) => res.sendFile(path.join(__dirname, 'index.html')));
app.use((err, _req, res, _next) => { console.error(err); res.status(500).json({ error: 'Server error.' }); });

app.listen(PORT, '0.0.0.0', () => console.log(`Scheduler running on :${PORT}`));
