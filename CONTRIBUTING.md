# Contributing to Ghostwork

Thanks for your interest in Ghostwork. This project aims to be the first agent you don't prompt — it watches how you work, learns recurring workflows, and earns the right to run them in your browser with your permission.

We're early. The engine works; the product loop is still being proven. **Good first issues are the fastest way to help.**

---

## Table of contents

- [Code of conduct](#code-of-conduct)
- [What we're building](#what-were-building)
- [Development setup](#development-setup)
- [Project layout](#project-layout)
- [Running the app](#running-the-app)
- [How to contribute](#how-to-contribute)
- [Coding guidelines](#coding-guidelines)
- [Architecture primer](#architecture-primer)
- [Good first issues](#good-first-issues)
- [License](#license)

---

## Code of conduct

Be respectful, constructive, and honest. Ghostwork handles screen activity — treat privacy and security issues with urgency. Do not commit API keys, `.env` files, or user data.

---

## What we're building

Ghostwork has two learning paths and one execution engine:

| Path | How it works |
|------|----------------|
| **Ambient learning** | Screenpipe observes your screen → hourly extractor finds workflows/rules → action engine nudges when context matches |
| **Teach Mode** | Record a demonstration in Chrome → events compile into a deterministic skill |
| **Execution** | Skill replay (zero tokens) → CDP plan-then-execute → deterministic steps → vision fallback |

The north-star moment: *"It noticed I do LinkedIn outreach every Tuesday and handled it while I got coffee."*

Pick up a task from [GitHub Issues labeled `good first issue`](https://github.com/hvardhan878/ghostwork/issues?q=is%3Aissue+is%3Aopen+label%3A%22good+first+issue%22).

---

## Development setup

### Requirements

- **macOS** (primary target — mouse/keyboard/AX automation is macOS-specific today)
- **Node.js** 18+
- **Google Chrome** (for CDP-based browser execution)
- **OpenRouter API key** ([openrouter.ai/keys](https://openrouter.ai/keys)) — required for learning and trigger decisions
- **Anthropic API key** (optional) — better quality for pixel-based fallback execution

Optional but recommended for full mouse support:

```bash
pip3 install pyobjc-framework-Quartz
# or
brew install cliclick
```

### Clone and install

```bash
git clone https://github.com/hvardhan878/ghostwork.git
cd ghostwork
npm install          # runs electron-rebuild for better-sqlite3
cp .env.example .env # add your keys
```

### macOS permissions

On first run, grant:

- **Screen Recording** — Screenpipe and screenshots
- **Accessibility** — mouse, keyboard, and AX tree automation

Ghostwork also launches Screenpipe automatically via `npx screenpipe record`.

### Ghostwork Chrome profile

Browser skills run in a **dedicated Chrome profile** (not your daily browser):

```
~/Library/Application Support/Ghostwork/ChromeProfile
```

Sign into sites (e.g. LinkedIn) once in this window. Teach Mode and skill replay use it.

---

## Project layout

```
src/
  main/                    Electron main process (Node)
    main.ts                App lifecycle, tray, IPC, cron jobs
    actionEngine.ts        10s context poll → LLM trigger → dispatch
    extractor.ts           Hourly Screenpipe → workflow/rule extraction
    skillEngine.ts         Skill compile + replay + self-heal
    browserDriver.ts       CDP attach, DOM snapshot, ranked locators
    teachMode.ts           Record-once skill compiler
    computerUse.ts         Execution router + pixel fallback
    stepRunner.ts          Deterministic steps (URL, keys, AX clicks)
    db.ts                  SQLite: workflows, rules, skills, approvals
    approvals.ts           Shadow mode approval queue
    ...
  renderer/
    index.html             Main UI (activity, behaviour, settings)
    hud.html               "Ghost is driving" overlay
    nudge.html             Suggestion popup
```

Compiled output goes to `dist/`. **Edit `src/`, not `dist/`.**

---

## Running the app

```bash
npm start          # build + launch Electron
npm run dev        # build + launch with Node inspector
npm run build      # TypeScript compile only
npm run rebuild-native   # if better-sqlite3 ABI mismatch after Electron upgrade
```

Logs appear in the terminal. Key prefixes:

| Prefix | Module |
|--------|--------|
| `[engine]` | Action engine (context, nudges) |
| `[extractor]` | Hourly pattern extraction |
| `[skill:*]` | Skill replay / compile |
| `[browser]` | CDP Chrome driver |
| `[teach]` | Teach Mode recorder |
| `[computer-use]` | Execution router |

Database location:

```
~/Library/Application Support/ghostwork/ghostwork.db
# or ~/Library/Application Support/Electron/ghostwork.db during dev
```

---

## How to contribute

### 1. Find an issue

Browse [GitHub Issues labeled `good first issue`](https://github.com/hvardhan878/ghostwork/issues?q=is%3Aissue+is%3Aopen+label%3A%22good+first+issue%22).

Comment **"I'd like to work on this"** before starting so we avoid duplicate work.

### 2. Fork and branch

```bash
git checkout -b fix/short-description
```

Use prefixes: `fix/`, `feat/`, `docs/`, `refactor/`.

### 3. Make your change

- Keep diffs focused — one issue per PR when possible
- Match existing TypeScript style (`strict`, no unnecessary abstractions)
- Run `npm run build` before opening a PR
- Manual test on macOS if you touch execution, IPC, or UI

### 4. Open a pull request

Fill out the PR description. Include:

- **What** changed and **why**
- **How you tested** (steps, screenshots for UI)
- Link to the issue: `Fixes #123`

### 5. Review

Maintainers may ask for changes. Once approved, we'll merge.

---

## Coding guidelines

### TypeScript

- Strict mode is on — no `any` unless unavoidable; prefer narrow types
- Main process code lives in `src/main/`; no React — vanilla HTML/JS in `renderer/`
- New IPC handlers: add to `main.ts`, expose via `preload.ts`, consume in `index.html`

### Database

- Schema changes go in `db.ts` `initDb()` with `CREATE TABLE IF NOT EXISTS`
- Migrations are manual today — document breaking changes in the PR
- Never log or commit user activity data

### Execution / browser

- Prefer **ranked locators** over coordinates or vision
- Mark externally visible steps (`send`, `post`, `connect`) with `external: true`
- Shadow mode must gate outbound actions unless `externalAllowed` is explicitly set

### UI

- Match existing CSS variables in `index.html` (`--surface`, `--border`, `--text-muted`, etc.)
- Keep the menu-bar-first UX — don't add dashboard complexity without discussion

### Commits

Clear, imperative subject lines:

```
fix(browser): ensure at least one tab before CDP connect
feat(ui): show morning digest card on app open
docs: update README for v2 skill engine
```

---

## Architecture primer

```
┌─────────────────────────────────────────────────────────────┐
│  OBSERVE                                                     │
│  Screenpipe → extractor (hourly) → workflows + rules (SQLite) │
└──────────────────────────┬──────────────────────────────────┘
                           │
┌──────────────────────────▼──────────────────────────────────┐
│  MATCH                                                       │
│  actionEngine (10s) → context + LLM → nudge / dispatch       │
└──────────────────────────┬──────────────────────────────────┘
                           │
┌──────────────────────────▼──────────────────────────────────┐
│  EXECUTE (computerUse router)                                │
│  1. skill replay (compiled/taught)                           │
│  2. CDP plan-then-execute (browserDriver + skillEngine)      │
│  3. deterministic steps (stepRunner)                         │
│  4. vision fallback (Anthropic / OpenRouter)                  │
└─────────────────────────────────────────────────────────────┘
```

**Known gap:** observation watches your main screen; execution runs in Ghostwork Chrome. A Chrome extension to unify these is on the roadmap — see good first issues.

---

## Good first issues

Find open starter tasks on GitHub: [issues labeled `good first issue`](https://github.com/hvardhan878/ghostwork/issues?q=is%3Aissue+is%3Aopen+label%3A%22good+first+issue%22).

Comment on an issue before you start work.

---

## License

By contributing, you agree that your contributions will be licensed under the [GNU General Public License v3.0 or later](LICENSE).

Ghostwork is GPL — derivative works must remain open source under the same license.

---

## Questions?

Open a [GitHub Discussion](https://github.com/hvardhan878/ghostwork/discussions) or comment on an issue. For security concerns, please do not open public issues with exploit details — contact the maintainer directly.
