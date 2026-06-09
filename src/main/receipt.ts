/**
 * Weekly receipt — the scoreboard that makes the ghost's work visible.
 * "Ghostwork ran 23 workflows and saved you 4.1 hours this week."
 */

import { getDb, getRecentSkillRuns, getAllSkills, getPendingApprovals } from "./db";

/** Estimated human seconds per automated step (typing, finding, clicking). */
const HUMAN_SECONDS_PER_STEP = 25;

export interface Receipt {
  days: number;
  runs: number;
  successes: number;
  minutesSaved: number;
  skillCount: number;
  topSkills: Array<{ name: string; runs: number }>;
  newPatterns: Array<{ id: number; action: string; condition: string }>;
  pendingApprovals: number;
}

export function computeReceipt(days = 7): Receipt {
  const runs = getRecentSkillRuns(days);
  const successes = runs.filter((r) => r.success === 1);

  let savedSeconds = 0;
  for (const run of successes) {
    let stepCount = 0;
    try {
      stepCount = (JSON.parse(run.steps_log) as string[]).length;
    } catch {}
    const humanTime = stepCount * HUMAN_SECONDS_PER_STEP;
    const machineTime = (run.duration_ms ?? 0) / 1000;
    savedSeconds += Math.max(0, humanTime - machineTime);
  }

  const skills = getAllSkills();
  const runsBySkill = new Map<number, number>();
  for (const run of successes) {
    if (run.skill_id != null) {
      runsBySkill.set(run.skill_id, (runsBySkill.get(run.skill_id) ?? 0) + 1);
    }
  }
  const topSkills = [...runsBySkill.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([skillId, count]) => ({
      name: skills.find((s) => s.id === skillId)?.name ?? `Skill #${skillId}`,
      runs: count,
    }));

  // New patterns: rules learned in the window that haven't been accepted yet.
  const newPatterns = getDb().prepare(`
    SELECT id, action, condition FROM rules
    WHERE created_at > datetime('now', ?) AND accept_count = 0 AND confidence > 0
    ORDER BY confidence DESC LIMIT 5
  `).all(`-${days} days`) as Array<{ id: number; action: string; condition: string }>;

  return {
    days,
    runs: runs.length,
    successes: successes.length,
    minutesSaved: Math.round(savedSeconds / 60),
    skillCount: skills.length,
    topSkills,
    newPatterns,
    pendingApprovals: getPendingApprovals().length,
  };
}

export function receiptSummaryLine(r: Receipt): string {
  const hours = (r.minutesSaved / 60).toFixed(1);
  return `${r.successes} workflow${r.successes === 1 ? "" : "s"} run, ~${hours}h saved this week`;
}
