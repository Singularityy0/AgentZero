// Sandboxed preload scripts (webPreferences.sandbox: true) must be
// CommonJS - Electron's sandbox context does not support ES module
// `import`, so this file is hand-written and copied into dist verbatim
// instead of going through the ESM-targeting tsc build.
const { contextBridge, ipcRenderer } = require("electron");

/**
 * Bridge for the in-window title bar (packages/gui's App.tsx). Kept minimal:
 * window state control, native menu popups anchored to a button's position,
 * and a platform flag so the renderer can skip drawing controls macOS
 * already gets for free via `titleBarStyle: "hiddenInset"`.
 */
contextBridge.exposeInMainWorld("agenticDesktop", {
  platform: process.platform,
  minimizeWindow: () => ipcRenderer.send("window:minimize"),
  toggleMaximizeWindow: () => ipcRenderer.send("window:toggle-maximize"),
  closeWindow: () => ipcRenderer.send("window:close"),
  isWindowMaximized: () => ipcRenderer.invoke("window:is-maximized"),
  onWindowMaximizedChange: (callback) => {
    const listener = (_event, maximized) => callback(maximized);
    ipcRenderer.on("window:maximized-changed", listener);
    return () => {
      ipcRenderer.removeListener("window:maximized-changed", listener);
    };
  },
  popupMenu: (menuId, x, y) => {
    ipcRenderer.send("menu:popup", menuId, x, y);
  },
});
