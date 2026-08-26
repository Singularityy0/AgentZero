import { createReadStream, existsSync, statSync } from "node:fs";
import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import {
  PROVIDER_FIELD_SPECS,
  validateStoredProvider,
  type ProviderFieldSpec,
} from "@agentic-runtime/gateway";
import { searchText } from "@agentic-runtime/search";
import { SessionStore } from "@agentic-runtime/session";
import { WorkspaceFileService } from "@agentic-runtime/workspace";

const DEFAULT_PORT = 4737;
const MAX_BODY_BYTES = 64 * 1024;
const MAX_SEARCH_RESULTS = 200;

export interface SettingsServerOptions {
  projectRoot: string;
  port?: number;
  /** Static GUI build to serve alongside the API. Defaults to the sibling
   * packages/gui/dist directory; pass false to disable static serving
   * (e.g. when a separate Vite dev server proxies /api to this port). */
  staticDir?: string | false;
}

export interface SettingsServer {
  readonly url: string;
  readonly port: number;
  close(): Promise<void>;
}

export function startSettingsServer(
  options: SettingsServerOptions,
): SettingsServer {
  const store = new SessionStore({ projectRoot: options.projectRoot });
  const workspace = new WorkspaceFileService(store.project.rootPath);
  const staticDir =
    options.staticDir === false
      ? undefined
      : (options.staticDir ??
        fileURLToPath(new URL("../../gui/dist", import.meta.url)));

  const server = createServer((request, response) => {
    handleRequest(request, response, store, workspace, staticDir).catch(
      (error) => {
        sendJson(response, 500, {
          error: error instanceof Error ? error.message : "Internal error.",
        });
      },
    );
  });

  const port = options.port ?? DEFAULT_PORT;
  // Bind to loopback only - this server reads/writes provider API keys and
  // must never be reachable from the network.
  server.listen(port, "127.0.0.1");

  return {
    url: `http://127.0.0.1:${port}`,
    port,
    async close() {
      store.close();
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
  staticDir: string | undefined,
): Promise<void> {
  const url = new URL(request.url ?? "/", "http://127.0.0.1");
  const method = request.method ?? "GET";

  if (url.pathname === "/api/project" && method === "GET") {
    sendJson(response, 200, {
      rootPath: store.project.rootPath,
      name:
        store.project.rootPath.split(/[/\\]/).pop() ?? store.project.rootPath,
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
      applyProviderUpdate(store, spec, body);
      sendJson(response, 200, { provider: describeProvider(store, spec) });
      return;
    }
    if (method === "DELETE") {
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
