/**
 * Direct read-only access to Screenpipe's local SQLite database.
 *
 * Screenpipe's REST API (/search?content_type=input) does NOT join ui_events
 * with frames, so app_name and window_title come back null. Querying the DB
 * directly with a JOIN gives us the full context: app name, window title,
 * browser URL, element name, element role, typed text, key codes.
 *
 * We open the DB in read-only mode — we never write to Screenpipe's DB.
 */

import Database from "better-sqlite3";
import * as os from "os";
import * as path from "path";
import * as fs from "fs";

const SCREENPIPE_DB = path.join(os.homedir(), ".screenpipe", "db.sqlite");

let _spDb: Database.Database | null = null;

function getSpDb(): Database.Database | null {
  if (_spDb) return _spDb;
  if (!fs.existsSync(SCREENPIPE_DB)) return null;
  try {
    _spDb = new Database(SCREENPIPE_DB, { readonly: true, fileMustExist: true });
    _spDb.pragma("journal_mode = WAL");
    return _spDb;
  } catch (err) {
    console.warn("[screenpipeDb] Could not open Screenpipe DB:", err);
    return null;
  }
}

export interface UiEvent {
  id: number;
  timestamp: string;
  event_type: string;        // click | key | scroll | app_switch | window_focus | clipboard | text
  app_name: string;          // COALESCE(ui_events.app_name, frames.app_name)
  window_name: string;       // COALESCE(ui_events.window_title, frames.window_name)
  browser_url: string | null;
  element_name: string | null;
  element_role: string | null;
  element_value: string | null;
  text_content: string | null;
  key_code: number | null;
  x: number | null;
  y: number | null;
}

const QUERY = `
  SELECT
    u.id,
    u.timestamp,
    u.event_type,
    COALESCE(u.app_name,    f.app_name)    AS app_name,
    COALESCE(u.window_title, f.window_name) AS window_name,
    COALESCE(u.browser_url, f.browser_url) AS browser_url,
    u.element_name,
    u.element_role,
    u.element_value,
    u.text_content,
    u.key_code,
    u.x,
    u.y
  FROM ui_events u
  LEFT JOIN frames f ON u.frame_id = f.id
  WHERE u.timestamp > ? AND u.timestamp <= ?
    AND u.event_type NOT IN ('move', 'scroll')
  ORDER BY u.timestamp ASC
  LIMIT ?
`;

// Structural AX container roles with no semantic meaning for behaviour capture.
const NOISY_ROLES = new Set([
  "AXScrollArea", "AXSplitGroup", "AXGroup", "AXApplication",
  "AXWindow", "AXSplitter", "AXUnknown", "AXGrowArea", "AXWebArea",
]);

// Apps to exclude from behaviour capture.
const EXCLUDED_APPS_LOWER = ["ghostwork", "electron", "cursor"];

function isUseful(ev: UiEvent): boolean {
  const app = (ev.app_name ?? "").toLowerCase();
  if (EXCLUDED_APPS_LOWER.some((ex) => app.includes(ex))) return false;
  // Keep if it has any meaningful context
  if (ev.text_content) return true;
  if (ev.element_name && !NOISY_ROLES.has(ev.element_role ?? "")) return true;
  if (ev.browser_url) return true;
  if (ev.app_name) return true;
  if (ev.key_code != null) return true;
  return false;
}

/**
 * Fetch UI events from Screenpipe's local DB for the given time range.
 * Returns events enriched with frame context (app name, window title, URL).
 */
export function queryUiEvents(
  sinceIso: string,
  untilIso: string,
  limit = 500
): UiEvent[] {
  const db = getSpDb();
  if (!db) return [];
  try {
    const rows = db.prepare(QUERY).all(sinceIso, untilIso, limit) as UiEvent[];
    return rows.filter(isUseful);
  } catch (err) {
    console.warn("[screenpipeDb] Query error:", err);
    return [];
  }
}

/**
 * Fetch recent OCR text entries — used for pattern extraction context.
 * Returns the app name, window, visible text, and timestamp.
 */
export function queryRecentOcr(
  sinceIso: string,
  untilIso: string,
  limit = 100
): Array<{ app_name: string; window_name: string; text: string; timestamp: string; browser_url: string | null }> {
  const db = getSpDb();
  if (!db) return [];
  try {
    return db.prepare(`
      SELECT o.app_name, o.window_name, o.text, f.timestamp, f.browser_url
      FROM ocr_text o
      JOIN frames f ON o.frame_id = f.id
      WHERE f.timestamp > ? AND f.timestamp <= ?
        AND o.text != ''
        AND o.app_name NOT IN ('Ghostwork','Electron','Cursor','')
      ORDER BY f.timestamp DESC
      LIMIT ?
    `).all(sinceIso, untilIso, limit) as Array<{
      app_name: string; window_name: string; text: string;
      timestamp: string; browser_url: string | null;
    }>;
  } catch (err) {
    console.warn("[screenpipeDb] OCR query error:", err);
    return [];
  }
}
