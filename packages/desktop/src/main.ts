import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { app, BrowserWindow, dialog, Menu, shell } from "electron";
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
  return undefined;
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

function createWindow(): BrowserWindow {
  const window = new BrowserWindow({
    title: "Agentic IDE",
    width: 1440,
    height: 900,
    minWidth: 1040,
    minHeight: 680,
    backgroundColor: "#0a0a0a",
    show: !smokeTest,
    autoHideMenuBar: false,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
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
  const html = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>Agentic IDE</title>
    <style>
      :root { color-scheme: dark; font-family: Inter, ui-sans-serif, system-ui, sans-serif; background: #090909; color: #d4d4d4; }
      * { box-sizing: border-box; }
      body { margin: 0; min-height: 100vh; background: radial-gradient(circle at 50% 28%, rgba(99, 102, 241, .11), transparent 34%), #090909; }
      header { height: 36px; display: flex; align-items: center; gap: 9px; padding: 0 14px; border-bottom: 1px solid rgba(255,255,255,.06); background: #0d0d0d; font-size: 12px; }
      .mark { width: 20px; height: 20px; display: grid; place-items: center; border-radius: 4px; color: #818cf8; background: rgba(99,102,241,.12); }
      main { min-height: calc(100vh - 36px); display: grid; place-items: center; padding: 32px; }
      section { width: min(560px, 90vw); }
      .logo { width: 44px; height: 44px; display: grid; place-items: center; border: 1px solid rgba(129,140,248,.18); border-radius: 9px; background: rgba(99,102,241,.10); color: #a5b4fc; font-size: 22px; }
      h1 { margin: 20px 0 8px; font-size: 26px; font-weight: 580; letter-spacing: -.03em; color: #ededed; }
      p { margin: 0; color: #777; font-size: 13px; line-height: 1.7; }
      a { margin-top: 24px; display: inline-flex; align-items: center; gap: 9px; min-width: 168px; justify-content: center; padding: 10px 16px; border-radius: 6px; color: #f1f1f1; background: #4f46e5; text-decoration: none; font-size: 13px; box-shadow: 0 8px 32px rgba(79,70,229,.2); }
      a:hover { background: #5b52eb; }
      small { display: block; margin-top: 14px; color: #4e4e4e; font-size: 11px; }
    </style>
  </head>
  <body>
    <header><span class="mark">✦</span><span>Agentic IDE</span></header>
    <main>
      <section>
        <div class="logo">⌁</div>
        <h1>Open a folder to start building.</h1>
        <p>No project is opened automatically. Select a codebase and Agentic IDE will create an isolated workspace, index its files, and connect the agent runtime.</p>
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

function installApplicationMenu(): void {
  const template: Electron.MenuItemConstructorOptions[] = [
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
          label: "About Agentic IDE",
          click: () =>
            void dialog.showMessageBox({
              type: "info",
              title: "About Agentic IDE",
              message: "Agentic IDE",
              detail:
                "A local-first coding workbench with agent orchestration, editable Monaco files, multiple terminal profiles, and observable runtime execution.",
            }),
        },
      ],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

async function dispatchRendererEvent(name: string): Promise<void> {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  await mainWindow.webContents.executeJavaScript(
    `window.dispatchEvent(new Event(${JSON.stringify(name)}))`,
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
        title: "Agentic IDE failed to start",
        message,
      });
      app.quit();
    }
  }
}

void app.whenReady().then(() => bootstrap());
