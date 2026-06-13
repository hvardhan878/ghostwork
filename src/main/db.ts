/**
 * SQLite behaviour model — the local brain of Ghostwork.
 * Three tables: workflows, rules, corrections.
 * All data stays on-device; no cloud sync, no telemetry.
 */

import Database from "better-sqlite3";
import * as path from "path";
import { app } from "electron";
import type { RankedLocator } from "./browserDriver";

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

// Safe column adder — silently ignores "duplicate column" errors on re-migration.
function safeAddColumn(
  db: Database.Database,
  table: string,
  column: string,
  definition: string
): void {
  try {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  } catch {
    // Column already exists — no-op.
  }
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

    -- Compiled skills: deterministic, replayable workflows with ranked locators.
    CREATE TABLE IF NOT EXISTS skills (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      rule_id       INTEGER REFERENCES rules(id) ON DELETE SET NULL,
      name          TEXT    NOT NULL,
      source        TEXT    NOT NULL DEFAULT 'compiled',   -- compiled | taught
      trigger_type  TEXT    NOT NULL DEFAULT 'context',    -- context | schedule | manual
      trigger_value TEXT    NOT NULL DEFAULT '',           -- cron expression for schedule
      steps         TEXT    NOT NULL DEFAULT '[]',         -- JSON SkillStep[]
      run_count     INTEGER NOT NULL DEFAULT 0,
      success_count INTEGER NOT NULL DEFAULT 0,
      last_run_at   TEXT,
      created_at    TEXT    NOT NULL DEFAULT (datetime('now'))
    );

    -- Audit log: every skill execution, step by step.
    CREATE TABLE IF NOT EXISTS skill_runs (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      skill_id    INTEGER REFERENCES skills(id) ON DELETE CASCADE,
      started_at  TEXT    NOT NULL DEFAULT (datetime('now')),
      finished_at TEXT,
      success     INTEGER,
      mode        TEXT    NOT NULL DEFAULT 'replay',       -- replay | compile | teach
      steps_log   TEXT    NOT NULL DEFAULT '[]',           -- JSON string[]
      error       TEXT,
      duration_ms INTEGER
    );

    -- Shadow-mode staging: externally visible actions await one-tap approval.
    CREATE TABLE IF NOT EXISTS approvals (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      skill_id    INTEGER REFERENCES skills(id) ON DELETE CASCADE,
      run_id      INTEGER REFERENCES skill_runs(id) ON DELETE CASCADE,
      description TEXT    NOT NULL,
      payload     TEXT    NOT NULL DEFAULT '{}',           -- JSON { remainingSteps, url }
      status      TEXT    NOT NULL DEFAULT 'pending',      -- pending | approved | rejected
      created_at  TEXT    NOT NULL DEFAULT (datetime('now')),
      resolved_at TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_rules_workflow ON rules(workflow_id);
    CREATE INDEX IF NOT EXISTS idx_corrections_rule ON corrections(rule_id);
    CREATE INDEX IF NOT EXISTS idx_activity_ts ON activity_log(timestamp DESC);
    CREATE INDEX IF NOT EXISTS idx_skills_rule ON skills(rule_id);
    CREATE INDEX IF NOT EXISTS idx_skill_runs_skill ON skill_runs(skill_id);
    CREATE INDEX IF NOT EXISTS idx_approvals_status ON approvals(status);

    -- ── Episodic memory: raw interaction events (L2) ──────────────────────────
    -- Sessions group events separated by > 5-minute idle gaps.
    CREATE TABLE IF NOT EXISTS sessions (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      started_at  TEXT    NOT NULL DEFAULT (datetime('now')),
      ended_at    TEXT,
      app         TEXT    NOT NULL DEFAULT '',
      urls        TEXT    NOT NULL DEFAULT '[]',  -- JSON string[] unique URLs
      apps        TEXT    NOT NULL DEFAULT '[]',  -- JSON string[] unique apps
      event_count INTEGER NOT NULL DEFAULT 0,
      summary     TEXT    NOT NULL DEFAULT ''     -- set after NREM analysis
    );

    -- Individual interaction events: clicks, keys, navigations, app switches.
    -- source='screenpipe' means from Screenpipe input/accessibility API.
    -- source='browser'    means from the browser recorder (has DOM locators).
    CREATE TABLE IF NOT EXISTS raw_events (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id   INTEGER REFERENCES sessions(id) ON DELETE CASCADE,
      ts           TEXT    NOT NULL DEFAULT (datetime('now')),
      type         TEXT    NOT NULL,  -- click|key|navigate|fill|app_switch|clipboard
      app          TEXT    NOT NULL DEFAULT '',
      url          TEXT,
      window_name  TEXT,
      element_role TEXT,              -- AX role or DOM role
      element_name TEXT,              -- button label / placeholder / link text
      locators     TEXT,              -- JSON RankedLocator[] (browser source only)
      value        TEXT,              -- typed text / clipboard (max 300 chars)
      source       TEXT    NOT NULL DEFAULT 'screenpipe'
    );

    CREATE INDEX IF NOT EXISTS idx_raw_events_session ON raw_events(session_id);
    CREATE INDEX IF NOT EXISTS idx_raw_events_ts ON raw_events(ts DESC);
    CREATE INDEX IF NOT EXISTS idx_raw_events_app ON raw_events(app);
    CREATE INDEX IF NOT EXISTS idx_sessions_ts ON sessions(started_at DESC);
  `);

  // Additive migrations — safe to run on every boot.
  safeAddColumn(db, 'rules', 'trigger_hints', "TEXT NOT NULL DEFAULT '{}'");
  safeAddColumn(db, 'rules', 'accept_count', "INTEGER NOT NULL DEFAULT 0");
  safeAddColumn(db, 'rules', 'dismiss_count', "INTEGER NOT NULL DEFAULT 0");
  safeAddColumn(db, 'rules', 'action_steps', "TEXT NOT NULL DEFAULT '[]'");

  // One-time wipe for the v2 decision engine: old keyword-era rules carry
  // made-up confidence and no executable steps — start clean and relearn.
  const versionRow = db
    .prepare("SELECT value FROM settings WHERE key = 'model_version'")
    .get() as { value: string } | undefined;
  if (versionRow?.value !== "2") {
    db.exec(`
      DELETE FROM corrections;
      DELETE FROM activity_log;
      DELETE FROM rules;
      DELETE FROM workflows;
    `);
    db.prepare(`
      INSERT INTO settings (key, value) VALUES ('model_version', '2')
      ON CONFLICT(key) DO UPDATE SET value = excluded.value
    `).run();
    console.log("[db] Migrated to model v2 — wiped keyword-era behaviour model.");
  }
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
  /** JSON-serialised { apps: string[], keywords: string[] } (legacy, unused by v2 engine) */
  trigger_hints: string;
  /** Times the user accepted this rule's suggestion/execution. */
  accept_count: number;
  /** Times the user dismissed/rejected it. */
  dismiss_count: number;
  /** JSON-serialised string[] of concrete executable steps. */
  action_steps: string;
}

/**
 * Jaccard-style token overlap between two strings.
 * Returns 0–1 where 1 is identical. Tokens are lowercased words.
 */
function tokenOverlap(a: string, b: string): number {
  const tok = (s: string) => new Set(s.toLowerCase().match(/\w+/g) ?? []);
  const setA = tok(a);
  const setB = tok(b);
  if (setA.size === 0 && setB.size === 0) return 1;
  let inter = 0;
  for (const t of setA) if (setB.has(t)) inter++;
  return inter / (setA.size + setB.size - inter);
}

export function upsertRule(
  workflowId: number,
  condition: string,
  action: string,
  confidence: number,
  actionSteps: string[] = []
): Rule {
  const db = getDb();
  const stepsJson = JSON.stringify(actionSteps);

  // 1. Exact match first.
  let existing = db.prepare(`
    SELECT * FROM rules WHERE workflow_id = ? AND condition = ? AND action = ?
  `).get(workflowId, condition, action) as Rule | undefined;

  // 2. Fuzzy match: if another rule in the same workflow has ≥ 0.7 token
  //    overlap on BOTH condition and action, treat it as the same rule.
  //    This prevents duplicate rows when the LLM rephrases slightly.
  if (!existing) {
    const siblings = db.prepare(
      "SELECT * FROM rules WHERE workflow_id = ?"
    ).all(workflowId) as Rule[];

    for (const r of siblings) {
      if (
        tokenOverlap(r.condition, condition) >= 0.7 &&
        tokenOverlap(r.action, action) >= 0.7
      ) {
        existing = r;
        break;
      }
    }
  }

  if (existing) {
    const newCount = existing.observed_count + 1;
    const newConf = Math.min(
      1.0,
      existing.confidence + (confidence - existing.confidence) * 0.3
    );
    const steps = actionSteps.length > 0 ? stepsJson : existing.action_steps;
    db.prepare(`
      UPDATE rules SET confidence = ?, observed_count = ?, action_steps = ? WHERE id = ?
    `).run(newConf, newCount, steps, existing.id);
    return db.prepare("SELECT * FROM rules WHERE id = ?").get(existing.id) as Rule;
  }

  const info = db.prepare(`
    INSERT INTO rules (workflow_id, condition, action, confidence, action_steps)
    VALUES (?, ?, ?, ?, ?)
  `).run(workflowId, condition, action, confidence, stepsJson);

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
      accept_count = accept_count + 1,
      last_triggered = datetime('now')
    WHERE id = ?
  `).run(ruleId);
}

export function dismissRule(ruleId: number): void {
  getDb().prepare(`
    UPDATE rules SET dismiss_count = dismiss_count + 1 WHERE id = ?
  `).run(ruleId);
}

/**
 * Autonomy is earned through user feedback, never asserted by the LLM:
 *   - suggest:    the starting tier for every rule
 *   - supervised: >= 3 accepts AND no rejection among the last 5 outcomes
 *   - autonomous: >= 8 accepts AND no rejection among the last 10 outcomes
 * (LLM extraction confidence is used only for ranking/pruning.)
 */
export function earnedTier(rule: Rule): ConfidenceTier {
  if (rule.accept_count < 3) return "suggest";

  const recent = getDb().prepare(`
    SELECT status FROM activity_log
    WHERE rule_id = ? AND status IN ('accepted', 'rejected', 'undone', 'silent')
    ORDER BY timestamp DESC
    LIMIT 10
  `).all(rule.id) as { status: string }[];

  const last5HasRejection = recent
    .slice(0, 5)
    .some((r) => r.status === "rejected" || r.status === "undone");
  if (last5HasRejection) return "suggest";

  const last10HasRejection = recent.some(
    (r) => r.status === "rejected" || r.status === "undone"
  );
  if (rule.accept_count >= 8 && !last10HasRejection) return "autonomous";

  return "supervised";
}

export function deleteRule(id: number): void {
  getDb().prepare("DELETE FROM rules WHERE id = ?").run(id);
}

export function updateRuleCondition(id: number, condition: string): void {
  getDb().prepare("UPDATE rules SET condition = ? WHERE id = ?").run(condition, id);
}

/** Set a rule's confidence to 0.0 and record a "never_suggest" correction. */
export function setRuleConfidenceZero(ruleId: number): void {
  const db = getDb();
  const rule = db.prepare("SELECT * FROM rules WHERE id = ?").get(ruleId) as Rule | undefined;
  if (!rule) return;
  db.prepare("UPDATE rules SET confidence = 0.0 WHERE id = ?").run(ruleId);
  db.prepare(`
    INSERT INTO corrections (rule_id, expected_action, actual_action, user_note)
    VALUES (?, '', ?, 'never_suggest')
  `).run(ruleId, rule.action);
}

export interface EvidenceEntry {
  date: string;   // "Mon 2 Jun"
  summary: string;
}

function _fmtEvidenceDate(ts: string): string {
  const d = new Date(ts);
  const days = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun",
                  "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  return `${days[d.getDay()]} ${d.getDate()} ${months[d.getMonth()]}`;
}

/**
 * Return the last N accepted/autonomous activity entries for any rule
 * belonging to the given workflow.
 */
export function getEvidenceForRule(workflowId: number, limit = 3): EvidenceEntry[] {
  const rows = getDb().prepare(`
    SELECT al.action_taken, al.timestamp
    FROM activity_log al
    JOIN rules r ON al.rule_id = r.id
    WHERE r.workflow_id = ?
      AND al.status IN ('accepted', 'silent')
    ORDER BY al.timestamp DESC
    LIMIT ?
  `).all(workflowId, limit) as { action_taken: string; timestamp: string }[];

  return rows.map((row) => ({
    date: _fmtEvidenceDate(row.timestamp),
    summary: row.action_taken.slice(0, 80),
  }));
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

// ─── Diagnostics ─────────────────────────────────────────────────────────────

export interface RuleDiagnostic {
  id: number;
  workflow_id: number;
  workflow_name: string;
  condition: string;
  action: string;
  confidence: number;
  observed_count: number;
  correction_count: number;
  accept_count: number;
  dismiss_count: number;
  action_steps: string;
  last_triggered: string | null;
}

export function getDiagnostics(): {
  rules: RuleDiagnostic[];
  settings: Record<string, string>;
  activityCount: number;
} {
  const db = getDb();

  const rules = db.prepare(`
    SELECT r.id, r.workflow_id, w.name as workflow_name,
           r.condition, r.action, r.confidence, r.observed_count,
           r.correction_count, r.accept_count, r.dismiss_count,
           r.action_steps, r.last_triggered
    FROM rules r
    LEFT JOIN workflows w ON w.id = r.workflow_id
    ORDER BY r.confidence DESC
  `).all() as RuleDiagnostic[];

  const settings = getAllSettings();
  const activityCount = (db.prepare("SELECT COUNT(*) as n FROM activity_log").get() as { n: number }).n;

  return { rules, settings, activityCount };
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

// ─── Skills ───────────────────────────────────────────────────────────────────

export type SkillAction = "navigate" | "click" | "fill" | "press" | "wait" | "switch_app";
export type SkillSource = "compiled" | "taught";
export type SkillTriggerType = "context" | "schedule" | "manual";

export interface SkillStep {
  action: SkillAction;
  /** Human-readable caption — shown in the HUD and used for self-healing. */
  description: string;
  /** navigate: target URL. */
  url?: string;
  /** fill: text to type; press: key name; wait: seconds; switch_app: app name. */
  value?: string;
  /** Recorded element role (self-heal hint). */
  role?: string;
  /** Recorded accessible name (self-heal hint). */
  name?: string;
  /** Ranked locator candidates (click/fill steps). */
  locators?: RankedLocator[];
  /** Externally visible side effect (send/post/submit) — shadow-gated. */
  external?: boolean;
  /** Post-action verification. */
  verify?: { urlIncludes?: string; textVisible?: string };
}

export interface Skill {
  id: number;
  rule_id: number | null;
  name: string;
  source: SkillSource;
  trigger_type: SkillTriggerType;
  trigger_value: string;
  steps: SkillStep[];
  run_count: number;
  success_count: number;
  last_run_at: string | null;
  created_at: string;
}

interface SkillRow extends Omit<Skill, "steps"> {
  steps: string;
}

function rowToSkill(row: SkillRow): Skill {
  let steps: SkillStep[] = [];
  try {
    const parsed = JSON.parse(row.steps) as unknown;
    if (Array.isArray(parsed)) steps = parsed as SkillStep[];
  } catch {}
  return { ...row, steps };
}

export function createSkill(
  name: string,
  steps: SkillStep[],
  source: SkillSource = "compiled",
  ruleId: number | null = null
): Skill {
  const db = getDb();
  // One skill per rule — replace existing compiled skill on re-learn.
  if (ruleId != null) {
    db.prepare("DELETE FROM skills WHERE rule_id = ? AND source = 'compiled'").run(ruleId);
  }
  const info = db.prepare(`
    INSERT INTO skills (rule_id, name, source, steps)
    VALUES (?, ?, ?, ?)
  `).run(ruleId, name, source, JSON.stringify(steps));
  return getSkillById(info.lastInsertRowid as number)!;
}

export function getSkillById(id: number): Skill | null {
  const row = getDb().prepare("SELECT * FROM skills WHERE id = ?").get(id) as SkillRow | undefined;
  return row ? rowToSkill(row) : null;
}

export function getSkillForRule(ruleId: number): Skill | null {
  const row = getDb()
    .prepare("SELECT * FROM skills WHERE rule_id = ? ORDER BY id DESC LIMIT 1")
    .get(ruleId) as SkillRow | undefined;
  return row ? rowToSkill(row) : null;
}

export function getAllSkills(): Skill[] {
  const rows = getDb()
    .prepare("SELECT * FROM skills ORDER BY last_run_at DESC, id DESC")
    .all() as SkillRow[];
  return rows.map(rowToSkill);
}

export function updateSkillSteps(id: number, steps: SkillStep[]): void {
  getDb()
    .prepare("UPDATE skills SET steps = ? WHERE id = ?")
    .run(JSON.stringify(steps), id);
}

export function setSkillTrigger(id: number, type: SkillTriggerType, value = ""): void {
  getDb()
    .prepare("UPDATE skills SET trigger_type = ?, trigger_value = ? WHERE id = ?")
    .run(type, value, id);
}

export function deleteSkill(id: number): void {
  getDb().prepare("DELETE FROM skills WHERE id = ?").run(id);
}

// ─── Skill runs (audit log) ───────────────────────────────────────────────────

export interface SkillRun {
  id: number;
  skill_id: number | null;
  started_at: string;
  finished_at: string | null;
  success: number | null;
  mode: string;
  steps_log: string;
  error: string | null;
  duration_ms: number | null;
}

export function startSkillRun(skillId: number | null, mode: string): number {
  const info = getDb()
    .prepare("INSERT INTO skill_runs (skill_id, mode) VALUES (?, ?)")
    .run(skillId, mode);
  return info.lastInsertRowid as number;
}

export function finishSkillRun(
  runId: number,
  success: boolean,
  stepsLog: string[],
  error?: string,
  durationMs?: number
): void {
  const db = getDb();
  db.prepare(`
    UPDATE skill_runs SET
      finished_at = datetime('now'), success = ?, steps_log = ?, error = ?, duration_ms = ?
    WHERE id = ?
  `).run(success ? 1 : 0, JSON.stringify(stepsLog), error ?? null, durationMs ?? null, runId);

  const run = db.prepare("SELECT skill_id FROM skill_runs WHERE id = ?").get(runId) as
    | { skill_id: number | null }
    | undefined;
  if (run?.skill_id != null) {
    db.prepare(`
      UPDATE skills SET
        run_count = run_count + 1,
        success_count = success_count + ?,
        last_run_at = datetime('now')
      WHERE id = ?
    `).run(success ? 1 : 0, run.skill_id);
  }
}

export function getRecentSkillRuns(sinceDays = 7): SkillRun[] {
  return getDb().prepare(`
    SELECT * FROM skill_runs
    WHERE started_at > datetime('now', ?)
    ORDER BY started_at DESC
  `).all(`-${sinceDays} days`) as SkillRun[];
}

// ─── Approvals (shadow mode) ──────────────────────────────────────────────────

export interface Approval {
  id: number;
  skill_id: number | null;
  run_id: number | null;
  description: string;
  payload: string;
  status: "pending" | "approved" | "rejected";
  created_at: string;
  resolved_at: string | null;
}

export function queueApproval(
  skillId: number | null,
  runId: number | null,
  description: string,
  payload: object
): number {
  const info = getDb().prepare(`
    INSERT INTO approvals (skill_id, run_id, description, payload)
    VALUES (?, ?, ?, ?)
  `).run(skillId, runId, description, JSON.stringify(payload));
  return info.lastInsertRowid as number;
}

export function getPendingApprovals(): Approval[] {
  return getDb()
    .prepare("SELECT * FROM approvals WHERE status = 'pending' ORDER BY created_at ASC")
    .all() as Approval[];
}

export function getApprovalById(id: number): Approval | null {
  const row = getDb().prepare("SELECT * FROM approvals WHERE id = ?").get(id) as
    | Approval
    | undefined;
  return row ?? null;
}

export function resolveApproval(id: number, status: "approved" | "rejected"): void {
  getDb()
    .prepare("UPDATE approvals SET status = ?, resolved_at = datetime('now') WHERE id = ?")
    .run(status, id);
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

/**
 * Merge near-duplicate rules (same workflow, ≥ 0.7 token overlap on both
 * condition and action).  Keeps the row with the highest confidence and
 * accumulated observed_count; deletes the rest.
 *
 * Safe to call at every boot — it's a no-op when no duplicates exist.
 */
export function dedupRules(): number {
  function overlap(a: string, b: string): number {
    const tok = (s: string) => new Set(s.toLowerCase().match(/\w+/g) ?? []);
    const sa = tok(a); const sb = tok(b);
    if (sa.size === 0 && sb.size === 0) return 1;
    let inter = 0; for (const t of sa) if (sb.has(t)) inter++;
    return inter / (sa.size + sb.size - inter);
  }

  const db = getDb();
  const rules = db.prepare("SELECT * FROM rules ORDER BY workflow_id, id").all() as Rule[];
  const toDelete = new Set<number>();
  let merged = 0;

  for (let i = 0; i < rules.length; i++) {
    if (toDelete.has(rules[i].id)) continue;
    for (let j = i + 1; j < rules.length; j++) {
      if (toDelete.has(rules[j].id)) continue;
      if (rules[i].workflow_id !== rules[j].workflow_id) continue;
      if (
        overlap(rules[i].condition, rules[j].condition) >= 0.7 &&
        overlap(rules[i].action,    rules[j].action)    >= 0.7
      ) {
        // Keep the one with higher confidence (i), accumulate observed_count.
        const winner = rules[i].confidence >= rules[j].confidence ? rules[i] : rules[j];
        const loser  = winner === rules[i] ? rules[j] : rules[i];
        db.prepare(
          "UPDATE rules SET observed_count = observed_count + ?, confidence = MAX(confidence, ?) WHERE id = ?"
        ).run(loser.observed_count, loser.confidence, winner.id);
        toDelete.add(loser.id);
        merged++;
      }
    }
  }

  if (toDelete.size > 0) {
    const ids = [...toDelete].join(",");
    db.exec(`DELETE FROM rules WHERE id IN (${ids})`);
  }

  return merged;
}

// ─── Episodic memory: sessions + raw_events ───────────────────────────────────

export interface Session {
  id: number;
  started_at: string;
  ended_at: string | null;
  app: string;
  urls: string;  // JSON
  apps: string;  // JSON
  event_count: number;
  summary: string;
}

export interface RawEvent {
  id: number;
  session_id: number | null;
  ts: string;
  type: string;
  app: string;
  url: string | null;
  window_name: string | null;
  element_role: string | null;
  element_name: string | null;
  locators: string | null;  // JSON RankedLocator[]
  value: string | null;
  source: string;
}

export function openSession(app: string): number {
  const info = getDb()
    .prepare(
      `INSERT INTO sessions (app, urls, apps, event_count, summary)
       VALUES (?, '[]', '[]', 0, '')`
    )
    .run(app);
  return info.lastInsertRowid as number;
}

export function closeSession(id: number): void {
  getDb()
    .prepare("UPDATE sessions SET ended_at = datetime('now') WHERE id = ?")
    .run(id);
}

export function updateSession(
  id: number,
  patch: { urls?: string[]; apps?: string[]; event_count?: number; summary?: string }
): void {
  const db = getDb();
  const row = db.prepare("SELECT * FROM sessions WHERE id = ?").get(id) as Session | undefined;
  if (!row) return;
  const urls = patch.urls ? JSON.stringify(patch.urls) : row.urls;
  const apps = patch.apps ? JSON.stringify(patch.apps) : row.apps;
  const count = patch.event_count ?? row.event_count;
  const summary = patch.summary ?? row.summary;
  db.prepare(
    "UPDATE sessions SET urls = ?, apps = ?, event_count = ?, summary = ? WHERE id = ?"
  ).run(urls, apps, count, summary, id);
}

export function insertRawEvent(event: Omit<RawEvent, "id">): number {
  const info = getDb()
    .prepare(
      `INSERT INTO raw_events
         (session_id, ts, type, app, url, window_name, element_role,
          element_name, locators, value, source)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      event.session_id,
      event.ts,
      event.type,
      event.app,
      event.url ?? null,
      event.window_name ?? null,
      event.element_role ?? null,
      event.element_name ?? null,
      event.locators ?? null,
      event.value ? event.value.slice(0, 300) : null,
      event.source
    );
  return info.lastInsertRowid as number;
}

export function getSessionsInRange(sinceIso: string, untilIso: string): Session[] {
  return getDb()
    .prepare(
      "SELECT * FROM sessions WHERE started_at >= ? AND started_at <= ? ORDER BY started_at DESC"
    )
    .all(sinceIso, untilIso) as Session[];
}

export function getRecentSessions(days = 7): Session[] {
  return getDb()
    .prepare(
      "SELECT * FROM sessions WHERE started_at >= datetime('now', ?) ORDER BY started_at DESC"
    )
    .all(`-${days} days`) as Session[];
}

export function getRawEventsForSession(sessionId: number): RawEvent[] {
  return getDb()
    .prepare("SELECT * FROM raw_events WHERE session_id = ? ORDER BY ts ASC")
    .all(sessionId) as RawEvent[];
}

export function getUnsummarisedSessions(): Session[] {
  return getDb()
    .prepare(
      `SELECT * FROM sessions
       WHERE summary = '' AND ended_at IS NOT NULL
       ORDER BY started_at DESC LIMIT 50`
    )
    .all() as Session[];
}

/** Delete raw events older than `days` days and orphaned sessions. */
export function pruneRawEvents(days = 90): { events: number; sessions: number } {
  const db = getDb();
  const eventsResult = db
    .prepare("DELETE FROM raw_events WHERE ts < datetime('now', ?)")
    .run(`-${days} days`);
  const sessionsResult = db
    .prepare(
      `DELETE FROM sessions
       WHERE ended_at < datetime('now', ?)
         AND id NOT IN (SELECT DISTINCT session_id FROM raw_events WHERE session_id IS NOT NULL)`
    )
    .run(`-${days} days`);
  return {
    events: eventsResult.changes,
    sessions: sessionsResult.changes,
  };
}

/** Confidence decay: apply power-law forgetting to rules not recently used. */
export function applyConfidenceDecay(): number {
  const db = getDb();
  const rules = db
    .prepare("SELECT id, confidence, last_triggered FROM rules WHERE confidence > 0")
    .all() as Array<{ id: number; confidence: number; last_triggered: string | null }>;

  let updated = 0;
  const now = Date.now();

  for (const rule of rules) {
    if (!rule.last_triggered) continue;
    const daysSince = (now - new Date(rule.last_triggered).getTime()) / 86_400_000;
    if (daysSince < 1) continue;
    // Power-law decay: conf * 0.95^days_since. Gentle — 30 days ≈ 21% loss.
    const decayed = Math.max(0, rule.confidence * Math.pow(0.95, daysSince));
    if (Math.abs(decayed - rule.confidence) < 0.001) continue;
    db.prepare("UPDATE rules SET confidence = ? WHERE id = ?").run(decayed, rule.id);
    updated++;
  }

  return updated;
}
