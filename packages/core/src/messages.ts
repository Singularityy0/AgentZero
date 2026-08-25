export interface UserMessage {
  role: "user";
  content: string;
}

export interface SystemMessage {
  role: "system";
  content: string;
}

export interface AssistantMessage {
  role: "assistant";
  content: string;
  toolCalls?: readonly ToolCall[];
}

export interface ToolMessage {
  role: "tool";
  toolCallId: string;
  toolName?: string;
  content: string;
}

export type ConversationMessage =
  UserMessage | SystemMessage | AssistantMessage | ToolMessage;

export interface ToolCall {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
}
