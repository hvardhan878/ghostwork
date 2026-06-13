# Contributing to Ghostwork

Thanks for your interest in Ghostwork — the first agent you don't prompt. It watches how you work, learns recurring workflows, and earns the right to run them autonomously.

We're early. The core loop is working. **Good first issues are the fastest way to help.**

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

Ghostwork has a single continuous loop:

| Phase | What happens |
|-------|-------------|
| **Observe** | Screenpipe captures every UI event and OCR frame on your Mac |
| **Learn** | Every 2 min: events → sessions. Every 30 min: sessions → rules (via LLM). Nightly: rules → compiled skills |
| **Act** | Every 10 s: current context → LLM checks if any rule applies → executes at earned tier |

**Autonomy tiers** — earned, never assumed:
- **Supervised** (default) — executes and shows a HUD notification; Cmd+Z undoes it
- **Autonomous** — runs silently after ≥5 accepted executions with fewer than 2 recent rejections

The north-star moment: *"It noticed I do LinkedIn outreach every Tuesday and handled it while I got coffee."*

---

## Development setup

### Requirements

- **macOS 12+** (AX automation is macOS-specific today)
- **Node.js 20+**
- **[Screenpipe](https://github.com/mediar-ai/screenpipe)** installed and running
- **OpenRouter API key** ([openrouter.ai/keys](https://openrouter.ai/keys)) — required for rule extraction and trigger decisions
- **Anthropic API key** (optional) — used for the AX-first native computer use executor

### Clone and install

```bash
git clone https://github.com/hvardhan878/ghostwork.git
cd ghostwork
npm install
npx @electron/rebuild -f -w better-sqlite3
cp .env.example .env   # add your keys
```

### macOS permissions

On first run, grant when prompted:

- **Screen Recording** — required by Screenpipe
- **Accessibility** — required for AX tree interaction and keyboard automation

---

## Project layout

```
src/
  main/                    Electron main process (Node.js)
    main.ts                App lifecycle, tray, IPC handlers, cron jobs
    actionEngine.ts        10 s context poll → LLM trigger decision → dispatch
    sessionIngester.ts     2 min poll → raw_events + per-event prediction scoring
    extractor.ts           30 min batch → 7-category structured rule extraction
    consolidation.ts       Nightly NREM (episodes→rules) + REM (rules→skills) + GC
    computerUse.ts         AX-first executor + Claude vision fallback
    axDriver.ts            macOS accessibility tree (AXUIElement via AppleScript)
    skillEngine.ts         Browser skill compile + deterministic replay + rollback
    approvals.ts           Shadow-mode approval queue (staged actions)
    context.ts             AppleScript + Screenpipe OCR → current UserContext
    screenpipeDb.ts        Direct SQLite queries to Screenpipe DB
    db.ts                  GhostWork SQLite: rules, episodes, skills, approvals
  renderer/
    index.html             Full UI — Activity, Timeline, Behaviour, Settings tabs
```

Compiled output goes to `dist/`. **Always edit `src/`, never `dist/`.**

---

## Running the app

```bash
npm start          # TypeScript build + launch Electron
npm run build      # TypeScript compile only (no launch)
npm run dist       # Package as .dmg
```

Logs appear in the terminal. Key prefixes:

| Prefix | Module |
|--------|--------|
| `[engine]` | Action engine — context polls, trigger decisions |
| `[ingester]` | Session ingester — raw event collection |
| `[extractor]` | Rule extraction from sessions |
| `[consolidation]` | Nightly NREM/REM/GC cycle |
| `[computer-use]` | AX-first executor + vision fallback |
| `[skill]` | Skill replay and rollback |
| `[approvals]` | Staged action approval queue |

Database location:

```
~/Library/Application Support/ghostwork/ghostwork.db
# or ~/Library/Application Support/Electron/ghostwork.db during dev
```

---

## How to contribute

### 1. Find an issue

Browse [issues labeled `good first issue`](https://github.com/hvardhan878/ghostwork/issues?q=is%3Aissue+is%3Aopen+label%3A%22good+first+issue%22) — these are scoped to single files with clear acceptance criteria.

Comment **"I'd like to work on this"** before starting so we avoid duplicate work.

### 2. Fork and branch

```bash
git checkout -b fix/short-description
```

Use prefixes: `fix/`, `feat/`, `docs/`, `refactor/`.

### 3. Make your change

- Keep diffs focused — one issue per PR
- Match existing TypeScript style (`strict` mode, no unnecessary abstractions)
- Run `npm run build` before opening a PR — it must compile clean
- If you touch execution, IPC, or UI: manual test on macOS

### 4. Open a pull request

Fill out the PR description with:

- **What** changed and **why**
- **How you tested** (steps to reproduce + verify)
- **Screenshots** for any UI changes
- Link to the issue: `Fixes #123`

### 5. Review

Maintainers aim to review within 48 hours. Once approved, we'll merge.

---

## Coding guidelines

### TypeScript

- Strict mode is on — no `any` unless truly unavoidable
- Main process code in `src/main/`; renderer is vanilla HTML/JS (no React, no build framework)
- New IPC handlers: add to `main.ts`, expose via `preload.ts`, consume in `index.html`

### Database

- Schema changes go in `db.ts` `initDb()` using `CREATE TABLE IF NOT EXISTS`
- Additive column migrations use the existing `safeAddColumn(db, table, col, type)` helper
- Never log or commit user activity data

### Execution

- Prefer AX tree interactions (`axDriver.ts`) over pixel clicks for native apps
- Mark externally visible steps (send email, post, submit form) with `external: true`
- Shadow mode must gate outbound actions unless `externalAllowed` is explicitly set

### UI

- Match existing CSS variables in `index.html` (`--surface`, `--border`, `--text-muted`, etc.)
- Keep the menu-bar-first UX — avoid adding dashboard complexity without discussion

### Commits

Clear, imperative subject lines:

```
fix(engine): skip rule check when frontmost app is excluded
feat(ui): add search filter to Behaviour tab rule cards
docs: update CONTRIBUTING for current architecture
```

---

## Architecture primer

```
┌──────────────────────────────────────────────────────────────┐
│  Screenpipe — frames · ui_events · audio · clipboard         │
└───────────────────────────┬──────────────────────────────────┘
                            │ every 2 min
┌───────────────────────────▼──────────────────────────────────┐
│  Session Ingester — groups events into sessions              │
│  Prediction pass: sliding 5-event window → prediction_error  │
└───────────────────────────┬──────────────────────────────────┘
                            │ every 30 min
┌───────────────────────────▼──────────────────────────────────┐
│  Extractor — 7-category structured rule extraction           │
│  High-delta events (prediction_error ≥ 0.7) prioritised      │
└───────────────────────────┬──────────────────────────────────┘
                            │ nightly
┌───────────────────────────▼──────────────────────────────────┐
│  Consolidation — NREM: stitch sessions → episodes            │
│                  REM:  rules → compiled skills               │
│                  GC:   demote poor skills, prune old events  │
└───────────────────────────┬──────────────────────────────────┘
                            │ every 10 s
┌───────────────────────────▼──────────────────────────────────┐
│  Action Engine — context → LLM trigger → supervised/auto     │
└───────────────────────────┬──────────────────────────────────┘
                            │
┌───────────────────────────▼──────────────────────────────────┐
│  AX-First Executor                                           │
│  ax_list_elements + ax_click_element for native apps         │
│  Claude vision fallback for browsers / AX-empty apps         │
└──────────────────────────────────────────────────────────────┘
```

See [architecture.md](architecture.md) for the full breakdown.

---

## Good first issues

These are scoped to a single file with clear acceptance criteria and no backend work required:

- [Show Screenpipe connection status in Settings tab](https://github.com/hvardhan878/ghostwork/issues/14)
- [Copy button on rule condition and action text](https://github.com/hvardhan878/ghostwork/issues/15)
- [Show last extraction time in Behaviour tab header](https://github.com/hvardhan878/ghostwork/issues/21)

Browse all: [issues labeled `good first issue`](https://github.com/hvardhan878/ghostwork/issues?q=is%3Aissue+is%3Aopen+label%3A%22good+first+issue%22)

Comment on an issue before you start work.

---

## License

By contributing, you agree that your contributions will be licensed under the [GNU General Public License v3.0](LICENSE).

Ghostwork is GPL — derivative works must remain open source under the same license.

---

## Questions?

Join the [Discord community](https://discord.gg/HxhDfs4H39) or comment on an issue. For security concerns, do not open public issues with exploit details — contact the maintainer directly.
