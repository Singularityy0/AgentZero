import { extname } from "node:path";

import type { ConversationMessage, ToolCall, ToolMessage } from "./messages.js";
import type { AgentEvent } from "./events.js";
import type { LanguageModel } from "./model.js";
import { ToolRegistry } from "./tool-registry.js";
import type {
  ToolExecutionContext,
  ToolPreviewContext,
  ToolResult,
} from "./tools.js";
import { rustClient } from "./rust-tools.js";

export interface AgentRunnerOptions {
  cwd: string;
  maxSteps?: number;
  requestApproval: (call: ToolCall, preview?: string) => Promise<boolean>;
  signal?: AbortSignal;
  beforeModelRequest?: () => void;
  onEvent?: (event: AgentEvent) => void | Promise<void>;
}

export interface AgentRunResult {
  text: string;
  messages: ConversationMessage[];
}

export class AgentRunner {
  private readonly maxSteps: number;

  constructor(
    private readonly model: LanguageModel,
    private readonly tools: ToolRegistry,
    private readonly options: AgentRunnerOptions,
  ) {
    this.maxSteps = options.maxSteps ?? 12;
  }

  async run(messages: ConversationMessage[]): Promise<AgentRunResult> {
    const cachedToolResults = new Map<string, CachedToolResult>();
    const executedToolNames: string[] = [];
    let workspaceRevision = 0;
    let duplicateCallCount = 0;
    let hadNoOpMutation = false;
    let lastResponseText = "";
    const workflow = createWorkflowState(messages);

    for (let step = 0; step < this.maxSteps; step += 1) {
      await this.compactContextIfNecessary(messages);

      this.options.beforeModelRequest?.();
      await this.emit({
        type: "model_request",
        messageCount: messages.length,
        toolCount: this.tools.list().length,
      });
      const response = await this.model.respond({
        messages,
        tools: this.tools.list(),
      });
      messages.push(response.message);
      lastResponseText = response.text;
      await this.emit({
        type: "model_response",
        text: response.text,
        toolCallCount: response.toolCalls.length,
      });

      if (response.toolCalls.length === 0) {
        const followUp = workflow.followUp(executedToolNames, hadNoOpMutation);
        if (followUp) {
          messages.push({ role: "user", content: followUp });
          continue;
        }
        await this.emit({ type: "agent_completed", text: response.text });
        return { text: response.text, messages };
      }

      for (const call of response.toolCalls) {
        executedToolNames.push(call.name);
        await this.emit({ type: "tool_requested", call });
        const signature = JSON.stringify([call.name, call.arguments]);
        const cached = cachedToolResults.get(signature);
        if (cached?.workspaceRevision === workspaceRevision) {
          duplicateCallCount += 1;
          const result: ToolResult = {
            output:
              `Duplicate ${call.name} call skipped because the workspace has not changed. ` +
              "Use the earlier tool result already present in the conversation and continue the task without calling it again.",
          };
          await this.emit({ type: "tool_completed", call, result });
          messages.push(this.toToolMessage(call, result));
          if (duplicateCallCount >= 4) {
            const text =
              "The model repeatedly requested cached tool calls without making progress. " +
              "The run was stopped before it could loop or exceed the provider token limit.";
            await this.emit({ type: "agent_safety_limit", text });
            return { text, messages };
          }
          continue;
        }

        const result = await this.executeTool(call);
        if (
          result.changed === false &&
          ["apply_patch", "write_file", "create_file", "delete_file"].includes(
            call.name,
          )
        ) {
          hadNoOpMutation = true;
        }
        if (result.changed === true) workspaceRevision += 1;
        cachedToolResults.set(signature, { result, workspaceRevision });
        await this.emit({ type: "tool_completed", call, result });
        messages.push(this.toToolMessage(call, result));
      }
    }

    const text = lastResponseText
      ? `${lastResponseText}\n\n[Agent stopped after reaching the ${this.maxSteps}-step safety limit.]`
      : `[Agent stopped after reaching the ${this.maxSteps}-step safety limit. Tools executed: ${executedToolNames.join(", ") || "none"}]`;
    await this.emit({ type: "agent_safety_limit", text });
    return { text, messages };
  }

  private async compactContextIfNecessary(
    messages: ConversationMessage[],
  ): Promise<void> {
    const threshold = 20_000;
    const totalLength = () =>
      messages.reduce((sum, message) => sum + message.content.length, 0);

    if (totalLength() <= threshold) return;

    for (let index = 0; index < messages.length; index += 1) {
      const message = messages[index];
      if (
        message?.role !== "tool" ||
        message.toolName !== "read_file" ||
        message.content.includes("[Content compacted for token efficiency.")
      ) {
        continue;
      }

      const file = parseReadFilePayload(message.content);
      if (!file) continue;

      const extension = extname(file.path).slice(1).toLowerCase() || "ts";
      try {
        rustClient.start();
        const pruned = await rustClient.pruneAst(file.content, extension);
        messages[index] = {
          ...message,
          content: JSON.stringify({
            ...file,
            content: `[Content compacted for token efficiency. Showing signatures only.]\n${pruned}`,
          }),
        };
      } catch {
        // The model-backed compaction below remains available without Rust.
      }
    }

    if (totalLength() <= threshold) return;

    const systemPrompts = messages.filter(
      (message) => message.role === "system",
    );
    const conversation = messages.filter(
      (message) => message.role !== "system",
    );

    if (conversation.length <= 4) return;

    const splitIndex = Math.floor(conversation.length / 2);
    const toSummarize = conversation.slice(0, splitIndex);
    const toKeep = conversation.slice(splitIndex);
    const summaryRequest: ConversationMessage[] = [
      {
        role: "system",
        content:
          "Summarize the technical analysis, decisions, completed work, failures, and remaining work in these messages so another model can continue. Preserve concrete file paths, constraints, and verification results. Be concise.",
      },
      ...toSummarize,
    ];

    try {
      this.options.beforeModelRequest?.();
      const response = await this.model.respond({
        messages: summaryRequest,
        tools: [],
      });
      const summaryMessage: ConversationMessage = {
        role: "system",
        content: `[Session summary of earlier context]\n${response.text}`,
      };

      await this.emit({ type: "context_compacted", summary: response.text });
      messages.length = 0;
      messages.push(...systemPrompts, summaryMessage, ...toKeep);
    } catch {
      // Keep the original context when compaction cannot complete safely.
    }
  }

  private async emit(event: AgentEvent): Promise<void> {
    await this.options.onEvent?.(event);
  }

  private async executeTool(call: ToolCall): Promise<ToolResult> {
    const tool = this.tools.get(call.name);

    if (!tool) {
      return { output: `Unknown tool: ${call.name}`, isError: true };
    }

    const validationErrors = this.tools.validateArguments(
      call.name,
      call.arguments,
    );
    if (validationErrors.length > 0) {
      return {
        output: `Invalid tool arguments: ${validationErrors.join("; ")}`,
        isError: true,
      };
    }

    if (tool.approval !== "auto") {
      const previewContext: ToolPreviewContext = { cwd: this.options.cwd };
      let preview: string | undefined;
      try {
        preview = tool.preview
          ? await tool.preview(call.arguments, previewContext)
          : undefined;
      } catch (error) {
        return {
          output: `Unable to prepare tool preview: ${error instanceof Error ? error.message : String(error)}`,
          isError: true,
        };
      }

      const approved = await this.options.requestApproval(call, preview);
      if (!approved) {
        return { output: "Tool execution denied by the user.", isError: true };
      }
    } else {
      await this.emit({ type: "tool_auto_approved", call });
    }

    const context: ToolExecutionContext = {
      cwd: this.options.cwd,
      signal: this.options.signal ?? new AbortController().signal,
      requestApproval: async () => true,
    };

    try {
      return await tool.execute(call.arguments, context);
    } catch (error) {
      return {
        output: error instanceof Error ? error.message : String(error),
        isError: true,
      };
    }
  }

  private toToolMessage(call: ToolCall, result: ToolResult): ToolMessage {
    const metadata = [
      result.isError ? "error" : undefined,
      result.exitCode === undefined
        ? undefined
        : `exit code: ${result.exitCode}`,
      result.timedOut ? "timed out" : undefined,
      result.truncated ? "output truncated" : undefined,
    ].filter(Boolean);
    const suffix = metadata.length > 0 ? `\n[${metadata.join(", ")}]` : "";

    return {
      role: "tool",
      toolCallId: call.id,
      toolName: call.name,
      content: `${result.output}${suffix}`,
    };
  }
}

interface CachedToolResult {
  result: ToolResult;
  workspaceRevision: number;
}

interface ReadFilePayload extends Record<string, unknown> {
  path: string;
  content: string;
}

function parseReadFilePayload(content: string): ReadFilePayload | undefined {
  try {
    const value: unknown = JSON.parse(content);
    if (
      typeof value !== "object" ||
      value === null ||
      !("path" in value) ||
      typeof value.path !== "string" ||
      !("content" in value) ||
      typeof value.content !== "string"
    ) {
      return undefined;
    }
    return value as ReadFilePayload;
  } catch {
    return undefined;
  }
}

interface WorkflowState {
  followUp: (
    executedTools: readonly string[],
    hadNoOpMutation: boolean,
  ) => string | undefined;
}

function createWorkflowState(
  messages: readonly ConversationMessage[],
): WorkflowState {
  const request = [...messages]
    .reverse()
    .find((message) => message.role === "user")?.content;
  if (
    !request ||
    /\b(do not|don't|dont)\s+(modify|change|write|edit)/i.test(request)
  ) {
    return { followUp: () => undefined };
  }

  const requestsPatch = /apply_patch|patch/i.test(request);
  const requestsMutation =
    requestsPatch ||
    /\b(add|create|delete|remove|modify|change|edit|write|overwrite)\b/i.test(
      request,
    );
  const requestsReadAfterMutation =
    /read (the )?file again|verify (the )?(file|change)|re-?read/i.test(
      request,
    );
  const requestsVerification =
    /\b(build|compile|format|syntax|typecheck|test|verify)\b/i.test(request);

  if (!requestsMutation && !requestsVerification) {
    return { followUp: () => undefined };
  }

  return {
    followUp: (executedTools, hadNoOpMutation) => {
      const mutationIndex = executedTools.findIndex((tool) =>
        ["apply_patch", "write_file", "create_file", "delete_file"].includes(
          tool,
        ),
      );
      const hasPatch = executedTools.includes("apply_patch");
      const hasReadAfterMutation =
        mutationIndex >= 0 &&
        executedTools.slice(mutationIndex + 1).includes("read_file");
      const hasVerification = executedTools.some((tool) =>
        ["compile_code", "syntax_check", "format_code", "run_code"].includes(
          tool,
        ),
      );

      if (requestsPatch && !hasPatch) {
        return `The original user request is: ${request}\n\nYou have only read the file. The required next action is to call apply_patch, not to describe a command and not to ask for details. Respond with exactly one apply_patch tool call using the previous file content and the requested change. Do not call compile_code until apply_patch has been approved and executed.`;
      }
      if (requestsMutation && mutationIndex < 0) {
        return `The original user request is: ${request}\n\nThe requested file mutation has not happened. Do not answer with prose or ask for details. Call the appropriate file mutation tool now, then continue with the remaining requested steps.`;
      }
      if (
        requestsReadAfterMutation &&
        !hasReadAfterMutation &&
        !hadNoOpMutation
      ) {
        return `The patch has already been approved and applied. Do not ask for approval again and do not answer with a diff. Call read_file now for the changed file to verify the edit, then continue with the remaining requested steps from the original request: ${request}`;
      }
      if (requestsVerification && !hasVerification) {
        return `The requested edit and verification are not complete. Do not answer with prose or ask the user to run a command. Call the appropriate verification tool now, then report its actual result: ${request}`;
      }
      return undefined;
    },
  };
}
