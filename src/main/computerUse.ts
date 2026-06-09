/**
 * Computer use executor.
 *
 * Calls Claude (via OpenRouter's Anthropic-compatible endpoint) with the
 * computer_20251124 tool.  Each tool_use block Claude returns is executed
 * locally using:
 *   - screencapture (macOS built-in) for screenshots
 *   - Python + Quartz CoreGraphics for mouse (CGEvent — reliable on M1/M2)
 *   - osascript / AppleScript for keyboard (keystroke / key code)
 *   - pbcopy + Cmd+V for text input (handles unicode / special chars)
 *
 * Display coordinates:
 *   screencapture produces images at physical (Retina) resolution.
 *   We tell Claude that resolution.  Claude returns coords in that space.
 *   CGEvent operates in logical (point) space → we divide by scaleFactor.
 */

import { screen } from "electron";
import { execSync } from "child_process";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";

const MESSAGES_URL = "https://openrouter.ai/api/v1/messages";
const MODEL = "anthropic/claude-sonnet-4-5";
const MAX_STEPS = 30;

// Sonnet 4.5 uses the Jan 2025 computer-use tool, not the Nov 2025 version.
// See: https://platform.claude.com/docs/en/agents-and-tools/tool-use/computer-use-tool
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

function runPython(code: string): void {
  fs.writeFileSync(PY_PATH, code, "utf-8");
  try {
    execSync(`python3 "${PY_PATH}"`, { timeout: 10000 });
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

function mouseMove(lx: number, ly: number): void {
  runPython(`
from Quartz.CoreGraphics import CGWarpMouseCursorPosition, CGPointMake
import time
CGWarpMouseCursorPosition(CGPointMake(${lx}, ${ly}))
time.sleep(0.05)
`);
}

function mouseClick(
  lx: number,
  ly: number,
  button: "left" | "right" | "middle" = "left",
  clickCount = 1
): void {
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

// ─── Main loop ────────────────────────────────────────────────────────────────

export async function executeWithComputerUse(
  task: string,
  context = "",
  onStep?: (step: number, action: string, detail?: string) => void
): Promise<ExecuteResult> {
  const key = process.env.OPENROUTER_API_KEY ?? "";
  if (!key) {
    return { success: false, steps: 0, lastText: "", error: "No OPENROUTER_API_KEY set" };
  }

  const { logW, logH, scale } = getDisplay();
  const physW = Math.round(logW * scale);
  const physH = Math.round(logH * scale);

  const systemPrompt = [
    "You are a macOS desktop automation agent acting on behalf of a user.",
    "Take a screenshot first to see the current state, then complete the task efficiently.",
    "Be precise with coordinates. Complete the task and stop — do not take unnecessary actions.",
    context ? `Current context: ${context}` : "",
  ]
    .filter(Boolean)
    .join("\n");

  // Seed with initial screenshot so Claude knows where things are
  let initialScreenshot: string | undefined;
  try {
    initialScreenshot = takeScreenshot();
  } catch (err) {
    console.warn("[computer-use] Could not take initial screenshot:", err);
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
    steps = i + 1;

    let res: Response;
    try {
      res = await fetch(MESSAGES_URL, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${key}`,
          "anthropic-version": "2023-06-01",
          "anthropic-beta": COMPUTER_USE_BETA,
          "HTTP-Referer": "https://ghostwork.app",
          "X-Title": "Ghostwork",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model: MODEL,
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
      };
    }

    if (!res.ok) {
      const body = await res.text().catch(() => "");
      return { success: false, steps, lastText, error: `API ${res.status}: ${body.slice(0, 300)}` };
    }

    const data = await res.json();
    const stopReason: string = data.stop_reason ?? "end_turn";
    const content: ContentBlock[] = data.content ?? [];

    for (const block of content) {
      if (block.type === "text") lastText = block.text;
    }

    messages.push({ role: "assistant", content });

    if (stopReason === "end_turn") {
      console.log(`[computer-use] Done in ${steps} steps. "${lastText.slice(0, 80)}"`);
      return { success: true, steps, lastText };
    }

    if (stopReason !== "tool_use") {
      return { success: false, steps, lastText, error: `stop_reason=${stopReason}` };
    }

    // Execute tool use blocks
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

      console.log(`[computer-use] Step ${steps}: ${actionName} ${detail}`);
      onStep?.(steps, actionName, detail);

      let result: ToolResultContent[];
      try {
        result = executeComputerAction(block.input, scale);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(`[computer-use] Action error (${actionName}):`, msg);
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

  return { success: false, steps, lastText, error: `Reached max steps (${MAX_STEPS})` };
}
