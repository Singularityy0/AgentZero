import type { AssistantMessage, ConversationMessage } from "./messages.js";
import type { ToolDefinition } from "./tools.js";
export const DEFAULT_MAX_TOOL_STEPS = 8;

export interface ModelRequest {
  messages: readonly ConversationMessage[];
  tools: readonly ToolDefinition[];
}

export interface ModelResponse {
  message: AssistantMessage;
  text: string;
  toolCalls: readonly import("./messages.js").ToolCall[];
}

export interface LanguageModel {
  respond(request: ModelRequest): Promise<ModelResponse>;
}

export const DEFAULT_MAX_TOOL_RETRIES = 3;
