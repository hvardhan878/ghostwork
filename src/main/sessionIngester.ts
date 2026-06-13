/**
 * Session ingester — continuously pulls interaction events from Screenpipe's
 * local SQLite database and stores them in the episodic memory layer.
 *
 * Runs every 2 minutes. Queries ui_events JOIN frames directly so we get
 * the full context: app name, window title, browser URL, AX element name
 * and role — none of which are available via the REST API.
 *
 * Events are grouped into sessions by 5-minute idle gaps.
 */

import { queryUiEvents, UiEvent } from "./screenpipeDb";
import {
  openSession,
  closeSession,
  updateSession,
  insertRawEvent,
  getSetting,
  setSetting,
} from "./db";

const POLL_INTERVAL_MS = 2 * 60 * 1000;  // every 2 minutes
const SESSION_IDLE_GAP_MS = 5 * 60 * 1000; // 5-min gap = new session
const SETTING_KEY = "ingester_last_cursor";

let pollTimer: ReturnType<typeof setInterval> | null = null;
let activeSessionId: number | null = null;
let lastEventTs: number = 0;
let activeSessionUrls = new Set<string>();
let activeSessionApps = new Set<string>();
let activeSessionEventCount = 0;

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
    // Look back 1.5× the poll interval to avoid missing events at boundaries.
    const since = cursor || new Date(now.getTime() - POLL_INTERVAL_MS * 1.5).toISOString();
    const until = now.toISOString();

    const events = queryUiEvents(since, until, 500);
    if (events.length === 0) {
      setSetting(SETTING_KEY, until);
      return;
    }

    let ingested = 0;

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

      insertRawEvent({
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
      });

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
    }

    setSetting(SETTING_KEY, until);
  } catch (err) {
    console.warn("[ingester] Poll error:", err);
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

/**
 * Accept a raw event pushed from the browser recorder (has DOM locators).
 * Called by teachMode when operating on Ghostwork's dedicated Chrome profile.
 */
export function ingestBrowserEvent(event: {
  type: string;
  app: string;
  url: string | null;
  window_name: string | null;
  element_role: string | null;
  element_name: string | null;
  locators: string | null;
  value: string | null;
  ts: string;
}): void {
  const evMs = new Date(event.ts).getTime();

  if (
    activeSessionId !== null &&
    lastEventTs > 0 &&
    evMs - lastEventTs > SESSION_IDLE_GAP_MS
  ) {
    flushSession();
  }

  if (activeSessionId === null) {
    activeSessionId = openSession(event.app);
    activeSessionUrls = new Set();
    activeSessionApps = new Set();
    activeSessionEventCount = 0;
  }

  if (event.app) activeSessionApps.add(event.app);
  if (event.url) activeSessionUrls.add(event.url);

  insertRawEvent({
    session_id: activeSessionId,
    ts: event.ts,
    type: event.type,
    app: event.app,
    url: event.url,
    window_name: event.window_name,
    element_role: event.element_role,
    element_name: event.element_name,
    locators: event.locators,
    value: event.value,
    source: "browser",
  });

  lastEventTs = evMs;
  activeSessionEventCount++;

  updateSession(activeSessionId, {
    urls: [...activeSessionUrls],
    apps: [...activeSessionApps],
    event_count: activeSessionEventCount,
  });
}
