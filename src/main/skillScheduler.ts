/**
 * Skill scheduler — "let it run" autonomy.
 *
 * Skills with trigger_type='schedule' run on their cron expression in the
 * background (no HUD, no focus steal). External steps always stage in the
 * approval queue — the morning-digest model: work is done before you sit
 * down, sends wait for one tap.
 */

import cron, { ScheduledTask } from "node-cron";
import { getAllSkills, Skill } from "./db";

const tasks = new Map<number, ScheduledTask>();

async function runScheduledSkill(skill: Skill): Promise<void> {
  console.log(`[scheduler] Running scheduled skill #${skill.id} "${skill.name}"`);
  try {
    const { replaySkill } = await import("./skillEngine");
    const result = await replaySkill(skill, { silent: true, externalAllowed: false });
    if (result.staged) {
      console.log(`[scheduler] Skill #${skill.id} staged external step(s) for approval`);
    } else if (result.success) {
      console.log(`[scheduler] Skill #${skill.id} completed (${result.stepsExecuted} steps)`);
    } else {
      console.error(`[scheduler] Skill #${skill.id} failed: ${result.error}`);
    }
  } catch (err) {
    console.error(`[scheduler] Skill #${skill.id} error:`, err);
  }
}

/** (Re)build cron jobs from the skills table. Call on boot and after changes. */
export function syncSkillSchedules(): void {
  for (const [, task] of tasks) task.stop();
  tasks.clear();

  const scheduled = getAllSkills().filter(
    (s) => s.trigger_type === "schedule" && s.trigger_value && s.steps.length > 0
  );

  for (const skill of scheduled) {
    if (!cron.validate(skill.trigger_value)) {
      console.warn(`[scheduler] Skill #${skill.id} has invalid cron "${skill.trigger_value}" — skipped`);
      continue;
    }
    const task = cron.schedule(skill.trigger_value, () => void runScheduledSkill(skill));
    tasks.set(skill.id, task);
  }

  if (scheduled.length > 0) {
    console.log(`[scheduler] ${tasks.size} scheduled skill(s) armed`);
  }
}

export function stopSkillSchedules(): void {
  for (const [, task] of tasks) task.stop();
  tasks.clear();
}
