/**
 * Execution kill switch.
 *
 * While any execution is running, the Escape key is registered as a global
 * shortcut that aborts it. Long-running loops call checkAbort() between
 * actions and bail out with AbortedError.
 */

import { globalShortcut } from "electron";

let aborted = false;
let activeExecutions = 0;
const listeners = new Set<() => void>();

export class AbortedError extends Error {
  constructor() {
    super("Execution aborted by user (Esc)");
    this.name = "AbortedError";
  }
}

export function beginExecution(): void {
  activeExecutions++;
  if (activeExecutions === 1) {
    aborted = false;
    try {
      globalShortcut.register("Escape", () => {
        console.log("[abort] Esc pressed — aborting execution");
        requestAbort();
      });
    } catch (err) {
      console.warn("[abort] Could not register Esc shortcut:", err);
    }
  }
}

export function endExecution(): void {
  activeExecutions = Math.max(0, activeExecutions - 1);
  if (activeExecutions === 0) {
    try {
      globalShortcut.unregister("Escape");
    } catch {}
    aborted = false;
  }
}

export function requestAbort(): void {
  aborted = true;
  for (const fn of listeners) {
    try {
      fn();
    } catch {}
  }
}

export function isAborted(): boolean {
  return aborted;
}

/** Throws AbortedError if the user hit the kill switch. */
export function checkAbort(): void {
  if (aborted) throw new AbortedError();
}

/** Notify when an abort is requested (e.g. to hide the HUD immediately). */
export function onAbort(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}
