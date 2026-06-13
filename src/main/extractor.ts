/**
 * Pattern extraction job — runs every 60 minutes.
 *
 * Data sources (richest first):
 *  1. Screenpipe DB buildActivityText(): frames.full_text (~3.5 KB/frame) +
 *     typed text, clicks + audio transcriptions + clipboard events.
 *  2. Screenpipe DB queryRecentOcr(): OCR-only rows as fallback.
 *  3. Screenpipe REST API: last resort when DB is unavailable.
 *
 * All data is PII-stripped before being sent to the LLM.
 */

import { getRecentActivity, ContentItem } from "./screenpipe";
import { buildActivityText, queryRecentOcr } from "./screenpipeDb";
import { promptJSON } from "./openrouter";
import { upsertWorkflow, upsertRule, getSetting, setSetting } from "./db";
import { getBehaviourProfileText } from "./behaviourProfile";

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
    .join("\n")
    .slice(0, 40_000); // keep prompt within reasonable input-token budget
}

// ─── Claude prompt ────────────────────────────────────────────────────────────

interface ExtractedRule {
  condition: string;
  action: string;
  confidence: number;
  evidence: string[];
  /** Concrete executable steps, e.g. ["open linkedin.com", "search for {job title}"] */
  steps: string[];
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

function buildExtractionPrompt(activityText: string, focusCategories: string[] = []): string {
  const categoryInstruction = focusCategories.length > 0
    ? `Only extract workflows related to these categories: ${focusCategories.join(", ")}. Ignore all other activity entirely.\n\n`
    : "";

  const profile = getBehaviourProfileText();
  const profileSection = profile
    ? `EXISTING BEHAVIOURAL PROFILE (use this to avoid duplicating known patterns):\n${profile.slice(0, 2000)}\n\n`
    : "";

  return `${categoryInstruction}${profileSection}You are analysing a knowledge worker's computer activity from the last 2 hours.
Your task: extract repeating workflows and inferred behavioural rules.

The activity data below combines:
- [SCREEN] sections: full page accessibility text + OCR (~3.5 KB per frame capture)
- User actions: exact keystrokes typed and UI elements clicked with timestamps
- [MIC]/[AUDIO]: spoken words transcribed from microphone or system audio
- CLIPBOARD: text that was copied or pasted (high-signal intent indicator)

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
          "evidence": ["raw observation 1", "raw observation 2"],
          "steps": ["concrete step 1", "concrete step 2", "concrete step 3"]
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
- Focus on app-switching patterns, repeated sequences, conditional behaviours
- "condition" must describe an observable screen state (app, website, page content) so it can be checked against what's on screen right now
- "steps" must use ONLY this exact step grammar, one action per step (this is machine-parsed — do not deviate):
    open <full-url>                  e.g. "open https://www.linkedin.com/search/results/people/?keywords=operations%20manager"
    switch to <App Name>             e.g. "switch to Google Chrome"
    click <element description>      e.g. "click the Connect button on the first profile result"
    click "<button name>" in <App>   for NATIVE apps only, e.g. "click \\"New Note\\" in Notes"
    type "<literal text>"            e.g. "type \\"operations manager fintech\\""
    press enter | press tab | press escape
    wait <N>s                        e.g. "wait 2s"
  URLs must be complete (include https:// and the full path/query observed). Use {braces} placeholders only inside type/click text for values that vary per run, e.g. "type \\"{job_title}\\""`;
}

// ─── Focus category helpers ───────────────────────────────────────────────────

export function parseFocusCategories(raw: string): string[] {
  try {
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed) ? (parsed as string[]).filter(Boolean) : [];
  } catch {
    return [];
  }
}

// Well-known domain → category keyword mappings so URL-based activity isn't
// filtered out just because the OCR text didn't happen to contain the keyword.
const DOMAIN_CATEGORY_HINTS: Record<string, string[]> = {
  "linkedin":  ["linkedin", "crm", "outreach"],
  "gmail":     ["email", "inbox"],
  "mail":      ["email", "inbox"],
  "salesforce":["crm", "reporting"],
  "hubspot":   ["crm"],
  "notion":    ["reporting"],
  "airtable":  ["reporting", "crm"],
  "slack":     ["email", "inbox"],
};

function focusCategoryKeywords(categories: string[]): string[] {
  return categories.flatMap((cat) =>
    cat.toLowerCase().split(/[\s&,]+/).filter((w) => w.length > 2)
  );
}

function filterByFocusCategories(items: ContentItem[], categories: string[]): ContentItem[] {
  const keywords = focusCategoryKeywords(categories);
  if (keywords.length === 0) return items;

  return items.filter((item) => {
    const haystack = [item.app_name, item.window_name, item.text?.slice(0, 500)]
      .filter(Boolean)
      .join(" ")
      .toLowerCase();

    if (keywords.some((kw) => haystack.includes(kw))) return true;

    // Domain-hint fallback: if the window title contains a known service name
    // and that service maps to one of our focus categories, keep the item.
    const windowLower = (item.window_name ?? "").toLowerCase();
    for (const [domain, hints] of Object.entries(DOMAIN_CATEGORY_HINTS)) {
      if (windowLower.includes(domain) && hints.some((h) => keywords.includes(h))) {
        return true;
      }
    }

    return false;
  });
}

// ─── Extraction job ───────────────────────────────────────────────────────────

export async function runExtractionJob(): Promise<void> {
  console.log("[extractor] Starting pattern extraction …");

  const now = new Date();
  const since2h = new Date(now.getTime() - 2 * 3600_000).toISOString();
  const since6h = new Date(now.getTime() - 6 * 3600_000).toISOString();
  const nowIso = now.toISOString();

  // ── Primary: Screenpipe DB buildActivityText ──────────────────────────────
  // Combines frames.full_text (~3.5 KB/frame), typed events, audio, clipboard.
  let activityText = buildActivityText(since2h, nowIso);

  if (!activityText || activityText.length < 200) {
    // Expand window if recent activity is sparse
    activityText = buildActivityText(since6h, nowIso);
    if (activityText.length >= 200) {
      console.log("[extractor] Using 6-hour window from Screenpipe DB");
    }
  } else {
    console.log(`[extractor] Using 2-hour window from Screenpipe DB (${activityText.length} chars)`);
  }

  // ── Fallback: OCR-only rows ───────────────────────────────────────────────
  if (!activityText || activityText.length < 100) {
    const ocrRows = queryRecentOcr(since6h, nowIso, 120);
    if (ocrRows.length >= 3) {
      activityText = ocrRows
        .map((r) =>
          `[OCR] ${r.app_name} / ${r.window_name}${r.browser_url ? ` (${r.browser_url})` : ""}: ${r.text.slice(0, 300)}`
        )
        .join("\n");
      console.log(`[extractor] Fallback: ${ocrRows.length} OCR rows from Screenpipe DB`);
    }
  }

  // ── Last resort: Screenpipe REST API ─────────────────────────────────────
  let items: ContentItem[] = [];
  if (!activityText || activityText.length < 100) {
    const excludedAppsRaw = getSetting("excluded_apps", "[]");
    let excludedApps: string[] = [];
    try { excludedApps = JSON.parse(excludedAppsRaw) as string[]; } catch { /* */ }

    try {
      items = await getRecentActivity(2, excludedApps, 100);
      if (items.length === 0) items = await getRecentActivity(6, excludedApps, 100);
    } catch (err) {
      console.warn("[extractor] Could not fetch Screenpipe REST data:", err);
    }

    if (items.length > 0) {
      const focusCategories = parseFocusCategories(getSetting("focus_categories", "[]"));
      if (focusCategories.length > 0) {
        items = filterByFocusCategories(items, focusCategories);
      }
      activityText = sanitiseItems(items);
      console.log(`[extractor] REST fallback: ${items.length} items`);
    }
  }

  if (!activityText || activityText.length < 50) {
    console.log("[extractor] No activity data found — skipping.");
    return;
  }

  const focusCats = parseFocusCategories(getSetting("focus_categories", "[]"));
  const result = await promptJSON<ExtractionResult>(
    buildExtractionPrompt(stripPII(activityText), focusCats)
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
      const steps = Array.isArray(rule.steps) ? rule.steps.filter(Boolean) : [];
      upsertRule(workflow.id, rule.condition, rule.action, rule.confidence, steps);
    }

    console.log(
      `[extractor]   ✓ "${wf.name}" — ${wf.rules?.length ?? 0} rules, confidence ${wf.confidence.toFixed(2)}`
    );
  }

  setSetting("first_extraction_done", "1");
  console.log("[extractor] Extraction complete.");
}
