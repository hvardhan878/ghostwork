/**
 * "Ghost is driving" HUD — a slim always-on-top strip shown while Ghostwork
 * executes visibly. Shows the current step caption and the Esc hint.
 */

import { BrowserWindow, screen } from "electron";
import * as path from "path";
import { onAbort } from "./abort";

let hud: BrowserWindow | null = null;
let unsubAbort: (() => void) | null = null;

const HUD_W = 480;
const HUD_H = 44;

export function showHud(title: string): void {
  if (hud && !hud.isDestroyed()) {
    updateHud(title);
    return;
  }

  const display = screen.getPrimaryDisplay();
  const { x, width, y } = display.workArea;

  hud = new BrowserWindow({
    width: HUD_W,
    height: HUD_H,
    x: x + Math.round((width - HUD_W) / 2),
    y: y + 8,
    frame: false,
    transparent: true,
    alwaysOnTop: true,
    resizable: false,
    movable: true,
    minimizable: false,
    maximizable: false,
    skipTaskbar: true,
    focusable: false,
    show: false,
    hasShadow: false,
    ...(process.platform === "darwin" ? { type: "panel" as const } : {}),
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
    },
  });

  hud.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  hud.setAlwaysOnTop(true, "screen-saver", 1);
  hud.setIgnoreMouseEvents(false);

  hud.loadFile(path.join(__dirname, "../renderer/hud.html"), {
    query: { caption: title.slice(0, 120) },
  });

  hud.once("ready-to-show", () => hud?.showInactive());
  setTimeout(() => {
    if (hud && !hud.isDestroyed() && !hud.isVisible()) hud.showInactive();
  }, 600);

  hud.on("closed", () => {
    hud = null;
  });

  unsubAbort = onAbort(() => hideHud());
}

export function updateHud(caption: string): void {
  if (!hud || hud.isDestroyed()) return;
  hud.webContents
    .executeJavaScript(
      `document.getElementById('caption').textContent = ${JSON.stringify(caption.slice(0, 120))};`
    )
    .catch(() => {});
}

export function hideHud(): void {
  if (unsubAbort) {
    unsubAbort();
    unsubAbort = null;
  }
  if (hud && !hud.isDestroyed()) {
    hud.close();
  }
  hud = null;
}
