/**
 * Screenpipe client — wraps the local REST API at localhost:3030.
 * Never builds its own capture layer; all screen data comes from Screenpipe.
 */

const SCREENPIPE_BASE = "http://localhost:3030";

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
  content_type?: "ocr" | "audio" | "ui";
  query?: string;
  excluded_apps?: string[];
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

  const query = new URLSearchParams();
  if (rest.limit !== undefined) query.set("limit", String(rest.limit));
  if (rest.offset !== undefined) query.set("offset", String(rest.offset));
  if (rest.start_time) query.set("start_time", rest.start_time);
  if (rest.end_time) query.set("end_time", rest.end_time);
  if (rest.app_name) query.set("app_name", rest.app_name);
  if (rest.content_type) query.set("content_type", rest.content_type);
  if (rest.query) query.set("q", rest.query);

  const url = `${SCREENPIPE_BASE}/search?${query.toString()}`;

  const res = await fetch(url, {
    headers: authHeaders(),
    signal: AbortSignal.timeout(10000),
  });
  if (!res.ok) {
    throw new Error(`Screenpipe search failed: HTTP ${res.status}`);
  }

  const body: SearchResponse = await res.json();

  // Privacy: filter excluded apps at the query level before any data leaves
  if (excluded_apps.length > 0) {
    const lower = excluded_apps.map((a) => a.toLowerCase());
    body.data = body.data.filter((item) => {
      const name = (item.app_name ?? "").toLowerCase();
      return !lower.some((ex) => name.includes(ex));
    });
  }

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
