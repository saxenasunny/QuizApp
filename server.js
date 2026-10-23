'use strict';

const path = require('path');
const crypto = require('crypto');
const express = require('express');
const { execFile } = require('child_process');

const { db, init, hashPassword, verifyPassword, competitionStatus, isProfileComplete } = require('./db');

const app = express();
const PORT = (() => {
  const n = Number(process.env.PORT);
  return Number.isInteger(n) && n > 0 ? n : 3000;
})();
const IS_VERCEL = !!process.env.VERCEL;
const SESSION_TTL_MS = 1000 * 60 * 60 * 24 * 7; // 7 days

app.use(express.json({ limit: '200kb' }));
app.use(express.static(path.join(__dirname, 'public')));

// Guarantee schema + seed are ready before any request is handled.
// init() is memoized, so this is a no-op after the first call.
app.use(async (req, res, next) => {
  try {
    await init();
    next();
  } catch (e) {
    console.error('DB init failed:', e);
    res.status(500).json({ error: 'Database unavailable.', code: 'DB_INIT' });
  }
});

/* ------------------------------------------------------------------ */
/* Session helpers (with fast in-memory cache)                         */
/* ------------------------------------------------------------------ */
const sessionCache = new Map(); // token -> { user, cachedAt }
const SESSION_CACHE_TTL_MS = 60000; // 60s cache in memory

function parseCookies(req) {
  const header = req.headers.cookie || '';
  const out = {};
  header.split(';').forEach((part) => {
    const idx = part.indexOf('=');
    if (idx > -1) out[part.slice(0, idx).trim()] = decodeURIComponent(part.slice(idx + 1).trim());
  });
  return out;
}

async function currentUser(req) {
  const token = parseCookies(req).sid;
  if (!token) return null;
  const now = Date.now();
  const cached = sessionCache.get(token);
  if (cached && (now - cached.cachedAt < SESSION_CACHE_TTL_MS)) {
    return cached.user;
  }
  const row = await db.prepare(`
    SELECT u.* FROM sessions s JOIN users u ON u.id = s.user_id
    WHERE s.token = ? AND s.expires_at > ?
  `).get(token, new Date(now).toISOString());
  if (row) {
    sessionCache.set(token, { user: row, cachedAt: now });
  } else {
    sessionCache.delete(token);
  }
  return row || null;
}

async function createSession(res, userOrId) {
  const token = crypto.randomBytes(32).toString('hex');
  const now = Date.now();
  const userId = typeof userOrId === 'object' ? userOrId.id : userOrId;
  await db.prepare('INSERT INTO sessions (token, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)')
    .run(token, userId, new Date(now).toISOString(), new Date(now + SESSION_TTL_MS).toISOString());
  res.setHeader('Set-Cookie', `sid=${token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${Math.floor(SESSION_TTL_MS / 1000)}`);
  if (typeof userOrId === 'object') {
    sessionCache.set(token, { user: userOrId, cachedAt: now });
  }
}

async function destroySession(req, res) {
  const token = parseCookies(req).sid;
  if (token) {
    sessionCache.delete(token);
    await db.prepare('DELETE FROM sessions WHERE token = ?').run(token);
  }
  res.setHeader('Set-Cookie', 'sid=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0');
}

async function requireAuth(req, res, next) {
  const user = await currentUser(req);
  if (!user) return res.status(401).json({ error: 'Not logged in.', code: 'UNAUTHENTICATED' });
  req.user = user;
  next();
}

function requireAdmin(req, res, next) {
  if (!req.user || req.user.role !== 'admin') {
    return res.status(403).json({ error: 'Admin access required.', code: 'FORBIDDEN' });
  }
  next();
}

function requireProfile(req, res, next) {
  if (!isProfileComplete(req.user)) {
    return res.status(403).json({ error: 'Complete your profile before participating.', code: 'PROFILE_INCOMPLETE' });
  }
  next();
}

const publicUser = (u) => ({
  id: u.id,
  email: u.email,
  role: u.role,
  name: u.name,
  enrollment_no: u.enrollment_no,
  admission_no: u.admission_no,
  school_name: u.school_name,
  program_name: u.program_name,
  section: u.section,
  batch_year: u.batch_year,
  profile_complete: isProfileComplete(u),
});

/* ------------------------------------------------------------------ */
/* Auth                                                                */
/* ------------------------------------------------------------------ */
app.post('/api/auth/register', async (req, res) => {
  const b = req.body || {};
  const email = String(b.email || '').trim().toLowerCase();
  const password = String(b.password || '');
  const fields = {
    name: String(b.name || '').trim(),
    enrollment_no: String(b.enrollment_no || '').trim(),
    admission_no: String(b.admission_no || '').trim(),
    school_name: String(b.school_name || '').trim(),
    program_name: String(b.program_name || '').trim(),
    section: String(b.section || '').trim(),
    batch_year: String(b.batch_year || '').trim(),
  };

  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return res.status(400).json({ error: 'Please enter a valid email address (this is your user ID).' });
  if (password.length < 6) return res.status(400).json({ error: 'Password must be at least 6 characters.' });
  if (!fields.name) return res.status(400).json({ error: 'Name is required.' });

  const exists = await db.prepare('SELECT id FROM users WHERE email = ?').get(email);
  if (exists) return res.status(409).json({ error: 'An account with this email already exists. Please log in.' });

  const r = await db.prepare(`
    INSERT INTO users (email, password_hash, role, name, enrollment_no, admission_no,
                       school_name, program_name, section, batch_year, created_at)
    VALUES (?, ?, 'student', ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(email, hashPassword(password), fields.name, fields.enrollment_no, fields.admission_no,
         fields.school_name, fields.program_name, fields.section, fields.batch_year, new Date().toISOString());

  const user = await db.prepare('SELECT * FROM users WHERE id = ?').get(r.lastInsertRowid);
  await createSession(res, user);
  res.status(201).json({ user: publicUser(user) });
});

app.post('/api/auth/login', async (req, res) => {
  const email = String(req.body?.email || '').trim().toLowerCase();
  const password = String(req.body?.password || '');
  const user = await db.prepare('SELECT * FROM users WHERE email = ?').get(email);
  if (!user || !verifyPassword(password, user.password_hash)) {
    return res.status(401).json({ error: 'Invalid email or password.' });
  }
  await createSession(res, user);
  res.json({ user: publicUser(user) });
});

app.post('/api/auth/logout', async (req, res) => {
  await destroySession(req, res);
  res.json({ ok: true });
});

app.get('/api/auth/me', async (req, res) => {
  const user = await currentUser(req);
  res.json({ user: user ? publicUser(user) : null });
});

app.put('/api/profile', requireAuth, async (req, res) => {
  const b = req.body || {};
  const pick = (k) => (b[k] !== undefined ? String(b[k]).trim() : undefined);
  const next = {
    name: pick('name') ?? req.user.name,
    enrollment_no: pick('enrollment_no') ?? req.user.enrollment_no,
    admission_no: pick('admission_no') ?? req.user.admission_no,
    school_name: pick('school_name') ?? req.user.school_name,
    program_name: pick('program_name') ?? req.user.program_name,
    section: pick('section') ?? req.user.section,
    batch_year: pick('batch_year') ?? req.user.batch_year,
  };
  if (b.password) {
    if (String(b.password).length < 6) return res.status(400).json({ error: 'New password must be at least 6 characters.' });
    await db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(hashPassword(String(b.password)), req.user.id);
  }
  await db.prepare(`
    UPDATE users SET name = ?, enrollment_no = ?, admission_no = ?, school_name = ?,
                     program_name = ?, section = ?, batch_year = ? WHERE id = ?
  `).run(next.name, next.enrollment_no, next.admission_no, next.school_name,
         next.program_name, next.section, next.batch_year, req.user.id);
  const user = await db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.id);
  const token = parseCookies(req).sid;
  if (token) sessionCache.set(token, { user, cachedAt: Date.now() });
  res.json({ user: publicUser(user) });
});

/* ------------------------------------------------------------------ */
/* Code runner (multi-language practical questions via Judge0 / Node)  */
/* ------------------------------------------------------------------ */
const JUDGE0_LANGUAGES = {
  javascript: 102, // Node.js (22.08.0)
  python: 100,     // Python (3.12.5)
  c: 103,          // C (GCC 14.1.0)
  cpp: 105,        // C++ (GCC 14.1.0)
  java: 91,        // Java (JDK 17.0.6)
};

const JUDGE0_BASE_URL = process.env.JUDGE0_URL || 'https://ce.judge0.com';

function runJavaScript(code, stdin = '') {
  return new Promise((resolve) => {
    const child = execFile(process.execPath, ['-e', code], { timeout: 3500, killSignal: 'SIGKILL', windowsHide: true }, (err, stdout, stderr) => {
      if (err && err.killed) return resolve({ ok: false, error: '⏱ Time limit exceeded (3.5s).', stdout: '' });
      if (err && !stdout && stderr) return resolve({ ok: false, error: String(stderr).slice(0, 2000), stdout: '' });
      resolve({ ok: !err, error: err && !err.killed ? String(stderr || err.message).slice(0, 2000) : '', stdout: String(stdout || '').slice(0, 10000) });
    });
    if (stdin) {
      try { child.stdin.write(stdin); } catch {}
    }
    try { child.stdin.end(); } catch {}
  });
}

async function runWithJudge0(code, language, stdin = '') {
  const langKey = String(language || 'python').toLowerCase().trim();
  const langId = JUDGE0_LANGUAGES[langKey] || JUDGE0_LANGUAGES.python;

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 12000);

  try {
    const headers = { 'Content-Type': 'application/json' };
    if (process.env.JUDGE0_API_KEY) {
      headers['X-RapidAPI-Key'] = process.env.JUDGE0_API_KEY;
      headers['X-RapidAPI-Host'] = 'judge0-ce.p.rapidapi.com';
    }

    const payload = {
      source_code: code,
      language_id: langId,
    };
    if (stdin) {
      payload.stdin = String(stdin);
    }

    const res = await fetch(`${JUDGE0_BASE_URL}/submissions?base64_encoded=false&wait=true`, {
      method: 'POST',
      headers,
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
    clearTimeout(timeoutId);

    if (!res.ok) {
      const errText = await res.text();
      return { ok: false, error: `Execution service error (${res.status}): ${errText.slice(0, 300)}`, stdout: '' };
    }

    const data = await res.json();
    const compileOutput = data.compile_output ? String(data.compile_output).trim() : '';
    const stderr = data.stderr ? String(data.stderr).trim() : '';
    const stdout = data.stdout ? String(data.stdout) : '';

    if (compileOutput) {
      return { ok: false, error: compileOutput.slice(0, 3000), stdout };
    }
    if (data.status && data.status.id === 5) {
      return { ok: false, error: '⏱ Time limit exceeded (execution timeout).', stdout };
    }
    if (stderr && !stdout) {
      return { ok: false, error: stderr.slice(0, 2000), stdout: '' };
    }
    if (data.status && data.status.id > 3) {
      let errMsg = (stderr || data.status.description || 'Execution failed').slice(0, 2000);
      if (errMsg.includes('NoSuchElementException')) {
        errMsg += '\n\n💡 Hint: NoSuchElementException occurred while reading input. Scanner reached End-of-File (EOF). Check that your input/test cases provide all required values.';
      }
      return { ok: false, error: errMsg, stdout };
    }

    return { ok: true, error: stderr.slice(0, 1000), stdout: stdout.slice(0, 10000) };
  } catch (err) {
    clearTimeout(timeoutId);
    if (err.name === 'AbortError') {
      return { ok: false, error: '⏱ Time limit exceeded (12s network timeout).', stdout: '' };
    }
    return { ok: false, error: `Execution service error: ${err.message}`, stdout: '' };
  }
}

async function runWithCodapi(code, language, stdin = '') {
  const langKey = String(language || 'python').toLowerCase().trim();
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 6000);

  try {
    let sandbox = 'python';
    let files = {};
    const stdinStr = String(stdin ?? '');
    const inputContent = stdinStr.endsWith('\n') ? stdinStr : (stdinStr ? stdinStr + '\n' : '');
    const hasStdin = stdinStr.trim().length > 0;

    if (langKey === 'python' || langKey === 'py') {
      sandbox = 'python';
      let wrappedCode = code;
      if (hasStdin) {
        wrappedCode = `import io, sys\nsys.stdin = io.StringIO(${JSON.stringify(inputContent)})\n${code}`;
      }
      files = { '': wrappedCode };
    } else if (langKey === 'c') {
      sandbox = 'gcc';
      let wrappedCode = code;
      if (hasStdin) {
        wrappedCode = `#include <stdio.h>\n#define main __student_main__\n${code}\n#undef main\nint main(int argc, char** argv) {\n    freopen("input.txt", "r", stdin);\n    return __student_main__();\n}`;
        files = { '': wrappedCode, 'input.txt': inputContent };
      } else {
        files = { '': code };
      }
    } else if (langKey === 'cpp' || langKey === 'c++') {
      sandbox = 'cpp';
      let wrappedCode = code;
      if (hasStdin) {
        wrappedCode = `#include <iostream>\n#include <cstdio>\n#define main __student_main__\n${code}\n#undef main\nint main(int argc, char** argv) {\n    freopen("input.txt", "r", stdin);\n    return __student_main__();\n}`;
        files = { '': wrappedCode, 'input.txt': inputContent };
      } else {
        files = { '': code };
      }
    } else if (langKey === 'java') {
      sandbox = 'java';
      let wrappedCode = code;
      const classRegex = /(?:public\s+)?class\s+[A-Za-z0-9_$]+[^{]*\{/;
      if (classRegex.test(code)) {
        wrappedCode = code.replace(classRegex, (match) => {
          return `${match} static { try { if (new java.io.File("input.txt").exists()) System.setIn(new java.io.FileInputStream("input.txt")); } catch (Throwable _e) {} }`;
        });
      }
      files = { '': wrappedCode, 'input.txt': inputContent };
    } else {
      sandbox = 'python';
      files = { '': code };
    }

    const res = await fetch('https://api.codapi.org/v1/exec', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        sandbox,
        command: 'run',
        files,
      }),
      signal: controller.signal,
    });
    clearTimeout(timeoutId);

    if (!res.ok) {
      const errText = await res.text();
      return { ok: false, error: `Execution service error (${res.status}): ${errText.slice(0, 300)}`, stdout: '' };
    }

    const data = await res.json();
    const stdout = data.stdout ? String(data.stdout) : '';
    const stderr = data.stderr ? String(data.stderr) : '';

    if (!data.ok) {
      let errMsg = (stderr || 'Execution failed').slice(0, 3000);
      if (errMsg.includes('NoSuchElementException')) {
        errMsg += '\n\n💡 Hint: NoSuchElementException occurred while reading input. Scanner reached End-of-File (EOF). Check that your input/test cases provide all required values.';
      }
      return { ok: false, error: errMsg, stdout };
    }

    return { ok: true, error: stderr.slice(0, 1000), stdout: stdout.slice(0, 10000) };
  } catch (err) {
    clearTimeout(timeoutId);
    if (err.name === 'AbortError') {
      return { ok: false, error: '⏱ Execution timeout (6s limit).', stdout: '' };
    }
    return { ok: false, error: `Execution service error: ${err.message}`, stdout: '' };
  }
}

async function runCode(code, language = 'javascript', stdin = '') {
  const lang = String(language || 'javascript').toLowerCase().trim();
  if (lang === 'javascript' || lang === 'js') {
    return runJavaScript(code, stdin);
  }
  if (process.env.JUDGE0_URL || process.env.JUDGE0_API_KEY) {
    return runWithJudge0(code, lang, stdin);
  }
  return runWithCodapi(code, lang, stdin);
}

const normalize = (s) => String(s ?? '').trim().replace(/\r\n/g, '\n').split('\n').map((l) => l.trimEnd()).join('\n').toLowerCase();

function parseTestCases(q) {
  if (q && q.test_cases_json) {
    try {
      const parsed = typeof q.test_cases_json === 'string' ? JSON.parse(q.test_cases_json) : q.test_cases_json;
      if (Array.isArray(parsed) && parsed.length > 0) {
        return parsed.map((tc) => ({
          input: String(tc.input ?? ''),
          output: String(tc.output ?? '').trim(),
          hidden: Boolean(tc.hidden),
        }));
      }
    } catch {}
  }
  if (q && q.answer && q.type === 'output') {
    return [{ input: '', output: String(q.answer).trim(), hidden: false }];
  }
  return [];
}

app.post('/api/run', requireAuth, async (req, res) => {
  const code = String(req.body?.code || '');
  const language = String(req.body?.language || 'javascript').toLowerCase();
  const stdin = String(req.body?.stdin || '');
  if (!code.trim()) return res.status(400).json({ error: 'Write some code first.' });
  if (code.length > 20000) return res.status(400).json({ error: 'Code is too long (20,000 char limit).' });
  const result = await runCode(code, language, stdin);
  res.json(result);
});

/* Run student's code against a question's configured test cases */
app.post('/api/questions/:id/test-run', requireAuth, async (req, res) => {
  const q = await db.prepare('SELECT * FROM questions WHERE id = ?').get(req.params.id);
  if (!q) return res.status(404).json({ error: 'Question not found.' });
  if (q.type !== 'output') return res.status(400).json({ error: 'Test cases are only available for practical questions.' });

  const code = String(req.body?.code || '');
  const language = String(req.body?.language || q.language || 'javascript').toLowerCase();
  if (!code.trim()) return res.status(400).json({ error: 'Write some code first.' });
  if (code.length > 20000) return res.status(400).json({ error: 'Code is too long (20,000 char limit).' });

  const testCases = parseTestCases(q);
  if (!testCases.length) {
    return res.status(400).json({ error: 'No test cases configured for this question.' });
  }

  const casePromises = testCases.map(async (tc, i) => {
    const run = await runCode(code, language, tc.input);
    const actualNorm = normalize(run.stdout);
    const expectedNorm = normalize(tc.output);
    const passed = run.ok && actualNorm === expectedNorm;

    if (tc.hidden) {
      return {
        case_number: i + 1,
        hidden: true,
        passed,
        error: run.ok ? null : (run.error || 'Execution error'),
      };
    } else {
      return {
        case_number: i + 1,
        hidden: false,
        input: tc.input,
        expected: tc.output,
        actual: run.stdout,
        passed,
        error: run.ok ? null : (run.error || 'Execution error'),
      };
    }
  });

  const cases = await Promise.all(casePromises);
  const passedCount = cases.filter((c) => c.passed).length;
  const compileOrRuntimeError = cases.find((c) => !c.passed && c.error)?.error || null;
  res.json({
    ok: true,
    summary: {
      total: cases.length,
      passed_count: passedCount,
      all_passed: passedCount === cases.length,
      error: compileOrRuntimeError,
    },
    cases,
  });
});

/* ------------------------------------------------------------------ */
/* Competitions (student-facing)                                       */
/* ------------------------------------------------------------------ */
async function leaderboardFor(competitionId) {
  const rows = await db.prepare(`
    SELECT u.id AS user_id, u.name, u.email, u.enrollment_no, u.school_name, u.program_name, u.section, u.batch_year,
           a.score, a.correct_count, a.total_questions, a.duration_seconds, a.submitted_at
    FROM attempts a JOIN users u ON u.id = a.user_id
    WHERE a.competition_id = ? AND a.status = 'submitted'
    ORDER BY a.score DESC, a.duration_seconds ASC, a.submitted_at ASC
  `).all(competitionId);
  return rows.map((r, i) => ({ rank: i + 1, ...r }));
}

async function overallLeaderboard() {
  const rows = await db.prepare(`
    SELECT u.id AS user_id, u.name, u.email, u.enrollment_no, u.school_name, u.program_name, u.section, u.batch_year,
           SUM(a.score) AS total_score,
           SUM(a.score) AS score,
           SUM(a.correct_count) AS total_correct,
           SUM(a.total_questions) AS total_questions,
           COUNT(a.id) AS competitions_attempted,
           ROUND(AVG(100.0 * a.correct_count / NULLIF(a.total_questions, 0)), 1) AS avg_accuracy
    FROM attempts a JOIN users u ON u.id = a.user_id
    WHERE a.status = 'submitted' AND u.role = 'student'
    GROUP BY u.id
    ORDER BY total_score DESC, avg_accuracy DESC
  `).all();
  return rows.map((r, i) => ({ rank: i + 1, ...r }));
}

app.get('/api/competitions', requireAuth, async (req, res) => {
  const [comps, regs, atts, ranks] = await Promise.all([
    db.prepare(`
      SELECT c.*,
             COALESCE(q.n, 0) AS question_count,
             COALESCE(q.pts, 0) AS total_points,
             COALESCE(att.n, 0) AS participant_count
      FROM competitions c
      LEFT JOIN (
        SELECT competition_id, COUNT(*) AS n, SUM(points) AS pts
        FROM questions GROUP BY competition_id
      ) q ON q.competition_id = c.id
      LEFT JOIN (
        SELECT competition_id, COUNT(*) AS n
        FROM attempts WHERE status = 'submitted' GROUP BY competition_id
      ) att ON att.competition_id = c.id
      ORDER BY c.starts_at DESC
    `).all(),
    db.prepare('SELECT competition_id FROM registrations WHERE user_id = ?').all(req.user.id),
    db.prepare("SELECT competition_id, score, status FROM attempts WHERE user_id = ? AND status = 'submitted'").all(req.user.id),
    db.prepare(`
      SELECT competition_id, rank FROM (
        SELECT competition_id, user_id,
               RANK() OVER (PARTITION BY competition_id ORDER BY score DESC, duration_seconds ASC, submitted_at ASC) AS rank
        FROM attempts WHERE status = 'submitted'
      ) WHERE user_id = ?
    `).all(req.user.id),
  ]);

  const regSet = new Set(regs.map((r) => r.competition_id));
  const attMap = Object.fromEntries(atts.map((a) => [a.competition_id, a]));
  const rankMap = Object.fromEntries(ranks.map((r) => [r.competition_id, r.rank]));

  // Filter competitions by student's batch_year if user is a student
  const visibleComps = req.user.role === 'admin'
    ? comps
    : comps.filter((c) => {
        if (!c.batch_year || !c.batch_year.trim() || c.batch_year.toLowerCase() === 'all') return true;
        return String(req.user.batch_year || '').trim() === c.batch_year.trim();
      });

  const data = visibleComps.map((c) => ({
    ...c,
    status: competitionStatus(c),
    registered: regSet.has(c.id),
    my_attempt: attMap[c.id] ? { score: attMap[c.id].score } : null,
    my_rank: rankMap[c.id] || null,
  }));
  res.json({ competitions: data });
});

app.get('/api/competitions/:id', requireAuth, async (req, res) => {
  const compId = req.params.id;
  const comp = await db.prepare('SELECT * FROM competitions WHERE id = ?').get(compId);
  if (!comp) return res.status(404).json({ error: 'Competition not found.' });
  if (req.user.role === 'student' && comp.batch_year && comp.batch_year.trim() && comp.batch_year.toLowerCase() !== 'all') {
    if (String(req.user.batch_year || '').trim() !== comp.batch_year.trim()) {
      return res.status(403).json({ error: `This competition is only open to students from the ${comp.batch_year} batch.` });
    }
  }
  const [q, reg, att, lb] = await Promise.all([
    db.prepare('SELECT COUNT(*) AS n, COALESCE(SUM(points),0) AS pts FROM questions WHERE competition_id = ?').get(compId),
    db.prepare('SELECT id FROM registrations WHERE competition_id = ? AND user_id = ?').get(compId, req.user.id),
    db.prepare('SELECT * FROM attempts WHERE competition_id = ? AND user_id = ?').get(compId, req.user.id),
    leaderboardFor(compId),
  ]);
  const me = lb.find((r) => r.user_id === req.user.id);
  res.json({
    competition: {
      ...comp,
      status: competitionStatus(comp),
      question_count: q.n,
      total_points: q.pts,
      registered: Boolean(reg),
      attempt: att ? { id: att.id, status: att.status, score: att.score, submitted_at: att.submitted_at } : null,
      my_rank: me ? me.rank : null,
      participant_count: lb.length,
    },
    leaderboard: lb.slice(0, 50),
  });
});

app.post('/api/competitions/:id/register', requireAuth, requireProfile, async (req, res) => {
  const comp = await db.prepare('SELECT * FROM competitions WHERE id = ?').get(req.params.id);
  if (!comp) return res.status(404).json({ error: 'Competition not found.' });
  if (req.user.role === 'student' && comp.batch_year && comp.batch_year.trim() && comp.batch_year.toLowerCase() !== 'all') {
    if (String(req.user.batch_year || '').trim() !== comp.batch_year.trim()) {
      return res.status(403).json({ error: `Registration is only open to students from the ${comp.batch_year} batch.` });
    }
  }
  const existing = await db.prepare('SELECT id FROM registrations WHERE competition_id = ? AND user_id = ?').get(comp.id, req.user.id);
  if (!existing) {
    await db.prepare('INSERT INTO registrations (competition_id, user_id, created_at) VALUES (?, ?, ?)')
      .run(comp.id, req.user.id, new Date().toISOString());
  }
  res.json({ ok: true });
});

/* Start (or resume) an attempt. Returns questions WITHOUT answers. */
app.post('/api/competitions/:id/start', requireAuth, requireProfile, async (req, res) => {
  const comp = await db.prepare('SELECT * FROM competitions WHERE id = ?').get(req.params.id);
  if (!comp) return res.status(404).json({ error: 'Competition not found.' });
  if (req.user.role === 'student' && comp.batch_year && comp.batch_year.trim() && comp.batch_year.toLowerCase() !== 'all') {
    if (String(req.user.batch_year || '').trim() !== comp.batch_year.trim()) {
      return res.status(403).json({ error: `This competition is only open to students from the ${comp.batch_year} batch.` });
    }
  }
  const status = competitionStatus(comp);
  if (status === 'upcoming') return res.status(400).json({ error: 'This competition has not started yet.' });
  if (status === 'ended') return res.status(400).json({ error: 'This competition has ended.' });

  const reg = await db.prepare('SELECT id FROM registrations WHERE competition_id = ? AND user_id = ?').get(comp.id, req.user.id);
  if (!reg) return res.status(403).json({ error: 'Register for this competition first.', code: 'NOT_REGISTERED' });

  const questions = await db.prepare('SELECT * FROM questions WHERE competition_id = ? ORDER BY sort_order, id').all(comp.id);
  if (questions.length === 0) return res.status(400).json({ error: 'This competition has no questions yet.' });

  let attempt = await db.prepare('SELECT * FROM attempts WHERE competition_id = ? AND user_id = ?').get(comp.id, req.user.id);
  if (attempt && attempt.status === 'submitted') {
    return res.status(409).json({ error: 'You have already submitted this competition.', code: 'ALREADY_SUBMITTED' });
  }
  if (!attempt) {
    const r = await db.prepare(`
      INSERT INTO attempts (competition_id, user_id, started_at, status, total_questions)
      VALUES (?, ?, ?, 'in_progress', ?)
    `).run(comp.id, req.user.id, new Date().toISOString(), questions.length);
    attempt = await db.prepare('SELECT * FROM attempts WHERE id = ?').get(r.lastInsertRowid);
  }

  // Auto-submit if the window (duration) has elapsed
  const deadline = Math.min(
    new Date(comp.ends_at).getTime(),
    new Date(attempt.started_at).getTime() + comp.duration_minutes * 60000
  );
  if (Date.now() > deadline) {
    await gradeAttempt(attempt.id, {}, true);
    return res.status(409).json({ error: 'Time is up — your answers were auto-submitted.', code: 'TIME_UP' });
  }

  res.json({
    attempt: { id: attempt.id, started_at: attempt.started_at, deadline },
    competition: { id: comp.id, title: comp.title, duration_minutes: comp.duration_minutes, ends_at: comp.ends_at },
    questions: questions.map((q) => ({
      id: q.id,
      type: q.type,
      prompt: q.prompt,
      options: q.options_json ? JSON.parse(q.options_json) : null,
      starter_code: q.starter_code,
      points: q.points,
      language: q.language || 'javascript',
      test_cases: parseTestCases(q).map((tc, idx) => ({
        case_number: idx + 1,
        input: tc.hidden ? null : tc.input,
        output: tc.hidden ? null : tc.output,
        hidden: tc.hidden,
      })),
      // answer intentionally omitted
    })),
  });
});

async function gradeAttempt(attemptId, answers, autoSubmit = false) {
  const attempt = await db.prepare('SELECT * FROM attempts WHERE id = ?').get(attemptId);
  if (!attempt || attempt.status === 'submitted') return null;
  const questions = await db.prepare('SELECT * FROM questions WHERE competition_id = ? ORDER BY sort_order, id').all(attempt.competition_id);
  const comp = await db.prepare('SELECT * FROM competitions WHERE id = ?').get(attempt.competition_id);

  let score = 0, correct = 0;
  const insertAns = db.prepare('INSERT OR REPLACE INTO attempt_answers (attempt_id, question_id, answer_text, is_correct) VALUES (?, ?, ?, ?)');
  const details = [];

  for (const q of questions) {
    const given = answers[q.id] !== undefined && answers[q.id] !== null ? String(answers[q.id]) : '';
    let ok = false;
    let earnedPoints = 0;
    let passedCount = 0;
    let totalCases = 0;
    const testResults = [];

    if (given.trim()) {
      if (q.type === 'mcq') {
        ok = normalize(given) === normalize(q.answer);
        if (ok) earnedPoints = q.points;
      } else {
        // practical: evaluate against all test cases for this question
        const testCases = parseTestCases(q);
        totalCases = testCases.length;
        const qLang = answers[`${q.id}_lang`] || q.language || 'javascript';
        const casePromises = testCases.map(async (tc, tIdx) => {
          const run = await runCode(given, qLang, tc.input);
          const passed = run.ok && normalize(run.stdout) === normalize(tc.output);
          return {
            case_number: tIdx + 1,
            hidden: tc.hidden,
            passed,
            input: tc.hidden ? null : tc.input,
            expected: tc.hidden ? null : tc.output,
            actual: tc.hidden ? null : run.stdout,
          };
        });
        const parallelResults = await Promise.all(casePromises);
        testResults.push(...parallelResults);
        passedCount = parallelResults.filter((r) => r.passed).length;
        ok = totalCases > 0 && passedCount === totalCases;
        earnedPoints = totalCases > 0 ? Math.round((passedCount / totalCases) * q.points) : (ok ? q.points : 0);
      }
    }
    if (ok) correct += 1;
    score += earnedPoints;
    await insertAns.run(attemptId, q.id, given.slice(0, 20000), ok ? 1 : 0);
    details.push({
      question_id: q.id,
      type: q.type,
      prompt: q.prompt,
      given,
      answer: q.answer,
      correct: ok,
      points: q.points,
      earned_points: earnedPoints,
      passed_test_cases: passedCount,
      total_test_cases: totalCases,
      test_results: testResults,
    });
  }

  const started = new Date(attempt.started_at).getTime();
  const elapsed = Math.max(0, Math.round((Date.now() - started) / 1000));
  const capped = Math.min(elapsed, Math.round((new Date(comp.ends_at).getTime() - started) / 1000));
  await db.prepare(`
    UPDATE attempts SET status = 'submitted', submitted_at = ?, score = ?, correct_count = ?, duration_seconds = ?
    WHERE id = ?
  `).run(new Date().toISOString(), score, correct, autoSubmit ? capped : elapsed, attemptId);

  return { score, correct, total: questions.length, details };
}

/* Submit answers. Body: { answers: { [questionId]: string } } */
app.post('/api/attempts/:id/submit', requireAuth, async (req, res) => {
  const attempt = await db.prepare('SELECT * FROM attempts WHERE id = ?').get(req.params.id);
  if (!attempt) return res.status(404).json({ error: 'Attempt not found.' });
  if (attempt.user_id !== req.user.id) return res.status(403).json({ error: 'This is not your attempt.' });
  if (attempt.status === 'submitted') return res.status(409).json({ error: 'Already submitted.' });

  const result = await gradeAttempt(attempt.id, req.body?.answers || {});
  const lb = await leaderboardFor(attempt.competition_id);
  const me = lb.find((r) => r.user_id === req.user.id);
  res.json({ result, rank: me ? me.rank : null, participants: lb.length });
});

app.get('/api/attempts/:id/result', requireAuth, async (req, res) => {
  const attempt = await db.prepare(`
    SELECT a.*, c.title AS competition_title, c.duration_minutes FROM attempts a
    JOIN competitions c ON c.id = a.competition_id WHERE a.id = ?
  `).get(req.params.id);
  if (!attempt) return res.status(404).json({ error: 'Attempt not found.' });
  if (attempt.user_id !== req.user.id && req.user.role !== 'admin') {
    return res.status(403).json({ error: 'This is not your attempt.' });
  }
  const detailRows = await db.prepare(`
    SELECT aa.question_id, aa.answer_text AS given, aa.is_correct, q.type, q.prompt, q.answer, q.points, q.language, q.test_cases_json
    FROM attempt_answers aa JOIN questions q ON q.id = aa.question_id
    WHERE aa.attempt_id = ? ORDER BY q.sort_order, q.id
  `).all(attempt.id);
  const details = detailRows.map((d) => ({
    ...d,
    correct: Boolean(d.is_correct),
    test_cases: parseTestCases(d).map((tc, idx) => ({
      case_number: idx + 1,
      input: tc.input,
      output: tc.output,
      hidden: tc.hidden,
    })),
  }));
  const lb = await leaderboardFor(attempt.competition_id);
  const me = lb.find((r) => r.user_id === attempt.user_id);
  res.json({ attempt, details, rank: me ? me.rank : null, participants: lb.length });
});

/* ------------------------------------------------------------------ */
/* Rankings                                                            */
/* ------------------------------------------------------------------ */
app.get('/api/rankings/overall', requireAuth, async (req, res) => {
  const rows = await overallLeaderboard();
  const me = rows.find((r) => r.user_id === req.user.id) || null;
  res.json({ leaderboard: rows, me });
});

app.get('/api/rankings/competition/:id', requireAuth, async (req, res) => {
  const comp = await db.prepare('SELECT * FROM competitions WHERE id = ?').get(req.params.id);
  if (!comp) return res.status(404).json({ error: 'Competition not found.' });
  const lb = await leaderboardFor(comp.id);
  const me = lb.find((r) => r.user_id === req.user.id) || null;
  res.json({ competition: { ...comp, status: competitionStatus(comp) }, leaderboard: lb, me });
});

/* My participations with ranks */
app.get('/api/me/participations', requireAuth, async (req, res) => {
  const rows = await db.prepare(`
    SELECT 
      c.id, c.title, c.starts_at, c.ends_at, 
      a.score, a.submitted_at, a.total_questions, a.correct_count,
      r.rank,
      COALESCE(p.participants, 0) AS participants
    FROM attempts a
    JOIN competitions c ON c.id = a.competition_id
    LEFT JOIN (
      SELECT competition_id, user_id,
             RANK() OVER (PARTITION BY competition_id ORDER BY score DESC, duration_seconds ASC, submitted_at ASC) AS rank
      FROM attempts WHERE status = 'submitted'
    ) r ON r.competition_id = a.competition_id AND r.user_id = a.user_id
    LEFT JOIN (
      SELECT competition_id, COUNT(*) AS participants
      FROM attempts WHERE status = 'submitted'
      GROUP BY competition_id
    ) p ON p.competition_id = a.competition_id
    WHERE a.user_id = ? AND a.status = 'submitted'
    ORDER BY a.submitted_at DESC
  `).all(req.user.id);
  const participations = rows.map((r) => ({
    ...r,
    rank: r.rank || null,
    participants: r.participants,
    status: competitionStatus(r),
  }));
  res.json({ participations });
});

/* ------------------------------------------------------------------ */
/* Admin                                                               */
/* ------------------------------------------------------------------ */
function validateCompetitionPayload(b) {
  const title = String(b.title || '').trim();
  const description = String(b.description || '').trim();
  const batchYear = b.batch_year !== undefined && b.batch_year !== null ? String(b.batch_year).trim() : null;
  const startsAt = b.starts_at ? new Date(b.starts_at) : null;
  const endsAt = b.ends_at ? new Date(b.ends_at) : null;
  const duration = parseInt(b.duration_minutes, 10);
  if (!title) return { error: 'Competition title is required.' };
  if (!startsAt || isNaN(startsAt.getTime())) return { error: 'Valid start date/time is required.' };
  if (!endsAt || isNaN(endsAt.getTime())) return { error: 'Valid end date/time is required.' };
  if (endsAt.getTime() <= startsAt.getTime()) return { error: 'End time must be after start time.' };
  if (!Number.isFinite(duration) || duration < 1 || duration > 480) return { error: 'Duration must be between 1 and 480 minutes.' };
  return { title, description, batch_year: batchYear || null, starts_at: startsAt.toISOString(), ends_at: endsAt.toISOString(), duration_minutes: duration };
}

function validateQuestions(list) {
  const qs = Array.isArray(list) ? list : [];
  const clean = [];
  for (let i = 0; i < qs.length; i++) {
    const q = qs[i] || {};
    const type = q.type === 'output' ? 'output' : 'mcq';
    const prompt = String(q.prompt || '').trim();
    const points = parseInt(q.points, 10);
    if (!prompt) return { error: `Question ${i + 1}: prompt text is required.` };
    if (!Number.isFinite(points) || points < 1 || points > 100) return { error: `Question ${i + 1}: points must be 1-100.` };
    if (type === 'mcq') {
      const options = (q.options || []).map((o) => String(o || '').trim()).filter(Boolean);
      if (options.length < 2) return { error: `Question ${i + 1}: MCQ needs at least 2 options.` };
      const answerIdx = parseInt(q.answer_index, 10);
      if (!Number.isInteger(answerIdx) || answerIdx < 0 || answerIdx >= options.length) {
        return { error: `Question ${i + 1}: select the correct option.` };
      }
      clean.push({ type, prompt, options_json: JSON.stringify(options), answer: options[answerIdx], starter_code: null, points, test_cases_json: null });
    } else {
      const lang = String(q.language || 'javascript').toLowerCase().trim();
      let testCases = [];
      if (Array.isArray(q.test_cases)) {
        testCases = q.test_cases
          .map((tc) => ({
            input: String(tc.input ?? ''),
            output: String(tc.output ?? '').trim(),
            hidden: Boolean(tc.hidden),
          }))
          .filter((tc) => tc.output.length > 0);
      }
      const singleExpected = String(q.answer || '').trim();
      if (testCases.length === 0 && !singleExpected) {
        return { error: `Question ${i + 1}: at least one test case with expected output is required.` };
      }
      if (testCases.length === 0) {
        testCases.push({ input: '', output: singleExpected, hidden: false });
      }
      const primaryAnswer = testCases[0].output;
      clean.push({
        type,
        prompt,
        options_json: null,
        answer: primaryAnswer,
        starter_code: String(q.starter_code || ''),
        points,
        language: lang,
        test_cases_json: JSON.stringify(testCases),
      });
    }
  }
  return { questions: clean };
}

app.post('/api/admin/competitions', requireAuth, requireAdmin, async (req, res) => {
  const v = validateCompetitionPayload(req.body || {});
  if (v.error) return res.status(400).json({ error: v.error });
  const qv = validateQuestions((req.body || {}).questions);
  if (qv.error) return res.status(400).json({ error: qv.error });

  const r = await db.prepare(`
    INSERT INTO competitions (title, description, batch_year, starts_at, ends_at, duration_minutes, created_by, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(v.title, v.description, v.batch_year, v.starts_at, v.ends_at, v.duration_minutes, req.user.id, new Date().toISOString());
  const id = r.lastInsertRowid;
  const ins = db.prepare(`
    INSERT INTO questions (competition_id, type, prompt, options_json, answer, starter_code, points, sort_order, language, test_cases_json)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  for (let i = 0; i < qv.questions.length; i++) {
    const q = qv.questions[i];
    await ins.run(id, q.type, q.prompt, q.options_json, q.answer, q.starter_code, q.points, i, q.language || 'javascript', q.test_cases_json);
  }
  res.status(201).json({ id });
});

app.get('/api/admin/competitions', requireAuth, requireAdmin, async (req, res) => {
  const comps = await db.prepare(`
    SELECT c.*,
           COALESCE(q.n, 0) AS question_count,
           COALESCE(q.pts, 0) AS total_points,
           COALESCE(att.n, 0) AS participant_count,
           COALESCE(reg.n, 0) AS registration_count
    FROM competitions c
    LEFT JOIN (
      SELECT competition_id, COUNT(*) AS n, SUM(points) AS pts
      FROM questions GROUP BY competition_id
    ) q ON q.competition_id = c.id
    LEFT JOIN (
      SELECT competition_id, COUNT(*) AS n
      FROM attempts WHERE status = 'submitted' GROUP BY competition_id
    ) att ON att.competition_id = c.id
    LEFT JOIN (
      SELECT competition_id, COUNT(*) AS n
      FROM registrations GROUP BY competition_id
    ) reg ON reg.competition_id = c.id
    ORDER BY c.starts_at DESC
  `).all();

  const data = comps.map((c) => ({
    ...c,
    status: competitionStatus(c),
  }));
  res.json({ competitions: data });
});

app.get('/api/admin/competitions/:id', requireAuth, requireAdmin, async (req, res) => {
  const comp = await db.prepare('SELECT * FROM competitions WHERE id = ?').get(req.params.id);
  if (!comp) return res.status(404).json({ error: 'Competition not found.' });
  const qrows = await db.prepare('SELECT * FROM questions WHERE competition_id = ? ORDER BY sort_order, id').all(comp.id);
  const questions = qrows.map((q) => ({
    ...q,
    options: q.options_json ? JSON.parse(q.options_json) : null,
    test_cases: parseTestCases(q),
  }));
  const attempts = (await db.prepare("SELECT COUNT(*) AS n FROM attempts WHERE competition_id = ? AND status = 'submitted'").get(comp.id)).n;
  res.json({ competition: { ...comp, status: competitionStatus(comp), participant_count: attempts }, questions });
});

app.put('/api/admin/competitions/:id', requireAuth, requireAdmin, async (req, res) => {
  const comp = await db.prepare('SELECT * FROM competitions WHERE id = ?').get(req.params.id);
  if (!comp) return res.status(404).json({ error: 'Competition not found.' });
  const v = validateCompetitionPayload({ ...comp, ...(req.body || {}) });
  if (v.error) return res.status(400).json({ error: v.error });
  await db.prepare('UPDATE competitions SET title = ?, description = ?, batch_year = ?, starts_at = ?, ends_at = ?, duration_minutes = ? WHERE id = ?')
    .run(v.title, v.description, v.batch_year, v.starts_at, v.ends_at, v.duration_minutes, comp.id);

  const hasAttempts = (await db.prepare('SELECT COUNT(*) AS n FROM attempts WHERE competition_id = ?').get(comp.id)).n > 0;
  if (!hasAttempts && req.body.questions) {
    const qv = validateQuestions(req.body.questions);
    if (qv.error) return res.status(400).json({ error: qv.error });
    await db.prepare('DELETE FROM questions WHERE competition_id = ?').run(comp.id);
    const ins = db.prepare(`
      INSERT INTO questions (competition_id, type, prompt, options_json, answer, starter_code, points, sort_order, language, test_cases_json)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    for (let i = 0; i < qv.questions.length; i++) {
      const q = qv.questions[i];
      await ins.run(comp.id, q.type, q.prompt, q.options_json, q.answer, q.starter_code, q.points, i, q.language || 'javascript', q.test_cases_json);
    }
  }
  res.json({ ok: true, questions_locked: hasAttempts });
});

app.delete('/api/admin/competitions/:id', requireAuth, requireAdmin, async (req, res) => {
  const comp = await db.prepare('SELECT * FROM competitions WHERE id = ?').get(req.params.id);
  if (!comp) return res.status(404).json({ error: 'Competition not found.' });
  const hasAttempts = (await db.prepare('SELECT COUNT(*) AS n FROM attempts WHERE competition_id = ?').get(comp.id)).n > 0;
  if (hasAttempts) return res.status(409).json({ error: 'Cannot delete: students already have attempts in this competition.' });
  await db.prepare('DELETE FROM questions WHERE competition_id = ?').run(comp.id);
  await db.prepare('DELETE FROM competitions WHERE id = ?').run(comp.id);
  res.json({ ok: true });
});

app.get('/api/admin/students', requireAuth, requireAdmin, async (req, res) => {
  const [overallRows, srows] = await Promise.all([
    overallLeaderboard(),
    db.prepare("SELECT * FROM users WHERE role = 'student' ORDER BY created_at DESC").all(),
  ]);
  const overall = Object.fromEntries(overallRows.map((r) => [r.user_id, r]));
  const students = srows.map((u) => ({ ...publicUser(u), stats: overall[u.id] || { total_score: 0, competitions_attempted: 0, avg_accuracy: null, rank: null } }));
  res.json({ students });
});

app.get('/api/admin/overview', requireAuth, requireAdmin, async (req, res) => {
  const [counts, allComps] = await Promise.all([
    db.prepare(`
      SELECT 
        (SELECT COUNT(*) FROM users WHERE role = 'student') AS students,
        (SELECT COUNT(*) FROM attempts WHERE status = 'submitted') AS attempts
    `).get(),
    db.prepare('SELECT starts_at, ends_at FROM competitions').all(),
  ]);
  const live = allComps.filter((c) => competitionStatus(c) === 'live').length;
  res.json({ students: counts.students, competitions: allComps.length, live, attempts: counts.attempts });
});

app.get('/api/admin/competitions/:id/submissions', requireAuth, requireAdmin, async (req, res) => {
  const comp = await db.prepare('SELECT * FROM competitions WHERE id = ?').get(req.params.id);
  if (!comp) return res.status(404).json({ error: 'Competition not found.' });
  res.json({ leaderboard: await leaderboardFor(comp.id) });
});

app.put('/api/admin/password', requireAuth, requireAdmin, async (req, res) => {
  const newPassword = String(req.body?.new_password || '').trim();
  if (!newPassword || newPassword.length < 6) {
    return res.status(400).json({ error: 'Password must be at least 6 characters.' });
  }
  await db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(hashPassword(newPassword), req.user.id);
  const updated = await db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.id);
  const token = parseCookies(req).sid;
  if (token) sessionCache.set(token, { user: updated, cachedAt: Date.now() });
  res.json({ ok: true, message: 'Admin password updated successfully.' });
});

app.put('/api/admin/students/:id/password', requireAuth, requireAdmin, async (req, res) => {
  const studentId = parseInt(req.params.id, 10);
  const newPassword = String(req.body?.password || '').trim();
  if (!newPassword || newPassword.length < 6) {
    return res.status(400).json({ error: 'Password must be at least 6 characters.' });
  }
  const user = await db.prepare('SELECT id, email, name, role FROM users WHERE id = ?').get(studentId);
  if (!user) {
    return res.status(404).json({ error: 'Student not found.' });
  }
  await db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(hashPassword(newPassword), studentId);
  // Clear cached sessions for this student
  for (const [token, s] of sessionCache.entries()) {
    if (s.user && s.user.id === studentId) {
      sessionCache.delete(token);
    }
  }
  res.json({ ok: true, message: `Password updated for ${user.name || user.email}.` });
});

/* ------------------------------------------------------------------ */
/* SPA fallback (local only; on Vercel the CDN serves public/)         */
/* ------------------------------------------------------------------ */
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// On Vercel, export the app. Locally, start listening.
if (IS_VERCEL) {
  module.exports = app;
} else {
  app.listen(PORT, () => {
    console.log(`Cryptic Coding Arena running at http://localhost:${PORT}`);
  });
  module.exports = app;
}
