import {
  app,
  BrowserWindow,
  Tray,
  Menu,
  nativeImage,
  nativeTheme,
  ipcMain,
  dialog,
  globalShortcut,
  screen,
} from "electron";
import * as path from "path";
import * as fs from "fs";
import cron from "node-cron";
import * as dotenv from "dotenv";

// Load .env from project root (dev) or app resources (prod)
dotenv.config({ path: path.join(__dirname, "../../.env") });
dotenv.config({ path: path.join(process.resourcesPath ?? "", ".env") });

import { checkHealth, getRecentActivity } from "./screenpipe";
import { testConnection } from "./openrouter";
import {
  getDb,
  getAllWorkflows,
  getRulesForWorkflow,
  getAllRules,
  deleteWorkflow,
  deleteRule,
  updateWorkflowDescription,
  updateRuleCondition,
  pinWorkflow,
  recordCorrection,
  acceptRule,
  dismissRule,
  getRecentActivityLog,
  updateActivityStatus,
  logActivity,
  getSetting,
  setSetting,
  getAllSettings,
  exportModel,
  wipeModel,
  setRuleConfidenceZero,
  getDiagnostics,
  dedupRules,
} from "./db";
import { runExtractionJob } from "./extractor";
import { runNightlyConsolidation } from "./consolidation";
import { seedDemoData } from "./demo";
import { executeWithComputerUse } from "./computerUse";
import { startActionEngine, stopActionEngine } from "./actionEngine";
import { showNudgeWindow } from "./nudgeWindow";
import {
  initScreenpipeManager,
  stopScreenpipeManager,
} from "./screenpipeManager";
import {
  getAllSkills,
  getSkillById,
  deleteSkill,
  setSkillTrigger,
  SkillTriggerType,
} from "./db";
import {
  pendingApprovals,
  approveAndContinue,
  rejectApproval,
  registerApprovalsListener,
} from "./approvals";
import { computeReceipt, receiptSummaryLine } from "./receipt";
import { syncSkillSchedules, stopSkillSchedules } from "./skillScheduler";
import { registerGhostStateSetter, GhostState } from "./ghostState";
import { requestAbort } from "./abort";
import { startSessionIngester, stopSessionIngester } from "./sessionIngester";
import { getRecentSessions, getRawEventsForSession } from "./db";
import { writeBehaviourProfile } from "./behaviourProfile";
import {
  buildScreenpipeSessions,
  getScreenpipeSessionEvents,
  buildActivityText,
  queryAudioTranscriptions,
  queryRecentFrameTexts,
  ftsSearch,
  appUsageAnalytics,
} from "./screenpipeDb";

let mainWindow: BrowserWindow | null = null;
let tray: Tray | null = null;
let correctionWindow: BrowserWindow | null = null;
let correctionRuleId: number | null = null;
let correctionAutoCloseTimer: ReturnType<typeof setTimeout> | null = null;

// ─── Startup DB diagnostics ───────────────────────────────────────────────────

function logDbState(): void {
  try {
    const merged = dedupRules();
    if (merged > 0) console.log(`[db] Deduped ${merged} near-duplicate rule(s) at startup.`);
    const { rules, settings, activityCount } = getDiagnostics();
    console.log(`\n[db] ── Startup state ──────────────────────────────────`);
    console.log(`[db] Rules: ${rules.length}  |  Activity log entries: ${activityCount}`);
    console.log(`[db] Settings: autonomy_override=${settings.autonomy_override ?? "full"} | excluded_apps=${settings.excluded_apps ?? "[]"} | focus_categories_set=${settings.focus_categories_set ?? "0"} | focus_categories=${settings.focus_categories ?? "[]"}`);
    if (rules.length === 0) {
      console.log(`[db] No rules — Ghostwork needs to run the extractor to learn workflows`);
    } else {
      console.log(`[db] Rules (sorted by confidence):`);
      for (const r of rules) {
        const steps = (() => {
          try { return JSON.parse(r.action_steps ?? "[]") as string[]; } catch { return []; }
        })();
        console.log(`  #${r.id} [${r.workflow_name}] conf=${r.confidence.toFixed(2)} obs=${r.observed_count} accepts=${r.accept_count} dismissals=${r.dismiss_count}`);
        console.log(`       condition: "${r.condition.slice(0, 100)}"`);
        console.log(`       action:    "${r.action.slice(0, 100)}"`);
        console.log(`       steps:     ${steps.length > 0 ? steps.length + " recorded" : "(none)"}`);
      }
    }
    console.log(`[db] ────────────────────────────────────────────────────\n`);
  } catch (err) {
    console.error("[db] Could not dump state:", err);
  }
}

// ─── Screenpipe + OpenRouter bootstrap ───────────────────────────────────────

async function initConnections(): Promise<void> {
  // Screenpipe — the manager handles launch; we just log a quick status here
  const health = await checkHealth();
  console.log(`[boot] Screenpipe: ${health.status === "ok" ? "connected" : "waiting for manager to start it"}`);

  if (health.status === "ok") {
    try {
      const items = await getRecentActivity(1, [], 5);
      console.log(`[boot] Screenpipe has ${items.length} events in the last hour.`);
    } catch (err) {
      console.warn("[boot] Could not fetch screenpipe activity:", err);
    }
  }

  // OpenRouter — only log key presence, do NOT fire a live prompt on every boot
  const key = process.env.OPENROUTER_API_KEY ?? "";
  console.log(`[boot] OpenRouter: ${key ? "API key loaded (" + key.slice(0, 8) + "…)" : "no API key set"}`);
}

// ─── Scheduled jobs ───────────────────────────────────────────────────────────

function scheduleJobs(): void {
  // Hourly extraction — every hour at :00
  cron.schedule("0 * * * *", async () => {
    console.log("[cron] Hourly extraction triggered");
    await runExtractionJob().catch((err) =>
      console.error("[cron] Extraction error:", err)
    );
    mainWindow?.webContents.send("model:updated");
  });

  // Nightly consolidation — 2am
  cron.schedule("0 2 * * *", async () => {
    console.log("[cron] Nightly consolidation triggered");
    await runNightlyConsolidation().catch((err) =>
      console.error("[cron] Consolidation error:", err)
    );
    mainWindow?.webContents.send("model:updated");
  });

  // Weekly receipt — Monday 9am
  cron.schedule("0 9 * * 1", () => {
    try {
      const receipt = computeReceipt(7);
      const line = receiptSummaryLine(receipt);
      console.log(`[cron] Weekly receipt: ${line}`);
      mainWindow?.webContents.send("receipt:ready", receipt);
      showNudgeWindow({
        activityId: -999999,
        ruleId: -1,
        action: `Your week with Ghostwork: ${line}`,
        instruction: "",
        condition: "",
        onDoIt: () => {
          mainWindow?.show();
          mainWindow?.focus();
        },
        onDismiss: () => {},
      });
    } catch (err) {
      console.error("[cron] Receipt error:", err);
    }
  });

  console.log("[cron] Jobs scheduled: hourly extraction, nightly consolidation 2am, weekly receipt Mon 9am");
}

// ─── IPC handlers ────────────────────────────────────────────────────────────

function registerIpcHandlers(): void {
  // ── Screenpipe ──
  ipcMain.handle("screenpipe:health", () => checkHealth());
  ipcMain.handle(
    "screenpipe:recent",
    (_e, hours: number = 1, excludedApps: string[] = []) =>
      getRecentActivity(hours, excludedApps, 50).catch(() => [])
  );

  // ── OpenRouter ──
  // status: cheap key-presence check (no LLM call)
  ipcMain.handle("openrouter:status", () => ({
    hasKey: !!(process.env.OPENROUTER_API_KEY ?? ""),
  }));
  // test: explicit live call — only when user clicks the button
  ipcMain.handle("openrouter:test", () => testConnection());

  // ── Extraction ──
  ipcMain.handle("extractor:run", async () => {
    await runExtractionJob();
    return true;
  });

  // ── Workflows ──
  ipcMain.handle("db:workflows", () => getAllWorkflows());
  ipcMain.handle("db:rules-for-workflow", (_e, id: number) =>
    getRulesForWorkflow(id)
  );
  ipcMain.handle("db:delete-workflow", (_e, id: number) => {
    deleteWorkflow(id);
    return true;
  });
  ipcMain.handle(
    "db:update-workflow-desc",
    (_e, id: number, description: string) => {
      updateWorkflowDescription(id, description);
      return true;
    }
  );
  ipcMain.handle("db:pin-workflow", (_e, id: number, pinned: boolean) => {
    pinWorkflow(id, pinned);
    return true;
  });

  // ── Rules ──
  ipcMain.handle("db:delete-rule", (_e, id: number) => {
    deleteRule(id);
    return true;
  });
  ipcMain.handle(
    "db:update-rule-condition",
    (_e, id: number, condition: string) => {
      updateRuleCondition(id, condition);
      return true;
    }
  );
  ipcMain.handle("db:accept-rule", (_e, id: number) => {
    acceptRule(id);
    return true;
  });

  // Returns all rules joined with workflow name + computed tier — for the rule review UI.
  ipcMain.handle("db:all-rules", () => {
    const { rules } = getDiagnostics();
    return rules.map((r) => ({
      ...r,
      category: (r as unknown as { category?: string }).category ?? "navigation",
      tier: r.accept_count >= 5 ? "autonomous" : "supervised",
    }));
  });

  // Manual accept boost — lets the user vouch for a rule without waiting for it to fire.
  ipcMain.handle("db:boost-rule", (_e, id: number) => {
    acceptRule(id);
    return true;
  });
  ipcMain.handle(
    "db:correction",
    (_e, ruleId: number, expected: string, actual: string, note: string) => {
      recordCorrection(ruleId, expected, actual, note);
      // Dismissals/rejections also count against earned autonomy.
      if (/dismiss|reject/i.test(note)) dismissRule(ruleId);
      return true;
    }
  );

  // ── Activity log ──
  ipcMain.handle("db:activity-log", (_e, limit: number = 100) =>
    getRecentActivityLog(limit)
  );
  ipcMain.handle(
    "db:activity-status",
    (_e, id: number, status: string) => {
      updateActivityStatus(id, status as never);
      return true;
    }
  );

  // ── Settings ──
  ipcMain.handle("settings:get-all", () => getAllSettings());
  ipcMain.handle("settings:set", (_e, key: string, value: string) => {
    setSetting(key, value);
    // Keep process.env in sync when the API key is updated
    if (key === "openrouter_api_key") {
      process.env.OPENROUTER_API_KEY = value;
    }
    if (key === "anthropic_api_key") {
      process.env.ANTHROPIC_API_KEY = value;
    }
    return true;
  });
  ipcMain.handle("settings:get", (_e, key: string, fallback = "") =>
    getSetting(key, fallback)
  );

  // ── Computer use ──
  ipcMain.handle(
    "execute:task",
    async (_e, task: string, context: string = "") => {
      console.log(`[computer-use] Starting task: "${task.slice(0, 100)}"`);
      const result = await executeWithComputerUse(task, context, (step, actionName, detail) => {
        mainWindow?.webContents.send("execute:step", { step, actionName, detail });
      });
      if (result.success) {
        console.log(`[computer-use] ✓ Done in ${result.steps} steps (mode=${result.mode ?? "?"})`);
      } else {
        console.error(`[computer-use] ✗ Failed after ${result.steps} steps (mode=${result.mode ?? "?"}) — ${result.error}`);
      }
      return result;
    }
  );

  // ── Scripted demo — no API tokens needed ──
  ipcMain.handle("demo:run", async () => {
    const { execSync } = require("child_process") as typeof import("child_process");
    const emit = (step: number, actionName: string, detail = "") =>
      mainWindow?.webContents.send("execute:step", { step, actionName, detail });
    try {
      emit(1, "screenshot", "→ desktop visible");
      execSync("open -a Calculator", { timeout: 5000 });
      execSync("sleep 1.2");
      emit(2, "launch", "Calculator.app");
      // Focus and type the calculation via keystrokes
      execSync(
        `osascript -e 'tell application "System Events" to keystroke "1337"'`,
        { timeout: 5000 }
      );
      emit(3, "type", '"1337"');
      execSync(
        `osascript -e 'tell application "System Events" to key code 24'`, // +
        { timeout: 3000 }
      );
      emit(4, "key", '"+"');
      execSync(
        `osascript -e 'tell application "System Events" to keystroke "42"'`,
        { timeout: 5000 }
      );
      emit(5, "type", '"42"');
      execSync(
        `osascript -e 'tell application "System Events" to key code 36'`, // Return / =
        { timeout: 3000 }
      );
      emit(6, "key", '"=" → result: 1379');
      execSync("sleep 0.5");
      emit(7, "screenshot", "→ Calculator shows 1379 ✓");
      return { success: true };
    } catch (err) {
      return { success: false, error: String(err) };
    }
  });

  // ── Diagnostics ──
  ipcMain.handle("db:diagnostics", () => getDiagnostics());

  // ── Never suggest / confidence zero ──
  ipcMain.handle("db:set-rule-confidence-zero", (_e, id: number) => {
    setRuleConfidenceZero(id);
    return true;
  });

  // ── Correction window IPC ──
  ipcMain.handle("correction:save", (_e, text: string) => {
    if (correctionRuleId != null) {
      const rule = getAllRules().find((r) => r.id === correctionRuleId);
      if (rule) {
        recordCorrection(correctionRuleId, rule.action, text, "undo_correction");
        // Lower confidence by 0.2 (on top of the -0.15 already applied by recordCorrection).
        const db = getDb();
        db.prepare(
          "UPDATE rules SET confidence = MAX(0.0, confidence - 0.05) WHERE id = ?"
        ).run(correctionRuleId);
      }
    }
    if (correctionWindow && !correctionWindow.isDestroyed()) {
      correctionWindow.close();
    }
    return true;
  });

  ipcMain.handle("correction:skip", () => {
    if (correctionWindow && !correctionWindow.isDestroyed()) {
      correctionWindow.close();
    }
    return true;
  });

  // ── Skills ──
  ipcMain.handle("skills:list", () => getAllSkills());
  ipcMain.handle("skills:delete", (_e, id: number) => {
    deleteSkill(id);
    syncSkillSchedules();
    return true;
  });
  ipcMain.handle(
    "skills:set-trigger",
    (_e, id: number, type: string, value: string = "") => {
      setSkillTrigger(id, type as SkillTriggerType, value);
      syncSkillSchedules();
      return true;
    }
  );
  ipcMain.handle("skills:run", async (_e, id: number) => {
    const skill = getSkillById(id);
    if (!skill) return { success: false, error: "Skill not found" };
    const { replaySkill } = await import("./skillEngine");
    const result = await replaySkill(skill, {
      onStep: (step, actionName, detail) =>
        mainWindow?.webContents.send("execute:step", { step, actionName, detail }),
    });
    mainWindow?.webContents.send("skills:updated");
    return result;
  });

  // ── Approvals (shadow mode) ──
  ipcMain.handle("approvals:list", () => pendingApprovals());
  ipcMain.handle("approvals:approve", (_e, id: number) => approveAndContinue(id));
  ipcMain.handle("approvals:reject", (_e, id: number) => {
    rejectApproval(id);
    return true;
  });

  // ── Weekly receipt ──
  ipcMain.handle("receipt:get", (_e, days: number = 7) => computeReceipt(days));

  // ── Timeline (Screenpipe-native, idle-gap sessions) ──
  ipcMain.handle("timeline:sessions", (_e, days: number = 7) => {
    return buildScreenpipeSessions(days, 60);
  });

  ipcMain.handle("timeline:events", (_e, startedAt: string, endedAt: string) => {
    return getScreenpipeSessionEvents(startedAt, endedAt, 500);
  });

  // Legacy: Ghostwork's own raw_events sessions (kept for skill building)
  ipcMain.handle("timeline:sessions-legacy", (_e, days: number = 7) => {
    return getRecentSessions(days);
  });
  ipcMain.handle("timeline:events-legacy", (_e, sessionId: number) => {
    return getRawEventsForSession(sessionId);
  });

  ipcMain.handle("timeline:save-as-skill", async (_e, startedAt: string, endedAt: string) => {
    // Run extraction focused on this session's time window
    await runExtractionJob();
    mainWindow?.webContents.send("model:updated");
    return { ok: true };
  });

  // ── Activity text for extraction preview ──
  ipcMain.handle("timeline:activity-text", (_e, sinceIso: string, untilIso: string) => {
    return buildActivityText(sinceIso, untilIso, 10_000);
  });

  // ── FTS keyword search across all Screenpipe content ──
  ipcMain.handle("screenpipe:search", (_e, query: string, sinceIso?: string) => {
    return ftsSearch(query, sinceIso, 50);
  });

  // ── App usage analytics ──
  ipcMain.handle("analytics:app-usage", (_e, days: number = 7) => {
    return appUsageAnalytics(days);
  });

  // ── Behaviour profile ──
  ipcMain.handle("profile:refresh", () => {
    writeBehaviourProfile();
    return { ok: true };
  });

  // ── Debug: inspect raw Screenpipe DB events + audio + frames ──
  ipcMain.handle("debug:screenpipe-raw", async () => {
    const since = new Date(Date.now() - 15 * 60 * 1000).toISOString();
    const until = new Date().toISOString();
    try {
      const { queryUiEvents } = await import("./screenpipeDb");
      const events = queryUiEvents(since, until, 10);
      const audio = queryAudioTranscriptions(since, until, 5);
      const frames = queryRecentFrameTexts(since, until, 3);
      return { ok: true, events, audio, frames };
    } catch (err) {
      return { ok: false, error: String(err) };
    }
  });

  // ── Kill switch (renderer-side stop button) ──
  ipcMain.handle("execute:abort", () => {
    requestAbort();
    return true;
  });

  // ── Export / Wipe ──
  ipcMain.handle("db:export", async () => {
    const model = exportModel();
    const { filePath } = await dialog.showSaveDialog({
      title: "Export Behaviour Model",
      defaultPath: `ghostwork-model-${Date.now()}.json`,
      filters: [{ name: "JSON", extensions: ["json"] }],
    });
    if (filePath) {
      fs.writeFileSync(filePath, JSON.stringify(model, null, 2), "utf-8");
      return { saved: true, path: filePath };
    }
    return { saved: false };
  });
  ipcMain.handle("db:wipe", () => {
    wipeModel();
    mainWindow?.webContents.send("model:updated");
    return true;
  });
}

// ─── Tray ─────────────────────────────────────────────────────────────────────

function applyGhostStateToTray(state: GhostState): void {
  if (!tray) return;
  const titles: Record<GhostState, string> = {
    observing: "",
    working: " …",
  };
  const tooltips: Record<GhostState, string> = {
    observing: "Ghostwork — observing",
    working: "Ghostwork — working (Esc to stop)",
  };
  try {
    tray.setTitle(titles[state]);
    tray.setToolTip(tooltips[state]);
  } catch {}
}

function createTray(): void {
  const icon = nativeImage.createFromDataURL(buildTrayIconDataURL());
  icon.setTemplateImage(true);
  tray = new Tray(icon);
  tray.setToolTip("Ghostwork — observing");
  registerGhostStateSetter(applyGhostStateToTray);

  const contextMenu = Menu.buildFromTemplate([
    {
      label: "Show Ghostwork",
      click: () => {
        mainWindow ? (mainWindow.show(), mainWindow.focus()) : createWindow();
      },
    },
    { type: "separator" },
    {
      label: "Stop execution (Esc)",
      click: () => requestAbort(),
    },
    { type: "separator" },
    { label: "Quit", accelerator: "CmdOrCtrl+Q", click: () => app.quit() },
  ]);

  tray.setContextMenu(contextMenu);
  tray.on("click", () => {
    if (!mainWindow) return createWindow();
    mainWindow.isVisible() ? mainWindow.hide() : mainWindow.show();
  });
}

function buildTrayIconDataURL(): string {
  return (
    "data:image/png;base64," +
    "iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAACXBIWXMAAAsTAAALEwEAmpwYAAAA" +
    "AXNSR0IArs4c6QAAAARnQU1BAACxjwv8YQUAAABxSURBVHgB7ZKxDcAgDARdRmEURmEURmEURmEU" +
    "Bsm8gCUXiSL5U+okS37c2XcGgJ8kpfReSimVUrrWWp/MnMxMkiRJ0l1mRlU1IlJVjYioxcxMRCQi" +
    "IiIiIiIiIiIiIiJiZmZmZmZmZmZmZjIzM7OfBzYPGh6oiWX9AAAAAElFTkSuQmCC"
  );
}

// ─── Correction window ────────────────────────────────────────────────────────

function openCorrectionWindow(ruleId: number): void {
  if (correctionWindow && !correctionWindow.isDestroyed()) {
    correctionWindow.close();
  }
  correctionRuleId = ruleId;

  const { width, height } = screen.getPrimaryDisplay().workAreaSize;
  correctionWindow = new BrowserWindow({
    width: 300,
    height: 160,
    x: width - 316,
    y: height - 176,
    frame: false,
    alwaysOnTop: true,
    resizable: false,
    minimizable: false,
    maximizable: false,
    skipTaskbar: true,
    backgroundColor: "#0d0d0d",
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(__dirname, "correction-preload.js"),
    },
  });

  correctionWindow.loadFile(
    path.join(__dirname, "../renderer/correction.html")
  );

  correctionWindow.on("closed", () => {
    correctionWindow = null;
    correctionRuleId = null;
    if (correctionAutoCloseTimer) {
      clearTimeout(correctionAutoCloseTimer);
      correctionAutoCloseTimer = null;
    }
  });

  // Auto-close safety net at 16 s (the window's own JS closes at 15 s).
  correctionAutoCloseTimer = setTimeout(() => {
    if (correctionWindow && !correctionWindow.isDestroyed()) {
      correctionWindow.close();
    }
  }, 16_000);
}

// ─── Main window ──────────────────────────────────────────────────────────────

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 960,
    height: 700,
    minWidth: 720,
    minHeight: 540,
    title: "Ghostwork",
    backgroundColor: "#0d0d0d",
    titleBarStyle: "hiddenInset",
    trafficLightPosition: { x: 16, y: 16 },
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(__dirname, "preload.js"),
    },
  });

  mainWindow.loadFile(path.join(__dirname, "../renderer/index.html"));

  mainWindow.on("close", (e) => {
    e.preventDefault();
    mainWindow?.hide();
  });
  mainWindow.on("closed", () => { mainWindow = null; });
}

// ─── App lifecycle ────────────────────────────────────────────────────────────

app.whenReady().then(async () => {
  if (process.platform === "darwin") app.dock?.hide();

  // Initialise DB (creates schema)
  getDb();

  // Seed demo data on first launch
  seedDemoData();

  // Startup DB state dump — helps diagnose rule/settings issues.
  logDbState();

  // If user stored API keys in settings, load into env
  const storedKey = getSetting("openrouter_api_key", "");
  if (storedKey && !process.env.OPENROUTER_API_KEY) {
    process.env.OPENROUTER_API_KEY = storedKey;
  }
  const storedAnthropic = getSetting("anthropic_api_key", "");
  if (storedAnthropic && !process.env.ANTHROPIC_API_KEY) {
    process.env.ANTHROPIC_API_KEY = storedAnthropic;
  }

  registerIpcHandlers();
  createTray();
  createWindow();
  scheduleJobs();

  // Start Screenpipe daemon and inject its auth token before any /search calls.
  await initScreenpipeManager(() => mainWindow);

  // Start episodic memory ingestion — polls Screenpipe input stream every 2min.
  startSessionIngester();

  startActionEngine(() => mainWindow);

  // Arm scheduled skills and surface approval-queue changes to the UI.
  syncSkillSchedules();
  registerApprovalsListener(() => {
    mainWindow?.webContents.send("approvals:updated");
  });

  // Cmd+Z — intercept if there is a pending undo from an autonomous/supervised action.
  globalShortcut.register("CommandOrControl+Z", async () => {
    const raw = getSetting("pending_undo", "");
    if (!raw) return;
    try {
      const { activityId, ruleId, action } = JSON.parse(raw) as {
        activityId: number;
        ruleId: number;
        action: string;
      };
      updateActivityStatus(activityId, "undone");
      recordCorrection(ruleId, action, "", "");
      setSetting("pending_undo", "");
      openCorrectionWindow(ruleId);
    } catch (err) {
      console.error("[shortcut] Cmd+Z parse error:", err);
    }
  });

  // Non-blocking startup probes (runs after screenpipe manager kicks off)
  initConnections().catch((err) =>
    console.error("[boot] Connection init error:", err)
  );
});

app.on("window-all-closed", () => { /* stay alive in tray */ });

app.on("before-quit", () => {
  globalShortcut.unregisterAll();
  stopActionEngine();
  stopSessionIngester();
  stopSkillSchedules();
  stopScreenpipeManager();
  mainWindow?.removeAllListeners("close");
});

app.on("activate", () => {
  mainWindow ? mainWindow.show() : createWindow();
});
