/**
 * Deterministic step runner — executes simple browser/shell steps without LLM.
 * Native-app clicks go through the AX tree (axDriver). Falls back to
 * vision/computer-use when a step needs coordinates or is ambiguous.
 */

import { execSync } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { clickElement } from "./axDriver";
import { checkAbort } from "./abort";

const AS_PATH = path.join(os.tmpdir(), "gw_step.applescript");

export interface StepRunResult {
  success: boolean;
  completedSteps: number;
  totalSteps: number;
  failedStep?: string;
  error?: string;
}

function runAppleScript(script: string): void {
  fs.writeFileSync(AS_PATH, script, "utf-8");
  try {
    execSync(`osascript "${AS_PATH}"`, { timeout: 15000 });
  } finally {
    try {
      fs.unlinkSync(AS_PATH);
    } catch {}
  }
}

function escapeAppleScriptString(s: string): string {
  return s.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

function normalizeUrl(raw: string): string {
  const trimmed = raw.trim().replace(/[.,;]+$/, "");
  if (/^https?:\/\//i.test(trimmed)) return trimmed;
  return `https://${trimmed}`;
}

function openUrlInBrowser(url: string): void {
  const u = escapeAppleScriptString(normalizeUrl(url));
  // Prefer Chrome; fall back to system default open.
  try {
    runAppleScript(`
tell application "Google Chrome"
  activate
  if (count of windows) = 0 then make new window
  set URL of active tab of front window to "${u}"
end tell`);
  } catch {
    execSync(`open "${normalizeUrl(url)}"`, { timeout: 10000 });
  }
}

function activateApp(appName: string): void {
  const name = escapeAppleScriptString(appName);
  runAppleScript(`tell application "${name}" to activate`);
}

function pressKey(name: "Return" | "Tab" | "Escape"): void {
  const codes: Record<string, number> = { Return: 36, Tab: 48, Escape: 53 };
  runAppleScript(
    `tell application "System Events" to key code ${codes[name]}`
  );
}

function typeLiteral(text: string): void {
  const clip = path.join(os.tmpdir(), "gw_step_clip.txt");
  fs.writeFileSync(clip, text, "utf-8");
  execSync(`cat "${clip}" | pbcopy`, { timeout: 5000 });
  try {
    fs.unlinkSync(clip);
  } catch {}
  runAppleScript(
    'tell application "System Events" to keystroke "v" using command down'
  );
}

/** AX-targeted native click: `click "Save" in Notes`. */
const AX_CLICK_RE = /^click\s+(?:button\s+|the\s+)?["'](.+?)["']\s+in\s+([\w .+-]+)$/i;

/** Steps we can run without vision (URL open, app switch, wait, keys, quoted text, AX clicks). */
export function isDeterministicStep(step: string): boolean {
  const lower = step.toLowerCase().trim();
  if (/^wait\s+\d/.test(lower)) return true;
  if (/^press\s+(enter|return|tab|escape)\b/.test(lower)) return true;
  if (/(?:open|navigate to|go to)\s+(?:https?:\/\/|\S+\.\w{2,})/.test(lower)) return true;
  if (/^(?:switch to|activate|focus on)\s+[a-z0-9 .+-]+$/i.test(lower)) return true;
  if (/^type\s+["'].+["']\s*$/i.test(step.trim())) return true;
  if (AX_CLICK_RE.test(step.trim())) return true;
  return false;
}

async function executeDeterministicStep(step: string): Promise<void> {
  const lower = step.toLowerCase().trim();

  const axMatch = step.trim().match(AX_CLICK_RE);
  if (axMatch) {
    const app = axMatch[2].trim().toLowerCase() === "chrome" ? "Google Chrome" : axMatch[2].trim();
    await clickElement(app, axMatch[1]);
    return;
  }

  const waitMatch = lower.match(/^wait\s+(\d+(?:\.\d+)?)\s*(?:s|sec|seconds)?$/);
  if (waitMatch) {
    execSync(`sleep ${waitMatch[1]}`);
    return;
  }

  if (/^press\s+enter\b/.test(lower) || /^press\s+return\b/.test(lower)) {
    pressKey("Return");
    return;
  }
  if (/^press\s+tab\b/.test(lower)) {
    pressKey("Tab");
    return;
  }
  if (/^press\s+escape\b/.test(lower)) {
    pressKey("Escape");
    return;
  }

  const urlMatch = step.match(
    /(?:open|navigate to|go to)\s+(https?:\/\/\S+|[^\s"']+\.\w{2,}(?:\/\S*)?)/i
  );
  if (urlMatch) {
    openUrlInBrowser(urlMatch[1]);
    return;
  }

  const appMatch = step.match(
    /^(?:switch to|activate|focus on|open)\s+(Google Chrome|Chrome|Safari|Arc|Firefox|LinkedIn)(?:\s+app)?$/i
  );
  if (appMatch) {
    const app = appMatch[1].toLowerCase() === "chrome" ? "Google Chrome" : appMatch[1];
    activateApp(app);
    return;
  }

  const typeMatch = step.match(/^type\s+["'](.+?)["']\s*$/i);
  if (typeMatch) {
    typeLiteral(typeMatch[1]);
    return;
  }

  throw new Error(`Unrecognized deterministic step: ${step}`);
}

/**
 * Run as many leading deterministic steps as possible.
 * Returns success=true only if ALL steps were deterministic and completed.
 */
export async function runDeterministicSteps(
  steps: string[],
  onStep?: (stepNum: number, action: string, detail?: string) => void
): Promise<StepRunResult> {
  if (steps.length === 0) {
    return { success: false, completedSteps: 0, totalSteps: 0, error: "No steps" };
  }

  let completed = 0;
  for (const step of steps) {
    checkAbort();
    if (!isDeterministicStep(step)) {
      return {
        success: false,
        completedSteps: completed,
        totalSteps: steps.length,
        failedStep: step,
        error: "Step needs vision/LLM",
      };
    }
    try {
      console.log(`[step-runner] ${completed + 1}/${steps.length}: ${step.slice(0, 80)}`);
      await executeDeterministicStep(step);
      completed++;
      onStep?.(completed, "deterministic", step.slice(0, 60));
      execSync("sleep 0.4");
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return {
        success: false,
        completedSteps: completed,
        totalSteps: steps.length,
        failedStep: step,
        error: msg,
      };
    }
  }

  return { success: true, completedSteps: completed, totalSteps: steps.length };
}
