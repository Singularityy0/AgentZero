import type {
  LanguageModel,
  ModelRequest,
  ModelResponse,
} from "@agentic-runtime/core";
import { OllamaModel } from "@agentic-runtime/ollama";
import { OpenAICompatibleChatModel } from "@agentic-runtime/openai";

export interface ModelInfo {
  id: string;
  name: string;
  providerId: string;
  contextWindow?: number;
  maxOutputTokens?: number;
  pricing?: { inputPerMillion?: number; outputPerMillion?: number };
  capabilities: {
    tools: boolean;
    vision: boolean;
    reasoning: boolean;
    streaming: boolean;
    structuredOutput: boolean;
  };
  metadata: Record<string, unknown>;
}

export interface ProviderConfig {
  providerId: string;
  baseUrl?: string;
  credentialRef?: string;
  manualModelId?: string;
}

export interface ModelRoute {
  providerId: string;
  modelId: string;
  baseUrl: string;
  protocol: "ollama" | "openai-chat";
  credentialRef?: string;
  execute(request: ModelRequest): Promise<ModelResponse>;
}

export interface ProviderAdapter {
  readonly id: string;
  configure(config: ProviderConfig): void;
  validateCredentials(): Promise<void>;
  discoverModels(options?: { refresh?: boolean }): Promise<ModelInfo[]>;
  createRoute(model: ModelInfo): Promise<ModelRoute>;
}

export interface GatewayEvent {
  type:
    | "provider_configured"
    | "provider_validation_started"
    | "provider_validation_completed"
    | "provider_validation_failed"
    | "model_discovery_started"
    | "model_discovery_completed"
    | "model_discovery_failed"
    | "models_refreshed"
    | "model_selected"
    | "llm_request_started"
    | "llm_request_completed"
    | "llm_request_failed";
  providerId: string;
  modelId?: string;
  detail?: string;
}

export interface CredentialResolver {
  get(reference: string): string | undefined;
}
export class EnvironmentCredentialResolver implements CredentialResolver {
  get(reference: string): string | undefined {
    return process.env[reference];
  }
}

/** Structural interface matching @agentic-runtime/session's SessionStore -
 * kept structural (not imported) so packages/gateway does not take on a
 * dependency on packages/session for one method. */
export interface CredentialStore {
  getCredential(providerId: string): string | undefined;
}

/** Env var fallback so a provider configured via .env before the settings
 * screen existed keeps working without re-entering the key. A value saved
 * through the settings screen (TUI `/settings` or the GUI) always takes
 * priority over this. Shared by every client that builds a
 * StoredCredentialResolver so they stay in sync. */
export const DEFAULT_CREDENTIAL_ENV_FALLBACK: Record<string, string> = {
  groq: "GROQ_API_KEY",
  openrouter: "OPENROUTER_API_KEY",
  "openai-compatible": "OPENAI_COMPATIBLE_API_KEY",
};

/**
 * Resolves credentials by provider ID from a persisted settings store (the
 * settings screen writes here), falling back to an environment variable per
 * provider for local dev/example scripts that never touched the UI. This is
 * the resolver the TUI/GUI should use so a key saved once, from either
 * client, works everywhere without editing `.env`.
 */
export class StoredCredentialResolver implements CredentialResolver {
  constructor(
    private readonly store: CredentialStore,
    private readonly envFallback: Record<string, string> = {},
  ) {}
  get(reference: string): string | undefined {
    const stored = this.store.getCredential(reference);
    if (stored) return stored;
    const envVar = this.envFallback[reference];
    return envVar ? process.env[envVar] : undefined;
  }
}

export class ProviderRegistry {
  private readonly providers = new Map<string, ProviderAdapter>();
  register(provider: ProviderAdapter): this {
    if (this.providers.has(provider.id))
      throw new Error(`Provider already registered: ${provider.id}`);
    this.providers.set(provider.id, provider);
    return this;
  }
  get(id: string): ProviderAdapter {
    const provider = this.providers.get(id);
    if (!provider) throw new Error(`Provider not found: ${id}`);
    return provider;
  }
  list(): ProviderAdapter[] {
    return [...this.providers.values()];
  }
}

export class ModelRegistry {
  private readonly models = new Map<string, ModelInfo>();
  replace(providerId: string, models: ModelInfo[]): void {
    for (const key of this.models.keys())
      if (key.startsWith(`${providerId}:`)) this.models.delete(key);
    for (const model of models)
      this.models.set(keyFor(model.providerId, model.id), model);
  }
  get(providerId: string, modelId: string): ModelInfo | undefined {
    return this.models.get(keyFor(providerId, modelId));
  }
  list(providerId?: string): ModelInfo[] {
    return [...this.models.values()].filter(
      (model) => !providerId || model.providerId === providerId,
    );
  }
}

export class ProviderGateway implements LanguageModel {
  readonly models = new ModelRegistry();
  private selected?: ModelInfo;
  constructor(
    readonly providers: ProviderRegistry,
    private readonly onEvent?: (event: GatewayEvent) => void,
  ) {}
  configure(config: ProviderConfig): void {
    this.providers.get(config.providerId).configure(config);
    this.emit({ type: "provider_configured", providerId: config.providerId });
  }
  async validate(providerId: string): Promise<void> {
    this.emit({ type: "provider_validation_started", providerId });
    try {
      await this.providers.get(providerId).validateCredentials();
      this.emit({ type: "provider_validation_completed", providerId });
    } catch (error) {
      this.emit({
        type: "provider_validation_failed",
        providerId,
        detail: safeError(error),
      });
      throw error;
    }
  }
  async discover(providerId: string, refresh = false): Promise<ModelInfo[]> {
    this.emit({ type: "model_discovery_started", providerId });
    try {
      const models = await this.providers
        .get(providerId)
        .discoverModels({ refresh });
      this.models.replace(providerId, models);
      this.emit({
        type: "model_discovery_completed",
        providerId,
        detail: `${models.length} models`,
      });
      if (refresh) this.emit({ type: "models_refreshed", providerId });
      return models;
    } catch (error) {
      this.emit({
        type: "model_discovery_failed",
        providerId,
        detail: safeError(error),
      });
      throw error;
    }
  }
  select(providerId: string, modelId: string): ModelInfo {
    const model = this.models.get(providerId, modelId);
    if (!model) throw new Error(`Model not found: ${providerId}/${modelId}`);
    this.selected = model;
    this.emit({ type: "model_selected", providerId, modelId });
    return model;
  }
  registerModel(model: ModelInfo): ModelInfo {
    this.models.replace(model.providerId, [
      ...this.models.list(model.providerId),
      model,
    ]);
    return model;
  }
  getSelected(): ModelInfo | undefined {
    return this.selected;
  }
  async route(model = this.selected): Promise<ModelRoute> {
    if (!model) throw new Error("No model selected.");
    return this.providers.get(model.providerId).createRoute(model);
  }
  async respond(request: ModelRequest): Promise<ModelResponse> {
    const route = await this.route();
    this.emit({
      type: "llm_request_started",
      providerId: route.providerId,
      modelId: route.modelId,
    });
    try {
      const response = await route.execute(request);
      this.emit({
        type: "llm_request_completed",
        providerId: route.providerId,
        modelId: route.modelId,
      });
      return response;
    } catch (error) {
      this.emit({
        type: "llm_request_failed",
        providerId: route.providerId,
        modelId: route.modelId,
        detail: safeError(error),
      });
      throw error;
    }
  }
  private emit(event: GatewayEvent): void {
    this.onEvent?.(event);
  }
}

abstract class HttpProvider implements ProviderAdapter {
  protected config?: ProviderConfig;
  protected cache?: { fetchedAt: number; models: ModelInfo[] };
  constructor(
    readonly id: string,
    protected readonly credentials: CredentialResolver,
    protected readonly fetcher: typeof fetch = fetch,
  ) {}
  configure(config: ProviderConfig): void {
    if (config.providerId !== this.id)
      throw new Error(`Invalid configuration for ${this.id}`);
    this.config = config;
  }
  protected getConfig(): ProviderConfig {
    if (!this.config) throw new Error(`Provider is not configured: ${this.id}`);
    return this.config;
  }
  protected authorization(): string | undefined {
    const ref = this.getConfig().credentialRef;
    const key = ref ? this.credentials.get(ref) : undefined;
    if (ref && !key)
      throw new Error(`Credential unavailable for provider ${this.id}.`);
    return key ? `Bearer ${key}` : undefined;
  }
  abstract validateCredentials(): Promise<void>;
  abstract discoverModels(options?: {
    refresh?: boolean;
  }): Promise<ModelInfo[]>;
  abstract createRoute(model: ModelInfo): Promise<ModelRoute>;
}

export class OpenRouterProvider extends HttpProvider {
  constructor(credentials: CredentialResolver, fetcher?: typeof fetch) {
    super("openrouter", credentials, fetcher);
  }
  async validateCredentials(): Promise<void> {
    const response = await this.fetcher("https://openrouter.ai/api/v1/models", {
      headers: { Authorization: this.authorization() ?? "" },
    });
    if (response.status === 401 || response.status === 403)
      throw new Error("OpenRouter credentials were rejected.");
    if (!response.ok)
      throw new Error(`OpenRouter unavailable (${response.status}).`);
  }
  async discoverModels(
    options: { refresh?: boolean } = {},
  ): Promise<ModelInfo[]> {
    if (!options.refresh && this.cache) return this.cache.models;
    const response = await this.fetcher("https://openrouter.ai/api/v1/models", {
      headers: { Authorization: this.authorization() ?? "" },
    });
    if (!response.ok)
      throw new Error(
        `OpenRouter model discovery failed (${response.status}).`,
      );
    const body = (await response.json()) as { data?: unknown };
    if (!Array.isArray(body.data))
      throw new Error("OpenRouter returned a malformed model catalog.");
    const models = body.data
      .map((raw) => normalizeOpenRouterModel(raw))
      .filter((model): model is ModelInfo => Boolean(model));
    this.cache = { fetchedAt: Date.now(), models };
    return models;
  }
  async createRoute(model: ModelInfo): Promise<ModelRoute> {
    const config = this.getConfig();
    const key = this.credentials.get(config.credentialRef ?? "");
    if (!key)
      throw new Error("Credential unavailable for provider openrouter.");
    const baseUrl = "https://openrouter.ai/api/v1";
    const client = new OpenAICompatibleChatModel({
      apiKey: key,
      model: model.id,
      baseURL: baseUrl,
    });
    return {
      providerId: this.id,
      modelId: model.id,
      baseUrl,
      protocol: "openai-chat",
      credentialRef: config.credentialRef,
      execute: (request) => client.respond(request),
    };
  }
}

export class GroqProvider extends HttpProvider {
  constructor(credentials: CredentialResolver, fetcher?: typeof fetch) {
    super("groq", credentials, fetcher);
  }
  async validateCredentials(): Promise<void> {
    const response = await this.fetcher(
      "https://api.groq.com/openai/v1/models",
      { headers: { Authorization: this.authorization() ?? "" } },
    );
    if (response.status === 401 || response.status === 403)
      throw new Error("Groq credentials were rejected.");
    if (!response.ok) throw new Error(`Groq unavailable (${response.status}).`);
  }
  async discoverModels(
    options: { refresh?: boolean } = {},
  ): Promise<ModelInfo[]> {
    if (!options.refresh && this.cache) return this.cache.models;
    const response = await this.fetcher(
      "https://api.groq.com/openai/v1/models",
      { headers: { Authorization: this.authorization() ?? "" } },
    );
    if (!response.ok)
      throw new Error(`Groq model discovery failed (${response.status}).`);
    const body = (await response.json()) as { data?: unknown };
    if (!Array.isArray(body.data))
      throw new Error("Groq returned a malformed model catalog.");
    const models = body.data
      .map((raw) => normalizeGroqModel(raw))
      .filter((model): model is ModelInfo => Boolean(model));
    this.cache = { fetchedAt: Date.now(), models };
    return models;
  }
  async createRoute(model: ModelInfo): Promise<ModelRoute> {
    const config = this.getConfig();
    const key = this.credentials.get(config.credentialRef ?? "");
    if (!key) throw new Error("Credential unavailable for provider groq.");
    const baseUrl = "https://api.groq.com/openai/v1";
    const client = new OpenAICompatibleChatModel({
      apiKey: key,
      model: model.id,
      baseURL: baseUrl,
    });
    return {
      providerId: this.id,
      modelId: model.id,
      baseUrl,
      protocol: "openai-chat",
      credentialRef: config.credentialRef,
      execute: (request) => client.respond(request),
    };
  }
}

export class OllamaProvider extends HttpProvider {
  constructor(credentials: CredentialResolver, fetcher?: typeof fetch) {
    super("ollama", credentials, fetcher);
  }
  async validateCredentials(): Promise<void> {
    const response = await this.fetcher(
      `${ollamaBase(this.getConfig())}/api/tags`,
    );
    if (!response.ok)
      throw new Error(`Ollama unavailable (${response.status}).`);
  }
  async discoverModels(
    options: { refresh?: boolean } = {},
  ): Promise<ModelInfo[]> {
    if (!options.refresh && this.cache) return this.cache.models;
    const config = this.getConfig();
    const response = await this.fetcher(`${ollamaBase(config)}/api/tags`);
    if (!response.ok)
      throw new Error(`Ollama model discovery failed (${response.status}).`);
    const body = (await response.json()) as {
      models?: Array<{ name?: string; details?: Record<string, unknown> }>;
    };
    if (!Array.isArray(body.models))
      throw new Error("Ollama returned a malformed model catalog.");
    const models = body.models
      .filter((model) => Boolean(model.name))
      .map((model) => ({
        id: model.name!,
        name: model.name!,
        providerId: this.id,
        capabilities: {
          tools: true,
          vision: false,
          reasoning: false,
          streaming: true,
          structuredOutput: true,
        },
        metadata: model.details ?? {},
      }));
    this.cache = { fetchedAt: Date.now(), models };
    return models;
  }
  async createRoute(model: ModelInfo): Promise<ModelRoute> {
    const config = this.getConfig();
    const baseUrl = ollamaBase(config);
    const endpoint = `${baseUrl}/api/chat`;
    const client = new OllamaModel({ model: model.id, endpoint });
    return {
      providerId: this.id,
      modelId: model.id,
      baseUrl,
      protocol: "ollama",
      credentialRef: config.credentialRef,
      execute: (request) => client.respond(request),
    };
  }
}

export class OpenAICompatibleProvider extends HttpProvider {
  constructor(credentials: CredentialResolver, fetcher?: typeof fetch) {
    super("openai-compatible", credentials, fetcher);
  }
  async validateCredentials(): Promise<void> {
    const response = await this.fetcher(
      `${openAIBase(this.getConfig())}/models`,
      { headers: this.headers() },
    );
    if (response.status === 401 || response.status === 403)
      throw new Error("Local endpoint credentials were rejected.");
    if (!response.ok && response.status !== 404)
      throw new Error(`Local endpoint unavailable (${response.status}).`);
  }
  async discoverModels(
    options: { refresh?: boolean } = {},
  ): Promise<ModelInfo[]> {
    if (!options.refresh && this.cache) return this.cache.models;
    const config = this.getConfig();
    const response = await this.fetcher(`${openAIBase(config)}/models`, {
      headers: this.headers(),
    });
    let models: ModelInfo[];
    if (response.status === 404 && config.manualModelId) {
      models = [manualModel(this.id, config.manualModelId)];
    } else {
      if (!response.ok)
        throw new Error(`Local model discovery failed (${response.status}).`);
      const body = (await response.json()) as {
        data?: Array<{ id?: string; owned_by?: string }>;
      };
      if (!Array.isArray(body.data))
        throw new Error("Local endpoint returned a malformed model catalog.");
      models = body.data
        .filter((model) => Boolean(model.id))
        .map((model) => ({
          ...manualModel(this.id, model.id!),
          metadata: { ownedBy: model.owned_by },
        }));
    }
    this.cache = { fetchedAt: Date.now(), models };
    return models;
  }
  async createRoute(model: ModelInfo): Promise<ModelRoute> {
    const config = this.getConfig();
    const key = config.credentialRef
      ? this.credentials.get(config.credentialRef)
      : "local";
    if (!key) throw new Error("Credential unavailable for local endpoint.");
    const baseUrl = openAIBase(config);
    const client = new OpenAICompatibleChatModel({
      apiKey: key,
      model: model.id,
      baseURL: baseUrl,
    });
    return {
      providerId: this.id,
      modelId: model.id,
      baseUrl,
      protocol: "openai-chat",
      credentialRef: config.credentialRef,
      execute: (request) => client.respond(request),
    };
  }
  private headers(): Record<string, string> {
    const auth = this.authorization();
    return auth ? { Authorization: auth } : {};
  }
}

export interface ProviderFieldSpec {
  id: string;
  label: string;
  fields: Array<"apiKey" | "baseUrl" | "manualModelId">;
  credentialRequired: boolean;
  helpUrl?: string;
}

/** Single source of truth for what a settings screen needs to collect per
 * provider, so the GUI/TUI settings surfaces don't hardcode provider
 * knowledge that can drift from what createDefaultProviderGateway registers. */
export const PROVIDER_FIELD_SPECS: ProviderFieldSpec[] = [
  {
    id: "groq",
    label: "Groq",
    fields: ["apiKey"],
    credentialRequired: true,
    helpUrl: "https://console.groq.com/keys",
  },
  {
    id: "openrouter",
    label: "OpenRouter",
    fields: ["apiKey"],
    credentialRequired: true,
    helpUrl: "https://openrouter.ai/keys",
  },
  {
    id: "ollama",
    label: "Ollama (local)",
    fields: ["baseUrl"],
    credentialRequired: false,
  },
  {
    id: "openai-compatible",
    label: "OpenAI-compatible / local endpoint",
    fields: ["baseUrl", "apiKey", "manualModelId"],
    credentialRequired: false,
  },
];

export interface ProviderSettingsStore extends CredentialStore {
  getProviderSetting(providerId: string, key: string): string | undefined;
}

/** Shared by every client (TUI `/settings`, GUI server) so "validate" means
 * the same thing everywhere: build a one-off gateway from whatever is
 * currently persisted for this provider and try validateCredentials(). */
export async function validateStoredProvider(
  store: ProviderSettingsStore,
  spec: ProviderFieldSpec,
  envFallback: Record<string, string> = DEFAULT_CREDENTIAL_ENV_FALLBACK,
): Promise<{ ok: boolean; message?: string }> {
  try {
    const credentials = new StoredCredentialResolver(store, envFallback);
    const gateway = createDefaultProviderGateway({ credentials });
    gateway.configure({
      providerId: spec.id,
      baseUrl: store.getProviderSetting(spec.id, "baseUrl"),
      credentialRef:
        spec.credentialRequired || store.getCredential(spec.id)
          ? spec.id
          : undefined,
      manualModelId: store.getProviderSetting(spec.id, "manualModelId"),
    });
    await gateway.validate(spec.id);
    return { ok: true };
  } catch (error) {
    return {
      ok: false,
      message: error instanceof Error ? error.message : "Validation failed.",
    };
  }
}

export function createDefaultProviderGateway(
  options: {
    credentials?: CredentialResolver;
    fetcher?: typeof fetch;
    onEvent?: (event: GatewayEvent) => void;
  } = {},
): ProviderGateway {
  const credentials =
    options.credentials ?? new EnvironmentCredentialResolver();
  const registry = new ProviderRegistry()
    .register(new GroqProvider(credentials, options.fetcher))
    .register(new OpenRouterProvider(credentials, options.fetcher))
    .register(new OpenAICompatibleProvider(credentials, options.fetcher))
    .register(new OllamaProvider(credentials, options.fetcher));
  return new ProviderGateway(registry, options.onEvent);
}

/** Groq's model list has no per-token pricing and no active/expert count, so
 * the 80B total-parameter cap cannot be enforced from this metadata alone. */
function normalizeGroqModel(raw: unknown): ModelInfo | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const model = raw as Record<string, unknown>;
  if (typeof model.id !== "string") return undefined;
  if (model.active === false) return undefined;
  return {
    id: model.id,
    name: model.id,
    providerId: "groq",
    contextWindow: numberValue(model.context_window),
    pricing: { inputPerMillion: 0, outputPerMillion: 0 },
    capabilities: {
      tools: !model.id.includes("whisper") && !model.id.includes("tts"),
      vision: model.id.includes("vision") || model.id.includes("scout"),
      reasoning: false,
      streaming: true,
      structuredOutput: true,
    },
    metadata: { ownedBy: model.owned_by },
  };
}
function normalizeOpenRouterModel(raw: unknown): ModelInfo | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const model = raw as Record<string, unknown>;
  if (typeof model.id !== "string") return undefined;
  const context = numberValue(model.context_length);
  const output = numberValue(
    model.top_provider && typeof model.top_provider === "object"
      ? (model.top_provider as Record<string, unknown>).max_completion_tokens
      : undefined,
  );
  const pricing =
    model.pricing && typeof model.pricing === "object"
      ? (model.pricing as Record<string, unknown>)
      : {};
  const architecture =
    model.architecture && typeof model.architecture === "object"
      ? (model.architecture as Record<string, unknown>)
      : {};
  const inputModalities = Array.isArray(architecture.input_modalities)
    ? architecture.input_modalities
    : [];
  return {
    id: model.id,
    name: typeof model.name === "string" ? model.name : model.id,
    providerId: "openrouter",
    contextWindow: context,
    maxOutputTokens: output,
    pricing: {
      inputPerMillion: perMillion(pricing.prompt),
      outputPerMillion: perMillion(pricing.completion),
    },
    capabilities: {
      tools:
        Array.isArray(model.supported_parameters) &&
        model.supported_parameters.includes("tools"),
      vision: inputModalities.includes("image"),
      reasoning: Boolean(model.reasoning),
      streaming: true,
      structuredOutput:
        Array.isArray(model.supported_parameters) &&
        model.supported_parameters.includes("response_format"),
    },
    metadata: model,
  };
}
function manualModel(providerId: string, id: string): ModelInfo {
  return {
    id,
    name: id,
    providerId,
    capabilities: {
      tools: true,
      vision: false,
      reasoning: false,
      streaming: true,
      structuredOutput: true,
    },
    metadata: {},
  };
}
function numberValue(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value)
    ? value
    : undefined;
}
function perMillion(value: unknown): number | undefined {
  const number = Number(value);
  return Number.isFinite(number) ? number * 1_000_000 : undefined;
}
function ollamaBase(config: ProviderConfig): string {
  return (config.baseUrl ?? "http://localhost:11434")
    .replace(/\/$/, "")
    .replace(/\/api\/chat$/, "");
}
function openAIBase(config: ProviderConfig): string {
  if (!config.baseUrl)
    throw new Error("A base URL is required for the local endpoint.");
  return config.baseUrl.replace(/\/$/, "");
}
function keyFor(providerId: string, modelId: string): string {
  return `${providerId}:${modelId}`;
}
function safeError(error: unknown): string {
  return error instanceof Error ? error.message : "Provider request failed.";
}
