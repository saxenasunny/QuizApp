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
  language       TEXT NOT NULL DEFAULT 'javascript'
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
  const { c } = await db.prepare('SELECT COUNT(*) AS c FROM users').get();
  if (c > 0) return; // already seeded

  const HOUR = 3600 * 1000;
  const DAY = 24 * HOUR;
  const insertUser = db.prepare(`
    INSERT INTO users (email, password_hash, role, name, enrollment_no, admission_no,
                       school_name, program_name, section, batch_year, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  // Admin account
  await insertUser.run('admin@codingarena.dev', hashPassword('admin123'), 'admin',
    'Competition Admin', null, null, 'School of Computer Science', null, null, null, iso(-30 * DAY));

  // Demo students (password for all: demo1234)
  const pw = hashPassword('demo1234');
  const students = [
    ['aarav@student.campus.edu',  'Aarav Sharma', 'ENR2023001', 'ADM1001', 'School of Computer Science', 'B.Tech CSE', 'A', '2023'],
    ['priya@student.campus.edu',  'Priya Verma',  'ENR2023002', 'ADM1002', 'School of Computer Science', 'B.Tech CSE', 'A', '2023'],
    ['rohan@student.campus.edu',  'Rohan Das',    'ENR2022014', 'ADM1014', 'School of Information Tech',  'B.Tech IT',  'B', '2022'],
    ['sneha@student.campus.edu',  'Sneha Iyer',   'ENR2024031', 'ADM1031', 'School of Computer Science', 'BCA',        'A', '2024'],
    ['kabir@student.campus.edu',  'Kabir Mehta',  'ENR2023009', 'ADM1009', 'School of Computer Science', 'B.Tech CSE', 'B', '2023'],
    ['ananya@student.campus.edu', 'Ananya Rao',   'ENR2025005', 'ADM1005', 'School of Applied Sciences', 'MCA',        'A', '2025'],
  ];
  const studentIds = {};
  for (const [email, name, enr, adm, school, program, section, batch] of students) {
    const r = await insertUser.run(email, pw, 'student', name, enr, adm, school, program, section, batch, iso(-20 * DAY));
    studentIds[email] = r.lastInsertRowid;
  }

  const adminId = (await db.prepare('SELECT id FROM users WHERE role = ?').get('admin')).id;

  const addComp = db.prepare(`
    INSERT INTO competitions (title, description, starts_at, ends_at, duration_minutes, created_by, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `);
  const addQ = db.prepare(`
    INSERT INTO questions (competition_id, type, prompt, options_json, answer, starter_code, points, sort_order)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);

  /* ---------- Competition 1: LIVE right now ---------- */
  const comp1 = (await addComp.run(
    'CodeSprint: JavaScript Fundamentals',
    'A fast-paced sprint through the core of JavaScript — types, arrays, scope and hands-on output problems. Write real code and get instant verdicts!',
    iso(-2 * HOUR), iso(6 * HOUR), 30, adminId, iso(-1 * DAY)
  )).lastInsertRowid;

  const q1 = [
    ['mcq', 'What is the output of `typeof null` in JavaScript?', JSON.stringify(['"object"', '"null"', '"undefined"', '"number"']), '"object"', null, 10],
    ['mcq', 'Which array method adds one or more elements to the END of an array?', JSON.stringify(['pop()', 'shift()', 'push()', 'unshift()']), 'push()', null, 10],
    ['mcq', 'What does the strict equality operator (===) compare?', JSON.stringify(['Only values', 'Only types', 'Both value and type, no type coercion', 'Value after type coercion']), 'Both value and type, no type coercion', null, 10],
    ['mcq', 'Which keyword declares a block-scoped variable whose binding CAN be reassigned?', JSON.stringify(['var', 'let', 'const', 'static']), 'let', null, 10],
    ['output', 'Write a JavaScript program that prints the sum of numbers from 1 to 10.', null, '55',
      '// Print the sum of numbers from 1 to 10\nconsole.log();\n', 20],
    ['output', 'Given the array below, print only the EVEN numbers separated by a single space.', null, '2 4 6',
      'const arr = [1, 2, 3, 4, 5, 6];\n// print only even numbers, space separated\nconsole.log();\n', 20],
  ];
  for (let i = 0; i < q1.length; i++) { const q = q1[i]; await addQ.run(comp1, q[0], q[1], q[2], q[3], q[4], q[5], i); }

  /* ---------- Competition 2: UPCOMING ---------- */
  const comp2 = (await addComp.run(
    'Algorithm Arena: Data Structures',
    'Test your mastery of arrays, linked lists, stacks, queues and complexity analysis. Objective questions with a practical coding finale.',
    iso(5 * DAY), iso(5 * DAY + 3 * HOUR), 45, adminId, iso(-2 * DAY)
  )).lastInsertRowid;

  const q2 = [
    ['mcq', 'What is the worst-case time complexity of searching in a balanced Binary Search Tree?', JSON.stringify(['O(1)', 'O(log n)', 'O(n)', 'O(n²)']), 'O(log n)', null, 10],
    ['mcq', 'Which data structure follows the LIFO (Last In, First Out) principle?', JSON.stringify(['Queue', 'Stack', 'Linked List', 'Heap']), 'Stack', null, 10],
    ['mcq', 'Which traversal of a BST returns keys in ascending order?', JSON.stringify(['Pre-order', 'In-order', 'Post-order', 'Level-order']), 'In-order', null, 10],
    ['mcq', 'A queue typically grows and shrinks from which ends?', JSON.stringify(['Both from the back', 'Enqueue at rear, dequeue from front', 'Both from the front', 'Random access only']), 'Enqueue at rear, dequeue from front', null, 10],
    ['mcq', 'What is the average time complexity of inserting at the HEAD of a singly linked list?', JSON.stringify(['O(1)', 'O(log n)', 'O(n)', 'O(n log n)']), 'O(1)', null, 10],
    ['output', 'Print the FACTORIAL of 5 (i.e. 5!).', null, '120',
      '// Print the factorial of 5\nconsole.log();\n', 20],
  ];
  for (let i = 0; i < q2.length; i++) { const q = q2[i]; await addQ.run(comp2, q[0], q[1], q[2], q[3], q[4], q[5], i); }

  /* ---------- Competition 3: ENDED ---------- */
  const comp3 = (await addComp.run(
    'C-Core Challenge',
    'The classics: pointers, arrays, memory and loops from the C programming world, finished with a string manipulation task.',
    iso(-4 * DAY), iso(-3 * DAY), 25, adminId, iso(-6 * DAY)
  )).lastInsertRowid;

  const q3 = [
    ['mcq', 'In C, what does `int *p` declare?', JSON.stringify(['An integer named p', 'A pointer to int named p', 'An array of ints', 'A function returning int']), 'A pointer to int named p', null, 10],
    ['mcq', 'Which of these is NOT a valid C data type?', JSON.stringify(['int', 'float', 'string', 'char']), 'string', null, 10],
    ['mcq', 'What is the index of the FIRST element of an array in C?', JSON.stringify(['0', '1', '-1', 'It depends on the compiler']), '0', null, 10],
    ['output', 'Print the REVERSE of the string stored in `str` below (without a trailing newline concern — just print it).', null, 'olleh',
      'const str = "hello";\n// print the reversed string\nconsole.log();\n', 20],
  ];
  for (let i = 0; i < q3.length; i++) { const q = q3[i]; await addQ.run(comp3, q[0], q[1], q[2], q[3], q[4], q[5], i); }

  /* ---------- Seed attempts so rankings feel alive ---------- */
  const reg = db.prepare('INSERT INTO registrations (competition_id, user_id, created_at) VALUES (?, ?, ?)');
  const att = db.prepare(`
    INSERT INTO attempts (competition_id, user_id, started_at, submitted_at, status, score, correct_count, total_questions, duration_seconds)
    VALUES (?, ?, ?, ?, 'submitted', ?, ?, ?, ?)
  `);
  const ans = db.prepare('INSERT INTO attempt_answers (attempt_id, question_id, answer_text, is_correct) VALUES (?, ?, ?, ?)');

  async function seedAttempt(compId, qTypesAnswers, email, pattern, seconds) {
    const uid = studentIds[email];
    await reg.run(compId, uid, iso(-5 * DAY));
    const questions = await db.prepare('SELECT id, type FROM questions WHERE competition_id = ? ORDER BY sort_order').all(compId);
    let score = 0, correct = 0;
    const start = iso(-(3 * DAY));
    const attemptId = (await att.run(compId, uid, start, iso(-(3 * DAY) + seconds * 1000), 0, 0, questions.length, seconds)).lastInsertRowid;
    for (let i = 0; i < questions.length; i++) {
      const qq = questions[i];
      const ok = pattern[i] ? 1 : 0;
      if (ok) { correct++; score += qTypesAnswers[i].points; }
      await ans.run(attemptId, qq.id, ok ? '(demo answer — correct)' : '(demo answer — incorrect)', ok);
    }
    await db.prepare('UPDATE attempts SET score = ?, correct_count = ? WHERE id = ?').run(score, correct, attemptId);
  }

  const q1Rows = await db.prepare('SELECT points FROM questions WHERE competition_id = ? ORDER BY sort_order').all(comp1);
  const q3Rows = await db.prepare('SELECT points FROM questions WHERE competition_id = ? ORDER BY sort_order').all(comp3);

  // Live competition: 4 of 6 students already attempted
  await seedAttempt(comp1, q1Rows, 'aarav@student.campus.edu', [1, 1, 1, 0, 1, 0], 1120);
  await seedAttempt(comp1, q1Rows, 'priya@student.campus.edu',  [1, 1, 1, 1, 1, 1], 890);
  await seedAttempt(comp1, q1Rows, 'rohan@student.campus.edu',  [1, 0, 1, 1, 0, 1], 1340);
  await seedAttempt(comp1, q1Rows, 'kabir@student.campus.edu',  [0, 1, 1, 1, 1, 0], 1010);

  // Ended competition: everyone attempted
  await seedAttempt(comp3, q3Rows, 'aarav@student.campus.edu', [1, 1, 1, 1], 620);
  await seedAttempt(comp3, q3Rows, 'priya@student.campus.edu',  [1, 0, 1, 1], 700);
  await seedAttempt(comp3, q3Rows, 'rohan@student.campus.edu',  [0, 1, 1, 0], 940);
  await seedAttempt(comp3, q3Rows, 'sneha@student.campus.edu',  [1, 1, 0, 1], 810);
  await seedAttempt(comp3, q3Rows, 'kabir@student.campus.edu',  [1, 1, 1, 0], 555);
  await seedAttempt(comp3, q3Rows, 'ananya@student.campus.edu', [0, 1, 1, 1], 1005);

  console.log('Seeded database with admin, demo students and sample competitions.');
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
      await seed();
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

module.exports = { db, init, hashPassword, verifyPassword, competitionStatus, isProfileComplete };
