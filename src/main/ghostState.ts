/**
 * Ambient ghost state — drives the menu-bar presence.
 *   observing: dim, default
 *   noticed:   a suggestion is waiting
 *   working:   executing a skill right now
 *   recording: teach mode active
 *
 * main.ts registers the actual tray updater; everyone else just calls
 * setGhostState() without importing the tray (avoids circular imports).
 */

export type GhostState = "observing" | "noticed" | "working" | "recording";

let current: GhostState = "observing";
let setter: (state: GhostState) => void = () => {};

export function registerGhostStateSetter(fn: (state: GhostState) => void): void {
  setter = fn;
  setter(current);
}

export function setGhostState(state: GhostState): void {
  current = state;
  try {
    setter(state);
  } catch {}
}

export function getGhostState(): GhostState {
  return current;
}
