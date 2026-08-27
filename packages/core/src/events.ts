import type { ToolCall } from "./messages.js";
import type { ToolResult } from "./tools.js";

export type AgentEvent =
  | { type: "model_request"; messageCount: number; toolCount: number }
  | { type: "model_response"; text: string; toolCallCount: number }
  | { type: "tool_requested"; call: ToolCall }
  | { type: "tool_auto_approved"; call: ToolCall }
  | { type: "tool_completed"; call: ToolCall; result: ToolResult }
  | { type: "agent_completed"; text: string }
  | { type: "agent_safety_limit"; text: string }
  | { type: "context_compacted"; summary: string };
