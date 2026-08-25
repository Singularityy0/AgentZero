import { randomUUID } from "node:crypto";
import type {
  AssistantMessage,
  ConversationMessage,
  LanguageModel,
  ModelRequest,
  ModelResponse,
  ToolCall,
  ToolDefinition,
} from "@agentic-runtime/core";

export const DEFAULT_OLLAMA_ENDPOINT = "http://localhost:11434/api/chat";

export interface OllamaModelOptions {
  model: string;
  endpoint?: string;
  apiKey?: string;
  timeoutMs?: number;
}

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
  message?: OllamaMessage;
  error?: string;
}

export class OllamaModel implements LanguageModel {
  private readonly endpoint: string;
  private readonly timeoutMs: number;

  constructor(private readonly options: OllamaModelOptions) {
    if (!options.model.trim()) {
      throw new Error("An Ollama model name is required.");
    }
    this.endpoint = options.endpoint ?? DEFAULT_OLLAMA_ENDPOINT;
    this.timeoutMs = options.timeoutMs ?? 120_000;
  }

  async respond(request: ModelRequest): Promise<ModelResponse> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
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
          stream: false,
        }),
        signal: controller.signal,
      });
      const body = (await response.json()) as OllamaResponse;

      if (!response.ok) {
        throw new Error(
          body.error ?? `Ollama request failed (${response.status}).`,
        );
      }
      if (!body.message) {
        throw new Error("Ollama returned no message.");
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
      return { message, text: body.message.content, toolCalls };
    } finally {
      clearTimeout(timer);
    }
  }
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
    ...content.split(/\r?\n/),
  ].filter((value, index, values) => value && values.indexOf(value) === index);
  const calls: ToolCall[] = [];

  for (const candidateText of candidates) {
    try {
      const parsed: unknown = JSON.parse(candidateText);
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        continue;
      }

      const candidate = parsed as Record<string, unknown>;
      if (
        typeof candidate.name !== "string" ||
        !candidate.arguments ||
        typeof candidate.arguments !== "object" ||
        Array.isArray(candidate.arguments)
      ) {
        continue;
      }

      calls.push({
        id: randomUUID(),
        name: candidate.name,
        arguments: candidate.arguments as Record<string, unknown>,
      });
    } catch {
      // Continue when the model response contains non-tool text.
    }
  }

  return calls;
}
