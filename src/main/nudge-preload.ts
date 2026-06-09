import { contextBridge, ipcRenderer } from "electron";

contextBridge.exposeInMainWorld("nudgeApi", {
  doIt: () => ipcRenderer.invoke("nudge:do-it"),
  dismiss: () => ipcRenderer.invoke("nudge:dismiss"),
});
