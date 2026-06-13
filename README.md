# Ghostwork

[![Discord](https://img.shields.io/badge/Discord-Join%20the%20community-5865F2?style=for-the-badge&logo=discord&logoColor=white)](https://discord.gg/HxhDfs4H39)

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

## Execution tiers

Ghostwork earns autonomy, never assumes it:

| Tier | Behaviour |
|------|-----------|
| **Suggest** | Nudge popup — you decide |
| **Supervised** | Executes but shows each step |
| **Autonomous** | Runs silently; you see a receipt |

Actions that are externally visible (send email, submit form, post) always require one-tap approval regardless of tier.

---

## Execution stack

1. **Compiled skill replay** — zero-token deterministic replay using ranked DOM/AX locators  
2. **CDP plan-then-execute** — Playwright CDP on a dedicated Chrome profile; LLM plans steps from live AX tree  
3. **Native AX control** — AppleScript + `AXUIElement` for non-browser apps  
4. **Pixel fallback** — Vision + function calling via OpenRouter when no structured tree is available

Self-healing: when a locator breaks, Ghostwork re-extracts from the live DOM and promotes the new locator automatically.

---

## UI

- **Menu bar icon** — reflects current state: observing / noticed / working / recording  
- **Activity feed** — chronological log of every suggestion and action  
- **Timeline tab** — drill down into every recorded session; save any session as a skill  
- **Behaviour tab** — learned workflows, high-confidence rules, and session-derived patterns  
- **Nudge popup** — appears above any app; shows evidence count and step preview before you confirm

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
Screenpipe ──► sessionIngester ──► raw_events ──► NREM ──► rules ──► REM ──► skills
                                                    ↓                  ↓
                                              behaviour.md      skill replay
                                                    ↓
                              actionEngine ──► trigger decision ──► nudge / execute
```

Key files:

| File | Responsibility |
|------|----------------|
| `sessionIngester.ts` | Polls Screenpipe input stream every 2 min; stitches events into sessions |
| `consolidation.ts` | Nightly NREM/REM/GC cycle |
| `behaviourProfile.ts` | Writes `behaviour.md`; read by all LLM prompts |
| `browserDriver.ts` | CDP connection to dedicated Chrome profile; ranked locators |
| `skillEngine.ts` | Compile (plan-then-execute) and replay (deterministic) |
| `axDriver.ts` | macOS native app control via AXUIElement |
| `actionEngine.ts` | Perception loop + LLM trigger decision |
| `extractor.ts` | Hourly Screenpipe OCR extraction fallback |
| `db.ts` | SQLite schema: workflows, rules, skills, sessions, raw_events |

---

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for setup instructions and coding guidelines.

Open issues on GitHub — look for `good first issue` labels.

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

MIT
