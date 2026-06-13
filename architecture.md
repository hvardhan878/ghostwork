# GhostWork — System Architecture

> **Status as of June 2026.** The system is production-capable for supervised execution. Full autonomous mode is gated behind earned confidence.

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
└────────────────────────┬────────────────────────────────┘
                         │ rules (condition + action + steps + category)
                         ▼
┌─────────────────────────────────────────────────────────┐
│             Consolidation (NREM + REM, nightly)          │
│                                                         │
│  NREM: clusters raw_events into episodes                │
│  REM:  compiles episodes → skills via generic semantic  │
│        matching (condition terms in session URLs/apps)  │
│        [fixed: was hardcoded to LinkedIn/Gmail only]    │
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
│     (e.g. no 'communication' rules in Xcode)            │
│  4. Rich trigger context:                               │
│     • Last 2min clipboard paste                         │
│     • Last 30s audio transcription                      │
│  5. LLM (cheap model) picks matching rule or null       │
│  6. Dispatch at earned tier:                            │
│     supervised → execute + HUD + Cmd+Z undo             │
│     autonomous  → execute silently                      │
└─────────────────────────────────────────────────────────┘
```

---

## Memory Layers

| Layer | Store | Updated by | Contents |
|---|---|---|---|
| L1 Raw Events | `raw_events` | Session Ingester | Every UI event with `prediction_error` score |
| L2 Episodes | `episodes` | Ingester / Consolidation NREM | Grouped sessions with app/URL context |
| L3 Semantic Rules | `rules` | Extractor | `WHEN condition → DO action` + 7-category tag |
| L4 Compiled Skills | `skills` | Consolidation REM | Executable step sequences from confirmed workflows |

---

## Autonomy Tiers

Two tiers only — no suggestion popups, no manual recording, no "teach me" sessions:

| Tier | Triggered when | Behaviour |
|---|---|---|
| **supervised** | Default for all new rules | Executes immediately, shows HUD notification, Cmd+Z available for 60s |
| **autonomous** | Rule has ≥5 net accepts (accepts − dismissals) | Executes silently, logged to Activity feed |

Configured globally in Settings → Autonomy Level. Default: supervised.

---

## Predict → Observe → Compare

Every 2-minute ingestion poll runs a prediction pass on the most recent events:

1. **Predict** — given the last 4 UI events, ask an LLM: "what happens next?"
2. **Observe** — the 5th actual event is recorded
3. **Compare** — token-overlap similarity between prediction and reality
4. **Score** — `prediction_error = 1 - similarity` stored on the raw event row

High-error events (≥0.7) are *surprising* — the user deviated from routine. These carry higher learning signal. The extractor prepends high-delta events to its prompt so the LLM focuses attention on anomalies rather than repetitive noise.

---

## 7 Workflow Categories

Rules are tagged at extraction time. The action engine pre-filters candidates before the LLM call, avoiding nonsensical matches:

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

Clipboard and audio are the strongest intent signals — if the user just pasted a job title and is on LinkedIn, that maps to a completely different rule than "user is browsing LinkedIn profiles."

---

## Key Files

| File | Role |
|---|---|
| `src/main/main.ts` | Electron entry, IPC bus, tray menu |
| `src/main/actionEngine.ts` | 10s poll → context → LLM trigger → dispatch |
| `src/main/sessionIngester.ts` | 2min poll → raw_events + prediction pass |
| `src/main/extractor.ts` | 30min batch → 7-category structured rule extraction |
| `src/main/consolidation.ts` | Nightly NREM+REM memory consolidation |
| `src/main/screenpipeDb.ts` | Direct SQLite queries to Screenpipe DB |
| `src/main/db.ts` | GhostWork SQLite (rules, episodes, activities, skills) |
| `src/main/computerUse.ts` | Claude computer-use executor for action dispatch |
| `src/main/context.ts` | AppleScript + Screenpipe OCR → UserContext |
| `src/main/approvals.ts` | Shadow mode gating for outbound actions |
| `src/renderer/index.html` | Full UI (Activity, Timeline, Behaviour, Settings tabs) |

**Removed:**
- `teachMode.ts` — CDP session recorder (gone)
- `nudge-preload.ts` / `nudge.html` — suggestion popup (gone)

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

## Gaps to Full Autopilot

### 1. Cold-start (critical)
New rules start at supervised and need ≥5 accepts to go autonomous. First 24–48hrs a user sees only supervised executions — which is correct, but the first experience is heavily dependent on having workflows that match quickly. Seeding a small library of universal patterns (create calendar event, open new tab, etc.) would accelerate time-to-value.

### 2. Execution accuracy
`computerUse.ts` uses Claude's vision model to identify and click UI elements. Success rate is ~70–80% on standard UIs. Fails on: custom web components, apps that rearrange layout between frames, apps with no accessibility labels. The fix is AX tree-first execution with vision as fallback.

### 3. Step grammar coverage
`normaliseStep()` handles `click`, `open`, `type`, `wait`. Missing verbs: `scroll`, `select` (dropdown), `drag`, `copy`, `paste`. Workflows involving these produce prose instructions instead of structured steps, which reduces execution reliability.

### 4. Undo fidelity
Cmd+Z invokes the OS undo stack. Works for text edits in documents. Doesn't work for: opening tabs, launching apps, sending emails, form submissions. A proper rollback would need a before-state snapshot per action type.

### 5. Multi-step failure recovery
If a 5-step sequence fails at step 3, the executor stops — state is partially applied with no rollback. No retry logic, no checkpoint saves. The user has to manually clean up.

### 6. Cross-session pattern detection
The extractor looks at one 30-min activity window at a time. Long workflows that span sessions (research Tuesday → draft Wednesday → send Thursday) never get learned as a single unit. Cross-session stitching isn't implemented.

### 7. Audio signal quality
Whisper transcription degrades with noise, accents, and domain vocabulary. If the user doesn't talk while working, this signal is empty. If Screenpipe hasn't been running long, the tables are sparse.

### 8. Prediction pass cost
One LLM call per 2-min poll to score prediction error. Currently one window per poll. Cheap model, but on low-end hardware or if Screenpipe generates many events, this could add up. A local embedding similarity check would eliminate the API call entirely.

### 9. Rule conflict resolution
Multiple rules can match the same context. The trigger LLM picks the best one with no explicit tie-breaking. Adding confidence-weighted priority ordering per category would reduce misfires in ambiguous contexts.

### 10. No second-device context
Everything is local to one Mac. External displays, iPhones, or iPads used for reference are invisible. For knowledge workers who split workflows across devices, this is a hard blind spot.

---

## Autonomy Readiness

| Component | Status |
|---|---|
| Screen observation | ✅ Working — Screenpipe + OCR |
| Session ingestion | ✅ Working — 2min poll |
| Prediction scoring | ✅ Working — per-event delta stored |
| Rule extraction | ✅ Working — 7-category structured |
| REM consolidation | ✅ Fixed — generic semantic matcher |
| Clipboard + audio context | ✅ Working — included in every trigger call |
| Category pre-filtering | ✅ Working — blocks context mismatches |
| Supervised execution | ✅ Working — HUD + Cmd+Z |
| Autonomous execution | ⚠️ Works — but earning tier takes days |
| Undo reliability | ⚠️ OS-level only — limited to text edits |
| Execution accuracy | ⚠️ ~70–80% — vision model, no AX fallback |
| Multi-step rollback | ❌ Not implemented |
| Cross-session learning | ❌ Not implemented |

**Overall readiness: ~55%** — the observe / learn / decide loop is solid. The execution and recovery layer is the remaining gap before truly hands-off automation.
