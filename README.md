# ⚔️ Coding Arena

A programming quiz web app for **live coding competitions** with rankings for students and a
full admin panel. Built with **Node + Express + SQLite** (no native build tools needed — uses
the built-in `node:sqlite`).

## 🚀 Run it

```bash
npm install
npm start
# open http://localhost:3000
```

The database is created and seeded automatically on first run (`data/quiz.db`).

## 🔑 Demo accounts

| Role    | Email                       | Password   |
| ------- | --------------------------- | ---------- |
| Student | `aarav@student.campus.edu`  | `demo1234` |
| Student | `priya@student.campus.edu`  | `demo1234` |
| Student | `sneha@student.campus.edu`  | `demo1234` |
| Admin   | `admin@codingarena.dev`     | `admin123` |

## ✨ Features

**For students**
- Register with **email as the user ID** + set a password
- Complete an academic profile (name, enrollment no., admission no., school, program,
  section, batch year) — **required before participating**
- Browse live / upcoming / ended competitions, register, and take timed quizzes
- Two question types: **Objective (MCQ)** and **Practical (output-based)** — write real
  JavaScript that runs on the server with instant verdicts
- Score ring, answer review, and confetti on strong results
- Per-competition leaderboard (ties broken by speed) **and** an overall campus ranking

**For admins**
- Log in and create competitions with a schedule + a mix of MCQ and practical questions
- View every competition's ranking plus the overall ranking of all students
- Manage (edit / delete) competitions and see a roster of all students

## 🧱 Stack

- **Backend:** Express, sessions via httpOnly cookies, scrypt-hashed passwords
- **Database:** SQLite through Node's built-in `node:sqlite` module
- **Code execution:** student code runs in a sandboxed child process (2.5s timeout)
- **Frontend:** dependency-free vanilla JS SPA (hash router) with a neon dark theme

## 📁 Structure

- `server.js` — Express API + static hosting
- `db.js` — schema + seed data
- `public/` — `index.html`, `styles.css`, `app.js`
