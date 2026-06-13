/**
 * Pattern extraction job — runs every 60 minutes.
 *
 * Data sources (richest first):
 *  1. Screenpipe DB buildActivityText(): frames.full_text (~3.5 KB/frame) +
 *     typed text, clicks + audio transcriptions + clipboard events.
 *  2. Screenpipe DB queryRecentOcr(): OCR-only rows as fallback.
 *  3. Screenpipe REST API: last resort when DB is unavailable.
 *
 * Extraction uses 7 structured categories (Zoral-inspired):
 *   navigation, data_transform, communication, search_to_action,
 *   scheduled, multi_app, correction
 *
 * High prediction-error events (surprising moments) are prepended so the
 * LLM sees the most interesting activity first, regardless of truncation.
 *
 * All data is PII-stripped before being sent to the LLM.
 */

import { getRecentActivity, ContentItem } from "./screenpipe";
import { buildActivityText, queryRecentOcr, detectTopTerms } from "./screenpipeDb";
import { promptJSON } from "./openrouter";
import { upsertWorkflow, upsertRule, getSetting, setSetting, getDb } from "./db";
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
    .slice(0, 40_000);
}

// ─── Step grammar normaliser ──────────────────────────────────────────────────
// Maps loose LLM-generated step descriptions to the exact grammar that
// stepRunner.ts and skillEngine.ts can parse deterministically.

const SKIP_STEPS = /^(wait for|scroll down|wait until|look for|check if|make sure|ensure|verify)/i;

export function normaliseStep(raw: string): string | null {
  const s = raw.trim();

  // Drop steps that are vague instructions, not actions
  if (SKIP_STEPS.test(s)) return null;
  if (s.length < 4) return null;

  // navigate / open / go to → open <url>
  const navMatch = s.match(/^(?:navigate to|go to|open)\s+(https?:\/\/\S+|[a-z0-9][\w.-]+\.[a-z]{2,}(?:\/\S*)?)/i);
  if (navMatch) return `open ${navMatch[1].startsWith("http") ? navMatch[1] : "https://" + navMatch[1]}`;

  // switch to / activate / focus → switch to <App>
  const switchMatch = s.match(/^(?:switch to|activate|focus on?)\s+(.+)$/i);
  if (switchMatch) return `switch to ${switchMatch[1].trim()}`;

  // press enter/tab/escape
  if (/^press\s+(enter|return)\b/i.test(s)) return "press enter";
  if (/^press\s+tab\b/i.test(s)) return "press tab";
  if (/^press\s+escape\b/i.test(s)) return "press escape";

  // wait <N>s — normalise "wait for 2 seconds", "wait 2", etc.
  const waitMatch = s.match(/^wait\s+(\d+(?:\.\d+)?)/i);
  if (waitMatch) return `wait ${waitMatch[1]}s`;
  if (/^wait\s+a\s+(moment|second|bit)/i.test(s)) return "wait 1s";

  // type "..." — already quoted → pass through; bare type → skip if no value
  const typeMatch = s.match(/^type\s+"(.+)"$/i) ?? s.match(/^type\s+'(.+)'$/i);
  if (typeMatch) return `type "${typeMatch[1]}"`;
  // bare type without quotes — LLM didn't give a literal, too vague
  if (/^type\s+/i.test(s) && !/"/.test(s)) return null;

  // click "X" in App — native app clicks
  const nativeClick = s.match(/^click\s+(?:the\s+)?"([^"]+)"\s+in\s+(.+)$/i)
    ?? s.match(/^click\s+(?:on\s+)?(?:the\s+)?["']([^"']+)["']\s+in\s+(.+)$/i);
  if (nativeClick) return `click "${nativeClick[1]}" in ${nativeClick[2].trim()}`;

  // click "X" — button label only
  const quotedClick = s.match(/^click\s+(?:on\s+)?(?:the\s+)?"([^"]+)"$/i);
  if (quotedClick) return `click "${quotedClick[1]}"`;

  // click <description> — extract the meaningful noun phrase
  const bareClick = s.match(/^click\s+(?:on\s+)?(?:the\s+)?(.+)$/i);
  if (bareClick) {
    const label = bareClick[1]
      .replace(/\s+(button|link|icon|tab|item|field|option|checkbox|radio)\s*$/i, "")
      .trim();
    if (label.length >= 2 && label.length <= 80) return `click "${label}"`;
    return null;
  }

  // Pass through if it already matches the expected grammar
  if (/^(open https?:\/\/|switch to |click "|type "|press (enter|tab|escape)|wait \d)/i.test(s)) {
    return s;
  }

  return null; // Drop anything unrecognised
}

function normaliseSteps(steps: string[]): string[] {
  return steps.map(normaliseStep).filter((s): s is string => s !== null);
}

// ─── 7-category extraction prompt ─────────────────────────────────────────────

export type WorkflowCategory =
  | "navigation"
  | "data_transform"
  | "communication"
  | "search_to_action"
  | "scheduled"
  | "multi_app"
  | "correction";

interface ExtractedRule {
  condition: string;
  action: string;
  confidence: number;
  evidence: string[];
  steps: string[];
  category: WorkflowCategory;
}

interface ExtractedWorkflow {
  name: string;
  description: string;
  category: WorkflowCategory;
  steps: string[];
  confidence: number;
  rules: ExtractedRule[];
}

interface ExtractionResult {
  workflows: ExtractedWorkflow[];
}

function buildExtractionPrompt(activityText: string, focusCategories: string[] = []): string {
  const categoryInstruction = focusCategories.length > 0
    ? `Only extract workflows related to these topics: ${focusCategories.join(", ")}. Ignore all other activity.\n\n`
    : "";

  const profile = getBehaviourProfileText();
  const profileSection = profile
    ? `EXISTING BEHAVIOURAL PROFILE (avoid duplicating known patterns):\n${profile.slice(0, 1500)}\n\n`
    : "";

  return `${categoryInstruction}${profileSection}You are analysing a knowledge worker's computer activity.
Your task: extract repeating workflows and inferred behavioural rules, tagged by category.

ACTIVITY DATA:
${activityText}

Category definitions (assign the BEST fit — pick exactly one):
  navigation       URL sequences, tab switching, app switching habits
  data_transform   copy from X → paste/reformat into Y (e.g. copy email → paste into CRM)
  communication    what triggers the user to open email/Slack/messages and what they send
  search_to_action search for X → always ends with specific action Y
  scheduled        happens at the same time each day or after same trigger sequence
  multi_app        workflow that crosses two or more app boundaries
  correction       things the user repeatedly fixes, redoes, or undoes (high learning signal)

Return a JSON object with this exact schema:
{
  "workflows": [
    {
      "name": "short workflow name (3–6 words)",
      "description": "one sentence: what this workflow accomplishes",
      "category": "<one of the 7 categories above>",
      "steps": ["step 1", "step 2"],
      "confidence": 0.0,
      "rules": [
        {
          "condition": "observable screen state that triggers this (app, URL, page content)",
          "action": "what to do — specific and actionable",
          "category": "<same category as parent workflow>",
          "confidence": 0.0,
          "evidence": ["raw observation 1 (no PII)"],
          "steps": ["concrete step 1", "concrete step 2"]
        }
      ]
    }
  ]
}

Constraints:
- Only include workflows observed at least TWICE in the data
- Confidence: 0.3–0.5 for first observations, 0.6–0.8 for clearly repeated patterns
- "condition" must describe what is CURRENTLY VISIBLE on screen — not past or future state
- Steps use ONLY this exact grammar (machine-parsed, do not deviate):
    open <full-url>                   e.g. open https://linkedin.com/in/someone
    switch to <App Name>              e.g. switch to Google Chrome
    click "<label>"                   e.g. click "Connect"
    click "<label>" in <App>          native apps only, e.g. click "New Note" in Notes
    type "<literal text>"             e.g. type "operations manager fintech"
    press enter | press tab | press escape
    wait <N>s                         e.g. wait 2s
- Use {placeholder} ONLY inside type/click values for per-run variables
- If no patterns found, return {"workflows":[]}
- Strip all personal data (names, emails, phone numbers) from evidence strings`;
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

const DOMAIN_CATEGORY_HINTS: Record<string, string[]> = {
  "linkedin":   ["linkedin", "crm", "outreach"],
  "gmail":      ["email", "inbox"],
  "mail":       ["email", "inbox"],
  "salesforce": ["crm", "reporting"],
  "hubspot":    ["crm"],
  "notion":     ["reporting"],
  "airtable":   ["reporting", "crm"],
  "slack":      ["email", "inbox"],
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
      .filter(Boolean).join(" ").toLowerCase();

    if (keywords.some((kw) => haystack.includes(kw))) return true;

    const windowLower = (item.window_name ?? "").toLowerCase();
    for (const [domain, hints] of Object.entries(DOMAIN_CATEGORY_HINTS)) {
      if (windowLower.includes(domain) && hints.some((h) => keywords.includes(h))) return true;
    }

    return false;
  });
}

// ─── High-delta event prepending ──────────────────────────────────────────────
// Pull the most "surprising" raw events (high prediction_error) from the DB
// and prepend them as a short highlight section so the LLM sees them even if
// the full activity text gets truncated.

function buildHighDeltaSection(sinceIso: string, untilIso: string): string {
  try {
    const db = getDb();
    const rows = db.prepare(`
      SELECT ts, type, app, url, element_name, value, prediction_error
      FROM raw_events
      WHERE ts >= ? AND ts <= ?
        AND prediction_error >= 0.7
      ORDER BY prediction_error DESC
      LIMIT 20
    `).all(sinceIso, untilIso) as Array<{
      ts: string; type: string; app: string; url: string | null;
      element_name: string | null; value: string | null; prediction_error: number;
    }>;

    if (rows.length === 0) return "";

    const lines = rows.map((r) =>
      `[HIGH-SIGNAL Δ=${r.prediction_error.toFixed(2)}] ${r.ts.slice(11, 19)} ${r.type} in ${r.app}` +
      (r.url ? ` @ ${r.url.slice(0, 60)}` : "") +
      (r.element_name ? ` → "${r.element_name.slice(0, 40)}"` : "") +
      (r.value ? ` = "${r.value.slice(0, 60)}"` : "")
    );

    return `## High-Surprise Events (learn from these especially)\n${lines.join("\n")}\n\n`;
  } catch {
    return "";
  }
}

// ─── Extraction job ───────────────────────────────────────────────────────────

export async function runExtractionJob(): Promise<void> {
  console.log("[extractor] Starting pattern extraction …");

  const now = new Date();
  const since2h = new Date(now.getTime() - 2 * 3600_000).toISOString();
  const since6h = new Date(now.getTime() - 6 * 3600_000).toISOString();
  const nowIso = now.toISOString();

  // ── FTS pre-filter: detect top topics to focus extraction ─────────────────
  let topTerms: string[] = [];
  try {
    topTerms = await detectTopTerms(since2h, nowIso, 5);
    if (topTerms.length > 0) {
      console.log(`[extractor] FTS top terms: ${topTerms.join(", ")}`);
    }
  } catch { /* FTS not available */ }

  // ── Primary: Screenpipe DB buildActivityText ──────────────────────────────
  let activityText = buildActivityText(since2h, nowIso);

  if (!activityText || activityText.length < 200) {
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
      if (focusCategories.length > 0) items = filterByFocusCategories(items, focusCategories);
      activityText = sanitiseItems(items);
      console.log(`[extractor] REST fallback: ${items.length} items`);
    }
  }

  if (!activityText || activityText.length < 50) {
    console.log("[extractor] No activity data found — skipping.");
    return;
  }

  // ── Prepend high-delta events (Zoral: weight surprising moments) ──────────
  const highDelta = buildHighDeltaSection(since2h, nowIso);
  const combinedText = (highDelta + activityText).slice(0, 45_000);

  const focusCats = parseFocusCategories(getSetting("focus_categories", "[]"));
  // Merge FTS-detected top terms into focus categories for this extraction run.
  const allFocusCats = [...new Set([...focusCats, ...topTerms])];

  const result = await promptJSON<ExtractionResult>(
    buildExtractionPrompt(stripPII(combinedText), allFocusCats)
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
      const rawSteps = Array.isArray(rule.steps) ? rule.steps.filter(Boolean) : [];
      const steps = normaliseSteps(rawSteps);
      const category = rule.category ?? wf.category ?? "navigation";
      upsertRule(workflow.id, rule.condition, rule.action, rule.confidence, steps, category);
    }

    console.log(
      `[extractor]   ✓ "${wf.name}" [${wf.category}] — ${wf.rules?.length ?? 0} rules, confidence ${wf.confidence.toFixed(2)}`
    );
  }

  setSetting("first_extraction_done", "1");
  console.log("[extractor] Extraction complete.");
}
