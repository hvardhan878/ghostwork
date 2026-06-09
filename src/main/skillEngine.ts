/**
 * Skill engine — the compiler and replayer at the heart of Ghostwork v2.
 *
 * COMPILE (first run, plan-then-execute):
 *   One LLM call on a compact DOM/AX snapshot plans N steps → we execute them
 *   deterministically → re-snapshot → ask "continue or done" (max few rounds).
 *   The locators actually used are frozen into a Skill. Vision never enters
 *   this path; the pixel stack stays as a separate fallback substrate.
 *
 * REPLAY (every run after): zero tokens. Ranked locators per step; when the
 * top locator drifts we fall down the list (<1s, no LLM), then fuzzy-match
 * against a fresh snapshot, and only as a last resort re-plan the single
 * broken step with the LLM.
 *
 * SHADOW MODE: steps marked external (send/post/submit/connect) are staged in
 * the approval queue instead of fired, unless explicitly allowed.
 */

import { Page } from "playwright-core";
import {
  getOrCreatePage,
  snapshotInteractive,
  resolveRanked,
  healLocator,
  normalizeUrl,
  PageSnapshot,
  SnapshotElement,
} from "./browserDriver";
import {
  Skill,
  SkillStep,
  createSkill,
  updateSkillSteps,
  startSkillRun,
  finishSkillRun,
  queueApproval,
  getSetting,
} from "./db";
import { promptJSON, FAST_MODEL } from "./openrouter";
import { checkAbort } from "./abort";
import { showHud, updateHud, hideHud } from "./hudWindow";
import { setGhostState } from "./ghostState";

const MAX_PLAN_ROUNDS = 5;
const PLANNER_MODEL = "anthropic/claude-sonnet-4-5";

export interface SkillRunResult {
  success: boolean;
  stepsExecuted: number;
  stepsLog: string[];
  error?: string;
  /** Run paused: external step staged for approval. */
  staged?: boolean;
  /** Compiled steps (compile mode) for freezing into a skill. */
  compiledSteps?: SkillStep[];
}

function shadowModeOn(): boolean {
  return getSetting("shadow_mode", "1") === "1";
}

// ─── Step execution ───────────────────────────────────────────────────────────

async function settle(page: Page): Promise<void> {
  await page.waitForLoadState("domcontentloaded", { timeout: 5000 }).catch(() => {});
  await page.waitForTimeout(350);
}

async function verifyStep(page: Page, step: SkillStep): Promise<string | null> {
  if (step.verify?.urlIncludes) {
    const ok = page.url().includes(step.verify.urlIncludes);
    if (!ok) return `expected URL to include "${step.verify.urlIncludes}", got ${page.url()}`;
  }
  if (step.verify?.textVisible) {
    const visible = await page
      .getByText(step.verify.textVisible, { exact: false })
      .first()
      .isVisible()
      .catch(() => false);
    if (!visible) return `expected text "${step.verify.textVisible}" to be visible`;
  }
  return null;
}

/**
 * Resolve a step's element: ranked locators → fuzzy self-heal → LLM re-plan
 * of just this one step. Returns the locator plus (possibly updated) locators
 * so the skill can be persisted with healed selectors.
 */
async function resolveStepElement(
  page: Page,
  step: SkillStep,
  log: (msg: string) => void
): Promise<{ locator: import("playwright-core").Locator; healedLocators?: SkillStep["locators"] } | null> {
  if (step.locators?.length) {
    const resolved = await resolveRanked(page, step.locators);
    if (resolved) return { locator: resolved.locator };
  }

  // Self-heal tier 1: fuzzy match against the live tree (no LLM, <1s).
  const hint = step.name || step.description;
  const healed = await healLocator(page, step.role ?? "generic", hint);
  if (healed) {
    const resolved = await resolveRanked(page, healed.locators);
    if (resolved) {
      log(`self-healed "${hint.slice(0, 50)}" via live-tree fuzzy match`);
      return { locator: resolved.locator, healedLocators: healed.locators };
    }
  }

  // Self-heal tier 2: single-step LLM re-plan (cheap model, one call).
  const snap = await snapshotInteractive(page);
  const verdict = await promptJSON<{ ref: number | null }>(
    `A browser automation step failed to find its element.
Step goal: ${step.description}
${step.name ? `Original element name: "${step.name}"` : ""}

Current page: ${snap.title} (${snap.url})
Interactive elements:
${snap.asText}

Which element ref best matches the step goal? Reply JSON: {"ref": <number or null>}`,
    FAST_MODEL
  );
  if (verdict?.ref != null) {
    const el = snap.elements.find((e) => e.ref === verdict.ref);
    if (el) {
      const resolved = await resolveRanked(page, el.locators);
      if (resolved) {
        log(`self-healed "${hint.slice(0, 50)}" via single-step LLM re-plan`);
        return { locator: resolved.locator, healedLocators: el.locators };
      }
    }
  }

  return null;
}

/** Execute one step on the page. Throws on failure. */
async function executeStep(
  page: Page,
  step: SkillStep,
  log: (msg: string) => void
): Promise<{ healedLocators?: SkillStep["locators"] }> {
  checkAbort();

  switch (step.action) {
    case "navigate": {
      if (!step.url) throw new Error("navigate step missing url");
      await page.goto(normalizeUrl(step.url), { waitUntil: "domcontentloaded", timeout: 30000 });
      await settle(page);
      return {};
    }

    case "wait": {
      const secs = Math.min(parseFloat(step.value ?? "1") || 1, 15);
      await page.waitForTimeout(secs * 1000);
      return {};
    }

    case "press": {
      await page.keyboard.press(normalizeKey(step.value ?? "Enter"));
      await settle(page);
      return {};
    }

    case "switch_app": {
      // Browser skills don't switch apps; treated as a no-op (the legacy
      // pixel path handles app switching).
      return {};
    }

    case "click": {
      const resolved = await resolveStepElement(page, step, log);
      if (!resolved) throw new Error(`Element not found: ${step.description}`);
      await resolved.locator.click({ timeout: 8000 });
      await settle(page);
      return { healedLocators: resolved.healedLocators };
    }

    case "fill": {
      const resolved = await resolveStepElement(page, step, log);
      if (!resolved) throw new Error(`Element not found: ${step.description}`);
      await resolved.locator.click({ timeout: 8000 }).catch(() => {});
      await resolved.locator.fill(step.value ?? "", { timeout: 8000 }).catch(async () => {
        // contenteditable-ish fallback: type via keyboard
        await page.keyboard.type(step.value ?? "", { delay: 15 });
      });
      return { healedLocators: resolved.healedLocators };
    }

    default:
      throw new Error(`Unknown step action: ${(step as SkillStep).action}`);
  }
}

function normalizeKey(key: string): string {
  const k = key.trim().toLowerCase();
  const map: Record<string, string> = {
    enter: "Enter", return: "Enter", tab: "Tab", escape: "Escape", esc: "Escape",
    backspace: "Backspace", delete: "Delete", space: "Space",
    up: "ArrowUp", down: "ArrowDown", left: "ArrowLeft", right: "ArrowRight",
  };
  return map[k] ?? key;
}

function stepCaption(step: SkillStep, i: number, total: number): string {
  return `Step ${i + 1}/${total} — ${step.description.slice(0, 80)}`;
}

function firstUrlHint(steps: SkillStep[]): string | undefined {
  return steps.find((s) => s.url)?.url;
}

// ─── Replay ───────────────────────────────────────────────────────────────────

export interface ReplayOptions {
  /** Allow externally visible steps to fire (post-approval / earned autonomy). */
  externalAllowed?: boolean;
  /** Don't show the HUD (background/scheduled runs). */
  silent?: boolean;
  onStep?: (step: number, action: string, detail?: string) => void;
}

export async function replaySkill(skill: Skill, opts: ReplayOptions = {}): Promise<SkillRunResult> {
  const runId = startSkillRun(skill.id, "replay");
  const started = Date.now();
  const stepsLog: string[] = [];
  const log = (msg: string) => {
    stepsLog.push(msg);
    console.log(`[skill:${skill.id}] ${msg}`);
  };

  let healedAny = false;

  if (!opts.silent) {
    showHud(`Replaying: ${skill.name}`);
    setGhostState("working");
  }

  try {
    const page = await getOrCreatePage(firstUrlHint(skill.steps));

    for (let i = 0; i < skill.steps.length; i++) {
      const step = skill.steps[i];

      if (step.external && !opts.externalAllowed && shadowModeOn()) {
        const remaining = skill.steps.slice(i);
        const approvalId = queueApproval(skill.id, runId, step.description, {
          remainingSteps: remaining,
          url: page.url(),
        });
        log(`staged external step for approval (#${approvalId}): ${step.description}`);
        finishSkillRun(runId, true, stepsLog, undefined, Date.now() - started);
        void import("./approvals").then((a) =>
          a.notifyApprovalQueued(approvalId, step.description)
        );
        return { success: true, staged: true, stepsExecuted: i, stepsLog };
      }

      if (!opts.silent) updateHud(stepCaption(step, i, skill.steps.length));
      opts.onStep?.(i + 1, step.action, step.description.slice(0, 60));

      const { healedLocators } = await executeStep(page, step, log);
      if (healedLocators) {
        skill.steps[i] = { ...step, locators: healedLocators };
        healedAny = true;
      }
      log(`${step.action}: ${step.description.slice(0, 70)}`);

      const verifyErr = await verifyStep(page, step);
      if (verifyErr) throw new Error(`Verification failed after step ${i + 1}: ${verifyErr}`);
    }

    if (healedAny) updateSkillSteps(skill.id, skill.steps);

    finishSkillRun(runId, true, stepsLog, undefined, Date.now() - started);
    return { success: true, stepsExecuted: skill.steps.length, stepsLog };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    finishSkillRun(runId, false, stepsLog, msg, Date.now() - started);
    return { success: false, stepsExecuted: stepsLog.length, stepsLog, error: msg };
  } finally {
    if (!opts.silent) {
      hideHud();
      setGhostState("observing");
    }
  }
}

/** Execute a slice of steps (approval resume path). */
export async function executeSteps(
  steps: SkillStep[],
  skillId: number | null,
  opts: ReplayOptions = {}
): Promise<SkillRunResult> {
  const tempSkill: Skill = {
    id: skillId ?? -1,
    rule_id: null,
    name: "approved continuation",
    source: "compiled",
    trigger_type: "manual",
    trigger_value: "",
    steps,
    run_count: 0,
    success_count: 0,
    last_run_at: null,
    created_at: "",
  };
  // Avoid touching skill stats for synthetic ids.
  if (skillId == null || skillId < 0) {
    tempSkill.id = -1;
  }
  return replaySkill(tempSkill, { ...opts, externalAllowed: true });
}

// ─── Compile (plan-then-execute) ─────────────────────────────────────────────

interface PlannedStep {
  action: "navigate" | "click" | "fill" | "press" | "wait";
  ref?: number;
  url?: string;
  value?: string;
  description: string;
  external?: boolean;
}

interface PlanResponse {
  done: boolean;
  summary?: string;
  steps?: PlannedStep[];
}

function plannerPrompt(task: string, context: string, snap: PageSnapshot, executed: string[]): string {
  return `You are planning browser automation steps. Plan ONLY actions doable on the current page (plus navigation).

TASK: ${task}
${context ? `CONTEXT: ${context}` : ""}
${executed.length ? `ALREADY DONE:\n${executed.map((s) => `- ${s}`).join("\n")}` : ""}

CURRENT PAGE: ${snap.title} (${snap.url})
INTERACTIVE ELEMENTS (ref → role "name"):
${snap.asText || "(none found)"}

Plan the next steps. Use element refs from the list above. Available actions:
- {"action":"navigate","url":"https://…","description":"…"}
- {"action":"click","ref":12,"description":"…","external":false}
- {"action":"fill","ref":3,"value":"text to type","description":"…"}
- {"action":"press","value":"Enter","description":"…"}
- {"action":"wait","value":"2","description":"wait 2s"}

Mark "external": true on any step with an externally visible side effect (sending a message/invite, posting, submitting a form to another person). Plain navigation, searching and reading are NOT external.

If the task is already complete, reply {"done": true, "summary": "what was accomplished"}.
Otherwise reply JSON: {"done": false, "steps": [ … ]}
Plan only steps you are confident about from the element list — stop the list when the page will change (after navigation/click that loads a new page) so you can re-assess.`;
}

function plannedToSkillStep(p: PlannedStep, snapElements: SnapshotElement[]): SkillStep {
  const el = p.ref != null ? snapElements.find((e) => e.ref === p.ref) : undefined;
  return {
    action: p.action,
    description: p.description || `${p.action} ${el?.name ?? p.url ?? p.value ?? ""}`.trim(),
    url: p.url,
    value: p.value,
    role: el?.role,
    name: el?.name,
    locators: el?.locators,
    external: p.external === true,
  };
}

export interface CompileOptions {
  /** Rule to attach the frozen skill to. */
  ruleId?: number;
  skillName?: string;
  startUrl?: string;
  externalAllowed?: boolean;
  silent?: boolean;
  onStep?: (step: number, action: string, detail?: string) => void;
}

/**
 * Plan-then-execute a novel task on the user's Chrome, freezing the executed
 * steps (with their locators) into a compiled skill.
 */
export async function compileAndRun(
  task: string,
  context: string,
  opts: CompileOptions = {}
): Promise<SkillRunResult> {
  const runId = startSkillRun(null, "compile");
  const started = Date.now();
  const stepsLog: string[] = [];
  const compiled: SkillStep[] = [];
  const log = (msg: string) => {
    stepsLog.push(msg);
    console.log(`[skill:compile] ${msg}`);
  };

  if (!opts.silent) {
    showHud(`Working on: ${task.slice(0, 80)}`);
    setGhostState("working");
  }

  let stepCounter = 0;

  try {
    const page = await getOrCreatePage(opts.startUrl);

    // Anchor the skill: replay must start where the compile run started.
    const initialUrl = page.url();
    if (initialUrl && initialUrl !== "about:blank") {
      compiled.push({
        action: "navigate",
        url: initialUrl,
        description: `Open ${initialUrl.slice(0, 80)}`,
      });
    }

    for (let round = 0; round < MAX_PLAN_ROUNDS; round++) {
      checkAbort();
      const snap = await snapshotInteractive(page);
      const plan = await promptJSON<PlanResponse>(
        plannerPrompt(task, context, snap, stepsLog),
        PLANNER_MODEL,
        2048
      );

      if (!plan) throw new Error("Planner returned no response");
      if (plan.done) {
        log(`done: ${plan.summary ?? "task complete"}`);
        break;
      }
      const planned = (plan.steps ?? []).filter((s) => s && s.action);
      if (planned.length === 0) throw new Error("Planner returned no steps");

      log(`planned ${planned.length} step(s) (round ${round + 1})`);

      for (const p of planned) {
        checkAbort();
        const step = plannedToSkillStep(p, snap.elements);

        if (step.external && !opts.externalAllowed && shadowModeOn()) {
          const approvalId = queueApproval(null, runId, step.description, {
            remainingSteps: [step],
            url: page.url(),
            task,
          });
          log(`staged external step for approval (#${approvalId}): ${step.description}`);
          compiled.push(step);
          freezeSkill(task, compiled, opts);
          finishSkillRun(runId, true, stepsLog, undefined, Date.now() - started);
          void import("./approvals").then((a) =>
            a.notifyApprovalQueued(approvalId, step.description)
          );
          return { success: true, staged: true, stepsExecuted: stepCounter, stepsLog, compiledSteps: compiled };
        }

        stepCounter++;
        if (!opts.silent) updateHud(`Step ${stepCounter} — ${step.description.slice(0, 80)}`);
        opts.onStep?.(stepCounter, step.action, step.description.slice(0, 60));

        await executeStep(page, step, log);
        log(`${step.action}: ${step.description.slice(0, 70)}`);
        compiled.push(step);
      }
    }

    if (stepCounter === 0) {
      throw new Error("Nothing executed — planner found no applicable steps");
    }

    freezeSkill(task, compiled, opts);
    finishSkillRun(runId, true, stepsLog, undefined, Date.now() - started);
    return { success: true, stepsExecuted: stepCounter, stepsLog, compiledSteps: compiled };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    finishSkillRun(runId, false, stepsLog, msg, Date.now() - started);
    return { success: false, stepsExecuted: stepCounter, stepsLog, error: msg };
  } finally {
    if (!opts.silent) {
      hideHud();
      setGhostState("observing");
    }
  }
}

function freezeSkill(task: string, steps: SkillStep[], opts: CompileOptions): void {
  if (steps.length === 0) return;
  const name = (opts.skillName ?? task).slice(0, 120);
  const skill = createSkill(name, steps, "compiled", opts.ruleId ?? null);
  console.log(
    `[skill:compile] Froze skill #${skill.id} "${name.slice(0, 60)}" (${steps.length} steps${opts.ruleId ? `, rule #${opts.ruleId}` : ""})`
  );
}
