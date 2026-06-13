# Ghostwork

[![Discord](https://img.shields.io/badge/Discord-Join%20the%20community-5865F2?style=for-the-badge&logo=discord&logoColor=white)](https://discord.gg/HxhDfs4H39)
[![License: GPL v3](https://img.shields.io/badge/License-GPLv3-blue?style=for-the-badge&logo=gnu&logoColor=white)](LICENSE)

> **The first agent you don't prompt.**

Ghostwork runs silently in the background, learns how you work from observation alone, and gradually takes repetitive tasks off your hands — without you ever writing a prompt or setting up an integration.

---

## What it does

Ghostwork watches every interaction across every app on your Mac (via [Screenpipe](https://github.com/mediar-ai/screenpipe)), builds a rich memory of your work patterns, and surfaces automations the moment they're relevant.

### Memory layers

| Layer | What's stored | How it's built |
|-------|--------------|----------------|
| **L1 Working** | Current screen context (app, URL, OCR) | Live, polled every 10 s |
| **L2 Episodic** | Raw interactions: clicks, keys, navigations, app switches | Ingested every 2 min from Screenpipe's input stream |
| **L3 Semantic** | Workflows and rules: *"WHEN on LinkedIn search → DO export to CRM"* | Promoted nightly from episodic memory via LLM |
| **L4 Procedural** | Executable skills with step-by-step DOM/AX locators | Promoted nightly from stable semantic rules |

### Nightly consolidation (sleep cycle)

Every night Ghostwork runs a 3-phase consolidation:

1. **NREM** — LLM analyses unsummarised sessions and promotes patterns to rules  
2. **REM** — Rules with 3+ observations that have browser-recorded events are compiled into executable skills  
3. **GC** — Power-law confidence decay, dedup, 90-day prune of raw events, `behaviour.md` rewrite

The living `behaviour.md` profile is injected into every LLM prompt, so the trigger decision has full context about who you are and what you do.

---

## Autonomy tiers

Ghostwork earns autonomy, never assumes it:

| Tier | Triggered when | Behaviour |
|------|---------------|-----------|
| **Supervised** | Default for all new rules | Executes immediately, shows HUD notification, Cmd+Z available |
| **Autonomous** | ≥5 accepts and <2 rejections in last 10 | Runs silently; logged to Activity feed |

Actions that are externally visible (send email, submit form, post) always require one-tap approval regardless of tier.

---

## Execution stack

1. **Compiled skill replay** — zero-token deterministic replay of recorded step sequences
2. **AX-first native control** — `ax_list_elements` + `ax_click_element` via macOS Accessibility API; ~95% accuracy on native apps
3. **Claude vision fallback** — pixel-level screenshots + function calling for browsers and AX-empty apps

When a multi-step sequence fails mid-way, Ghostwork fires Cmd+Z for each completed reversible step in reverse order before surfacing the error.

---

## UI

- **Menu bar icon** — reflects current state: observing / working  
- **Activity feed** — chronological log of every action taken and approval waiting  
- **Timeline tab** — drill down into every recorded session; save any session as a skill  
- **Behaviour tab** — learned rules with autonomy progress, category badges, and one-click boost  
- **Approvals** — staged actions waiting for your confirmation before executing externally visible steps

---

## Setup

### Prerequisites

- macOS 12+
- [Screenpipe](https://github.com/mediar-ai/screenpipe) installed and running (`screenpipe`)
- Node.js 20+ and npm
- An [OpenRouter](https://openrouter.ai) API key (or Anthropic key)

### Install

```bash
git clone https://github.com/your-org/ghostwork
cd ghostwork
npm install
npx @electron/rebuild -f -w better-sqlite3
```

### Configure

```bash
cp .env.example .env
```

Edit `.env`:

```env
OPENROUTER_API_KEY=sk-or-...
ANTHROPIC_API_KEY=sk-ant-...   # optional, used for native computer use
```

### Run

```bash
npm start          # development (hot reload)
npm run build      # production build
npm run dist       # package as .dmg
```

---

## Architecture

```
Screenpipe ──► sessionIngester (2min) ──► raw_events ──► extractor (30min) ──► rules
                                                                                   │
                                                                          NREM/REM nightly
                                                                                   │
                                                                              compiled skills
                                                                                   │
                              actionEngine (10s) ──► LLM trigger ──► AX-first executor
                                                                    └──► vision fallback
```

Key files:

| File | Responsibility |
|------|----------------|
| `sessionIngester.ts` | 2 min poll → raw_events + per-event prediction scoring |
| `extractor.ts` | 30 min batch → 7-category structured rule extraction |
| `consolidation.ts` | Nightly NREM (sessions→rules) + REM (rules→skills) + GC |
| `actionEngine.ts` | 10 s perception loop + LLM trigger decision + dispatch |
| `computerUse.ts` | AX-first executor + Claude vision fallback |
| `axDriver.ts` | macOS accessibility tree (AXUIElement via AppleScript) |
| `skillEngine.ts` | Browser skill replay with multi-step rollback |
| `approvals.ts` | Shadow-mode approval queue for externally visible actions |
| `db.ts` | GhostWork SQLite: rules, episodes, skills, approvals, settings |

---

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for setup instructions and coding guidelines.

Open issues on GitHub — look for `good first issue` labels. Join the [Discord](https://discord.gg/HxhDfs4H39) to discuss ideas or get help getting set up.

---

## Privacy

- All data stays on your device. No cloud sync, no telemetry.
- Ghostwork excludes itself, Cursor, and any app you add to the exclusion list.
- Raw events are pruned after 90 days.
- PII (emails, phone numbers, card numbers) is stripped before any LLM call.
- The `behaviour.md` profile never leaves your machine.

---

## Roadmap

- [ ] Full autopilot mode: skill execution without any prompt
- [ ] Cross-session pattern detection in REM phase
- [ ] Browser extension for richer DOM locators in user's main Chrome profile
- [ ] Windows support (via Screenpipe Windows builds)
- [ ] Team profiles (opt-in, anonymised)

---

## Licence

GPL-3.0 — see [LICENSE](LICENSE) for details.
