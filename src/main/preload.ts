import { contextBridge, ipcRenderer } from "electron";

contextBridge.exposeInMainWorld("ghostwork", {
  platform: process.platform,

  openrouter: {
    status: () => ipcRenderer.invoke("openrouter:status"),
    test: () => ipcRenderer.invoke("openrouter:test"),
  },

  extractor: {
    run: () => ipcRenderer.invoke("extractor:run"),
  },

  execute: {
    task: (task: string, context?: string) =>
      ipcRenderer.invoke("execute:task", task, context ?? ""),
    demoRun: () => ipcRenderer.invoke("demo:run"),
    abort: () => ipcRenderer.invoke("execute:abort"),
  },

  teach: {
    start: () => ipcRenderer.invoke("teach:start"),
    stop: () => ipcRenderer.invoke("teach:stop"),
    status: () => ipcRenderer.invoke("teach:status"),
  },

  skills: {
    list: () => ipcRenderer.invoke("skills:list"),
    run: (id: number) => ipcRenderer.invoke("skills:run", id),
    remove: (id: number) => ipcRenderer.invoke("skills:delete", id),
    setTrigger: (id: number, type: string, value?: string) =>
      ipcRenderer.invoke("skills:set-trigger", id, type, value ?? ""),
  },

  approvals: {
    list: () => ipcRenderer.invoke("approvals:list"),
    approve: (id: number) => ipcRenderer.invoke("approvals:approve", id),
    reject: (id: number) => ipcRenderer.invoke("approvals:reject", id),
  },

  receipt: {
    get: (days?: number) => ipcRenderer.invoke("receipt:get", days ?? 7),
  },

  timeline: {
    sessions: (days?: number) => ipcRenderer.invoke("timeline:sessions", days ?? 7),
    /** Fetch enriched events for a session by its start/end timestamps */
    events: (startedAt: string, endedAt: string) =>
      ipcRenderer.invoke("timeline:events", startedAt, endedAt),
    saveAsSkill: (startedAt: string, endedAt: string) =>
      ipcRenderer.invoke("timeline:save-as-skill", startedAt, endedAt),
    /** Get a plain-text summary of activity in a time window */
    activityText: (sinceIso: string, untilIso: string) =>
      ipcRenderer.invoke("timeline:activity-text", sinceIso, untilIso),
  },

  screenpipe: {
    health: () => ipcRenderer.invoke("screenpipe:health"),
    recent: (hours?: number, excludedApps?: string[]) =>
      ipcRenderer.invoke("screenpipe:recent", hours, excludedApps),
    search: (query: string, sinceIso?: string) =>
      ipcRenderer.invoke("screenpipe:search", query, sinceIso),
  },

  analytics: {
    appUsage: (days?: number) => ipcRenderer.invoke("analytics:app-usage", days ?? 7),
  },

  profile: {
    refresh: () => ipcRenderer.invoke("profile:refresh"),
  },

  debug: {
    screenpipeRaw: () => ipcRenderer.invoke("debug:screenpipe-raw"),
  },

  db: {
    workflows: () => ipcRenderer.invoke("db:workflows"),
    rulesForWorkflow: (id: number) =>
      ipcRenderer.invoke("db:rules-for-workflow", id),
    deleteWorkflow: (id: number) => ipcRenderer.invoke("db:delete-workflow", id),
    updateWorkflowDesc: (id: number, desc: string) =>
      ipcRenderer.invoke("db:update-workflow-desc", id, desc),
    pinWorkflow: (id: number, pinned: boolean) =>
      ipcRenderer.invoke("db:pin-workflow", id, pinned),

    allRules: () => ipcRenderer.invoke("db:all-rules"),
    boostRule: (id: number) => ipcRenderer.invoke("db:boost-rule", id),
    deleteRule: (id: number) => ipcRenderer.invoke("db:delete-rule", id),
    updateRuleCondition: (id: number, condition: string) =>
      ipcRenderer.invoke("db:update-rule-condition", id, condition),
    acceptRule: (id: number) => ipcRenderer.invoke("db:accept-rule", id),
    correction: (ruleId: number, expected: string, actual: string, note: string) =>
      ipcRenderer.invoke("db:correction", ruleId, expected, actual, note),
    setRuleConfidenceZero: (id: number) =>
      ipcRenderer.invoke("db:set-rule-confidence-zero", id),

    activityLog: (limit?: number) => ipcRenderer.invoke("db:activity-log", limit),
    activityStatus: (id: number, status: string) =>
      ipcRenderer.invoke("db:activity-status", id, status),

    diagnostics: () => ipcRenderer.invoke("db:diagnostics"),
    export: () => ipcRenderer.invoke("db:export"),
    wipe: () => ipcRenderer.invoke("db:wipe"),
  },

  settings: {
    getAll: () => ipcRenderer.invoke("settings:get-all"),
    get: (key: string, fallback?: string) =>
      ipcRenderer.invoke("settings:get", key, fallback),
    set: (key: string, value: string) =>
      ipcRenderer.invoke("settings:set", key, value),
  },

  nudge: {
    test: () => ipcRenderer.invoke("nudge:test"),
  },

  on: (channel: string, fn: (...args: unknown[]) => void) => {
    const allowed = [
      "engine:suggest",
      "engine:supervised",
      "engine:activity",
      "engine:step",
      "execute:step",
      "model:updated",
      "screenpipe-mgr:status",
      "screenpipe-mgr:log",
      "skills:updated",
      "approvals:updated",
      "teach:status",
      "receipt:ready",
      "timeline:updated",
    ];
    if (allowed.includes(channel)) {
      ipcRenderer.on(channel, (_event, ...args) => fn(...args));
    }
  },

  off: (channel: string, fn: (...args: unknown[]) => void) => {
    ipcRenderer.removeListener(channel, fn as never);
  },
});
