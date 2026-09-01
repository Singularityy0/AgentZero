export interface UserMessage {
  role: "user";
  content: string;
}

export interface SystemMessage {
  role: "system";
  content: string;
  kind?: "instruction" | "compaction";
}

export interface CompactedTaskState {
  version: 1;
  objective: string;
  plan: string[];
  completedWork: string[];
  failures: string[];
  changedFiles: Array<{ path: string; hash?: string }>;
  verificationStatus: string[];
  retrievedSlices: string[];
  projectRules: string[];
  openQuestions: string[];
}

export interface ContextCompactionCheckpoint {
  version: 1;
  reason: "token_threshold" | "context_limit";
  pass: number;
  estimatedTokensBefore: number;
  estimatedTokensAfter: number;
  compactedMessageCount: number;
  state: CompactedTaskState;
  createdAt: number;
}

export interface AssistantMessage {
  role: "assistant";
  content: string;
  toolCalls?: readonly ToolCall[];
  metadata?: {
    taskId?: string;
    /** Safe execution summary for UI disclosure, never private chain-of-thought. */
    thinking?: string[];
  };
}

export interface ToolMessage {
  role: "tool";
  toolCallId: string;
  toolName?: string;
  content: string;
  metadata?: {
    /** Whether the tool execution failed. Used by workflow completion checks. */
    isError?: boolean;
    /** Whether the tool changed workspace state. */
    changed?: boolean;
    exitCode?: number;
    changedFiles?: Array<{ path: string; hash?: string }>;
    contextArtifacts?: Array<{
      source: "file" | "retrieval" | "manual" | "tool";
      path?: string;
      hash?: string;
      startLine?: number;
      endLine?: number;
      content: string;
      tokenEstimate: number;
    }>;
  };
}

export type ConversationMessage =
  UserMessage | SystemMessage | AssistantMessage | ToolMessage;

export interface ToolCall {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
}
