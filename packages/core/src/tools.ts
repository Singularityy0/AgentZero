export interface ToolDefinition {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  approval?: ToolApproval;
}

export type ToolApproval = "auto" | "ask";

export interface ProposedHunk {
  id: string;
  path: string;
  startLine: number;
  endLine: number;
  original: string;
  replacement: string;
}

export interface FileDiffPreview {
  kind: "file_diff";
  path: string;
  baseHash: string | null;
  proposedHash: string;
  text: string;
  hunks: ProposedHunk[];
  /** Symbols present before the change but absent after it. See workspace's PreparedFileChange. */
  warnings?: string[];
}

export type ToolPreview = string | FileDiffPreview;

export interface ApprovalDecision {
  acceptedHunkIds: string[];
  rejectedHunkIds: string[];
}

export type ToolApprovalResponse = boolean | ApprovalDecision;

export interface ToolReviewResult {
  acceptedHunkIds: string[];
  rejectedHunks: ProposedHunk[];
}

export interface WorkspaceMutationRecord {
  id: string;
  path: string;
  operation: "write" | "delete";
  before: { content: string; hash: string } | null;
  afterHash: string | null;
  acceptedHunkIds: string[];
}

export interface ContextArtifact {
  source: "file" | "retrieval" | "manual" | "tool";
  path?: string;
  hash?: string;
  startLine?: number;
  endLine?: number;
  content: string;
  tokenEstimate: number;
  /**
   * Why this slice is in context - an exact symbol match, a call-graph hop, a
   * text hit. The dashboard shows these, because "which files were in this
   * agent's context" is only half an answer without "and why".
   */
  reasons?: string[];
  /** Analyser that produced the symbols behind this slice, when known. */
  extractor?: string;
}

export interface ToolExecutionContext {
  cwd: string;
  signal: AbortSignal;
  requestApproval: (reason: string) => Promise<boolean>;
  approval?: {
    preview: ToolPreview;
    decision: ApprovalDecision;
  };
}

export interface ToolPreviewContext {
  cwd: string;
}

export interface ToolResult {
  output: string;
  changed?: boolean;
  isError?: boolean;
  /** True only when execution stopped because the human rejected approval. */
  denied?: boolean;
  exitCode?: number;
  timedOut?: boolean;
  truncated?: boolean;
  review?: ToolReviewResult;
  changedFiles?: Array<{ path: string; hash?: string }>;
  workspaceMutation?: WorkspaceMutationRecord;
  contextArtifacts?: ContextArtifact[];
}

export interface Tool extends ToolDefinition {
  preview?: (
    arguments_: Record<string, unknown>,
    context: ToolPreviewContext,
  ) => Promise<ToolPreview>;
  execute(
    arguments_: Record<string, unknown>,
    context: ToolExecutionContext,
  ): Promise<ToolResult>;
}
