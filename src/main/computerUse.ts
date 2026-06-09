/**
 * Hybrid computer-use executor.
 *
 * 1. Deterministic steps (URLs, app switch, keys) via stepRunner — no LLM.
 * 2. Anthropic native computer_20250124 if ANTHROPIC_API_KEY is set.
 * 3. OpenRouter chat/completions + computer_action function tool (vision fallback).
 *
 * Local actions: screencapture, Python Quartz mouse, AppleScript keyboard, pbcopy+Cmd+V.
 */

import { screen } from "electron";
import { execSync } from "child_process";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { runDeterministicSteps } from "./stepRunner";
import { beginExecution, endExecution, checkAbort, AbortedError } from "./abort";

const CHAT_URL = "https://openrouter.ai/api/v1/chat/completions";
const ANTHROPIC_MESSAGES_URL = "https://api.anthropic.com/v1/messages";
const OPENROUTER_MODEL = "anthropic/claude-sonnet-4-5";
const ANTHROPIC_MODEL = "claude-sonnet-4-5";
const MAX_STEPS = 30;

const COMPUTER_USE_BETA = "computer-use-2025-01-24";
const COMPUTER_TOOL_TYPE = "computer_20250124";

const SS_PATH = path.join(os.tmpdir(), "gw_ss.png");
const PY_PATH = path.join(os.tmpdir(), "gw_action.py");
const AS_PATH = path.join(os.tmpdir(), "gw_action.applescript");
const CLIP_PATH = path.join(os.tmpdir(), "gw_clip.txt");

// ─── Types ────────────────────────────────────────────────────────────────────

export interface ExecuteResult {
  success: boolean;
  steps: number;
  lastText: string;
  error?: string;
  /** How execution was performed (for logging). */
  mode?: "skill" | "compiled" | "deterministic" | "anthropic" | "openrouter";
  /** Run paused: external step staged in the approval queue. */
  staged?: boolean;
}

export interface ExecuteOptions {
  /** Stored workflow steps — tried deterministically before LLM. */
  steps?: string[];
  /** Rule this execution belongs to — compiled skills are keyed by rule. */
  ruleId?: number;
  /** Allow externally visible steps without shadow-mode staging. */
  externalAllowed?: boolean;
}

interface ComputerAction {
  action: string;
  coordinate?: [number, number];
  start_coordinate?: [number, number];
  text?: string;
  direction?: string;
  amount?: number;
  duration?: number;
}

type ToolResultContent =
  | { type: "text"; text: string }
  | {
      type: "image";
      source: { type: "base64"; media_type: "image/png"; data: string };
    };

type ContentBlock =
  | { type: "text"; text: string }
  | { type: "tool_use"; id: string; name: string; input: ComputerAction }
  | {
      type: "tool_result";
      tool_use_id: string;
      content: ToolResultContent[];
    };

type Message = {
  role: "user" | "assistant";
  content: string | ContentBlock[];
};

// ─── Display helpers ──────────────────────────────────────────────────────────

function getDisplay(): { logW: number; logH: number; scale: number } {
  const d = screen.getPrimaryDisplay();
  return {
    logW: d.size.width,
    logH: d.size.height,
    scale: d.scaleFactor,
  };
}

// Convert from screenshot (physical pixel) coord → logical CGEvent coord
function toLogical(px: number, scale: number): number {
  return px / scale;
}

// ─── Screenshot ───────────────────────────────────────────────────────────────

function takeScreenshot(): string {
  execSync(`screencapture -x -t png "${SS_PATH}"`, { timeout: 8000 });
  return fs.readFileSync(SS_PATH).toString("base64");
}

// ─── Low-level executors ──────────────────────────────────────────────────────

/**
 * Mouse backend ladder. The previous implementation assumed `python3` had
 * PyObjC Quartz — when it didn't, every click silently failed and the vision
 * agent flailed. Now we probe once and degrade gracefully:
 *   1. Quartz CGEvent via any python that can import it (best: all buttons, drag, scroll)
 *   2. cliclick (brew) — clicks/moves/drags, scroll approximated with keys
 *   3. AppleScript "click at" — left clicks only, scroll via Page Up/Down keys
 */
type MouseBackend = "quartz" | "cliclick" | "applescript";

let _mouseBackend: MouseBackend | null = null;
let _pythonBin = "python3";

function detectMouseBackend(): MouseBackend {
  if (_mouseBackend) return _mouseBackend;

  const pythons = [
    "python3",
    "/opt/homebrew/bin/python3",
    "/usr/local/bin/python3",
    "/usr/bin/python3",
  ];
  for (const bin of pythons) {
    try {
      execSync(`"${bin}" -c "import Quartz.CoreGraphics"`, {
        timeout: 8000,
        stdio: "pipe",
      });
      _pythonBin = bin;
      _mouseBackend = "quartz";
      console.log(`[computer-use] Mouse backend: Quartz CGEvent via ${bin}`);
      return _mouseBackend;
    } catch {}
  }

  try {
    execSync("which cliclick", { timeout: 3000, stdio: "pipe" });
    _mouseBackend = "cliclick";
    console.log("[computer-use] Mouse backend: cliclick");
    return _mouseBackend;
  } catch {}

  _mouseBackend = "applescript";
  console.warn(
    "[computer-use] Mouse backend: AppleScript (degraded — left-click only). " +
      "For full mouse support run: pip3 install pyobjc-framework-Quartz  OR  brew install cliclick"
  );
  return _mouseBackend;
}

function runPython(code: string): void {
  detectMouseBackend();
  fs.writeFileSync(PY_PATH, code, "utf-8");
  try {
    execSync(`"${_pythonBin}" "${PY_PATH}"`, { timeout: 10000, stdio: "pipe" });
  } finally {
    try {
      fs.unlinkSync(PY_PATH);
    } catch {}
  }
}

function runAppleScript(script: string): string {
  fs.writeFileSync(AS_PATH, script, "utf-8");
  try {
    return execSync(`osascript "${AS_PATH}"`, { timeout: 10000 })
      .toString()
      .trim();
  } finally {
    try {
      fs.unlinkSync(AS_PATH);
    } catch {}
  }
}

// ─── Mouse ────────────────────────────────────────────────────────────────────

function runCliclick(args: string): void {
  execSync(`cliclick ${args}`, { timeout: 10000, stdio: "pipe" });
}

function mouseMove(lx: number, ly: number): void {
  const backend = detectMouseBackend();
  if (backend === "quartz") {
    runPython(`
from Quartz.CoreGraphics import CGWarpMouseCursorPosition, CGPointMake
import time
CGWarpMouseCursorPosition(CGPointMake(${lx}, ${ly}))
time.sleep(0.05)
`);
  } else if (backend === "cliclick") {
    runCliclick(`m:${Math.round(lx)},${Math.round(ly)}`);
  }
  // applescript backend: no separate move primitive — click includes position
}

function mouseClick(
  lx: number,
  ly: number,
  button: "left" | "right" | "middle" = "left",
  clickCount = 1
): void {
  const backend = detectMouseBackend();
  const x = Math.round(lx);
  const y = Math.round(ly);

  if (backend === "cliclick") {
    const cmd =
      button === "right"
        ? `rc:${x},${y}`
        : clickCount === 2
          ? `dc:${x},${y}`
          : clickCount === 3
            ? `tc:${x},${y}`
            : `c:${x},${y}`;
    runCliclick(cmd);
    return;
  }

  if (backend === "applescript") {
    if (button !== "left") {
      throw new Error(
        `${button}-click unsupported without Quartz/cliclick. Install: pip3 install pyobjc-framework-Quartz`
      );
    }
    for (let i = 0; i < clickCount; i++) {
      runAppleScript(
        `tell application "System Events" to click at {${x}, ${y}}`
      );
    }
    return;
  }

  const down =
    button === "left"
      ? "kCGEventLeftMouseDown"
      : button === "right"
        ? "kCGEventRightMouseDown"
        : "kCGEventOtherMouseDown";
  const up =
    button === "left"
      ? "kCGEventLeftMouseUp"
      : button === "right"
        ? "kCGEventRightMouseUp"
        : "kCGEventOtherMouseUp";
  const btn =
    button === "left"
      ? "kCGMouseButtonLeft"
      : button === "right"
        ? "kCGMouseButtonRight"
        : "kCGMouseButtonCenter";

  runPython(`
from Quartz.CoreGraphics import *
import time

pt = CGPointMake(${lx}, ${ly})
CGWarpMouseCursorPosition(pt)
time.sleep(0.05)

for _ in range(${clickCount}):
    d = CGEventCreateMouseEvent(None, ${down}, pt, ${btn})
    CGEventSetIntegerValueField(d, kCGMouseEventClickState, ${clickCount})
    CGEventPost(kCGHIDEventTap, d)
    time.sleep(0.05)
    u = CGEventCreateMouseEvent(None, ${up}, pt, ${btn})
    CGEventSetIntegerValueField(u, kCGMouseEventClickState, ${clickCount})
    CGEventPost(kCGHIDEventTap, u)
    time.sleep(0.05)
`);
}

function mouseDrag(
  lx1: number,
  ly1: number,
  lx2: number,
  ly2: number
): void {
  const backend = detectMouseBackend();

  if (backend === "cliclick") {
    runCliclick(
      `dd:${Math.round(lx1)},${Math.round(ly1)} du:${Math.round(lx2)},${Math.round(ly2)}`
    );
    return;
  }

  if (backend === "applescript") {
    throw new Error(
      "Drag unsupported without Quartz/cliclick. Install: pip3 install pyobjc-framework-Quartz"
    );
  }

  runPython(`
from Quartz.CoreGraphics import *
import time

start = CGPointMake(${lx1}, ${ly1})
end_pt = CGPointMake(${lx2}, ${ly2})

CGWarpMouseCursorPosition(start)
time.sleep(0.1)

d = CGEventCreateMouseEvent(None, kCGEventLeftMouseDown, start, kCGMouseButtonLeft)
CGEventPost(kCGHIDEventTap, d)
time.sleep(0.1)

steps = 25
for i in range(steps + 1):
    t = i / steps
    cx = ${lx1} + (${lx2} - ${lx1}) * t
    cy = ${ly1} + (${ly2} - ${ly1}) * t
    drag = CGEventCreateMouseEvent(None, kCGEventLeftMouseDragged, CGPointMake(cx, cy), kCGMouseButtonLeft)
    CGEventPost(kCGHIDEventTap, drag)
    time.sleep(0.01)

u = CGEventCreateMouseEvent(None, kCGEventLeftMouseUp, end_pt, kCGMouseButtonLeft)
CGEventPost(kCGHIDEventTap, u)
time.sleep(0.1)
`);
}

function mouseScroll(
  lx: number,
  ly: number,
  direction: string,
  amount: number
): void {
  const backend = detectMouseBackend();

  if (backend !== "quartz") {
    // No scroll-wheel primitive — approximate with Page Up/Down after clicking
    // the target area to focus it.
    try {
      mouseClick(lx, ly, "left", 1);
    } catch {}
    const key = direction === "up" ? "Page_Up" : "Page_Down";
    for (let i = 0; i < Math.max(1, Math.min(amount, 5)); i++) {
      pressKey(key);
    }
    return;
  }

  const dy =
    direction === "up" ? amount : direction === "down" ? -amount : 0;
  const dx =
    direction === "right" ? amount : direction === "left" ? -amount : 0;

  runPython(`
from Quartz.CoreGraphics import *
import time

CGWarpMouseCursorPosition(CGPointMake(${lx}, ${ly}))
time.sleep(0.05)
e = CGEventCreateScrollWheelEvent(None, kCGScrollEventUnitLine, 2, ${dy}, ${dx})
CGEventPost(kCGHIDEventTap, e)
time.sleep(0.1)
`);
}

// ─── Keyboard ─────────────────────────────────────────────────────────────────

// Claude key name → AppleScript key code number
const KEY_CODES: Record<string, number> = {
  Return: 36, Tab: 48, BackSpace: 51, Escape: 53, Delete: 117, space: 49,
  Up: 126, Down: 125, Left: 123, Right: 124,
  Home: 115, End: 119, Page_Up: 116, Page_Down: 121,
  F1: 122, F2: 120, F3: 99, F4: 118, F5: 96, F6: 97,
  F7: 98, F8: 100, F9: 101, F10: 109, F11: 103, F12: 111,
};

// Claude modifier name → AppleScript using-clause token
const MOD_MAP: Record<string, string> = {
  ctrl: "control down", control: "control down",
  alt: "option down", option: "option down",
  shift: "shift down",
  super: "command down", command: "command down", cmd: "command down", meta: "command down",
};

function pressKey(keyStr: string): void {
  const parts = keyStr.split("+");
  const main = parts[parts.length - 1];
  const mods = parts
    .slice(0, -1)
    .map((m) => MOD_MAP[m.toLowerCase()] ?? "")
    .filter(Boolean);
  const using = mods.length ? ` using {${mods.join(", ")}}` : "";

  if (KEY_CODES[main] !== undefined) {
    runAppleScript(
      `tell application "System Events" to key code ${KEY_CODES[main]}${using}`
    );
  } else if (main.length === 1) {
    runAppleScript(
      `tell application "System Events" to keystroke "${main}"${using}`
    );
  }
}

function typeText(text: string): void {
  // Write to temp file → pbcopy → Cmd+V  (handles unicode/special chars)
  fs.writeFileSync(CLIP_PATH, text, "utf-8");
  execSync(`cat "${CLIP_PATH}" | pbcopy`, { timeout: 5000 });
  try {
    fs.unlinkSync(CLIP_PATH);
  } catch {}
  runAppleScript(
    'tell application "System Events" to keystroke "v" using command down'
  );
}

// ─── Action dispatcher ────────────────────────────────────────────────────────

function executeComputerAction(
  action: ComputerAction,
  scale: number
): ToolResultContent[] {
  const lx = (px: number) => toLogical(px, scale);
  const [cx, cy] = action.coordinate ?? [0, 0];
  const [sx, sy] = action.start_coordinate ?? [0, 0];

  const withScreenshot = (): ToolResultContent[] => {
    execSync("sleep 0.2"); // brief settle
    const data = takeScreenshot();
    return [{ type: "image", source: { type: "base64", media_type: "image/png", data } }];
  };

  switch (action.action) {
    case "screenshot":
      return withScreenshot();

    case "mouse_move":
      mouseMove(lx(cx), lx(cy));
      return [{ type: "text", text: `Moved to (${cx}, ${cy})` }];

    case "left_click":
      mouseClick(lx(cx), lx(cy), "left");
      return withScreenshot();

    case "right_click":
      mouseClick(lx(cx), lx(cy), "right");
      return withScreenshot();

    case "middle_click":
      mouseClick(lx(cx), lx(cy), "middle");
      return withScreenshot();

    case "double_click":
      mouseClick(lx(cx), lx(cy), "left", 2);
      return withScreenshot();

    case "left_click_drag":
      mouseDrag(lx(sx), lx(sy), lx(cx), lx(cy));
      return withScreenshot();

    case "scroll":
      mouseScroll(lx(cx), lx(cy), action.direction ?? "down", action.amount ?? 3);
      return withScreenshot();

    case "type":
      typeText(action.text ?? "");
      return withScreenshot();

    case "key":
      pressKey(action.text ?? "");
      return withScreenshot();

    case "hold_key":
      pressKey(action.text ?? "");
      return [{ type: "text", text: `Key pressed: ${action.text}` }];

    case "wait": {
      const ms = Math.min(action.duration ?? 1000, 10000);
      execSync(`sleep ${ms / 1000}`);
      return withScreenshot();
    }

    case "zoom": {
      // Read-only zoom — just return the current screenshot
      return withScreenshot();
    }

    default:
      return [{ type: "text", text: `Unsupported action: ${action.action}` }];
  }
}

function argsToComputerAction(args: Record<string, unknown>): ComputerAction | null {
  const action = String(args.action ?? "");
  if (action === "done") return { action: "done" };
  return {
    action,
    coordinate:
      args.x != null && args.y != null
        ? [Number(args.x), Number(args.y)]
        : undefined,
    start_coordinate:
      args.start_x != null && args.start_y != null
        ? [Number(args.start_x), Number(args.start_y)]
        : undefined,
    text: args.text != null ? String(args.text) : undefined,
    direction: args.direction != null ? String(args.direction) : undefined,
    amount: args.amount != null ? Number(args.amount) : undefined,
    duration: args.duration_ms != null ? Number(args.duration_ms) : undefined,
  };
}

// ─── OpenRouter vision + function-calling loop ───────────────────────────────

type ChatContentPart =
  | { type: "text"; text: string }
  | { type: "image_url"; image_url: { url: string } };

type ChatMessage = {
  role: "system" | "user" | "assistant" | "tool";
  content?: string | ChatContentPart[];
  tool_calls?: Array<{
    id: string;
    type: "function";
    function: { name: string; arguments: string };
  }>;
  tool_call_id?: string;
};

function buildVisionTool(physW: number, physH: number) {
  return {
    type: "function" as const,
    function: {
      name: "computer_action",
      description: `Perform one macOS desktop action. Screenshot size: ${physW}x${physH}px, origin top-left.`,
      parameters: {
        type: "object",
        properties: {
          action: {
            type: "string",
            enum: [
              "screenshot",
              "mouse_move",
              "left_click",
              "right_click",
              "double_click",
              "type",
              "key",
              "scroll",
              "wait",
              "done",
            ],
          },
          x: { type: "number" },
          y: { type: "number" },
          start_x: { type: "number" },
          start_y: { type: "number" },
          text: { type: "string" },
          direction: { type: "string", enum: ["up", "down", "left", "right"] },
          amount: { type: "number" },
          duration_ms: { type: "number" },
          message: { type: "string", description: "Summary when action is done" },
        },
        required: ["action"],
      },
    },
  };
}

async function executeOpenRouterVision(
  task: string,
  context: string,
  onStep: ((step: number, action: string, detail?: string) => void) | undefined,
  apiKey: string,
  scale: number,
  physW: number,
  physH: number
): Promise<ExecuteResult> {
  const systemPrompt = [
    "You are a macOS desktop automation agent.",
    `The screen is ${physW}x${physH} pixels. Use computer_action for each step.`,
    "Call computer_action with action=done when finished.",
    context ? `Context: ${context}` : "",
  ]
    .filter(Boolean)
    .join("\n");

  let screenshot: string;
  try {
    screenshot = takeScreenshot();
  } catch (err) {
    return {
      success: false,
      steps: 0,
      lastText: "",
      error: `Screenshot failed: ${err instanceof Error ? err.message : String(err)}`,
      mode: "openrouter",
    };
  }

  const messages: ChatMessage[] = [
    { role: "system", content: systemPrompt },
    {
      role: "user",
      content: [
        { type: "text", text: task },
        { type: "image_url", image_url: { url: `data:image/png;base64,${screenshot}` } },
      ],
    },
  ];

  let lastText = "";
  let steps = 0;

  for (let i = 0; i < MAX_STEPS; i++) {
    checkAbort();
    steps = i + 1;

    let res: Response;
    try {
      res = await fetch(CHAT_URL, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "HTTP-Referer": "https://ghostwork.app",
          "X-Title": "Ghostwork",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model: OPENROUTER_MODEL,
          max_tokens: 1024,
          messages,
          tools: [buildVisionTool(physW, physH)],
          tool_choice: "auto",
        }),
        signal: AbortSignal.timeout(90000),
      });
    } catch (err) {
      return {
        success: false,
        steps,
        lastText,
        error: `API request failed: ${err instanceof Error ? err.message : String(err)}`,
        mode: "openrouter",
      };
    }

    if (!res.ok) {
      const body = await res.text().catch(() => "");
      return {
        success: false,
        steps,
        lastText,
        error: `API ${res.status}: ${body.slice(0, 300)}`,
        mode: "openrouter",
      };
    }

    const data = await res.json();
    const choice = data.choices?.[0];
    const msg = choice?.message;
    if (!msg) {
      return { success: false, steps, lastText, error: "Empty model response", mode: "openrouter" };
    }

    if (msg.content) lastText = typeof msg.content === "string" ? msg.content : lastText;

    const toolCalls = msg.tool_calls ?? [];
    if (toolCalls.length === 0) {
      console.log(`[computer-use:openrouter] Done in ${steps} steps`);
      return { success: true, steps, lastText, mode: "openrouter" };
    }

    messages.push({
      role: "assistant",
      content: msg.content ?? "",
      tool_calls: toolCalls,
    });

    for (const tc of toolCalls) {
      if (tc.function.name !== "computer_action") continue;

      let args: Record<string, unknown>;
      try {
        args = JSON.parse(tc.function.arguments) as Record<string, unknown>;
      } catch {
        messages.push({
          role: "tool",
          tool_call_id: tc.id,
          content: "Error: invalid JSON arguments",
        });
        continue;
      }

      if (args.action === "done") {
        lastText = String(args.message ?? lastText);
        console.log(`[computer-use:openrouter] Done in ${steps} steps`);
        return { success: true, steps, lastText, mode: "openrouter" };
      }

      const input = argsToComputerAction(args);
      if (!input) continue;

      const detail =
        input.coordinate
          ? `(${input.coordinate.join(",")})`
          : input.text
            ? `"${input.text.slice(0, 40)}"`
            : "";
      console.log(`[computer-use:openrouter] Step ${steps}: ${input.action} ${detail}`);
      onStep?.(steps, input.action, detail);

      let resultText = "OK";
      try {
        const results = executeComputerAction(input, scale);
        resultText = results
          .map((r) => (r.type === "text" ? r.text : "[screenshot taken]"))
          .join("; ");
      } catch (err) {
        resultText = `Error: ${err instanceof Error ? err.message : String(err)}`;
      }

      messages.push({ role: "tool", tool_call_id: tc.id, content: resultText });

      // Send updated screenshot for next turn.
      try {
        screenshot = takeScreenshot();
        messages.push({
          role: "user",
          content: [
            { type: "text", text: "Updated screen after last action:" },
            { type: "image_url", image_url: { url: `data:image/png;base64,${screenshot}` } },
          ],
        });
      } catch {
        // Continue without image if capture fails.
      }
    }
  }

  return {
    success: false,
    steps,
    lastText,
    error: `Reached max steps (${MAX_STEPS})`,
    mode: "openrouter",
  };
}

// ─── Anthropic native computer-use loop ───────────────────────────────────────

async function executeAnthropicNative(
  task: string,
  context: string,
  onStep: ((step: number, action: string, detail?: string) => void) | undefined,
  apiKey: string,
  scale: number,
  physW: number,
  physH: number
): Promise<ExecuteResult> {
  const systemPrompt = [
    "You are a macOS desktop automation agent acting on behalf of a user.",
    "Take a screenshot first to see the current state, then complete the task efficiently.",
    "Be precise with coordinates. Complete the task and stop.",
    context ? `Current context: ${context}` : "",
  ]
    .filter(Boolean)
    .join("\n");

  let initialScreenshot: string | undefined;
  try {
    initialScreenshot = takeScreenshot();
  } catch (err) {
    console.warn("[computer-use:anthropic] Could not take initial screenshot:", err);
  }

  const firstContent: ContentBlock[] = [
    { type: "text", text: task },
    ...(initialScreenshot
      ? [
          {
            type: "image" as const,
            source: {
              type: "base64" as const,
              media_type: "image/png" as const,
              data: initialScreenshot,
            },
          } as unknown as ContentBlock,
        ]
      : []),
  ];

  const messages: Message[] = [{ role: "user", content: firstContent }];
  let lastText = "";
  let steps = 0;

  for (let i = 0; i < MAX_STEPS; i++) {
    checkAbort();
    steps = i + 1;

    let res: Response;
    try {
      res = await fetch(ANTHROPIC_MESSAGES_URL, {
        method: "POST",
        headers: {
          "x-api-key": apiKey,
          "anthropic-version": "2023-06-01",
          "anthropic-beta": COMPUTER_USE_BETA,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model: ANTHROPIC_MODEL,
          max_tokens: 4096,
          system: systemPrompt,
          tools: [
            {
              type: COMPUTER_TOOL_TYPE,
              name: "computer",
              display_width_px: physW,
              display_height_px: physH,
            },
          ],
          messages,
        }),
        signal: AbortSignal.timeout(90000),
      });
    } catch (err) {
      return {
        success: false,
        steps,
        lastText,
        error: `API request failed: ${err instanceof Error ? err.message : String(err)}`,
        mode: "anthropic",
      };
    }

    if (!res.ok) {
      const body = await res.text().catch(() => "");
      return {
        success: false,
        steps,
        lastText,
        error: `API ${res.status}: ${body.slice(0, 300)}`,
        mode: "anthropic",
      };
    }

    const data = await res.json();
    const stopReason: string = data.stop_reason ?? "end_turn";
    const content: ContentBlock[] = data.content ?? [];

    for (const block of content) {
      if (block.type === "text") lastText = block.text;
    }

    messages.push({ role: "assistant", content });

    if (stopReason === "end_turn") {
      console.log(`[computer-use:anthropic] Done in ${steps} steps`);
      return { success: true, steps, lastText, mode: "anthropic" };
    }

    if (stopReason !== "tool_use") {
      return {
        success: false,
        steps,
        lastText,
        error: `stop_reason=${stopReason}`,
        mode: "anthropic",
      };
    }

    const toolResults: ContentBlock[] = [];
    for (const block of content) {
      if (block.type !== "tool_use" || block.name !== "computer") continue;

      const actionName = block.input.action;
      const detail =
        block.input.coordinate
          ? `(${block.input.coordinate.join(",")})`
          : block.input.text
            ? `"${block.input.text.slice(0, 40)}"`
            : "";

      console.log(`[computer-use:anthropic] Step ${steps}: ${actionName} ${detail}`);
      onStep?.(steps, actionName, detail);

      let result: ToolResultContent[];
      try {
        result = executeComputerAction(block.input, scale);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        result = [{ type: "text", text: `Error: ${msg}` }];
      }

      toolResults.push({
        type: "tool_result",
        tool_use_id: block.id,
        content: result,
      });
    }

    messages.push({ role: "user", content: toolResults });
  }

  return {
    success: false,
    steps,
    lastText,
    error: `Reached max steps (${MAX_STEPS})`,
    mode: "anthropic",
  };
}

// ─── Main entry — execution router ───────────────────────────────────────────
//
// Order: compiled skill replay → CDP plan-then-execute (browser tasks)
//        → legacy deterministic steps → pixel fallback (Anthropic/OpenRouter).

function extractUrlHint(task: string, steps: string[]): string | undefined {
  const urlRe = /(https?:\/\/\S+|(?:[\w-]+\.)+(?:com|net|org|io|ai|co|app|dev)\S*)/i;
  for (const s of steps) {
    const m = s.match(urlRe);
    if (m) return m[1];
  }
  const m = task.match(urlRe);
  return m?.[1];
}

function looksBrowserTask(task: string, steps: string[]): boolean {
  if (extractUrlHint(task, steps)) return true;
  return /\b(browser|website|web page|tab|chrome|linkedin|gmail|google|search results?|url)\b/i.test(
    `${task} ${steps.join(" ")}`
  );
}

export async function executeWithComputerUse(
  task: string,
  context = "",
  onStep?: (step: number, action: string, detail?: string) => void,
  options?: ExecuteOptions
): Promise<ExecuteResult> {
  beginExecution();
  try {
    return await routeExecution(task, context, onStep, options);
  } catch (err) {
    if (err instanceof AbortedError) {
      return { success: false, steps: 0, lastText: "", error: "Aborted by user (Esc)" };
    }
    throw err;
  } finally {
    endExecution();
  }
}

async function routeExecution(
  task: string,
  context: string,
  onStep?: (step: number, action: string, detail?: string) => void,
  options?: ExecuteOptions
): Promise<ExecuteResult> {
  const { logW, logH, scale } = getDisplay();
  const physW = Math.round(logW * scale);
  const physH = Math.round(logH * scale);

  const storedSteps = options?.steps?.filter(Boolean) ?? [];

  // Lazy import to avoid loading playwright until execution actually happens.
  const skillEngine = await import("./skillEngine");
  const db = await import("./db");
  const browserDriver = await import("./browserDriver");

  // 1) Compiled skill replay — deterministic, zero tokens, human speed.
  if (options?.ruleId != null) {
    const skill = db.getSkillForRule(options.ruleId);
    if (skill && skill.steps.length > 0) {
      console.log(`[computer-use] Replaying compiled skill #${skill.id} (${skill.steps.length} steps)`);
      const res = await skillEngine.replaySkill(skill, {
        externalAllowed: options.externalAllowed,
        onStep,
      });
      if (res.success) {
        return {
          success: true,
          steps: res.stepsExecuted,
          lastText: res.stepsLog.slice(-1)[0] ?? "Skill replayed",
          mode: "skill",
          staged: res.staged,
        };
      }
      console.warn(`[computer-use] Skill replay failed (${res.error}) — recompiling`);
    }
  }

  // 2) Browser plan-then-execute (DOM/AX perception — no vision tokens).
  const browserish = looksBrowserTask(task, storedSteps);
  const cdpAlready = await browserDriver.isAvailable();
  if (browserish || cdpAlready) {
    try {
      console.log("[computer-use] Using browser engine (CDP plan-then-execute)");
      const res = await skillEngine.compileAndRun(task, context, {
        ruleId: options?.ruleId,
        startUrl: extractUrlHint(task, storedSteps),
        externalAllowed: options?.externalAllowed,
        onStep,
      });
      if (res.success) {
        return {
          success: true,
          steps: res.stepsExecuted,
          lastText: res.stepsLog.slice(-1)[0] ?? "Done",
          mode: "compiled",
          staged: res.staged,
        };
      }
      console.warn(`[computer-use] Browser engine failed (${res.error}) — falling back`);
      context = [context, `Browser engine already tried and failed: ${res.error}`]
        .filter(Boolean)
        .join(". ");
    } catch (err) {
      if (err instanceof AbortedError) throw err;
      console.warn(
        `[computer-use] Browser engine unavailable (${err instanceof Error ? err.message : err}) — falling back`
      );
    }
  }

  // 3) Legacy deterministic steps (URL opens / app switches without CDP).
  if (storedSteps.length > 0) {
    console.log(`[computer-use] Trying ${storedSteps.length} stored step(s) deterministically…`);
    const det = await runDeterministicSteps(storedSteps, onStep);
    if (det.success) {
      console.log(`[computer-use] All ${det.completedSteps} steps completed deterministically`);
      return {
        success: true,
        steps: det.completedSteps,
        lastText: `Completed ${det.completedSteps} steps`,
        mode: "deterministic",
      };
    }
    if (det.completedSteps > 0) {
      context = [context, `Already completed steps: ${storedSteps.slice(0, det.completedSteps).join("; ")}`]
        .filter(Boolean)
        .join(". ");
    }
  }

  const anthropicKey = process.env.ANTHROPIC_API_KEY ?? "";
  const openrouterKey = process.env.OPENROUTER_API_KEY ?? "";

  // 4) Pixel fallback — Anthropic native computer use (best quality).
  if (anthropicKey) {
    console.log("[computer-use] Using Anthropic native computer use (pixel fallback)");
    return executeAnthropicNative(task, context, onStep, anthropicKey, scale, physW, physH);
  }

  // 5) Pixel fallback — OpenRouter vision + function calling.
  if (openrouterKey) {
    console.log("[computer-use] Using OpenRouter vision + function calling (pixel fallback)");
    return executeOpenRouterVision(
      task,
      context,
      onStep,
      openrouterKey,
      scale,
      physW,
      physH
    );
  }

  return {
    success: false,
    steps: 0,
    lastText: "",
    error:
      "No API key for execution. Add ANTHROPIC_API_KEY (recommended) or OPENROUTER_API_KEY in Settings.",
  };
}
