import type { ToolCall } from "./messages.js";
import type { ContextCompactionCheckpoint } from "./messages.js";
import type { ModelRequest, ModelResponse } from "./model.js";
import type { ToolResult } from "./tools.js";

export type AgentEvent =
  | {
      type: "model_request";
      callId?: string;
      messageCount: number;
      toolCount: number;
      request?: Omit<ModelRequest, "signal">;
    }
  | {
      type: "model_response";
      callId?: string;
      text: string;
      toolCallCount: number;
      response?: ModelResponse;
      durationMs?: number;
    }
  | {
      type: "tool_requested";
      spanId?: string;
      parentSpanId?: string;
      call: ToolCall;
    }
  | { type: "tool_auto_approved"; call: ToolCall }
  | {
      type: "tool_completed";
      spanId?: string;
      parentSpanId?: string;
      call: ToolCall;
      result: ToolResult;
    }
  | { type: "agent_completed"; text: string }
  | { type: "agent_safety_limit"; text: string }
  | {
      type: "context_compacted";
      summary: string;
      checkpoint: ContextCompactionCheckpoint;
    }
  | {
      type: "context_limit_recovery";
      attempt: number;
      estimatedTokens: number;
      targetTokens: number;
    };
