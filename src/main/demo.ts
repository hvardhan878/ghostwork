/**
 * Demo seed — one concrete example showing the full execution trace.
 * Runs once on first launch, wiped when the user clicks "Wipe all data".
 */

import { upsertWorkflow, upsertRule, getSetting, setSetting } from "./db";

export function seedDemoData(): void {
  if (getSetting("demo_seeded") === "1") return;

  console.log("[demo] Seeding single example workflow …");

  const db = (require("./db") as typeof import("./db")).getDb();

  // ── One workflow ─────────────────────────────────────────────────────────────
  const wf = upsertWorkflow(
    "Archive Gmail newsletters",
    "When Gmail is open and the inbox contains unread newsletters, select them all and archive.",
    ["Open Gmail", "Identify newsletters by sender", "Select all", "Click Archive"],
    0.82
  );

  const rule = upsertRule(
    wf.id,
    "Gmail is open and inbox contains emails from known newsletter senders (Substack, Morning Brew, etc.)",
    "Select all newsletter emails and click Archive",
    0.82
  );

  // ── Activity log: one completed execution with step trace in user_note ───────
  const now = Date.now();
  const ago = (ms: number) => new Date(now - ms).toISOString();

  // note helper: always include demo:true so UI can badge these as sample data
  const note = (steps: string[]) => JSON.stringify({ demo: true, steps });

  // Completed autonomous execution 11 minutes ago — with step trace
  db.prepare(`
    INSERT INTO activity_log
      (timestamp, workflow_name, action_taken, confidence, tier, status, rule_id, user_note)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    ago(11 * 60_000),
    "Archive Gmail newsletters",
    "Archived 3 newsletters (Morning Brew, Substack Weekly, Product Hunt Digest)",
    0.82,
    "autonomous",
    "silent",
    rule.id,
    note([
      "screenshot → saw Gmail inbox, 3 unread newsletters visible",
      "left_click on 'Morning Brew' row",
      "left_click checkbox on 'Substack Weekly'",
      "left_click checkbox on 'Product Hunt Digest'",
      "left_click 'Archive' button — all 3 moved",
      "screenshot → inbox clear ✓",
    ])
  );

  // One pending supervised item — acted 2 min ago, waiting for user to undo or confirm
  db.prepare(`
    INSERT INTO activity_log
      (timestamp, workflow_name, action_taken, confidence, tier, status, rule_id, user_note)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    ago(2 * 60_000),
    "Archive Gmail newsletters",
    "Archived 1 newsletter (YC Newsletter) — undo?",
    0.82,
    "supervised",
    "pending",
    rule.id,
    note([
      "screenshot → saw Gmail, 1 unread newsletter from 'Y Combinator'",
      "left_click on 'YC Newsletter' row",
      "left_click 'Archive' button",
      "screenshot → email archived ✓",
    ])
  );

  // Exclude Cursor and Electron from observation by default so the extractor
  // never learns from debugging sessions of Ghostwork itself.
  if (!getSetting("excluded_apps_defaulted")) {
    setSetting("excluded_apps", JSON.stringify(["Cursor", "Electron"]));
    setSetting("excluded_apps_defaulted", "1");
  }

  setSetting("demo_seeded", "1");
  console.log("[demo] Seed complete.");
}
