/**
 * Screenpipe process manager.
 * Starts `npx screenpipe record` as a managed child process when the app
 * launches, keeps it alive if it crashes, and kills it when the app quits.
 *
 * The REST API at localhost:3030 is the only interface Ghostwork uses —
 * we never build our own capture layer, we just make sure the daemon is up.
 */

import { spawn, ChildProcess, execFile } from "child_process";
import { BrowserWindow } from "electron";
import { checkHealth, setScreenpipeAuthToken } from "./screenpipe";

const READY_POLL_MS = 2_000;
const READY_TIMEOUT_MS = 120_000;
const RESTART_DELAY_MS = 5_000;

let proc: ChildProcess | null = null;
let stopping = false;
let getWin: (() => BrowserWindow | null) | null = null;

export function initScreenpipeManager(
  windowGetter: () => BrowserWindow | null
): Promise<void> {
  getWin = windowGetter;
  return ensureRunning();
}

export function stopScreenpipeManager(): void {
  stopping = true;
  kill();
}

// ─── Internal ─────────────────────────────────────────────────────────────────

async function ensureRunning(): Promise<void> {
  if (stopping) return;

  // If already responding, just inject the token and skip launch
  const health = await checkHealth();
  if (health.status === "ok") {
    console.log("[screenpipe-mgr] Already running — skipping launch");
    await injectAuthToken();
    notify("status", { running: true, message: "Screenpipe already running" });
    return;
  }

  launch();
}

async function launch(): Promise<void> {
  if (stopping) return;
  console.log("[screenpipe-mgr] Launching screenpipe …");
  notify("status", { running: false, message: "Starting Screenpipe…" });

  // Use npx so no global install is needed — npx caches after first download
  proc = spawn("npx", ["screenpipe@latest", "record"], {
    shell: true,
    detached: false,
    env: {
      ...process.env,
      // Silence npx install progress noise on first run
      npm_config_loglevel: "error",
    },
  });

  proc.stdout?.on("data", (chunk: Buffer) => {
    const line = chunk.toString().trim();
    if (line) {
      console.log("[screenpipe]", line);
      // Relay notable lines to the renderer
      if (
        line.toLowerCase().includes("listening") ||
        line.toLowerCase().includes("started") ||
        line.toLowerCase().includes("ready") ||
        line.toLowerCase().includes("3030")
      ) {
        notify("log", { message: line });
      }
    }
  });

  proc.stderr?.on("data", (chunk: Buffer) => {
    const line = chunk.toString().trim();
    if (line) console.warn("[screenpipe-err]", line);
  });

  proc.on("error", (err) => {
    console.error("[screenpipe-mgr] Process error:", err.message);
    notify("status", { running: false, message: `Error: ${err.message}` });
  });

  proc.on("exit", (code, signal) => {
    proc = null;
    if (stopping) return;
    console.warn(
      `[screenpipe-mgr] Exited (code=${code} signal=${signal}) — restarting in ${RESTART_DELAY_MS / 1000}s`
    );
    notify("status", {
      running: false,
      message: `Screenpipe exited (${code ?? signal}), restarting…`,
    });
    setTimeout(launch, RESTART_DELAY_MS);
  });

  // Poll until the API is ready, then tell the renderer
  await waitUntilReady();
}

async function waitUntilReady(): Promise<void> {
  const deadline = Date.now() + READY_TIMEOUT_MS;
  while (Date.now() < deadline && !stopping) {
    await sleep(READY_POLL_MS);
    const health = await checkHealth();
    if (health.status === "ok") {
      console.log("[screenpipe-mgr] API ready at localhost:3030");
      await injectAuthToken();
      notify("status", { running: true, message: "Screenpipe running" });
      return;
    }
  }
  if (!stopping) {
    console.warn(
      "[screenpipe-mgr] Timed out waiting for Screenpipe. " +
        "Check macOS Screen Recording permission (System Settings → Privacy)."
    );
    notify("status", {
      running: false,
      message:
        "Screenpipe not responding. Grant Screen Recording permission in System Settings → Privacy & Security.",
    });
  }
}

/** Fetch the auth token via `npx screenpipe auth token` and inject it. */
async function injectAuthToken(): Promise<void> {
  return new Promise((resolve) => {
    execFile(
      "npx",
      ["screenpipe", "auth", "token"],
      { shell: true, timeout: 15000 },
      (err, stdout, stderr) => {
        if (err) {
          console.warn("[screenpipe-mgr] Could not fetch auth token:", err.message);
          resolve();
          return;
        }
        const token = (stdout || stderr || "").trim().split("\n").pop()?.trim() ?? "";
        if (token) {
          setScreenpipeAuthToken(token);
          console.log("[screenpipe-mgr] Auth token injected:", token.slice(0, 8) + "…");
        }
        resolve();
      }
    );
  });
}

function kill(): void {
  if (!proc) return;
  console.log("[screenpipe-mgr] Sending SIGTERM to screenpipe process");
  try {
    proc.kill("SIGTERM");
  } catch {
    // already dead
  }
  proc = null;
}

function notify(
  event: "status" | "log",
  payload: Record<string, unknown>
): void {
  const win = getWin?.();
  win?.webContents.send(`screenpipe-mgr:${event}`, payload);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
