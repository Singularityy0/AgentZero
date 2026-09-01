import { randomUUID } from "node:crypto";
import {
  ModelError,
  toModelError,
  type AssistantMessage,
  type ConversationMessage,
  type LanguageModel,
  type ModelRequest,
  type ModelResponse,
  type ModelTiming,
  type ModelUsage,
  type ToolCall,
  type ToolDefinition,
} from "@agentic-runtime/core";

export const DEFAULT_OLLAMA_ENDPOINT = "http://localhost:11434/api/chat";

export interface OllamaModelOptions {
  model: string;
  endpoint?: string;
  apiKey?: string;
  timeoutMs?: number;
  contextWindow?: number;
  /** Upper bound on generated tokens; a whole file must fit in one response. */
  maxOutputTokens?: number;
}

export const DEFAULT_NUM_PREDICT = 4096;

interface OllamaMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  tool_name?: string;
  tool_calls?: OllamaToolCall[];
}

interface OllamaToolCall {
  type?: "function";
  function: {
    name: string;
    arguments: Record<string, unknown>;
  };
}

interface OllamaResponse {
  model?: string;
  created_at?: string;
  message?: OllamaMessage;
  done?: boolean;
  done_reason?: string;
  total_duration?: number;
  load_duration?: number;
  prompt_eval_count?: number;
  prompt_eval_duration?: number;
  eval_count?: number;
  eval_duration?: number;
  error?: string;
}

export class OllamaModel implements LanguageModel {
  private readonly endpoint: string;
  private readonly timeoutMs: number;

  constructor(private readonly options: OllamaModelOptions) {
    if (!options.model.trim()) {
      throw new ModelError("An Ollama model name is required.", {
        code: "invalid_request",
        retryable: false,
      });
    }
    this.endpoint = options.endpoint ?? DEFAULT_OLLAMA_ENDPOINT;
    this.timeoutMs = options.timeoutMs ?? 300_000;
  }

  async respond(request: ModelRequest): Promise<ModelResponse> {
    const controller = new AbortController();
    let abortSource: "external" | "timeout" | undefined;
    const abortFromRequest = (): void => {
      if (abortSource) return;
      abortSource = "external";
      controller.abort(request.signal?.reason);
    };
    if (request.signal?.aborted) {
      abortFromRequest();
    } else {
      request.signal?.addEventListener("abort", abortFromRequest, {
        once: true,
      });
    }
    const timer = setTimeout(() => {
      if (abortSource) return;
      abortSource = "timeout";
      controller.abort();
    }, this.timeoutMs);
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
    };
    if (this.options.apiKey) {
      headers.Authorization = `Bearer ${this.options.apiKey}`;
    }

    try {
      const response = await fetch(this.endpoint, {
        method: "POST",
        headers,
        body: JSON.stringify({
          model: this.options.model,
          messages: request.messages.map(toOllamaMessage),
          tools: request.tools.map(toOllamaTool),
          options: {
            ...(this.options.contextWindow
              ? { num_ctx: this.options.contextWindow }
              : {}),
            num_predict: this.options.maxOutputTokens ?? DEFAULT_NUM_PREDICT,
          },
          stream: false,
        }),
        signal: controller.signal,
      });
      let body: OllamaResponse;
      try {
        body = (await response.json()) as OllamaResponse;
      } catch (error) {
        if (!response.ok) {
          throw toModelError(
            { status: response.status },
            `Ollama request failed (${response.status}).`,
          );
        }
        throw new ModelError("Ollama returned malformed JSON.", {
          code: "invalid_request",
          retryable: false,
          cause: error,
        });
      }

      if (!response.ok) {
        throw toModelError(
          { status: response.status },
          body.error ?? `Ollama request failed (${response.status}).`,
        );
      }
      if (!body.message) {
        throw new ModelError("Ollama returned no message.", {
          code: "invalid_request",
          retryable: false,
        });
      }

      const nativeToolCalls = (body.message.tool_calls ?? []).map(toToolCall);
      const toolCalls =
        nativeToolCalls.length > 0
          ? nativeToolCalls
          : parseJsonToolCalls(body.message.content);
      const message: AssistantMessage = {
        role: "assistant",
        content: body.message.content,
        toolCalls,
      };
      const usage = normalizeUsage(body);
      const timing = normalizeTiming(body);
      return {
        message,
        text: body.message.content,
        toolCalls,
        ...(usage ? { usage } : {}),
        ...(timing ? { timing } : {}),
        model: body.model ?? this.options.model,
        ...(body.created_at ? { createdAt: body.created_at } : {}),
        ...(body.done_reason ? { finishReason: body.done_reason } : {}),
      };
    } catch (error) {
      if (abortSource === "external") {
        throw new ModelError("Ollama request was cancelled.", {
          code: "cancelled",
          retryable: false,
          cause: error,
        });
      }
      if (abortSource === "timeout") {
        throw new ModelError(
          `Ollama request timed out after ${this.timeoutMs} ms.`,
          {
            code: "timeout",
            retryable: true,
            cause: error,
          },
        );
      }
      throw toModelError(error, "Ollama request failed.");
    } finally {
      clearTimeout(timer);
      request.signal?.removeEventListener("abort", abortFromRequest);
    }
  }
}

function normalizeUsage(body: OllamaResponse): ModelUsage | undefined {
  if (body.prompt_eval_count === undefined && body.eval_count === undefined) {
    return undefined;
  }
  const inputTokens = body.prompt_eval_count ?? 0;
  const outputTokens = body.eval_count ?? 0;
  return {
    inputTokens,
    outputTokens,
    totalTokens: inputTokens + outputTokens,
  };
}

function normalizeTiming(body: OllamaResponse): ModelTiming | undefined {
  const durationMs = nanosecondsToMilliseconds(body.total_duration);
  const loadDurationMs = nanosecondsToMilliseconds(body.load_duration);
  const inputDurationMs = nanosecondsToMilliseconds(body.prompt_eval_duration);
  const outputDurationMs = nanosecondsToMilliseconds(body.eval_duration);
  if (
    durationMs === undefined &&
    loadDurationMs === undefined &&
    inputDurationMs === undefined &&
    outputDurationMs === undefined
  ) {
    return undefined;
  }
  return {
    ...(durationMs === undefined ? {} : { durationMs }),
    ...(loadDurationMs === undefined ? {} : { loadDurationMs }),
    ...(inputDurationMs === undefined ? {} : { inputDurationMs }),
    ...(outputDurationMs === undefined ? {} : { outputDurationMs }),
  };
}

function nanosecondsToMilliseconds(
  value: number | undefined,
): number | undefined {
  return value === undefined ? undefined : value / 1_000_000;
}

function toOllamaMessage(message: ConversationMessage): OllamaMessage {
  if (message.role === "tool") {
    return {
      role: "tool",
      tool_name: message.toolName,
      content: message.content,
    };
  }

  if (message.role === "assistant" && message.toolCalls?.length) {
    return {
      role: "assistant",
      content: "",
      tool_calls: message.toolCalls.map((call) => ({
        type: "function",
        function: { name: call.name, arguments: call.arguments },
      })),
    };
  }

  return { role: message.role, content: message.content };
}

function toOllamaTool(tool: ToolDefinition): Record<string, unknown> {
  return {
    type: "function",
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters,
    },
  };
}

function toToolCall(call: OllamaToolCall): ToolCall {
  return {
    id: randomUUID(),
    name: call.function.name,
    arguments: call.function.arguments,
  };
}

export function parseJsonToolCalls(content: string): ToolCall[] {
  const taggedCandidates = [
    ...content.matchAll(
      /<(?:tool_response|tool_call)>\s*([\s\S]*?)\s*<\/(?:tool_response|tool_call)>/gi,
    ),
  ].map((match) => match[1] ?? "");
  const fencedCandidates = [
    ...content.matchAll(/```(?:json)?\s*([\s\S]*?)\s*```/gi),
  ].map((match) => match[1] ?? "");
  const candidates = [
    content.trim(),
    ...taggedCandidates,
    ...fencedCandidates,
    ...extractJsonObjects(content),
    ...content.split(/\r?\n/),
  ].filter((value, index, values) => value && values.indexOf(value) === index);
  const calls: ToolCall[] = [];
  const signatures = new Set<string>();

  for (const candidateText of candidates) {
    try {
      const parsed: unknown = JSON.parse(
        normalizeJsonLineContinuations(candidateText),
      );
      for (const candidate of collectJsonToolCandidates(parsed)) {
        const functionCall = asRecord(candidate.function);
        const name = firstString(
          candidate.name,
          candidate.tool_name,
          candidate.tool,
          functionCall?.name,
        );
        let arguments_: unknown =
          candidate.arguments ??
          candidate.parameters ??
          candidate.input ??
          functionCall?.arguments ??
          functionCall?.parameters;
        if (typeof arguments_ === "string") {
          arguments_ = JSON.parse(arguments_);
        }
        const toolArguments = asRecord(arguments_);
        if (!name || !toolArguments) continue;

        const signature = JSON.stringify([name, toolArguments]);
        if (signatures.has(signature)) continue;
        signatures.add(signature);

        calls.push({
          id: randomUUID(),
          name,
          arguments: toolArguments,
        });
      }
    } catch {
      // Continue when the model response contains non-tool text.
    }
  }

  return calls;
}

function normalizeJsonLineContinuations(value: string): string {
  // Some local instruct models emit a backslash followed by a physical newline
  // while building multiline JSON string arguments. JSON has no line-
  // continuation syntax, so convert that invalid form to the standard `\n`
  // escape before parsing the otherwise valid tool call.
  return value.replace(/\\\r?\n/gu, "\\n").replace(/\\([^"\\/bfnrtu])/gu, "$1");
}

function collectJsonToolCandidates(value: unknown): Record<string, unknown>[] {
  if (Array.isArray(value)) {
    return value.flatMap(collectJsonToolCandidates);
  }
  const candidate = asRecord(value);
  if (!candidate) return [];

  const wrappedCalls = candidate.tool_calls ?? candidate.calls;
  if (Array.isArray(wrappedCalls)) {
    return wrappedCalls.flatMap(collectJsonToolCandidates);
  }
  return [candidate];
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function firstString(...values: unknown[]): string | undefined {
  return values.find(
    (value): value is string => typeof value === "string" && value.length > 0,
  );
}

function extractJsonObjects(content: string): string[] {
  const objects: string[] = [];
  let start = -1;
  let depth = 0;
  let quoted = false;
  let escaped = false;

  for (let index = 0; index < content.length; index += 1) {
    const character = content[index];
    if (quoted) {
      if (escaped) {
        escaped = false;
      } else if (character === "\\") {
        escaped = true;
      } else if (character === '"') {
        quoted = false;
      }
      continue;
    }
    if (character === '"') {
      quoted = true;
    } else if (character === "{" && depth === 0) {
      start = index;
      depth = 1;
    } else if (character === "{" && depth > 0) {
      depth += 1;
    } else if (character === "}" && depth > 0) {
      depth -= 1;
      if (depth === 0 && start >= 0) {
        objects.push(content.slice(start, index + 1));
        start = -1;
      }
    }
  }

  return objects;
}
