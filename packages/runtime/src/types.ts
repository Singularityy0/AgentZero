import type {
  AgentDefinition,
  ConversationMessage,
  MultiAgentEvent,
  OrchestrationEvent,
  ToolApprovalResponse,
  ToolCall,
  ToolPreview,
} from "@agentic-runtime/core";
import type { GatewayEvent } from "@agentic-runtime/gateway";
import type { SessionRecord, TraceSpanRecord } from "@agentic-runtime/session";

export type RuntimeProviderId =
  "ollama" | "groq" | "openrouter" | "openai-compatible";

export interface RuntimeModelRouteSelection {
  providerId: RuntimeProviderId;
  modelId: string;
  baseUrl?: string;
  credentialRef?: string | null;
  contextWindow?: number;
  inputCostPerMillion?: number;
  outputCostPerMillion?: number;
}

export interface RuntimeModelSelection extends RuntimeModelRouteSelection {
  fallbacks?: readonly RuntimeModelRouteSelection[];
}

export interface RuntimeLimits {
  maxDepth: number;
  maxHandoffs: number;
  maxHandoffsPerPair: number;
  maxModelSteps: number;
  maxToolCalls: number;
  maxDurationMs: number;
  contextCharacterBudget: number;
}

export const DEFAULT_RUNTIME_LIMITS: RuntimeLimits = {
  maxDepth: 4,
  maxHandoffs: 8,
  maxHandoffsPerPair: 2,
  maxModelSteps: 32,
  maxToolCalls: 128,
  maxDurationMs: 10 * 60_000,
  contextCharacterBudget: 20_000,
};

export interface RuntimeApprovalRequest {
  requestId: string;
  sessionId: string;
  taskId: string;
  runId: string;
  agentId: string;
  call: ToolCall;
  preview?: ToolPreview;
}

export type RuntimeApprovalHandler = (
  request: RuntimeApprovalRequest,
) => Promise<ToolApprovalResponse>;

export interface StartTaskInput {
  sessionId: string;
  agentId: string;
  prompt: string;
}

export interface ResumeTaskInput {
  taskId: string;
  agentId?: string;
}

export interface ContextLineRange {
  startLine: number;
  endLine: number;
}

export interface AddFileContextInput {
  sessionId: string;
  path: string;
  range?: ContextLineRange;
}

export type RemoveFileContextInput = AddFileContextInput;

export interface RuntimeFileContext {
  id: string;
  sessionId: string;
  path: string;
  content: string;
  startLine?: number;
  endLine?: number;
  tokenEstimate: number;
  createdAt: number;
}

export interface StartIsolatedQuestionInput {
  sessionId: string;
  agentId: string;
  prompt: string;
}

export interface RuntimeIsolatedQuestionResult {
  sessionId: string;
  agentId: string;
  text: string;
}

export interface RuntimeIsolatedQuestionHandle {
  sessionId: string;
  completion: Promise<RuntimeIsolatedQuestionResult>;
  cancel(): void;
}

export interface RuntimeTaskResult {
  sessionId: string;
  taskId: string;
  runId: string;
  agentId: string;
  status: "completed" | "failed" | "paused";
  text: string;
  handoffs: number;
  messages: ConversationMessage[];
}

export interface RuntimeTaskHandle {
  sessionId: string;
  taskId: string;
  completion: Promise<RuntimeTaskResult>;
  cancel(): void;
}

interface RuntimeEventBase {
  sessionId: string;
  taskId?: string;
  occurredAt: number;
}

export type RuntimeEvent =
  | (RuntimeEventBase & {
      type: "task_started";
      taskId: string;
      agentId: string;
      prompt: string;
      maxModelSteps: number;
    })
  | (RuntimeEventBase & {
      type: "orchestration_event";
      taskId: string;
      event: MultiAgentEvent;
    })
  | (RuntimeEventBase & {
      type: "pipeline_event";
      taskId: string;
      event: OrchestrationEvent;
    })
  | (RuntimeEventBase & {
      type: "routing_event";
      taskId: string;
      event: GatewayEvent;
    })
  | (RuntimeEventBase & {
      type: "approval_requested";
      taskId: string;
      request: RuntimeApprovalRequest;
    })
  | (RuntimeEventBase & {
      type: "approval_resolved";
      taskId: string;
      requestId: string;
      approved: boolean;
      decision: ToolApprovalResponse;
    })
  | (RuntimeEventBase & {
      type: "task_paused";
      taskId: string;
      result: RuntimeTaskResult;
    })
  | (RuntimeEventBase & {
      type: "task_completed";
      taskId: string;
      result: RuntimeTaskResult;
    })
  | (RuntimeEventBase & {
      type: "trace_updated";
      span: TraceSpanRecord;
    })
  | (RuntimeEventBase & {
      type: "isolated_started";
      agentId: string;
      prompt: string;
    })
  | (RuntimeEventBase & {
      type: "isolated_completed";
      agentId: string;
      text: string;
    })
  | (RuntimeEventBase & {
      type: "isolated_failed";
      agentId: string;
      error: string;
    })
  | (RuntimeEventBase & {
      type: "task_failed";
      taskId: string;
      error: string;
      result?: RuntimeTaskResult;
    });

export type RuntimeEventListener = (
  event: RuntimeEvent,
) => void | Promise<void>;

export interface RuntimeSettingsStore {
  getCredential(providerId: string): string | undefined;
  setCredential(providerId: string, value: string): void;
  clearCredential(providerId: string): void;
  getProviderSetting(providerId: string, key: string): string | undefined;
  setProviderSetting(providerId: string, key: string, value: string): void;
  clearProviderSetting(providerId: string, key: string): void;
}

export interface RuntimeSessionService {
  createSession(title?: string): SessionRecord;
  getSession(sessionId: string): SessionRecord | undefined;
  listSessions(): SessionRecord[];
  clearSession(sessionId: string): SessionRecord;
  listAgents(): AgentDefinition[];
  getAgent(agentId: string): AgentDefinition | undefined;
  resumeTask(input: ResumeTaskInput): RuntimeTaskHandle;
  addFileContext(input: AddFileContextInput): Promise<RuntimeFileContext>;
  removeFileContext(input: RemoveFileContextInput): number;
  listFileContext(sessionId: string): RuntimeFileContext[];
  startIsolatedQuestion(
    input: StartIsolatedQuestionInput,
  ): RuntimeIsolatedQuestionHandle;
  runIsolatedQuestion(
    input: StartIsolatedQuestionInput,
  ): Promise<RuntimeIsolatedQuestionResult>;
  listTraceSpans(taskId: string): TraceSpanRecord[];
}
