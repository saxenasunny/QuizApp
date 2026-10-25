'use strict';

const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { createClient } = require('@libsql/client');

/* ------------------------------------------------------------------ */
/* Client setup                                                        */
/* Local dev  -> file: data/quiz.db (no config needed)                 */
/* Production -> TURSO_DATABASE_URL + TURSO_AUTH_TOKEN (Vercel env)    */
/* ------------------------------------------------------------------ */
const TURSO_URL = process.env.TURSO_DATABASE_URL;
const isRemote = Boolean(TURSO_URL);

let DATA_DIR = null;
let dbFileUrl = 'file:data/quiz.db';
if (!isRemote) {
  DATA_DIR = path.join(__dirname, 'data');
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  dbFileUrl = 'file:' + path.join(DATA_DIR, 'quiz.db');
}

const client = createClient({
  url: isRemote ? TURSO_URL : dbFileUrl,
  authToken: process.env.TURSO_AUTH_TOKEN,
});

/* libSQL rows are array-like; convert to plain objects for the rest of the app. */
function rowToObject(row, columns) {
  if (!row) return undefined;
  const obj = {};
  for (let i = 0; i < columns.length; i++) obj[columns[i]] = row[i];
  return obj;
}

/* Thin async wrapper so server.js keeps the familiar .prepare().get/all/run() shape. */
function prepare(sql) {
  return {
    async get(...args) {
      const rs = await client.execute({ sql, args });
      return rs.rows.length ? rowToObject(rs.rows[0], rs.columns) : undefined;
    },
    async all(...args) {
      const rs = await client.execute({ sql, args });
      return rs.rows.map((r) => rowToObject(r, rs.columns));
    },
    async run(...args) {
      const rs = await client.execute({ sql, args });
      return { lastInsertRowid: Number(rs.lastInsertRowid ?? 0), changes: rs.rowsAffected };
    },
  };
}

const db = { prepare, client };

/* ------------------------------------------------------------------ */
/* Password hashing (scrypt + salt)                                    */
/* ------------------------------------------------------------------ */
function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(password, salt, 64).toString('hex');
  return `${salt}:${hash}`;
}

function verifyPassword(password, stored) {
  const [salt, hash] = String(stored || '').split(':');
  if (!salt || !hash) return false;
  const check = crypto.scryptSync(password, salt, 64).toString('hex');
  return crypto.timingSafeEqual(Buffer.from(hash, 'hex'), Buffer.from(check, 'hex'));
}

/* ------------------------------------------------------------------ */
/* Schema                                                              */
/* ------------------------------------------------------------------ */
const SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  email          TEXT NOT NULL UNIQUE,
  password_hash  TEXT NOT NULL,
  role           TEXT NOT NULL DEFAULT 'student',
  name           TEXT,
  enrollment_no  TEXT,
  admission_no   TEXT,
  school_name    TEXT,
  program_name   TEXT,
  section        TEXT,
  batch_year     TEXT,
  created_at     TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
  token      TEXT PRIMARY KEY,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS competitions (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  title            TEXT NOT NULL,
  description      TEXT NOT NULL DEFAULT '',
  batch_year       TEXT,
  starts_at        TEXT NOT NULL,
  ends_at          TEXT NOT NULL,
  duration_minutes INTEGER NOT NULL DEFAULT 30,
  created_by       INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at       TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS questions (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  competition_id INTEGER NOT NULL REFERENCES competitions(id) ON DELETE CASCADE,
  type           TEXT NOT NULL,
  prompt         TEXT NOT NULL,
  options_json   TEXT,
  answer         TEXT NOT NULL,
  starter_code   TEXT,
  points         INTEGER NOT NULL DEFAULT 10,
  sort_order     INTEGER NOT NULL DEFAULT 0,
  language       TEXT NOT NULL DEFAULT 'javascript',
  test_cases_json TEXT
);

CREATE TABLE IF NOT EXISTS registrations (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  competition_id INTEGER NOT NULL REFERENCES competitions(id) ON DELETE CASCADE,
  user_id        INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at     TEXT NOT NULL,
  UNIQUE (competition_id, user_id)
);

CREATE TABLE IF NOT EXISTS attempts (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  competition_id   INTEGER NOT NULL REFERENCES competitions(id) ON DELETE CASCADE,
  user_id          INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  started_at       TEXT NOT NULL,
  submitted_at     TEXT,
  status           TEXT NOT NULL DEFAULT 'in_progress',
  score            INTEGER NOT NULL DEFAULT 0,
  correct_count    INTEGER NOT NULL DEFAULT 0,
  total_questions  INTEGER NOT NULL DEFAULT 0,
  duration_seconds INTEGER NOT NULL DEFAULT 0,
  UNIQUE (competition_id, user_id)
);

CREATE TABLE IF NOT EXISTS attempt_answers (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  attempt_id  INTEGER NOT NULL REFERENCES attempts(id) ON DELETE CASCADE,
  question_id INTEGER NOT NULL REFERENCES questions(id) ON DELETE CASCADE,
  answer_text TEXT,
  is_correct  INTEGER NOT NULL DEFAULT 0,
  UNIQUE (attempt_id, question_id)
);
`;

/* ------------------------------------------------------------------ */
/* Seed                                                                */
/* ------------------------------------------------------------------ */
function iso(offsetMs) {
  return new Date(Date.now() + offsetMs).toISOString();
}

async function seed() {
  const admin = await db.prepare("SELECT id FROM users WHERE role = 'admin' LIMIT 1").get();
  if (!admin) {
    const insertUser = db.prepare(`
      INSERT INTO users (email, password_hash, role, name, enrollment_no, admission_no,
                         school_name, program_name, section, batch_year, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    await insertUser.run(
      'admin@codingarena.dev',
      hashPassword('admin123'),
      'admin',
      'Competition Admin',
      null,
      null,
      'School of Computer Science',
      null,
      null,
      null,
      new Date().toISOString()
    );
    console.log('Seeded default admin account.');
  }
}

async function purgeAllDummyData() {
  // Wipe attempt answers, attempts, registrations, questions, competitions
  await client.execute('DELETE FROM attempt_answers');
  await client.execute('DELETE FROM attempts');
  await client.execute('DELETE FROM registrations');
  await client.execute('DELETE FROM questions');
  await client.execute('DELETE FROM competitions');

  // Delete all student sessions and student users
  await client.execute("DELETE FROM sessions WHERE user_id IN (SELECT id FROM users WHERE role = 'student')");
  await client.execute("DELETE FROM users WHERE role = 'student'");

  // Ensure admin account exists
  await seed();
  return { ok: true };
}

async function runLaunchCleanup() {
  try {
    await client.execute(`
      CREATE TABLE IF NOT EXISTS system_migrations (
        name TEXT PRIMARY KEY,
        applied_at TEXT NOT NULL
      )
    `);

    const existing = await client.execute({
      sql: 'SELECT name FROM system_migrations WHERE name = ?',
      args: ['clean_launch_dummy_data_v2']
    });

    if (existing.rows.length === 0) {
      console.log('Performing clean launch purge of all dummy students and competitions...');
      await purgeAllDummyData();
      await client.execute({
        sql: 'INSERT INTO system_migrations (name, applied_at) VALUES (?, ?)',
        args: ['clean_launch_dummy_data_v2', new Date().toISOString()]
      });
      console.log('Clean launch purge complete.');
    }
  } catch (err) {
    console.error('Error during launch cleanup:', err);
  }
}

/* ------------------------------------------------------------------ */
/* Init (memoized): create schema + seed once per process              */
/* ------------------------------------------------------------------ */
let isDbReady = false;
let initPromise = null;
async function init() {
  if (isDbReady) return;
  if (initPromise) return initPromise;
  initPromise = (async () => {
    try {
      try {
        await client.execute('SELECT 1 FROM users LIMIT 1');
        try {
          await client.execute('SELECT batch_year FROM competitions LIMIT 1');
        } catch {
          try {
            await client.execute('ALTER TABLE competitions ADD COLUMN batch_year TEXT');
          } catch {}
        }
        try {
          await client.execute('SELECT test_cases_json FROM questions LIMIT 1');
        } catch {
          try {
            await client.execute('ALTER TABLE questions ADD COLUMN test_cases_json TEXT');
          } catch {}
        }
        await runLaunchCleanup();
        isDbReady = true;
        return;
      } catch {
        // Table not initialized yet, run schema creation
      }
      await client.executeMultiple(SCHEMA);
      try {
        await client.execute("ALTER TABLE questions ADD COLUMN language TEXT DEFAULT 'javascript'");
      } catch {
        // column already exists
      }
      try {
        await client.execute('ALTER TABLE competitions ADD COLUMN batch_year TEXT');
      } catch {}
      try {
        await client.execute('ALTER TABLE questions ADD COLUMN test_cases_json TEXT');
      } catch {}
      await seed();
      await runLaunchCleanup();
      isDbReady = true;
    } catch (e) {
      initPromise = null; // allow retry on transient failure
      throw e;
    }
  })();
  return initPromise;
}

/* ------------------------------------------------------------------ */
/* Helpers                                                             */
/* ------------------------------------------------------------------ */
function competitionStatus(comp, now = Date.now()) {
  const start = new Date(comp.starts_at).getTime();
  const end = new Date(comp.ends_at).getTime();
  if (now < start) return 'upcoming';
  if (now <= end) return 'live';
  return 'ended';
}

function isProfileComplete(user) {
  return Boolean(
    user.name && user.enrollment_no && user.admission_no &&
    user.school_name && user.program_name && user.section && user.batch_year
  );
}

module.exports = { db, init, hashPassword, verifyPassword, competitionStatus, isProfileComplete, purgeAllDummyData };
