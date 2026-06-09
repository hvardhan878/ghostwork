# Ghostwork

A macOS background agent that watches what you do, learns recurring workflows, and can take real actions on your screen when it recognizes a familiar situation.

Ghostwork runs in the menu bar. It observes activity through [Screenpipe](https://github.com/mediar-ai/screenpipe), builds a local model of your habits, and uses Claude (via [OpenRouter](https://openrouter.ai)) to suggest or execute actions with computer use — mouse, keyboard, and screenshots.

## How it works

```
Screen activity (Screenpipe)
        ↓
Hourly pattern extraction (Claude via OpenRouter)
        ↓
Local SQLite model (workflows + rules + confidence scores)
        ↓
Action engine polls every 10s → matches current context to rules
        ↓
Computer use executor (screenshots, clicks, typing on your Mac)
```

**Learn.** Every hour, Ghostwork pulls recent screen activity from Screenpipe, strips obvious PII (emails, phone numbers, etc.), and asks Claude to extract workflows and rules. These are stored locally in SQLite — nothing leaves your machine except the anonymized prompts sent to OpenRouter.

**Match.** The action engine checks your current context against learned rules every 10 seconds. Each rule has a confidence score that determines behavior:

| Confidence | Tier | Behavior |
|------------|------|----------|
| &lt; 0.6 | Suggest | Show in the sidebar; you decide |
| 0.6 – 0.85 | Supervised | Act, then ask you to confirm or undo |
| &gt; 0.85 | Autonomous | Act silently and log to the activity feed |

**Act.** When a rule fires, Ghostwork calls Claude with the computer-use tool. Claude sees a screenshot, returns actions (click, type, scroll, etc.), and Ghostwork executes them locally using macOS APIs — `screencapture`, Quartz CoreGraphics for mouse events, and AppleScript for keyboard input.

## Requirements

- **macOS** (Apple Silicon or Intel)
- **Node.js** 18+
- **[Screenpipe](https://github.com/mediar-ai/screenpipe)** — Ghostwork can launch and manage it automatically, or you can run it yourself
- **OpenRouter API key** — used for pattern extraction and computer-use actions ([get one here](https://openrouter.ai/keys))

Ghostwork also needs macOS permissions for screen recording and accessibility (for mouse/keyboard control). You will be prompted on first use.

## Setup

```bash
git clone https://github.com/hvardhan878/ghostwork.git
cd ghostwork
npm install
cp .env.example .env
# Edit .env and add your OpenRouter API key
npm start
```

The app opens as a menu-bar utility. Click the tray icon to open the main window.

## Demo data

On first launch, Ghostwork seeds **one example workflow** so you can see what learned behavior looks like before it has observed you. Demo items are clearly marked with a **Demo** badge in the UI and in the Learned Workflows list.

You can also run a **live demo** from the home screen — it opens Calculator via Spotlight and types `2+2=` so you can watch Ghostwork take a real action on your screen. This requires a valid OpenRouter API key.

Use **Wipe all data** in Settings to remove demo and learned data and start fresh.

## Project structure

```
src/
  main/
    main.ts            — Electron app, tray, IPC, scheduled jobs
    screenpipe.ts      — Screenpipe API client
    screenpipeManager.ts — launches/manages Screenpipe process
    extractor.ts       — hourly workflow extraction from activity
    consolidation.ts — nightly cleanup of the behaviour model
    actionEngine.ts    — polls context and triggers rules
    computerUse.ts     — Claude computer-use loop + local execution
    db.ts              — SQLite storage for workflows, rules, activity
    demo.ts            — seeds the example workflow on first launch
  renderer/
    index.html         — UI (activity feed, workflows, settings)
```

## Scripts

| Command | Description |
|---------|-------------|
| `npm start` | Build TypeScript and launch Electron |
| `npm run dev` | Same as start, with Node inspector enabled |
| `npm run build` | Compile TypeScript to `dist/` |

## Privacy

- Activity data comes from Screenpipe and stays local except for anonymized excerpts sent to OpenRouter during extraction and action execution.
- PII patterns (email, phone, credit card) are redacted before any LLM call.
- You can exclude specific apps from observation in Settings.

## License

This project is licensed under the **Ghostwork Non-Commercial License**. You may use, modify, and share it for **non-commercial purposes only**. Commercial use is not permitted. See [LICENSE](LICENSE) for full terms.
