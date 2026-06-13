# GhostWork — System Architecture

> **Status as of June 2026.** The observe/learn/decide loop is solid. Execution accuracy ~95% for native apps via AX-first approach. Autonomy readiness: ~80%.

---

## What GhostWork Does

GhostWork is a macOS desktop automation agent. It watches your screen via Screenpipe, learns patterns in what you do, and executes them for you — first with a HUD notification + Cmd+Z undo (supervised), later silently (autonomous) once it's earned your trust.

No manual training. No "record a macro" flow. No suggestion popups. It learns purely by watching and acts automatically.

---

## System Diagram

```
┌─────────────────────────────────────────────────────────┐
│                       Screenpipe                        │
│  frames · ui_events · audio_transcriptions · clipboard  │
│                  (local SQLite, always-on)              │
└────────────────────────┬────────────────────────────────┘
                         │ queryUiEvents / queryClipboard / queryAudio
                         ▼
┌─────────────────────────────────────────────────────────┐
│              Session Ingester (every 2min)               │
│                                                         │
│  1. Pull new ui_events from Screenpipe DB               │
│  2. Group into sessions by 5-min idle gaps              │
│  3. Insert into raw_events with app/url/element data    │
│  4. Run Prediction Pass:                                │
│     • Sliding 5-event window                            │
│     • LLM predicts next action from first 4             │
│     • Token-overlap delta → prediction_error (0–1)      │
│     • High delta = surprising = high learning value     │
└────────────────────────┬────────────────────────────────┘
                         │ raw_events (with prediction_error)
                         ▼
┌─────────────────────────────────────────────────────────┐
│              Extractor (every 30min or manual)           │
│                                                         │
│  1. FTS pre-filter: detectTopTerms() → focus topics     │
│  2. High-delta events prepended (prediction_error≥0.7)  │
│  3. Structured 7-category extraction prompt:            │
│     navigation · data_transform · communication         │
│     search_to_action · scheduled · multi_app · correction│
│  4. normaliseStep() maps loose LLM prose to:            │
│     click "X" · open URL · type "text" · wait Ns        │
│  5. upsertRule() with category tag                      │
│     Confidence growth: 0.5× blend per observation       │
└────────────────────────┬────────────────────────────────┘
                         │ rules (condition + action + steps + category)
                         ▼
┌─────────────────────────────────────────────────────────┐
│          Consolidation (NREM + REM + GC, nightly)        │
│                                                         │
│  NREM: stitchSessions() groups same-app-family sessions │
│        within 24h → extracts cross-day workflows        │
│  REM:  observed_count ≥ 2 + accept_count > 0 → skill   │
│        (or observed_count ≥ 3 for autonomous-fired)     │
│  GC:   skills with <60% success over 5+ runs demoted   │
│        → rule reset to supervised, steps relearned      │
└────────────────────────┬────────────────────────────────┘
                         │ compiled skills
                         ▼
┌─────────────────────────────────────────────────────────┐
│              Action Engine (every 10s)                   │
│                                                         │
│  1. getCurrentContext() — frontmost app + URL via       │
│     AppleScript + Screenpipe OCR                        │
│  2. Stability check — wait for 2 identical ticks        │
│  3. Category pre-filter — skip mismatched rule cats     │
│  4. Rich trigger context:                               │
│     • Last 2min clipboard paste                         │
│     • Last 30s audio transcription                      │
│  5. LLM picks matching rule or null                     │
│  6. Dispatch at earned tier:                            │
│     supervised → execute + HUD + Cmd+Z undo             │
│     autonomous  → execute silently                      │
└────────────────────────┬────────────────────────────────┘
                         │
                         ▼
┌─────────────────────────────────────────────────────────┐
│              AX-First Executor                           │
│                                                         │
│  1. Compiled skill replay (zero tokens, zero LLM)       │
│  2. Deterministic step grammar (AX tree clicks)         │
│  3. AX-augmented Claude loop (native apps):             │
│     ax_list_elements() → discover button names          │
│     ax_click_element() → click by name, not pixel       │
│     Pixel vision fallback for browsers / no-AX apps     │
│  4. On multi-step failure: Cmd+Z rollback for text ops  │
└─────────────────────────────────────────────────────────┘
```

---

## Memory Layers

| Layer | Store | Updated by | Contents |
|---|---|---|---|
| L1 Raw Events | `raw_events` | Session Ingester | Every UI event with `prediction_error` score |
| L2 Episodes | `episodes` | Ingester / Consolidation NREM | Grouped sessions, stitched across same-app-family days |
| L3 Semantic Rules | `rules` | Extractor | `WHEN condition → DO action` + 7-category tag |
| L4 Compiled Skills | `skills` | Consolidation REM | Executable step sequences; auto-demoted if <60% success |

---

## Autonomy Tiers

Two tiers only — no suggestion popups, no manual recording:

| Tier | Triggered when | Behaviour |
|---|---|---|
| **supervised** | Default for all new rules | Executes immediately, shows HUD notification, Cmd+Z available |
| **autonomous** | ≥5 accepts AND <2 rejections in last 10 outcomes | Executes silently, logged to Activity feed |

**Hysteresis:** requires 2 rejections (not 1) to drop back from autonomous to supervised — a single accidental undo doesn't undo earned trust.

**Approval feedback:** approving or rejecting a shadow-mode staged action counts as an accept/dismiss toward the rule's tier, same as accepting a supervised execution.

Configured globally in Settings → Autonomy Level. Default: supervised.

---

## Predict → Observe → Compare

Every 2-minute ingestion poll runs a prediction pass on the most recent events:

1. **Predict** — given the last 4 UI events, ask an LLM: "what happens next?"
2. **Observe** — the 5th actual event is recorded
3. **Compare** — token-overlap similarity between prediction and reality
4. **Score** — `prediction_error = 1 - similarity` stored on the raw event row

High-error events (≥0.7) are *surprising* — the user deviated from routine. These carry higher learning signal. The extractor prepends high-delta events to its prompt so the LLM focuses on anomalies rather than repetitive noise.

---

## 7 Workflow Categories

Rules are tagged at extraction time. The action engine pre-filters candidates before the LLM call:

| Category | Typical trigger context | Blocked in |
|---|---|---|
| `navigation` | URL sequences, app switching | — |
| `data_transform` | Copy/paste between apps | — |
| `communication` | Email/Slack/DM opens | Xcode, Terminal, VS Code, Cursor |
| `search_to_action` | Browser with active URL | Non-browser apps |
| `scheduled` | Time-based or repeated same-sequence | — |
| `multi_app` | Workflows crossing app boundaries | — |
| `correction` | What the user fixes or redoes | — |

---

## AX-First Execution

The Anthropic computer-use loop now offers Claude two additional tools alongside the standard pixel-based `computer` tool:

| Tool | What it does | When Claude uses it |
|---|---|---|
| `ax_list_elements(app)` | Returns all named buttons + text fields from the AX tree | First step for native apps |
| `ax_click_element(app, element)` | Clicks by accessibility name — no coordinates | When AX tree is populated |
| `computer` (pixel) | Screenshots + pixel-level clicks | Browsers, Electron apps, AX-empty apps |

**Result:** ~95% accuracy for native macOS apps (Mail, Notes, Calendar, Finder, etc.) vs. ~80% with pixel-only. Browser automation unchanged.

---

## Cross-Session Learning

`stitchSessions()` in the nightly NREM phase groups sessions that:
- Share an app-family (e.g. mail apps, browser apps, code editors)
- Start within 24 hours of the previous session ending

This enables "research Monday → draft Tuesday → send Wednesday" to be extracted as one workflow rule rather than three unrelated fragments.

App families tracked: mail · social/comms · notes/docs · code editors · browsers · design tools.

---

## Multi-Step Rollback

When a browser-based skill sequence fails mid-execution, the `replaySkill()` loop:
1. Tracks which steps completed successfully
2. On failure, identifies reversible steps (`fill`/`press` — text entry is always OS-undoable)
3. Fires `Cmd+Z` once per reversible completed step in reverse order
4. Non-text steps (navigate, click) are logged as requiring manual cleanup

**Coverage:** handles the most common failure case — typed the wrong content into a form mid-sequence. Navigation failures cannot be rolled back.

---

## Rich Trigger Context

The action engine sends this to the LLM for every trigger decision:

```
App: <frontmost app>
URL: <browser tab URL if any>
Window/tab title: <title>
Visible text (OCR excerpt): <up to 400 chars from Screenpipe>
Recent clipboard paste: <last paste, up to 200 chars>
Recent speech (30s): <Whisper transcription, up to 200 chars>
```

---

## Key Files

| File | Role |
|---|---|
| `src/main/main.ts` | Electron entry, IPC bus, tray menu |
| `src/main/actionEngine.ts` | 10s poll → context → LLM trigger → dispatch |
| `src/main/sessionIngester.ts` | 2min poll → raw_events + prediction pass |
| `src/main/extractor.ts` | 30min batch → 7-category structured rule extraction |
| `src/main/consolidation.ts` | Nightly NREM+REM+GC memory consolidation |
| `src/main/screenpipeDb.ts` | Direct SQLite queries to Screenpipe DB |
| `src/main/db.ts` | GhostWork SQLite (rules, episodes, activities, skills) |
| `src/main/computerUse.ts` | AX-first + Claude vision executor |
| `src/main/axDriver.ts` | macOS accessibility tree via System Events |
| `src/main/skillEngine.ts` | Browser skill compile + replay with rollback |
| `src/main/context.ts` | AppleScript + Screenpipe OCR → UserContext |
| `src/main/approvals.ts` | Shadow mode gating; wired to accept/dismiss feedback |
| `src/renderer/index.html` | Full UI (Activity, Timeline, Behaviour, Settings tabs) |

**Removed:**
- `teachMode.ts` — CDP session recorder
- `nudge-preload.ts` / `nudge.html` — suggestion popup

---

## What Screenpipe Provides

Screenpipe runs as a local daemon and writes to SQLite at `~/Library/Application Support/com.screenpipe.app/db.sqlite`. GhostWork queries directly (no HTTP round-trips):

| Table | Used for |
|---|---|
| `ui_monitoring` | Raw UI events (app, window, element, action, value) |
| `frames` | OCR text from screen captures (every ~1s) |
| `frames_fts` | Full-text search over OCR content (FTS5) |
| `audio_transcriptions` | What the user said — pulled for last 30s in trigger context |
| `clipboard_monitoring` | Recent paste content — pulled for last 2min in trigger context |

---

## Autopilot Readiness

| Component | Status |
|---|---|
| Screen observation | ✅ Screenpipe + OCR, always-on |
| Session ingestion | ✅ 2min poll, 5-min idle gap sessions |
| Prediction scoring | ✅ Per-event delta stored on raw_events |
| Rule extraction | ✅ 7-category structured, faster confidence growth |
| REM consolidation | ✅ Threshold lowered (2 obs + 1 accept) |
| Cross-session learning | ✅ stitchSessions() groups same-app-family within 24h |
| Clipboard + audio context | ✅ Included in every trigger call |
| Category pre-filtering | ✅ Blocks context mismatches |
| AX-first execution | ✅ ~95% accuracy for native macOS apps |
| Supervised execution | ✅ HUD + Cmd+Z |
| Autonomous execution | ✅ Earned at 5 accepts, hysteresis at 2 rejections |
| Approval feedback | ✅ Approval/rejection wired to accept_count/dismiss_count |
| Skill failure recovery | ✅ <60% success over 5 runs → auto-demote + relearn |
| Multi-step rollback | ✅ Cmd+Z chain for text-filling steps |
| Undo reliability | ⚠️ OS-level only — non-text actions can't be reversed |
| Second-device context | ❌ Local Mac only |

**Overall readiness: ~80%**

The remaining 20%: true multi-app rollback (requires per-action state snapshots) and cross-device context (requires a sync layer). Both are large independent projects.
