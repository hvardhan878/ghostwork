/**
 * Session ingester — continuously pulls interaction events from Screenpipe
 * and stores them in the local episodic memory layer (raw_events + sessions).
 *
 * Runs every 2 minutes. Reads Screenpipe's input and accessibility streams
 * (clicks, keystrokes, app switches, UI element snapshots) and maps them into
 * raw_events rows, grouped into sessions by 5-minute idle gaps.
 *
 * This is the foundation of the L2 episodic memory layer. Everything the user
 * does across every app is captured here and preserved for 90 days.
 */

import {
  getInputEvents,
  getAccessibilityEvents,
  InputEvent,
} from "./screenpipe";
import {
  openSession,
  closeSession,
  updateSession,
  insertRawEvent,
  getSetting,
  setSetting,
} from "./db";

const POLL_INTERVAL_MS = 2 * 60 * 1000; // every 2 minutes
const SESSION_IDLE_GAP_MS = 5 * 60 * 1000; // 5-min gap = new session
const SETTING_KEY = "ingester_last_cursor";

const EXCLUDED_APPS_DEFAULT = ["cursor", "electron", "ghostwork"];

let pollTimer: ReturnType<typeof setInterval> | null = null;
let activeSessionId: number | null = null;
let lastEventTs: number = 0;
let activeSessionUrls = new Set<string>();
let activeSessionApps = new Set<string>();

export function startSessionIngester(): void {
  if (pollTimer) return;
  console.log("[ingester] Session ingester started — polling Screenpipe input stream every 2min");
  void poll(); // immediate first pass
  pollTimer = setInterval(() => void poll(), POLL_INTERVAL_MS);
}

export function stopSessionIngester(): void {
  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
    console.log("[ingester] Session ingester stopped.");
  }
  if (activeSessionId !== null) {
    closeSession(activeSessionId);
    activeSessionId = null;
  }
}

async function poll(): Promise<void> {
  try {
    const cursor = getSetting(SETTING_KEY, "");
    const now = new Date();
    const since = cursor || new Date(now.getTime() - POLL_INTERVAL_MS * 1.5).toISOString();
    const until = now.toISOString();

    const excludedAppsRaw = getSetting("excluded_apps", "[]");
    let excludedApps: string[] = EXCLUDED_APPS_DEFAULT;
    try {
      const parsed = JSON.parse(excludedAppsRaw) as string[];
      excludedApps = [...EXCLUDED_APPS_DEFAULT, ...parsed.map((a) => a.toLowerCase())];
    } catch {
      // use defaults
    }

    // Fetch input events and accessibility snapshots in parallel.
    const [inputEvents, axEvents] = await Promise.all([
      getInputEvents(since, until, undefined, 300),
      getAccessibilityEvents(since, until, undefined, 100),
    ]);

    // Build a quick lookup: ax event nearest in time to a click for element context
    const axByTime = axEvents.sort((a, b) =>
      new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime()
    );

    let ingested = 0;

    for (const ev of inputEvents) {
      if (isExcluded(ev.app_name, excludedApps)) continue;
      if (!isUsefulEvent(ev)) continue;

      const evMs = new Date(ev.timestamp).getTime();

      // Session stitching: close and open if idle gap exceeded
      if (
        activeSessionId !== null &&
        lastEventTs > 0 &&
        evMs - lastEventTs > SESSION_IDLE_GAP_MS
      ) {
        closeAndFlush();
      }

      if (activeSessionId === null) {
        activeSessionId = openSession(ev.app_name);
        activeSessionUrls = new Set();
        activeSessionApps = new Set();
      }

      // Find nearest accessibility snapshot for element context
      const ax = findNearestAx(axByTime, evMs, ev.app_name);

      activeSessionApps.add(ev.app_name);
      const url = extractUrl(ev, ax);
      if (url) activeSessionUrls.add(url);

      insertRawEvent({
        session_id: activeSessionId,
        ts: ev.timestamp,
        type: ev.type,
        app: ev.app_name,
        url: url ?? null,
        window_name: ev.window_name || null,
        element_role: ax?.role ?? null,
        element_name: ax?.text?.slice(0, 120) ?? null,
        locators: null,
        value: ev.text ? ev.text.slice(0, 300) : null,
        source: "screenpipe",
      });

      lastEventTs = evMs;
      ingested++;

      // Update session stats every 10 events
      if (ingested % 10 === 0) {
        updateSession(activeSessionId, {
          urls: [...activeSessionUrls],
          apps: [...activeSessionApps],
        });
      }
    }

    if (ingested > 0) {
      console.log(`[ingester] Ingested ${ingested} events`);
      if (activeSessionId !== null) {
        updateSession(activeSessionId, {
          urls: [...activeSessionUrls],
          apps: [...activeSessionApps],
          event_count: ingested,
        });
      }
    }

    setSetting(SETTING_KEY, until);
  } catch (err) {
    console.warn("[ingester] Poll error:", err);
  }
}

function closeAndFlush(): void {
  if (activeSessionId !== null) {
    updateSession(activeSessionId, {
      urls: [...activeSessionUrls],
      apps: [...activeSessionApps],
    });
    closeSession(activeSessionId);
    console.log(`[ingester] Session #${activeSessionId} closed`);
    activeSessionId = null;
    activeSessionUrls = new Set();
    activeSessionApps = new Set();
  }
}

function isExcluded(appName: string, excluded: string[]): boolean {
  const lower = appName.toLowerCase();
  return excluded.some((ex) => lower.includes(ex));
}

function isUsefulEvent(ev: InputEvent): boolean {
  // Skip pure scroll events — too noisy, not useful for behavior modeling
  if (ev.type === "scroll") return false;
  // Skip empty key events
  if (ev.type === "key" && !ev.text) return false;
  return true;
}

/**
 * Find the accessibility snapshot closest in time to the given event,
 * within a ±2s window, for the same app.
 */
function findNearestAx(
  sorted: Array<{ app_name: string; timestamp: string; text: string; role?: string }>,
  evMs: number,
  appName: string
): { text: string; role?: string } | null {
  let best: { text: string; role?: string } | null = null;
  let bestDelta = Infinity;
  for (const ax of sorted) {
    if (ax.app_name !== appName) continue;
    const delta = Math.abs(new Date(ax.timestamp).getTime() - evMs);
    if (delta < 2000 && delta < bestDelta) {
      best = ax;
      bestDelta = delta;
    }
  }
  return best;
}

function extractUrl(
  ev: InputEvent,
  ax: { text?: string; role?: string } | null
): string | null {
  // Screenpipe sometimes puts browser_url in the raw content blob
  const c = (ev.content ?? {}) as Record<string, unknown>;
  if (typeof c.browser_url === "string" && c.browser_url) return c.browser_url;
  return null;
}

/**
 * Accept a single raw event pushed from the browser recorder (has DOM locators).
 * Called by teachMode or sessionRecorder when operating on Ghostwork's Chrome.
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
    closeAndFlush();
  }

  if (activeSessionId === null) {
    activeSessionId = openSession(event.app);
    activeSessionUrls = new Set();
    activeSessionApps = new Set();
  }

  activeSessionApps.add(event.app);
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

  updateSession(activeSessionId, {
    urls: [...activeSessionUrls],
    apps: [...activeSessionApps],
  });
}
