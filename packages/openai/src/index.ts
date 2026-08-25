import OpenAI from "openai";
import type {
  AssistantMessage,
  ConversationMessage,
  LanguageModel,
  ModelRequest,
  ModelResponse,
  ToolCall,
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

export class OpenAIModel implements LanguageModel {
  private readonly client: OpenAI;
  private readonly model: string;

  constructor(options: OpenAIResponseOptions) {
    if (!options.apiKey.trim()) {
      throw new Error("An OpenAI API key is required.");
    }

    this.client = new OpenAI({
      apiKey: options.apiKey,
      baseURL: options.baseURL,
    });
    this.model = options.model ?? DEFAULT_OPENAI_MODEL;
  }

  async respond(request: ModelRequest): Promise<ModelResponse> {
    const response = await this.client.responses.create({
      model: this.model,
      input: toResponseInput(request.messages),
      tools: request.tools.map(toFunctionTool),
    });
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

    return { message, text: response.output_text, toolCalls };
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
    this.client = new OpenAI({
      apiKey: options.apiKey,
      baseURL: options.baseURL,
    });
  }

  async respond(request: ModelRequest): Promise<ModelResponse> {
    const response = await this.client.chat.completions.create({
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
    });
    const message = response.choices[0]?.message;
    if (!message) throw new Error("Provider returned no completion choices.");
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
        throw new Error(`Invalid arguments for tool "${call.function.name}".`);
      }
    });
    const content = message.content ?? "";
    return {
      message: { role: "assistant", content, toolCalls },
      text: content,
      toolCalls,
    };
  }
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
