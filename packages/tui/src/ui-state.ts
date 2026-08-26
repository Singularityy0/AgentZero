import type { AgentEvent, MultiAgentEvent } from "@agentic-runtime/core";
import type { ToolCall } from "@agentic-runtime/core";
import type { ToolResult } from "@agentic-runtime/core";

export type ActivityStatus =
  "idle" | "thinking" | "tool" | "approval" | "completed" | "failed";

export interface ToolActivity {
  id: string;
  agentId: string;
  call: ToolCall;
  result?: ToolResult;
  status: "running" | "completed" | "failed";
  startedAt: number;
  finishedAt?: number;
}

export interface HandoffActivity {
  parentAgentId: string;
  targetAgentId: string;
  task?: string;
  status: "started" | "completed" | "failed";
}

export interface TuiState {
  status: ActivityStatus;
  activeAgentId: string;
  model: string;
  provider: string;
  taskId?: string;
  sessionId?: string;
  step: number;
  maxSteps: number;
  startedAt?: number;
  lastProgress?: string;
  toolActivities: ToolActivity[];
  handoffs: HandoffActivity[];
  approval?: { call: ToolCall; preview?: string };
  error?: string;
}

export type TuiAction =
  | {
      type: "task_started";
      taskId: string;
      sessionId: string;
      agentId: string;
      maxSteps: number;
    }
  | { type: "agent_event"; agentId: string; event: AgentEvent }
  | { type: "multi_agent_event"; event: MultiAgentEvent }
  | { type: "approval_requested"; call: ToolCall; preview?: string }
  | { type: "approval_resolved"; approved: boolean }
  | { type: "task_completed"; text: string }
  | { type: "task_failed"; error: string };

export const initialTuiState: TuiState = {
  status: "idle",
  activeAgentId: "general",
  model: "",
  provider: "",
  step: 0,
  maxSteps: 24,
  toolActivities: [],
  handoffs: [],
};

export function reduceTuiState(state: TuiState, action: TuiAction): TuiState {
  if (action.type === "task_started") {
    return {
      ...initialTuiState,
      model: state.model,
      provider: state.provider,
      activeAgentId: action.agentId,
      taskId: action.taskId,
      sessionId: action.sessionId,
      maxSteps: action.maxSteps,
      startedAt: Date.now(),
      status: "thinking",
    };
  }

  if (action.type === "approval_requested") {
    return {
      ...state,
      status: "approval",
      approval: { call: action.call, preview: action.preview },
    };
  }

  if (action.type === "task_completed") {
    return {
      ...state,
      status: "completed",
      lastProgress: action.text,
      approval: undefined,
    };
  }

  if (action.type === "approval_resolved") {
    return {
      ...state,
      status: action.approved ? "tool" : "thinking",
      approval: undefined,
      lastProgress: action.approved ? "Approval granted" : "Approval denied",
    };
  }

  if (action.type === "task_failed") {
    return {
      ...state,
      status: "failed",
      error: action.error,
      approval: undefined,
    };
  }

  if (action.type === "multi_agent_event") {
    const event = action.event;
    if (event.type === "agent_started") {
      return {
        ...state,
        activeAgentId: event.agentId,
        status: "thinking",
        lastProgress: `${event.agentId} is working`,
        handoffs: event.parentAgentId
          ? [
              ...state.handoffs,
              {
                parentAgentId: event.parentAgentId,
                targetAgentId: event.agentId,
                task: event.task,
                status: "started",
              },
            ]
          : state.handoffs,
      };
    }
    if (event.type === "handoff_completed") {
      const handoffs = state.handoffs.map((handoff) =>
        handoff.parentAgentId === event.agentId &&
        handoff.targetAgentId === event.targetAgentId &&
        handoff.status === "started"
          ? { ...handoff, status: "completed" as const }
          : handoff,
      );
      return {
        ...state,
        handoffs,
        activeAgentId: event.agentId,
        status: "thinking",
      };
    }
    if (event.type === "agent_failed" || event.type === "handoff_rejected") {
      return {
        ...state,
        status: "failed",
        error: event.reason ?? event.output,
      };
    }
    return state;
  }

  const event = action.event;
  if (event.type === "model_request") {
    return {
      ...state,
      status: "thinking",
      step: state.step + 1,
      lastProgress: `Requesting model response (${event.toolCount} tools available)`,
    };
  }
  if (event.type === "model_response") {
    return {
      ...state,
      lastProgress: event.toolCallCount
        ? "Model selected tools"
        : "Model returned a response",
    };
  }
  if (event.type === "tool_requested") {
    const activity: ToolActivity = {
      id: event.call.id,
      agentId: state.activeAgentId,
      call: event.call,
      status: "running",
      startedAt: Date.now(),
    };
    return {
      ...state,
      status: "tool",
      lastProgress: `${event.call.name} is running`,
      toolActivities: [...state.toolActivities, activity].slice(-12),
    };
  }
  if (event.type === "tool_completed") {
    return {
      ...state,
      status: event.result.isError ? "failed" : "thinking",
      lastProgress: event.result.isError
        ? `${event.call.name} failed`
        : `${event.call.name} completed`,
      toolActivities: state.toolActivities.map((activity) =>
        activity.id === event.call.id
          ? {
              ...activity,
              result: event.result,
              status: event.result.isError ? "failed" : "completed",
              finishedAt: Date.now(),
            }
          : activity,
      ),
    };
  }
  if (event.type === "agent_safety_limit") {
    return { ...state, status: "failed", error: event.text };
  }
  return state;
}
