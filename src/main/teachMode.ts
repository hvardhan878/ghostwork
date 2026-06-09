/**
 * Teach Mode — record once, replay forever.
 *
 * The user hits Record, performs the task in their own Chrome, hits Stop.
 * A recorder script (injected over CDP into every page) captures each click,
 * input and Enter press WITH ranked locators computed at interaction time.
 * On stop, the event stream is coalesced into SkillSteps, an LLM names the
 * skill and flags externally visible steps, and the result is frozen as a
 * taught skill — the same format ambient learning compiles into.
 */

import { BrowserContext, Page } from "playwright-core";
import { getContext } from "./browserDriver";
import { createSkill, Skill, SkillStep } from "./db";
import { promptJSON } from "./openrouter";
import { setGhostState } from "./ghostState";

const PLANNER_MODEL = "anthropic/claude-sonnet-4-5";

interface TeachEvent {
  type: "click" | "input" | "enter" | "navigate";
  url: string;
  role?: string;
  name?: string;
  locators?: SkillStep["locators"];
  value?: string;
  /** Stable per-element key for input coalescing. */
  elementKey?: string;
  ts: number;
}

let teaching = false;
let events: TeachEvent[] = [];
let teachContext: BrowserContext | null = null;
let pageListeners: Array<{ page: Page; handler: (...args: never[]) => void }> = [];

export function isTeaching(): boolean {
  return teaching;
}

// Recorder injected into pages. Computes ranked locators at interaction time —
// the moment of truth, when the element is definitely correct.
const RECORDER_JS = `
(() => {
  if (window.__gwTeachInstalled) { window.__gwTeachActive = true; return; }
  window.__gwTeachInstalled = true;
  window.__gwTeachActive = true;

  const accName = (el) => {
    const aria = el.getAttribute && el.getAttribute('aria-label');
    if (aria) return aria.trim();
    const ph = el.getAttribute && el.getAttribute('placeholder');
    if (ph) return ph.trim();
    if (el.labels && el.labels.length) {
      const t = Array.from(el.labels).map(l => l.textContent || '').join(' ').trim();
      if (t) return t;
    }
    const txt = ((el.innerText || el.value || '') + '').trim().replace(/\\s+/g, ' ');
    return txt.slice(0, 80);
  };

  const computedRole = (el) => {
    const explicit = el.getAttribute && el.getAttribute('role');
    if (explicit) return explicit;
    const tag = el.tagName ? el.tagName.toLowerCase() : '';
    if (tag === 'a') return 'link';
    if (tag === 'button') return 'button';
    if (tag === 'select') return 'combobox';
    if (tag === 'textarea') return 'textbox';
    if (tag === 'input') {
      const t = (el.getAttribute('type') || 'text').toLowerCase();
      if (['button','submit','reset'].includes(t)) return 'button';
      if (t === 'checkbox') return 'checkbox';
      if (t === 'search') return 'searchbox';
      return 'textbox';
    }
    if (el.isContentEditable) return 'textbox';
    return 'generic';
  };

  const cssPath = (el) => {
    if (el.id && !/^[0-9]/.test(el.id)) return '#' + CSS.escape(el.id);
    const dt = el.getAttribute('data-testid') || el.getAttribute('data-test-id');
    if (dt) return '[data-testid="' + dt.replace(/"/g, '\\\\"') + '"]';
    const parts = [];
    let cur = el;
    for (let depth = 0; cur && cur !== document.body && depth < 4; depth++) {
      let part = cur.tagName.toLowerCase();
      const cls = Array.from(cur.classList || []).filter(c => /^[a-zA-Z][\\w-]{2,30}$/.test(c)).slice(0, 2);
      if (cls.length) part += '.' + cls.map(c => CSS.escape(c)).join('.');
      const parent = cur.parentElement;
      if (parent) {
        const sibs = Array.from(parent.children).filter(s => s.tagName === cur.tagName);
        if (sibs.length > 1) part += ':nth-of-type(' + (sibs.indexOf(cur) + 1) + ')';
      }
      parts.unshift(part);
      cur = parent;
    }
    return parts.join(' > ');
  };

  const lociFor = (el) => {
    const role = computedRole(el);
    const name = accName(el);
    const locators = [];
    if (role !== 'generic' && name) locators.push({ kind: 'role', value: role, name: name.slice(0, 100) });
    const dt = el.getAttribute('data-testid') || el.getAttribute('data-test-id');
    if (dt) locators.push({ kind: 'testid', value: dt });
    const aria = el.getAttribute('aria-label');
    if (aria) locators.push({ kind: 'aria', value: aria });
    locators.push({ kind: 'css', value: cssPath(el) });
    const txt = ((el.innerText || '') + '').trim().replace(/\\s+/g, ' ');
    if (txt && txt.length >= 2 && txt.length <= 60) locators.push({ kind: 'text', value: txt });
    return { role, name, locators };
  };

  const interactive = (el) => {
    while (el && el !== document.body) {
      const tag = el.tagName ? el.tagName.toLowerCase() : '';
      if (['a','button','input','select','textarea'].includes(tag)) return el;
      if (el.getAttribute && (el.getAttribute('role') || el.isContentEditable || el.onclick)) return el;
      el = el.parentElement;
    }
    return null;
  };

  const emit = (payload) => {
    try { window.__gwTeachEmit(JSON.stringify(payload)); } catch (e) {}
  };

  document.addEventListener('click', (ev) => {
    if (!window.__gwTeachActive) return;
    const el = interactive(ev.target);
    if (!el) return;
    const tag = el.tagName.toLowerCase();
    // Typing targets are recorded via input events, not clicks.
    if (['input','textarea'].includes(tag) && !['button','submit','checkbox','radio'].includes((el.getAttribute('type')||'').toLowerCase())) return;
    if (el.isContentEditable) return;
    const meta = lociFor(el);
    emit({ type: 'click', url: location.href, ...meta, ts: Date.now() });
  }, true);

  const inputHandler = (ev) => {
    if (!window.__gwTeachActive) return;
    const el = ev.target;
    if (!el || !(el.tagName)) return;
    const tag = el.tagName.toLowerCase();
    if (!['input','textarea'].includes(tag) && !el.isContentEditable) return;
    const meta = lociFor(el);
    const value = el.isContentEditable ? (el.innerText || '') : (el.value || '');
    emit({ type: 'input', url: location.href, ...meta, value: value.slice(0, 2000), elementKey: meta.locators.map(l => l.kind + ':' + l.value).join('|'), ts: Date.now() });
  };
  document.addEventListener('input', inputHandler, true);

  document.addEventListener('keydown', (ev) => {
    if (!window.__gwTeachActive) return;
    if (ev.key !== 'Enter') return;
    emit({ type: 'enter', url: location.href, ts: Date.now() });
  }, true);
})()
`;

async function injectIntoPage(page: Page): Promise<void> {
  await page.evaluate(RECORDER_JS).catch(() => {});
  const navHandler = () => {
    if (!teaching) return;
    events.push({ type: "navigate", url: page.url(), ts: Date.now() });
    // Re-inject after navigation (init script covers new docs; this is belt and braces).
    setTimeout(() => void page.evaluate(RECORDER_JS).catch(() => {}), 500);
  };
  page.on("framenavigated", (frame) => {
    if (frame === page.mainFrame()) navHandler();
  });
  pageListeners.push({ page, handler: navHandler as never });
}

export async function startTeaching(): Promise<{ ok: boolean; error?: string }> {
  if (teaching) return { ok: true };
  try {
    const context = await getContext();
    teachContext = context;
    events = [];
    pageListeners = [];

    try {
      await context.exposeBinding("__gwTeachEmit", (_source, raw: string) => {
        if (!teaching) return;
        try {
          const ev = JSON.parse(raw) as TeachEvent;
          events.push(ev);
          console.log(`[teach] ${ev.type}${ev.name ? ` "${ev.name.slice(0, 40)}"` : ""}`);
        } catch {}
      });
    } catch {
      // Binding already registered from a previous session — fine.
    }

    await context.addInitScript(RECORDER_JS).catch(() => {});

    teaching = true;
    for (const page of context.pages()) {
      if (page.url().startsWith("devtools://")) continue;
      await injectIntoPage(page);
    }
    context.on("page", (page) => {
      if (teaching) void injectIntoPage(page);
    });

    setGhostState("recording");
    console.log("[teach] Recording started — perform the task in Chrome, then hit Stop");
    return { ok: true };
  } catch (err) {
    teaching = false;
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, error: msg };
  }
}

function coalesceEvents(raw: TeachEvent[]): SkillStep[] {
  const steps: SkillStep[] = [];
  // Keep only the final input value per element (user typed char by char).
  const lastInputByKey = new Map<string, number>();
  raw.forEach((ev, i) => {
    if (ev.type === "input" && ev.elementKey) lastInputByKey.set(ev.elementKey, i);
  });

  let lastUrl = "";
  raw.forEach((ev, i) => {
    switch (ev.type) {
      case "navigate": {
        if (!ev.url || ev.url === "about:blank" || ev.url === lastUrl) return;
        // Skip navigations caused by clicks (the click step triggers them on replay).
        const prev = raw[i - 1];
        if (prev && (prev.type === "click" || prev.type === "enter") && ev.ts - prev.ts < 3000) {
          lastUrl = ev.url;
          return;
        }
        lastUrl = ev.url;
        steps.push({
          action: "navigate",
          url: ev.url,
          description: `Open ${ev.url.slice(0, 80)}`,
        });
        return;
      }
      case "click":
        steps.push({
          action: "click",
          description: `Click ${ev.role ?? "element"} "${(ev.name ?? "").slice(0, 60)}"`,
          role: ev.role,
          name: ev.name,
          locators: ev.locators,
        });
        return;
      case "input": {
        if (ev.elementKey && lastInputByKey.get(ev.elementKey) !== i) return;
        steps.push({
          action: "fill",
          description: `Type into ${ev.role ?? "field"} "${(ev.name ?? "").slice(0, 50)}"`,
          role: ev.role,
          name: ev.name,
          locators: ev.locators,
          value: ev.value ?? "",
        });
        return;
      }
      case "enter": {
        // Drop Enter presses inside multi-line fields captured as input anyway.
        steps.push({ action: "press", value: "Enter", description: "Press Enter" });
        return;
      }
    }
  });

  // If recording started mid-page, anchor the replay with a navigate step.
  if (steps.length > 0 && steps[0].action !== "navigate") {
    const firstUrl = raw.find((e) => e.url && e.url !== "about:blank")?.url;
    if (firstUrl) {
      steps.unshift({ action: "navigate", url: firstUrl, description: `Open ${firstUrl.slice(0, 80)}` });
    }
  }

  return steps;
}

const EXTERNAL_HINT = /send|submit|post|connect|invite|apply|publish|reply|share|confirm order|buy/i;

export async function stopTeaching(): Promise<{
  ok: boolean;
  skill?: Skill;
  steps?: number;
  error?: string;
}> {
  if (!teaching) return { ok: false, error: "Not recording" };
  teaching = false;
  setGhostState("observing");

  // Deactivate recorders.
  if (teachContext) {
    for (const page of teachContext.pages()) {
      void page.evaluate("window.__gwTeachActive = false").catch(() => {});
    }
  }
  for (const { page, handler } of pageListeners) {
    try {
      page.off("framenavigated", handler as never);
    } catch {}
  }
  pageListeners = [];

  const steps = coalesceEvents(events);
  console.log(`[teach] Recording stopped — ${events.length} events → ${steps.length} steps`);
  events = [];

  if (steps.length === 0) {
    return { ok: false, error: "No interactions recorded. Perform the task in Chrome while recording." };
  }

  // LLM pass: name the skill, clean descriptions, flag external steps.
  let name = `Taught skill — ${new Date().toLocaleString()}`;
  try {
    const review = await promptJSON<{
      name: string;
      steps: Array<{ index: number; description?: string; external?: boolean }>;
    }>(
      `A user demonstrated a workflow in their browser. Review the recorded steps.

Steps:
${steps.map((s, i) => `${i}: [${s.action}] ${s.description}${s.value ? ` (value: "${s.value.slice(0, 60)}")` : ""}${s.url ? ` (${s.url.slice(0, 80)})` : ""}`).join("\n")}

Reply with JSON:
{
  "name": "short workflow name (3-6 words)",
  "steps": [{"index": 0, "description": "cleaned short description", "external": false}, …]
}
Mark "external": true ONLY for steps with externally visible side effects (sending a message/invite/email, posting, submitting an application or order). Searching, navigating and typing drafts are NOT external.`,
      PLANNER_MODEL,
      2048
    );
    if (review?.name) name = review.name.slice(0, 120);
    for (const r of review?.steps ?? []) {
      const s = steps[r.index];
      if (!s) continue;
      if (r.description) s.description = r.description.slice(0, 140);
      if (r.external != null) s.external = r.external;
    }
  } catch {
    // Heuristic fallback for external flags.
    for (const s of steps) {
      if (EXTERNAL_HINT.test(`${s.description} ${s.name ?? ""}`)) s.external = true;
    }
  }

  const skill = createSkill(name, steps, "taught");
  console.log(`[teach] Skill #${skill.id} "${name}" saved (${steps.length} steps)`);
  return { ok: true, skill, steps: steps.length };
}
