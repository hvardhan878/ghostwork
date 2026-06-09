/**
 * Action engine v2 — perception + LLM trigger decision.
 *
 * Every 10s it builds a UserContext (frontmost app + browser tab via
 * AppleScript, supplementary Screenpipe OCR) — local and free.  When the
 * context meaningfully changes and stays stable for one tick, a single cheap
 * LLM call decides whether any learned rule applies right now.
 *
 * Autonomy is earned, never asserted: every rule starts at "suggest" and
 * only climbs to supervised/autonomous through accepted executions
 * (see earnedTier in db.ts).
 */

import { BrowserWindow, Notification } from "electron";
import {
  getCurrentContext,
  contextKey,
  describeContext,
  UserContext,
} from "./context";
import {
  getAllRules,
  logActivity,
  updateActivityStatus,
  updateActivitySteps,
  getSetting,
  setSetting,
  recordCorrection,
  acceptRule,
  dismissRule,
  earnedTier,
  getEvidenceForRule,
  Rule,
  ConfidenceTier,
} from "./db";
import { executeWithComputerUse } from "./computerUse";
import { promptJSON, FAST_MODEL } from "./openrouter";
import { showNudgeWindow } from "./nudgeWindow";
import { setGhostState } from "./ghostState";

const POLL_INTERVAL_MS = 10_000;
const RULE_COOLDOWN_MS = 5 * 60 * 1000; // same rule won't fire more than once per 5 minutes
const MIN_TRIGGER_INTERVAL_MS = 60_000; // at most one LLM trigger call per minute

// Cheap safety net against self-referential rules learned while debugging.
const BLOCKED_RULE_TERMS = [
  "cursor",
  "terminal log",
  "http 403",
  "auth token",
  "screenpipe integration",
  "calculator app",
  "background for quick numerical reference",
];

let pollTimer: ReturnType<typeof setInterval> | null = null;
let tickCount = 0;
let prevKey: string | null = null; // key seen on the previous tick (stability check)
let lastEvaluatedKey: string | null = null; // key we last sent to the LLM
let lastTriggerCallAt = 0;
let evaluating = false;
const ruleFiredAt = new Map<number, number>(); // ruleId → timestamp of last dispatch
// Keep notification refs alive until dismissed — otherwise macOS GCs them before show.
const activeNotifications = new Map<number, Notification>();

export function startActionEngine(getWindow: () => BrowserWindow | null): void {
  if (pollTimer) return;
  console.log("[engine] Action engine v2 started — polling context every 10s");

  pollTimer = setInterval(async () => {
    try {
      await tick(getWindow);
    } catch (err) {
      console.error("[engine] Poll error:", err);
    }
  }, POLL_INTERVAL_MS);
}

export function stopActionEngine(): void {
  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
    console.log("[engine] Action engine stopped.");
  }
}

async function tick(getWindow: () => BrowserWindow | null): Promise<void> {
  tickCount++;
  if (evaluating) return; // an LLM call is already in flight

  const excludedApps = parseExcludedApps(getSetting("excluded_apps", "[]"));

  const ctx = await getCurrentContext(excludedApps);
  if (!ctx) return; // excluded app frontmost, or AppleScript failed

  if (ctx.app.toLowerCase().includes("ghostwork")) return; // never watch ourselves

  const key = contextKey(ctx);
  const stable = key === prevKey;
  prevKey = key;

  if (!stable) {
    console.log(`[engine:tick#${tickCount}] Context changed → ${describeContext(ctx)} (waiting for stability)`);
    return;
  }

  if (key === lastEvaluatedKey) return; // already evaluated this context

  const sinceLastCall = Date.now() - lastTriggerCallAt;
  if (sinceLastCall < MIN_TRIGGER_INTERVAL_MS) {
    console.log(`[engine:tick#${tickCount}] Trigger call rate-limited (${Math.round((MIN_TRIGGER_INTERVAL_MS - sinceLastCall) / 1000)}s remaining)`);
    return;
  }

  // Candidate rules: not blocked, not muted (conf 0 = "never suggest"), not on cooldown.
  const now = Date.now();
  const candidates = getAllRules().filter(
    (r) =>
      !isBlockedRule(r) &&
      r.confidence > 0 &&
      now - (ruleFiredAt.get(r.id) ?? 0) >= RULE_COOLDOWN_MS
  );

  if (candidates.length === 0) {
    console.log(`[engine:tick#${tickCount}] Context stable (${describeContext(ctx)}) but no candidate rules`);
    lastEvaluatedKey = key;
    return;
  }

  console.log(`[engine:tick#${tickCount}] Evaluating context: ${describeContext(ctx)} (${candidates.length} candidate rules)`);

  evaluating = true;
  lastEvaluatedKey = key;
  lastTriggerCallAt = now;

  try {
    const decision = await decideTrigger(ctx, candidates);

    if (!decision || decision.rule_id == null) {
      console.log(`[engine:tick#${tickCount}] LLM verdict: no rule applies${decision?.reason ? ` — ${decision.reason}` : ""}`);
      return;
    }

    const rule = candidates.find((r) => r.id === decision.rule_id);
    if (!rule) {
      console.warn(`[engine:tick#${tickCount}] LLM picked unknown rule #${decision.rule_id} — ignoring`);
      return;
    }

    const tier = capTier(earnedTier(rule), getSetting("autonomy_override", "suggest"));
    console.log(`[engine] LLM verdict: rule #${rule.id} applies — "${decision.reason}"`);
    console.log(`[engine] DISPATCHING rule #${rule.id} tier=${tier} (accepts=${rule.accept_count}, dismissals=${rule.dismiss_count}): "${rule.action.slice(0, 80)}"`);

    ruleFiredAt.set(rule.id, Date.now());
    await dispatch(rule, tier, getWindow);
  } finally {
    evaluating = false;
  }
}

// ─── LLM trigger decision ────────────────────────────────────────────────────

interface TriggerDecision {
  rule_id: number | null;
  reason: string;
}

async function decideTrigger(
  ctx: UserContext,
  rules: Rule[]
): Promise<TriggerDecision | null> {
  const ruleList = rules
    .map((r) => `  ${r.id}: WHEN ${r.condition} → DO ${r.action}`)
    .join("\n");

  const prompt = `You are the trigger decider for a workflow automation assistant.
The user's current screen context:

App: ${ctx.app}
${ctx.url ? `URL: ${ctx.url}` : ""}
${ctx.windowTitle ? `Window/tab title: ${ctx.windowTitle}` : ""}
${ctx.ocrText ? `Visible text (OCR excerpt): ${ctx.ocrText.slice(0, 500)}` : ""}

Learned rules (id: WHEN condition → DO action):
${ruleList}

Does exactly one of these rules clearly apply to what the user is doing RIGHT NOW?
Be strict: only match if the current context genuinely satisfies the rule's condition.
Do not match rules about future or past activity, and do not stretch a rule to fit.

Reply with JSON only:
{"rule_id": <number or null>, "reason": "<one short sentence>"}`;

  return promptJSON<TriggerDecision>(prompt, FAST_MODEL);
}

// ─── Tier handling ───────────────────────────────────────────────────────────

function capTier(tier: ConfidenceTier, override: string): ConfidenceTier {
  if (override === "suggest") return "suggest";
  if (override === "supervised" && tier === "autonomous") return "supervised";
  return tier;
}

/** Confidence shown in the UI — informational ranking signal only. */
function displayConfidence(rule: Rule): number {
  return rule.confidence;
}

// ─── Execution instruction ──────────────────────────────────────────────────

export function parseSteps(raw: string | undefined): string[] {
  try {
    const parsed = JSON.parse(raw ?? "[]") as unknown;
    return Array.isArray(parsed) ? (parsed as string[]).filter(Boolean) : [];
  } catch {
    return [];
  }
}

/**
 * Build the instruction for computer-use execution. Prefers the recorded
 * step sequence so the executor follows a known procedure rather than
 * reinterpreting prose.
 */
export function executionInstruction(rule: Rule): string {
  const steps = parseSteps(rule.action_steps);
  if (steps.length === 0) return rule.action;
  return `${rule.action}\n\nFollow these exact steps:\n${steps
    .map((s, i) => `${i + 1}. ${s}`)
    .join("\n")}`;
}

// ─── Dispatch ────────────────────────────────────────────────────────────────

async function dispatch(
  rule: Rule,
  tier: ConfidenceTier,
  getWindow: () => BrowserWindow | null
): Promise<void> {
  const confidence = displayConfidence(rule);
  const activityId = logActivity(
    "",
    rule.action,
    confidence,
    tier,
    tier === "autonomous" ? "silent" : "pending",
    rule.id
  );

  const win = getWindow();
  const evidence = getEvidenceForRule(rule.workflow_id, 3);
  const instruction = executionInstruction(rule);
  const execOpts = { steps: parseSteps(rule.action_steps), ruleId: rule.id };

  if (tier === "suggest") {
    const payload = {
      id: activityId,
      ruleId: rule.id,
      workflowId: rule.workflow_id,
      action: rule.action,
      condition: rule.condition,
      instruction, // steps-augmented execution instruction
      confidence,
      evidence,
    };

    win?.webContents.send("engine:suggest", payload);
    console.log(`[engine] Suggestion queued: "${rule.action}"`);

    const runDoIt = () => {
      console.log(`[engine] "Do it" for rule #${rule.id}: "${rule.action.slice(0, 80)}"`);
      setGhostState("working");
      return executeWithComputerUse(
        instruction,
        `Suggestion: ${rule.condition}`,
        () => {},
        execOpts
      )
        .then((result) => {
          if (result.success) {
            console.log(`[engine] Execution ✓ (${result.steps} steps, mode=${result.mode ?? "?"})`);
            updateActivityStatus(activityId, "accepted");
            acceptRule(rule.id);
          } else {
            console.error(`[engine] Execution ✗ — ${result.error}`);
            updateActivityStatus(activityId, "rejected");
            recordCorrection(rule.id, rule.action, "", "execution failed");
          }
        })
        .catch((err) => console.error("[engine] Do it error:", err))
        .finally(() => setGhostState("observing"));
    };

    const runDismiss = () => {
      console.log(`[engine] Dismissed rule #${rule.id}`);
      updateActivityStatus(activityId, "rejected");
      dismissRule(rule.id);
      recordCorrection(rule.id, rule.action, "", "dismissed");
      activeNotifications.delete(activityId);
      setGhostState("observing");
    };

    // macOS: native Notification action buttons require a code-signed app and
    // silent:true suppresses the banner entirely. Use a custom nudge popup instead.
    if (process.platform === "darwin") {
      setGhostState("noticed");
      showNudgeWindow({
        activityId,
        ruleId: rule.id,
        action: rule.action,
        instruction,
        condition: rule.condition,
        onDoIt: runDoIt,
        onDismiss: runDismiss,
      });
    } else if (Notification.isSupported()) {
      const n = new Notification({
        title: "Ghostwork suggestion",
        body: rule.action.slice(0, 100),
        actions: [
          { type: "button", text: "Do it" },
          { type: "button", text: "Dismiss" },
        ],
        closeButtonText: "Dismiss",
      });

      activeNotifications.set(activityId, n);

      n.on("action", (_event: Electron.Event, index: number) => {
        if (index === 0) runDoIt();
        else runDismiss();
      });

      n.on("click", () => {
        win?.show();
        win?.focus();
      });

      n.on("failed", () => {
        console.error("[engine] Native notification failed to show");
        activeNotifications.delete(activityId);
      });

      n.on("close", () => activeNotifications.delete(activityId));

      n.show();
      console.log("[engine] Native notification shown");
    } else {
      console.warn("[engine] Notifications not supported on this platform");
    }
  } else if (tier === "supervised") {
    setSetting(
      "pending_undo",
      JSON.stringify({ activityId, ruleId: rule.id, action: rule.action, timestamp: Date.now() })
    );

    console.log(`[engine] Supervised: executing "${rule.action}" …`);
    win?.webContents.send("engine:supervised", {
      id: activityId,
      ruleId: rule.id,
      action: rule.action,
      confidence,
      status: "executing",
    });

    const supervisedSteps: string[] = [];
    setGhostState("working");
    executeWithComputerUse(
      instruction,
      `Triggered by rule: ${rule.condition}`,
      (step, actionName, detail) => {
        const label = `${actionName}${detail ? " " + detail : ""}`;
        supervisedSteps.push(label);
        win?.webContents.send("engine:step", { activityId, step, actionName, detail });
      },
      execOpts
    ).then((result) => {
      setGhostState("observing");
      setSetting("pending_undo", "");
      updateActivityStatus(activityId, result.success ? "accepted" : "rejected");
      if (result.success) acceptRule(rule.id);
      if (supervisedSteps.length) updateActivitySteps(activityId, supervisedSteps);
      win?.webContents.send("engine:supervised", {
        id: activityId,
        ruleId: rule.id,
        action: rule.action,
        confidence,
        status: result.success ? "done" : "failed",
        error: result.error,
      });
      if (result.success) {
        showNotification(`Done: ${rule.action.slice(0, 60)}`, "Press Cmd+Z to undo", activityId);
      }
    }).catch((err) => {
      setGhostState("observing");
      setSetting("pending_undo", "");
      console.error("[engine] Supervised execution error:", err);
    });
  } else {
    // Autonomous — record pending_undo, execute silently, log to feed.
    setSetting(
      "pending_undo",
      JSON.stringify({ activityId, ruleId: rule.id, action: rule.action, timestamp: Date.now() })
    );

    console.log(`[engine] Autonomous: executing "${rule.action}" …`);
    win?.webContents.send("engine:activity", {
      id: activityId,
      ruleId: rule.id,
      action: rule.action,
      confidence,
      tier: "autonomous",
      status: "executing",
    });

    const autonomousSteps: string[] = [];
    setGhostState("working");
    executeWithComputerUse(
      instruction,
      `Autonomous rule: ${rule.condition}`,
      (step, actionName, detail) => {
        autonomousSteps.push(`${actionName}${detail ? " " + detail : ""}`);
      },
      execOpts
    ).then((result) => {
      setGhostState("observing");
      setSetting("pending_undo", "");
      updateActivityStatus(activityId, result.success ? "silent" : "rejected");
      if (result.success) acceptRule(rule.id);
      if (autonomousSteps.length) updateActivitySteps(activityId, autonomousSteps);
      win?.webContents.send("engine:activity", {
        id: activityId,
        status: result.success ? "silent" : "failed",
        error: result.error,
      });
    }).catch((err) => {
      setGhostState("observing");
      setSetting("pending_undo", "");
      console.error("[engine] Autonomous execution error:", err);
    });
  }
}

function showNotification(
  title: string,
  body: string,
  activityId: number
): void {
  if (!Notification.isSupported()) return;
  const n = new Notification({ title, body });
  n.on("click", () => updateActivityStatus(activityId, "undone"));
  n.on("close", () => activeNotifications.delete(activityId));
  activeNotifications.set(activityId, n);
  n.show();
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function parseExcludedApps(raw: string): string[] {
  try {
    return JSON.parse(raw) as string[];
  } catch {
    return [];
  }
}

function isBlockedRule(rule: Rule): boolean {
  const text = `${rule.condition} ${rule.action}`.toLowerCase();
  return BLOCKED_RULE_TERMS.some((term) => text.includes(term));
}
