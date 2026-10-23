/* ============================================================
   Cryptic Coding Arena — SPA (hash router, no framework)
   ============================================================ */
'use strict';

/* ---------------- helpers ---------------- */
const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const apiCache = new Map(); // path -> { data, time }
const apiInflight = new Map(); // path -> Promise
const API_CACHE_TTL_MS = 20000; // 20s client-side cache for GET

async function api(path, { method = 'GET', body, bustCache = false } = {}) {
  const m = method.toUpperCase();
  const isGet = m === 'GET';
  const isQuiz = path.includes('/quiz/');

  if (isGet && !bustCache && !isQuiz) {
    const cached = apiCache.get(path);
    if (cached && (Date.now() - cached.time < API_CACHE_TTL_MS)) {
      return cached.data;
    }
    if (apiInflight.has(path)) {
      return apiInflight.get(path);
    }
  }

  const fetchPromise = (async () => {
    try {
      const res = await fetch(path, {
        method: m,
        headers: body ? { 'Content-Type': 'application/json' } : {},
        body: body ? JSON.stringify(body) : undefined,
      });
      let data = {};
      try { data = await res.json(); } catch { /* empty body */ }
      if (!res.ok) {
        const err = new Error(data.error || `Request failed (${res.status})`);
        err.code = data.code;
        throw err;
      }
      if (isGet && !isQuiz) {
        apiCache.set(path, { data, time: Date.now() });
      } else if (!isGet) {
        apiCache.clear(); // invalidate cache on mutations
      }
      return data;
    } finally {
      apiInflight.delete(path);
    }
  })();

  if (isGet && !bustCache && !isQuiz) {
    apiInflight.set(path, fetchPromise);
  }

  return fetchPromise;
}

function toast(msg, kind = 'info') {
  const root = $('#toast-root');
  const el = document.createElement('div');
  el.className = `toast ${kind}`;
  el.innerHTML = `<span>${kind === 'success' ? '✅' : kind === 'error' ? '⚠️' : '💡'}</span><span>${esc(msg)}</span>`;
  root.appendChild(el);
  setTimeout(() => { el.style.opacity = '0'; el.style.transition = 'opacity .4s'; setTimeout(() => el.remove(), 400); }, 4200);
}

let lastSecurityToast = 0;
function securityNotice(msg) {
  const now = Date.now();
  if (now - lastSecurityToast > 1400) {
    lastSecurityToast = now;
    toast(msg, 'error');
  }
}

const fmtDate = (d) => new Date(d).toLocaleString([], { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
const fmtDateFull = (d) => new Date(d).toLocaleString([], { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });
const fmtSecs = (s) => `${Math.floor(s / 60)}m ${s % 60}s`;
const initials = (name) => String(name || '?').split(/\s+/).map((w) => w[0]).slice(0, 2).join('').toUpperCase();
const medal = (r) => (r === 1 ? '🥇' : r === 2 ? '🥈' : r === 3 ? '🥉' : `#${r}`);

function timeLeftStr(ms) {
  if (ms <= 0) return '00:00:00';
  const t = Math.floor(ms / 1000);
  const h = String(Math.floor(t / 3600)).padStart(2, '0');
  const m = String(Math.floor((t % 3600) / 60)).padStart(2, '0');
  const s = String(t % 60).padStart(2, '0');
  return `${h}:${m}:${s}`;
}

function toLocalInput(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (isNaN(d.getTime())) return '';
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function toIsoFromInput(val) {
  if (!val) return '';
  const parts = String(val).split('T');
  if (parts.length !== 2) {
    const d = new Date(val);
    return isNaN(d.getTime()) ? '' : d.toISOString();
  }
  const [datePart, timePart] = parts;
  const [y, m, d] = datePart.split('-').map(Number);
  const [hh, mm] = timePart.split(':').map(Number);
  if (!y || !m || !d || isNaN(hh) || isNaN(mm)) return '';
  const dt = new Date(y, m - 1, d, hh, mm, 0, 0);
  return isNaN(dt.getTime()) ? '' : dt.toISOString();
}

const SUPPORTED_LANGUAGES = [
  { id: 'javascript', label: 'JavaScript (Node.js)', icon: '⚡' },
  { id: 'python', label: 'Python 3', icon: '🐍' },
  { id: 'c', label: 'C (GCC)', icon: '⚙️' },
  { id: 'cpp', label: 'C++ (G++)', icon: '🚀' },
  { id: 'java', label: 'Java (JDK)', icon: '☕' },
];

const DEFAULT_STARTER_CODE = {
  javascript: '// Read stdin: const input = require("fs").readFileSync(0, "utf-8").trim();\nconsole.log();\n',
  python: '# Read stdin: import sys; input_data = sys.stdin.read().split()\n# or val = input()\nprint()\n',
  c: '#include <stdio.h>\n\nint main() {\n    // Write your C solution\n    return 0;\n}\n',
  cpp: '#include <iostream>\nusing namespace std;\n\nint main() {\n    // Write your C++ solution\n    return 0;\n}\n',
  java: 'import java.util.Scanner;\n\npublic class Main {\n    public static void main(String[] args) {\n        Scanner sc = new Scanner(System.in);\n        // Write your Java solution\n    }\n}\n',
};

function getPrintHint(lang) {
  switch (lang) {
    case 'python': return 'print()';
    case 'c': return 'printf()';
    case 'cpp': return 'std::cout';
    case 'java': return 'System.out.println()';
    default: return 'console.log()';
  }
}

/* ---------------- global state ---------------- */
let ME = null; // current user
let quizState = null; // active quiz player state
let quizTimer = null;

/* ============================================================
   NAVBAR
   ============================================================ */
function renderNav(active = '') {
  const nav = $('#navbar');
  if (!ME) { nav.classList.add('hidden'); nav.innerHTML = ''; return; }
  nav.classList.remove('hidden');
  const links = [
    { href: '#/dashboard', label: '🏠 Competitions' },
    { href: '#/leaderboard', label: '🏆 Leaderboards' },
    { href: '#/overall', label: '🌍 Overall Ranking' },
  ];
  if (ME.role === 'admin') links.push({ href: '#/admin', label: '🛠️ Admin Panel' });
  nav.innerHTML = `
    <div class="navbar-inner">
      <div class="logo" onclick="location.hash='#/dashboard'"><span class="logo-icon">⚔️</span> Cryptic Coding<span class="grad-text">Arena</span></div>
      <div class="nav-links">
        ${links.map((l) => `<a class="nav-link ${active === l.href ? 'active' : ''}" href="${l.href}">${l.label}</a>`).join('')}
      </div>
      <div class="nav-right">
        <div class="nav-user">
          <b>${esc(ME.name || ME.email)}</b>
          <span>${ME.role === 'admin' ? 'Administrator' : esc(ME.program_name || 'Student')}</span>
        </div>
        <div class="avatar" title="Profile" onclick="location.hash='#/profile'">${esc(initials(ME.name || ME.email))}</div>
        <button class="btn btn-ghost btn-sm" onclick="logout()">Logout</button>
      </div>
    </div>`;
}

async function logout() {
  try { await api('/api/auth/logout', { method: 'POST' }); } catch { /* ignore */ }
  ME = null;
  apiCache.clear();
  try { localStorage.removeItem('coding_arena_user'); } catch {}
  location.hash = '#/login';
}

/* ============================================================
   AUTH VIEWS
   ============================================================ */
function authHero() {
  return `
    <div class="auth-hero">
      <h1>Compete. Code. <span class="grad-text">Climb the ranks.</span></h1>
      <p class="tagline">Cryptic Coding Arena is your campus platform for live programming competitions — objective quizzes and real output-based coding tasks, scored instantly, ranked globally.</p>
      <ul class="feature-list">
        <li><span class="ico">⚡</span><span><b>Live competitions</b>Join events created by your admin and compete in real time.</span></li>
        <li><span class="ico">💻</span><span><b>Two question types</b>Objective MCQs + practical output-based code challenges you actually write code for.</span></li>
        <li><span class="ico">🏅</span><span><b>Rankings everywhere</b>Per-competition ranks plus an overall campus leaderboard.</span></li>
      </ul>
      <div class="code-demo">
        <span class="c">// your journey</span><br/>
        <span class="k">const</span> you = <span class="f">register</span>();<br/>
        you.<span class="f">completeProfile</span>();<br/>
        you.<span class="f">compete</span>(<span class="s">'CodeSprint'</span>);<br/>
        you.<span class="f">rank</span> = <span class="s">'#1'</span>; <span class="caret"></span>
      </div>
    </div>`;
}

function viewLogin() {
  renderNav();
  $('#app').innerHTML = `
    <div class="auth-wrap page-enter">
      ${authHero()}
      <div class="card auth-form">
        <h2>Welcome back 👋</h2>
        <p class="muted" style="margin-top:-4px;font-size:14px">Log in to continue your coding journey.</p>
        <form id="login-form" style="margin-top:18px">
          <div class="field">
            <label>Email (your user ID) <span class="req">*</span></label>
            <input class="input" type="email" name="email" placeholder="you@student.campus.edu" required />
          </div>
          <div class="field">
            <label>Password <span class="req">*</span></label>
            <input class="input" type="password" name="password" placeholder="••••••••" required />
          </div>
          <button class="btn btn-primary btn-block" type="submit">Log In →</button>
        </form>
        <p class="muted" style="font-size:13.5px;margin-top:16px">New student? <a class="link" href="#/register">Create an account</a></p>
      </div>
    </div>`;
  $('#login-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const f = new FormData(e.target);
    try {
      const { user } = await api('/api/auth/login', { method: 'POST', body: { email: f.get('email'), password: f.get('password') } });
      ME = user;
      try { localStorage.setItem('coding_arena_user', JSON.stringify(user)); } catch {}
      toast(`Welcome back, ${user.name || user.email}!`, 'success');
      location.hash = user.role === 'admin' ? '#/admin' : '#/dashboard';
    } catch (err) { toast(err.message, 'error'); }
  });
}

function viewRegister() {
  renderNav();
  const f = (name, label, type = 'text', req = true, placeholder = '') => `
    <div class="field">
      <label>${label}${req ? ' <span class="req">*</span>' : ''}</label>
      <input class="input" type="${type}" name="${name}" placeholder="${placeholder}" ${req ? 'required' : ''} />
    </div>`;
  $('#app').innerHTML = `
    <div class="auth-wrap page-enter">
      ${authHero()}
      <div class="card auth-form">
        <h2>Create your account 🚀</h2>
        <p class="muted" style="margin-top:-4px;font-size:14px">Your <b>email is your user ID</b>. Fill in your academic details — they appear on your leaderboard profile.</p>
        <form id="reg-form" style="margin-top:16px">
          <div class="form-row">${f('name', 'Full Name')}${f('email', 'Email (User ID)', 'email')}</div>
          <div class="field">
            <label>Password <span class="req">*</span></label>
            <input class="input" type="password" name="password" minlength="6" placeholder="Minimum 6 characters" required />
          </div>
          <div class="form-row">${f('enrollment_no', 'Enrollment No.')}${f('admission_no', 'Admission No.')}</div>
          ${f('school_name', 'School / Faculty Name', 'text', true, 'e.g. School of Computer Science')}
          <div class="form-row">
            ${f('program_name', 'Program Name', 'text', true, 'e.g. B.Tech CSE')}
            <div class="form-row">
              ${f('section', 'Section', 'text', true, 'A')}
              ${f('batch_year', 'Batch Year', 'text', true, '2024')}
            </div>
          </div>
          <button class="btn btn-primary btn-block" type="submit" style="margin-top:6px">Create Account &amp; Login →</button>
        </form>
        <p class="muted" style="font-size:13.5px;margin-top:14px">Already registered? <a class="link" href="#/login">Log in</a></p>
      </div>
    </div>`;
  $('#reg-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const fd = Object.fromEntries(new FormData(e.target).entries());
    try {
      const { user } = await api('/api/auth/register', { method: 'POST', body: fd });
      ME = user;
      try { localStorage.setItem('coding_arena_user', JSON.stringify(user)); } catch {}
      toast('Account created — welcome to Cryptic Coding Arena! 🎉', 'success');
      location.hash = '#/dashboard';
    } catch (err) { toast(err.message, 'error'); }
  });
}

/* ============================================================
   STUDENT DASHBOARD
   ============================================================ */
function statusBadge(status) {
  if (status === 'live') return '<span class="badge badge-live"><span class="pulse-dot"></span> Live now</span>';
  if (status === 'upcoming') return '<span class="badge badge-upcoming">⏳ Upcoming</span>';
  return '<span class="badge badge-ended">✔ Ended</span>';
}

function viewDashboard() {
  renderNav('#/dashboard');
  if (!apiCache.has('/api/competitions')) {
    $('#app').innerHTML = '<div class="spinner"></div>';
  }
  Promise.all([api('/api/competitions'), api('/api/rankings/overall'), api('/api/me/participations')])
    .then(([comps, overall, parts]) => {
      const myOverall = overall.me;
      const incomplete = !ME.profile_complete;
      const liveCount = comps.competitions.filter((c) => c.status === 'live').length;

      const cards = comps.competitions.map((c) => {
        let action = '';
        if (c.status === 'upcoming') {
          action = c.registered
            ? '<button class="btn btn-ghost btn-sm" disabled>✓ Registered</button>'
            : `<button class="btn btn-primary btn-sm" onclick="registerComp(${c.id})">Register Now</button>`;
        } else if (c.status === 'live') {
          if (c.my_attempt) {
            action = `<button class="btn btn-ghost btn-sm" onclick="location.hash='#/result-comp/${c.id}'">View Result (${c.my_attempt.score} pts)</button>`;
          } else if (c.registered) {
            action = `<button class="btn btn-primary btn-sm" onclick="location.hash='#/quiz/${c.id}'">▶ Start Quiz</button>`;
          } else {
            action = `<button class="btn btn-primary btn-sm" onclick="registerComp(${c.id}, true)">Register &amp; Play</button>`;
          }
        } else {
          action = c.my_attempt
            ? `<button class="btn btn-ghost btn-sm" onclick="location.hash='#/result-comp/${c.id}'">View Result (${c.my_attempt.score} pts)</button>`
            : '<button class="btn btn-ghost btn-sm" disabled>Missed</button>';
        }
        const when = c.status === 'live'
          ? `<span class="chip">⏳ closes in <span class="countdown" data-end="${esc(c.ends_at)}">…</span></span>`
          : `<span class="chip">🗓 ${fmtDate(c.starts_at)}</span>`;
        return `
          <div class="card hoverable comp-card">
            <div style="display:flex;justify-content:space-between;gap:10px;align-items:flex-start">
              ${statusBadge(c.status)}
              ${c.my_rank ? `<span class="badge badge-info">${medal(c.my_rank)} rank</span>` : ''}
            </div>
            <h3 class="comp-title">${esc(c.title)}</h3>
            <p class="comp-desc">${esc(c.description || 'No description provided.')}</p>
            <div class="comp-meta">
              <span class="chip">🎓 ${c.batch_year ? esc(c.batch_year) + ' Batch' : 'All Batches'}</span>
              <span class="chip">❓ ${c.question_count} questions</span>
              <span class="chip">🎯 ${c.total_points} pts</span>
              <span class="chip">⏱ ${c.duration_minutes} min</span>
              <span class="chip">👥 ${c.participant_count} participants</span>
              ${when}
            </div>
            <div class="comp-actions">
              ${action}
              <button class="btn btn-ghost btn-sm" onclick="location.hash='#/leaderboard/${c.id}'">Leaderboard</button>
            </div>
          </div>`;
      }).join('');

      const partsRows = parts.participations.map((p) => `
        <tr>
          <td><b>${esc(p.title)}</b></td>
          <td>${statusBadge(p.status)}</td>
          <td class="score-cell">${p.score}</td>
          <td>${p.correct_count}/${p.total_questions}</td>
          <td class="rank-num ${p.rank <= 3 ? 'rank-' + p.rank : ''}">${medal(p.rank)} <span class="faint">of ${p.participants}</span></td>
          <td><button class="btn btn-ghost btn-sm" onclick="location.hash='#/result-comp/${p.id}'">Review</button></td>
        </tr>`).join('');

      $('#app').innerHTML = `
        <div class="page-enter">
          ${incomplete ? `
            <div class="banner">
              <span class="banner-ico">⚠️</span>
              <div class="banner-body"><b>Your profile is incomplete.</b> Complete all academic details to participate in competitions.</div>
              <button class="btn btn-primary btn-sm" onclick="location.hash='#/profile'">Complete Profile</button>
            </div>` : ''}
          <div class="section-head" style="margin-top:6px">
            <div>
              <h1>Hey ${esc((ME.name || '').split(' ')[0] || 'Coder')} 👋</h1>
              <p class="muted">${liveCount > 0 ? `🔥 <b>${liveCount} competition${liveCount > 1 ? 's are' : ' is'} LIVE right now</b> — jump in!` : 'No live competitions right now — check back soon.'}</p>
            </div>
            <div class="grid grid-3" style="min-width:330px">
              <div class="card stat-card"><div class="stat-val">${myOverall ? '#' + myOverall.rank : '—'}</div><div class="stat-label">Overall Rank</div></div>
              <div class="card stat-card"><div class="stat-val">${myOverall ? myOverall.total_score : 0}</div><div class="stat-label">Total Points</div></div>
              <div class="card stat-card"><div class="stat-val">${myOverall ? myOverall.avg_accuracy + '%' : '—'}</div><div class="stat-label">Avg Accuracy</div></div>
            </div>
          </div>

          <div class="section-head"><h2>🎯 Competitions</h2></div>
          ${comps.competitions.length ? `<div class="grid grid-2">${cards}</div>` : `
            <div class="card empty-state"><div class="es-ico">📭</div>No competitions yet. Stay tuned!</div>`}

          <div class="section-head"><h2>📜 My Participations</h2></div>
          ${parts.participations.length ? `
            <div class="table-wrap"><table class="lb">
              <thead><tr><th>Competition</th><th>Status</th><th>Score</th><th>Correct</th><th>Your Rank</th><th></th></tr></thead>
              <tbody>${partsRows}</tbody>
            </table></div>` : `
            <div class="card empty-state"><div class="es-ico">🚀</div>You haven't completed any competition yet. Your history will appear here.</div>`}
        </div>`;
      startCountdowns();
    })
    .catch((e) => { toast(e.message, 'error'); $('#app').innerHTML = `<div class="card empty-state">${esc(e.message)}</div>`; });
}

async function registerComp(id, playNow = false) {
  try {
    await api(`/api/competitions/${id}/register`, { method: 'POST' });
    toast('Registered successfully! 🎉', 'success');
    if (playNow) location.hash = `#/quiz/${id}`;
    else viewDashboard();
  } catch (err) {
    if (err.code === 'PROFILE_INCOMPLETE') {
      toast('Complete your profile first!', 'error');
      location.hash = '#/profile';
    } else toast(err.message, 'error');
  }
}

function startCountdowns() {
  $$('[data-end]').forEach((el) => {
    const end = new Date(el.dataset.end).getTime();
    const tick = () => {
      const rem = end - Date.now();
      el.textContent = rem > 0 ? timeLeftStr(rem) : 'closed';
    };
    tick();
    setInterval(tick, 1000);
  });
}

/* ============================================================
   COMPETITION DETAIL
   ============================================================ */
function viewCompetition(id) {
  renderNav('#/dashboard');
  if (!apiCache.has(`/api/competitions/${id}`)) {
    $('#app').innerHTML = '<div class="spinner"></div>';
  }
  api(`/api/competitions/${id}`).then(({ competition: c, leaderboard }) => {
    const lbRows = leaderboard.slice(0, 5).map((r) => `
      <tr class="${r.user_id === ME.id ? 'me-row' : ''}">
        <td class="rank-num ${r.rank <= 3 ? 'rank-' + r.rank : ''}">${medal(r.rank)}</td>
        <td><div class="user-cell"><div class="mini-avatar">${esc(initials(r.name))}</div>
          <div><div class="uc-name">${esc(r.name)}${r.user_id === ME.id ? ' <span class="faint">(you)</span>' : ''}</div>
          <div class="uc-sub">${esc(r.enrollment_no || '')} · ${esc(r.program_name || '')}</div></div></div></td>
        <td class="score-cell">${r.score}</td>
      </tr>`).join('');

    let mainAction = '';
    if (c.status === 'upcoming') {
      mainAction = c.registered
        ? '<button class="btn btn-ghost" disabled>✓ Registered — waiting for start</button>'
        : `<button class="btn btn-primary" onclick="registerComp(${c.id})">Register for this Competition</button>`;
    } else if (c.status === 'live') {
      if (c.attempt && c.attempt.status === 'submitted') {
        mainAction = `<button class="btn btn-primary" onclick="location.hash='#/result-comp/${c.id}'">View My Result</button>`;
      } else {
        mainAction = c.registered
          ? `<button class="btn btn-primary" onclick="location.hash='#/quiz/${c.id}'">▶ Start Competition Now</button>`
          : `<button class="btn btn-primary" onclick="registerComp(${c.id}, true)">Register &amp; Start</button>`;
      }
    } else {
      mainAction = c.attempt && c.attempt.status === 'submitted'
        ? `<button class="btn btn-primary" onclick="location.hash='#/result-comp/${c.id}'">View My Result</button>`
        : '<button class="btn btn-ghost" disabled>Competition ended</button>';
    }

    $('#app').innerHTML = `
      <div class="page-enter">
        <a class="link" href="#/dashboard">← Back to competitions</a>
        <div class="card" style="margin-top:14px">
          <div style="display:flex;justify-content:space-between;gap:12px;flex-wrap:wrap;align-items:center">
            ${statusBadge(c.status)}
            ${c.my_rank ? `<span class="badge badge-info">Your rank: ${medal(c.my_rank)} of ${c.participant_count}</span>` : ''}
          </div>
          <h1 style="margin-top:12px">${esc(c.title)}</h1>
          <p class="muted" style="line-height:1.7;max-width:760px">${esc(c.description)}</p>
          <div class="details-grid">
            <div class="detail-box"><div class="db-label">Eligible Batch</div><div class="db-value">🎓 ${c.batch_year ? esc(c.batch_year) + ' Batch' : 'All Batches'}</div></div>
            <div class="detail-box"><div class="db-label">Starts</div><div class="db-value">${fmtDateFull(c.starts_at)}</div></div>
            <div class="detail-box"><div class="db-label">Ends</div><div class="db-value">${fmtDateFull(c.ends_at)}</div></div>
            <div class="detail-box"><div class="db-label">Duration</div><div class="db-value">⏱ ${c.duration_minutes} minutes</div></div>
            <div class="detail-box"><div class="db-label">Questions</div><div class="db-value">❓ ${c.question_count} (${c.total_points} pts)</div></div>
            <div class="detail-box"><div class="db-label">Participants</div><div class="db-value">👥 ${c.participant_count}</div></div>
          </div>
          <div style="margin-top:8px">${mainAction}</div>
        </div>

        <div class="grid grid-2" style="margin-top:18px">
          <div class="card">
            <h2>🏆 Top contestants</h2>
            ${leaderboard.length ? `<div class="table-wrap"><table class="lb">
              <thead><tr><th>Rank</th><th>Student</th><th>Score</th></tr></thead>
              <tbody>${lbRows}</tbody></table></div>
              <button class="btn btn-ghost btn-sm" style="margin-top:14px" onclick="location.hash='#/leaderboard/${c.id}'">Full leaderboard →</button>`
              : '<div class="empty-state"><div class="es-ico">🧭</div>No submissions yet — be the first!</div>'}
          </div>
          <div class="card">
            <h2>📖 How it works</h2>
            <details class="faq"><summary>Objective questions</summary><p class="muted">Multiple-choice questions graded instantly and automatically.</p></details>
            <details class="faq"><summary>Output-based (practical) questions</summary><p class="muted">You write real JavaScript in the editor. Your code is executed on the server and its output is compared with the expected output. Syntax errors and infinite loops are handled safely (2.5s limit).</p></details>
            <details class="faq"><summary>Ranking rules</summary><p class="muted">Higher score wins. Ties are broken by faster completion time. Only your best submitted attempt counts.</p></details>
          </div>
        </div>
      </div>`;
  }).catch((e) => { toast(e.message, 'error'); location.hash = '#/dashboard'; });
}

/* ============================================================
   QUIZ PLAYER
   ============================================================ */
function viewQuiz(compId) {
  renderNav('#/dashboard');
  $('#app').innerHTML = '<div class="spinner"></div>';
  api(`/api/competitions/${compId}/start`, { method: 'POST' })
    .then((data) => {
      quizState = {
        compId,
        attempt: data.attempt,
        competition: data.competition,
        questions: data.questions,
        idx: 0,
        answers: {},
        testResults: {},
        activeTcTab: {},
      };
      renderQuiz();
      if (quizTimer) clearInterval(quizTimer);
      quizTimer = setInterval(() => {
        const rem = quizState.attempt.deadline - Date.now();
        const t = $('#quiz-timer');
        if (t) {
          t.textContent = timeLeftStr(rem);
          t.classList.toggle('warn', rem < 60000);
        }
        if (rem <= 0 && quizState) {
          clearInterval(quizTimer);
          toast("Time's up! Auto-submitting…", 'error');
          submitQuiz(true);
        }
      }, 1000);
    })
    .catch((e) => {
      if (e.code === 'ALREADY_SUBMITTED') { location.hash = `#/result-comp/${compId}`; return; }
      toast(e.message, 'error');
      location.hash = `#/competition/${compId}`;
    });
}

function renderQuiz() {
  const s = quizState;
  if (!s) return;
  const q = s.questions[s.idx];
  const answeredCount = s.questions.filter((x) => s.answers[x.id] !== undefined && String(s.answers[x.id]).trim() !== '').length;
  const dots = s.questions.map((x, i) => {
    const answered = s.answers[x.id] !== undefined && String(s.answers[x.id]).trim() !== '';
    return `<div class="q-dot ${answered ? 'answered' : ''} ${i === s.idx ? 'current' : ''}" onclick="goQ(${i})">${i + 1}</div>`;
  }).join('');

  let body = '';
  if (q.type === 'mcq') {
    body = q.options.map((opt, i) => `
      <div class="option ${s.answers[q.id] === opt ? 'selected' : ''}" onclick="selectOption(${q.id}, ${i})">
        <div class="opt-key">${String.fromCharCode(65 + i)}</div>
        <div>${esc(opt)}</div>
      </div>`).join('');
  } else {
    const qLang = s.answers[`${q.id}_lang`] || q.language || 'javascript';
    const langObj = SUPPORTED_LANGUAGES.find((l) => l.id === qLang) || SUPPORTED_LANGUAGES[0];
    const printHint = getPrintHint(qLang);
    const tcs = q.test_cases && q.test_cases.length ? q.test_cases : [{ case_number: 1, input: '', output: '', hidden: false }];
    if (s.activeTcTab[q.id] === undefined) s.activeTcTab[q.id] = 0;
    const currentTab = Math.min(s.activeTcTab[q.id], tcs.length - 1);
    const result = s.testResults[q.id] || null;

    const tcTabsHtml = tcs.map((tc, ti) => {
      let statusClass = '';
      let statusIco = '';
      if (result && result.cases && result.cases[ti]) {
        const cRes = result.cases[ti];
        if (cRes.passed) { statusClass = 'pass'; statusIco = '✔ '; }
        else { statusClass = 'fail'; statusIco = '✖ '; }
      }
      return `
        <button type="button" class="tc-tab-btn ${ti === currentTab ? 'active' : ''} ${statusClass}" onclick="switchTcTab(${q.id}, ${ti})">
          ${statusIco}${tc.hidden ? '🔒 Case ' + (ti + 1) : 'Case ' + (ti + 1)}
        </button>
      `;
    }).join('');

    const activeTc = tcs[currentTab] || tcs[0];
    const activeRes = result && result.cases ? result.cases[currentTab] : null;

    let tcBodyHtml = '';
    if (result && result.summary) {
      let bannerClass = 'ok';
      let bannerText = `🎉 All ${result.summary.total} Test Cases Passed!`;
      if (result.summary.error) {
        bannerClass = 'err';
        bannerText = `❌ Error: ${esc(result.summary.error)}`;
      } else if (!result.summary.all_passed) {
        bannerClass = result.summary.passed_count > 0 ? 'warn' : 'err';
        bannerText = `⚠️ ${result.summary.passed_count} of ${result.summary.total} Test Cases Passed`;
      }

      let caseDetailHtml = '';
      if (activeRes) {
        if (activeRes.hidden) {
          caseDetailHtml = `
            <div style="padding:10px 0">
              <span style="font-weight:600;font-size:13px">🔒 Hidden Test Case:</span>
              ${activeRes.passed ? '<span class="badge badge-info" style="margin-left:8px">Passed ✔</span>' : '<span class="badge" style="margin-left:8px;background:rgba(248,113,113,0.2);color:var(--red)">Failed ✖ (Output mismatch or error)</span>'}
              ${activeRes.error ? `<div class="tc-label" style="margin-top:10px;color:var(--red)">Error</div><pre class="tc-code" style="color:var(--red)">${esc(activeRes.error)}</pre>` : ''}
            </div>
          `;
        } else {
          caseDetailHtml = `
            <div class="tc-label">Input (stdin)</div>
            <pre class="tc-code">${esc(activeRes.input || '(no stdin input)')}</pre>
            <div class="tc-label">Expected Output</div>
            <pre class="tc-code">${esc(activeRes.expected || '')}</pre>
            <div class="tc-label">Your Code Output</div>
            <pre class="tc-code" style="color:${activeRes.passed ? 'var(--green)' : 'var(--red)'}">${esc(activeRes.actual || '(no output)')}</pre>
            ${activeRes.error ? `<div class="tc-label" style="color:var(--red)">Runtime / Compiler Error</div><pre class="tc-code" style="color:var(--red)">${esc(activeRes.error)}</pre>` : ''}
          `;
        }
      }

      tcBodyHtml = `
        <div class="tc-summary-banner ${bannerClass}">
          <div>${bannerText}</div>
          <div style="font-size:12px;opacity:0.85">${result.summary.passed_count}/${result.summary.total} Passed</div>
        </div>
        ${caseDetailHtml}
      `;
    } else {
      if (activeTc.hidden) {
        tcBodyHtml = `
          <div style="padding:14px 6px;color:var(--muted);font-size:13.5px">
            🔒 <b>Hidden Test Case</b>: The input and output are hidden. This test case will be evaluated against your code when you click <b>Run &amp; Check Test Cases</b> or submit.
          </div>
        `;
      } else {
        tcBodyHtml = `
          <div class="tc-label">Input (stdin)</div>
          <pre class="tc-code">${esc(activeTc.input || '(no stdin input)')}</pre>
          <div class="tc-label">Expected Output</div>
          <pre class="tc-code">${esc(activeTc.output || '')}</pre>
        `;
      }
    }

    body = `
      <p class="muted" style="font-size:13.5px;margin:-8px 0 12px">✍️ Write your solution in <b>${langObj.label}</b>. Use <span class="mono">${printHint}</span> to print the output. Code is tested against all test cases.</p>
      <div class="code-area">
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px;gap:8px;flex-wrap:wrap">
          <div style="display:flex;align-items:center;gap:8px">
            <span class="faint" style="font-size:12.5px">Language:</span>
            <select class="input" style="padding:4px 10px;font-size:13px;width:auto;height:auto" id="quiz-lang-select" onchange="changeQuizLang(${q.id}, this.value)">
              ${SUPPORTED_LANGUAGES.map((l) => `<option value="${l.id}" ${qLang === l.id ? 'selected' : ''}>${l.icon} ${l.label}</option>`).join('')}
            </select>
          </div>
          <span class="chip" style="font-size:11.5px;padding:3px 9px;color:var(--muted);border-color:rgba(255,255,255,0.08)"><span style="opacity:0.85">🔒</span> Copy, Paste &amp; Right-click disabled</span>
        </div>
        <textarea class="code-editor" id="code-editor" spellcheck="false"
          oninput="saveCode(${q.id})"
          onpaste="return false;"
          oncopy="return false;"
          oncut="return false;"
          oncontextmenu="return false;"
          ondrop="return false;">${esc(s.answers[q.id] ?? q.starter_code ?? '')}</textarea>
        <div style="display:flex;gap:10px;margin-top:11px;flex-wrap:wrap;align-items:center">
          <button type="button" class="btn btn-primary btn-sm" id="test-run-btn" onclick="runTestCases(${q.id})">▶ Run &amp; Check Test Cases</button>
          <button type="button" class="btn btn-ghost btn-sm" id="run-btn" onclick="runCode(${q.id})">▶ Run Code</button>
          <span class="faint" style="align-self:center">Checks your solution against all ${tcs.length} test case(s).</span>
        </div>
        <div class="console-out hidden" id="console-out"></div>
        <div class="tc-panel">
          <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:10px">
            <div style="font-size:13px;font-weight:700">🧪 Test Cases (${tcs.length})</div>
          </div>
          <div class="tc-tabs">${tcTabsHtml}</div>
          <div class="tc-view">${tcBodyHtml}</div>
        </div>
      </div>`;
  }

  $('#app').innerHTML = `
    <div class="page-enter">
      <div class="quiz-top">
        <div>
          <b style="font-size:15px">${esc(s.competition.title)}</b>
          <div class="faint">Question ${s.idx + 1} of ${s.questions.length} · ${answeredCount} answered</div>
        </div>
        <div class="timer" id="quiz-timer">${timeLeftStr(s.attempt.deadline - Date.now())}</div>
        <div class="q-dots">${dots}</div>
        <button class="btn btn-primary btn-sm" style="margin-left:auto" onclick="submitQuiz(false)">📤 Submit Quiz</button>
      </div>

      <div class="card q-body">
        <span class="badge ${q.type === 'mcq' ? 'badge-info' : 'badge-upcoming'}">${q.type === 'mcq' ? '🎯 Objective' : '💻 Practical · Output based'} · ${q.points} pts</span>
        <div class="q-prompt">${esc(q.prompt)}</div>
        ${body}
        <div class="quiz-nav">
          <button class="btn btn-ghost" ${s.idx === 0 ? 'disabled' : ''} onclick="goQ(${s.idx - 1})">← Previous</button>
          ${s.idx === s.questions.length - 1
            ? '<button class="btn btn-primary" onclick="submitQuiz(false)">📤 Submit Quiz</button>'
            : `<button class="btn btn-primary" onclick="goQ(${s.idx + 1})">Next →</button>`}
        </div>
      </div>
    </div>`;

  // Attach anti-cheat protections for participants in practical coding
  if (q.type !== 'mcq') {
    const ed = $('#code-editor');
    if (ed) {
      // Prevent context menu (right click)
      ed.addEventListener('contextmenu', (e) => {
        e.preventDefault();
        securityNotice('Right-click is disabled during the competition.');
      });

      // Prevent paste event (mouse or shortcut)
      ed.addEventListener('paste', (e) => {
        e.preventDefault();
        securityNotice('Pasting is disabled for practical challenges. Please write your own code.');
      });

      // Prevent copy event
      ed.addEventListener('copy', (e) => {
        e.preventDefault();
        securityNotice('Copying code is disabled for this challenge.');
      });

      // Prevent cut event
      ed.addEventListener('cut', (e) => {
        e.preventDefault();
        securityNotice('Cut is disabled for this challenge.');
      });

      // Prevent drag-and-drop into editor
      ed.addEventListener('drop', (e) => {
        e.preventDefault();
        securityNotice('Pasting or dropping code is disabled.');
      });
      ed.addEventListener('dragover', (e) => {
        e.preventDefault();
      });

      // Intercept keyboard shortcuts (Ctrl+V, Ctrl+C, Ctrl+X, Cmd+V, Cmd+C, Cmd+X, Shift+Insert, Ctrl+Insert)
      // and support Tab key indentation
      ed.addEventListener('keydown', (e) => {
        const isMod = e.ctrlKey || e.metaKey;
        const k = e.key ? e.key.toLowerCase() : '';

        if ((isMod && k === 'v') || (e.shiftKey && e.key === 'Insert')) {
          e.preventDefault();
          securityNotice('Ctrl+V / Pasting is disabled for practical challenges.');
          return;
        }
        if ((isMod && k === 'c') || (isMod && e.key === 'Insert')) {
          e.preventDefault();
          securityNotice('Ctrl+C / Copying is disabled for this challenge.');
          return;
        }
        if (isMod && k === 'x') {
          e.preventDefault();
          securityNotice('Ctrl+X / Cut is disabled for this challenge.');
          return;
        }

        // Tab indentation support
        if (e.key === 'Tab') {
          e.preventDefault();
          const start = ed.selectionStart;
          const end = ed.selectionEnd;
          ed.value = ed.value.substring(0, start) + '    ' + ed.value.substring(end);
          ed.selectionStart = ed.selectionEnd = start + 4;
          saveCode(q.id);
        }
      });
    }

    const codeArea = $('.code-area');
    if (codeArea) {
      codeArea.addEventListener('contextmenu', (e) => {
        e.preventDefault();
        securityNotice('Right-click is disabled during the competition.');
      });
    }
  }

  // Disable right-click across the entire question card during competitions
  const qBody = $('.q-body');
  if (qBody) {
    qBody.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      securityNotice('Right-click is disabled during the competition.');
    });
  }
}

function changeQuizLang(qid, newLang) {
  if (!quizState) return;
  saveCurrentCode();
  const oldLang = quizState.answers[`${qid}_lang`] || quizState.questions.find((x) => x.id === qid)?.language || 'javascript';
  quizState.answers[`${qid}_lang`] = newLang;
  const currentCode = quizState.answers[qid];
  if (!currentCode || currentCode === DEFAULT_STARTER_CODE[oldLang]) {
    quizState.answers[qid] = DEFAULT_STARTER_CODE[newLang];
  }
  renderQuiz();
}

function goQ(i) {
  if (!quizState) return;
  saveCurrentCode();
  quizState.idx = Math.max(0, Math.min(quizState.questions.length - 1, i));
  renderQuiz();
}

function selectOption(qid, optIdx) {
  const q = quizState.questions.find((x) => x.id === qid);
  quizState.answers[qid] = q.options[optIdx];
  renderQuiz();
}

function saveCode(qid) {
  const ed = $('#code-editor');
  if (ed) quizState.answers[qid] = ed.value;
}

function saveCurrentCode() {
  const q = quizState.questions[quizState.idx];
  if (q.type === 'output') saveCode(q.id);
}

function switchTcTab(qid, tabIdx) {
  if (!quizState) return;
  saveCurrentCode();
  quizState.activeTcTab[qid] = tabIdx;
  renderQuiz();
}

async function runTestCases(qid) {
  saveCurrentCode();
  const btn = $('#test-run-btn');
  const code = quizState.answers[qid] || '';
  const language = quizState.answers[`${qid}_lang`] || quizState.questions[quizState.idx].language || 'javascript';
  if (!code.trim()) {
    toast('Please write some code first.', 'error');
    return;
  }
  if (btn) {
    btn.disabled = true;
    btn.textContent = '⏳ Testing code…';
  }
  try {
    const res = await api(`/api/questions/${qid}/test-run`, {
      method: 'POST',
      body: { code, language },
    });
    quizState.testResults[qid] = res;
    if (res.summary.all_passed) {
      toast(`🎉 All ${res.summary.total} test cases passed!`, 'success');
    } else if (res.summary.error) {
      toast('Execution error in test cases.', 'error');
    } else {
      toast(`${res.summary.passed_count}/${res.summary.total} test cases passed.`, 'info');
    }
    renderQuiz();
  } catch (e) {
    toast(e.message, 'error');
    if (btn) {
      btn.disabled = false;
      btn.textContent = '▶ Run & Check Test Cases';
    }
  }
}

async function runCode(qid) {
  saveCurrentCode();
  const btn = $('#run-btn');
  const out = $('#console-out');
  const code = quizState.answers[qid] || '';
  const language = quizState.answers[`${qid}_lang`] || quizState.questions[quizState.idx].language || 'javascript';
  btn.disabled = true; btn.textContent = '⏳ Running…';
  out.classList.remove('hidden', 'ok', 'err');
  out.textContent = `Running your ${language} code…`;
  try {
    const r = await api('/api/run', { method: 'POST', body: { code, language } });
    if (r.ok) {
      out.classList.add('ok');
      out.textContent = '✔ Finished successfully\n\n' + (r.stdout || `(no output — did you forget ${getPrintHint(language)}?)`);
    } else {
      out.classList.add('err');
      out.textContent = '✖ Error\n\n' + (r.error || 'Runtime error');
    }
  } catch (e) {
    out.classList.add('err');
    out.textContent = e.message;
  }
  btn.disabled = false; btn.textContent = '▶ Run Code';
}

async function submitQuiz(auto = false) {
  if (!quizState) return;
  saveCurrentCode();
  const s = quizState;
  const unanswered = s.questions.filter((x) => s.answers[x.id] === undefined || String(s.answers[x.id]).trim() === '').length;
  if (!auto) {
    const msg = unanswered > 0
      ? `${unanswered} question(s) unanswered. Submit anyway?`
      : 'Submit your quiz? You cannot change answers afterwards.';
    if (!confirm(msg)) return;
  }
  try {
    const r = await api(`/api/attempts/${s.attempt.id}/submit`, { method: 'POST', body: { answers: s.answers } });
    quizState = null;
    clearInterval(quizTimer);
    toast(`Submitted! You scored ${r.result.score} points.`, 'success');
    location.hash = `#/result/${s.attempt.id}`;
  } catch (e) {
    toast(e.message, 'error');
  }
}

/* ============================================================
   RESULT
   ============================================================ */
function ringSvg(pct) {
  const r = 72, c = 2 * Math.PI * r;
  const off = c - (pct / 100) * c;
  return `
    <svg width="168" height="168" viewBox="0 0 168 168">
      <circle cx="84" cy="84" r="${r}" fill="none" stroke="rgba(255,255,255,0.08)" stroke-width="12"/>
      <circle cx="84" cy="84" r="${r}" fill="none" stroke="url(#g1)" stroke-width="12" stroke-linecap="round"
        stroke-dasharray="${c}" stroke-dashoffset="${off}" style="transition:stroke-dashoffset 1s ease"/>
      <defs><linearGradient id="g1" x1="0%" y1="0%" x2="100%" y2="100%">
        <stop offset="0%" stop-color="#22d3ee"/><stop offset="60%" stop-color="#8b5cf6"/><stop offset="100%" stop-color="#f472b6"/>
      </linearGradient></defs>
    </svg>`;
}

function viewResult(attemptId) {
  renderNav('#/dashboard');
  if (!apiCache.has(`/api/attempts/${attemptId}/result`)) {
    $('#app').innerHTML = '<div class="spinner"></div>';
  }
  api(`/api/attempts/${attemptId}/result`).then(({ attempt, details, rank, participants }) => {
    const totalPts = details.reduce((a, d) => a + d.points, 0);
    const pct = totalPts ? Math.round((attempt.score / totalPts) * 100) : 0;
    const reviews = details.map((d, i) => {
      const tcCount = d.test_cases ? d.test_cases.length : (d.total_test_cases || 0);
      const earned = d.earned_points !== undefined ? d.earned_points : (d.correct ? d.points : 0);
      return `
      <div class="review-item ${d.correct ? 'ok' : 'bad'}">
        <div class="rv-head">
          <span>${d.correct ? '✅' : '❌'}</span>
          <span>Q${i + 1}. ${esc(d.prompt.slice(0, 120))}${d.prompt.length > 120 ? '…' : ''}</span>
          <span class="badge ${d.correct ? 'badge-live' : 'badge-ended'}" style="margin-left:auto">${earned}/${d.points} pts</span>
        </div>
        <div class="rv-detail">
          ${d.type === 'mcq'
            ? `Your answer: <b>${esc(d.given || '(not answered)')}</b><br/>Correct answer: <b>${esc(d.answer)}</b>`
            : `${tcCount > 0 ? `Test cases: <b>${tcCount} test case(s) evaluated</b><br/>` : ''}Expected output: <b>${esc(d.answer)}</b><br/>Your submitted code:<pre>${esc(d.given || '(not answered)')}</pre>`}
        </div>
      </div>`;
    }).join('');

    const verdict = pct >= 70 ? '🔥 Outstanding performance!' : pct >= 40 ? '👍 Good effort — keep training!' : '💪 Practice makes perfect — try again!';
    $('#app').innerHTML = `
      <div class="page-enter">
        <div class="card result-hero">
          <div class="ring-wrap">${ringSvg(pct)}
            <div class="ring-label"><div><div class="rl-val">${attempt.score}<span class="faint" style="font-size:17px">/${totalPts}</span></div>
            <div class="rl-sub">${attempt.correct_count}/${attempt.total_questions} correct</div></div></div>
          </div>
          <div class="verdict grad-text">${verdict}</div>
          <p class="muted" style="margin-top:6px">You finished <b style="color:var(--text)">${medal(rank)}</b> out of <b style="color:var(--text)">${participants}</b> in <span class="mono">${esc(attempt.competition_title)}</span> · Time: <span class="mono">${fmtSecs(attempt.duration_seconds)}</span></p>
          <div style="display:flex;gap:12px;justify-content:center;margin-top:18px;flex-wrap:wrap">
            <button class="btn btn-primary" onclick="location.hash='#/leaderboard/${attempt.competition_id}'">🏆 View Leaderboard</button>
            <button class="btn btn-ghost" onclick="location.hash='#/dashboard'">Back to Competitions</button>
          </div>
        </div>
        <div class="section-head"><h2>📋 Answer Review</h2></div>
        ${reviews || '<div class="card empty-state">No answers recorded.</div>'}
      </div>`;
    if (rank <= 3 || pct >= 70) confettiBurst();
  }).catch((e) => { toast(e.message, 'error'); location.hash = '#/dashboard'; });
}

/* lightweight confetti */
function confettiBurst() {
  const cv = document.createElement('canvas');
  cv.style.cssText = 'position:fixed;inset:0;pointer-events:none;z-index:300';
  cv.width = innerWidth; cv.height = innerHeight;
  document.body.appendChild(cv);
  const ctx = cv.getContext('2d');
  const colors = ['#22d3ee', '#8b5cf6', '#f472b6', '#34d399', '#fbbf24'];
  const parts = Array.from({ length: 130 }, () => ({
    x: innerWidth / 2 + (Math.random() - 0.5) * 300, y: innerHeight * 0.32,
    vx: (Math.random() - 0.5) * 11, vy: Math.random() * -11 - 3,
    s: Math.random() * 7 + 4, c: colors[(Math.random() * colors.length) | 0], a: Math.random() * Math.PI,
  }));
  let frames = 0;
  (function draw() {
    ctx.clearRect(0, 0, cv.width, cv.height);
    parts.forEach((p) => {
      p.vy += 0.28; p.x += p.vx; p.y += p.vy; p.a += 0.15;
      ctx.save(); ctx.translate(p.x, p.y); ctx.rotate(p.a); ctx.fillStyle = p.c;
      ctx.fillRect(-p.s / 2, -p.s / 2, p.s, p.s * 0.6); ctx.restore();
    });
    if (++frames < 170) requestAnimationFrame(draw);
    else cv.remove();
  })();
}

/* ============================================================
   LEADERBOARDS
   ============================================================ */
function viewLeaderboardPicker() {
  renderNav('#/leaderboard');
  if (!apiCache.has('/api/competitions')) {
    $('#app').innerHTML = '<div class="spinner"></div>';
  }
  api('/api/competitions').then(({ competitions }) => {
    const cards = competitions.map((c) => `
      <div class="card hoverable comp-card" onclick="location.hash='#/leaderboard/${c.id}'" style="cursor:pointer">
        ${statusBadge(c.status)}
        <h3 class="comp-title">${esc(c.title)}</h3>
        <div class="comp-meta">
          <span class="chip">🎓 ${c.batch_year ? esc(c.batch_year) + ' Batch' : 'All Batches'}</span>
          <span class="chip">👥 ${c.participant_count} participants</span>
          ${c.my_rank ? `<span class="chip" style="color:var(--cyan)">Your rank: ${medal(c.my_rank)}</span>` : '<span class="chip">Not participated</span>'}
        </div>
        <button class="btn btn-ghost btn-sm">View leaderboard →</button>
      </div>`).join('');
    $('#app').innerHTML = `
      <div class="page-enter">
        <h1>🏆 Competition Leaderboards</h1>
        <p class="muted" style="margin-bottom:22px">Pick a competition to see its live rankings.</p>
        <div class="grid grid-3">${cards}</div>
        <div style="margin-top:22px">
          <button class="btn btn-primary" onclick="location.hash='#/overall'">🌍 See Overall Campus Ranking →</button>
        </div>
      </div>`;
  }).catch((e) => toast(e.message, 'error'));
}

function podiumHtml(leaderboard) {
  const top = leaderboard.slice(0, 3);
  if (top.length < 3) return '';
  const order = [1, 0, 2]; // 2nd, 1st, 3rd
  return `<div class="podium">${order.map((i) => {
    const r = top[i];
    const pts = r.total_score !== undefined && r.total_score !== null ? r.total_score : (r.score ?? 0);
    return `<div class="p-col p-${r.rank}">
      <div class="p-medal">${medal(r.rank)}</div>
      <div class="p-name">${esc(r.name)}</div>
      <div class="p-score">${pts} pts</div>
      <div class="p-block"></div>
    </div>`;
  }).join('')}</div>`;
}

function viewLeaderboard(compId) {
  renderNav('#/leaderboard');
  if (!apiCache.has(`/api/rankings/competition/${compId}`)) {
    $('#app').innerHTML = '<div class="spinner"></div>';
  }
  api(`/api/rankings/competition/${compId}`).then(({ competition: c, leaderboard, me }) => {
    const rows = leaderboard.map((r) => `
      <tr class="${r.user_id === ME.id ? 'me-row' : ''}">
        <td class="rank-num ${r.rank <= 3 ? 'rank-' + r.rank : ''}">${medal(r.rank)}</td>
        <td><div class="user-cell"><div class="mini-avatar">${esc(initials(r.name))}</div>
          <div><div class="uc-name">${esc(r.name)}${r.user_id === ME.id ? ' <span class="faint">(you)</span>' : ''}</div>
          <div class="uc-sub">${esc(r.enrollment_no || '')} · ${esc(r.program_name || '')} · ${esc(r.school_name || '')}</div></div></div></td>
        <td class="faint">${esc(r.section || '')} · ${esc(r.batch_year || '')}</td>
        <td class="score-cell">${r.score}</td>
        <td>${r.correct_count}/${r.total_questions}</td>
        <td class="mono faint">${fmtSecs(r.duration_seconds)}</td>
      </tr>`).join('');
    $('#app').innerHTML = `
      <div class="page-enter">
        <a class="link" href="#/leaderboard">← All leaderboards</a>
        <div class="section-head" style="margin-top:10px">
          <div><h1>🏆 ${esc(c.title)}</h1><p class="muted">${statusBadge(c.status)} &nbsp; ${leaderboard.length} participants ${me ? `· your rank: <b style="color:var(--cyan)">${medal(me.rank)}</b>` : ''}</p></div>
          <button class="btn btn-ghost" onclick="location.hash='#/overall'">🌍 Overall ranking</button>
        </div>
        ${podiumHtml(leaderboard)}
        ${leaderboard.length ? `
          <div class="table-wrap" style="margin-top:18px"><table class="lb">
            <thead><tr><th>Rank</th><th>Student</th><th>Section / Batch</th><th>Score</th><th>Correct</th><th>Time</th></tr></thead>
            <tbody>${rows}</tbody></table></div>`
          : '<div class="card empty-state"><div class="es-ico">📭</div>No submissions yet.</div>'}
      </div>`;
  }).catch((e) => { toast(e.message, 'error'); location.hash = '#/leaderboard'; });
}

function viewOverall() {
  renderNav('#/overall');
  if (!apiCache.has('/api/rankings/overall')) {
    $('#app').innerHTML = '<div class="spinner"></div>';
  }
  api('/api/rankings/overall').then(({ leaderboard, me }) => {
    const rows = leaderboard.map((r) => `
      <tr class="${r.user_id === ME.id ? 'me-row' : ''}">
        <td class="rank-num ${r.rank <= 3 ? 'rank-' + r.rank : ''}">${medal(r.rank)}</td>
        <td><div class="user-cell"><div class="mini-avatar">${esc(initials(r.name))}</div>
          <div><div class="uc-name">${esc(r.name)}${r.user_id === ME.id ? ' <span class="faint">(you)</span>' : ''}</div>
          <div class="uc-sub">${esc(r.email)}</div></div></div></td>
        <td class="faint">${esc(r.enrollment_no || '')}</td>
        <td class="faint">${esc(r.school_name || '')}<br/><span class="faint">${esc(r.program_name || '')} · Sec ${esc(r.section || '-')} · Batch ${esc(r.batch_year || '-')}</span></td>
        <td>${r.competitions_attempted}</td>
        <td class="faint">${r.avg_accuracy ?? '—'}%</td>
        <td class="score-cell">${r.total_score}</td>
      </tr>`).join('');
    $('#app').innerHTML = `
      <div class="page-enter">
        <div class="section-head" style="margin-top:6px">
          <div><h1>🌍 Overall Campus Ranking</h1>
          <p class="muted">Total points earned across all competitions. ${me ? `You are ranked <b style="color:var(--cyan)">${medal(me.rank)}</b> with <b style="color:var(--text)">${me.total_score}</b> points.` : ''}</p></div>
        </div>
        ${podiumHtml(leaderboard)}
        ${leaderboard.length ? `
          <div class="table-wrap" style="margin-top:18px"><table class="lb">
            <thead><tr><th>Rank</th><th>Student</th><th>Enrollment</th><th>School / Program</th><th>Competitions</th><th>Accuracy</th><th>Total Points</th></tr></thead>
            <tbody>${rows}</tbody></table></div>`
          : '<div class="card empty-state"><div class="es-ico">📭</div>Rankings appear once students start competing.</div>'}
      </div>`;
  }).catch((e) => toast(e.message, 'error'));
}

/* ============================================================
   PROFILE
   ============================================================ */
function viewProfile() {
  renderNav('#/profile');
  if (ME.role === 'admin') {
    $('#app').innerHTML = `
      <div class="page-enter" style="max-width:620px;margin:0 auto">
        <a class="link" href="#/admin">← Admin panel</a>
        <h1 style="margin-top:10px">🛠️ Administrator Profile</h1>
        <p class="muted" style="margin-bottom:20px">Manage your administrator account credentials.</p>
        <div class="card">
          <form id="admin-profile-form">
            <div class="field"><label>Admin Name <span class="req">*</span></label>
              <input class="input" name="name" value="${esc(ME.name || '')}" placeholder="Administrator" required /></div>
            <div class="field"><label>Email (User ID)</label>
              <input class="input" value="${esc(ME.email)}" disabled style="opacity:0.75;cursor:not-allowed" /></div>
            <hr class="divider"/>
            <h3>🔒 Change Admin Password</h3>
            <p class="muted" style="font-size:13px;margin:-4px 0 12px">Leave blank if you do not wish to change your password.</p>
            <div class="field"><label>New Password</label>
              <input class="input" type="password" name="password" minlength="6" placeholder="Minimum 6 characters" /></div>
            <button class="btn btn-primary" type="submit" style="margin-top:6px">Save Admin Profile</button>
          </form>
        </div>
      </div>`;
    $('#admin-profile-form').addEventListener('submit', async (e) => {
      e.preventDefault();
      const fd = Object.fromEntries(new FormData(e.target).entries());
      if (fd.password && fd.password.trim().length < 6) {
        toast('New password must be at least 6 characters.', 'error');
        return;
      }
      try {
        const { user } = await api('/api/profile', { method: 'PUT', body: fd });
        ME = user;
        try { localStorage.setItem('coding_arena_user', JSON.stringify(user)); } catch {}
        toast('Admin profile updated! ✅', 'success');
        location.hash = '#/admin';
      } catch (err) { toast(err.message, 'error'); }
    });
    return;
  }
  const f = (name, label, val, ph = '') => `
    <div class="field"><label>${label}</label>
    <input class="input" name="${name}" value="${esc(val || '')}" placeholder="${ph}" /></div>`;
  $('#app').innerHTML = `
    <div class="page-enter" style="max-width:760px;margin:0 auto">
      <h1>👤 My Profile</h1>
      <p class="muted" style="margin-bottom:20px">Your email <b style="color:var(--cyan)">${esc(ME.email)}</b> is your user ID and cannot be changed.</p>
      ${!ME.profile_complete ? `
        <div class="banner"><span class="banner-ico">⚠️</span>
        <div class="banner-body"><b>Complete all fields</b> — a full profile is required to participate in competitions.</div></div>` : ''}
      <div class="card">
        <form id="profile-form">
          ${f('name', 'Full Name <span class="req">*</span>', ME.name)}
          <div class="form-row">${f('enrollment_no', 'Enrollment No. <span class="req">*</span>', ME.enrollment_no, 'e.g. ENR2023001')}${f('admission_no', 'Admission No. <span class="req">*</span>', ME.admission_no, 'e.g. ADM1001')}</div>
          ${f('school_name', 'School / Faculty Name <span class="req">*</span>', ME.school_name, 'e.g. School of Computer Science')}
          <div class="form-row">${f('program_name', 'Program Name <span class="req">*</span>', ME.program_name, 'e.g. B.Tech CSE')}
          <div class="form-row">${f('section', 'Section <span class="req">*</span>', ME.section, 'A')}${f('batch_year', 'Batch Year <span class="req">*</span>', ME.batch_year, '2024')}</div></div>
          <hr class="divider"/>
          <h3>🔒 Change password <span class="faint">(leave blank to keep current)</span></h3>
          <div class="field"><label>New password</label><input class="input" type="password" name="password" minlength="6" placeholder="Minimum 6 characters" /></div>
          <button class="btn btn-primary" type="submit">Save Profile</button>
        </form>
      </div>
    </div>`;
  $('#profile-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const fd = Object.fromEntries(new FormData(e.target).entries());
    try {
      const { user } = await api('/api/profile', { method: 'PUT', body: fd });
      ME = user;
      try { localStorage.setItem('coding_arena_user', JSON.stringify(user)); } catch {}
      toast('Profile saved! ✅', 'success');
      location.hash = '#/dashboard';
    } catch (err) { toast(err.message, 'error'); }
  });
}

/* ============================================================
   ADMIN PANEL
   ============================================================ */
function viewAdmin() {
  renderNav('#/admin');
  if (!apiCache.has('/api/admin/overview') || !apiCache.has('/api/admin/competitions')) {
    $('#app').innerHTML = '<div class="spinner"></div>';
  }
  Promise.all([api('/api/admin/overview'), api('/api/admin/competitions')]).then(([ov, comps]) => {
    const rows = comps.competitions.map((c) => `
      <tr>
        <td><b>${esc(c.title)}</b><div class="faint">${esc(c.description || '').slice(0, 80)}</div></td>
        <td>${c.batch_year ? `<span class="badge badge-info">🎓 ${esc(c.batch_year)}</span>` : '<span class="badge">All Batches</span>'}</td>
        <td>${statusBadge(c.status)}</td>
        <td>${c.question_count} <span class="faint">(${c.total_points} pts)</span></td>
        <td>${c.registration_count}</td>
        <td>${c.participant_count}</td>
        <td style="white-space:nowrap">
          <button class="btn btn-ghost btn-sm" onclick="location.hash='#/admin/edit/${c.id}'">Edit</button>
          <button class="btn btn-ghost btn-sm" onclick="location.hash='#/leaderboard/${c.id}'">Rankings</button>
          <button class="btn btn-danger btn-sm" onclick="deleteComp(${c.id}, '${esc(c.title).replace(/'/g, "\\'")}')">Delete</button>
        </td>
      </tr>`).join('');
    $('#app').innerHTML = `
      <div class="page-enter">
        <div class="section-head" style="margin-top:6px">
          <div><h1>🛠️ Admin Panel</h1><p class="muted">Create coding competitions and monitor every ranking.</p></div>
          <div style="display:flex;gap:10px;flex-wrap:wrap">
            <button class="btn btn-ghost" onclick="downloadQuestionTemplate()">📥 Bulk Template</button>
            <button class="btn btn-ghost" onclick="openAdminPasswordModal()">🔑 Change Password</button>
            <button class="btn btn-primary" onclick="location.hash='#/admin/new'">＋ Create Competition</button>
          </div>
        </div>
        <div class="grid grid-4">
          <div class="card stat-card"><div class="stat-val">${ov.students}</div><div class="stat-label">Students</div></div>
          <div class="card stat-card"><div class="stat-val">${ov.competitions}</div><div class="stat-label">Competitions</div></div>
          <div class="card stat-card"><div class="stat-val">${ov.live}</div><div class="stat-label">Live Now</div></div>
          <div class="card stat-card"><div class="stat-val">${ov.attempts}</div><div class="stat-label">Submissions</div></div>
        </div>

        <div class="section-head"><h2>🎯 Competitions</h2>
          <button class="btn btn-ghost btn-sm" onclick="location.hash='#/admin/students'">👥 View all students →</button></div>
        ${comps.competitions.length ? `
          <div class="table-wrap"><table class="lb">
            <thead><tr><th>Title</th><th>Batch</th><th>Status</th><th>Questions</th><th>Registered</th><th>Submitted</th><th>Actions</th></tr></thead>
            <tbody>${rows}</tbody></table></div>`
          : '<div class="card empty-state"><div class="es-ico">📭</div>No competitions yet — create your first one!</div>'}

        <div class="section-head"><h2>🌍 Overall Ranking (all students)</h2>
          <button class="btn btn-ghost btn-sm" onclick="location.hash='#/overall'">Open full page →</button></div>
        <div id="admin-overall"></div>
      </div>`;
    return api('/api/rankings/overall');
  }).then(({ leaderboard }) => {
    const el = $('#admin-overall');
    if (!el) return;
    el.innerHTML = `<div class="table-wrap"><table class="lb">
      <thead><tr><th>Rank</th><th>Student</th><th>Enrollment</th><th>School / Program</th><th>Competitions</th><th>Total Points</th></tr></thead>
      <tbody>${leaderboard.map((r) => `
        <tr><td class="rank-num ${r.rank <= 3 ? 'rank-' + r.rank : ''}">${medal(r.rank)}</td>
        <td><div class="user-cell"><div class="mini-avatar">${esc(initials(r.name))}</div>
          <div><div class="uc-name">${esc(r.name)}</div><div class="uc-sub">${esc(r.email)}</div></div></div></td>
        <td class="faint">${esc(r.enrollment_no || '')}</td>
        <td class="faint">${esc(r.school_name || '')} · ${esc(r.program_name || '')}</td>
        <td>${r.competitions_attempted}</td>
        <td class="score-cell">${r.total_score}</td></tr>`).join('')}
      </tbody></table></div>`;
  }).catch((e) => {
    toast(e.message, 'error');
    if (e.code === 'FORBIDDEN') location.hash = '#/dashboard';
  });
}

async function deleteComp(id, title) {
  if (!confirm(`Delete "${title}"? This cannot be undone.`)) return;
  try {
    await api(`/api/admin/competitions/${id}`, { method: 'DELETE' });
    toast('Competition deleted.', 'success');
    viewAdmin();
  } catch (e) { toast(e.message, 'error'); }
}

function viewAdminStudents() {
  renderNav('#/admin');
  if (!apiCache.has('/api/admin/students')) {
    $('#app').innerHTML = '<div class="spinner"></div>';
  }
  api('/api/admin/students').then(({ students }) => {
    const rows = students.map((s) => `
      <tr>
        <td><div class="user-cell"><div class="mini-avatar">${esc(initials(s.name))}</div>
          <div><div class="uc-name">${esc(s.name)}</div><div class="uc-sub">${esc(s.email)}</div></div></div></td>
        <td class="faint">${esc(s.enrollment_no || '—')}<br/>${esc(s.admission_no || '')}</td>
        <td class="faint">${esc(s.school_name || '—')}</td>
        <td class="faint">${esc(s.program_name || '—')} · Sec ${esc(s.section || '-')} · Batch ${esc(s.batch_year || '-')}</td>
        <td><span class="badge ${s.profile_complete ? 'badge-live' : 'badge-upcoming'}">${s.profile_complete ? 'Complete' : 'Incomplete'}</span></td>
        <td>${s.stats.competitions_attempted}</td>
        <td class="score-cell">${s.stats.total_score}</td>
        <td class="rank-num">${s.stats.rank ? medal(s.stats.rank) : '—'}</td>
        <td style="white-space:nowrap">
          <button class="btn btn-ghost btn-sm" onclick="openStudentPasswordModal(${s.id}, '${esc(s.name || s.email).replace(/'/g, "\\'")}', '${esc(s.email).replace(/'/g, "\\'")}')">🔑 Change Password</button>
        </td>
      </tr>`).join('');
    $('#app').innerHTML = `
      <div class="page-enter">
        <a class="link" href="#/admin">← Admin panel</a>
        <h1 style="margin-top:10px">👥 All Students</h1>
        <p class="muted" style="margin-bottom:18px">${students.length} registered students with their overall performance.</p>
        <div class="table-wrap"><table class="lb">
          <thead><tr><th>Student</th><th>Enrollment / Admission</th><th>School</th><th>Program</th><th>Profile</th><th>Competitions</th><th>Points</th><th>Rank</th><th>Actions</th></tr></thead>
          <tbody>${rows}</tbody></table></div>
      </div>`;
  }).catch((e) => { toast(e.message, 'error'); location.hash = '#/admin'; });
}

/* ---------- password management modals ---------- */
function closeModal() {
  const m = $('#modal-root');
  if (m) m.innerHTML = '';
}

function openAdminPasswordModal() {
  const root = $('#modal-root');
  if (!root) return;
  root.innerHTML = `
    <div class="modal-backdrop" onclick="if(event.target===this) closeModal()">
      <div class="modal-card">
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:14px">
          <h2 style="margin:0;font-size:19px">🔑 Change Admin Password</h2>
          <button class="btn btn-ghost btn-sm" type="button" onclick="closeModal()" style="padding:4px 8px">✕</button>
        </div>
        <p class="muted" style="font-size:13.5px;margin:-4px 0 16px">Set a new password for the administrator account (<b>${esc(ME.email)}</b>).</p>
        <form id="admin-pwd-form">
          <div class="field">
            <label>New Password <span class="req">*</span></label>
            <input class="input" type="password" id="admin-new-pwd" minlength="6" placeholder="Minimum 6 characters" required autofocus />
          </div>
          <div class="field">
            <label>Confirm New Password <span class="req">*</span></label>
            <input class="input" type="password" id="admin-confirm-pwd" minlength="6" placeholder="Repeat new password" required />
          </div>
          <div style="display:flex;gap:10px;justify-content:flex-end;margin-top:20px">
            <button class="btn btn-ghost" type="button" onclick="closeModal()">Cancel</button>
            <button class="btn btn-primary" type="submit">Update Password</button>
          </div>
        </form>
      </div>
    </div>`;

  $('#admin-pwd-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const p1 = $('#admin-new-pwd').value;
    const p2 = $('#admin-confirm-pwd').value;
    if (p1 !== p2) {
      toast('Passwords do not match.', 'error');
      return;
    }
    try {
      await api('/api/admin/password', { method: 'PUT', body: { new_password: p1 } });
      toast('Admin password updated successfully! 🔑', 'success');
      closeModal();
    } catch (err) {
      toast(err.message, 'error');
    }
  });
}

function openStudentPasswordModal(studentId, studentName, studentEmail) {
  const root = $('#modal-root');
  if (!root) return;
  root.innerHTML = `
    <div class="modal-backdrop" onclick="if(event.target===this) closeModal()">
      <div class="modal-card">
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:14px">
          <h2 style="margin:0;font-size:19px">🔑 Change Student Password</h2>
          <button class="btn btn-ghost btn-sm" type="button" onclick="closeModal()" style="padding:4px 8px">✕</button>
        </div>
        <p class="muted" style="font-size:13.5px;margin:-4px 0 16px">
          Setting new password for: <b style="color:var(--cyan)">${esc(studentName)}</b><br/>
          <span class="faint">Email / User ID: ${esc(studentEmail)}</span>
        </p>
        <form id="student-pwd-form">
          <div class="field">
            <label>New Password <span class="req">*</span></label>
            <div style="display:flex;gap:8px">
              <input class="input" type="text" id="student-new-pwd" minlength="6" placeholder="Minimum 6 characters" required style="flex:1" autofocus />
              <button class="btn btn-ghost btn-sm" type="button" onclick="$('#student-new-pwd').value='Pass@' + Math.floor(1000 + Math.random()*9000); toast('Generated password!', 'info');">🎲 Generate</button>
            </div>
          </div>
          <div style="display:flex;gap:10px;justify-content:flex-end;margin-top:20px">
            <button class="btn btn-ghost" type="button" onclick="closeModal()">Cancel</button>
            <button class="btn btn-primary" type="submit">Save Password</button>
          </div>
        </form>
      </div>
    </div>`;

  $('#student-pwd-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const pwd = $('#student-new-pwd').value.trim();
    if (pwd.length < 6) {
      toast('Password must be at least 6 characters.', 'error');
      return;
    }
    try {
      await api(`/api/admin/students/${studentId}/password`, { method: 'PUT', body: { password: pwd } });
      toast(`Password updated for ${studentName}! ✅`, 'success');
      closeModal();
    } catch (err) {
      toast(err.message, 'error');
    }
  });
}

/* ---------- competition builder (create / edit) ---------- */
let qbQuestions = [];

function onLangChange(i, newLang) {
  syncQbFromDom();
  const q = qbQuestions[i];
  const oldLang = q.language || 'javascript';
  q.language = newLang;
  if (!q.starter_code || q.starter_code.trim() === '' || q.starter_code === DEFAULT_STARTER_CODE[oldLang]) {
    q.starter_code = DEFAULT_STARTER_CODE[newLang];
  }
  renderQList();
}

function viewAdminNewComp() {
  renderNav('#/admin');
  qbQuestions = [
    { type: 'mcq', prompt: '', options: ['', ''], answer_index: 0, answer: '', starter_code: '', points: 10, language: 'javascript' },
  ];
  renderCompForm({ title: '', description: '', batch_year: '', starts_at: toLocalInput(new Date(Date.now() + 3600e3)), ends_at: toLocalInput(new Date(Date.now() + 4 * 3600e3)), duration_minutes: 30 }, false);
}

function viewAdminEditComp(id) {
  renderNav('#/admin');
  $('#app').innerHTML = '<div class="spinner"></div>';
  api(`/api/admin/competitions/${id}`).then(({ competition, questions }) => {
    qbQuestions = questions.map((q) => ({
      type: q.type, prompt: q.prompt,
      options: q.options || ['', ''],
      answer_index: q.options ? Math.max(0, q.options.indexOf(q.answer)) : 0,
      answer: q.answer,
      test_cases: q.test_cases && q.test_cases.length ? q.test_cases : (q.type === 'output' ? [{ input: '', output: q.answer || '', hidden: false }] : undefined),
      starter_code: q.starter_code || '', points: q.points,
      language: q.language || 'javascript',
    }));
    if (!qbQuestions.length) qbQuestions.push({ type: 'mcq', prompt: '', options: ['', ''], answer_index: 0, answer: '', starter_code: '', points: 10, language: 'javascript' });
    renderCompForm({
      title: competition.title, description: competition.description,
      batch_year: competition.batch_year || '',
      starts_at: toLocalInput(competition.starts_at), ends_at: toLocalInput(competition.ends_at),
      duration_minutes: competition.duration_minutes,
    }, true, competition);
  }).catch((e) => { toast(e.message, 'error'); location.hash = '#/admin'; });
}

function renderCompForm(c, isEdit, comp = null) {
  const locked = isEdit && comp && comp.participant_count > 0;
  $('#app').innerHTML = `
    <div class="page-enter" style="max-width:900px;margin:0 auto">
      <a class="link" href="#/admin">← Admin panel</a>
      <h1 style="margin-top:10px">${isEdit ? '✏️ Edit Competition' : '🎉 Create Competition'}</h1>
      <p class="muted" style="margin-bottom:20px">Set the schedule, then add <b>Objective (MCQ)</b> and <b>Practical (output-based)</b> questions.</p>

      <div class="card" style="margin-bottom:18px">
        <h3>📅 Event Details</h3>
        <div class="field"><label>Title <span class="req">*</span></label>
          <input class="input" id="c-title" value="${esc(c.title)}" placeholder="e.g. CodeSprint: Python Basics" /></div>
        <div class="field"><label>Description</label>
          <textarea class="input" id="c-desc" placeholder="What is this competition about?">${esc(c.description)}</textarea></div>
        <div class="field"><label>Target Batch Year <span class="faint">(e.g. 2024 or leave blank for all batches)</span></label>
          <input class="input" id="c-batch" value="${esc(c.batch_year || '')}" placeholder="e.g. 2024 (leave blank for all students)" /></div>
        <div class="form-row">
          <div class="field"><label>Starts at (your local time) <span class="req">*</span></label>
            <input class="input" type="datetime-local" id="c-start" value="${esc(c.starts_at)}" /></div>
          <div class="field"><label>Ends at (your local time) <span class="req">*</span></label>
            <input class="input" type="datetime-local" id="c-end" value="${esc(c.ends_at)}" /></div>
        </div>
        <div class="form-row">
          <div class="field"><label>Duration (minutes) <span class="req">*</span></label>
            <input class="input" type="number" id="c-dur" min="1" max="480" value="${c.duration_minutes}" /></div>
        </div>
      </div>

      <div class="card" style="margin-bottom:18px">
        <div style="display:flex;justify-content:space-between;align-items:center;gap:10px;flex-wrap:wrap">
          <h3 style="margin:0">❓ Questions</h3>
          ${locked ? '' : `
            <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap">
              <button type="button" class="btn btn-ghost btn-sm" onclick="downloadQuestionTemplate()">📥 Download Template</button>
              <label class="btn btn-ghost btn-sm" style="margin:0;cursor:pointer;display:inline-flex;align-items:center;gap:5px">
                📤 Bulk Upload <input type="file" id="bulk-upload-input" accept=".csv,.json" style="display:none" onchange="handleBulkQuestionUpload(event)" />
              </label>
              <button type="button" class="btn btn-ghost btn-sm" onclick="addQuestion('mcq')">＋ Objective (MCQ)</button>
              <button type="button" class="btn btn-ghost btn-sm" onclick="addQuestion('output')">＋ Practical (output)</button>
            </div>`}
        </div>
        ${locked ? '<p class="faint" style="margin-top:10px">Students have already attempted this competition — questions are locked, but you can still edit the schedule.</p>' : ''}
        <div id="q-list" style="margin-top:14px"></div>
      </div>

      <button class="btn btn-primary btn-lg" style="padding:14px 28px;font-size:16px" onclick="saveComp(${isEdit ? comp.id : 'null'})">
        ${isEdit ? '💾 Save Changes' : '🚀 Publish Competition'}
      </button>
    </div>`;
  renderQList(!locked);
}

function syncQbFromDom() {
  $$('.q-builder-item').forEach((el, i) => {
    const q = qbQuestions[i];
    if (!q) return;
    q.prompt = $('.q-prompt-input', el)?.value ?? q.prompt;
    q.points = parseInt($('.q-points', el)?.value, 10) || 10;
    if (q.type === 'mcq') {
      q.options = $$('.opt-input', el).map((o) => o.value);
      const checked = $('.opt-radio:checked', el);
      q.answer_index = checked ? parseInt(checked.value, 10) : 0;
    } else {
      q.language = $('.q-lang-select', el)?.value ?? q.language ?? 'javascript';
      q.starter_code = $('.q-starter-input', el)?.value ?? q.starter_code;
      const tcCards = $$('.tc-builder-card', el);
      if (tcCards.length > 0) {
        q.test_cases = tcCards.map((cEl) => {
          const inp = $('.q-tc-input', cEl)?.value ?? '';
          const out = $('.q-tc-output', cEl)?.value ?? '';
          const hid = $('.q-tc-hidden', cEl)?.checked ?? false;
          return { input: inp, output: out, hidden: hid };
        });
        q.answer = q.test_cases[0] ? q.test_cases[0].output : (q.answer || '');
      } else {
        const singleOut = $('.q-answer-input', el)?.value;
        if (singleOut !== undefined) {
          q.answer = singleOut;
          q.test_cases = [{ input: '', output: singleOut, hidden: false }];
        }
      }
    }
  });
}

function renderQList(editable = true) {
  const list = $('#q-list');
  if (!list) return;
  list.innerHTML = qbQuestions.map((q, i) => {
    const qLang = q.language || 'javascript';
    if (q.type === 'output' && (!q.test_cases || !q.test_cases.length)) {
      q.test_cases = [{ input: '', output: q.answer || '', hidden: false }];
    }
    const typeUi = q.type === 'mcq'
      ? `
        <div id="opts-${i}">
          ${q.options.map((o, oi) => `
            <div class="opt-row">
              <input type="radio" class="opt-radio" name="correct-${i}" value="${oi}" ${q.answer_index === oi ? 'checked' : ''} ${editable ? '' : 'disabled'} />
              <input class="input opt-input" value="${esc(o)}" placeholder="Option ${String.fromCharCode(65 + oi)}" ${editable ? '' : 'disabled'} />
              ${editable && q.options.length > 2 ? `<button class="btn btn-danger btn-sm" onclick="removeOption(${i},${oi})">✕</button>` : ''}
            </div>`).join('')}
          ${editable ? `<button class="btn btn-ghost btn-sm" onclick="addOption(${i})">＋ Add option</button>
          <p class="faint" style="margin:6px 0 0">Select the radio button next to the correct answer.</p>` : ''}
        </div>`
      : `
        <div class="form-row">
          <div class="field" style="flex:1">
            <label>Programming language</label>
            <select class="input q-lang-select" onchange="onLangChange(${i}, this.value)" ${editable ? '' : 'disabled'}>
              ${SUPPORTED_LANGUAGES.map((l) => `<option value="${l.id}" ${qLang === l.id ? 'selected' : ''}>${l.icon} ${l.label}</option>`).join('')}
            </select>
          </div>
        </div>
        <div class="field"><label>Starter code shown to students</label>
          <textarea class="code-editor q-starter-input" style="min-height:95px" placeholder="// code template" ${editable ? '' : 'disabled'}>${esc(q.starter_code || '')}</textarea></div>
        <div style="margin-top:14px">
          <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px;gap:8px;flex-wrap:wrap">
            <label style="font-weight:700;font-size:13.5px">🧪 Test Cases (${(q.test_cases || []).length}) <span class="req">*</span></label>
            ${editable ? `<button type="button" class="btn btn-ghost btn-sm" onclick="addTestCase(${i})">＋ Add Test Case</button>` : ''}
          </div>
          <p class="faint" style="margin-top:-4px;margin-bottom:12px">Student code is executed and verified against each test case. Mark cases as "Hidden" so students don't see secret inputs/outputs during the competition.</p>
          <div id="tc-list-${i}">
            ${(q.test_cases || [{ input: '', output: q.answer || '', hidden: false }]).map((tc, ti) => `
              <div class="tc-builder-card">
                <div class="tc-builder-head">
                  <span style="font-weight:600;font-size:13px">
                    Test Case #${ti + 1}
                    ${tc.hidden ? '<span class="badge" style="margin-left:6px">🔒 Hidden</span>' : '<span class="badge badge-info" style="margin-left:6px">Sample</span>'}
                  </span>
                  <div style="display:flex;align-items:center;gap:12px">
                    <label style="font-size:12.5px;display:flex;align-items:center;gap:5px;cursor:pointer">
                      <input type="checkbox" class="q-tc-hidden" ${tc.hidden ? 'checked' : ''} onchange="syncQbFromDom(); qbQuestions[${i}].test_cases[${ti}].hidden = this.checked; renderQList();" ${editable ? '' : 'disabled'} />
                      Hidden from students
                    </label>
                    ${editable && (q.test_cases || []).length > 1 ? `<button type="button" class="btn btn-danger btn-sm" onclick="removeTestCase(${i}, ${ti})">✕ Remove</button>` : ''}
                  </div>
                </div>
                <div class="form-row">
                  <div class="field" style="flex:1">
                    <label style="font-size:12px">Input (stdin) <span class="faint">(optional / empty if none)</span></label>
                    <textarea class="input mono q-tc-input" style="min-height:55px" placeholder="Standard input (e.g. 5 3)" ${editable ? '' : 'disabled'}>${esc(tc.input || '')}</textarea>
                  </div>
                  <div class="field" style="flex:1">
                    <label style="font-size:12px">Expected Output (stdout) <span class="req">*</span></label>
                    <textarea class="input mono q-tc-output" style="min-height:55px" placeholder="Expected output (e.g. 8)" ${editable ? '' : 'disabled'}>${esc(tc.output || '')}</textarea>
                  </div>
                </div>
              </div>`).join('')}
          </div>
        </div>`;
    return `
      <div class="q-builder-item">
        <div class="qb-head">
          <b class="grad-text">Q${i + 1}</b>
          <div class="type-toggle">
            <button class="${q.type === 'mcq' ? 'on' : ''}" onclick="setType(${i},'mcq')" ${editable ? '' : 'disabled'}>🎯 Objective</button>
            <button class="${q.type === 'output' ? 'on' : ''}" onclick="setType(${i},'output')" ${editable ? '' : 'disabled'}>💻 Practical</button>
          </div>
          <div style="margin-left:auto;display:flex;gap:9px;align-items:center">
            <span class="faint">Points</span>
            <input class="input q-points" type="number" min="1" max="100" value="${q.points}" style="width:78px" ${editable ? '' : 'disabled'} />
            ${editable && qbQuestions.length > 1 ? `<button class="btn btn-danger btn-sm" onclick="removeQuestion(${i})">✕ Remove</button>` : ''}
          </div>
        </div>
        <div class="field"><label>Question prompt <span class="req">*</span></label>
          <textarea class="input q-prompt-input" style="min-height:64px" placeholder="Write the question…" ${editable ? '' : 'disabled'}>${esc(q.prompt)}</textarea></div>
        ${typeUi}
      </div>`;
  }).join('');
}

function addQuestion(type) {
  syncQbFromDom();
  qbQuestions.push({
    type,
    prompt: '',
    options: type === 'mcq' ? ['', ''] : undefined,
    answer_index: 0,
    answer: '',
    test_cases: type === 'output' ? [{ input: '', output: '', hidden: false }] : undefined,
    starter_code: type === 'output' ? DEFAULT_STARTER_CODE.javascript : '',
    points: 10,
    language: 'javascript',
  });
  renderQList();
}
function removeQuestion(i) { syncQbFromDom(); qbQuestions.splice(i, 1); renderQList(); }
function setType(i, type) {
  syncQbFromDom();
  const q = qbQuestions[i];
  if (q.type === type) return;
  q.type = type;
  if (type === 'mcq' && !q.options) { q.options = ['', '']; q.answer_index = 0; }
  if (type === 'output') {
    q.language = q.language || 'javascript';
    if (!q.starter_code) q.starter_code = DEFAULT_STARTER_CODE[q.language];
    if (!q.test_cases || !q.test_cases.length) {
      q.test_cases = [{ input: '', output: q.answer || '', hidden: false }];
    }
  }
  renderQList();
}
function addTestCase(qi) {
  syncQbFromDom();
  const q = qbQuestions[qi];
  if (!q) return;
  if (!q.test_cases) q.test_cases = [];
  q.test_cases.push({ input: '', output: '', hidden: q.test_cases.length >= 1 });
  renderQList();
}
function removeTestCase(qi, ti) {
  syncQbFromDom();
  const q = qbQuestions[qi];
  if (!q || !q.test_cases) return;
  q.test_cases.splice(ti, 1);
  renderQList();
}
function addOption(i) { syncQbFromDom(); qbQuestions[i].options.push(''); renderQList(); }
function removeOption(i, oi) { syncQbFromDom(); qbQuestions[i].options.splice(oi, 1); qbQuestions[i].answer_index = 0; renderQList(); }

function downloadQuestionTemplate() {
  const csvRows = [
    'type,prompt,points,option_a,option_b,option_c,option_d,correct_answer,language,starter_code,test_case_1_input,test_case_1_output,test_case_2_input,test_case_2_output,test_case_2_hidden',
    'mcq,"What is the output of typeof null in JavaScript?",10,"""object""","""null""","""undefined""","""boolean""","A",,,,',
    'mcq,"Which data structure operates on a Last In, First Out (LIFO) basis?",10,"Queue","Stack","Array","Linked List","B",,,,',
    'practical,"Write a Python program that reads two space-separated numbers from input and prints their sum.",20,,,,,"","python","# Read two numbers and print sum\na, b = map(int, input().split())\nprint(a + b)","5 3","8","10 20","30","TRUE"',
    'practical,"Write a program that prints the square of an integer read from stdin.",15,,,,,"","python","n = int(input())\nprint(n * n)","4","16","9","81","FALSE"'
  ];
  const csvContent = csvRows.join('\r\n');
  const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = 'cryptic_quiz_questions_template.csv';
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
  toast('Template downloaded! Fill questions in Excel/Sheets, save as CSV, and upload.', 'info');
}

function parseCSV(text) {
  const rows = [];
  let row = [];
  let inQuotes = false;
  let cur = '';
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    const next = text[i + 1];
    if (inQuotes) {
      if (c === '"') {
        if (next === '"') {
          cur += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        cur += c;
      }
    } else {
      if (c === '"') {
        inQuotes = true;
      } else if (c === ',') {
        row.push(cur.trim());
        cur = '';
      } else if (c === '\r') {
        // ignore CR
      } else if (c === '\n') {
        row.push(cur.trim());
        if (row.some((cell) => cell.length > 0)) rows.push(row);
        row = [];
        cur = '';
      } else {
        cur += c;
      }
    }
  }
  if (cur.length > 0 || row.length > 0) {
    row.push(cur.trim());
    if (row.some((cell) => cell.length > 0)) rows.push(row);
  }
  return rows;
}

async function handleBulkQuestionUpload(e) {
  const file = e.target.files && e.target.files[0];
  if (!file) return;

  const fileName = file.name.toLowerCase();
  const reader = new FileReader();

  reader.onload = (evt) => {
    try {
      const content = evt.target.result;
      let parsedQuestions = [];

      if (fileName.endsWith('.json')) {
        const rawJson = JSON.parse(content);
        if (!Array.isArray(rawJson)) throw new Error('JSON file must contain an array of question objects.');
        parsedQuestions = rawJson.map((q, idx) => {
          const rawType = (q.type || '').toLowerCase();
          const isPractical = rawType.includes('pract') || rawType.includes('code') || rawType === 'output';
          const prompt = String(q.prompt || `Question ${idx + 1}`).trim();
          const points = parseInt(q.points, 10) || 10;
          if (!isPractical) {
            const options = Array.isArray(q.options) && q.options.length ? q.options.map(String) : ['Option A', 'Option B'];
            let answer = String(q.answer || options[0]);
            let answerIndex = options.indexOf(answer);
            if (answerIndex === -1) {
              const letterIdx = ['a', 'b', 'c', 'd', 'e', 'f'].indexOf(answer.toLowerCase().trim());
              answerIndex = letterIdx >= 0 && letterIdx < options.length ? letterIdx : 0;
              answer = options[answerIndex];
            }
            return { type: 'mcq', prompt, options, answer_index: answerIndex, answer, points };
          } else {
            let lang = String(q.language || 'python').toLowerCase().trim();
            if (lang === 'js') lang = 'javascript';
            if (lang === 'py') lang = 'python';
            if (lang === 'c++') lang = 'cpp';
            if (!SUPPORTED_LANGUAGES.some((l) => l.id === lang)) lang = 'python';

            const starter_code = q.starter_code || DEFAULT_STARTER_CODE[lang] || '';
            const tcs = Array.isArray(q.test_cases) && q.test_cases.length
              ? q.test_cases.map((t) => ({ input: String(t.input ?? ''), output: String(t.output ?? ''), hidden: Boolean(t.hidden) }))
              : [{ input: '', output: String(q.answer || '0'), hidden: false }];
            return {
              type: 'output',
              prompt,
              points,
              language: lang,
              starter_code,
              test_cases: tcs,
              answer: tcs[0] ? tcs[0].output : '0',
            };
          }
        });
      } else {
        // Parse CSV
        const rows = parseCSV(content);
        if (rows.length < 2) throw new Error('CSV file has no data rows.');
        const rawHeaders = rows[0];
        const headers = rawHeaders.map((h) => h.toLowerCase().trim().replace(/[\s_-]+/g, ''));
        const getCol = (r, name) => {
          const norm = name.toLowerCase().replace(/[\s_-]+/g, '');
          const idx = headers.indexOf(norm);
          return idx !== -1 ? r[idx] || '' : '';
        };

        for (let ri = 1; ri < rows.length; ri++) {
          const r = rows[ri];
          const rawType = (getCol(r, 'type') || '').toLowerCase();
          const prompt = getCol(r, 'prompt') || `Question ${ri}`;
          const points = parseInt(getCol(r, 'points'), 10) || 10;
          const isPractical = rawType.includes('pract') || rawType.includes('code') || rawType === 'output';

          if (!isPractical) {
            // MCQ Question
            let options = [];
            const genericOpts = getCol(r, 'options');
            if (genericOpts && genericOpts.includes('|')) {
              options = genericOpts.split('|').map((o) => o.trim()).filter(Boolean);
            } else {
              const optA = getCol(r, 'option_a') || getCol(r, 'option1');
              const optB = getCol(r, 'option_b') || getCol(r, 'option2');
              const optC = getCol(r, 'option_c') || getCol(r, 'option3');
              const optD = getCol(r, 'option_d') || getCol(r, 'option4');
              options = [optA, optB, optC, optD].filter((o) => o && o.length > 0);
            }
            if (options.length < 2) options = ['Option A', 'Option B'];

            const rawAns = getCol(r, 'correct_answer') || getCol(r, 'answer') || 'A';
            let answerIndex = 0;
            const letterIdx = ['a', 'b', 'c', 'd'].indexOf(rawAns.toLowerCase().trim());
            if (letterIdx >= 0 && letterIdx < options.length) {
              answerIndex = letterIdx;
            } else {
              const matchIdx = options.findIndex((o) => o.toLowerCase() === rawAns.toLowerCase());
              if (matchIdx !== -1) answerIndex = matchIdx;
            }
            parsedQuestions.push({
              type: 'mcq',
              prompt,
              points,
              options,
              answer_index: answerIndex,
              answer: options[answerIndex] || options[0],
            });
          } else {
            // Practical Question
            let lang = (getCol(r, 'language') || 'python').toLowerCase().trim();
            if (lang === 'js') lang = 'javascript';
            if (lang === 'py') lang = 'python';
            if (lang === 'c++') lang = 'cpp';
            if (!SUPPORTED_LANGUAGES.some((l) => l.id === lang)) lang = 'python';

            const starter_code = getCol(r, 'starter_code') || DEFAULT_STARTER_CODE[lang] || '';
            const test_cases = [];

            const tc1Out = getCol(r, 'test_case_1_output') || getCol(r, 'tc1output');
            const tc1In = getCol(r, 'test_case_1_input') || getCol(r, 'tc1input');
            const tc1Hid = getCol(r, 'test_case_1_hidden') || getCol(r, 'tc1hidden');
            if (tc1Out) {
              test_cases.push({
                input: tc1In,
                output: tc1Out,
                hidden: tc1Hid.toLowerCase() === 'true' || tc1Hid === '1',
              });
            }

            const tc2Out = getCol(r, 'test_case_2_output') || getCol(r, 'tc2output');
            const tc2In = getCol(r, 'test_case_2_input') || getCol(r, 'tc2input');
            const tc2Hid = getCol(r, 'test_case_2_hidden') || getCol(r, 'tc2hidden');
            if (tc2Out) {
              test_cases.push({
                input: tc2In,
                output: tc2Out,
                hidden: tc2Hid.toLowerCase() === 'true' || tc2Hid === '1',
              });
            }

            const tc3Out = getCol(r, 'test_case_3_output') || getCol(r, 'tc3output');
            const tc3In = getCol(r, 'test_case_3_input') || getCol(r, 'tc3input');
            const tc3Hid = getCol(r, 'test_case_3_hidden') || getCol(r, 'tc3hidden');
            if (tc3Out) {
              test_cases.push({
                input: tc3In,
                output: tc3Out,
                hidden: tc3Hid.toLowerCase() === 'true' || tc3Hid === '1',
              });
            }

            if (!test_cases.length) {
              const singleAns = getCol(r, 'correct_answer') || getCol(r, 'answer') || '0';
              test_cases.push({ input: '', output: singleAns, hidden: false });
            }

            parsedQuestions.push({
              type: 'output',
              prompt,
              points,
              language: lang,
              starter_code,
              test_cases,
              answer: test_cases[0].output,
            });
          }
        }
      }

      if (!parsedQuestions.length) throw new Error('No valid questions found in the uploaded file.');

      syncQbFromDom();

      // If existing questions have real prompts or multiple questions, ask replace or append
      const hasRealExisting = qbQuestions.length > 1 || (qbQuestions[0] && qbQuestions[0].prompt && qbQuestions[0].prompt.trim().length > 0);
      if (hasRealExisting) {
        if (confirm(`You have existing questions in the editor.\n\nClick OK to REPLACE them with the ${parsedQuestions.length} uploaded question(s).\nClick Cancel to APPEND to your existing questions.`)) {
          qbQuestions = parsedQuestions;
        } else {
          qbQuestions = qbQuestions.concat(parsedQuestions);
        }
      } else {
        qbQuestions = parsedQuestions;
      }

      renderQList();
      toast(`🎉 Successfully imported ${parsedQuestions.length} question(s)! Review them below.`, 'success');
    } catch (err) {
      toast(`Upload failed: ${err.message}`, 'error');
    } finally {
      e.target.value = ''; // Reset input so same file can be re-selected if edited
    }
  };

  reader.onerror = () => {
    toast('Failed to read the file.', 'error');
    e.target.value = '';
  };

  reader.readAsText(file);
}

async function saveComp(id) {
  syncQbFromDom();
  const startRaw = $('#c-start').value;
  const endRaw = $('#c-end').value;
  if (!startRaw) { toast('Please specify a start date & time.', 'error'); return; }
  if (!endRaw) { toast('Please specify an end date & time.', 'error'); return; }
  const startsAt = toIsoFromInput(startRaw);
  const endsAt = toIsoFromInput(endRaw);
  if (!startsAt || !endsAt) { toast('Invalid start or end date/time.', 'error'); return; }
  if (new Date(endsAt).getTime() <= new Date(startsAt).getTime()) {
    toast('End time must be after start time.', 'error');
    return;
  }

  const body = {
    title: $('#c-title').value,
    description: $('#c-desc').value,
    batch_year: $('#c-batch') ? $('#c-batch').value.trim() : null,
    starts_at: startsAt,
    ends_at: endsAt,
    duration_minutes: $('#c-dur').value,
    questions: qbQuestions,
  };
  try {
    if (id) {
      await api(`/api/admin/competitions/${id}`, { method: 'PUT', body });
      toast('Competition updated! ✅', 'success');
    } else {
      await api('/api/admin/competitions', { method: 'POST', body });
      toast('Competition published! 🎉', 'success');
    }
    location.hash = '#/admin';
  } catch (e) { toast(e.message, 'error'); }
}

/* ============================================================
   ROUTER
   ============================================================ */
const routes = [
  [/^#\/login$/, () => (ME ? (location.hash = ME.role === 'admin' ? '#/admin' : '#/dashboard') : viewLogin())],
  [/^#\/register$/, () => (ME ? (location.hash = ME.role === 'admin' ? '#/admin' : '#/dashboard') : viewRegister())],
  [/^#\/dashboard$/, () => viewDashboard()],
  [/^#\/competition\/(\d+)$/, (m) => viewCompetition(m[1])],
  [/^#\/quiz\/(\d+)$/, (m) => viewQuiz(m[1])],
  [/^#\/result\/(\d+)$/, (m) => viewResult(m[1])],
  [/^#\/result-comp\/(\d+)$/, (m) => viewResultByComp(m[1])],
  [/^#\/leaderboard$/, () => viewLeaderboardPicker()],
  [/^#\/leaderboard\/(\d+)$/, (m) => viewLeaderboard(m[1])],
  [/^#\/overall$/, () => viewOverall()],
  [/^#\/profile$/, () => viewProfile()],
  [/^#\/admin$/, () => viewAdmin()],
  [/^#\/admin\/new$/, () => viewAdminNewComp()],
  [/^#\/admin\/edit\/(\d+)$/, (m) => viewAdminEditComp(m[1])],
  [/^#\/admin\/students$/, () => viewAdminStudents()],
];

async function viewResultByComp(compId) {
  try {
    const { attempt } = await api(`/api/competitions/${compId}`);
    if (attempt && attempt.status === 'submitted') location.replace(`#/result/${attempt.id}`);
    else location.hash = `#/competition/${compId}`;
  } catch { location.hash = '#/dashboard'; }
}

function router() {
  if (quizTimer && !location.hash.startsWith('#/quiz/')) { clearInterval(quizTimer); quizTimer = null; }
  const hash = location.hash || '#/login';
  const path = ME ? (ME.role === 'admin' ? '#/admin' : '#/dashboard') : '#/login';

  for (const [re, fn] of routes) {
    const m = hash.match(re);
    if (m) {
      if (!ME && !/^#\/(login|register)$/.test(hash)) { location.hash = '#/login'; return; }
      if (ME && /^#\/admin/.test(hash) && ME.role !== 'admin') { toast('Admin access only.', 'error'); location.hash = '#/dashboard'; return; }
      fn(m);
      return;
    }
  }
  location.hash = path;
}

/* ============================================================
   BOOT
   ============================================================ */
// 1. Immediately restore cached user session if present
try {
  const saved = localStorage.getItem('coding_arena_user');
  if (saved) ME = JSON.parse(saved);
} catch { ME = null; }

// 2. Set initial hash and start router IMMEDIATELY (no blank screen!)
if (!location.hash || location.hash === '#/') {
  location.hash = ME ? (ME.role === 'admin' ? '#/admin' : '#/dashboard') : '#/login';
}
window.addEventListener('hashchange', router);
const cy = $('#copyright-year');
if (cy) cy.textContent = new Date().getFullYear();
router();

// 3. Verify / refresh session in background without blocking UI
(async function verifySession() {
  try {
    const { user } = await api('/api/auth/me', { bustCache: true });
    const hadUser = Boolean(ME);
    ME = user;
    try { localStorage.setItem('coding_arena_user', JSON.stringify(user)); } catch {}
    if (!hadUser && user) {
      if (!location.hash || location.hash === '#/login' || location.hash === '#/register') {
        location.hash = user.role === 'admin' ? '#/admin' : '#/dashboard';
      } else {
        router();
      }
    }
  } catch {
    if (ME) {
      ME = null;
      try { localStorage.removeItem('coding_arena_user'); } catch {}
      location.hash = '#/login';
    }
  }
})();
