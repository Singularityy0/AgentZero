import { assessLocalModel } from "./local-hardware.js";
import {
  ModelError,
  toModelError,
  type LanguageModel,
  type ModelContextEstimate,
  type ModelErrorCode,
  type ModelRequest,
  type ModelResponse,
} from "@agentic-runtime/core";
import { OllamaModel } from "@agentic-runtime/ollama";
import { OpenAICompatibleChatModel } from "@agentic-runtime/openai";
/** Static catalog of known model total (not active/expert) parameter counts,
 * from each model's publisher. Provider APIs don't reliably expose this, so
 * it has to be maintained by hand - see the "unverified" metadata flag
 * ModelRegistry.replace() sets for anything missing here. Only add entries
 * you can cite a real published figure for; a wrong number here is a
 * disqualification risk under the PS's <=80B constraint. Ollama keys must
 * match the exact tag returned by `ollama list` (e.g. "llama2:7b"), not the
 * bare model family name. */
const MODEL_PARAMETER_CATALOG: Record<string, Record<string, number>> = {
  groq: {
    "mixtral-8x7b-32768": 46_700_000_000, // Mistral AI, published total param count
    "qwen/qwen3.6-27b": 27_000_000_000,
    "qwen/qwen3.8-27b": 27_000_000_000,
    "openai/gpt-oss-20b": 20_000_000_000,
  },
  openrouter: {
    "nvidia/nemotron-3.5-lightning:free": 30_000_000_000,
  },
  ollama: {
    "llama2:7b": 7_000_000_000,
    "qwen2.5-coder:7b": 7_620_000_000,
  },
  mistral: {
    "ministral-3b-latest": 3_000_000_000,
    "ministral-8b-latest": 8_000_000_000,
    "ministral-14b-latest": 14_000_000_000,
  },
  cerebras: {
    "gemma-4-31b": 31_000_000_000,
  },
  huggingface: {
    "Qwen/Qwen3-Coder-30B-A3B-Instruct": 30_500_000_000,
    "Qwen/Qwen2.5-Coder-32B-Instruct": 32_500_000_000,
  },
};
function lookupTotalParameters(
  providerId: string,
  modelId: string,
): number | undefined {
  return MODEL_PARAMETER_CATALOG[providerId]?.[modelId];
}
export interface ModelInfo {
  id: string;
  name: string;
  providerId: string;
  contextWindow?: number;
  maxOutputTokens?: number;
  /** Total parameter count for the model, if known. */
  totalParameters?: number;
  pricing?: { inputPerMillion?: number; outputPerMillion?: number };
  capabilities: {
    tools: boolean;
    vision: boolean;
    reasoning: boolean;
    streaming: boolean;
    structuredOutput: boolean;
  };
  /** Additional arbitrary metadata about the model. May include an `unverified` flag for unknown parameters. */
  metadata: Record<string, unknown>;
}

export interface ModelRoutePreference {
  providerId: string;
  modelId: string;
  /** Lower values are preferred. Array order is used when omitted. */
  preference?: number;
  /** Alias for preference for callers that use priority terminology. */
  priority?: number;
}

export interface RouteRankingCandidate {
  model: ModelInfo;
  preference: number;
  cooldownUntil?: number;
}

export interface RouteRankingRequirements {
  requiresTools: boolean;
  contextTokens: number;
  estimatedOutputTokens: number;
  now: number;
}

export interface RankedModelRoute {
  model: ModelInfo;
  preference: number;
  contextTokens: number;
  estimatedCost: number | null;
  cooldownUntil?: number;
  inCooldown: boolean;
  eligible: boolean;
  reason: string;
}

export function estimateModelRequestTokens(request: ModelRequest): number {
  const characters =
    serializedLength(request.messages) + serializedLength(request.tools);
  return characters === 0 ? 0 : Math.ceil(characters / 4);
}

export function rankModelRoutes(
  candidates: readonly RouteRankingCandidate[],
  requirements: RouteRankingRequirements,
): RankedModelRoute[] {
  const contextTokens = Math.max(0, requirements.contextTokens);
  const outputTokens = Math.max(0, requirements.estimatedOutputTokens);
  return candidates
    .map((candidate): RankedModelRoute => {
      const supportsTools =
        !requirements.requiresTools || candidate.model.capabilities.tools;
      const contextFits =
        candidate.model.contextWindow === undefined ||
        contextTokens + outputTokens <= candidate.model.contextWindow;
      const cooldownUntil = candidate.cooldownUntil;
      const inCooldown =
        cooldownUntil !== undefined && cooldownUntil > requirements.now;
      const estimatedCost = estimateModelCost(
        candidate.model,
        contextTokens,
        outputTokens,
      );
      const eligibilityReason = !supportsTools
        ? "tools required but unsupported"
        : !contextFits
          ? `estimated context ${contextTokens + outputTokens} exceeds window ${candidate.model.contextWindow}`
          : undefined;
      const costReason =
        estimatedCost === null
          ? "cost unknown"
          : `estimated cost ${estimatedCost.toFixed(6)}`;
      const contextReason =
        candidate.model.contextWindow === undefined
          ? `estimated context ${contextTokens}; window unknown`
          : `estimated context ${contextTokens}/${candidate.model.contextWindow}`;
      const reason = eligibilityReason
        ? `rejected: ${eligibilityReason}`
        : `${inCooldown ? "cooldown active; " : ""}preference ${candidate.preference}; ${requirements.requiresTools ? "tools supported" : "tools not required"}; ${contextReason}; ${costReason}`;

      return {
        model: candidate.model,
        preference: candidate.preference,
        contextTokens,
        estimatedCost,
        cooldownUntil,
        inCooldown,
        eligible: supportsTools && contextFits,
        reason,
      };
    })
    .sort(compareRankedRoutes);
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

export interface GatewayFailure {
  code: ModelErrorCode;
  retryable: boolean;
  status?: number;
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
    | "routing_decision"
    | "routing_attempt_started"
    | "routing_attempt_completed"
    | "routing_attempt_failed"
    | "llm_request_started"
    | "llm_request_completed"
    | "llm_request_failed";
  providerId: string;
  modelId?: string;
  detail?: string;
  reason?: string;
  attempt?: number;
  contextTokens?: number;
  estimatedCost?: number | null;
  failure?: GatewayFailure;
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
  mistral: "MISTRAL_API_KEY",
  cerebras: "CEREBRAS_API_KEY",
  huggingface: "HF_TOKEN",
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
  /** Allowed free-tier, pay-as-you-go, and local provider IDs. */
  private static readonly ELIGIBLE_PROVIDERS = new Set([
    "groq",
    "openrouter",
    "mistral",
    "cerebras",
    "huggingface",
    "ollama",
    "openai-compatible",
  ]);
  register(provider: ProviderAdapter): this {
    if (this.providers.has(provider.id))
      throw new Error(`Provider already registered: ${provider.id}`);
    if (!ProviderRegistry.ELIGIBLE_PROVIDERS.has(provider.id)) {
      throw new Error(
        `Provider ${provider.id} is not on the free-tier/pay-as-you-go/local allowlist.`,
      );
    }
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
    for (const model of models) {
      // Enforce 80B parameter cap; drop oversized models.
      if (model.totalParameters && model.totalParameters > 80_000_000_000) {
        // Skip adding this model.
        continue;
      }
      // Flag unknown parameter count as unverified.
      if (!model.totalParameters) {
        model.metadata = { ...(model.metadata ?? {}), unverified: true };
      }
      this.models.set(keyFor(model.providerId, model.id), model);
    }
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

/** One bounded attempt for every eligible provider in the safe catalog. */
export const DEFAULT_MAX_ROUTE_ATTEMPTS = 7;
export const DEFAULT_ROUTE_COOLDOWN_MS = 30_000;
export const DEFAULT_ESTIMATED_OUTPUT_TOKENS = 1_024;

export interface ProviderGatewayOptions {
  maxAttempts?: number;
  cooldownMs?: number;
  estimatedOutputTokens?: number;
  now?: () => number;
}

export class ProviderGateway implements LanguageModel {
  readonly models = new ModelRegistry();
  private selected?: ModelInfo;
  private routePreferences: ModelRoutePreference[] = [];
  private readonly cooldowns = new Map<string, number>();
  private readonly maxAttempts: number;
  private readonly cooldownMs: number;
  private readonly estimatedOutputTokens: number;
  private readonly now: () => number;

  constructor(
    readonly providers: ProviderRegistry,
    private readonly onEvent?: (event: GatewayEvent) => void,
    options: ProviderGatewayOptions = {},
  ) {
    this.maxAttempts = positiveInteger(
      options.maxAttempts,
      DEFAULT_MAX_ROUTE_ATTEMPTS,
      "maxAttempts",
    );
    this.cooldownMs = nonNegativeNumber(
      options.cooldownMs,
      DEFAULT_ROUTE_COOLDOWN_MS,
      "cooldownMs",
    );
    this.estimatedOutputTokens = nonNegativeNumber(
      options.estimatedOutputTokens,
      DEFAULT_ESTIMATED_OUTPUT_TOKENS,
      "estimatedOutputTokens",
    );
    this.now = options.now ?? Date.now;
  }

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
    this.routePreferences = [{ providerId, modelId }];
    this.emit({ type: "model_selected", providerId, modelId });
    return model;
  }

  setRoutePreferences(
    preferences: readonly ModelRoutePreference[],
  ): readonly ModelRoutePreference[] {
    if (preferences.length === 0) {
      throw new Error("At least one model route preference is required.");
    }
    const seen = new Set<string>();
    const normalized = preferences.map((preference, index) => {
      const model = this.models.get(preference.providerId, preference.modelId);
      if (!model) {
        throw new Error(
          `Model not found: ${preference.providerId}/${preference.modelId}`,
        );
      }
      const key = keyFor(preference.providerId, preference.modelId);
      if (seen.has(key)) throw new Error(`Duplicate model route: ${key}`);
      seen.add(key);
      const value = routePreferenceValue(preference, index);
      return { ...preference, preference: value };
    });

    this.routePreferences = normalized;
    const primary = normalized[0]!;
    this.selected = this.models.get(primary.providerId, primary.modelId);
    this.emit({
      type: "model_selected",
      providerId: primary.providerId,
      modelId: primary.modelId,
      reason: `${normalized.length} route preferences configured`,
    });
    return this.getRoutePreferences();
  }

  getRoutePreferences(): readonly ModelRoutePreference[] {
    return this.routePreferences.map((preference) => ({ ...preference }));
  }

  registerModel(model: ModelInfo): ModelInfo {
    const registered = {
      ...model,
      totalParameters:
        model.totalParameters ??
        lookupTotalParameters(model.providerId, model.id),
    };
    this.models.replace(model.providerId, [
      ...this.models.list(model.providerId),
      registered,
    ]);
    return registered;
  }

  getSelected(): ModelInfo | undefined {
    return this.selected;
  }

  async route(model = this.selected): Promise<ModelRoute> {
    if (!model) throw new Error("No model selected.");
    return this.providers.get(model.providerId).createRoute(model);
  }

  estimateContext(request: ModelRequest): ModelContextEstimate {
    const primary = this.routePreferences[0];
    const model = primary
      ? this.models.get(primary.providerId, primary.modelId)
      : this.selected;
    return {
      inputTokens: estimateModelRequestTokens(request),
      contextWindowTokens: model?.contextWindow,
      reservedOutputTokens: this.estimatedOutputTokens,
    };
  }

  /**
   * When every policy-allowed route is cooling down, a short wait is better than
   * demoting the request to an excluded provider. Rate-limit cooldowns are
   * seconds; a judgement step is worth waiting for. The wait is bounded and
   * abortable, and falls through to normal ranking when it expires.
   */
  private async waitOutCooldownForPolicy(request: ModelRequest): Promise<void> {
    const policy = request.routePolicy;
    const budget = policy?.maxCooldownWaitMs ?? 0;
    if (!policy?.excludeProviders?.length || budget <= 0) return;
    const excluded = new Set(policy.excludeProviders);
    const allowed = this.routePreferences
      .map((preference) =>
        this.models.get(preference.providerId, preference.modelId),
      )
      .filter(
        (model): model is ModelInfo =>
          model !== undefined && !excluded.has(model.providerId),
      );
    if (allowed.length === 0) return;
    const cooldowns = allowed.map(
      (model) => this.cooldowns.get(keyFor(model.providerId, model.id)) ?? 0,
    );
    const now = this.now();
    const earliest = Math.min(...cooldowns);
    const waitMs = earliest - now;
    if (waitMs <= 0 || waitMs > budget) return;
    this.emit({
      type: "routing_decision",
      providerId: allowed[0]!.providerId,
      modelId: allowed[0]!.id,
      reason: `waiting ${waitMs} ms for a preferred route to leave cooldown rather than using ${[...excluded].join(", ")}${policy.reason ? `; ${policy.reason}` : ""}`,
      attempt: 0,
      contextTokens: estimateModelRequestTokens(request),
      estimatedCost: null,
    });
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, waitMs);
      timer.unref?.();
      request.signal?.addEventListener(
        "abort",
        () => {
          clearTimeout(timer);
          resolve();
        },
        { once: true },
      );
    });
  }

  rankRoutes(request: ModelRequest): RankedModelRoute[] {
    const contextTokens = estimateModelRequestTokens(request);
    const now = this.now();
    const excluded = new Set(request.routePolicy?.excludeProviders ?? []);
    const candidates = this.routePreferences.flatMap(
      (preference, index): RouteRankingCandidate[] => {
        const model = this.models.get(
          preference.providerId,
          preference.modelId,
        );
        return model
          ? [
              {
                model,
                preference: routePreferenceValue(preference, index),
                cooldownUntil: this.cooldowns.get(
                  keyFor(model.providerId, model.id),
                ),
              },
            ]
          : [];
      },
    );
    // Excluding every configured route would leave the caller with nothing, so
    // the filter only applies while at least one route survives it.
    const allowed = candidates.filter(
      (candidate) => !excluded.has(candidate.model.providerId),
    );
    return rankModelRoutes(allowed.length > 0 ? allowed : candidates, {
      requiresTools: request.tools.length > 0,
      contextTokens,
      estimatedOutputTokens: this.estimatedOutputTokens,
      now,
    });
  }

  async respond(request: ModelRequest): Promise<ModelResponse> {
    if (this.routePreferences.length === 0 && this.selected) {
      this.routePreferences = [
        { providerId: this.selected.providerId, modelId: this.selected.id },
      ];
    }
    await this.waitOutCooldownForPolicy(request);
    const rankedRoutes = this.rankRoutes(request);
    const ranked = rankedRoutes
      .filter((candidate) => candidate.eligible)
      .slice(0, this.maxAttempts);
    if (ranked.length === 0) {
      const contextTooLarge = rankedRoutes.some((candidate) =>
        candidate.reason.includes("exceeds window"),
      );
      throw new ModelError(
        this.routePreferences.length === 0
          ? "No model selected."
          : contextTooLarge
            ? "No configured route can fit the request context."
            : "No route supports the request requirements.",
        contextTooLarge
          ? { code: "context_length", retryable: true }
          : { code: "invalid_request", retryable: false },
      );
    }

    let previousFailure: GatewayFailure | undefined;
    for (let index = 0; index < ranked.length; index += 1) {
      const candidate = ranked[index]!;
      const attempt = index + 1;
      const reason = previousFailure
        ? `failover after ${previousFailure.code}; ${candidate.reason}`
        : candidate.reason;
      const event = {
        providerId: candidate.model.providerId,
        modelId: candidate.model.id,
        reason,
        attempt,
        contextTokens: candidate.contextTokens,
        estimatedCost: candidate.estimatedCost,
      };
      this.emit({ type: "routing_decision", ...event });
      this.emit({ type: "routing_attempt_started", ...event });
      this.emit({ type: "llm_request_started", ...event });

      try {
        const route = await this.route(candidate.model);
        const response = await route.execute(request);
        response.providerId ??= candidate.model.providerId;
        response.model ??= candidate.model.id;
        if (response.cost === undefined && response.usage) {
          response.cost =
            estimateModelCost(
              candidate.model,
              response.usage.inputTokens,
              response.usage.outputTokens,
            ) ?? undefined;
        }
        const resolvedResponse = response;
        this.emit({ type: "routing_attempt_completed", ...event });
        this.emit({ type: "llm_request_completed", ...event });
        return resolvedResponse;
      } catch (error) {
        const modelError = toModelError(error);
        const failure: GatewayFailure = {
          code: modelError.code,
          retryable: modelError.retryable,
          status: modelError.status,
        };
        this.emit({
          type: "routing_attempt_failed",
          ...event,
          failure,
        });
        this.emit({ type: "llm_request_failed", ...event, failure });
        if (modelError.retryable && modelError.code !== "context_length") {
          this.cooldowns.set(
            keyFor(candidate.model.providerId, candidate.model.id),
            this.now() + this.cooldownMs,
          );
        }
        if (!modelError.retryable || attempt === ranked.length) {
          throw modelError;
        }
        previousFailure = failure;
      }
    }

    throw new ModelError("All model routes failed.", {
      code: "unknown",
      retryable: false,
    });
  }

  private emit(event: GatewayEvent): void {
    try {
      this.onEvent?.(event);
    } catch {
      // Telemetry observers must never control routing or failover.
    }
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

interface HostedOpenAIProviderDefinition {
  id: string;
  baseUrl: string;
  models: Array<{
    id: string;
    contextWindow?: number;
    reasoning?: boolean;
  }>;
}

/** OpenAI-chat-compatible hosted providers with a deliberately small model
 * allowlist. Keeping that list explicit lets the application uphold the
 * problem statement's <=80B total-parameter rule even when a provider's
 * general catalog contains much larger models. */
class HostedOpenAIProvider extends HttpProvider {
  constructor(
    private readonly definition: HostedOpenAIProviderDefinition,
    credentials: CredentialResolver,
    fetcher?: typeof fetch,
  ) {
    super(definition.id, credentials, fetcher);
  }

  async validateCredentials(): Promise<void> {
    const response = await this.fetcher(`${this.definition.baseUrl}/models`, {
      headers: { Authorization: this.authorization() ?? "" },
    });
    if (response.status === 401 || response.status === 403) {
      throw new Error(`${this.id} credentials were rejected.`);
    }
    if (!response.ok)
      throw new Error(`${this.id} unavailable (${response.status}).`);
  }

  async discoverModels(
    options: { refresh?: boolean } = {},
  ): Promise<ModelInfo[]> {
    if (!options.refresh && this.cache) return this.cache.models;
    const response = await this.fetcher(`${this.definition.baseUrl}/models`, {
      headers: { Authorization: this.authorization() ?? "" },
    });
    if (!response.ok) {
      throw new Error(
        `${this.id} model discovery failed (${response.status}).`,
      );
    }
    const body = (await response.json()) as { data?: Array<{ id?: string }> };
    if (!Array.isArray(body.data)) {
      throw new Error(`${this.id} returned a malformed model catalog.`);
    }
    const available = new Set(
      body.data
        .map((model) => model.id)
        .filter((id): id is string => typeof id === "string"),
    );
    const models = this.definition.models
      .filter((model) => available.has(model.id))
      .map((model) => hostedModel(this.id, model));
    this.cache = { fetchedAt: Date.now(), models };
    return models;
  }

  async createRoute(model: ModelInfo): Promise<ModelRoute> {
    if (
      !this.definition.models.some((candidate) => candidate.id === model.id)
    ) {
      throw new Error(
        `${model.id} is not in the verified <=80B allowlist for ${this.id}.`,
      );
    }
    const config = this.getConfig();
    const key = this.credentials.get(config.credentialRef ?? "");
    if (!key)
      throw new Error(`Credential unavailable for provider ${this.id}.`);
    const client = new OpenAICompatibleChatModel({
      apiKey: key,
      model: model.id,
      baseURL: this.definition.baseUrl,
    });
    return {
      providerId: this.id,
      modelId: model.id,
      baseUrl: this.definition.baseUrl,
      protocol: "openai-chat",
      credentialRef: config.credentialRef,
      execute: (request) => client.respond(request),
    };
  }
}

const MISTRAL_PROVIDER: HostedOpenAIProviderDefinition = {
  id: "mistral",
  baseUrl: "https://api.mistral.ai/v1",
  models: [
    { id: "ministral-14b-latest", contextWindow: 262_144 },
    { id: "ministral-8b-latest", contextWindow: 262_144 },
    { id: "ministral-3b-latest", contextWindow: 262_144 },
  ],
};

const CEREBRAS_PROVIDER: HostedOpenAIProviderDefinition = {
  id: "cerebras",
  baseUrl: "https://api.cerebras.ai/v1",
  models: [{ id: "gemma-4-31b", contextWindow: 131_072, reasoning: true }],
};

const HUGGINGFACE_PROVIDER: HostedOpenAIProviderDefinition = {
  id: "huggingface",
  baseUrl: "https://router.huggingface.co/v1",
  models: [
    {
      id: "Qwen/Qwen3-Coder-30B-A3B-Instruct",
      contextWindow: 262_144,
      reasoning: true,
    },
    { id: "Qwen/Qwen2.5-Coder-32B-Instruct", contextWindow: 131_072 },
  ],
};

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
      models?: Array<{
        name?: string;
        size?: number;
        details?: Record<string, unknown>;
      }>;
    };
    if (!Array.isArray(body.models))
      throw new Error("Ollama returned a malformed model catalog.");
    const models = body.models
      .filter((model) => Boolean(model.name))
      .map((model) => {
        const totalParams = lookupTotalParameters("ollama", model.name!);
        // Ollama reports weight size for every installed model, which is what
        // actually decides whether it fits the reference 16 GB / 8 GB machine.
        const hardware = assessLocalModel(
          typeof model.size === "number" ? model.size : undefined,
        );
        return {
          id: model.name!,
          name: model.name!,
          providerId: this.id,
          totalParameters: totalParams,
          capabilities: {
            tools: true,
            vision: false,
            reasoning: false,
            streaming: true,
            structuredOutput: true,
          },
          metadata: {
            ...(model.details ?? {}),
            ...(totalParams ? {} : { unverified: true }),
            hardwareFit: hardware.verdict,
            hardwareDetail: hardware.detail,
            ...(hardware.modelBytes === undefined
              ? {}
              : { weightBytes: hardware.modelBytes }),
          },
        };
      });
    this.cache = { fetchedAt: Date.now(), models };
    return models;
  }
  async createRoute(model: ModelInfo): Promise<ModelRoute> {
    const config = this.getConfig();
    const baseUrl = ollamaBase(config);
    const endpoint = `${baseUrl}/api/chat`;
    const client = new OllamaModel({
      model: model.id,
      endpoint,
      contextWindow: model.contextWindow,
    });
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
  description?: string;
  defaultModelId?: string;
  modelOptions?: string[];
}

/** Single source of truth for what a settings screen needs to collect per
 * provider, so the GUI/TUI settings surfaces don't hardcode provider
 * knowledge that can drift from what createDefaultProviderGateway registers. */
export const PROVIDER_FIELD_SPECS: ProviderFieldSpec[] = [
  {
    id: "groq",
    label: "Groq",
    fields: ["apiKey", "manualModelId"],
    credentialRequired: true,
    helpUrl: "https://console.groq.com/keys",
    description: "Fast hosted inference with a permanent free-plan allowance.",
    defaultModelId: "qwen/qwen3.6-27b",
    modelOptions: [
      "qwen/qwen3.6-27b",
      "qwen/qwen3.8-27b",
      "openai/gpt-oss-20b",
    ],
  },
  {
    id: "openrouter",
    label: "OpenRouter",
    fields: ["apiKey", "manualModelId"],
    credentialRequired: true,
    helpUrl: "https://openrouter.ai/keys",
    description: "Free-model access using an explicit <=80B route.",
    defaultModelId: "nvidia/nemotron-3.5-lightning:free",
    modelOptions: ["nvidia/nemotron-3.5-lightning:free"],
  },
  {
    id: "mistral",
    label: "Mistral AI",
    fields: ["apiKey", "manualModelId"],
    credentialRequired: true,
    helpUrl: "https://console.mistral.ai/api-keys/",
    description: "Free Studio mode with compact tool-capable models.",
    defaultModelId: "ministral-14b-latest",
    modelOptions: [
      "ministral-14b-latest",
      "ministral-8b-latest",
      "ministral-3b-latest",
    ],
  },
  {
    id: "cerebras",
    label: "Cerebras",
    fields: ["apiKey", "manualModelId"],
    credentialRequired: true,
    helpUrl: "https://cloud.cerebras.ai/platform/",
    description:
      "Very fast inference; the current trial requires account verification.",
    defaultModelId: "gemma-4-31b",
    modelOptions: ["gemma-4-31b"],
  },
  {
    id: "huggingface",
    label: "Hugging Face",
    fields: ["apiKey", "manualModelId"],
    credentialRequired: true,
    helpUrl: "https://huggingface.co/settings/tokens",
    description:
      "Inference Providers routing with a small monthly free credit.",
    defaultModelId: "Qwen/Qwen3-Coder-30B-A3B-Instruct",
    modelOptions: [
      "Qwen/Qwen3-Coder-30B-A3B-Instruct",
      "Qwen/Qwen2.5-Coder-32B-Instruct",
    ],
  },
  {
    id: "ollama",
    label: "Ollama (local)",
    fields: ["baseUrl", "manualModelId"],
    credentialRequired: false,
    helpUrl: "https://ollama.com/download/windows",
    description:
      "Private local inference; the app starts the installed service automatically.",
    defaultModelId: "qwen2.5-coder:7b",
    modelOptions: ["qwen2.5-coder:7b"],
  },
  {
    id: "openai-compatible",
    label: "OpenAI-compatible / local endpoint",
    fields: ["baseUrl", "apiKey", "manualModelId"],
    credentialRequired: false,
    description: "Advanced route for a self-hosted compatible endpoint.",
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
  options: ProviderGatewayOptions & {
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
    .register(
      new HostedOpenAIProvider(MISTRAL_PROVIDER, credentials, options.fetcher),
    )
    .register(
      new HostedOpenAIProvider(CEREBRAS_PROVIDER, credentials, options.fetcher),
    )
    .register(
      new HostedOpenAIProvider(
        HUGGINGFACE_PROVIDER,
        credentials,
        options.fetcher,
      ),
    )
    .register(new OpenAICompatibleProvider(credentials, options.fetcher))
    .register(new OllamaProvider(credentials, options.fetcher));
  return new ProviderGateway(registry, options.onEvent, options);
}

/** Groq's model list has no per-token pricing and no active/expert count, so
 * the 80B total-parameter cap cannot be enforced from this metadata alone. */
function normalizeGroqModel(raw: unknown): ModelInfo | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const model = raw as Record<string, unknown>;
  if (typeof model.id !== "string") return undefined;
  if (model.active === false) return undefined;
  const totalParams = lookupTotalParameters("groq", model.id);
  return {
    id: model.id,
    name: model.id,
    providerId: "groq",
    contextWindow: numberValue(model.context_window),
    totalParameters: totalParams,
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
  const totalParams = lookupTotalParameters("openrouter", model.id);
  return {
    id: model.id,
    name: typeof model.name === "string" ? model.name : model.id,
    providerId: "openrouter",
    contextWindow: context,
    maxOutputTokens: output,
    totalParameters: totalParams,
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
    metadata: {
      ...(model as Record<string, unknown>),
      ...(model.totalParameters ? {} : { unverified: true }),
    },
  };
}

function hostedModel(
  providerId: string,
  model: HostedOpenAIProviderDefinition["models"][number],
): ModelInfo {
  return {
    id: model.id,
    name: model.id,
    providerId,
    contextWindow: model.contextWindow,
    totalParameters: lookupTotalParameters(providerId, model.id),
    capabilities: {
      tools: true,
      vision: false,
      reasoning: model.reasoning ?? false,
      streaming: true,
      structuredOutput: true,
    },
    metadata: { verifiedParameterLimit: true },
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
    // totalParameters may be supplied via catalog later
  };
}
export {
  assessLocalModel,
  formatGiB,
  LOCAL_RAM_BUDGET_BYTES,
  LOCAL_VRAM_BUDGET_BYTES,
  type LocalFitVerdict,
  type LocalHardwareAssessment,
} from "./local-hardware.js";

export function estimateModelCost(
  model: ModelInfo,
  inputTokens: number,
  outputTokens: number,
): number | null {
  if (model.providerId === "ollama") return 0;
  const inputPrice = model.pricing?.inputPerMillion;
  const outputPrice = model.pricing?.outputPerMillion;
  if (inputPrice === undefined && outputPrice === undefined) return null;
  return (
    ((inputPrice ?? 0) * Math.max(0, inputTokens) +
      (outputPrice ?? 0) * Math.max(0, outputTokens)) /
    1_000_000
  );
}

function compareRankedRoutes(
  left: RankedModelRoute,
  right: RankedModelRoute,
): number {
  if (left.eligible !== right.eligible) return left.eligible ? -1 : 1;
  if (left.inCooldown !== right.inCooldown) return left.inCooldown ? 1 : -1;
  if (left.preference !== right.preference) {
    return left.preference - right.preference;
  }
  const leftCost = left.estimatedCost ?? Number.POSITIVE_INFINITY;
  const rightCost = right.estimatedCost ?? Number.POSITIVE_INFINITY;
  if (leftCost !== rightCost) return leftCost - rightCost;
  const leftWindow = left.model.contextWindow ?? Number.POSITIVE_INFINITY;
  const rightWindow = right.model.contextWindow ?? Number.POSITIVE_INFINITY;
  if (leftWindow !== rightWindow) return leftWindow - rightWindow;
  return keyFor(left.model.providerId, left.model.id).localeCompare(
    keyFor(right.model.providerId, right.model.id),
  );
}

function serializedLength(value: unknown): number {
  try {
    return JSON.stringify(value)?.length ?? 0;
  } catch {
    return 0;
  }
}

function routePreferenceValue(
  preference: ModelRoutePreference,
  fallback: number,
): number {
  const value = preference.preference ?? preference.priority ?? fallback;
  if (!Number.isFinite(value)) {
    throw new Error("A route preference must be a finite number.");
  }
  return value;
}

function positiveInteger(
  value: number | undefined,
  fallback: number,
  name: string,
): number {
  const resolved = value ?? fallback;
  if (!Number.isInteger(resolved) || resolved < 1) {
    throw new Error(`${name} must be a positive integer.`);
  }
  return resolved;
}

function nonNegativeNumber(
  value: number | undefined,
  fallback: number,
  name: string,
): number {
  const resolved = value ?? fallback;
  if (!Number.isFinite(resolved) || resolved < 0) {
    throw new Error(`${name} must be a non-negative number.`);
  }
  return resolved;
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
  const message =
    error instanceof Error ? error.message : "Provider request failed.";
  return message
    .replace(/(bearer\s+)[^\s"']+/giu, "$1[REDACTED]")
    .replace(/([?&](?:api_?key|token|secret)=)[^&\s]+/giu, "$1[REDACTED]")
    .slice(0, 500);
}
