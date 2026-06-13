/**
 * Perception layer — answers "what is the user doing right now?"
 *
 * Combines:
 *   - Frontmost app via AppleScript (always accurate, instant)
 *   - Active browser tab title + URL via AppleScript (fastest for live tab)
 *   - Latest Screenpipe frame text from DB (replaces REST OCR — ~3.5 KB of
 *     full page accessibility + OCR text vs the sparse REST response)
 */

import { execFile } from "child_process";
import { getLatestFrameForApp } from "./screenpipeDb";

export interface UserContext {
  app: string;
  windowTitle: string;
  url: string;
  ocrText: string;
  timestamp: number;
}

const BROWSER_APPS: Record<string, "chromium" | "safari"> = {
  "google chrome": "chromium",
  "brave browser": "chromium",
  "microsoft edge": "chromium",
  "arc": "chromium",
  "safari": "safari",
};

function osascript(script: string, timeoutMs = 3000): Promise<string> {
  return new Promise((resolve) => {
    execFile(
      "osascript",
      ["-e", script],
      { timeout: timeoutMs },
      (err, stdout) => {
        resolve(err ? "" : stdout.trim());
      }
    );
  });
}

async function getFrontmostApp(): Promise<string> {
  return osascript(
    'tell application "System Events" to get name of first application process whose frontmost is true'
  );
}

async function getBrowserTab(
  app: string
): Promise<{ title: string; url: string }> {
  const kind = BROWSER_APPS[app.toLowerCase()];
  if (!kind) return { title: "", url: "" };

  const script =
    kind === "safari"
      ? `tell application "Safari" to get (name of current tab of front window) & "\n" & (URL of current tab of front window)`
      : `tell application "${app}" to get (title of active tab of front window) & "\n" & (URL of active tab of front window)`;

  const out = await osascript(script);
  if (!out) return { title: "", url: "" };
  const [title = "", url = ""] = out.split("\n");
  return { title: title.trim(), url: url.trim() };
}

/**
 * Build the current user context. AppleScript gives the authoritative
 * app/tab; Screenpipe OCR (if any) is appended as supplementary text.
 */
export async function getCurrentContext(
  excludedApps: string[] = []
): Promise<UserContext | null> {
  const app = await getFrontmostApp();
  if (!app) return null;

  const lowerApp = app.toLowerCase();
  if (excludedApps.some((ex) => lowerApp.includes(ex.toLowerCase()))) {
    return null;
  }

  const { title, url } = await getBrowserTab(app);

  // Screenpipe frame full_text — much richer than the REST OCR endpoint.
  // Tries exact app name first, then a broader 5-minute window for near-matches.
  let ocrText = "";
  try {
    const frame = getLatestFrameForApp(app, 3) ?? getLatestFrameForApp(app, 5);
    if (frame?.text) {
      ocrText = frame.text;
    }
  } catch {
    // Screenpipe DB unavailable — context still useful without OCR.
  }

  return {
    app,
    windowTitle: title || "",
    url,
    ocrText,
    timestamp: Date.now(),
  };
}

function urlDomain(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return "";
  }
}

/**
 * Stable key for "meaningful context". Changes when the user switches app,
 * site, or page — not when OCR text fluctuates.
 */
export function contextKey(ctx: UserContext): string {
  const domain = urlDomain(ctx.url);
  // Normalise the title lightly so minor dynamic suffixes don't churn the key.
  const title = ctx.windowTitle.toLowerCase().replace(/\s+/g, " ").slice(0, 60);
  return `${ctx.app.toLowerCase()}|${domain}|${title}`;
}

/** Human-readable one-liner for logs. */
export function describeContext(ctx: UserContext): string {
  const parts = [ctx.app];
  if (ctx.url) parts.push(urlDomain(ctx.url) || ctx.url);
  if (ctx.windowTitle) parts.push(`"${ctx.windowTitle.slice(0, 50)}"`);
  return parts.join(" — ");
}
