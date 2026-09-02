import type { AssistantMessage, ConversationMessage } from "./messages.js";
import type { ToolDefinition } from "./tools.js";

export const DEFAULT_MAX_TOOL_STEPS = 8;

/**
 * Per-request routing constraints.
 *
 * Route ranking is global, so a provider cooldown during one stage silently
 * pushes the next stage onto whatever route is left. That is correct for
 * generation but wrong for judgement: a verifier is worthless if it runs on a
 * weaker model than the coder it is checking. A policy lets a caller say which
 * providers must not serve a request, and whether waiting out a cooldown is
 * preferable to degrading.
 */
/**
 * How a request wants eligible routes ordered, once tool support and context fit
 * have been settled.
 *
 * `capacity` puts the largest known model first and is for work whose quality
 * decides whether the task succeeds at all: planning a decomposition, judging
 * whether an implementation is correct. `economy` puts the cheapest first and is
 * for work where a small model is genuinely sufficient — summarising retrieval
 * output, answering a one-line question — so the budget is spent where it moves
 * accuracy. `balanced` keeps the operator's configured preference order.
 */
export type ModelRouteBias = "balanced" | "capacity" | "economy";

export interface ModelRoutePolicy {
  /** Providers that must not serve this request while any alternative exists. */
  excludeProviders?: readonly string[];
  /**
   * Wait up to this long for an excluded-set-free route to leave cooldown
   * before considering the excluded providers. Zero disables waiting.
   */
  maxCooldownWaitMs?: number;
  /** Ordering preference among eligible routes. Defaults to `balanced`. */
  bias?: ModelRouteBias;
  /** Reject routes whose known context window is below this many tokens. */
  minContextWindow?: number;
  /** Human-readable justification, surfaced in routing events. */
  reason?: string;
}

export interface ModelRequest {
  messages: readonly ConversationMessage[];
  tools: readonly ToolDefinition[];
  signal?: AbortSignal;
  routePolicy?: ModelRoutePolicy;
  /**
   * Completion budget for this logical stage. Small planning and verification
   * turns should not reserve the same provider quota as a whole-file creation.
   */
  maxOutputTokens?: number;
}

export interface ModelUsage {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  cachedInputTokens?: number;
  reasoningTokens?: number;
}

export interface ModelTiming {
  durationMs?: number;
  loadDurationMs?: number;
  inputDurationMs?: number;
  outputDurationMs?: number;
}

export interface ModelResponse {
  message: AssistantMessage;
  text: string;
  toolCalls: readonly import("./messages.js").ToolCall[];
  usage?: ModelUsage;
  timing?: ModelTiming;
  providerId?: string;
  model?: string;
  cost?: number;
  responseId?: string;
  createdAt?: string;
  finishReason?: string;
}

export interface ModelContextEstimate {
  inputTokens: number;
  contextWindowTokens?: number;
  reservedOutputTokens?: number;
}

export interface LanguageModel {
  respond(request: ModelRequest): Promise<ModelResponse>;
  estimateContext?(request: ModelRequest): ModelContextEstimate;
}

export function estimateModelRequestTokens(request: ModelRequest): number {
  const serialized = JSON.stringify({
    messages: request.messages,
    tools: request.tools,
  });
  return Math.max(1, Math.ceil(serialized.length / 4));
}

export type ModelErrorCode =
  | "rate_limit"
  | "quota"
  | "context_length"
  | "timeout"
  | "cancelled"
  | "connection"
  | "server"
  | "authentication"
  | "invalid_request"
  | "unknown";

export interface ModelErrorClassification {
  code: ModelErrorCode;
  retryable: boolean;
  status?: number;
}

export interface ModelErrorOptions extends ModelErrorClassification {
  cause?: unknown;
}

export class ModelError extends Error {
  readonly code: ModelErrorCode;
  readonly retryable: boolean;
  readonly status?: number;

  constructor(message: string, options: ModelErrorOptions) {
    super(
      message,
      options.cause === undefined ? undefined : { cause: options.cause },
    );
    this.name = "ModelError";
    this.code = options.code;
    this.retryable = options.retryable;
    this.status = options.status;
  }
}

export function classifyModelError(error: unknown): ModelErrorClassification {
  if (error instanceof ModelError) {
    return {
      code: error.code,
      retryable: error.retryable,
      status: error.status,
    };
  }

  const status = errorStatus(error);
  const code = errorCode(error).toLowerCase();
  const name = errorName(error).toLowerCase();
  const message = errorMessage(error).toLowerCase();
  const searchable = `${code} ${name} ${message}`;

  if (status === 429 || includesAny(searchable, ["rate_limit", "rate limit"])) {
    return { code: "rate_limit", retryable: true, status };
  }
  if (
    status === 402 ||
    includesAny(searchable, [
      "insufficient quota",
      "insufficient_quota",
      "payment required",
      "quota exceeded",
      "quota exhausted",
      "out of credits",
      "credit balance",
    ])
  ) {
    // Billing/quota exhaustion is terminal for this provider account but not
    // for the user's task. Mark it retryable so the gateway cools down this
    // route and immediately tries another configured provider.
    return { code: "quota", retryable: true, status };
  }
  if (
    status === 413 ||
    includesAny(searchable, [
      "context_length",
      "context length",
      "maximum context",
      "payload too large",
      "request too large",
    ])
  ) {
    return { code: "context_length", retryable: true, status };
  }
  if (
    status === 408 ||
    includesAny(searchable, [
      "timeout",
      "timed out",
      "etimedout",
      "apiconnectiontimeouterror",
    ])
  ) {
    return { code: "timeout", retryable: true, status };
  }
  if (
    name === "aborterror" ||
    includesAny(searchable, [
      "apiuseraborterror",
      "cancelled",
      "canceled",
      "user abort",
    ])
  ) {
    return { code: "cancelled", retryable: false, status };
  }
  if (
    includesAny(searchable, [
      "apiconnectionerror",
      "connection error",
      "connection refused",
      "connection reset",
      "econnrefused",
      "econnreset",
      "enotfound",
      "fetch failed",
      "network error",
      "socket hang up",
    ])
  ) {
    return { code: "connection", retryable: true, status };
  }
  if (status !== undefined && status >= 500 && status <= 599) {
    return { code: "server", retryable: true, status };
  }
  if (
    status === 401 ||
    status === 403 ||
    includesAny(searchable, [
      "authentication",
      "unauthorized",
      "forbidden",
      "api key",
      "credential",
    ])
  ) {
    return { code: "authentication", retryable: false, status };
  }
  if (
    (status !== undefined && status >= 400 && status <= 499) ||
    includesAny(searchable, [
      "bad request",
      "invalid argument",
      "invalid request",
      "malformed",
      "model not found",
    ])
  ) {
    return { code: "invalid_request", retryable: false, status };
  }

  return { code: "unknown", retryable: false, status };
}

export function toModelError(
  error: unknown,
  fallbackMessage = "Model request failed.",
): ModelError {
  if (error instanceof ModelError) return error;
  const classification = classifyModelError(error);
  return new ModelError(
    error instanceof Error && error.message ? error.message : fallbackMessage,
    { ...classification, cause: error },
  );
}

function errorStatus(error: unknown): number | undefined {
  const record = asRecord(error);
  const direct = finiteNumber(record?.status);
  if (direct !== undefined) return direct;
  const response = asRecord(record?.response);
  const responseStatus = finiteNumber(response?.status);
  if (responseStatus !== undefined) return responseStatus;
  const match = errorMessage(error).match(/\b([45]\d\d)\b/);
  return match ? Number(match[1]) : undefined;
}

function errorCode(error: unknown): string {
  const value = asRecord(error)?.code;
  return typeof value === "string" ? value : "";
}

function errorName(error: unknown): string {
  const value = asRecord(error)?.name;
  return typeof value === "string" ? value : "";
}

function errorMessage(error: unknown): string {
  const value = asRecord(error)?.message;
  return typeof value === "string" ? value : String(error ?? "");
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object"
    ? (value as Record<string, unknown>)
    : undefined;
}

function finiteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value)
    ? value
    : undefined;
}

function includesAny(value: string, candidates: readonly string[]): boolean {
  return candidates.some((candidate) => value.includes(candidate));
}

export const DEFAULT_MAX_TOOL_RETRIES = 3;
