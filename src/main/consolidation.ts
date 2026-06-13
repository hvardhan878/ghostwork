/**
 * Nightly consolidation — runs at 2am via node-cron.
 *
 * Three phases modelled on memory consolidation research:
 *
 * NREM  — promotes raw episodic events (L2) to semantic rules/workflows (L3).
 *          Reads unsummarised sessions, extracts patterns with an LLM, and
 *          upserts workflows + rules.
 *
 * REM   — promotes stable L3 rules to executable L4 skills.
 *          For rules observed >= 3 times that have browser-recorded events
 *          (with DOM locators), constructs SkillStep[] and saves a skill.
 *
 * GC    — garbage collection and profile refresh.
 *          Power-law confidence decay, dedup, prune stale raw events,
 *          rewrite behaviour.md.
 */

import {
  promoteHighConfidenceRules,
  demoteFrequentlyCorrectRules,
  pruneStaleRules,
  dedupRules,
  getUnsummarisedSessions,
  getRawEventsForSession,
  updateSession,
  getAllRules,
  getRecentSessions,
  pruneRawEvents,
  applyConfidenceDecay,
  upsertWorkflow,
  upsertRule,
  createSkill,
  RawEvent,
  SkillStep,
  SkillAction,
} from "./db";
import { promptJSON } from "./openrouter";
import { writeBehaviourProfile } from "./behaviourProfile";
import { runExtractionJob } from "./extractor";

// ─── NREM: episodic → semantic ─────────────────────────────────────────────

interface NremRule {
  condition: string;
  action: string;
  confidence: number;
}

interface NremWorkflow {
  name: string;
  description: string;
  confidence: number;
  rules: NremRule[];
}

function serializeSession(events: RawEvent[]): string {
  return events
    .map((e) => {
      const parts = [`[${e.type}] ${e.app}`];
      if (e.url) parts.push(`@ ${e.url.slice(0, 80)}`);
      if (e.element_name) parts.push(`→ "${e.element_name.slice(0, 60)}"`);
      if (e.value) parts.push(`= "${e.value.slice(0, 80)}"`);
      return parts.join(" ");
    })
    .join("\n")
    .slice(0, 8000);
}

async function runNrem(): Promise<void> {
  console.log("[consolidation:nrem] Starting episodic → semantic promotion …");

  const sessions = getUnsummarisedSessions();
  if (sessions.length === 0) {
    console.log("[consolidation:nrem] No unsummarised sessions — skipping.");
    return;
  }

  console.log(`[consolidation:nrem] Analysing ${sessions.length} session(s) …`);
  let promoted = 0;

  for (const session of sessions) {
    const events = getRawEventsForSession(session.id);
    if (events.length < 3) {
      updateSession(session.id, { summary: "too_short" });
      continue;
    }

    const sequence = serializeSession(events);
    const apps = (() => { try { return JSON.parse(session.apps) as string[]; } catch { return [session.app]; } })();

    const prompt = `You are analysing a user's recorded work session to extract behavioural patterns.

SESSION DATA (ordered interaction events):
${sequence}

Apps used: ${apps.join(", ")}
Session duration: from ${session.started_at} to ${session.ended_at ?? "ongoing"}

Extract any repeating or meaningful workflow patterns from this session.
Return JSON only — no prose:
{
  "workflows": [
    {
      "name": "short workflow name (3-6 words)",
      "description": "one sentence describing what this workflow accomplishes",
      "confidence": 0.4,
      "rules": [
        {
          "condition": "observable screen state that triggers this (app + URL/content)",
          "action": "what the user does when in that state",
          "confidence": 0.4
        }
      ]
    }
  ]
}

Rules:
- Only include patterns that appear intentional and goal-directed
- "condition" must be checkable from the current screen state (app name, URL pattern, page content)
- If no meaningful pattern found, return {"workflows":[]}
- Confidence 0.3-0.5 for first observation`;

    const result = await promptJSON<{ workflows: NremWorkflow[] }>(prompt);
    if (!result || !Array.isArray(result.workflows)) {
      updateSession(session.id, { summary: "no_pattern" });
      continue;
    }

    let wfName = "unknown";
    for (const wf of result.workflows) {
      if (!wf.name || typeof wf.confidence !== "number") continue;
      const workflow = upsertWorkflow(wf.name, wf.description ?? "", [], wf.confidence);
      wfName = wf.name;
      for (const rule of wf.rules ?? []) {
        if (!rule.condition || !rule.action) continue;
        upsertRule(workflow.id, rule.condition, rule.action, rule.confidence, []);
      }
      promoted++;
    }

    updateSession(session.id, { summary: wfName });
  }

  console.log(`[consolidation:nrem] Promoted ${promoted} workflow(s) from sessions.`);
}

// ─── REM: semantic → procedural ──────────────────────────────────────────────

async function runRem(): Promise<void> {
  console.log("[consolidation:rem] Starting semantic → procedural promotion …");

  const rules = getAllRules().filter(
    (r) => r.observed_count >= 3 && r.confidence >= 0.4
  );

  if (rules.length === 0) {
    console.log("[consolidation:rem] No eligible rules — skipping.");
    return;
  }

  // Find rules that have browser-recorded events (with locators) in recent sessions
  const recentSessions = getRecentSessions(7);
  let promoted = 0;

  for (const rule of rules) {
    // Look for sessions where the URL or app matches the rule condition
    const matchingSessions = recentSessions.filter((s) => {
      const condLower = rule.condition.toLowerCase();
      const urlsLower = s.urls.toLowerCase();
      const appsLower = s.apps.toLowerCase();
      return urlsLower.includes("linkedin") && condLower.includes("linkedin") ||
             urlsLower.includes("gmail") && condLower.includes("gmail") ||
             appsLower.split('"').some((a) => a.length > 3 && condLower.includes(a.toLowerCase()));
    });

    if (matchingSessions.length === 0) continue;

    // Gather browser-recorded events with locators from these sessions
    const browserEvents: RawEvent[] = [];
    for (const session of matchingSessions.slice(0, 3)) {
      const events = getRawEventsForSession(session.id).filter(
        (e) => e.source === "browser" && e.locators
      );
      browserEvents.push(...events);
    }

    if (browserEvents.length < 2) continue;

    // Build SkillStep[] from browser events
    const steps: SkillStep[] = browserEvents
      .slice(0, 20)
      .map((e): SkillStep => {
        const rawAction = e.type === "fill" ? "fill"
          : e.type === "click" ? "click"
          : e.type === "navigate" ? "navigate"
          : e.type === "app_switch" ? "switch_app"
          : "click";
        const action = rawAction as SkillAction;
        const step: SkillStep = {
          action,
          description: e.element_name
            ? `${e.type} "${e.element_name}"`
            : `${e.type} on ${e.app}`,
        };
        if (e.url) step.url = e.url;
        if (e.value) step.value = e.value;
        if (e.element_role) step.role = e.element_role;
        if (e.element_name) step.name = e.element_name;
        if (e.locators) {
          try { step.locators = JSON.parse(e.locators); } catch {}
        }
        return step;
      });

    try {
      createSkill(
        rule.action.slice(0, 80),
        steps,
        "compiled",
        rule.id
      );
      promoted++;
      console.log(`[consolidation:rem] Promoted rule #${rule.id} to skill (${steps.length} steps)`);
    } catch (err) {
      console.warn(`[consolidation:rem] Could not create skill for rule #${rule.id}:`, err);
    }
  }

  console.log(`[consolidation:rem] Promoted ${promoted} rule(s) to skills.`);
}

// ─── GC: cleanup + profile rewrite ───────────────────────────────────────────

function runGc(): void {
  console.log("[consolidation:gc] Starting garbage collection …");

  const promoted = promoteHighConfidenceRules();
  console.log(`[consolidation:gc] Promoted ${promoted} rules (high confidence).`);

  const demoted = demoteFrequentlyCorrectRules();
  console.log(`[consolidation:gc] Demoted ${demoted} frequently-corrected rules.`);

  const decayed = applyConfidenceDecay();
  console.log(`[consolidation:gc] Applied power-law decay to ${decayed} rules.`);

  const pruned = pruneStaleRules();
  console.log(`[consolidation:gc] Pruned ${pruned} stale rules.`);

  const merged = dedupRules();
  console.log(`[consolidation:gc] Deduped ${merged} near-duplicate rules.`);

  const { events, sessions } = pruneRawEvents(90);
  console.log(`[consolidation:gc] Pruned ${events} raw events, ${sessions} empty sessions (>90 days).`);

  writeBehaviourProfile();
}

// ─── Main entry ──────────────────────────────────────────────────────────────

export async function runNightlyConsolidation(): Promise<void> {
  console.log("[consolidation] ── Nightly consolidation starting ──────────────");

  // NREM: episodic → semantic (session events → rules)
  await runNrem().catch((err) =>
    console.error("[consolidation:nrem] Error:", err)
  );

  // Also re-run the Screenpipe OCR extractor as a supplementary signal
  await runExtractionJob().catch((err) =>
    console.error("[consolidation] Extraction error:", err)
  );

  // REM: semantic → procedural (stable rules → skills with steps)
  await runRem().catch((err) =>
    console.error("[consolidation:rem] Error:", err)
  );

  // GC: decay, dedup, prune, profile rewrite
  runGc();

  console.log("[consolidation] ── Nightly consolidation complete ───────────────");
}
