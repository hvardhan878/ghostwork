/**
 * Action engine v2 — perception + LLM trigger decision.
 *
 * Every 10s it builds a UserContext (frontmost app + browser tab via
 * AppleScript, supplementary Screenpipe OCR + audio + clipboard) — local and free.
 * When the context meaningfully changes and stays stable for one tick, a single
 * cheap LLM call decides whether any learned rule applies right now.
 *
 * Autonomy is earned, never asserted. All rules start at "supervised"
 * (executes + HUD + Cmd+Z undo) and climb to "autonomous" through accepted
 * executions. There is no "suggest" tier — the system acts, it doesn't ask.
 */

import { BrowserWindow } from "electron";
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
import { setGhostState } from "./ghostState";
import { getBehaviourProfileText } from "./behaviourProfile";
import { queryClipboardEvents, queryAudioTranscriptions } from "./screenpipeDb";

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

    const tier = capTier(earnedTier(rule), getSetting("autonomy_override", "supervised"));
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
  // Only surface rules whose category is plausible for the current context.
  // For example, skip 'communication' rules when the user is in a code editor.
  const filteredRules = filterRulesByContext(ctx, rules);
  if (filteredRules.length === 0) return { rule_id: null, reason: "no rules match context category" };

  const ruleList = filteredRules
    .map((r) => `  ${r.id} [${(r as Rule & { category?: string }).category ?? "general"}]: WHEN ${r.condition} → DO ${r.action}`)
    .join("\n");

  const profile = getBehaviourProfileText();
  const profileSection = profile
    ? `\nUser's behavioural profile:\n${profile.slice(0, 800)}\n`
    : "";

  // Rich context: pull recent clipboard + audio from Screenpipe (strongest intent signals).
  const now = new Date().toISOString();
  const since2min = new Date(Date.now() - 2 * 60 * 1000).toISOString();
  const since30s = new Date(Date.now() - 30 * 1000).toISOString();

  let clipboardCtx = "";
  let audioCtx = "";
  try {
    const clips = queryClipboardEvents(since2min, now, 1);
    if (clips.length > 0) clipboardCtx = clips[0].text_content?.slice(0, 200) ?? "";
  } catch { /* Screenpipe DB may not be ready */ }
  try {
    const audio = queryAudioTranscriptions(since30s, now, 3);
    if (audio.length > 0) audioCtx = audio.map((a) => a.transcription).join(" ").slice(0, 200);
  } catch { /* Screenpipe DB may not be ready */ }

  const prompt = `You are the trigger decider for a workflow automation assistant.
${profileSection}
The user's current screen context:

App: ${ctx.app}
${ctx.url ? `URL: ${ctx.url}` : ""}
${ctx.windowTitle ? `Window/tab title: ${ctx.windowTitle}` : ""}
${ctx.ocrText ? `Visible text (OCR excerpt): ${ctx.ocrText.slice(0, 400)}` : ""}
${clipboardCtx ? `Recent clipboard paste: ${clipboardCtx}` : ""}
${audioCtx ? `Recent speech (30s): ${audioCtx}` : ""}

Learned rules (id [category]: WHEN condition → DO action):
${ruleList}

Does exactly one of these rules clearly apply to what the user is doing RIGHT NOW?
Be strict: only match if the current context genuinely satisfies the rule's condition.
Do not match rules about future or past activity, and do not stretch a rule to fit.
Clipboard and speech are strong intent signals — weight them heavily.

Reply with JSON only:
{"rule_id": <number or null>, "reason": "<one short sentence>"}`;

  return promptJSON<TriggerDecision>(prompt, FAST_MODEL);
}

// Category-based pre-filter: removes rules that can't possibly apply given the current app/URL.
// Prevents "communication" rules firing when the user is writing code, etc.
const CATEGORY_BLOCKED: Record<string, (ctx: UserContext) => boolean> = {
  communication: (ctx) =>
    /xcode|terminal|vscode|cursor|intellij|pycharm|vim|emacs|sublime/i.test(ctx.app),
  search_to_action: (ctx) =>
    !ctx.url && !/chrome|safari|firefox|arc|edge/i.test(ctx.app),
};

function filterRulesByContext(ctx: UserContext, rules: Rule[]): Rule[] {
  return rules.filter((r) => {
    const cat = (r as Rule & { category?: string }).category ?? "general";
    const blocker = CATEGORY_BLOCKED[cat];
    return !blocker || !blocker(ctx);
  });
}

// ─── Tier handling ───────────────────────────────────────────────────────────

function capTier(tier: ConfidenceTier, override: string): ConfidenceTier {
  // "suggest" override treated as supervised (suggest tier removed)
  if (override === "supervised" || override === "suggest") return "supervised";
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
  const instruction = executionInstruction(rule);
  const execOpts = { steps: parseSteps(rule.action_steps), ruleId: rule.id };

  if (tier === "supervised") {
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

function showNotification(title: string, body: string, _activityId: number): void {
  // Post-execution toast via macOS notification — uses Electron's Notification API.
  try {
    const { Notification: ElNotification } = require("electron") as typeof import("electron");
    if (!(ElNotification as unknown as { isSupported?: () => boolean }).isSupported?.()) return;
    const n = new ElNotification({ title, body });
    (n as unknown as { show: () => void }).show?.();
  } catch {
    // Notifications unavailable — log to console only.
    console.log(`[engine] ${title}: ${body}`);
  }
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
