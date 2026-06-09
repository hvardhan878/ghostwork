/**
 * Pattern extraction job — runs every 60 minutes.
 * Queries Screenpipe for the last hour, strips PII, sends to Claude via
 * OpenRouter, parses the structured JSON response, and merges into the
 * local behaviour model.
 */

import { getRecentActivity, ContentItem } from "./screenpipe";
import { promptJSON } from "./openrouter";
import { upsertWorkflow, upsertRule, getSetting, setSetting } from "./db";

// ─── PII stripping ────────────────────────────────────────────────────────────

const PII_PATTERNS: RegExp[] = [
  /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Z|a-z]{2,}\b/g, // email
  /\b(?:\+?1[-.\s]?)?\(?\d{3}\)?[-.\s]?\d{3}[-.\s]?\d{4}\b/g, // phone
  /\b(?:4[0-9]{12}(?:[0-9]{3})?|5[1-5][0-9]{14}|3[47][0-9]{13}|3(?:0[0-5]|[68][0-9])[0-9]{11}|6(?:011|5[0-9]{2})[0-9]{12})\b/g, // card
  /\b[A-Z]{2}\d{6}[A-Z]?\b/g, // passport-like
];

function stripPII(text: string): string {
  let result = text;
  for (const pattern of PII_PATTERNS) {
    result = result.replace(pattern, "[REDACTED]");
  }
  return result;
}

function sanitiseItems(items: ContentItem[]): string {
  return items
    .map((item) => {
      const base = `[${item.type}] ${item.app_name ?? "unknown"} / ${item.window_name ?? ""}`;
      const contentText = JSON.stringify(item.content);
      return stripPII(`${base}: ${contentText}`);
    })
    .join("\n");
}

// ─── Claude prompt ────────────────────────────────────────────────────────────

interface ExtractedRule {
  condition: string;
  action: string;
  confidence: number;
  evidence: string[];
}

interface ExtractedWorkflow {
  name: string;
  description: string;
  steps: string[];
  confidence: number;
  rules: ExtractedRule[];
}

interface ExtractionResult {
  workflows: ExtractedWorkflow[];
}

function buildExtractionPrompt(activityText: string): string {
  return `You are analysing a knowledge worker's computer activity from the last hour.
Your task: extract repeating workflows and inferred behavioural rules.

ACTIVITY DATA:
${activityText}

Return a JSON object with this exact schema (no extra keys):
{
  "workflows": [
    {
      "name": "short workflow name",
      "description": "one sentence describing what this workflow accomplishes",
      "steps": ["step 1", "step 2", "step 3"],
      "confidence": 0.0,
      "rules": [
        {
          "condition": "when X happens",
          "action": "do Y",
          "confidence": 0.0,
          "evidence": ["raw observation 1", "raw observation 2"]
        }
      ]
    }
  ]
}

Rules:
- Only include workflows observed at least twice in this session
- Confidence is 0.0–1.0; use 0.3–0.5 for first observations
- Rules must be specific and actionable, not vague
- If no patterns found, return {"workflows":[]}
- Strip any personal data from evidence strings
- Focus on app-switching patterns, repeated sequences, conditional behaviours`;
}

// ─── Extraction job ───────────────────────────────────────────────────────────

export async function runExtractionJob(): Promise<void> {
  console.log("[extractor] Starting hourly pattern extraction …");

  const excludedAppsRaw = getSetting("excluded_apps", "[]");
  let excludedApps: string[] = [];
  try {
    excludedApps = JSON.parse(excludedAppsRaw) as string[];
  } catch {
    excludedApps = [];
  }

  let items: ContentItem[];
  try {
    items = await getRecentActivity(1, excludedApps, 200);
  } catch (err) {
    console.warn("[extractor] Could not fetch screenpipe data:", err);
    return;
  }

  if (items.length === 0) {
    console.log("[extractor] No activity data in last hour — skipping.");
    return;
  }

  console.log(`[extractor] Processing ${items.length} events …`);
  const activityText = sanitiseItems(items);

  const result = await promptJSON<ExtractionResult>(
    buildExtractionPrompt(activityText)
  );

  if (!result || !Array.isArray(result.workflows)) {
    console.warn("[extractor] No valid extraction result from OpenRouter.");
    return;
  }

  console.log(`[extractor] Extracted ${result.workflows.length} workflow(s).`);

  for (const wf of result.workflows) {
    if (!wf.name || typeof wf.confidence !== "number") continue;

    const workflow = upsertWorkflow(
      wf.name,
      wf.description ?? "",
      wf.steps ?? [],
      wf.confidence
    );

    for (const rule of wf.rules ?? []) {
      if (!rule.condition || !rule.action) continue;
      upsertRule(workflow.id, rule.condition, rule.action, rule.confidence);
    }

    console.log(
      `[extractor]   ✓ "${wf.name}" — ${wf.rules?.length ?? 0} rules, confidence ${wf.confidence.toFixed(2)}`
    );
  }

  setSetting("first_extraction_done", "1");
  console.log("[extractor] Extraction complete.");
}
