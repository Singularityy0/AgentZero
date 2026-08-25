export interface ToolDefinition {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  approval?: ToolApproval;
}

export type ToolApproval = "auto" | "ask";

export interface ToolExecutionContext {
  cwd: string;
  signal: AbortSignal;
  requestApproval: (reason: string) => Promise<boolean>;
}

export interface ToolPreviewContext {
  cwd: string;
}

export interface ToolResult {
  output: string;
  changed?: boolean;
  isError?: boolean;
  exitCode?: number;
  timedOut?: boolean;
  truncated?: boolean;
}

export interface Tool extends ToolDefinition {
  preview?: (
    arguments_: Record<string, unknown>,
    context: ToolPreviewContext,
  ) => Promise<string>;
  execute(
    arguments_: Record<string, unknown>,
    context: ToolExecutionContext,
  ): Promise<ToolResult>;
}
