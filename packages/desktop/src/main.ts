import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  Menu,
  nativeImage,
  shell,
  type NativeImage,
} from "electron";
import {
  startSettingsServer,
  type SettingsServer,
} from "@agentic-runtime/gui-server";

interface DesktopState {
  lastWorkspace?: string;
}

let mainWindow: BrowserWindow | undefined;
let settingsServer: SettingsServer | undefined;
let currentWorkspace: string | undefined;

const sourceDirectory = fileURLToPath(new URL(".", import.meta.url));
const smokeTest = process.env.AGENTIC_DESKTOP_SMOKE_TEST === "1";

function desktopStatePath(): string {
  return join(app.getPath("userData"), "desktop-state.json");
}

function loadDesktopState(): DesktopState {
  try {
    return JSON.parse(readFileSync(desktopStatePath(), "utf8")) as DesktopState;
  } catch {
    return {};
  }
}

function saveDesktopState(state: DesktopState): void {
  const path = desktopStatePath();
  mkdirSync(app.getPath("userData"), { recursive: true });
  writeFileSync(path, JSON.stringify(state, null, 2), "utf8");
}

function workspaceFromArguments(): string | undefined {
  const explicit = process.argv.find((argument) =>
    argument.startsWith("--workspace="),
  );
  const value = explicit?.slice("--workspace=".length).trim();
  return value ? resolve(value) : undefined;
}

function isWorkspace(path: string | undefined): path is string {
  return Boolean(path && existsSync(path));
}

async function chooseWorkspace(fallback?: string): Promise<string | undefined> {
  const options: Electron.OpenDialogOptions = {
    title: "Open a codebase",
    defaultPath: fallback,
    properties: ["openDirectory", "createDirectory"],
  };
  const result = await (mainWindow
    ? dialog.showOpenDialog(mainWindow, options)
    : dialog.showOpenDialog(options));
  return result.canceled ? undefined : result.filePaths[0];
}

async function resolveInitialWorkspace(): Promise<string | undefined> {
  const explicit =
    workspaceFromArguments() ?? process.env.AGENTIC_PROJECT_ROOT?.trim();
  if (isWorkspace(explicit)) return resolve(explicit);
  const lastWorkspace = loadDesktopState().lastWorkspace;
  if (isWorkspace(lastWorkspace)) return resolve(lastWorkspace);
  return undefined;
}

/** Product name, used for the window, menus, dialogs, and the splash page. */
const APP_NAME = "Agent Zero";

/**
 * The product mark as a data URI, or an empty string when it cannot be read.
 *
 * The folderless splash is loaded from a `data:` URL, so a relative image path
 * has nothing to resolve against; the bytes have to travel with the markup. The
 * file ships inside the GUI bundle, which is where both the packaged app and a
 * source checkout already look for static assets.
 */
function logoDataUri(): string {
  try {
    const bytes = readFileSync(join(staticGuiDirectory(), "logo.jpeg"));
    return `data:image/jpeg;base64,${bytes.toString("base64")}`;
  } catch {
    return "";
  }
}

function staticGuiDirectory(): string {
  return app.isPackaged
    ? join(process.resourcesPath, "gui")
    : resolve(sourceDirectory, "../../gui/dist");
}

function configurePackagedRuntime(): void {
  if (!app.isPackaged) return;
  const windows = process.platform === "win32";
  const ripgrepPath = join(
    process.resourcesPath,
    "runtime",
    windows ? "rg.exe" : "rg",
  );
  if (!existsSync(ripgrepPath)) {
    throw new Error(`The packaged ripgrep binary is missing: ${ripgrepPath}`);
  }
  process.env.AGENTIC_RIPGREP_PATH = ripgrepPath;

  // The Rust sidecar is optional at runtime - structural slicing, the AST diff
  // tool, and signature pruning degrade rather than fail without it - so a
  // missing binary is not fatal the way ripgrep is. It still has to be pointed
  // at explicitly, because a packaged app has no rust/target tree to search.
  const rustPath = join(
    process.resourcesPath,
    "runtime",
    windows ? "rust.exe" : "rust",
  );
  if (existsSync(rustPath)) process.env.AGENTIC_RUST_PATH = rustPath;
}

async function startWorkspace(workspaceRoot: string): Promise<void> {
  configurePackagedRuntime();
  const previousServer = settingsServer;
  settingsServer = undefined;
  if (previousServer) await previousServer.close();

  const server = startSettingsServer({
    projectRoot: workspaceRoot,
    port: 0,
    staticDir: staticGuiDirectory(),
    onOpenFolder: () => {
      void openWorkspace();
    },
  });
  try {
    await server.ready;
  } catch (error) {
    await server.close();
    throw error;
  }
  settingsServer = server;
  currentWorkspace = workspaceRoot;
  saveDesktopState({ lastWorkspace: workspaceRoot });
}

/**
 * Window and taskbar icon.
 *
 * Electron's `nativeImage` reads JPEG directly, so the same file the web app
 * serves is reused here. electron-builder is stricter and takes the generated
 * PNG/ICO under `build/` instead. An unreadable icon is not worth failing a
 * launch over, so this degrades to Electron's default.
 */
function windowIcon(): NativeImage | undefined {
  for (const candidate of [
    join(staticGuiDirectory(), "logo.png"),
    join(staticGuiDirectory(), "logo.jpeg"),
  ]) {
    try {
      const image = nativeImage.createFromPath(candidate);
      if (!image.isEmpty()) return image;
    } catch {
      // Try the next candidate.
    }
  }
  return undefined;
}

/**
 * On macOS, `titleBarStyle: "hiddenInset"` gives native traffic-light
 * buttons with no separate title/menu row for free - nothing else to build.
 * Windows and Linux have no such mode, so the window goes fully frameless
 * and the renderer's own title bar (App.tsx) draws the menu and window
 * controls, driven by the IPC bridge in preload.ts.
 */
function createWindow(): BrowserWindow {
  const icon = windowIcon();
  const window = new BrowserWindow({
    title: APP_NAME,
    ...(icon ? { icon } : {}),
    width: 1440,
    height: 900,
    minWidth: 1040,
    minHeight: 680,
    backgroundColor: "#0a0a0a",
    show: !smokeTest,
    frame: process.platform === "darwin",
    ...(process.platform === "darwin"
      ? { titleBarStyle: "hiddenInset" as const }
      : {}),
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      preload: join(sourceDirectory, "preload.cjs"),
    },
  });
  window.webContents.setWindowOpenHandler(({ url }) => {
    if (url === "agentic-ide://open-folder") {
      void openWorkspace();
      return { action: "deny" };
    }
    if (url.startsWith("https://")) void shell.openExternal(url);
    return { action: "deny" };
  });
  window.webContents.on("will-navigate", (event, url) => {
    if (url !== "agentic-ide://open-folder") return;
    event.preventDefault();
    void openWorkspace();
  });
  window.on("maximize", () =>
    window.webContents.send("window:maximized-changed", true),
  );
  window.on("unmaximize", () =>
    window.webContents.send("window:maximized-changed", false),
  );
  window.on("closed", () => {
    if (mainWindow === window) mainWindow = undefined;
  });
  return window;
}

async function loadWorkbench(): Promise<void> {
  if (!settingsServer) throw new Error("The workspace server is not running.");
  if (!mainWindow || mainWindow.isDestroyed()) mainWindow = createWindow();
  await mainWindow.loadURL(settingsServer.url);
}

async function loadFolderlessWelcome(): Promise<void> {
  if (!mainWindow || mainWindow.isDestroyed()) mainWindow = createWindow();
  const logo = logoDataUri();
  const html = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>${APP_NAME}</title>
    <style>
      :root { color-scheme: dark; font-family: Inter, ui-sans-serif, system-ui, sans-serif; background: #090909; color: #d4d4d4; }
      * { box-sizing: border-box; }
      body { margin: 0; min-height: 100vh; background: radial-gradient(circle at 50% 28%, rgba(99, 102, 241, .11), transparent 34%), #090909; }
      header { height: 36px; display: flex; align-items: center; gap: 9px; padding: 0 14px; border-bottom: 1px solid rgba(255,255,255,.06); background: #0d0d0d; font-size: 12px; }
      .mark { width: 20px; height: 20px; border-radius: 4px; object-fit: cover; }
      main { min-height: calc(100vh - 36px); display: grid; place-items: center; padding: 32px; }
      section { width: min(560px, 90vw); }
      .logo { width: 52px; height: 52px; border-radius: 10px; object-fit: cover; }
      h1 { margin: 20px 0 8px; font-size: 26px; font-weight: 580; letter-spacing: -.03em; color: #ededed; }
      p { margin: 0; color: #777; font-size: 13px; line-height: 1.7; }
      a { margin-top: 24px; display: inline-flex; align-items: center; gap: 9px; min-width: 168px; justify-content: center; padding: 10px 16px; border-radius: 6px; color: #f1f1f1; background: #4f46e5; text-decoration: none; font-size: 13px; box-shadow: 0 8px 32px rgba(79,70,229,.2); }
      a:hover { background: #5b52eb; }
      small { display: block; margin-top: 14px; color: #4e4e4e; font-size: 11px; }
    </style>
  </head>
  <body>
    <header><img class="mark" src="${logo}" alt="" /><span>${APP_NAME}</span></header>
    <main>
      <section>
        ${logo ? `<img class="logo" src="${logo}" alt="" />` : ""}
        <h1>Open a folder to start building.</h1>
        <p>No project is opened automatically. Select a codebase and ${APP_NAME} will create an isolated workspace, index its files, and connect the agent runtime.</p>
        <a href="agentic-ide://open-folder">Open Folder…</a>
        <small>You can also use File → Open Folder or Ctrl+Shift+O.</small>
      </section>
    </main>
  </body>
</html>`;
  await mainWindow.loadURL(
    `data:text/html;charset=utf-8,${encodeURIComponent(html)}`,
  );
}

async function openWorkspace(): Promise<void> {
  const recentWorkspace = loadDesktopState().lastWorkspace;
  const selected = await chooseWorkspace(currentWorkspace ?? recentWorkspace);
  if (!selected || selected === currentWorkspace) return;
  try {
    await startWorkspace(selected);
    await loadWorkbench();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const options: Electron.MessageBoxOptions = {
      type: "error",
      title: "Could not open workspace",
      message,
    };
    if (mainWindow) await dialog.showMessageBox(mainWindow, options);
    else await dialog.showMessageBox(options);
  }
}

async function closeWorkspace(): Promise<void> {
  const previousServer = settingsServer;
  settingsServer = undefined;
  currentWorkspace = undefined;
  if (previousServer) await previousServer.close();
  await loadFolderlessWelcome();
}

/**
 * Shared by the real (accelerator-bearing) application menu and by the
 * renderer title bar's per-label popups, so "File"/"Edit"/etc. behave
 * identically however they were opened.
 */
function buildMenuTemplate(): Electron.MenuItemConstructorOptions[] {
  return [
    {
      label: "File",
      submenu: [
        {
          label: "Open Folder…",
          accelerator: "CmdOrCtrl+Shift+O",
          click: () => void openWorkspace(),
        },
        {
          label: "Close Folder",
          click: () => void closeWorkspace(),
        },
        { type: "separator" },
        process.platform === "darwin" ? { role: "close" } : { role: "quit" },
      ],
    },
    {
      label: "Edit",
      submenu: [
        { role: "undo" },
        { role: "redo" },
        { type: "separator" },
        { role: "cut" },
        { role: "copy" },
        { role: "paste" },
        { role: "delete" },
        { type: "separator" },
        { role: "selectAll" },
      ],
    },
    {
      label: "View",
      submenu: [
        { role: "reload" },
        { role: "forceReload" },
        { type: "separator" },
        { role: "resetZoom" },
        { role: "zoomIn" },
        { role: "zoomOut" },
        { type: "separator" },
        { role: "togglefullscreen" },
        ...(!app.isPackaged
          ? ([
              { type: "separator" },
              { role: "toggleDevTools" },
            ] as Electron.MenuItemConstructorOptions[])
          : []),
      ],
    },
    {
      label: "Terminal",
      submenu: [
        {
          label: "Focus Terminal",
          accelerator: "Ctrl+`",
          click: () => void dispatchRendererEvent("agentic:open-terminal"),
        },
      ],
    },
    {
      label: "Help",
      submenu: [
        {
          label: `About ${APP_NAME}`,
          click: () =>
            void dialog.showMessageBox({
              type: "info",
              title: `About ${APP_NAME}`,
              message: APP_NAME,
              detail:
                "A local-first coding workbench with agent orchestration, editable Monaco files, multiple terminal profiles, and observable runtime execution.",
            }),
        },
      ],
    },
  ];
}

function installApplicationMenu(): void {
  Menu.setApplicationMenu(Menu.buildFromTemplate(buildMenuTemplate()));
}

/** Pops a single top-level menu (by its label, case-insensitive) at a screen position. */
function popupMenu(menuId: string, x: number, y: number): void {
  if (!mainWindow) return;
  const entry = buildMenuTemplate().find(
    (item) => item.label?.toLowerCase() === menuId.toLowerCase(),
  );
  const submenu = entry?.submenu;
  if (!Array.isArray(submenu)) return;
  Menu.buildFromTemplate(submenu).popup({ window: mainWindow, x, y });
}

async function dispatchRendererEvent(name: string): Promise<void> {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  await mainWindow.webContents.executeJavaScript(
    `window.dispatchEvent(new Event(${JSON.stringify(name)}))`,
  );
}

/** Backs the frameless-window title bar the renderer draws on Windows/Linux. */
function installWindowChromeIpc(): void {
  ipcMain.on("window:minimize", () => mainWindow?.minimize());
  ipcMain.on("window:toggle-maximize", () => {
    if (!mainWindow) return;
    if (mainWindow.isMaximized()) mainWindow.unmaximize();
    else mainWindow.maximize();
  });
  ipcMain.on("window:close", () => mainWindow?.close());
  ipcMain.handle(
    "window:is-maximized",
    () => mainWindow?.isMaximized() ?? false,
  );
  ipcMain.on(
    "menu:popup",
    (_event, menuId: unknown, x: unknown, y: unknown) => {
      if (
        typeof menuId !== "string" ||
        typeof x !== "number" ||
        typeof y !== "number"
      )
        return;
      popupMenu(menuId, x, y);
    },
  );
}

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

app.on("activate", () => {
  if (mainWindow) return;
  if (settingsServer) void loadWorkbench();
  else void loadFolderlessWelcome();
});

app.on("before-quit", () => {
  void settingsServer?.close();
});

async function bootstrap(): Promise<void> {
  try {
    installApplicationMenu();
    installWindowChromeIpc();
    const workspace = await resolveInitialWorkspace();
    if (!workspace) {
      await loadFolderlessWelcome();
      return;
    }
    await startWorkspace(workspace);
    await loadWorkbench();
    if (smokeTest) {
      console.log(`Desktop smoke test loaded ${settingsServer?.url}.`);
      await settingsServer?.close();
      settingsServer = undefined;
      app.quit();
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (smokeTest) {
      console.error(`Desktop smoke test failed: ${message}`);
      app.exit(1);
    } else {
      await dialog.showMessageBox({
        type: "error",
        title: `${APP_NAME} failed to start`,
        message,
      });
      app.quit();
    }
  }
}

void app.whenReady().then(() => bootstrap());
