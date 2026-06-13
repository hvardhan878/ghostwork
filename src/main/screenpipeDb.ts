/**
 * Direct read-only access to Screenpipe's local SQLite database.
 *
 * Why direct DB access instead of the REST API?
 * - The REST /search?content_type=input endpoint does NOT join ui_events with
 *   frames, so app_name and window_title come back null.
 * - frames.full_text averages ~3.5 KB per frame — the REST API truncates this.
 * - elements has 1.5M rows of accessibility tree data unavailable via REST.
 * - audio_transcriptions has 5k+ rows the REST /search misses at our time windows.
 * - FTS5 virtual tables (frames_fts, ui_events_fts, elements_fts) give
 *   sub-millisecond keyword search over all captured content.
 *
 * We open Screenpipe's DB in WAL read-only mode — we never write to it.
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

// ─── Excluded apps ────────────────────────────────────────────────────────────

const EXCLUDED_APPS_LOWER = ["ghostwork", "electron", "cursor"];

function appIsExcluded(name: string | null): boolean {
  if (!name) return false;
  const lower = name.toLowerCase();
  return EXCLUDED_APPS_LOWER.some((ex) => lower.includes(ex));
}

// ─── Noisy AX roles with no semantic meaning ──────────────────────────────────

const NOISY_ROLES = new Set([
  "AXScrollArea", "AXSplitGroup", "AXGroup", "AXApplication",
  "AXWindow", "AXSplitter", "AXUnknown", "AXGrowArea", "AXWebArea",
  "AXGenericElement",
]);

// ─── UI Event (enriched) ─────────────────────────────────────────────────────

export interface UiEvent {
  id: number;
  timestamp: string;
  event_type: string;
  app_name: string;
  window_name: string;
  browser_url: string | null;
  /** Best available AX element label: element_name → element_description → null */
  element_name: string | null;
  element_role: string | null;
  element_value: string | null;
  text_content: string | null;
  key_code: number | null;
  x: number | null;
  y: number | null;
  /** First 200 chars of frame accessibility_text or full_text — what was on screen */
  frame_text: string | null;
  /** Screenpipe recording session UUID (per daemon launch, not per workflow) */
  screenpipe_session_id: string | null;
}

const ENRICHED_EVENT_QUERY = `
  SELECT
    u.id,
    u.timestamp,
    u.event_type,
    COALESCE(u.app_name,      f.app_name)    AS app_name,
    COALESCE(u.window_title,  f.window_name) AS window_name,
    COALESCE(u.browser_url,   f.browser_url) AS browser_url,
    COALESCE(u.element_name,  u.element_description) AS element_name,
    u.element_role,
    u.element_value,
    u.text_content,
    u.key_code,
    u.x,
    u.y,
    substr(COALESCE(f.accessibility_text, f.full_text, ''), 1, 200) AS frame_text,
    u.session_id AS screenpipe_session_id
  FROM ui_events u
  LEFT JOIN frames f ON u.frame_id = f.id
  WHERE u.timestamp > ? AND u.timestamp <= ?
    AND u.event_type NOT IN ('move', 'scroll')
  ORDER BY u.timestamp ASC
  LIMIT ?
`;

function isUseful(ev: UiEvent): boolean {
  if (appIsExcluded(ev.app_name)) return false;
  if (ev.text_content) return true;
  if (ev.element_name && !NOISY_ROLES.has(ev.element_role ?? "")) return true;
  if (ev.browser_url) return true;
  if (ev.app_name) return true;
  if (ev.key_code != null) return true;
  return false;
}

/**
 * Fetch UI events from Screenpipe's local DB, enriched with:
 * - Frame context (app name, window title, browser URL)
 * - AX element label (element_name → element_description fallback)
 * - Frame text snippet (first 200 chars of page accessibility text)
 */
export function queryUiEvents(
  sinceIso: string,
  untilIso: string,
  limit = 500
): UiEvent[] {
  const db = getSpDb();
  if (!db) return [];
  try {
    const rows = db.prepare(ENRICHED_EVENT_QUERY).all(sinceIso, untilIso, limit) as UiEvent[];
    return rows.filter(isUseful);
  } catch (err) {
    console.warn("[screenpipeDb] queryUiEvents error:", err);
    return [];
  }
}

// ─── Frame context ────────────────────────────────────────────────────────────

export interface FrameContext {
  frame_id: number;
  timestamp: string;
  app_name: string;
  window_name: string;
  browser_url: string | null;
  /** Full page text: accessibility tree text or OCR, up to 800 chars */
  text: string;
  capture_trigger: string | null;
}

/**
 * Get the most recent Screenpipe frame for the given app, within the last
 * `withinMinutes` minutes. Returns null when no recent frame exists.
 * Used by context.ts to replace the REST OCR call.
 */
export function getLatestFrameForApp(
  appName: string,
  withinMinutes = 3
): FrameContext | null {
  const db = getSpDb();
  if (!db) return null;
  try {
    return db.prepare(`
      SELECT
        f.id AS frame_id, f.timestamp, f.app_name, f.window_name, f.browser_url,
        f.capture_trigger,
        substr(COALESCE(f.full_text, f.accessibility_text, ''), 1, 800) AS text
      FROM frames f
      WHERE f.timestamp > datetime('now', '-' || ? || ' minutes')
        AND f.app_name = ?
      ORDER BY f.timestamp DESC
      LIMIT 1
    `).get(withinMinutes, appName) as FrameContext | null;
  } catch (err) {
    console.warn("[screenpipeDb] getLatestFrameForApp error:", err);
    return null;
  }
}

/**
 * Fetch recent frames with full page text for the extractor.
 * Uses full_text (accessibility tree + OCR merged) which averages ~3.5 KB/frame.
 */
export function queryRecentFrameTexts(
  sinceIso: string,
  untilIso: string,
  limit = 80
): Array<{
  app_name: string;
  window_name: string;
  browser_url: string | null;
  text: string;
  timestamp: string;
  capture_trigger: string | null;
}> {
  const db = getSpDb();
  if (!db) return [];
  try {
    return db.prepare(`
      SELECT
        f.app_name, f.window_name, f.browser_url,
        substr(COALESCE(f.full_text, f.accessibility_text, ''), 1, 1500) AS text,
        f.timestamp, f.capture_trigger
      FROM frames f
      WHERE f.timestamp > ? AND f.timestamp <= ?
        AND COALESCE(f.full_text, f.accessibility_text) IS NOT NULL
        AND length(COALESCE(f.full_text, f.accessibility_text)) > 100
        AND f.app_name NOT IN ('Ghostwork','Electron','Cursor','')
      ORDER BY f.timestamp DESC
      LIMIT ?
    `).all(sinceIso, untilIso, limit) as Array<{
      app_name: string; window_name: string; browser_url: string | null;
      text: string; timestamp: string; capture_trigger: string | null;
    }>;
  } catch (err) {
    console.warn("[screenpipeDb] queryRecentFrameTexts error:", err);
    return [];
  }
}

/**
 * Legacy OCR-only query — used as fallback when full_text is unavailable.
 */
export function queryRecentOcr(
  sinceIso: string,
  untilIso: string,
  limit = 100
): Array<{
  app_name: string;
  window_name: string;
  text: string;
  timestamp: string;
  browser_url: string | null;
}> {
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
    console.warn("[screenpipeDb] queryRecentOcr error:", err);
    return [];
  }
}

// ─── Audio transcriptions ─────────────────────────────────────────────────────

export interface AudioEntry {
  id: number;
  timestamp: string;
  transcription: string;
  device: string;
  is_input_device: boolean;
  speaker_name: string | null;
}

/**
 * Fetch audio transcriptions (what the user said or heard) for a time range.
 * Useful for adding spoken context to behavior extraction.
 */
export function queryAudioTranscriptions(
  sinceIso: string,
  untilIso: string,
  limit = 50
): AudioEntry[] {
  const db = getSpDb();
  if (!db) return [];
  try {
    return db.prepare(`
      SELECT
        a.id, a.timestamp, a.transcription, a.device, a.is_input_device,
        sp.name AS speaker_name
      FROM audio_transcriptions a
      LEFT JOIN speakers sp ON a.speaker_id = sp.id
      WHERE a.timestamp > ? AND a.timestamp <= ?
        AND a.transcription != ''
        AND length(a.transcription) > 5
        AND sp.hallucination IS NOT TRUE
      ORDER BY a.timestamp ASC
      LIMIT ?
    `).all(sinceIso, untilIso, limit) as AudioEntry[];
  } catch (err) {
    console.warn("[screenpipeDb] queryAudioTranscriptions error:", err);
    return [];
  }
}

// ─── FTS5 full-text search ────────────────────────────────────────────────────

export interface FtsResult {
  source: "frame" | "element" | "audio" | "ui_event";
  timestamp: string;
  app_name: string;
  text: string;
  browser_url: string | null;
}

/**
 * Fast keyword search across all of Screenpipe's FTS5 indexes.
 * Use this before calling an LLM to find specific content (e.g. "linkedin",
 * "email", "meeting notes") without burning tokens on irrelevant data.
 */
export function ftsSearch(
  query: string,
  sinceIso?: string,
  limit = 30
): FtsResult[] {
  const db = getSpDb();
  if (!db) return [];
  const results: FtsResult[] = [];
  const since = sinceIso ?? new Date(Date.now() - 7 * 86_400_000).toISOString();

  try {
    // Frames FTS (full page text, highest value)
    const frameRows = db.prepare(`
      SELECT f.timestamp, f.app_name, f.browser_url,
             substr(COALESCE(f.full_text, f.accessibility_text,''), 1, 300) AS text
      FROM frames_fts fts
      JOIN frames f ON fts.rowid = f.id
      WHERE frames_fts MATCH ?
        AND f.timestamp > ?
        AND f.app_name NOT IN ('Ghostwork','Electron','Cursor')
      ORDER BY rank
      LIMIT ?
    `).all(query, since, Math.ceil(limit * 0.6)) as Array<{
      timestamp: string; app_name: string; browser_url: string | null; text: string;
    }>;
    for (const r of frameRows) {
      results.push({ source: "frame", timestamp: r.timestamp, app_name: r.app_name, text: r.text, browser_url: r.browser_url });
    }

    // UI events FTS (typed text, element names)
    const uiRows = db.prepare(`
      SELECT u.timestamp, COALESCE(u.app_name, f.app_name, '') AS app_name,
             COALESCE(u.browser_url, f.browser_url) AS browser_url,
             COALESCE(u.text_content, u.element_name, '') AS text
      FROM ui_events_fts fts
      JOIN ui_events u ON fts.rowid = u.id
      LEFT JOIN frames f ON u.frame_id = f.id
      WHERE ui_events_fts MATCH ?
        AND u.timestamp > ?
      ORDER BY rank
      LIMIT ?
    `).all(query, since, Math.ceil(limit * 0.4)) as Array<{
      timestamp: string; app_name: string; browser_url: string | null; text: string;
    }>;
    for (const r of uiRows) {
      results.push({ source: "ui_event", timestamp: r.timestamp, app_name: r.app_name, text: r.text, browser_url: r.browser_url });
    }
  } catch (err) {
    console.warn("[screenpipeDb] ftsSearch error:", err);
  }

  return results.slice(0, limit);
}

// ─── Activity summary ─────────────────────────────────────────────────────────

export interface AppActivity {
  app_name: string;
  url_domain: string | null;
  event_count: number;
  first_seen: string;
  last_seen: string;
}

/**
 * Summarise which apps and sites the user was active on in a time range.
 * Used by NREM consolidation to describe session context to the LLM.
 */
export function queryAppActivity(
  sinceIso: string,
  untilIso: string
): AppActivity[] {
  const db = getSpDb();
  if (!db) return [];
  try {
    return db.prepare(`
      SELECT
        COALESCE(u.app_name, f.app_name, '') AS app_name,
        CASE
          WHEN COALESCE(u.browser_url, f.browser_url) IS NOT NULL
          THEN replace(replace(replace(
            substr(COALESCE(u.browser_url,f.browser_url), instr(COALESCE(u.browser_url,f.browser_url),'://')+3),
            'www.',''),
            substr(substr(COALESCE(u.browser_url,f.browser_url), instr(COALESCE(u.browser_url,f.browser_url),'://')+3),
              instr(substr(COALESCE(u.browser_url,f.browser_url), instr(COALESCE(u.browser_url,f.browser_url),'://')+3),'/')
            ),
            '')
          , '/', '')
          ELSE NULL
        END AS url_domain,
        COUNT(*) AS event_count,
        MIN(u.timestamp) AS first_seen,
        MAX(u.timestamp) AS last_seen
      FROM ui_events u
      LEFT JOIN frames f ON u.frame_id = f.id
      WHERE u.timestamp > ? AND u.timestamp <= ?
        AND COALESCE(u.app_name, f.app_name) NOT IN ('Ghostwork','Electron','Cursor','')
        AND u.event_type NOT IN ('move','scroll')
      GROUP BY app_name, url_domain
      ORDER BY event_count DESC
      LIMIT 30
    `).all(sinceIso, untilIso) as AppActivity[];
  } catch (err) {
    console.warn("[screenpipeDb] queryAppActivity error:", err);
    return [];
  }
}

// ─── Clipboard ────────────────────────────────────────────────────────────────

export interface ClipboardEntry {
  timestamp: string;
  text_content: string;
  app_name: string;
  browser_url: string | null;
}

/**
 * Fetch clipboard copy/paste events. These are high-signal: pasting a URL,
 * copying text from a doc, etc. tells us what the user was working on.
 */
export function queryClipboardEvents(
  sinceIso: string,
  untilIso: string,
  limit = 50
): ClipboardEntry[] {
  const db = getSpDb();
  if (!db) return [];
  try {
    return db.prepare(`
      SELECT
        u.timestamp,
        u.text_content,
        COALESCE(u.app_name, f.app_name, '') AS app_name,
        COALESCE(u.browser_url, f.browser_url) AS browser_url
      FROM ui_events u
      LEFT JOIN frames f ON u.frame_id = f.id
      WHERE u.timestamp > ? AND u.timestamp <= ?
        AND u.event_type = 'clipboard'
        AND u.text_content IS NOT NULL
        AND length(u.text_content) > 3
      ORDER BY u.timestamp ASC
      LIMIT ?
    `).all(sinceIso, untilIso, limit) as ClipboardEntry[];
  } catch (err) {
    console.warn("[screenpipeDb] queryClipboardEvents error:", err);
    return [];
  }
}

// ─── Meetings ─────────────────────────────────────────────────────────────────

export interface MeetingEntry {
  id: number;
  meeting_start: string;
  meeting_end: string | null;
  meeting_app: string;
  title: string | null;
  attendees: string | null;
  note: string | null;
}

export function queryMeetings(sinceIso: string, untilIso: string): MeetingEntry[] {
  const db = getSpDb();
  if (!db) return [];
  try {
    return db.prepare(`
      SELECT id, meeting_start, meeting_end, meeting_app, title, attendees, note
      FROM meetings
      WHERE meeting_start > ? AND meeting_start <= ?
      ORDER BY meeting_start DESC
      LIMIT 20
    `).all(sinceIso, untilIso) as MeetingEntry[];
  } catch (err) {
    return [];
  }
}

// ─── Enriched activity text (for LLM extraction) ─────────────────────────────

/**
 * Build a rich text blob describing the user's activity in a time window.
 * Combines: frame full_text + UI events (typed text, navigations) + audio + clipboard.
 * This replaces the thin OCR-only extractor input.
 *
 * Format is human-readable so the LLM can reason about it naturally.
 */
export function buildActivityText(
  sinceIso: string,
  untilIso: string,
  maxChars = 40_000
): string {
  const sections: string[] = [];

  // 1. Frame texts (richest signal — full page content)
  const frames = queryRecentFrameTexts(sinceIso, untilIso, 60);
  if (frames.length > 0) {
    const frameLines = frames.map((f) => {
      const loc = f.browser_url
        ? f.browser_url.replace(/^https?:\/\//, "").slice(0, 60)
        : f.window_name?.slice(0, 60) ?? "";
      return `[SCREEN ${f.timestamp.slice(11, 19)} ${f.app_name}${loc ? " @ " + loc : ""}]\n${f.text.slice(0, 800)}`;
    });
    sections.push("## Screen content\n" + frameLines.join("\n\n"));
  }

  // 2. Typed text & navigation events (intent signal)
  const events = queryUiEvents(sinceIso, untilIso, 300);
  const actionLines = events
    .filter((e) => e.text_content || (e.event_type === "click" && e.element_name))
    .map((e) => {
      const loc = e.browser_url?.replace(/^https?:\/\//, "").slice(0, 50) ?? e.window_name?.slice(0, 50) ?? e.app_name;
      if (e.text_content) return `${e.timestamp.slice(11, 19)} TYPE "${e.text_content}" @ ${loc}`;
      return `${e.timestamp.slice(11, 19)} CLICK "${e.element_name}" @ ${loc}`;
    });
  if (actionLines.length > 0) {
    sections.push("## User actions\n" + actionLines.join("\n"));
  }

  // 3. Audio transcriptions (what was said / heard)
  const audio = queryAudioTranscriptions(sinceIso, untilIso, 30);
  if (audio.length > 0) {
    const audioLines = audio.map((a) =>
      `${a.timestamp.slice(11, 19)} ${a.is_input_device ? "[MIC]" : "[AUDIO]"} ${a.transcription.slice(0, 150)}`
    );
    sections.push("## Audio\n" + audioLines.join("\n"));
  }

  // 4. Clipboard (high-signal: what was pasted/copied)
  const clips = queryClipboardEvents(sinceIso, untilIso, 20);
  if (clips.length > 0) {
    const clipLines = clips.map((c) =>
      `${c.timestamp.slice(11, 19)} CLIPBOARD "${c.text_content.slice(0, 100)}" in ${c.app_name}`
    );
    sections.push("## Clipboard\n" + clipLines.join("\n"));
  }

  return sections.join("\n\n").slice(0, maxChars);
}

// ─── Idle-gap session builder ─────────────────────────────────────────────────
// Groups raw ui_events into logical work sessions by detecting idle gaps.
// This is more meaningful than Screenpipe's session_id (which is per daemon
// launch and can contain 12k+ events spanning days).

const IDLE_GAP_MS = 5 * 60 * 1000; // 5 min without input = new session

export interface SpSession {
  /** Virtual session ID: first event's ISO timestamp */
  id: string;
  started_at: string;
  ended_at: string;
  duration_min: number;
  event_count: number;
  /** Primary app (most events) */
  dominant_app: string;
  apps: string[];
  urls: string[];
  /** Representative activity description */
  summary: string;
}

export interface SpSessionEvent {
  id: number;
  timestamp: string;
  event_type: string;
  app_name: string;
  window_name: string;
  browser_url: string | null;
  element_name: string | null;
  element_role: string | null;
  text_content: string | null;
  key_code: number | null;
  frame_text: string | null;
}

/**
 * Build idle-gap sessions from Screenpipe's ui_events for the last N days.
 * Returns sessions sorted newest-first, each with app/URL context.
 */
export function buildScreenpipeSessions(days = 7, maxSessions = 50): SpSession[] {
  const db = getSpDb();
  if (!db) return [];

  const since = new Date(Date.now() - days * 86_400_000).toISOString();
  let rows: UiEvent[];
  try {
    rows = db.prepare(`
      SELECT
        u.id,
        u.timestamp,
        u.event_type,
        COALESCE(u.app_name,      f.app_name)    AS app_name,
        COALESCE(u.window_title,  f.window_name) AS window_name,
        COALESCE(u.browser_url,   f.browser_url) AS browser_url,
        COALESCE(u.element_name,  u.element_description) AS element_name,
        u.element_role,
        u.element_value,
        u.text_content,
        u.key_code,
        u.x, u.y,
        substr(COALESCE(f.accessibility_text, f.full_text, ''), 1, 120) AS frame_text,
        u.session_id AS screenpipe_session_id
      FROM ui_events u
      LEFT JOIN frames f ON u.frame_id = f.id
      WHERE u.timestamp > ?
        AND u.event_type NOT IN ('move', 'scroll')
        AND COALESCE(u.app_name, f.app_name, '') NOT IN ('Ghostwork','Electron','Cursor','')
      ORDER BY u.timestamp ASC
      LIMIT 50000
    `).all(since) as UiEvent[];
  } catch (err) {
    console.warn("[screenpipeDb] buildScreenpipeSessions query error:", err);
    return [];
  }

  if (rows.length === 0) return [];

  // Stitch into sessions by idle gap
  const sessions: SpSession[] = [];
  let sessionEvents: UiEvent[] = [];

  const flush = () => {
    if (sessionEvents.length < 3) return;
    const apps = new Map<string, number>();
    const urls = new Set<string>();
    for (const ev of sessionEvents) {
      if (ev.app_name) apps.set(ev.app_name, (apps.get(ev.app_name) ?? 0) + 1);
      if (ev.browser_url) {
        // Store just the hostname/path to de-noise
        try {
          const u = new URL(ev.browser_url);
          urls.add(u.hostname.replace(/^www\./, "") + u.pathname.slice(0, 50));
        } catch {
          urls.add(ev.browser_url.slice(0, 80));
        }
      }
    }
    const dominantApp = [...apps.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? "unknown";
    const started = sessionEvents[0].timestamp;
    const ended = sessionEvents[sessionEvents.length - 1].timestamp;
    const durationMin = Math.round((new Date(ended).getTime() - new Date(started).getTime()) / 60_000);

    // Build a short human summary from the most-visited URLs + typed text
    const typedTexts = sessionEvents
      .filter((e) => e.text_content && e.text_content.length > 3)
      .map((e) => `"${e.text_content!.slice(0, 40)}"`)
      .slice(0, 3);
    const topUrls = [...urls].slice(0, 3).map((u) => u.split("/")[0]);
    const summaryParts: string[] = [];
    if (topUrls.length > 0) summaryParts.push(topUrls.join(", "));
    if (typedTexts.length > 0) summaryParts.push(`typed: ${typedTexts.join(", ")}`);
    const summary = summaryParts.join(" · ") || dominantApp;

    sessions.push({
      id: started,
      started_at: started,
      ended_at: ended,
      duration_min: durationMin,
      event_count: sessionEvents.length,
      dominant_app: dominantApp,
      apps: [...apps.keys()].slice(0, 8),
      urls: [...urls].slice(0, 15),
      summary,
    });
  };

  let prevMs = 0;
  for (const row of rows) {
    const ms = new Date(row.timestamp).getTime();
    if (prevMs > 0 && ms - prevMs > IDLE_GAP_MS) {
      flush();
      sessionEvents = [];
    }
    sessionEvents.push(row);
    prevMs = ms;
  }
  flush();

  // Newest first, capped
  return sessions.reverse().slice(0, maxSessions);
}

/**
 * Fetch enriched events for a given session identified by its start timestamp.
 * Looks for all events in [startedAt, endedAt] from Screenpipe DB.
 */
export function getScreenpipeSessionEvents(
  startedAt: string,
  endedAt: string,
  limit = 500
): SpSessionEvent[] {
  const db = getSpDb();
  if (!db) return [];
  try {
    return db.prepare(`
      SELECT
        u.id,
        u.timestamp,
        u.event_type,
        COALESCE(u.app_name,     f.app_name)    AS app_name,
        COALESCE(u.window_title, f.window_name) AS window_name,
        COALESCE(u.browser_url,  f.browser_url) AS browser_url,
        COALESCE(u.element_name, u.element_description) AS element_name,
        u.element_role,
        u.text_content,
        u.key_code,
        substr(COALESCE(f.accessibility_text, f.full_text, ''), 1, 200) AS frame_text
      FROM ui_events u
      LEFT JOIN frames f ON u.frame_id = f.id
      WHERE u.timestamp >= ? AND u.timestamp <= ?
        AND u.event_type NOT IN ('move', 'scroll')
      ORDER BY u.timestamp ASC
      LIMIT ?
    `).all(startedAt, endedAt, limit) as SpSessionEvent[];
  } catch (err) {
    console.warn("[screenpipeDb] getScreenpipeSessionEvents error:", err);
    return [];
  }
}
