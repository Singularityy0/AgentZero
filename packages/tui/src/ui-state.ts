import type {
  AgentEvent,
  MultiAgentEvent,
  OrchestrationEvent,
} from "@agentic-runtime/core";
import type { ToolCall } from "@agentic-runtime/core";
import type { ToolPreview } from "@agentic-runtime/core";
import type { ToolResult } from "@agentic-runtime/core";
import type { GatewayEvent } from "@agentic-runtime/gateway";

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

export interface RouteActivity {
  providerId: string;
  modelId?: string;
  reason?: string;
  attempt?: number;
  status: "selected" | "completed" | "failed";
  failure?: string;
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
  routeActivities: RouteActivity[];
  handoffs: HandoffActivity[];
  approval?: {
    call: ToolCall;
    preview?: ToolPreview;
    selectedHunkIds: string[];
    focusedHunk: number;
  };
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
  | { type: "gateway_event"; event: GatewayEvent }
  | { type: "pipeline_event"; event: OrchestrationEvent }
  | { type: "approval_requested"; call: ToolCall; preview?: ToolPreview }
  | { type: "approval_focus_changed"; offset: -1 | 1 }
  | { type: "approval_hunk_toggled" }
  | { type: "approval_all_selected" }
  | { type: "approval_resolved"; approved: boolean }
  | { type: "session_changed"; sessionId: string }
  | { type: "agent_changed"; agentId: string }
  | { type: "isolated_started" }
  | { type: "isolated_completed"; text: string }
  | { type: "isolated_failed"; error: string }
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
  routeActivities: [],
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
      approval: {
        call: action.call,
        preview: action.preview,
        selectedHunkIds:
          typeof action.preview === "object"
            ? action.preview.hunks.map((hunk) => hunk.id)
            : [],
        focusedHunk: 0,
      },
    };
  }

  if (action.type === "approval_focus_changed" && state.approval) {
    const count =
      typeof state.approval.preview === "object"
        ? state.approval.preview.hunks.length
        : 0;
    if (count === 0) return state;
    return {
      ...state,
      approval: {
        ...state.approval,
        focusedHunk:
          (state.approval.focusedHunk + action.offset + count) % count,
      },
    };
  }

  if (action.type === "approval_hunk_toggled" && state.approval) {
    const preview = state.approval.preview;
    if (typeof preview !== "object") return state;
    const hunk = preview.hunks[state.approval.focusedHunk];
    if (!hunk) return state;
    const selected = new Set(state.approval.selectedHunkIds);
    if (selected.has(hunk.id)) selected.delete(hunk.id);
    else selected.add(hunk.id);
    return {
      ...state,
      approval: { ...state.approval, selectedHunkIds: [...selected] },
    };
  }

  if (action.type === "approval_all_selected" && state.approval) {
    const preview = state.approval.preview;
    if (typeof preview !== "object") return state;
    return {
      ...state,
      approval: {
        ...state.approval,
        selectedHunkIds: preview.hunks.map((hunk) => hunk.id),
      },
    };
  }

  if (action.type === "session_changed") {
    return { ...state, sessionId: action.sessionId };
  }

  if (action.type === "agent_changed") {
    return { ...state, activeAgentId: action.agentId };
  }

  if (action.type === "isolated_started") {
    return {
      ...state,
      status: "thinking",
      lastProgress: "Answering isolated /bytheway question",
    };
  }

  if (action.type === "isolated_completed") {
    return {
      ...state,
      status: "completed",
      lastProgress: action.text,
    };
  }

  if (action.type === "isolated_failed") {
    return { ...state, status: "failed", error: action.error };
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

  if (action.type === "pipeline_event") {
    const event = action.event;
    if (event.type === "orchestration_started") {
      return {
        ...state,
        status: "thinking",
        lastProgress: "Pipeline started",
      };
    }
    if (event.type === "step_started") {
      return {
        ...state,
        activeAgentId: event.role,
        status: "thinking",
        lastProgress: `${event.role} stage started (attempt ${event.attempt})`,
      };
    }
    if (event.type === "step_completed") {
      return {
        ...state,
        status: "thinking",
        lastProgress: `${event.role} stage completed`,
      };
    }
    if (event.type === "step_retrying") {
      return {
        ...state,
        status: "thinking",
        lastProgress: `Retrying ${event.stepId}: ${event.reason}`,
      };
    }
    if (event.type === "step_recovering") {
      return {
        ...state,
        status: "thinking",
        lastProgress: `Recovering ${event.stepId}: ${event.reason}`,
      };
    }
    if (event.type === "orchestration_paused") {
      return {
        ...state,
        status: "idle",
        lastProgress: `Pipeline paused: ${event.reason}`,
      };
    }
    if (event.type === "orchestration_completed") {
      return {
        ...state,
        status: "thinking",
        lastProgress: "Pipeline completed",
      };
    }
    if (event.type === "orchestration_failed") {
      return { ...state, status: "failed", error: event.reason };
    }
    return state;
  }

  if (action.type === "gateway_event") {
    const event = action.event;
    if (!event.type.startsWith("routing_")) return state;
    const status =
      event.type === "routing_attempt_completed"
        ? "completed"
        : event.type === "routing_attempt_failed"
          ? "failed"
          : "selected";
    if (event.type === "routing_attempt_started") return state;
    const activity: RouteActivity = {
      providerId: event.providerId,
      modelId: event.modelId,
      reason: event.reason,
      attempt: event.attempt,
      status,
      failure: event.failure?.code,
    };
    const existingIndex = state.routeActivities.findIndex(
      (item) =>
        item.providerId === activity.providerId &&
        item.modelId === activity.modelId &&
        item.attempt === activity.attempt,
    );
    const routeActivities = [...state.routeActivities];
    if (existingIndex >= 0) routeActivities[existingIndex] = activity;
    else routeActivities.push(activity);
    return {
      ...state,
      provider: event.providerId,
      model: event.modelId ?? state.model,
      lastProgress:
        status === "failed"
          ? `${event.providerId}/${event.modelId ?? "unknown"} failed (${event.failure?.code ?? "unknown"}); trying fallback`
          : status === "completed"
            ? `${event.providerId}/${event.modelId ?? "unknown"} completed`
            : `Routing to ${event.providerId}/${event.modelId ?? "unknown"}`,
      routeActivities: routeActivities.slice(-8),
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
                status: "started" as const,
              },
            ].slice(-12)
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

  if (action.type !== "agent_event") return state;
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
              result: {
                ...event.result,
                output:
                  event.result.output.length <= 4_000
                    ? event.result.output
                    : `${event.result.output.slice(0, 4_000)}\n[truncated in TUI state]`,
              },
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
