/**
 * macOS nudge popup — a small always-on-top window that replaces native
 * Notification banners (which require code signing and are suppressed when silent).
 */

import { app, BrowserWindow, screen } from "electron";
import * as path from "path";

export interface NudgePayload {
  activityId: number;
  ruleId: number;
  action: string;
  instruction: string;
  condition: string;
  onDoIt: () => void | Promise<void>;
  onDismiss: () => void;
}

let nudgeWindow: BrowserWindow | null = null;
let currentPayload: NudgePayload | null = null;
let autoCloseTimer: ReturnType<typeof setTimeout> | null = null;
let dockWasHidden = false;

function positionOnActiveDisplay(win: BrowserWindow, winW: number, winH: number): void {
  const point = screen.getCursorScreenPoint();
  const display = screen.getDisplayNearestPoint(point);
  const { x, y, width } = display.workArea;
  win.setPosition(x + width - winW - 16, y + 12);
  win.setSize(winW, winH);
}

export function showNudgeWindow(payload: NudgePayload): void {
  closeNudgeWindow();
  currentPayload = payload;

  const winW = 340;
  const winH = 130;

  // Accessory apps (dock hidden) often fail to surface overlay windows on macOS.
  if (process.platform === "darwin") {
    dockWasHidden = !app.dock?.isVisible();
    if (dockWasHidden) app.dock?.show();
  }

  nudgeWindow = new BrowserWindow({
    width: winW,
    height: winH,
    frame: false,
    alwaysOnTop: true,
    resizable: false,
    minimizable: false,
    maximizable: false,
    skipTaskbar: true,
    focusable: true,
    show: false,
    hasShadow: true,
    backgroundColor: "#0d0d0d",
    ...(process.platform === "darwin" ? { type: "panel" as const } : {}),
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(__dirname, "nudge-preload.js"),
    },
  });

  positionOnActiveDisplay(nudgeWindow, winW, winH);
  nudgeWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  // Highest z-order on macOS so it appears above Chrome/full-screen apps.
  nudgeWindow.setAlwaysOnTop(true, "screen-saver", 1);

  const htmlPath = path.join(__dirname, "../renderer/nudge.html");
  console.log(`[nudge] Loading ${htmlPath}`);

  nudgeWindow.webContents.on("did-fail-load", (_e, code, desc) => {
    console.error(`[nudge] Failed to load: ${code} ${desc}`);
  });

  nudgeWindow.loadFile(htmlPath, {
    query: { action: payload.action.slice(0, 200) },
  });

  const reveal = () => {
    if (!nudgeWindow || nudgeWindow.isDestroyed()) return;
    positionOnActiveDisplay(nudgeWindow, winW, winH);
    nudgeWindow.showInactive(); // don't steal focus from user's current app
    nudgeWindow.moveTop();
    console.log(`[nudge] Popup visible at (${nudgeWindow.getPosition().join(",")})`);
  };

  nudgeWindow.once("ready-to-show", reveal);

  // Fallback if ready-to-show never fires (seen with panel windows on some macOS versions).
  setTimeout(reveal, 800);

  nudgeWindow.on("closed", () => {
    nudgeWindow = null;
    currentPayload = null;
    if (autoCloseTimer) {
      clearTimeout(autoCloseTimer);
      autoCloseTimer = null;
    }
    if (process.platform === "darwin" && dockWasHidden) {
      app.dock?.hide();
      dockWasHidden = false;
    }
  });

  autoCloseTimer = setTimeout(() => {
    if (currentPayload) {
      currentPayload.onDismiss();
      closeNudgeWindow();
    }
  }, 45_000);

  console.log(`[nudge] Showing popup: "${payload.action.slice(0, 80)}"`);
}

export function closeNudgeWindow(): void {
  if (autoCloseTimer) {
    clearTimeout(autoCloseTimer);
    autoCloseTimer = null;
  }
  if (nudgeWindow && !nudgeWindow.isDestroyed()) {
    nudgeWindow.close();
  }
  nudgeWindow = null;
  currentPayload = null;
}

export async function handleNudgeDoIt(): Promise<void> {
  const payload = currentPayload;
  closeNudgeWindow();
  if (payload) await payload.onDoIt();
}

export function handleNudgeDismiss(): void {
  const payload = currentPayload;
  closeNudgeWindow();
  if (payload) payload.onDismiss();
}

/** Dev/test helper — show a nudge immediately without waiting for a rule match. */
export function showTestNudge(): void {
  showNudgeWindow({
    activityId: -1,
    ruleId: -1,
    action: "Test nudge — if you see this, popups are working",
    instruction: "",
    condition: "",
    onDoIt: () => console.log("[nudge] Test Do it clicked"),
    onDismiss: () => console.log("[nudge] Test Dismiss clicked"),
  });
}
