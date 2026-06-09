import { contextBridge, ipcRenderer } from "electron";

contextBridge.exposeInMainWorld("correctionApi", {
  save: (text: string) => ipcRenderer.invoke("correction:save", text),
  skip: () => ipcRenderer.invoke("correction:skip"),
});
