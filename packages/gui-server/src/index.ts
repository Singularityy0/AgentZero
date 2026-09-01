import { createReadStream, existsSync, statSync } from "node:fs";
import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import { delimiter, extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import { executeCommand } from "@agentic-runtime/command";
import { stopRustEngine } from "@agentic-runtime/core";
import { DEFAULT_AGENT_ID, isSelectableAgent } from "@agentic-runtime/runtime";
import {
  PROVIDER_FIELD_SPECS,
  validateStoredProvider,
  type ProviderFieldSpec,
} from "@agentic-runtime/gateway";
import { findFiles, searchText } from "@agentic-runtime/search";
import {
  createWorkspaceWatcher,
  type WorkspaceWatcher,
} from "./workspace-watcher.js";
import { SessionStore } from "@agentic-runtime/session";
import { WorkspaceFileService } from "@agentic-runtime/workspace";
import { RuntimeTransport } from "./runtime-transport.js";

const DEFAULT_PORT = 4737;
const MAX_BODY_BYTES = 64 * 1024;
const MAX_SEARCH_RESULTS = 200;
const MAX_MANUAL_CONTEXT_CHARACTERS = 20_000;

interface TerminalProfile {
  id: string;
  label: string;
  shell: "cmd" | "powershell" | "posix";
  executable?: string;
}

export interface SettingsServerOptions {
  projectRoot: string;
  port?: number;
  /** Desktop-only callback used by the renderer's Open Folder action. */
  onOpenFolder?: () => void;
  /** Static GUI build to serve alongside the API. Defaults to the sibling
   * packages/gui/dist directory; pass false to disable static serving
   * (e.g. when a separate Vite dev server proxies /api to this port). */
  staticDir?: string | false;
}

export interface SettingsServer {
  readonly url: string;
  readonly port: number;
  readonly ready: Promise<void>;
  close(): Promise<void>;
}

export function startSettingsServer(
  options: SettingsServerOptions,
): SettingsServer {
  const store = new SessionStore({ projectRoot: options.projectRoot });
  const environmentPath = join(store.project.rootPath, ".env");
  if (existsSync(environmentPath)) {
    try {
      process.loadEnvFile(environmentPath);
    } catch {
      // Provider settings can still be supplied through the GUI.
    }
  }
  const workspace = new WorkspaceFileService(store.project.rootPath);
  const workspaceWatcher = createWorkspaceWatcher(store.project.rootPath);
  const runtimeTransport = new RuntimeTransport(store);
  const liveResponses = new Set<ServerResponse>();
  const staticDir =
    options.staticDir === false
      ? undefined
      : (options.staticDir ??
        fileURLToPath(new URL("../../gui/dist", import.meta.url)));

  const server = createServer((request, response) => {
    handleRequest(
      request,
      response,
      store,
      workspace,
      workspaceWatcher,
      runtimeTransport,
      liveResponses,
      staticDir,
      options.onOpenFolder,
    ).catch((error) => {
      if (response.headersSent) {
        response.end();
        return;
      }
      sendJson(response, 500, {
        error: error instanceof Error ? error.message : "Internal error.",
      });
    });
  });

  const requestedPort = options.port ?? DEFAULT_PORT;
  let boundPort = requestedPort;
  let storeClosed = false;
  const closeStore = (): void => {
    if (storeClosed) return;
    storeClosed = true;
    workspaceWatcher.close();
    store.close();
    // The Rust sidecar is a child process shared by the whole runtime. Closing
    // the server without stopping it leaves an orphan behind.
    stopRustEngine();
  };
  const ready = new Promise<void>((resolve, reject) => {
    const handleListening = (): void => {
      server.off("error", handleStartupError);
      const address = server.address();
      if (address && typeof address !== "string") boundPort = address.port;
      resolve();
    };
    const handleStartupError = (error: Error): void => {
      server.off("listening", handleListening);
      closeStore();
      reject(error);
    };
    server.once("listening", handleListening);
    server.once("error", handleStartupError);
  });
  // Bind to loopback only - this server reads/writes provider API keys and
  // must never be reachable from the network.
  server.listen(requestedPort, "127.0.0.1");

  return {
    get url() {
      return `http://127.0.0.1:${boundPort}`;
    },
    get port() {
      return boundPort;
    },
    ready,
    async close() {
      await ready.catch(() => undefined);
      for (const response of liveResponses) response.end();
      liveResponses.clear();
      await runtimeTransport.close();
      closeStore();
      if (!server.listening) return;
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    },
  };
}

async function handleRequest(
  request: IncomingMessage,
  response: ServerResponse,
  store: SessionStore,
  workspace: WorkspaceFileService,
  workspaceWatcher: WorkspaceWatcher,
  runtimeTransport: RuntimeTransport,
  liveResponses: Set<ServerResponse>,
  staticDir: string | undefined,
  onOpenFolder: (() => void) | undefined,
): Promise<void> {
  const url = new URL(request.url ?? "/", "http://127.0.0.1");
  const method = request.method ?? "GET";

  if (url.pathname === "/api/desktop/open-folder" && method === "POST") {
    if (!onOpenFolder) {
      sendJson(response, 501, {
        error: "Open Folder is available in the desktop application.",
      });
      return;
    }
    sendJson(response, 202, { opening: true });
    setImmediate(onOpenFolder);
    return;
  }

  if (url.pathname === "/api/project" && method === "GET") {
    sendJson(response, 200, {
      rootPath: store.project.rootPath,
      name:
        store.project.rootPath.split(/[/\\]/).pop() ?? store.project.rootPath,
    });
    return;
  }

  if (url.pathname === "/api/runtime/status" && method === "GET") {
    sendJson(response, 200, { runtime: runtimeTransport.status() });
    return;
  }

  if (url.pathname === "/api/runtime/config" && method === "PUT") {
    const body = (await readJsonBody(request)) as Record<string, unknown>;
    const providerId =
      typeof body.providerId === "string" ? body.providerId : "";
    const modelId = typeof body.modelId === "string" ? body.modelId : undefined;
    await runtimeTransport.configure(providerId, modelId);
    sendJson(response, 200, { runtime: runtimeTransport.status() });
    return;
  }

  if (url.pathname === "/api/workspace/events" && method === "GET") {
    response.writeHead(200, {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
    });
    response.write(": connected\n\n");
    liveResponses.add(response);
    const unsubscribe = workspaceWatcher.subscribe((change) => {
      if (response.destroyed) return;
      response.write(`data: ${JSON.stringify(change)}\n\n`);
    });
    const keepAlive = setInterval(() => {
      if (!response.destroyed) response.write(": keep-alive\n\n");
    }, 15_000);
    const cleanup = (): void => {
      clearInterval(keepAlive);
      unsubscribe();
      liveResponses.delete(response);
    };
    request.once("close", cleanup);
    response.once("close", cleanup);
    return;
  }

  if (url.pathname === "/api/runtime/events" && method === "GET") {
    const sessionId = url.searchParams.get("sessionId");
    if (!sessionId || !store.getSession(sessionId)) {
      sendJson(response, 400, { error: "A valid sessionId is required." });
      return;
    }
    response.writeHead(200, {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
    });
    response.write(": connected\n\n");
    liveResponses.add(response);
    const unsubscribe = runtimeTransport.subscribe((event) => {
      if (event.sessionId !== sessionId || response.destroyed) return;
      response.write(`data: ${JSON.stringify(event)}\n\n`);
    });
    const keepAlive = setInterval(() => {
      if (!response.destroyed) response.write(": keep-alive\n\n");
    }, 15_000);
    const cleanup = (): void => {
      clearInterval(keepAlive);
      unsubscribe();
      liveResponses.delete(response);
    };
    request.once("close", cleanup);
    response.once("close", cleanup);
    return;
  }

  if (url.pathname === "/api/tasks" && method === "POST") {
    const body = (await readJsonBody(request)) as Record<string, unknown>;
    const sessionId = typeof body.sessionId === "string" ? body.sessionId : "";
    const agentId = typeof body.agentId === "string" ? body.agentId : undefined;
    const prompt = typeof body.prompt === "string" ? body.prompt : "";
    if (!store.getSession(sessionId)) {
      sendJson(response, 400, { error: "A valid sessionId is required." });
      return;
    }
    if (!prompt.trim()) {
      sendJson(response, 400, { error: "A task prompt is required." });
      return;
    }
    if (agentId && !store.getAgent(agentId)?.enabled) {
      sendJson(response, 400, { error: "An enabled agentId is required." });
      return;
    }
    if (!runtimeTransport.status().ready) {
      sendJson(response, 409, {
        error: "Configure a runtime provider and model in Settings first.",
      });
      return;
    }
    let handle: Awaited<ReturnType<RuntimeTransport["startTask"]>>;
    try {
      handle = await runtimeTransport.startTask({ sessionId, agentId, prompt });
    } catch (error) {
      sendJson(response, 409, {
        error: error instanceof Error ? error.message : "Task could not start.",
      });
      return;
    }
    sendJson(response, 202, {
      sessionId: handle.sessionId,
      taskId: handle.taskId,
      status: "running",
    });
    return;
  }

  const taskMatch = url.pathname.match(/^\/api\/tasks\/([^/]+)$/);
  if (taskMatch && method === "GET") {
    const task = store.getTask(decodeURIComponent(taskMatch[1]!));
    if (!task) {
      sendJson(response, 404, { error: "Task not found." });
      return;
    }
    sendJson(response, 200, {
      task: {
        id: task.id,
        sessionId: task.sessionId,
        prompt: task.prompt,
        status: task.status,
        currentStage: task.currentStage,
        updatedAt: task.updatedAt,
      },
    });
    return;
  }

  const cancelTaskMatch = url.pathname.match(/^\/api\/tasks\/([^/]+)\/cancel$/);
  if (cancelTaskMatch && method === "POST") {
    const taskId = decodeURIComponent(cancelTaskMatch[1]!);
    const cancelled = runtimeTransport.cancelTask(taskId);
    sendJson(response, cancelled ? 202 : 404, {
      cancelled,
      ...(cancelled ? {} : { error: "Active task not found." }),
    });
    return;
  }

  const approvalMatch = url.pathname.match(/^\/api\/approvals\/([^/]+)$/);
  if (approvalMatch && method === "POST") {
    const requestId = decodeURIComponent(approvalMatch[1]!);
    const body = (await readJsonBody(request)) as Record<string, unknown>;
    let decision:
      boolean | { acceptedHunkIds: string[]; rejectedHunkIds: string[] };
    if (typeof body.approved === "boolean") {
      decision = body.approved;
    } else if (
      Array.isArray(body.acceptedHunkIds) &&
      Array.isArray(body.rejectedHunkIds)
    ) {
      decision = {
        acceptedHunkIds: body.acceptedHunkIds.filter(
          (value): value is string => typeof value === "string",
        ),
        rejectedHunkIds: body.rejectedHunkIds.filter(
          (value): value is string => typeof value === "string",
        ),
      };
    } else {
      sendJson(response, 400, { error: "An approval decision is required." });
      return;
    }
    const resolved = runtimeTransport.resolveApproval(requestId, decision);
    sendJson(response, resolved ? 200 : 404, {
      resolved,
      ...(resolved ? {} : { error: "Approval request not found." }),
    });
    return;
  }

  if (url.pathname === "/api/files" && method === "GET") {
    try {
      const entries = await workspace.listDirectory(
        url.searchParams.get("path") ?? ".",
      );
      sendJson(response, 200, {
        entries: entries
          .map((entry) => ({
            name: entry.name,
            path: entry.path,
            type: entry.type,
            size: entry.size,
          }))
          .sort(
            (a, b) =>
              Number(b.type === "directory") - Number(a.type === "directory") ||
              a.name.localeCompare(b.name),
          ),
      });
    } catch (error) {
      sendJson(response, 400, {
        error:
          error instanceof Error ? error.message : "Could not list directory.",
      });
    }
    return;
  }

  if (url.pathname === "/api/files/content" && method === "GET") {
    const path = url.searchParams.get("path");
    if (!path) {
      sendJson(response, 400, { error: "path query parameter is required." });
      return;
    }
    try {
      const file = await workspace.readText(path);
      sendJson(response, 200, file);
    } catch (error) {
      sendJson(response, 400, {
        error: error instanceof Error ? error.message : "Could not read file.",
      });
    }
    return;
  }

  if (url.pathname === "/api/files/content" && method === "PUT") {
    const body = (await readJsonBody(request)) as Record<string, unknown>;
    const path = typeof body.path === "string" ? body.path : "";
    const content = typeof body.content === "string" ? body.content : undefined;
    const expectedHash =
      typeof body.expectedHash === "string" || body.expectedHash === null
        ? body.expectedHash
        : undefined;
    if (!path || content === undefined) {
      sendJson(response, 400, { error: "path and content are required." });
      return;
    }
    try {
      const result = await workspace.applyChange({
        path,
        newContent: content,
        expectedHash,
      });
      const file = await workspace.readText(path);
      sendJson(response, 200, { file, result });
    } catch (error) {
      sendJson(response, 409, {
        error: error instanceof Error ? error.message : "Could not save file.",
      });
    }
    return;
  }

  if (url.pathname === "/api/terminal/profiles" && method === "GET") {
    sendJson(response, 200, { profiles: terminalProfiles() });
    return;
  }

  if (url.pathname === "/api/terminal/execute" && method === "POST") {
    const body = (await readJsonBody(request)) as Record<string, unknown>;
    const command = typeof body.command === "string" ? body.command.trim() : "";
    const profileId =
      typeof body.profileId === "string" ? body.profileId : undefined;
    if (!command) {
      sendJson(response, 400, { error: "A command is required." });
      return;
    }
    if (command.length > 4_000) {
      sendJson(response, 400, { error: "Command exceeds 4,000 characters." });
      return;
    }
    const profiles = terminalProfiles();
    const profile =
      profiles.find((candidate) => candidate.id === profileId) ?? profiles[0];
    if (!profile) {
      sendJson(response, 503, { error: "No supported terminal shell found." });
      return;
    }
    const controller = new AbortController();
    request.once("aborted", () => controller.abort());
    try {
      const result = await executeCommand(
        command,
        {
          cwd: store.project.rootPath,
          signal: controller.signal,
          requestApproval: async () => true,
        },
        { shell: profile.shell, executable: profile.executable },
      );
      sendJson(response, 200, {
        command,
        profileId: profile.id,
        profileLabel: profile.label,
        cwd: store.project.rootPath,
        output: result.output,
        exitCode: result.exitCode ?? -1,
        timedOut: result.timedOut ?? false,
        truncated: result.truncated ?? false,
      });
    } catch (error) {
      sendJson(response, 400, {
        error:
          error instanceof Error ? error.message : "Command execution failed.",
      });
    }
    return;
  }

  if (url.pathname === "/api/search" && method === "GET") {
    const pattern = url.searchParams.get("q");
    if (!pattern) {
      sendJson(response, 200, { matches: [] });
      return;
    }
    try {
      const matches = await searchText({
        root: store.project.rootPath,
        pattern,
        glob: url.searchParams.get("glob") ?? undefined,
        maxResults: MAX_SEARCH_RESULTS,
      });
      sendJson(response, 200, { matches });
    } catch (error) {
      sendJson(response, 400, {
        error: error instanceof Error ? error.message : "Search failed.",
      });
    }
    return;
  }

  // Flat, ranked file list backing @-mention completion in the composer.
  // Explorer file management. These are direct human actions, so unlike agent
  // mutations they are not approval-gated - the person clicking is the approver.
  if (url.pathname === "/api/files/entry" && method === "POST") {
    const body = (await readJsonBody(request)) as Record<string, unknown>;
    const path = typeof body.path === "string" ? body.path.trim() : "";
    const type = body.type === "directory" ? "directory" : "file";
    if (!path) {
      sendJson(response, 400, { error: "A path is required." });
      return;
    }
    try {
      const created =
        type === "directory"
          ? await workspace.createDirectory(path)
          : await workspace.createEmptyFile(path);
      sendJson(response, 201, { path: created, type });
    } catch (error) {
      sendJson(response, 400, {
        error:
          error instanceof Error
            ? error.message
            : "Could not create the entry.",
      });
    }
    return;
  }

  // Copy, paste, and duplicate. `to` is a desired path; a collision is resolved
  // by suffixing rather than by overwriting whatever is already there.
  if (url.pathname === "/api/files/copy" && method === "POST") {
    const body = (await readJsonBody(request)) as Record<string, unknown>;
    const from = typeof body.from === "string" ? body.from.trim() : "";
    const to = typeof body.to === "string" ? body.to.trim() : "";
    if (!from || !to) {
      sendJson(response, 400, { error: "Both from and to are required." });
      return;
    }
    try {
      sendJson(response, 201, { path: await workspace.copyEntry(from, to) });
    } catch (error) {
      sendJson(response, 400, {
        error:
          error instanceof Error ? error.message : "Could not copy the entry.",
      });
    }
    return;
  }

  if (url.pathname === "/api/files/entry" && method === "PATCH") {
    const body = (await readJsonBody(request)) as Record<string, unknown>;
    const from = typeof body.from === "string" ? body.from.trim() : "";
    const to = typeof body.to === "string" ? body.to.trim() : "";
    if (!from || !to) {
      sendJson(response, 400, { error: "Both from and to are required." });
      return;
    }
    try {
      sendJson(response, 200, { path: await workspace.renameEntry(from, to) });
    } catch (error) {
      sendJson(response, 400, {
        error:
          error instanceof Error
            ? error.message
            : "Could not rename the entry.",
      });
    }
    return;
  }

  if (url.pathname === "/api/files/entry" && method === "DELETE") {
    const path = (url.searchParams.get("path") ?? "").trim();
    if (!path) {
      sendJson(response, 400, { error: "A path is required." });
      return;
    }
    try {
      await workspace.removeEntry(path);
      sendJson(response, 200, { deleted: path });
    } catch (error) {
      sendJson(response, 400, {
        error:
          error instanceof Error
            ? error.message
            : "Could not delete the entry.",
      });
    }
    return;
  }

  if (url.pathname === "/api/files/lookup" && method === "GET") {
    const query = (url.searchParams.get("q") ?? "").trim().toLowerCase();
    try {
      const paths = await findFiles(store.project.rootPath);
      const ranked = query
        ? paths
            .filter((path) => path.toLowerCase().includes(query))
            .sort((a, b) => {
              const aName = a.slice(a.lastIndexOf("/") + 1).toLowerCase();
              const bName = b.slice(b.lastIndexOf("/") + 1).toLowerCase();
              return (
                Number(bName.startsWith(query)) -
                  Number(aName.startsWith(query)) ||
                a.length - b.length ||
                a.localeCompare(b)
              );
            })
        : paths;
      sendJson(response, 200, { paths: ranked.slice(0, 25) });
    } catch (error) {
      sendJson(response, 400, {
        error: error instanceof Error ? error.message : "Could not list files.",
      });
    }
    return;
  }

  if (url.pathname === "/api/workbench" && method === "GET") {
    sendJson(response, 200, {
      project: {
        id: store.project.id,
        rootPath: store.project.rootPath,
        name:
          store.project.rootPath.split(/[/\\]/).pop() ?? store.project.rootPath,
      },
      sessions: store.listSessions(),
      tasks: store.listTasks(),
      // `automatic` marks the agent that routes a prompt to the right place on
      // its own; `selectable` hides the pipeline stages the runtime drives
      // itself, which are not modes a user can meaningfully choose.
      agents: store.listAgents().map((agent) => ({
        id: agent.id,
        name: agent.name,
        description: agent.description,
        enabled: agent.enabled,
        selectable: isSelectableAgent(agent.id),
        automatic: agent.id === DEFAULT_AGENT_ID,
      })),
    });
    return;
  }

  if (url.pathname === "/api/sessions" && method === "POST") {
    const body = (await readJsonBody(request)) as { title?: unknown };
    const title =
      typeof body.title === "string" && body.title.trim()
        ? body.title.trim().slice(0, 120)
        : "New session";
    sendJson(response, 201, { session: store.createSession(title) });
    return;
  }

  const sessionEventsMatch = url.pathname.match(
    /^\/api\/sessions\/([^/]+)\/events$/,
  );
  if (sessionEventsMatch && method === "GET") {
    const sessionId = decodeURIComponent(sessionEventsMatch[1]!);
    if (!store.getSession(sessionId)) {
      sendJson(response, 404, { error: "Session not found." });
      return;
    }
    sendJson(response, 200, { events: store.listEvents(sessionId) });
    return;
  }

  const resumeMatch = url.pathname.match(/^\/api\/tasks\/([^/]+)\/resume$/);
  if (resumeMatch && method === "POST") {
    const taskId = decodeURIComponent(resumeMatch[1]!);
    const task = store.getTask(taskId);
    if (!task) {
      sendJson(response, 404, { error: "Task not found." });
      return;
    }
    if (task.status === "completed" || task.status === "running") {
      sendJson(response, 409, {
        error: `Task is ${task.status} and cannot be resumed.`,
      });
      return;
    }
    try {
      const handle = await runtimeTransport.resumeTask(taskId);
      sendJson(response, 202, {
        sessionId: handle.sessionId,
        taskId: handle.taskId,
      });
    } catch (error) {
      sendJson(response, 500, {
        error:
          error instanceof Error ? error.message : "Could not resume the task.",
      });
    }
    return;
  }

  const spendMatch = url.pathname.match(/^\/api\/tasks\/([^/]+)\/spend$/);
  if (spendMatch && method === "GET") {
    const taskId = decodeURIComponent(spendMatch[1]!);
    if (!store.getTask(taskId)) {
      sendJson(response, 404, { error: "Task not found." });
      return;
    }
    sendJson(response, 200, { spend: runtimeTransport.taskSpend(taskId) });
    return;
  }

  const taskTracesMatch = url.pathname.match(/^\/api\/tasks\/([^/]+)\/traces$/);
  if (taskTracesMatch && method === "GET") {
    const taskId = decodeURIComponent(taskTracesMatch[1]!);
    if (!store.getTask(taskId)) {
      sendJson(response, 404, { error: "Task not found." });
      return;
    }
    sendJson(response, 200, { spans: store.listTraceSpans(taskId) });
    return;
  }

  if (url.pathname === "/api/bytheway" && method === "POST") {
    const body = (await readJsonBody(request)) as Record<string, unknown>;
    const sessionId = typeof body.sessionId === "string" ? body.sessionId : "";
    const prompt = typeof body.prompt === "string" ? body.prompt.trim() : "";
    if (!store.getSession(sessionId) || !prompt) {
      sendJson(response, 400, {
        error: "A valid sessionId and question are required.",
      });
      return;
    }
    try {
      const text = await runtimeTransport.askIsolatedQuestion({
        sessionId,
        prompt,
        ...(typeof body.agentId === "string" ? { agentId: body.agentId } : {}),
      });
      sendJson(response, 200, { text });
    } catch (error) {
      sendJson(response, 500, {
        error:
          error instanceof Error
            ? error.message
            : "The isolated question failed.",
      });
    }
    return;
  }

  if (url.pathname === "/api/context" && method === "GET") {
    const sessionId = url.searchParams.get("sessionId");
    if (!sessionId || !store.getSession(sessionId)) {
      sendJson(response, 400, { error: "A valid sessionId is required." });
      return;
    }
    const items = store
      .listContextItems(sessionId, undefined)
      .filter(
        (item) =>
          item.sessionId === sessionId &&
          item.taskId === undefined &&
          item.source === "file",
      );
    sendJson(response, 200, { items });
    return;
  }

  if (url.pathname === "/api/context" && method === "POST") {
    const body = (await readJsonBody(request)) as Record<string, unknown>;
    const sessionId = typeof body.sessionId === "string" ? body.sessionId : "";
    const path = typeof body.path === "string" ? body.path : "";
    if (!store.getSession(sessionId) || !path) {
      sendJson(response, 400, {
        error: "A valid sessionId and path are required.",
      });
      return;
    }
    try {
      const file = await workspace.readText(path);
      const lines = file.content.split(/\r?\n/);
      const startLine = toPositiveInteger(body.startLine);
      const endLine = toPositiveInteger(body.endLine);
      if ((startLine === undefined) !== (endLine === undefined)) {
        throw new Error("Both startLine and endLine are required for a range.");
      }
      if (
        startLine !== undefined &&
        endLine !== undefined &&
        (startLine > endLine || endLine > lines.length)
      ) {
        throw new Error(`Line range must be within 1-${lines.length}.`);
      }
      const content =
        startLine === undefined || endLine === undefined
          ? file.content
          : lines.slice(startLine - 1, endLine).join("\n");
      const existing = store
        .listContextItems(sessionId, undefined)
        .find(
          (item) =>
            item.source === "file" &&
            item.filePath === file.path &&
            item.startLine === startLine &&
            item.endLine === endLine,
        );
      if (existing) {
        sendJson(response, 200, { item: existing });
        return;
      }
      const used = store
        .listContextItems(sessionId, undefined)
        .filter(
          (item) => item.source === "file" && item.sessionId === sessionId,
        )
        .reduce((total, item) => total + item.content.length, 0);
      if (used + content.length > MAX_MANUAL_CONTEXT_CHARACTERS) {
        throw new Error(
          `Manual context exceeds the ${MAX_MANUAL_CONTEXT_CHARACTERS}-character budget. Select a smaller line range.`,
        );
      }
      const label =
        startLine === undefined
          ? file.path
          : `${file.path}:${startLine}-${endLine}`;
      const item = store.addContextItem({
        sessionId,
        source: "file",
        content: `[File context: ${label}]\n${content}`,
        filePath: file.path,
        startLine,
        endLine,
        priority: "high",
        pinned: true,
        tokenEstimate: Math.max(1, Math.ceil(content.length / 4)),
      });
      sendJson(response, 201, { item });
    } catch (error) {
      sendJson(response, 400, {
        error:
          error instanceof Error ? error.message : "Could not add context.",
      });
    }
    return;
  }

  const contextMatch = url.pathname.match(/^\/api\/context\/([^/]+)$/);
  if (contextMatch && method === "DELETE") {
    const itemId = decodeURIComponent(contextMatch[1]!);
    const sessionId = url.searchParams.get("sessionId");
    if (!sessionId || !store.getSession(sessionId)) {
      sendJson(response, 400, { error: "A valid sessionId is required." });
      return;
    }
    const removed = store.removeContextItem(sessionId, itemId);
    sendJson(response, removed ? 200 : 404, { removed });
    return;
  }

  if (url.pathname === "/api/providers" && method === "GET") {
    sendJson(response, 200, { providers: listProviders(store) });
    return;
  }

  const providerMatch = url.pathname.match(/^\/api\/providers\/([^/]+)$/);
  if (providerMatch) {
    const providerId = decodeURIComponent(providerMatch[1]!);
    const spec = findSpec(providerId);
    if (!spec) {
      sendJson(response, 404, { error: `Unknown provider: ${providerId}` });
      return;
    }
    if (method === "PUT") {
      const body = await readJsonBody(request);
      await runtimeTransport.prepareForConfigurationChange();
      applyProviderUpdate(store, spec, body);
      sendJson(response, 200, { provider: describeProvider(store, spec) });
      return;
    }
    if (method === "DELETE") {
      await runtimeTransport.prepareForConfigurationChange();
      clearProvider(store, spec);
      sendJson(response, 200, { provider: describeProvider(store, spec) });
      return;
    }
  }

  const validateMatch = url.pathname.match(
    /^\/api\/providers\/([^/]+)\/validate$/,
  );
  if (validateMatch && method === "POST") {
    const providerId = decodeURIComponent(validateMatch[1]!);
    const spec = findSpec(providerId);
    if (!spec) {
      sendJson(response, 404, { error: `Unknown provider: ${providerId}` });
      return;
    }
    const result = await validateProvider(store, spec);
    sendJson(response, 200, { result });
    return;
  }

  if (staticDir && method === "GET" && !url.pathname.startsWith("/api/")) {
    serveStatic(url.pathname, staticDir, response);
    return;
  }

  sendJson(response, 404, { error: "Not found." });
}

function terminalProfiles(): TerminalProfile[] {
  if (process.platform !== "win32") {
    const executable = process.env.SHELL?.trim() || "/bin/sh";
    return [{ id: "bash", label: "Bash", shell: "posix", executable }];
  }

  const profiles: TerminalProfile[] = [];
  const powerShell7 = executableOnPath("pwsh.exe");
  if (powerShell7) {
    profiles.push({
      id: "pwsh",
      label: "PowerShell",
      shell: "powershell",
      executable: powerShell7,
    });
  } else {
    const windowsPowerShell = join(
      process.env.SYSTEMROOT ?? "C:\\Windows",
      "System32",
      "WindowsPowerShell",
      "v1.0",
      "powershell.exe",
    );
    profiles.push({
      id: "powershell",
      label: "Windows PowerShell",
      shell: "powershell",
      executable: existsSync(windowsPowerShell)
        ? windowsPowerShell
        : "powershell.exe",
    });
  }

  profiles.push({
    id: "cmd",
    label: "Command Prompt",
    shell: "cmd",
    executable: process.env.COMSPEC ?? "cmd.exe",
  });

  const gitBashCandidates = [
    join(
      process.env.ProgramFiles ?? "C:\\Program Files",
      "Git",
      "bin",
      "bash.exe",
    ),
    ...(process.env["ProgramFiles(x86)"]
      ? [join(process.env["ProgramFiles(x86)"], "Git", "bin", "bash.exe")]
      : []),
    ...(process.env.LOCALAPPDATA
      ? [join(process.env.LOCALAPPDATA, "Programs", "Git", "bin", "bash.exe")]
      : []),
  ];
  const gitBash = gitBashCandidates.find((candidate) => existsSync(candidate));
  if (gitBash) {
    profiles.push({
      id: "git-bash",
      label: "Git Bash",
      shell: "posix",
      executable: gitBash,
    });
  }

  const bash = executableOnPath("bash.exe");
  if (bash && bash !== gitBash) {
    profiles.push({
      id: "bash",
      label: "Bash",
      shell: "posix",
      executable: bash,
    });
  }
  return profiles;
}

function executableOnPath(name: string): string | undefined {
  for (const directory of (process.env.PATH ?? "").split(delimiter)) {
    const normalized = directory.trim().replace(/^"|"$/g, "");
    if (!normalized) continue;
    const candidate = join(normalized, name);
    if (existsSync(candidate)) return candidate;
  }
  return undefined;
}

function findSpec(providerId: string): ProviderFieldSpec | undefined {
  return PROVIDER_FIELD_SPECS.find((spec) => spec.id === providerId);
}

function listProviders(
  store: SessionStore,
): ReturnType<typeof describeProvider>[] {
  return PROVIDER_FIELD_SPECS.map((spec) => describeProvider(store, spec));
}

function describeProvider(store: SessionStore, spec: ProviderFieldSpec) {
  const credential = store.getCredential(spec.id);
  const lastValidationRaw = store.getProviderSetting(spec.id, "lastValidation");
  return {
    id: spec.id,
    label: spec.label,
    fields: spec.fields,
    credentialRequired: spec.credentialRequired,
    helpUrl: spec.helpUrl,
    description: spec.description,
    defaultModelId: spec.defaultModelId,
    modelOptions: spec.modelOptions,
    hasCredential: Boolean(credential),
    maskedCredential: credential ? maskSecret(credential) : undefined,
    baseUrl: store.getProviderSetting(spec.id, "baseUrl"),
    manualModelId: store.getProviderSetting(spec.id, "manualModelId"),
    lastValidation: lastValidationRaw
      ? (JSON.parse(lastValidationRaw) as unknown)
      : undefined,
  };
}

function applyProviderUpdate(
  store: SessionStore,
  spec: ProviderFieldSpec,
  body: unknown,
): void {
  const update = (body ?? {}) as Record<string, unknown>;
  if (spec.fields.includes("apiKey") && typeof update.apiKey === "string") {
    if (update.apiKey.trim())
      store.setCredential(spec.id, update.apiKey.trim());
    else store.clearCredential(spec.id);
  }
  if (spec.fields.includes("baseUrl") && typeof update.baseUrl === "string") {
    if (update.baseUrl.trim())
      store.setProviderSetting(spec.id, "baseUrl", update.baseUrl.trim());
    else store.clearProviderSetting(spec.id, "baseUrl");
  }
  if (
    spec.fields.includes("manualModelId") &&
    typeof update.manualModelId === "string"
  ) {
    if (update.manualModelId.trim())
      store.setProviderSetting(
        spec.id,
        "manualModelId",
        update.manualModelId.trim(),
      );
    else store.clearProviderSetting(spec.id, "manualModelId");
  }
}

function clearProvider(store: SessionStore, spec: ProviderFieldSpec): void {
  store.clearCredential(spec.id);
  store.clearProviderSetting(spec.id, "baseUrl");
  store.clearProviderSetting(spec.id, "manualModelId");
  store.clearProviderSetting(spec.id, "lastValidation");
}

async function validateProvider(
  store: SessionStore,
  spec: ProviderFieldSpec,
): Promise<{ ok: boolean; message?: string; at: number }> {
  const outcome = await validateStoredProvider(store, spec);
  const result = { ...outcome, at: Date.now() };
  store.setProviderSetting(spec.id, "lastValidation", JSON.stringify(result));
  return result;
}

function maskSecret(value: string): string {
  if (value.length <= 4) return "*".repeat(value.length);
  return `${"*".repeat(Math.max(0, value.length - 4))}${value.slice(-4)}`;
}

function toPositiveInteger(value: unknown): number | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new Error("Line numbers must be positive integers.");
  }
  return parsed;
}

async function readJsonBody(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    size += (chunk as Buffer).length;
    if (size > MAX_BODY_BYTES) throw new Error("Request body too large.");
    chunks.push(chunk as Buffer);
  }
  if (chunks.length === 0) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new Error("Request body must be valid JSON.");
  }
}

function sendJson(
  response: ServerResponse,
  status: number,
  body: unknown,
): void {
  const payload = JSON.stringify(body);
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(payload),
  });
  response.end(payload);
}

const MIME_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".ico": "image/x-icon",
};

function serveStatic(
  pathname: string,
  staticDir: string,
  response: ServerResponse,
): void {
  const safePath = normalize(pathname).replace(/^(\.\.[/\\])+/, "");
  const candidate = join(staticDir, safePath);
  const target =
    existsSync(candidate) && statSync(candidate).isFile()
      ? candidate
      : join(staticDir, "index.html");
  if (!existsSync(target)) {
    sendJson(response, 404, {
      error:
        "GUI build not found. Run `pnpm --filter @agentic-runtime/gui build` first.",
    });
    return;
  }
  const type = MIME_TYPES[extname(target)] ?? "application/octet-stream";
  response.writeHead(200, { "content-type": type });
  createReadStream(target).pipe(response);
}
