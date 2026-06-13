/**
 * Session ingester — continuously pulls interaction events from Screenpipe's
 * local SQLite database and stores them in the episodic memory layer.
 *
 * Runs every 2 minutes. Queries ui_events JOIN frames directly so we get
 * the full context: app name, window title, browser URL, AX element name
 * and role — none of which are available via the REST API.
 *
 * Events are grouped into sessions by 5-minute idle gaps.
 *
 * Prediction pass: after each batch is ingested, a sliding
 * 5-event window is sent to a cheap LLM — "predict event 5 given events 1–4".
 * The delta between prediction and reality is stored as prediction_error.
 * High-error events are surprising and carry more learning signal; the
 * extractor weights them heavily when building extraction prompts.
 */

import { queryUiEvents, UiEvent } from "./screenpipeDb";
import {
  openSession,
  closeSession,
  updateSession,
  insertRawEvent,
  updateRawEventPredictionError,
  getSetting,
  setSetting,
  getDb,
} from "./db";
import { promptJSON, FAST_MODEL } from "./openrouter";

const POLL_INTERVAL_MS = 2 * 60 * 1000;  // every 2 minutes
const SESSION_IDLE_GAP_MS = 5 * 60 * 1000; // 5-min gap = new session
const SETTING_KEY = "ingester_last_cursor";
const PREDICTION_WINDOW = 5;  // events per sliding window
const PREDICTION_STRIDE = 3;  // step between windows (avoids O(n²) calls)

let pollTimer: ReturnType<typeof setInterval> | null = null;
let activeSessionId: number | null = null;
let lastEventTs: number = 0;
let activeSessionUrls = new Set<string>();
let activeSessionApps = new Set<string>();
let activeSessionEventCount = 0;

// Ring buffer of the last N inserted raw_event IDs + their event descriptions.
// Used to run the prediction pass after each poll batch.
interface RecentEvent { id: number; description: string; }
const recentEventBuffer: RecentEvent[] = [];
const BUFFER_MAX = 50;

export function startSessionIngester(): void {
  if (pollTimer) return;
  console.log("[ingester] Session ingester started — querying Screenpipe DB every 2min");
  void poll();
  pollTimer = setInterval(() => void poll(), POLL_INTERVAL_MS);
}

export function stopSessionIngester(): void {
  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
    console.log("[ingester] Session ingester stopped.");
  }
  if (activeSessionId !== null) {
    flushSession();
  }
}

async function poll(): Promise<void> {
  try {
    const cursor = getSetting(SETTING_KEY, "");
    const now = new Date();
    const since = cursor || new Date(now.getTime() - POLL_INTERVAL_MS * 1.5).toISOString();
    const until = now.toISOString();

    const events = queryUiEvents(since, until, 500);
    if (events.length === 0) {
      setSetting(SETTING_KEY, until);
      return;
    }

    let ingested = 0;
    const newEventIds: number[] = [];

    for (const ev of events) {
      const evMs = new Date(ev.timestamp).getTime();

      // Session boundary: close current session if idle gap exceeded.
      if (
        activeSessionId !== null &&
        lastEventTs > 0 &&
        evMs - lastEventTs > SESSION_IDLE_GAP_MS
      ) {
        flushSession();
      }

      // Open a new session if none is active.
      if (activeSessionId === null) {
        activeSessionId = openSession(ev.app_name || "unknown");
        activeSessionUrls = new Set();
        activeSessionApps = new Set();
        activeSessionEventCount = 0;
      }

      if (ev.app_name) activeSessionApps.add(ev.app_name);
      if (ev.browser_url) activeSessionUrls.add(ev.browser_url);

      const rawId = insertRawEvent({
        session_id: activeSessionId,
        ts: ev.timestamp,
        type: ev.event_type,
        app: ev.app_name || "",
        url: ev.browser_url || null,
        window_name: ev.window_name || null,
        element_role: ev.element_role || null,
        element_name: (ev.element_name || ev.element_value)?.slice(0, 120) ?? null,
        locators: null,
        value: buildValue(ev),
        source: "screenpipe",
        prediction_error: null,
      });

      // Build a compact text description for the prediction buffer.
      const desc = buildEventDescription(ev);
      recentEventBuffer.push({ id: rawId, description: desc });
      if (recentEventBuffer.length > BUFFER_MAX) recentEventBuffer.shift();

      newEventIds.push(rawId);
      lastEventTs = evMs;
      activeSessionEventCount++;
      ingested++;
    }

    if (ingested > 0) {
      console.log(`[ingester] Ingested ${ingested} events (${[...activeSessionApps].join(", ") || "no app context"})`);
      if (activeSessionId !== null) {
        updateSession(activeSessionId, {
          urls: [...activeSessionUrls],
          apps: [...activeSessionApps],
          event_count: activeSessionEventCount,
        });
      }
      // Run prediction pass in the background — don't block the main ingestion.
      void runPredictionPass().catch((err) =>
        console.warn("[ingester] Prediction pass error:", err)
      );
    }

    setSetting(SETTING_KEY, until);
  } catch (err) {
    console.warn("[ingester] Poll error:", err);
  }
}

// ─── Prediction pass ─────────────────────────────────────────────────────────
// For each sliding window of PREDICTION_WINDOW events, we ask the LLM to
// predict the final event given the preceding ones, then compare to reality.
// High prediction error = surprising moment = high learning value.

interface PredictionResult {
  predicted_action: string;
  reasoning: string;
}

async function runPredictionPass(): Promise<void> {
  // Only run if there are enough events and an API key is available.
  if (!(process.env.OPENROUTER_API_KEY ?? process.env.ANTHROPIC_API_KEY)) return;
  if (recentEventBuffer.length < PREDICTION_WINDOW) return;

  // Process one window per poll call to keep costs low.
  // Take a window ending at the most recent events.
  const windowEnd = recentEventBuffer.length - 1;
  const windowStart = windowEnd - PREDICTION_WINDOW + 1;
  if (windowStart < 0) return;

  const window = recentEventBuffer.slice(windowStart, windowEnd + 1);
  const context = window.slice(0, PREDICTION_WINDOW - 1);
  const actual = window[PREDICTION_WINDOW - 1];

  const prompt = `A user is working on their computer. Given these recent actions:
${context.map((e, i) => `${i + 1}. ${e.description}`).join("\n")}

Predict the NEXT action they will take. Be specific about app, element, and action type.

Reply with JSON only:
{"predicted_action": "short description of next action", "reasoning": "one sentence"}`;

  try {
    const result = await promptJSON<PredictionResult>(prompt, FAST_MODEL);
    if (!result?.predicted_action) return;

    // Compute similarity between prediction and actual.
    // Simple token overlap — cheap, no extra API call.
    const predTokens = new Set(result.predicted_action.toLowerCase().match(/\w+/g) ?? []);
    const actualTokens = new Set(actual.description.toLowerCase().match(/\w+/g) ?? []);
    let overlap = 0;
    for (const t of predTokens) if (actualTokens.has(t)) overlap++;
    const similarity = predTokens.size > 0
      ? overlap / Math.max(predTokens.size, actualTokens.size)
      : 0;
    const error = 1 - similarity; // 0 = perfectly predicted, 1 = completely wrong

    updateRawEventPredictionError(actual.id, error);

    if (error >= 0.7) {
      console.log(`[ingester:predict] High-delta event (Δ=${error.toFixed(2)}): "${actual.description.slice(0, 60)}"`);
    }
  } catch {
    // Prediction pass is best-effort — never block ingestion.
  }
}

function flushSession(): void {
  if (activeSessionId !== null) {
    updateSession(activeSessionId, {
      urls: [...activeSessionUrls],
      apps: [...activeSessionApps],
      event_count: activeSessionEventCount,
    });
    closeSession(activeSessionId);
    console.log(
      `[ingester] Session #${activeSessionId} closed — ` +
      `${activeSessionEventCount} events, apps: ${[...activeSessionApps].slice(0, 3).join(", ")}`
    );
    activeSessionId = null;
    activeSessionUrls = new Set();
    activeSessionApps = new Set();
    activeSessionEventCount = 0;
  }
}

function buildValue(ev: UiEvent): string | null {
  if (ev.text_content) return ev.text_content.slice(0, 300);
  if (ev.key_code != null) return `key:${ev.key_code}`;
  return null;
}

function buildEventDescription(ev: UiEvent): string {
  const parts: string[] = [ev.event_type, `in ${ev.app_name || "unknown"}`];
  if (ev.browser_url) parts.push(`@ ${ev.browser_url.slice(0, 50)}`);
  if (ev.element_name) parts.push(`→ "${ev.element_name.slice(0, 40)}"`);
  if (ev.element_role) parts.push(`(${ev.element_role})`);
  if (ev.text_content) parts.push(`= "${ev.text_content.slice(0, 40)}"`);
  return parts.join(" ");
}
