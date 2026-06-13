/**
 * Behavioural profile — a living markdown document that summarises who the
 * user is, what they repeatedly do, and which workflows are ready to automate.
 *
 * Written to `behaviour.md` in the app's userData directory after every
 * nightly consolidation. Injected as system context into LLM prompts so the
 * model has a coherent picture of the user's work habits rather than reading
 * 30 flat rule rows.
 */

import * as fs from "fs";
import * as path from "path";
import { app } from "electron";
import { getAllRules, getAllWorkflows, getRecentSessions, getAllSkills, getSetting } from "./db";

const PROFILE_FILENAME = "behaviour.md";

function profilePath(): string {
  return path.join(app.getPath("userData"), PROFILE_FILENAME);
}

/**
 * Read the current profile text. Returns empty string if the file doesn't
 * exist yet (first boot, before the first nightly run).
 */
export function getBehaviourProfileText(): string {
  try {
    return fs.readFileSync(profilePath(), "utf-8");
  } catch {
    return "";
  }
}

/**
 * Rewrite the full behaviour.md from the current DB state.
 * Called at the end of every nightly consolidation (GC phase).
 */
export function writeBehaviourProfile(): void {
  try {
    const content = buildProfile();
    fs.writeFileSync(profilePath(), content, "utf-8");
    console.log("[profile] behaviour.md updated");
  } catch (err) {
    console.warn("[profile] Failed to write behaviour.md:", err);
  }
}

function buildProfile(): string {
  const now = new Date().toISOString().slice(0, 10);
  const rules = getAllRules();
  const workflows = getAllWorkflows();
  const skills = getAllSkills();
  const recentSessions = getRecentSessions(7);
  const focusCategories = parseFocus(getSetting("focus_categories", "[]"));

  const lines: string[] = [];
  lines.push(`# Behavioural Profile — updated ${now}`);
  lines.push("");

  // Focus areas
  if (focusCategories.length > 0) {
    lines.push("## Focus areas");
    lines.push(focusCategories.map((c) => `- ${c}`).join("\n"));
    lines.push("");
  }

  // Session summary
  if (recentSessions.length > 0) {
    const totalEvents = recentSessions.reduce((n, s) => n + s.event_count, 0);
    const uniqueApps = new Set<string>();
    for (const s of recentSessions) {
      try { (JSON.parse(s.apps) as string[]).forEach((a) => uniqueApps.add(a)); } catch {}
    }
    lines.push("## Activity this week");
    lines.push(`- ${recentSessions.length} sessions recorded, ${totalEvents} interactions`);
    if (uniqueApps.size > 0) {
      lines.push(`- Apps used: ${[...uniqueApps].slice(0, 8).join(", ")}`);
    }
    lines.push("");
  }

  // Skills (autopilot-ready)
  const readySkills = skills.filter((s) => s.steps.length > 0);
  if (readySkills.length > 0) {
    lines.push("## Workflows ready to automate (have recorded steps)");
    for (const sk of readySkills.slice(0, 10)) {
      const stepCount = sk.steps.length;
      const runs = sk.run_count > 0 ? ` · run ${sk.run_count}x` : "";
      lines.push(`- **${sk.name}**: ${stepCount} steps, source=${sk.source}${runs}`);
    }
    lines.push("");
  }

  // High-confidence rules
  const strongRules = rules
    .filter((r) => r.confidence >= 0.6)
    .sort((a, b) => b.confidence - a.confidence)
    .slice(0, 10);
  if (strongRules.length > 0) {
    lines.push("## Learned patterns (high confidence)");
    for (const r of strongRules) {
      const hasSteps = (() => {
        try { return (JSON.parse(r.action_steps) as unknown[]).length > 0; } catch { return false; }
      })();
      lines.push(
        `- WHEN ${r.condition.slice(0, 80)} → DO ${r.action.slice(0, 80)}` +
        ` (conf=${r.confidence.toFixed(2)}, obs=${r.observed_count}` +
        (hasSteps ? ", steps recorded" : ", needs recording") + ")"
      );
    }
    lines.push("");
  }

  // Learning rules (low confidence)
  const learningRules = rules
    .filter((r) => r.confidence > 0 && r.confidence < 0.6)
    .sort((a, b) => b.observed_count - a.observed_count)
    .slice(0, 5);
  if (learningRules.length > 0) {
    lines.push("## Patterns still learning");
    for (const r of learningRules) {
      lines.push(`- ${r.action.slice(0, 80)} (obs=${r.observed_count}, conf=${r.confidence.toFixed(2)})`);
    }
    lines.push("");
  }

  // Execution notes
  lines.push("## Execution preferences");
  const autonomy = getSetting("autonomy_override", "suggest");
  lines.push(`- Autonomy level: ${autonomy}`);
  lines.push("- Always confirm before any externally visible action (send, post, submit)");
  lines.push("");

  return lines.join("\n");
}

function parseFocus(raw: string): string[] {
  try {
    const v = JSON.parse(raw) as unknown;
    return Array.isArray(v) ? (v as string[]).filter(Boolean) : [];
  } catch {
    return [];
  }
}
