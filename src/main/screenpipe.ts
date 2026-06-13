/**
 * Screenpipe client — wraps the local REST API at localhost:3030.
 * Never builds its own capture layer; all screen data comes from Screenpipe.
 *
 * Screenpipe captures three streams:
 *   vision/ocr  — what is visible on screen (text via AX tree + OCR fallback)
 *   input       — every click, keystroke, app switch, clipboard, scroll
 *   accessibility — UI element tree snapshots (buttons, fields, labels)
 */

const SCREENPIPE_BASE = "http://localhost:3030";
const DEFAULT_EXCLUDED_APPS = ["Cursor", "Electron", "Ghostwork"];

// Auth token — populated by the manager after launch
let _authToken: string | null = null;

export function setScreenpipeAuthToken(token: string): void {
  _authToken = token;
}

function authHeaders(): Record<string, string> {
  if (_authToken) {
    return { Authorization: `Bearer ${_authToken}` };
  }
  return {};
}

export interface ScreenpipeHealth {
  status: "ok" | "error";
  message: string;
  timestamp: string;
}

export interface ContentItem {
  type: "OCR" | "Audio" | "UI";
  content: Record<string, unknown>;
  timestamp: string;
  app_name?: string;
  window_name?: string;
  text?: string;
  focused?: boolean;
}

export function normalizeContentItem(item: any): any {
  const c = item.content ?? {};
  return {
    ...item,
    app_name: c.app_name ?? item.app_name ?? "",
    window_name: c.window_name ?? item.window_name ?? "",
    timestamp: c.timestamp ?? item.timestamp ?? "",
    text: c.text ?? item.text ?? "",
    focused: c.focused ?? item.focused ?? false,
    content: item.content,
  };
}

export interface SearchResponse {
  data: ContentItem[];
  pagination: {
    limit: number;
    offset: number;
    total: number;
  };
}

export interface SearchParams {
  limit?: number;
  offset?: number;
  start_time?: string;
  end_time?: string;
  app_name?: string;
  content_type?: "ocr" | "audio" | "ui" | "input" | "accessibility" | "all";
  query?: string;
  browser_url?: string;
  excluded_apps?: string[];
}

// ─── Input event types (content_type=input) ──────────────────────────────────

export type InputEventType =
  | "click"
  | "key"
  | "app_switch"
  | "window_focus"
  | "clipboard"
  | "scroll";

export interface InputEvent {
  type: InputEventType;
  app_name: string;
  window_name: string;
  timestamp: string;
  /** Typed text, clipboard content, or key name */
  text?: string;
  /** Mouse click X coordinate */
  x?: number;
  /** Mouse click Y coordinate */
  y?: number;
  /** Raw content blob from Screenpipe */
  content?: Record<string, unknown>;
}

// ─── Accessibility event types (content_type=accessibility) ──────────────────

export interface AccessibilityEvent {
  app_name: string;
  window_name: string;
  timestamp: string;
  /** Visible text from the element or its label */
  text: string;
  /** ARIA/AX role e.g. button, textfield, link */
  role?: string;
  /** Browser URL if captured inside a browser */
  browser_url?: string;
  content?: Record<string, unknown>;
}

/** Check whether Screenpipe is reachable */
export async function checkHealth(): Promise<ScreenpipeHealth> {
  try {
    const res = await fetch(`${SCREENPIPE_BASE}/health`, {
      headers: authHeaders(),
      signal: AbortSignal.timeout(3000),
    });
    if (!res.ok) {
      return {
        status: "error",
        message: `HTTP ${res.status}`,
        timestamp: new Date().toISOString(),
      };
    }
    const body = await res.json();
    return {
      status: "ok",
      message: JSON.stringify(body),
      timestamp: new Date().toISOString(),
    };
  } catch (err) {
    return {
      status: "error",
      message: err instanceof Error ? err.message : String(err),
      timestamp: new Date().toISOString(),
    };
  }
}

/**
 * Query Screenpipe's /search endpoint.
 * Filters out excluded apps before returning.
 */
export async function searchContent(
  params: SearchParams = {}
): Promise<SearchResponse> {
  const { excluded_apps = [], ...rest } = params;
  const effectiveExcludedApps = [...DEFAULT_EXCLUDED_APPS, ...excluded_apps];

  const query = new URLSearchParams();
  if (rest.limit !== undefined) query.set("limit", String(rest.limit));
  if (rest.offset !== undefined) query.set("offset", String(rest.offset));
  if (rest.start_time) query.set("start_time", rest.start_time);
  if (rest.end_time) query.set("end_time", rest.end_time);
  if (rest.app_name) query.set("app_name", rest.app_name);
  if (rest.content_type) query.set("content_type", rest.content_type);
  if (rest.query) query.set("q", rest.query);
  if (rest.browser_url) query.set("browser_url", rest.browser_url);

  const url = `${SCREENPIPE_BASE}/search?${query.toString()}`;

  let res = await fetch(url, {
    headers: authHeaders(),
    signal: AbortSignal.timeout(10000),
  });

  // Auth token injection is async at boot — retry once after a short wait
  // if we get 401/403 so the race between ensureRunning() and the first
  // extraction job doesn't permanently fail the boot extraction.
  if (res.status === 401 || res.status === 403) {
    await new Promise<void>((r) => setTimeout(r, 5000));
    res = await fetch(url, {
      headers: authHeaders(),
      signal: AbortSignal.timeout(10000),
    });
  }

  if (!res.ok) {
    throw new Error(`Screenpipe search failed: HTTP ${res.status}`);
  }

  const body: SearchResponse = await res.json();

  let items = body.data.map(normalizeContentItem);

  // Privacy: filter excluded apps after normalization (case-insensitive substring)
  if (effectiveExcludedApps.length > 0) {
    const lowerExcluded = effectiveExcludedApps.map((a) => a.toLowerCase());
    items = items.filter((i) => {
      const name = (i.app_name ?? "").toLowerCase();
      return !lowerExcluded.some((ex) => name.includes(ex));
    });
  }

  body.data = items;

  return body;
}

/**
 * Fetch the last `hours` hours of activity, respecting excluded apps.
 * Used by the hourly extraction job.
 */
export async function getRecentActivity(
  hours: number = 1,
  excludedApps: string[] = [],
  limit: number = 100
): Promise<ContentItem[]> {
  const end = new Date();
  const start = new Date(end.getTime() - hours * 60 * 60 * 1000);

  const result = await searchContent({
    start_time: start.toISOString(),
    end_time: end.toISOString(),
    limit,
    excluded_apps: excludedApps,
  });

  return result.data;
}

/**
 * Fetch input events (clicks, keystrokes, app switches, clipboard, scrolls)
 * from Screenpipe for the given time window. These are the raw interaction
 * events that form the episodic memory layer.
 */
export async function getInputEvents(
  sinceIso: string,
  untilIso: string,
  appName?: string,
  limit = 300
): Promise<InputEvent[]> {
  try {
    const result = await searchContent({
      content_type: "input",
      start_time: sinceIso,
      end_time: untilIso,
      app_name: appName,
      limit,
    });

    return result.data.map((item) => {
      const c = (item.content ?? {}) as Record<string, unknown>;
      const type = (
        (c.event_type ?? c.type ?? item.type ?? "key") as string
      ).toLowerCase() as InputEventType;

      return {
        type: normaliseInputType(type),
        app_name: item.app_name ?? "",
        window_name: item.window_name ?? "",
        timestamp: item.timestamp,
        text: (c.text ?? c.key_char ?? item.text ?? "") as string | undefined,
        x: c.x as number | undefined,
        y: c.y as number | undefined,
        content: item.content,
      };
    });
  } catch {
    return [];
  }
}

function normaliseInputType(raw: string): InputEventType {
  if (raw.includes("click")) return "click";
  if (raw.includes("key")) return "key";
  if (raw.includes("app")) return "app_switch";
  if (raw.includes("focus")) return "window_focus";
  if (raw.includes("clip")) return "clipboard";
  if (raw.includes("scroll")) return "scroll";
  return "key";
}

/**
 * Fetch accessibility tree events — UI element snapshots (buttons, labels,
 * fields) captured by Screenpipe's accessibility layer for the given window.
 */
export async function getAccessibilityEvents(
  sinceIso: string,
  untilIso: string,
  appName?: string,
  limit = 100
): Promise<AccessibilityEvent[]> {
  try {
    const result = await searchContent({
      content_type: "accessibility",
      start_time: sinceIso,
      end_time: untilIso,
      app_name: appName,
      limit,
    });

    return result.data.map((item) => {
      const c = (item.content ?? {}) as Record<string, unknown>;
      return {
        app_name: item.app_name ?? "",
        window_name: item.window_name ?? "",
        timestamp: item.timestamp,
        text: (c.text ?? item.text ?? "") as string,
        role: c.role as string | undefined,
        browser_url: c.browser_url as string | undefined,
        content: item.content,
      };
    });
  } catch {
    return [];
  }
}
