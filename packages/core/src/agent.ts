import { randomUUID } from "node:crypto";
import { extname } from "node:path";

import type {
  CompactedTaskState,
  ContextCompactionCheckpoint,
  ConversationMessage,
  SystemMessage,
  ToolCall,
  ToolMessage,
} from "./messages.js";
import type { AgentEvent } from "./events.js";
import {
  classifyModelError,
  estimateModelRequestTokens,
  type LanguageModel,
  type ModelRequest,
  type ModelResponse,
} from "./model.js";
import { ToolRegistry } from "./tool-registry.js";
import type {
  ApprovalDecision,
  FileDiffPreview,
  ToolApprovalResponse,
  ToolExecutionContext,
  ToolPreview,
  ToolPreviewContext,
  ToolResult,
} from "./tools.js";
import { rustClient } from "./rust-tools.js";

export interface ContextCompactionOptions {
  triggerRatio?: number;
  targetRatio?: number;
  recoveryTargetRatio?: number;
  maxPasses?: number;
  maxRecoveryAttempts?: number;
  minimumRecentExchanges?: number;
  fallbackContextWindowTokens?: number;
  reservedOutputTokens?: number;
}

export interface AgentRunnerOptions {
  cwd: string;
  maxSteps?: number;
  maxToolCalls?: number;
  requestApproval: (
    call: ToolCall,
    preview?: ToolPreview,
  ) => Promise<ToolApprovalResponse>;
  signal?: AbortSignal;
  beforeModelRequest?: () => void;
  enforceWorkflowCompletion?: boolean;
  compaction?: false | ContextCompactionOptions;
  onEvent?: (event: AgentEvent) => void | Promise<void>;
}

export interface AgentRunResult {
  text: string;
  messages: ConversationMessage[];
}

export class AgentRunner {
  private readonly maxSteps: number;
  private readonly maxToolCalls: number;
  private currentModelCallId?: string;

  constructor(
    private readonly model: LanguageModel,
    private readonly tools: ToolRegistry,
    private readonly options: AgentRunnerOptions,
  ) {
    this.maxSteps = options.maxSteps ?? 12;
    this.maxToolCalls = options.maxToolCalls ?? 128;
    if (this.maxToolCalls < 1) {
      throw new Error("maxToolCalls must be at least 1.");
    }
  }

  async run(messages: ConversationMessage[]): Promise<AgentRunResult> {
    const cachedToolResults = new Map<string, CachedToolResult>();
    const executedToolNames: string[] = [];
    let workspaceRevision = 0;
    let duplicateCallCount = 0;
    let toolCallCount = 0;
    let hadNoOpMutation = false;
    let lastResponseText = "";
    const workflow =
      this.options.enforceWorkflowCompletion === false
        ? { followUp: () => undefined }
        : createWorkflowState(messages);

    for (let step = 0; step < this.maxSteps; step += 1) {
      await this.compactContextIfNecessary(messages, "token_threshold");

      const response = await this.requestModelWithContextRecovery(messages);
      messages.push(response.message);
      lastResponseText = response.text;

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
        toolCallCount += 1;
        if (toolCallCount > this.maxToolCalls) {
          const text = `The run was stopped after reaching the ${this.maxToolCalls}-tool-call safety limit.`;
          await this.emit({ type: "agent_safety_limit", text });
          return { text, messages };
        }
        if (this.options.signal?.aborted) {
          throw new Error("Agent run cancelled.");
        }
        const toolSpanId = randomUUID();
        await this.emit({
          type: "tool_requested",
          spanId: toolSpanId,
          parentSpanId: this.currentModelCallId,
          call,
        });
        const signature = JSON.stringify([call.name, call.arguments]);
        const cached = cachedToolResults.get(signature);
        if (cached?.workspaceRevision === workspaceRevision) {
          duplicateCallCount += 1;
          const result: ToolResult = {
            output:
              `Duplicate ${call.name} call skipped because the workspace has not changed. ` +
              "Use the earlier tool result already present in the conversation and continue the task without calling it again.",
          };
          await this.emit({
            type: "tool_completed",
            spanId: toolSpanId,
            parentSpanId: this.currentModelCallId,
            call,
            result,
          });
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
        if (!result.isError) executedToolNames.push(call.name);
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
        await this.emit({
          type: "tool_completed",
          spanId: toolSpanId,
          parentSpanId: this.currentModelCallId,
          call,
          result,
        });
        messages.push(this.toToolMessage(call, result));
      }
    }

    const text = lastResponseText
      ? `${lastResponseText}\n\n[Agent stopped after reaching the ${this.maxSteps}-step safety limit.]`
      : `[Agent stopped after reaching the ${this.maxSteps}-step safety limit. Tools executed: ${executedToolNames.join(", ") || "none"}]`;
    await this.emit({ type: "agent_safety_limit", text });
    return { text, messages };
  }

  private async requestModelWithContextRecovery(
    messages: ConversationMessage[],
  ): Promise<ModelResponse> {
    const options = this.compactionOptions();
    for (let attempt = 0; ; attempt += 1) {
      const request = this.createModelRequest(messages);
      const callId = randomUUID();
      const startedAt = Date.now();
      this.options.beforeModelRequest?.();
      await this.emit({
        type: "model_request",
        callId,
        messageCount: messages.length,
        toolCount: request.tools.length,
        request: { messages: request.messages, tools: request.tools },
      });
      try {
        const response = await this.model.respond(request);
        this.currentModelCallId = callId;
        await this.emit({
          type: "model_response",
          callId,
          text: response.text,
          toolCallCount: response.toolCalls.length,
          response,
          durationMs: Date.now() - startedAt,
        });
        return response;
      } catch (error) {
        if (
          classifyModelError(error).code !== "context_length" ||
          attempt >= options.maxRecoveryAttempts
        ) {
          throw error;
        }
        const estimate = this.estimateRequest(request);
        const targetTokens = Math.floor(
          (estimate.contextWindowTokens - estimate.reservedOutputTokens) *
            options.recoveryTargetRatio,
        );
        await this.emit({
          type: "context_limit_recovery",
          attempt: attempt + 1,
          estimatedTokens: estimate.inputTokens,
          targetTokens,
        });
        const compacted = await this.compactContextIfNecessary(
          messages,
          "context_limit",
        );
        if (!compacted) throw error;
      }
    }
  }

  private async compactContextIfNecessary(
    messages: ConversationMessage[],
    reason: ContextCompactionCheckpoint["reason"],
  ): Promise<boolean> {
    if (this.options.compaction === false) return false;
    const options = this.compactionOptions();
    const initialRequest = this.createModelRequest(messages);
    const initialEstimate = this.estimateRequest(initialRequest);
    const usableTokens =
      initialEstimate.contextWindowTokens -
      initialEstimate.reservedOutputTokens;
    const triggerTokens = Math.floor(usableTokens * options.triggerRatio);
    const targetTokens = Math.floor(
      usableTokens *
        (reason === "context_limit"
          ? options.recoveryTargetRatio
          : options.targetRatio),
    );
    if (
      reason === "token_threshold" &&
      initialEstimate.inputTokens < triggerTokens
    ) {
      return false;
    }

    await this.pruneReadFileResults(messages);
    const tokensAfterPruning = this.estimateRequest(
      this.createModelRequest(messages),
    ).inputTokens;
    let changed = tokensAfterPruning < initialEstimate.inputTokens;
    let previousTokens = tokensAfterPruning;
    for (let pass = 1; pass <= options.maxPasses; pass += 1) {
      const currentTokens = this.estimateRequest(
        this.createModelRequest(messages),
      ).inputTokens;
      if (currentTokens <= targetTokens && changed) return true;
      const checkpoint = this.compactOldestExchanges(
        messages,
        reason,
        pass,
        currentTokens,
        options.minimumRecentExchanges,
      );
      if (!checkpoint) break;
      if (checkpoint.estimatedTokensAfter >= previousTokens) break;
      changed = true;
      previousTokens = checkpoint.estimatedTokensAfter;
      await this.emit({
        type: "context_compacted",
        summary: JSON.stringify(checkpoint.state),
        checkpoint,
      });
      if (checkpoint.estimatedTokensAfter <= targetTokens) break;
    }
    return changed;
  }

  private compactOldestExchanges(
    messages: ConversationMessage[],
    reason: ContextCompactionCheckpoint["reason"],
    pass: number,
    estimatedTokensBefore: number,
    minimumRecentExchanges: number,
  ): ContextCompactionCheckpoint | undefined {
    const instructions = messages.filter(
      (message): message is SystemMessage =>
        message.role === "system" && message.kind !== "compaction",
    );
    const existing = messages.find(
      (message): message is SystemMessage =>
        message.role === "system" && message.kind === "compaction",
    );
    const conversation = messages.filter(
      (message) => message.role !== "system",
    );
    const exchanges = groupConversationExchanges(conversation);
    const lastUserIndex = lastUserExchangeIndex(exchanges);
    const recentStart = Math.max(0, exchanges.length - minimumRecentExchanges);
    const compactable = exchanges.filter(
      (_exchange, index) => index !== lastUserIndex && index < recentStart,
    );
    if (compactable.length === 0) return undefined;
    const selectedExchangeCount = Math.max(
      1,
      Math.ceil(compactable.length / 2),
    );
    const selected = compactable.slice(0, selectedExchangeCount).flat();
    const selectedSet = new Set(selected);
    const keptConversation = conversation.filter(
      (message) => !selectedSet.has(message),
    );
    const state = buildCompactedTaskState(
      parseCompactedTaskState(existing?.content),
      instructions,
      selected,
      conversation,
    );
    const summaryMessage: SystemMessage = {
      role: "system",
      kind: "compaction",
      content: `[Structured compact task state]\n${JSON.stringify(state)}`,
    };
    const nextMessages: ConversationMessage[] = [
      ...instructions,
      summaryMessage,
      ...keptConversation,
    ];
    const estimatedTokensAfter = this.estimateRequest(
      this.createModelRequest(nextMessages),
    ).inputTokens;
    if (estimatedTokensAfter >= estimatedTokensBefore) return undefined;
    messages.length = 0;
    messages.push(...nextMessages);
    return {
      version: 1,
      reason,
      pass,
      estimatedTokensBefore,
      estimatedTokensAfter,
      compactedMessageCount: selected.length,
      state,
      createdAt: Date.now(),
    };
  }

  private async pruneReadFileResults(
    messages: ConversationMessage[],
  ): Promise<void> {
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
        // Structured exchange compaction remains available without Rust.
      }
    }
  }

  private createModelRequest(
    messages: readonly ConversationMessage[],
  ): ModelRequest {
    return {
      messages,
      tools: this.tools.list(),
      signal: this.options.signal,
    };
  }

  private estimateRequest(request: ModelRequest): RequiredModelContextEstimate {
    const options = this.compactionOptions();
    const modelEstimate = this.model.estimateContext?.(request);
    return {
      inputTokens:
        modelEstimate?.inputTokens ?? estimateModelRequestTokens(request),
      contextWindowTokens:
        modelEstimate?.contextWindowTokens ??
        options.fallbackContextWindowTokens,
      reservedOutputTokens:
        modelEstimate?.reservedOutputTokens ?? options.reservedOutputTokens,
    };
  }

  private compactionOptions(): Required<ContextCompactionOptions> {
    const configured = this.options.compaction || {};
    return {
      triggerRatio: configured.triggerRatio ?? 0.75,
      targetRatio: configured.targetRatio ?? 0.6,
      recoveryTargetRatio: configured.recoveryTargetRatio ?? 0.45,
      maxPasses: configured.maxPasses ?? 4,
      maxRecoveryAttempts: configured.maxRecoveryAttempts ?? 2,
      minimumRecentExchanges: configured.minimumRecentExchanges ?? 2,
      fallbackContextWindowTokens:
        configured.fallbackContextWindowTokens ?? 8192,
      reservedOutputTokens: configured.reservedOutputTokens ?? 1024,
    };
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

    let approval: ToolExecutionContext["approval"];
    if (tool.approval !== "auto") {
      const previewContext: ToolPreviewContext = { cwd: this.options.cwd };
      let preview: ToolPreview | undefined;
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

      const response = await this.options.requestApproval(call, preview);
      if (response === false) {
        return { output: "Tool execution denied by the user.", isError: true };
      }
      let decision: ApprovalDecision;
      try {
        decision = normalizeApprovalDecision(response, preview);
      } catch (error) {
        return {
          output: `Invalid approval decision: ${error instanceof Error ? error.message : String(error)}`,
          isError: true,
        };
      }
      if (
        preview &&
        typeof preview !== "string" &&
        preview.hunks.length > 0 &&
        decision.acceptedHunkIds.length === 0
      ) {
        return {
          output: formatRejectedHunks(preview.hunks),
          isError: true,
          changed: false,
          review: {
            acceptedHunkIds: [],
            rejectedHunks: preview.hunks,
          },
        };
      }
      approval = preview ? { preview, decision } : undefined;
    } else {
      await this.emit({ type: "tool_auto_approved", call });
    }

    const context: ToolExecutionContext = {
      cwd: this.options.cwd,
      signal: this.options.signal ?? new AbortController().signal,
      requestApproval: async () => true,
      approval,
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
    const review = result.review
      ? `\n\n[Human review]\nAccepted hunks: ${result.review.acceptedHunkIds.join(", ") || "none"}\n${formatRejectedHunks(result.review.rejectedHunks)}`
      : "";

    return {
      role: "tool",
      toolCallId: call.id,
      toolName: call.name,
      content: `${result.output}${suffix}${review}`,
      metadata:
        result.changedFiles || result.contextArtifacts
          ? {
              changedFiles: result.changedFiles,
              contextArtifacts: result.contextArtifacts,
            }
          : undefined,
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

interface RequiredModelContextEstimate {
  inputTokens: number;
  contextWindowTokens: number;
  reservedOutputTokens: number;
}

function groupConversationExchanges(
  messages: readonly ConversationMessage[],
): ConversationMessage[][] {
  const exchanges: ConversationMessage[][] = [];
  for (let index = 0; index < messages.length; index += 1) {
    const message = messages[index];
    if (!message) continue;
    const exchange = [message];
    if (message.role === "assistant" && message.toolCalls?.length) {
      const callIds = new Set(message.toolCalls.map((call) => call.id));
      while (true) {
        const result = messages[index + 1];
        if (result?.role !== "tool" || !callIds.has(result.toolCallId)) {
          break;
        }
        exchange.push(result);
        index += 1;
      }
    }
    exchanges.push(exchange);
  }
  return exchanges;
}

function lastUserExchangeIndex(
  exchanges: readonly ConversationMessage[][],
): number {
  for (let index = exchanges.length - 1; index >= 0; index -= 1) {
    if (exchanges[index]?.some((message) => message.role === "user")) {
      return index;
    }
  }
  return -1;
}

function parseCompactedTaskState(
  content: string | undefined,
): CompactedTaskState | undefined {
  if (!content) return undefined;
  const start = content.indexOf("{");
  if (start < 0) return undefined;
  try {
    const value = JSON.parse(
      content.slice(start),
    ) as Partial<CompactedTaskState>;
    return value.version === 1 && typeof value.objective === "string"
      ? {
          version: 1,
          objective: value.objective,
          plan: stringArray(value.plan),
          completedWork: stringArray(value.completedWork),
          failures: stringArray(value.failures),
          changedFiles: Array.isArray(value.changedFiles)
            ? value.changedFiles.filter(
                (file): file is { path: string; hash?: string } =>
                  typeof file === "object" &&
                  file !== null &&
                  "path" in file &&
                  typeof file.path === "string",
              )
            : [],
          verificationStatus: stringArray(value.verificationStatus),
          retrievedSlices: stringArray(value.retrievedSlices),
          projectRules: stringArray(value.projectRules),
          openQuestions: stringArray(value.openQuestions),
        }
      : undefined;
  } catch {
    return undefined;
  }
}

function buildCompactedTaskState(
  existing: CompactedTaskState | undefined,
  instructions: readonly SystemMessage[],
  selected: readonly ConversationMessage[],
  conversation: readonly ConversationMessage[],
): CompactedTaskState {
  const latestObjective = [...conversation]
    .reverse()
    .find((message) => message.role === "user")?.content;
  const state: CompactedTaskState = existing
    ? structuredClone(existing)
    : {
        version: 1,
        objective: latestObjective ? bounded(latestObjective, 4000) : "",
        plan: [],
        completedWork: [],
        failures: [],
        changedFiles: [],
        verificationStatus: [],
        retrievedSlices: [],
        projectRules: [],
        openQuestions: [],
      };
  if (latestObjective) state.objective = bounded(latestObjective, 4000);
  for (const instruction of instructions) {
    addUnique(state.projectRules, bounded(instruction.content, 1600), 8);
  }
  for (const message of selected) {
    const content = bounded(message.content, 1600);
    if (/\b(plan|step|todo)\b/i.test(content))
      addUnique(state.plan, content, 10);
    if (/\b(error|failed|failure|denied|timeout)\b/i.test(content)) {
      addUnique(state.failures, content, 10);
    }
    if (/\b(verified|verification|passed|test|build|lint)\b/i.test(content)) {
      addUnique(state.verificationStatus, content, 10);
    }
    if (message.role === "assistant" && content.trim().endsWith("?")) {
      addUnique(state.openQuestions, content, 8);
    }
    if (message.role === "assistant" && content.trim()) {
      addUnique(state.completedWork, content, 12);
    }
    if (message.role === "tool") {
      if (/Rejected hunks/i.test(content)) {
        addUnique(state.failures, content, 10);
      }
      for (const file of message.metadata?.changedFiles ?? []) {
        const existingFile = state.changedFiles.find(
          (item) => item.path === file.path,
        );
        if (existingFile) existingFile.hash = file.hash;
        else state.changedFiles.push(file);
        state.changedFiles = state.changedFiles.slice(-20);
      }
      if (message.toolName === "retrieve_context") {
        addUnique(state.retrievedSlices, content, 12);
      }
      const file = parseFileIdentity(message.content);
      if (file && !state.changedFiles.some((item) => item.path === file.path)) {
        state.changedFiles.push(file);
        state.changedFiles = state.changedFiles.slice(-20);
      }
    }
  }
  return state;
}

function parseFileIdentity(
  content: string,
): { path: string; hash?: string } | undefined {
  try {
    const value = JSON.parse(content) as Record<string, unknown>;
    if (typeof value.path !== "string") return undefined;
    return {
      path: value.path,
      hash: typeof value.hash === "string" ? value.hash : undefined,
    };
  } catch {
    return undefined;
  }
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
}

function addUnique(values: string[], value: string, limit: number): void {
  if (!value || values.includes(value)) return;
  values.push(value);
  if (values.length > limit) values.splice(0, values.length - limit);
}

function bounded(value: string, length: number): string {
  return value.length <= length
    ? value
    : `${value.slice(0, length)}\n[truncated]`;
}

function normalizeApprovalDecision(
  response: ToolApprovalResponse,
  preview: ToolPreview | undefined,
): ApprovalDecision {
  if (typeof response === "boolean") {
    const ids = isFileDiffPreview(preview)
      ? preview.hunks.map((hunk) => hunk.id)
      : [];
    return response
      ? { acceptedHunkIds: ids, rejectedHunkIds: [] }
      : { acceptedHunkIds: [], rejectedHunkIds: ids };
  }
  if (!isFileDiffPreview(preview)) {
    throw new Error("Block decisions require a structured file diff preview.");
  }
  const available = new Set(preview.hunks.map((hunk) => hunk.id));
  const accepted = new Set(response.acceptedHunkIds);
  const rejected = new Set(response.rejectedHunkIds);
  if (
    accepted.size !== response.acceptedHunkIds.length ||
    rejected.size !== response.rejectedHunkIds.length
  ) {
    throw new Error("Hunk IDs must not be duplicated.");
  }
  for (const id of accepted) {
    if (!available.has(id) || rejected.has(id)) {
      throw new Error(`Invalid accepted hunk ID: ${id}`);
    }
  }
  for (const id of rejected) {
    if (!available.has(id)) throw new Error(`Invalid rejected hunk ID: ${id}`);
  }
  if (accepted.size + rejected.size !== available.size) {
    throw new Error("Every proposed hunk must be accepted or rejected.");
  }
  return {
    acceptedHunkIds: [...accepted],
    rejectedHunkIds: [...rejected],
  };
}

function isFileDiffPreview(
  preview: ToolPreview | undefined,
): preview is FileDiffPreview {
  return typeof preview === "object" && preview?.kind === "file_diff";
}

function formatRejectedHunks(
  hunks: readonly FileDiffPreview["hunks"][number][],
): string {
  if (hunks.length === 0) return "Rejected hunks: none";
  return [
    "Rejected hunks (continue without re-requesting these unchanged):",
    ...hunks.map(
      (hunk) =>
        `- ${hunk.id} ${hunk.path}:${hunk.startLine}-${hunk.endLine}\n${bounded(hunk.replacement, 800)}`,
    ),
  ].join("\n");
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

  const followUpCounts = new Map<string, number>();
  const boundedFollowUp = (
    phase: string,
    message: string,
  ): string | undefined => {
    const count = followUpCounts.get(phase) ?? 0;
    if (count >= 2) return undefined;
    followUpCounts.set(phase, count + 1);
    return message;
  };

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
        return boundedFollowUp(
          "patch",
          `The original user request is: ${request}\n\nYou have only read the file. The required next action is to call apply_patch, not to describe a command and not to ask for details. Respond with exactly one apply_patch tool call using the previous file content and the requested change. Do not call compile_code until apply_patch has been approved and executed.`,
        );
      }
      if (requestsMutation && mutationIndex < 0) {
        return boundedFollowUp(
          "mutation",
          `The original user request is: ${request}\n\nThe requested file mutation has not happened. Do not answer with prose, Markdown code fences, [TOOL_CALLS], or questions. Call the appropriate file mutation tool now. If native tool calling is unavailable, output only this JSON shape with real values: {"name":"create_file","arguments":{"path":"workspace-relative-name.ext","content":"complete file content"}}`,
        );
      }
      if (
        requestsReadAfterMutation &&
        !hasReadAfterMutation &&
        !hadNoOpMutation
      ) {
        return boundedFollowUp(
          "read-after-mutation",
          `The patch has already been approved and applied. Do not ask for approval again and do not answer with a diff. Call read_file now for the changed file to verify the edit, then continue with the remaining requested steps from the original request: ${request}`,
        );
      }
      if (requestsVerification && !hasVerification) {
        return boundedFollowUp(
          "verification",
          `The requested edit and verification are not complete. Do not answer with prose or ask the user to run a command. Call the appropriate verification tool now, then report its actual result: ${request}`,
        );
      }
      return undefined;
    },
  };
}
