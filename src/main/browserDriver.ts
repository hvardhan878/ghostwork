/**
 * Browser driver — CDP connection to the user's REAL Chrome profile.
 *
 * Why the real Chrome: logged-in sessions, real fingerprint, no bot flags
 * (LinkedIn/Gmail block fresh automated browsers). We attach over the
 * DevTools protocol; if Chrome isn't exposing it, we relaunch it once with
 * --remote-debugging-port (managed, graceful).
 *
 * Perception is DOM/AX-tree first: snapshotInteractive() returns a compact,
 * token-cheap list of interactive elements with RANKED locators per element
 * (role → data-testid → aria-label → css → text). Vision is never used here —
 * the pixel stack in computerUse.ts remains the separate fallback substrate.
 */

import { execSync } from "child_process";
import * as path from "path";
import * as os from "os";
import { chromium, Browser, BrowserContext, Page, Locator } from "playwright-core";

const CDP_PORT = 9333;
const CDP_URL = `http://127.0.0.1:${CDP_PORT}`;

/**
 * Chrome ≥136 blocks --remote-debugging-port on the DEFAULT user-data-dir
 * (security hardening, March 2025). The production pattern: a persistent
 * dedicated profile. Real Chrome binary, real fingerprint, logins persist
 * after a one-time sign-in — and it runs alongside the user's main Chrome
 * without quitting it.
 */
const PROFILE_DIR = path.join(
  os.homedir(),
  "Library",
  "Application Support",
  "Ghostwork",
  "ChromeProfile"
);

export class ChromeUnavailableError extends Error {
  constructor(msg: string) {
    super(msg);
    this.name = "ChromeUnavailableError";
  }
}

// ─── Locators ─────────────────────────────────────────────────────────────────

export type LocatorKind = "role" | "testid" | "aria" | "css" | "text";

export interface RankedLocator {
  kind: LocatorKind;
  /** For role: the ARIA role. For others: the selector/label/text value. */
  value: string;
  /** Accessible name (role locators only). */
  name?: string;
}

export interface SnapshotElement {
  ref: number;
  role: string;
  name: string;
  tag: string;
  /** Ranked locator candidates, most stable first. */
  locators: RankedLocator[];
  /** Truncated visible text (context for the LLM). */
  text: string;
}

export interface PageSnapshot {
  url: string;
  title: string;
  elements: SnapshotElement[];
  /** Compact text rendering for LLM prompts (one line per element). */
  asText: string;
}

// ─── Connection management ────────────────────────────────────────────────────

let _browser: Browser | null = null;

async function cdpAlive(): Promise<boolean> {
  try {
    const res = await fetch(`${CDP_URL}/json/version`, {
      signal: AbortSignal.timeout(800),
    });
    return res.ok;
  } catch {
    return false;
  }
}

async function waitFor(cond: () => Promise<boolean> | boolean, timeoutMs: number, intervalMs = 300): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await cond()) return true;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  return false;
}

/**
 * Make sure the Ghostwork Chrome instance is running with the CDP port open.
 * Launches the real Chrome binary against Ghostwork's persistent profile —
 * runs alongside the user's main Chrome without disturbing it.
 */
export async function ensureChromeCDP(): Promise<void> {
  if (await cdpAlive()) return;

  console.log("[browser] Launching Ghostwork Chrome (persistent profile, CDP enabled)…");
  execSync(
    `open -na "Google Chrome" --args ` +
      `--user-data-dir="${PROFILE_DIR}" ` +
      `--remote-debugging-port=${CDP_PORT} ` +
      `--no-first-run --no-default-browser-check --restore-last-session`,
    { timeout: 10000 }
  );

  const up = await waitFor(() => cdpAlive(), 20000, 400);
  if (!up) {
    throw new ChromeUnavailableError("Chrome CDP endpoint did not come up on port " + CDP_PORT);
  }
  console.log("[browser] Chrome CDP ready");
}

/** connectOverCDP fails against a zero-tab Chrome — make sure one exists. */
async function ensureAtLeastOneTab(): Promise<void> {
  try {
    const res = await fetch(`${CDP_URL}/json/list`, { signal: AbortSignal.timeout(2000) });
    const targets = (await res.json()) as Array<{ type: string }>;
    if (!targets.some((t) => t.type === "page")) {
      await fetch(`${CDP_URL}/json/new?about:blank`, {
        method: "PUT",
        signal: AbortSignal.timeout(3000),
      });
    }
  } catch {}
}

export async function getBrowser(): Promise<Browser> {
  if (_browser?.isConnected()) return _browser;
  await ensureChromeCDP();
  await ensureAtLeastOneTab();
  _browser = await chromium.connectOverCDP(CDP_URL, { timeout: 10000 });
  _browser.on("disconnected", () => {
    _browser = null;
  });
  return _browser;
}

export async function getContext(): Promise<BrowserContext> {
  const browser = await getBrowser();
  const contexts = browser.contexts();
  if (contexts.length === 0) {
    throw new ChromeUnavailableError("No browser context available over CDP");
  }
  return contexts[0];
}

/** Is the driver usable right now (without forcing a relaunch)? */
export async function isAvailable(): Promise<boolean> {
  return cdpAlive();
}

// ─── Page management ──────────────────────────────────────────────────────────

/**
 * Get a page for the task. Prefers an existing tab already on the target
 * domain; otherwise opens a new background tab (does not steal OS focus —
 * the user keeps typing wherever they are).
 */
export async function getOrCreatePage(urlHint?: string): Promise<Page> {
  const context = await getContext();
  const pages = context.pages().filter((p) => !p.url().startsWith("devtools://"));

  if (urlHint) {
    const hintHost = safeHost(urlHint);
    if (hintHost) {
      const existing = pages.find((p) => safeHost(p.url()) === hintHost);
      if (existing) return existing;
    }
  }

  const page = await context.newPage();
  if (urlHint) {
    await page.goto(normalizeUrl(urlHint), { waitUntil: "domcontentloaded", timeout: 30000 });
  }
  return page;
}

export function normalizeUrl(raw: string): string {
  const trimmed = raw.trim().replace(/[.,;]+$/, "");
  if (/^https?:\/\//i.test(trimmed)) return trimmed;
  return `https://${trimmed}`;
}

function safeHost(url: string): string {
  try {
    return new URL(normalizeUrl(url)).hostname.replace(/^www\./, "");
  } catch {
    return "";
  }
}

// ─── Perception: interactive-element snapshot ────────────────────────────────

const SNAPSHOT_JS = `
(() => {
  const MAX = 150;
  const results = [];
  const seen = new Set();

  // DOM-first perception: include the whole page, not just the viewport.
  // Actions auto-scroll to their target, so off-screen elements are actionable.
  const isVisible = (el) => {
    const r = el.getBoundingClientRect();
    if (r.width < 2 || r.height < 2) return false;
    const style = getComputedStyle(el);
    if (style.visibility === 'hidden' || style.display === 'none' || style.opacity === '0') return false;
    return true;
  };

  const accName = (el) => {
    const aria = el.getAttribute('aria-label');
    if (aria) return aria.trim();
    const labelled = el.getAttribute('aria-labelledby');
    if (labelled) {
      const t = labelled.split(/\\s+/).map(id => document.getElementById(id)?.textContent || '').join(' ').trim();
      if (t) return t;
    }
    if (el.labels && el.labels.length) {
      const t = Array.from(el.labels).map(l => l.textContent || '').join(' ').trim();
      if (t) return t;
    }
    const ph = el.getAttribute('placeholder');
    if (ph) return ph.trim();
    const title = el.getAttribute('title');
    if (title) return title.trim();
    const alt = el.getAttribute('alt');
    if (alt) return alt.trim();
    const txt = (el.innerText || el.value || '').trim().replace(/\\s+/g, ' ');
    if (txt) return txt.slice(0, 80);
    const nm = el.getAttribute('name');
    if (nm) return nm.trim();
    return '';
  };

  const computedRole = (el) => {
    const explicit = el.getAttribute('role');
    if (explicit) return explicit;
    const tag = el.tagName.toLowerCase();
    if (tag === 'a' && el.hasAttribute('href')) return 'link';
    if (tag === 'button') return 'button';
    if (tag === 'select') return 'combobox';
    if (tag === 'textarea') return 'textbox';
    if (tag === 'input') {
      const t = (el.getAttribute('type') || 'text').toLowerCase();
      if (['button','submit','reset'].includes(t)) return 'button';
      if (t === 'checkbox') return 'checkbox';
      if (t === 'radio') return 'radio';
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
    // short structural path (max 3 ancestors)
    const parts = [];
    let cur = el;
    for (let depth = 0; cur && cur !== document.body && depth < 4; depth++) {
      let part = cur.tagName.toLowerCase();
      if (cur.id && !/^[0-9]/.test(cur.id)) { parts.unshift('#' + CSS.escape(cur.id) + (depth === 0 ? '' : ' ' + parts.shift() || '')); cur = null; break; }
      const cls = Array.from(cur.classList).filter(c => /^[a-zA-Z][\\w-]{2,30}$/.test(c)).slice(0, 2);
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

  const selector = 'a[href], button, input, select, textarea, [role="button"], [role="link"], [role="tab"], [role="menuitem"], [role="option"], [role="checkbox"], [role="combobox"], [role="textbox"], [contenteditable="true"], [onclick]';
  const all = Array.from(document.querySelectorAll(selector));

  // Form controls and buttons are scarce and high-value; links are plentiful
  // and repetitive. Under the cap, controls always make the cut — otherwise a
  // long list page crowds out the one input that matters.
  const isControl = (el) => {
    const tag = el.tagName.toLowerCase();
    return ['input','select','textarea','button'].includes(tag) || el.isContentEditable ||
      ['button','combobox','textbox','checkbox','searchbox'].includes(el.getAttribute('role') || '');
  };
  const controls = all.filter(isControl);
  const rest = all.filter(el => !isControl(el));
  const els = controls.slice(0, MAX).concat(rest.slice(0, Math.max(0, MAX - Math.min(controls.length, MAX))));

  let ref = 0;
  for (const el of els) {
    if (results.length >= MAX) break;
    if (!isVisible(el)) continue;
    if (seen.has(el)) continue;
    seen.add(el);

    const role = computedRole(el);
    const name = accName(el);
    if (!name && role === 'generic') continue;

    const locators = [];
    if (role !== 'generic' && name) locators.push({ kind: 'role', value: role, name: name.slice(0, 100) });
    const dt = el.getAttribute('data-testid') || el.getAttribute('data-test-id');
    if (dt) locators.push({ kind: 'testid', value: dt });
    const aria = el.getAttribute('aria-label');
    if (aria) locators.push({ kind: 'aria', value: aria });
    locators.push({ kind: 'css', value: cssPath(el) });
    const txt = (el.innerText || '').trim().replace(/\\s+/g, ' ');
    if (txt && txt.length >= 2 && txt.length <= 60) locators.push({ kind: 'text', value: txt });

    ref += 1;
    results.push({
      ref,
      role,
      name: name.slice(0, 100),
      tag: el.tagName.toLowerCase(),
      locators,
      text: txt.slice(0, 100),
    });
  }
  return results;
})()
`;

export async function snapshotInteractive(page: Page): Promise<PageSnapshot> {
  const elements = (await page.evaluate(SNAPSHOT_JS)) as SnapshotElement[];
  const lines = elements.map((e) => {
    const label = e.name && e.name !== e.text ? `"${e.name}"` : `"${e.text || e.name}"`;
    return `[${e.ref}] ${e.role} ${label}`;
  });
  return {
    url: page.url(),
    title: await page.title().catch(() => ""),
    elements,
    asText: lines.join("\n"),
  };
}

// ─── Locator resolution (ranked, self-heal-friendly) ─────────────────────────

function buildLocator(page: Page, loc: RankedLocator): Locator {
  switch (loc.kind) {
    case "role":
      // Exact name match — recorded from the live element, so it matches on
      // replay. Substring matching is dangerous ("new" matches "Hacker News");
      // fuzzy matching belongs to the heal tier, not here.
      return page.getByRole(loc.value as never, { name: loc.name, exact: true }).first();
    case "testid":
      return page.locator(`[data-testid="${cssEscapeAttr(loc.value)}"], [data-test-id="${cssEscapeAttr(loc.value)}"]`).first();
    case "aria":
      return page.locator(`[aria-label="${cssEscapeAttr(loc.value)}"]`).first();
    case "css":
      return page.locator(loc.value).first();
    case "text":
      return page.getByText(loc.value, { exact: true }).first();
  }
}

function cssEscapeAttr(v: string): string {
  return v.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

export interface ResolveResult {
  locator: Locator;
  used: RankedLocator;
}

/**
 * Try the ranked locator list; return the first that resolves to a visible
 * element. This is the cheap (<1s, no-LLM) self-healing primitive — when the
 * top locator drifts, a lower-ranked one usually still matches.
 */
export async function resolveRanked(
  page: Page,
  locators: RankedLocator[],
  perLocatorTimeoutMs = 1200
): Promise<ResolveResult | null> {
  for (const loc of locators) {
    try {
      const candidate = buildLocator(page, loc);
      await candidate.waitFor({ state: "visible", timeout: perLocatorTimeoutMs });
      return { locator: candidate, used: loc };
    } catch {
      // try the next ranked locator
    }
  }
  return null;
}

/**
 * Deeper self-heal: re-snapshot the live DOM and fuzzy-match the element by
 * its recorded role + name/description. Still no LLM.
 */
export async function healLocator(
  page: Page,
  role: string,
  nameHint: string
): Promise<SnapshotElement | null> {
  const snap = await snapshotInteractive(page);
  const hint = nameHint.toLowerCase().trim();
  if (!hint) return null;
  const scored = snap.elements
    .filter((el) => el.name.trim().length > 0)
    .map((el) => {
      let score = 0;
      const elName = el.name.toLowerCase();
      if (el.role === role) score += 2;
      if (elName === hint) score += 5;
      else if (elName.includes(hint) || hint.includes(elName)) score += 3;
      else {
        const hintWords = hint.split(/\s+/).filter((w) => w.length > 2);
        const matches = hintWords.filter((w) => elName.includes(w)).length;
        score += matches;
      }
      return { el, score };
    })
    .filter((s) => s.score >= 3)
    .sort((a, b) => b.score - a.score);

  return scored[0]?.el ?? null;
}
