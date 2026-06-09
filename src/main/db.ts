/**
 * SQLite behaviour model — the local brain of Ghostwork.
 * Three tables: workflows, rules, corrections.
 * All data stays on-device; no cloud sync, no telemetry.
 */

import Database from "better-sqlite3";
import * as path from "path";
import { app } from "electron";

let _db: Database.Database | null = null;

function dbPath(): string {
  return path.join(app.getPath("userData"), "ghostwork.db");
}

export function getDb(): Database.Database {
  if (_db) return _db;
  _db = new Database(dbPath());
  _db.pragma("journal_mode = WAL");
  _db.pragma("foreign_keys = ON");
  migrate(_db);
  return _db;
}

function migrate(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS workflows (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      name          TEXT    NOT NULL,
      description   TEXT    NOT NULL DEFAULT '',
      step_sequence TEXT    NOT NULL DEFAULT '[]',   -- JSON array of step strings
      confidence    REAL    NOT NULL DEFAULT 0.0,
      observed_count INTEGER NOT NULL DEFAULT 1,
      last_seen     TEXT    NOT NULL DEFAULT (datetime('now')),
      pinned        INTEGER NOT NULL DEFAULT 0,
      created_at    TEXT    NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS rules (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      workflow_id     INTEGER NOT NULL REFERENCES workflows(id) ON DELETE CASCADE,
      condition       TEXT    NOT NULL,
      action          TEXT    NOT NULL,
      confidence      REAL    NOT NULL DEFAULT 0.0,
      observed_count  INTEGER NOT NULL DEFAULT 1,
      correction_count INTEGER NOT NULL DEFAULT 0,
      last_triggered  TEXT,
      created_at      TEXT    NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS corrections (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      rule_id         INTEGER NOT NULL REFERENCES rules(id) ON DELETE CASCADE,
      expected_action TEXT    NOT NULL,
      actual_action   TEXT    NOT NULL,
      timestamp       TEXT    NOT NULL DEFAULT (datetime('now')),
      user_note       TEXT    NOT NULL DEFAULT ''
    );

    CREATE TABLE IF NOT EXISTS activity_log (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      timestamp     TEXT    NOT NULL DEFAULT (datetime('now')),
      workflow_name TEXT    NOT NULL DEFAULT '',
      rule_id       INTEGER REFERENCES rules(id) ON DELETE SET NULL,
      action_taken  TEXT    NOT NULL,
      confidence    REAL    NOT NULL DEFAULT 0.0,
      tier          TEXT    NOT NULL DEFAULT 'suggest',  -- suggest | supervised | autonomous
      status        TEXT    NOT NULL DEFAULT 'pending',  -- pending | accepted | rejected | undone | silent
      user_note     TEXT    NOT NULL DEFAULT ''
    );

    CREATE TABLE IF NOT EXISTS settings (
      key   TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_rules_workflow ON rules(workflow_id);
    CREATE INDEX IF NOT EXISTS idx_corrections_rule ON corrections(rule_id);
    CREATE INDEX IF NOT EXISTS idx_activity_ts ON activity_log(timestamp DESC);
  `);
}

// ─── Workflows ────────────────────────────────────────────────────────────────

export interface Workflow {
  id: number;
  name: string;
  description: string;
  step_sequence: string[];
  confidence: number;
  observed_count: number;
  last_seen: string;
  pinned: boolean;
  created_at: string;
}

export interface WorkflowRow {
  id: number;
  name: string;
  description: string;
  step_sequence: string;
  confidence: number;
  observed_count: number;
  last_seen: string;
  pinned: number;
  created_at: string;
}

function rowToWorkflow(row: WorkflowRow): Workflow {
  return {
    ...row,
    step_sequence: JSON.parse(row.step_sequence) as string[],
    pinned: row.pinned === 1,
  };
}

export function upsertWorkflow(
  name: string,
  description: string,
  steps: string[],
  confidence: number
): Workflow {
  const db = getDb();
  const existing = db
    .prepare("SELECT * FROM workflows WHERE name = ?")
    .get(name) as WorkflowRow | undefined;

  if (existing) {
    const newCount = existing.observed_count + 1;
    const newConf = Math.min(
      1.0,
      existing.confidence + (confidence - existing.confidence) * 0.3
    );
    db.prepare(`
      UPDATE workflows SET
        description = ?, step_sequence = ?, confidence = ?,
        observed_count = ?, last_seen = datetime('now')
      WHERE id = ?
    `).run(description, JSON.stringify(steps), newConf, newCount, existing.id);
    return rowToWorkflow(
      db.prepare("SELECT * FROM workflows WHERE id = ?").get(existing.id) as WorkflowRow
    );
  }

  const info = db.prepare(`
    INSERT INTO workflows (name, description, step_sequence, confidence)
    VALUES (?, ?, ?, ?)
  `).run(name, description, JSON.stringify(steps), confidence);

  return rowToWorkflow(
    db.prepare("SELECT * FROM workflows WHERE id = ?").get(info.lastInsertRowid) as WorkflowRow
  );
}

export function getAllWorkflows(): Workflow[] {
  const rows = getDb()
    .prepare("SELECT * FROM workflows ORDER BY confidence DESC, last_seen DESC")
    .all() as WorkflowRow[];
  return rows.map(rowToWorkflow);
}

export function deleteWorkflow(id: number): void {
  getDb().prepare("DELETE FROM workflows WHERE id = ?").run(id);
}

export function updateWorkflowDescription(id: number, description: string): void {
  getDb()
    .prepare("UPDATE workflows SET description = ? WHERE id = ?")
    .run(description, id);
}

export function pinWorkflow(id: number, pinned: boolean): void {
  getDb()
    .prepare("UPDATE workflows SET pinned = ? WHERE id = ?")
    .run(pinned ? 1 : 0, id);
}

// ─── Rules ───────────────────────────────────────────────────────────────────

export interface Rule {
  id: number;
  workflow_id: number;
  condition: string;
  action: string;
  confidence: number;
  observed_count: number;
  correction_count: number;
  last_triggered: string | null;
  created_at: string;
}

export function upsertRule(
  workflowId: number,
  condition: string,
  action: string,
  confidence: number
): Rule {
  const db = getDb();
  const existing = db.prepare(`
    SELECT * FROM rules WHERE workflow_id = ? AND condition = ? AND action = ?
  `).get(workflowId, condition, action) as Rule | undefined;

  if (existing) {
    const newCount = existing.observed_count + 1;
    const newConf = Math.min(
      1.0,
      existing.confidence + (confidence - existing.confidence) * 0.3
    );
    db.prepare(`
      UPDATE rules SET confidence = ?, observed_count = ? WHERE id = ?
    `).run(newConf, newCount, existing.id);
    return db.prepare("SELECT * FROM rules WHERE id = ?").get(existing.id) as Rule;
  }

  const info = db.prepare(`
    INSERT INTO rules (workflow_id, condition, action, confidence)
    VALUES (?, ?, ?, ?)
  `).run(workflowId, condition, action, confidence);

  return db.prepare("SELECT * FROM rules WHERE id = ?").get(info.lastInsertRowid) as Rule;
}

export function getRulesForWorkflow(workflowId: number): Rule[] {
  return getDb()
    .prepare("SELECT * FROM rules WHERE workflow_id = ? ORDER BY confidence DESC")
    .all(workflowId) as Rule[];
}

export function getAllRules(): Rule[] {
  return getDb()
    .prepare("SELECT * FROM rules ORDER BY confidence DESC")
    .all() as Rule[];
}

export function recordCorrection(
  ruleId: number,
  expectedAction: string,
  actualAction: string,
  userNote = ""
): void {
  const db = getDb();
  db.prepare(`
    INSERT INTO corrections (rule_id, expected_action, actual_action, user_note)
    VALUES (?, ?, ?, ?)
  `).run(ruleId, expectedAction, actualAction, userNote);

  db.prepare(`
    UPDATE rules SET
      correction_count = correction_count + 1,
      confidence = MAX(0.0, confidence - 0.15)
    WHERE id = ?
  `).run(ruleId);
}

export function acceptRule(ruleId: number): void {
  getDb().prepare(`
    UPDATE rules SET
      confidence = MIN(1.0, confidence + 0.05),
      last_triggered = datetime('now')
    WHERE id = ?
  `).run(ruleId);
}

export function deleteRule(id: number): void {
  getDb().prepare("DELETE FROM rules WHERE id = ?").run(id);
}

export function updateRuleCondition(id: number, condition: string): void {
  getDb().prepare("UPDATE rules SET condition = ? WHERE id = ?").run(condition, id);
}

// ─── Activity log ─────────────────────────────────────────────────────────────

export type ConfidenceTier = "suggest" | "supervised" | "autonomous";
export type ActivityStatus = "pending" | "accepted" | "rejected" | "undone" | "silent";

export interface ActivityEntry {
  id: number;
  timestamp: string;
  workflow_name: string;
  rule_id: number | null;
  action_taken: string;
  confidence: number;
  tier: ConfidenceTier;
  status: ActivityStatus;
  user_note: string;
}

export function logActivity(
  workflowName: string,
  actionTaken: string,
  confidence: number,
  tier: ConfidenceTier,
  status: ActivityStatus = "pending",
  ruleId?: number
): number {
  const info = getDb().prepare(`
    INSERT INTO activity_log (workflow_name, action_taken, confidence, tier, status, rule_id)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(workflowName, actionTaken, confidence, tier, status, ruleId ?? null);
  return info.lastInsertRowid as number;
}

export function updateActivityStatus(id: number, status: ActivityStatus): void {
  getDb()
    .prepare("UPDATE activity_log SET status = ? WHERE id = ?")
    .run(status, id);
}

export function updateActivitySteps(id: number, steps: string[]): void {
  getDb()
    .prepare("UPDATE activity_log SET user_note = ? WHERE id = ?")
    .run(JSON.stringify({ demo: false, steps }), id);
}

export function getRecentActivityLog(limit = 100): ActivityEntry[] {
  return getDb().prepare(`
    SELECT * FROM activity_log ORDER BY timestamp DESC LIMIT ?
  `).all(limit) as ActivityEntry[];
}

// ─── Settings ─────────────────────────────────────────────────────────────────

export function getSetting(key: string, fallback = ""): string {
  const row = getDb()
    .prepare("SELECT value FROM settings WHERE key = ?")
    .get(key) as { value: string } | undefined;
  return row?.value ?? fallback;
}

export function setSetting(key: string, value: string): void {
  getDb().prepare(`
    INSERT INTO settings (key, value) VALUES (?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value
  `).run(key, value);
}

export function getAllSettings(): Record<string, string> {
  const rows = getDb()
    .prepare("SELECT key, value FROM settings")
    .all() as { key: string; value: string }[];
  return Object.fromEntries(rows.map((r) => [r.key, r.value]));
}

// ─── Model export ─────────────────────────────────────────────────────────────

export function exportModel(): object {
  const workflows = getAllWorkflows();
  const rules = getAllRules();
  return {
    exported_at: new Date().toISOString(),
    workflows,
    rules,
  };
}

/** Wipe everything — user-facing "reset" button. */
export function wipeModel(): void {
  const db = getDb();
  db.exec(`
    DELETE FROM corrections;
    DELETE FROM activity_log;
    DELETE FROM rules;
    DELETE FROM workflows;
  `);
  console.log("[db] Behaviour model wiped.");
}

// ─── Consolidation helpers ────────────────────────────────────────────────────

/** Promote rules with >10 observations and >0.8 confidence. */
export function promoteHighConfidenceRules(): number {
  const result = getDb().prepare(`
    UPDATE rules SET confidence = MIN(1.0, confidence + 0.02)
    WHERE observed_count > 10 AND confidence > 0.8 AND correction_count = 0
  `).run();
  return result.changes;
}

/** Demote rules with >3 corrections in the last 7 days. */
export function demoteFrequentlyCorrectRules(): number {
  const result = getDb().prepare(`
    UPDATE rules SET confidence = MAX(0.0, confidence - 0.2)
    WHERE id IN (
      SELECT rule_id FROM corrections
      WHERE timestamp > datetime('now', '-7 days')
      GROUP BY rule_id
      HAVING COUNT(*) > 3
    )
  `).run();
  return result.changes;
}

/** Delete rules with 0 observations in 30 days. */
export function pruneStaleRules(): number {
  const result = getDb().prepare(`
    DELETE FROM rules
    WHERE last_triggered < datetime('now', '-30 days')
      AND observed_count = 0
  `).run();
  return result.changes;
}
