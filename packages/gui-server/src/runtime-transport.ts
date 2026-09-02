import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import type { ToolApprovalResponse } from "@agentic-runtime/core";
import {
  DEFAULT_CREDENTIAL_ENV_FALLBACK,
  PROVIDER_FIELD_SPECS,
} from "@agentic-runtime/gateway";
import {
  CONVERSATION_AGENT_ID,
  DEFAULT_RUNTIME_LIMITS,
  createHeadlessRuntime,
  DEFAULT_AGENT_ID,
  type HeadlessRuntimeService,
  type RuntimeApprovalRequest,
  type RuntimeEvent,
  type RuntimeTaskSpend,
  type RuntimeModelRouteSelection,
  type RuntimeModelSelection,
  type RuntimeProviderId,
  type RuntimeTaskHandle,
} from "@agentic-runtime/runtime";
import type { SessionStore } from "@agentic-runtime/session";

/** Hosted tool-capable routes are exhausted before the slower local fallback. */
export const RUNTIME_PROVIDER_PRIORITY: readonly RuntimeProviderId[] = [
  "groq",
  "openrouter",
  "cerebras",
  "huggingface",
  "mistral",
  "openai-compatible",
  "ollama",
];

const DEFAULT_MODELS: Record<RuntimeProviderId, string> = {
  ollama: "qwen2.5-coder:7b",
  groq: "qwen/qwen3.6-27b",
  openrouter: "nvidia/nemotron-3.5-lightning:free",
  mistral: "ministral-14b-latest",
  cerebras: "gemma-4-31b",
  huggingface: "Qwen/Qwen3-Coder-30B-A3B-Instruct",
  "openai-compatible": "",
};

const MODEL_ENV_KEYS: Record<RuntimeProviderId, string[]> = {
  ollama: ["OLLAMA_MODEL"],
  groq: ["GROQ_MODEL", "OPENAI_COMPATIBLE_MODEL"],
  openrouter: ["OPENROUTER_MODEL", "OPENAI_MODEL"],
  mistral: ["MISTRAL_MODEL"],
  cerebras: ["CEREBRAS_MODEL"],
  huggingface: ["HUGGINGFACE_MODEL"],
  "openai-compatible": ["OPENAI_COMPATIBLE_MODEL"],
};

const BASE_URL_ENV_KEYS: Partial<Record<RuntimeProviderId, string>> = {
  ollama: "OLLAMA_ENDPOINT",
  "openai-compatible": "OPENAI_COMPATIBLE_BASE_URL",
};

interface PendingApproval {
  request: RuntimeApprovalRequest;
  resolve: (decision: ToolApprovalResponse) => void;
}

export interface RuntimeRouteView {
  providerId: RuntimeProviderId;
  label: string;
  modelId: string;
  configured: boolean;
  selected: boolean;
}

export interface RuntimeTransportStatus {
  ready: boolean;
  connected: boolean;
  providerId: RuntimeProviderId;
  modelId: string;
  routes: RuntimeRouteView[];
  fallbackOrder: RuntimeProviderId[];
  activeTaskIds: string[];
  pendingApprovals: RuntimeApprovalRequest[];
}

export class RuntimeTransport {
  private runtime?: HeadlessRuntimeService;
  private unsubscribeRuntime?: () => void;
  private readonly listeners = new Set<(event: RuntimeEvent) => void>();
  private readonly activeTasks = new Map<string, RuntimeTaskHandle>();
  private readonly pendingApprovals = new Map<string, PendingApproval>();
  private ollamaStartup?: Promise<void>;

  constructor(private readonly store: SessionStore) {
    // Runtime construction seeds/refreshes the reserved built-in agents in the
    // shared global store. Do this before `/api/workbench` is served so a fresh
    // desktop install always has a selectable agent and can submit its first
    // task without a circular lazy-initialization failure.
    this.ensureRuntime();
  }

  status(): RuntimeTransportStatus {
    const providerId = this.selectedProvider();
    const fallbackOrder = this.getFallbackOrder();
    const routes = fallbackOrder.map((id) =>
      this.describeRoute(id, providerId),
    );
    const selected = routes.find((route) => route.providerId === providerId)!;
    return {
      ready: selected.configured && Boolean(selected.modelId),
      // Reaching this object through the loopback API means the UI transport
      // itself is connected. Model availability is reported separately by
      // `ready` and by the provider validation action in Settings.
      connected: true,
      providerId,
      modelId: selected.modelId,
      routes,
      fallbackOrder,
      activeTaskIds: [...this.activeTasks.keys()],
      pendingApprovals: [...this.pendingApprovals.values()].map(
        ({ request }) => request,
      ),
    };
  }

  subscribe(listener: (event: RuntimeEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  async startTask(input: {
    sessionId: string;
    agentId?: string;
    prompt: string;
  }): Promise<RuntimeTaskHandle> {
    if (this.selectedProvider() === "ollama") {
      await this.ensureOllamaAvailable();
    }
    const runtime = this.ensureRuntime();
    const handle = runtime.startTask({
      sessionId: input.sessionId,
      agentId: input.agentId?.trim() || DEFAULT_AGENT_ID,
      prompt: input.prompt,
    });
    this.activeTasks.set(handle.taskId, handle);
    void handle.completion
      .catch(() => undefined)
      .finally(() => this.activeTasks.delete(handle.taskId));
    return handle;
  }

  /**
   * Answers one question with zero prior context and without mutating the
   * session transcript, so the user returns to the ongoing task unchanged.
   */
  async askIsolatedQuestion(input: {
    sessionId: string;
    agentId?: string;
    prompt: string;
  }): Promise<string> {
    if (this.selectedProvider() === "ollama") {
      await this.ensureOllamaAvailable();
    }
    const runtime = this.ensureRuntime();
    const handle = runtime.startIsolatedQuestion({
      sessionId: input.sessionId,
      agentId: input.agentId?.trim() || CONVERSATION_AGENT_ID,
      prompt: input.prompt,
    });
    const result = await handle.completion;
    return result.text;
  }

  /** Dollars and tokens billed to a task so far, zeroed when it never ran. */
  taskSpend(taskId: string): RuntimeTaskSpend {
    return (
      this.runtime?.taskSpend(taskId) ?? {
        taskId,
        costUsd: 0,
        budgetUsd: DEFAULT_RUNTIME_LIMITS.maxTaskCostUsd,
        inputTokens: 0,
        outputTokens: 0,
        modelCalls: 0,
      }
    );
  }

  /**
   * Continues an interrupted task from its last durable checkpoint instead of
   * restarting it. Completed pipeline stages are skipped, so a task that
   * survived a crash or a closed IDE resumes rather than repeating work.
   */
  async resumeTask(taskId: string): Promise<RuntimeTaskHandle> {
    if (this.selectedProvider() === "ollama") {
      await this.ensureOllamaAvailable();
    }
    const handle = this.ensureRuntime().resumeTask({ taskId });
    this.activeTasks.set(handle.taskId, handle);
    void handle.completion
      .catch(() => undefined)
      .finally(() => this.activeTasks.delete(handle.taskId));
    return handle;
  }

  cancelTask(taskId: string): boolean {
    const handle = this.activeTasks.get(taskId);
    if (!handle) return false;
    handle.cancel();
    return true;
  }

  resolveApproval(requestId: string, decision: ToolApprovalResponse): boolean {
    const pending = this.pendingApprovals.get(requestId);
    if (!pending) return false;
    this.pendingApprovals.delete(requestId);
    pending.resolve(decision);
    return true;
  }

  async configure(providerId: string, modelId?: string): Promise<void> {
    if (!isRuntimeProviderId(providerId)) {
      throw new Error(`Unsupported runtime provider: ${providerId}`);
    }
    await this.prepareForConfigurationChange();
    this.store.setProviderSetting("runtime", "providerId", providerId);
    if (modelId !== undefined) {
      const normalized = modelId.trim();
      if (normalized)
        this.store.setProviderSetting(providerId, "manualModelId", normalized);
      else this.store.clearProviderSetting(providerId, "manualModelId");
    }
  }

  /** True while a task is running in this session. */
  isSessionActive(sessionId: string): boolean {
    for (const handle of this.activeTasks.values()) {
      if (handle.sessionId === sessionId) return true;
    }
    return false;
  }

  async prepareForConfigurationChange(): Promise<void> {
    if (this.activeTasks.size > 0) {
      throw new Error(
        "Cannot change runtime configuration during an active task.",
      );
    }
    await this.disposeRuntime();
  }

  async close(): Promise<void> {
    for (const pending of this.pendingApprovals.values())
      pending.resolve(false);
    this.pendingApprovals.clear();
    this.listeners.clear();
    await this.disposeRuntime();
  }

  private ensureRuntime(): HeadlessRuntimeService {
    if (this.runtime) return this.runtime;
    const model = this.modelSelection();
    const runtime = createHeadlessRuntime({
      workspaceRoot: this.store.project.rootPath,
      model,
      credentialEnvironmentFallback: DEFAULT_CREDENTIAL_ENV_FALLBACK,
      requestApproval: (request) => this.waitForApproval(request),
    });
    this.unsubscribeRuntime = runtime.subscribe((event) => {
      for (const listener of this.listeners) listener(event);
    });
    this.runtime = runtime;
    return runtime;
  }

  private modelSelection(): RuntimeModelSelection {
    const providerId = this.selectedProvider();
    const primary = this.routeFor(providerId);
    if (!primary.modelId) {
      throw new Error(
        `No model is configured for ${providerId}. Set a model ID in Provider Settings.`,
      );
    }
    const fallbacks = this.getFallbackOrder()
      .filter((id) => id !== providerId)
      // Ollama needs no credential, only a reachable daemon, so it stays a
      // viable last-resort fallback without ever being "explicitly
      // configured" - that's the whole point of it being the local fallback.
      .filter((id) => id === "ollama" || this.hasExplicitConfiguration(id))
      .map((id) => this.routeFor(id))
      .filter((route) => Boolean(route.modelId));
    return { ...primary, fallbacks };
  }

  /**
   * User-editable fallback order, persisted per machine. Defaults to
   * `RUNTIME_PROVIDER_PRIORITY`. Ollama is always present - appended at the
   * end if the stored order omits it - so local inference is always the
   * fallback of last resort even if the user never touches this setting.
   */
  getFallbackOrder(): RuntimeProviderId[] {
    const raw = this.store.getProviderSetting("runtime", "fallbackOrder");
    let order: RuntimeProviderId[] = RUNTIME_PROVIDER_PRIORITY.slice();
    if (raw) {
      try {
        const parsed: unknown = JSON.parse(raw);
        if (Array.isArray(parsed)) {
          const valid = parsed.filter(isRuntimeProviderId);
          if (valid.length > 0) order = valid;
        }
      } catch {
        // Fall through to the default order.
      }
    }
    const deduped = [...new Set(order)];
    if (!deduped.includes("ollama")) deduped.push("ollama");
    return deduped;
  }

  setFallbackOrder(order: readonly string[]): RuntimeProviderId[] {
    const valid = order.filter(isRuntimeProviderId);
    if (valid.length === 0) {
      throw new Error("At least one valid provider is required.");
    }
    const deduped = [...new Set(valid)];
    if (!deduped.includes("ollama")) deduped.push("ollama");
    this.store.setProviderSetting(
      "runtime",
      "fallbackOrder",
      JSON.stringify(deduped),
    );
    return deduped;
  }

  private selectedProvider(): RuntimeProviderId {
    const stored = this.store.getProviderSetting("runtime", "providerId");
    if (isRuntimeProviderId(stored)) return stored;
    const environment = process.env.MODEL_PROVIDER?.toLowerCase();
    if (isRuntimeProviderId(environment)) return environment;
    return (
      RUNTIME_PROVIDER_PRIORITY.find((providerId) =>
        this.hasExplicitConfiguration(providerId),
      ) ?? "ollama"
    );
  }

  private routeFor(providerId: RuntimeProviderId): RuntimeModelRouteSelection {
    const environmentBaseKey = BASE_URL_ENV_KEYS[providerId];
    const credentialEnvironmentKey =
      DEFAULT_CREDENTIAL_ENV_FALLBACK[providerId];
    const hasCredential = Boolean(
      this.store.getCredential(providerId) ||
      (credentialEnvironmentKey
        ? process.env[credentialEnvironmentKey]
        : undefined),
    );
    const baseUrl =
      this.store.getProviderSetting(providerId, "baseUrl") ??
      (environmentBaseKey ? process.env[environmentBaseKey] : undefined) ??
      (providerId === "ollama" ? "http://localhost:11434" : undefined);
    return {
      providerId,
      modelId: this.modelIdFor(providerId),
      baseUrl,
      ...(providerId === "ollama" ? { contextWindow: 8_192 } : {}),
      credentialRef:
        providerId === "ollama" ||
        (providerId === "openai-compatible" && !hasCredential)
          ? null
          : providerId,
    };
  }

  private describeRoute(
    providerId: RuntimeProviderId,
    selectedProviderId: RuntimeProviderId,
  ): RuntimeRouteView {
    const spec = PROVIDER_FIELD_SPECS.find((entry) => entry.id === providerId);
    const modelId = this.modelIdFor(providerId);
    const hasCredential =
      providerId === "ollama" ||
      providerId === "openai-compatible" ||
      Boolean(
        this.store.getCredential(providerId) ||
        process.env[DEFAULT_CREDENTIAL_ENV_FALLBACK[providerId] ?? ""],
      );
    const hasBaseUrl =
      providerId !== "openai-compatible" ||
      Boolean(
        this.store.getProviderSetting(providerId, "baseUrl") ||
        process.env.OPENAI_COMPATIBLE_BASE_URL,
      );
    return {
      providerId,
      label: spec?.label ?? providerId,
      modelId,
      configured: Boolean(modelId && hasCredential && hasBaseUrl),
      selected: providerId === selectedProviderId,
    };
  }

  private modelIdFor(providerId: RuntimeProviderId): string {
    const stored = this.store.getProviderSetting(providerId, "manualModelId");
    if (stored?.trim()) return stored.trim();
    for (const key of MODEL_ENV_KEYS[providerId]) {
      const value = process.env[key]?.trim();
      if (value) return value;
    }
    return DEFAULT_MODELS[providerId];
  }

  private hasExplicitConfiguration(providerId: RuntimeProviderId): boolean {
    if (this.store.getProviderSetting(providerId, "manualModelId")) return true;
    if (this.store.getCredential(providerId)) return true;
    if (this.store.getProviderSetting(providerId, "baseUrl")) return true;
    const credentialKey = DEFAULT_CREDENTIAL_ENV_FALLBACK[providerId];
    if (credentialKey && process.env[credentialKey]) return true;
    if (MODEL_ENV_KEYS[providerId].some((key) => Boolean(process.env[key])))
      return true;
    const baseKey = BASE_URL_ENV_KEYS[providerId];
    return Boolean(baseKey && process.env[baseKey]);
  }

  private async ensureOllamaAvailable(): Promise<void> {
    if (!this.ollamaStartup) {
      this.ollamaStartup = this.startAndVerifyOllama().finally(() => {
        this.ollamaStartup = undefined;
      });
    }
    await this.ollamaStartup;
  }

  private async startAndVerifyOllama(): Promise<void> {
    const route = this.routeFor("ollama");
    const baseUrl = (route.baseUrl ?? "http://localhost:11434").replace(
      /\/$/,
      "",
    );
    let models = await readOllamaModels(baseUrl);
    if (!models) {
      if (!isLocalOllamaUrl(baseUrl)) {
        throw new Error(
          `Ollama is not reachable at ${baseUrl}. Start that remote service and try again.`,
        );
      }
      await launchOllama();
      for (let attempt = 0; attempt < 30 && !models; attempt += 1) {
        await delay(400);
        models = await readOllamaModels(baseUrl);
      }
    }
    if (!models) {
      throw new Error(
        "Ollama could not be started. Install Ollama once, then reopen the application.",
      );
    }
    const installed =
      hasOllamaModel(models, route.modelId) ||
      (await inspectOllamaModel(baseUrl, route.modelId));
    if (!installed) {
      throw new Error(
        `Ollama is running, but ${route.modelId} is not installed. Run once: ollama pull ${route.modelId}`,
      );
    }
  }

  private waitForApproval(
    request: RuntimeApprovalRequest,
  ): Promise<ToolApprovalResponse> {
    return new Promise<ToolApprovalResponse>((resolve) => {
      this.pendingApprovals.set(request.requestId, { request, resolve });
    });
  }

  private async disposeRuntime(): Promise<void> {
    this.unsubscribeRuntime?.();
    this.unsubscribeRuntime = undefined;
    const runtime = this.runtime;
    this.runtime = undefined;
    if (runtime) await runtime.close();
  }
}

async function readOllamaModels(
  baseUrl: string,
): Promise<Set<string> | undefined> {
  try {
    const response = await fetch(`${baseUrl}/api/tags`, {
      signal: AbortSignal.timeout(1_500),
    });
    if (!response.ok) return undefined;
    const body = (await response.json()) as {
      models?: Array<{ name?: string }>;
    };
    if (!Array.isArray(body.models)) return undefined;
    return new Set(
      body.models
        .map((model) => model.name)
        .filter((name): name is string => typeof name === "string"),
    );
  } catch {
    return undefined;
  }
}

export function hasOllamaModel(
  models: ReadonlySet<string>,
  requested: string,
): boolean {
  const normalizedRequested = normalizeOllamaModelName(requested);
  return [...models].some(
    (model) => normalizeOllamaModelName(model) === normalizedRequested,
  );
}

export function normalizeOllamaModelName(model: string): string {
  const normalized = model.trim().toLocaleLowerCase();
  return normalized.endsWith(":latest")
    ? normalized.slice(0, -":latest".length)
    : normalized;
}

async function inspectOllamaModel(
  baseUrl: string,
  model: string,
): Promise<boolean> {
  try {
    const response = await fetch(`${baseUrl}/api/show`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model }),
      signal: AbortSignal.timeout(2_500),
    });
    return response.ok;
  } catch {
    return false;
  }
}

function isLocalOllamaUrl(baseUrl: string): boolean {
  try {
    const hostname = new URL(baseUrl).hostname;
    return (
      hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1"
    );
  } catch {
    return false;
  }
}

async function launchOllama(): Promise<void> {
  const localAppData = process.env.LOCALAPPDATA;
  const installedExecutable = localAppData
    ? join(localAppData, "Programs", "Ollama", "ollama.exe")
    : undefined;
  const executable =
    installedExecutable && existsSync(installedExecutable)
      ? installedExecutable
      : "ollama";
  await new Promise<void>((resolve, reject) => {
    const child = spawn(executable, ["serve"], {
      detached: true,
      stdio: "ignore",
      windowsHide: true,
    });
    child.once("error", reject);
    child.once("spawn", () => {
      child.unref();
      resolve();
    });
  }).catch((error: unknown) => {
    throw new Error(
      `Ollama is not installed or could not be launched: ${error instanceof Error ? error.message : String(error)}`,
    );
  });
}

function delay(durationMs: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, durationMs));
}

function isRuntimeProviderId(value: unknown): value is RuntimeProviderId {
  return (
    typeof value === "string" &&
    RUNTIME_PROVIDER_PRIORITY.includes(value as RuntimeProviderId)
  );
}
