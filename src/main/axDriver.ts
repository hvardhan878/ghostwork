/**
 * Native-app substrate — macOS accessibility tree via System Events
 * (UI scripting drives the same AXUIElement layer VoiceOver uses).
 *
 * Element-targeted actions instead of pixel coordinates: ~50ms lookups,
 * no screenshots, no vision tokens. Focus is verified before every action.
 * Apps with empty AX trees (some Electron/Qt) fall through to the pixel stack.
 */

import { execFile } from "child_process";

function osascript(script: string, timeoutMs = 10000): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile("osascript", ["-e", script], { timeout: timeoutMs }, (err, stdout, stderr) => {
      if (err) reject(new Error(stderr?.trim() || err.message));
      else resolve(stdout.trim());
    });
  });
}

function asEscape(s: string): string {
  return s.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

/** Bring the app frontmost and verify it actually got focus. */
export async function ensureFrontmost(appName: string): Promise<void> {
  const name = asEscape(appName);
  await osascript(`tell application "${name}" to activate`);
  const front = await osascript(
    'tell application "System Events" to get name of first application process whose frontmost is true'
  ).catch(() => "");
  if (!front.toLowerCase().includes(appName.toLowerCase().split(" ")[0])) {
    throw new Error(`Could not focus "${appName}" (frontmost is "${front}")`);
  }
}

/**
 * Click a named element in the app's front window via the AX tree.
 * Tries buttons → any UI element → deep search, with "contains" matching.
 */
export async function clickElement(appName: string, elementName: string): Promise<void> {
  await ensureFrontmost(appName);
  const proc = asEscape(appName);
  const target = asEscape(elementName);

  const script = `
tell application "System Events"
  tell process "${proc}"
    if (count of windows) = 0 then error "no windows"
    try
      click (first button of window 1 whose name contains "${target}")
      return "ok:button"
    end try
    try
      click (first UI element of window 1 whose name contains "${target}")
      return "ok:element"
    end try
    try
      set found to first UI element of entire contents of window 1 whose name contains "${target}"
      click found
      return "ok:deep"
    end try
    error "element not found: ${target}"
  end tell
end tell`;

  const result = await osascript(script, 15000);
  if (!result.startsWith("ok")) {
    throw new Error(`AX click failed: ${result}`);
  }
}

/** Click a menu item, e.g. clickMenuItem("Notes", "File", "New Note"). */
export async function clickMenuItem(
  appName: string,
  menuName: string,
  itemName: string
): Promise<void> {
  await ensureFrontmost(appName);
  const proc = asEscape(appName);
  await osascript(`
tell application "System Events"
  tell process "${proc}"
    click menu item "${asEscape(itemName)}" of menu "${asEscape(menuName)}" of menu bar item "${asEscape(menuName)}" of menu bar 1
  end tell
end tell`);
}

/** Type text with focus verification (AX path — no clipboard tricks needed). */
export async function typeInApp(appName: string, text: string): Promise<void> {
  await ensureFrontmost(appName);
  await osascript(
    `tell application "System Events" to keystroke "${asEscape(text)}"`
  );
}

export interface AxElement {
  role: string;
  name: string;
}

/**
 * List named interactive elements in the app's front window — used to decide
 * whether the AX tree is usable or we must fall back to pixels.
 */
export async function listElements(appName: string): Promise<AxElement[]> {
  const proc = asEscape(appName);
  const out = await osascript(`
tell application "System Events"
  tell process "${proc}"
    if (count of windows) = 0 then return ""
    set resultList to {}
    repeat with el in (buttons of window 1)
      try
        set end of resultList to ("button|" & (name of el))
      end try
    end repeat
    repeat with el in (text fields of window 1)
      try
        set end of resultList to ("textfield|" & (name of el))
      end try
    end repeat
    set AppleScript's text item delimiters to linefeed
    return resultList as text
  end tell
end tell`, 15000).catch(() => "");

  return out
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const [role, ...rest] = line.split("|");
      return { role, name: rest.join("|") };
    })
    .filter((el) => el.name);
}

/** Does this app expose a usable AX tree? */
export async function hasUsableTree(appName: string): Promise<boolean> {
  const els = await listElements(appName);
  return els.length > 0;
}
