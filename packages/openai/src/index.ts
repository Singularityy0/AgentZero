import OpenAI from "openai";
import {
  ModelError,
  toModelError,
  type AssistantMessage,
  type ConversationMessage,
  type LanguageModel,
  type ModelRequest,
  type ModelResponse,
  type ModelUsage,
  type ToolCall,
} from "@agentic-runtime/core";
import type {
  FunctionTool,
  ResponseInput,
  ResponseInputItem,
} from "openai/resources/responses/responses";

export const DEFAULT_OPENAI_MODEL = "gpt-4.1-mini";

export interface OpenAIResponseOptions {
  apiKey: string;
  model?: string;
  baseURL?: string;
}

/**
 * A whole source file has to fit in one completion. Provider defaults are far
 * smaller than that, and a completion cut short at the default is written to
 * disk as if it were finished, so the limit is stated explicitly.
 */
export const DEFAULT_MAX_OUTPUT_TOKENS = 8192;

export class OpenAIModel implements LanguageModel {
  private readonly client: OpenAI;
  private readonly model: string;

  constructor(options: OpenAIResponseOptions) {
    if (!options.apiKey.trim()) {
      throw new ModelError("An OpenAI API key is required.", {
        code: "authentication",
        retryable: false,
      });
    }

    this.client = new OpenAI({
      apiKey: options.apiKey,
      baseURL: options.baseURL,
      maxRetries: 0,
    });
    this.model = options.model ?? DEFAULT_OPENAI_MODEL;
  }

  async respond(request: ModelRequest): Promise<ModelResponse> {
    const startedAt = Date.now();
    try {
      const response = await this.client.responses.create(
        {
          model: this.model,
          input: toResponseInput(request.messages),
          tools: request.tools.map(toFunctionTool),
          max_output_tokens:
            request.maxOutputTokens ?? DEFAULT_MAX_OUTPUT_TOKENS,
        },
        { signal: request.signal },
      );
      const toolCalls = response.output
        .filter(
          (item): item is OpenAI.Responses.ResponseFunctionToolCall =>
            item.type === "function_call",
        )
        .map(toToolCall);
      const message: AssistantMessage = {
        role: "assistant",
        content: response.output_text,
        toolCalls,
      };
      const usage = normalizeResponsesUsage(response.usage);
      const finishReason =
        response.incomplete_details?.reason ?? response.status;
      // `status` is normally "completed"; a provider can still resolve the
      // request (HTTP 200) while the underlying generation failed. Without
      // this check the empty response looks like a real, successful turn.
      if (response.status === "failed" || response.status === "cancelled") {
        throw new ModelError(
          `${this.model} returned status "${response.status}".`,
          { code: "server", retryable: true },
        );
      }

      return {
        message,
        text: response.output_text,
        toolCalls,
        ...(usage ? { usage } : {}),
        timing: { durationMs: Date.now() - startedAt },
        model: response.model,
        responseId: response.id,
        createdAt: new Date(response.created_at * 1_000).toISOString(),
        ...(finishReason ? { finishReason } : {}),
      };
    } catch (error) {
      if (request.signal?.aborted) {
        throw new ModelError("OpenAI request was cancelled.", {
          code: "cancelled",
          retryable: false,
          cause: error,
        });
      }
      throw toModelError(error, "OpenAI request failed.");
    }
  }
}

/** Executes against OpenAI-compatible Chat Completions APIs such as OpenRouter. */
export class OpenAICompatibleChatModel implements LanguageModel {
  private readonly client: OpenAI;

  constructor(
    private readonly options: Required<
      Pick<OpenAIResponseOptions, "apiKey" | "model">
    > & { baseURL: string },
  ) {
    if (!options.apiKey.trim()) {
      throw new ModelError("An API key is required.", {
        code: "authentication",
        retryable: false,
      });
    }
    this.client = new OpenAI({
      apiKey: options.apiKey,
      baseURL: options.baseURL,
      maxRetries: 0,
    });
  }

  async respond(request: ModelRequest): Promise<ModelResponse> {
    const startedAt = Date.now();
    try {
      const response = await this.client.chat.completions.create(
        {
          model: this.options.model,
          messages: request.messages.map(toChatMessage),
          tools: request.tools.map((tool) => ({
            type: "function" as const,
            function: {
              name: tool.name,
              description: tool.description,
              parameters: tool.parameters,
            },
          })),
          max_tokens: request.maxOutputTokens ?? DEFAULT_MAX_OUTPUT_TOKENS,
        },
        { signal: request.signal },
      );
      const choice = response.choices[0];
      const message = choice?.message;
      if (!message) throw new Error("Provider returned no completion choices.");
      // OpenRouter proxies to many backends and, when the upstream model itself
      // fails, still answers with HTTP 200 and a populated (often empty)
      // message - only `finish_reason` reveals the failure. Left unchecked,
      // this reads as a normal successful turn and the gateway's exception-
      // driven failover never runs.
      if ((choice.finish_reason as string) === "error") {
        throw new ModelError(
          `${this.options.model} returned finish_reason "error".`,
          { code: "server", retryable: true },
        );
      }
      const toolCalls = (message.tool_calls ?? []).flatMap((call) => {
        if (call.type !== "function") return [];
        try {
          const arguments_ = JSON.parse(call.function.arguments) as Record<
            string,
            unknown
          >;
          return [
            { id: call.id, name: call.function.name, arguments: arguments_ },
          ];
        } catch {
          throw new Error(
            `Invalid arguments for tool "${call.function.name}".`,
          );
        }
      });
      const content = message.content ?? "";
      const usage = normalizeChatUsage(response.usage);
      return {
        message: { role: "assistant", content, toolCalls },
        text: content,
        toolCalls,
        ...(usage ? { usage } : {}),
        timing: { durationMs: Date.now() - startedAt },
        model: response.model,
        responseId: response.id,
        createdAt: new Date(response.created * 1_000).toISOString(),
        finishReason: choice.finish_reason,
      };
    } catch (error) {
      if (request.signal?.aborted) {
        throw new ModelError("OpenAI-compatible request was cancelled.", {
          code: "cancelled",
          retryable: false,
          cause: error,
        });
      }
      throw toModelError(error, "OpenAI-compatible request failed.");
    }
  }
}

function normalizeResponsesUsage(
  usage: OpenAI.Responses.Response["usage"],
): ModelUsage | undefined {
  if (!usage) return undefined;
  return {
    inputTokens: usage.input_tokens,
    outputTokens: usage.output_tokens,
    totalTokens: usage.total_tokens,
    cachedInputTokens: usage.input_tokens_details.cached_tokens,
    reasoningTokens: usage.output_tokens_details.reasoning_tokens,
  };
}

function normalizeChatUsage(
  usage: OpenAI.Chat.Completions.ChatCompletion["usage"],
): ModelUsage | undefined {
  if (!usage) return undefined;
  const cachedInputTokens = usage.prompt_tokens_details?.cached_tokens;
  const reasoningTokens = usage.completion_tokens_details?.reasoning_tokens;
  return {
    inputTokens: usage.prompt_tokens,
    outputTokens: usage.completion_tokens,
    totalTokens: usage.total_tokens,
    ...(cachedInputTokens === undefined ? {} : { cachedInputTokens }),
    ...(reasoningTokens === undefined ? {} : { reasoningTokens }),
  };
}

export async function generateOpenAIResponse(
  prompt: string,
  options: OpenAIResponseOptions,
): Promise<string> {
  if (!prompt.trim()) {
    throw new Error("A prompt is required.");
  }

  const model = new OpenAIModel(options);
  const response = await model.respond({
    messages: [{ role: "user", content: prompt }],
    tools: [],
  });
  return response.text;
}

function toFunctionTool({
  name,
  description,
  parameters,
}: {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}): FunctionTool {
  return {
    type: "function",
    name,
    description,
    parameters,
    strict: true,
  };
}

function toResponseInput(
  messages: readonly ConversationMessage[],
): ResponseInput {
  return messages.flatMap((message): ResponseInputItem[] => {
    if (message.role === "user" || message.role === "system") {
      return [{ role: message.role, content: message.content }];
    }

    if (message.role === "assistant") {
      return message.toolCalls && message.toolCalls.length > 0
        ? message.toolCalls.map((call) => ({
            type: "function_call" as const,
            call_id: call.id,
            name: call.name,
            arguments: JSON.stringify(call.arguments),
          }))
        : [{ role: "assistant", content: message.content }];
    }

    return [
      {
        type: "function_call_output",
        call_id: message.toolCallId,
        output: message.content,
      },
    ];
  });
}

function toToolCall(call: OpenAI.Responses.ResponseFunctionToolCall): ToolCall {
  let arguments_: Record<string, unknown>;

  try {
    const parsed: unknown = JSON.parse(call.arguments);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("Tool arguments must be a JSON object.");
    }
    arguments_ = parsed as Record<string, unknown>;
  } catch (error) {
    throw new Error(
      `Invalid arguments for tool "${call.name}": ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  return { id: call.call_id, name: call.name, arguments: arguments_ };
}

function toChatMessage(
  message: ConversationMessage,
): OpenAI.Chat.Completions.ChatCompletionMessageParam {
  if (message.role === "system" || message.role === "user") {
    return { role: message.role, content: message.content };
  }
  if (message.role === "tool") {
    return {
      role: "tool",
      tool_call_id: message.toolCallId,
      content: message.content,
    };
  }
  if (message.toolCalls?.length) {
    return {
      role: "assistant",
      content: message.content || null,
      tool_calls: message.toolCalls.map((call) => ({
        id: call.id,
        type: "function" as const,
        function: {
          name: call.name,
          arguments: JSON.stringify(call.arguments),
        },
      })),
    };
  }
  return { role: "assistant", content: message.content };
}
