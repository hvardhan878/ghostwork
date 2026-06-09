/**
 * Action engine — polls Screenpipe every 10 seconds, matches current
 * activity against known rules, and acts based on confidence tier.
 *
 * Tier thresholds:
 *   < 0.6  → suggest (show in sidebar)
 *   0.6–0.85 → supervised (act + show "undo?" notification)
 *   > 0.85 → autonomous (act silently, log to feed)
 */

import { BrowserWindow, Notification } from "electron";
import { getRecentActivity, ContentItem } from "./screenpipe";
import { getAllRules, logActivity, updateActivityStatus, updateActivitySteps, getSetting, Rule } from "./db";
import { executeWithComputerUse } from "./computerUse";

const POLL_INTERVAL_MS = 10_000;
let pollTimer: ReturnType<typeof setInterval> | null = null;
let lastSeenTimestamp: string | null = null;

export function startActionEngine(getWindow: () => BrowserWindow | null): void {
  if (pollTimer) return;
  console.log("[engine] Action engine started — polling every 10s");

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
  const excludedApps = parseExcludedApps(getSetting("excluded_apps", "[]"));
  const autonomyOverride = getSetting("autonomy_override", "full");

  // Fetch just the last 2 minutes of activity
  const end = new Date();
  const start = new Date(end.getTime() - 2 * 60 * 1000);

  let items: ContentItem[];
  try {
    items = await getRecentActivity(
      0.033, // ~2 min
      excludedApps,
      30
    );
  } catch {
    return; // Screenpipe offline — silent
  }

  if (items.length === 0) return;

  // Deduplicate against last seen
  const newItems = lastSeenTimestamp
    ? items.filter((i) => i.timestamp > lastSeenTimestamp!)
    : items;

  if (newItems.length === 0) return;
  lastSeenTimestamp = newItems[0].timestamp;

  const rules = getAllRules();
  if (rules.length === 0) return;

  const activitySummary = newItems
    .map((i) => `${i.app_name ?? ""} ${i.window_name ?? ""}`)
    .join(" | ")
    .toLowerCase();

  for (const rule of rules) {
    const conditionLower = rule.condition.toLowerCase();
    // Naive keyword match — the real signal comes from the extraction job;
    // this is a lightweight trigger to see if the current context looks relevant
    const keywords = conditionLower
      .replace(/[^a-z0-9\s]/g, " ")
      .split(/\s+/)
      .filter((w) => w.length > 3);

    const matchScore =
      keywords.filter((kw) => activitySummary.includes(kw)).length /
      Math.max(keywords.length, 1);

    if (matchScore < 0.4) continue;

    const effectiveConfidence = effectiveTierConfidence(
      rule.confidence,
      autonomyOverride
    );
    const tier = getTier(effectiveConfidence);

    await dispatch(rule, tier, effectiveConfidence, getWindow);
    break; // one action per tick to avoid flooding
  }
}

function effectiveTierConfidence(
  confidence: number,
  override: string
): number {
  if (override === "suggest") return Math.min(confidence, 0.59);
  if (override === "supervised") return Math.min(confidence, 0.84);
  return confidence; // full
}

function getTier(
  confidence: number
): "suggest" | "supervised" | "autonomous" {
  if (confidence > 0.85) return "autonomous";
  if (confidence >= 0.6) return "supervised";
  return "suggest";
}

async function dispatch(
  rule: Rule,
  tier: "suggest" | "supervised" | "autonomous",
  confidence: number,
  getWindow: () => BrowserWindow | null
): Promise<void> {
  const activityId = logActivity(
    "",
    rule.action,
    confidence,
    tier,
    tier === "autonomous" ? "silent" : "pending",
    rule.id
  );

  const win = getWindow();

  if (tier === "suggest") {
    // Push suggestion to sidebar — user approves before anything runs
    win?.webContents.send("engine:suggest", {
      id: activityId,
      ruleId: rule.id,
      action: rule.action,
      condition: rule.condition,
      confidence,
    });
    console.log(`[engine] Suggestion queued: "${rule.action}" (${confidence.toFixed(2)})`);
  } else if (tier === "supervised") {
    // Execute, then show "Undo?" notification
    console.log(`[engine] Supervised: executing "${rule.action}" …`);
    win?.webContents.send("engine:supervised", {
      id: activityId,
      ruleId: rule.id,
      action: rule.action,
      confidence,
      status: "executing",
    });

    const supervisedSteps: string[] = [];
    executeWithComputerUse(
      rule.action,
      `Triggered by rule: ${rule.condition}`,
      (step, actionName, detail) => {
        const label = `${actionName}${detail ? " " + detail : ""}`;
        supervisedSteps.push(label);
        win?.webContents.send("engine:step", { activityId, step, actionName, detail });
      }
    ).then((result) => {
      updateActivityStatus(activityId, result.success ? "accepted" : "rejected");
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
        showNotification(`Done: ${rule.action.slice(0, 60)}`, "Click to undo", activityId);
      }
    }).catch((err) => {
      console.error("[engine] Supervised execution error:", err);
    });
  } else {
    // Autonomous — execute silently, log to feed
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
    executeWithComputerUse(
      rule.action,
      `Autonomous rule: ${rule.condition}`,
      (step, actionName, detail) => {
        autonomousSteps.push(`${actionName}${detail ? " " + detail : ""}`);
      }
    ).then((result) => {
      updateActivityStatus(activityId, result.success ? "silent" : "rejected");
      if (autonomousSteps.length) updateActivitySteps(activityId, autonomousSteps);
      win?.webContents.send("engine:activity", {
        id: activityId,
        status: result.success ? "silent" : "failed",
        error: result.error,
      });
    }).catch((err) => {
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
  const n = new Notification({ title, body, silent: true });
  n.on("click", () => {
    // Undo: mark activity as undone
    updateActivityStatus(activityId, "undone");
  });
  n.show();
}

function parseExcludedApps(raw: string): string[] {
  try {
    return JSON.parse(raw) as string[];
  } catch {
    return [];
  }
}
