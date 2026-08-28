import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import { relative } from "node:path";
import {
  AgentRunner,
  MultiAgentOrchestrator,
  TaskOrchestrator,
  ToolRegistry,
  type AgentDefinition,
  type AgentWorkRequest,
  type AgentWorkResult,
  type AgentModelResolver,
  type AgentToolResolver,
  type ConversationMessage,
  type MultiAgentEvent,
  type MultiAgentResult,
  type OrchestrationEvent,
  type OrchestrationPlan,
  type ToolApprovalResponse,
  type ToolCall,
  type ToolPreview,
} from "@agentic-runtime/core";
import type { GatewayEvent } from "@agentic-runtime/gateway";
import type {
  RetrievalIndexReport,
  RetrievalQueryOptions,
  RetrievalQueryResult,
  SemanticRetrievalIndex,
} from "@agentic-runtime/retrieval";
import {
  createTaskCheckpointStore,
  SessionStore,
  type ContextItem,
  type SessionRecord,
  type TaskRecord,
  type TraceSpanRecord,
} from "@agentic-runtime/session";
import {
  WorkspaceFileService,
  type FileMutationRecord,
} from "@agentic-runtime/workspace";
import {
  DEFAULT_RUNTIME_LIMITS,
  type AddFileContextInput,
  type RemoveFileContextInput,
  type ResumeTaskInput,
  type RuntimeApprovalHandler,
  type RuntimeApprovalRequest,
  type RuntimeEvent,
  type RuntimeEventListener,
  type RuntimeFileContext,
  type RuntimeIsolatedQuestionHandle,
  type RuntimeIsolatedQuestionResult,
  type RuntimeLimits,
  type RuntimeModelSelection,
  type RuntimeSettingsStore,
  type RuntimeTaskHandle,
  type RuntimeTaskResult,
  type StartIsolatedQuestionInput,
  type StartTaskInput,
} from "./types.js";
import {
  CODING_AGENT_ID,
  DEFAULT_AGENT_ID,
  REVIEWER_AGENT_ID,
  VERIFIER_AGENT_ID,
} from "./default-agents.js";

export interface HeadlessRuntimeServiceOptions {
  store: SessionStore;
  model: RuntimeModelSelection;
  resolveModel: AgentModelResolver;
  resolveTools: AgentToolResolver;
  requestApproval: RuntimeApprovalHandler;
  retrieval?: SemanticRetrievalIndex;
  limits?: Partial<RuntimeLimits>;
}

interface RuntimeExecutionContext {
  sessionId: string;
  taskId: string;
  traceId: string;
  taskSpanId: string;
}

interface ActiveTask {
  controller: AbortController;
  completion?: Promise<unknown>;
}

interface WorkspaceRecoveryState {
  version: 1;
  cycle: number;
  phase:
    | "coding"
    | "rollback_pending"
    | "rolling_back"
    | "replanning"
    | "recoding"
    | "ready_to_verify"
    | "conflicted";
  verifierFailure?: string;
  mutations: FileMutationRecord[];
  rolledBack?: Array<{ path: string; status: string }>;
  revisedPlan?: string;
  correctiveResult?: string;
  untrackedSideEffects: string[];
}

export class HeadlessRuntimeService {
  readonly projectRoot: string;
  readonly model: RuntimeModelSelection;
  readonly limits: RuntimeLimits;
  readonly settings: RuntimeSettingsStore;

  private readonly store: SessionStore;
  private readonly resolveModel: AgentModelResolver;
  private readonly resolveTools: AgentToolResolver;
  private readonly requestApproval: RuntimeApprovalHandler;
  private readonly retrieval?: SemanticRetrievalIndex;
  private readonly listeners = new Set<RuntimeEventListener>();
  private readonly activeTasks = new Map<string, ActiveTask>();
  private readonly executionContext =
    new AsyncLocalStorage<RuntimeExecutionContext>();
  private readonly activeSessionIds = new Set<string>();
  private readonly activeAgentSpans = new Map<string, string>();
  private readonly activeStepSpans = new Map<string, string>();
  private readonly activeModelSpans = new Map<string, string>();
  private readonly activeRouteSpans = new Map<string, string>();
  private closed = false;
  private closePromise?: Promise<void>;

  constructor(options: HeadlessRuntimeServiceOptions) {
    this.store = options.store;
    this.projectRoot = options.store.project.rootPath;
    this.model = { ...options.model };
    this.resolveModel = options.resolveModel;
    this.resolveTools = options.resolveTools;
    this.requestApproval = options.requestApproval;
    this.retrieval = options.retrieval;
    this.limits = { ...DEFAULT_RUNTIME_LIMITS, ...options.limits };
    validateLimits(this.limits);
    this.settings = {
      getCredential: (providerId) => this.store.getCredential(providerId),
      setCredential: (providerId, value) =>
        this.store.setCredential(providerId, value),
      clearCredential: (providerId) => this.store.clearCredential(providerId),
      getProviderSetting: (providerId, key) =>
        this.store.getProviderSetting(providerId, key),
      setProviderSetting: (providerId, key, value) =>
        this.store.setProviderSetting(providerId, key, value),
      clearProviderSetting: (providerId, key) =>
        this.store.clearProviderSetting(providerId, key),
    };
  }

  subscribe(listener: RuntimeEventListener): () => void {
    this.ensureOpen();
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  createSession(title?: string): SessionRecord {
    this.ensureOpen();
    return this.store.createSession(title);
  }

  getSession(sessionId: string): SessionRecord | undefined {
    this.ensureOpen();
    return this.store.getSession(sessionId);
  }

  listSessions(): SessionRecord[] {
    this.ensureOpen();
    return this.store.listSessions();
  }

  clearSession(sessionId: string): SessionRecord {
    this.ensureOpen();
    this.requireSession(sessionId);
    if (this.activeSessionIds.has(sessionId)) {
      throw new Error(`Cannot clear active session: ${sessionId}`);
    }
    this.store.saveMessages(sessionId, []);
    return this.requireSession(sessionId);
  }

  listAgents(): AgentDefinition[] {
    this.ensureOpen();
    return this.store.listAgents();
  }

  getAgent(agentId: string): AgentDefinition | undefined {
    this.ensureOpen();
    return this.store.getAgent(agentId);
  }

  indexProject(): Promise<RetrievalIndexReport> {
    this.ensureOpen();
    if (!this.retrieval)
      throw new Error("Semantic retrieval is not configured.");
    return this.retrieval.indexProject();
  }

  retrieve(options: RetrievalQueryOptions): Promise<RetrievalQueryResult> {
    this.ensureOpen();
    if (!this.retrieval)
      throw new Error("Semantic retrieval is not configured.");
    return this.retrieval.query(options);
  }

  async addFileContext(
    input: AddFileContextInput,
  ): Promise<RuntimeFileContext> {
    this.ensureOpen();
    this.requireSession(input.sessionId);
    const file = await new WorkspaceFileService(this.projectRoot).readText(
      input.path,
    );
    const range = normalizeContextRange(input.range, file.content);
    const content = range
      ? sliceLineRange(file.content, range.startLine, range.endLine)
      : file.content;
    const existing = this.listFileContext(input.sessionId).find(
      (item) =>
        item.path === file.path &&
        item.startLine === range?.startLine &&
        item.endLine === range?.endLine,
    );
    if (existing) return existing;
    const used = this.listFileContext(input.sessionId).reduce(
      (sum, item) => sum + item.content.length,
      0,
    );
    if (used + content.length > this.limits.contextCharacterBudget) {
      throw new Error(
        `Manual context exceeds the ${this.limits.contextCharacterBudget}-character budget. Select a smaller line range.`,
      );
    }
    const label = range
      ? `${file.path}:${range.startLine}-${range.endLine}`
      : file.path;
    const item = this.store.addContextItem({
      sessionId: input.sessionId,
      source: "file",
      content: `[File context: ${label}]\n${content}`,
      filePath: file.path,
      startLine: range?.startLine,
      endLine: range?.endLine,
      priority: "high",
      pinned: true,
      tokenEstimate: Math.max(1, Math.ceil(content.length / 4)),
    });
    return contextItemToRuntime(item, content);
  }

  removeFileContext(input: RemoveFileContextInput): number {
    this.ensureOpen();
    this.requireSession(input.sessionId);
    const normalizedPath = new WorkspaceFileService(
      this.projectRoot,
    ).resolvePath(input.path);
    const relativePath = normalizeWorkspaceRelativePath(
      this.projectRoot,
      normalizedPath,
    );
    const matches = this.listFileContext(input.sessionId).filter(
      (item) =>
        item.path === relativePath &&
        (!input.range ||
          (item.startLine === input.range.startLine &&
            item.endLine === input.range.endLine)),
    );
    return matches.reduce(
      (count, item) =>
        count +
        (this.store.removeContextItem(input.sessionId, item.id) ? 1 : 0),
      0,
    );
  }

  listFileContext(sessionId: string): RuntimeFileContext[] {
    this.ensureOpen();
    this.requireSession(sessionId);
    return this.store
      .listContextItems(sessionId, undefined)
      .filter(
        (item) =>
          item.source === "file" &&
          item.sessionId === sessionId &&
          item.taskId === undefined &&
          item.filePath,
      )
      .map((item) =>
        contextItemToRuntime(item, stripContextHeader(item.content)),
      )
      .sort(
        (left, right) =>
          left.path.localeCompare(right.path) ||
          (left.startLine ?? 0) - (right.startLine ?? 0),
      );
  }

  listTraceSpans(taskId: string): TraceSpanRecord[] {
    this.ensureOpen();
    const task = this.store.getTask(taskId);
    if (!task) throw new Error(`Task not found: ${taskId}`);
    return this.store.listTraceSpans(taskId);
  }

  startIsolatedQuestion(
    input: StartIsolatedQuestionInput,
  ): RuntimeIsolatedQuestionHandle {
    this.ensureOpen();
    const prompt = input.prompt.trim();
    if (!prompt) throw new Error("An isolated question is required.");
    const session = this.requireSession(input.sessionId);
    const agent = this.store.getAgent(input.agentId);
    if (!agent?.enabled)
      throw new Error(`Enabled agent not found: ${input.agentId}`);
    if (this.activeSessionIds.has(session.id)) {
      throw new Error(`Session already has an active operation: ${session.id}`);
    }
    const controller = new AbortController();
    const operationId = `isolated:${randomUUID()}`;
    const active: ActiveTask = { controller };
    this.activeSessionIds.add(session.id);
    this.activeTasks.set(operationId, active);
    const completion = this.executeIsolatedQuestion(
      session,
      agent,
      prompt,
      controller.signal,
    ).finally(() => {
      this.activeTasks.delete(operationId);
      this.activeSessionIds.delete(session.id);
    });
    active.completion = completion;
    return {
      sessionId: session.id,
      completion,
      cancel: () => controller.abort(),
    };
  }

  runIsolatedQuestion(
    input: StartIsolatedQuestionInput,
  ): Promise<RuntimeIsolatedQuestionResult> {
    return this.startIsolatedQuestion(input).completion;
  }

  startTask(input: StartTaskInput): RuntimeTaskHandle {
    this.ensureOpen();
    const prompt = input.prompt.trim();
    if (!prompt) throw new Error("A task prompt is required.");
    const session = this.requireSession(input.sessionId);
    const agent = this.store.getAgent(input.agentId);
    if (!agent) throw new Error(`Agent not found: ${input.agentId}`);
    if (!agent.enabled) throw new Error(`Agent is disabled: ${input.agentId}`);
    if (this.activeSessionIds.has(session.id)) {
      throw new Error(`Session already has an active task: ${session.id}`);
    }

    const task = this.store.createTask(session.id, prompt);
    const state = { ...task.state, agentId: agent.id };
    this.store.updateTask(task.id, { state });
    return this.launchTask(session, { ...task, state }, agent.id);
  }

  runTask(input: StartTaskInput): Promise<RuntimeTaskResult> {
    return this.startTask(input).completion;
  }

  resumeTask(input: ResumeTaskInput): RuntimeTaskHandle {
    this.ensureOpen();
    const task = this.store.getTask(input.taskId);
    if (!task) throw new Error(`Task not found: ${input.taskId}`);
    if (task.status === "completed") {
      throw new Error(`Task is already completed: ${input.taskId}`);
    }
    const session = this.requireSession(task.sessionId);
    const persistedAgentId =
      typeof task.state.agentId === "string" ? task.state.agentId : undefined;
    const agentId = input.agentId ?? persistedAgentId ?? DEFAULT_AGENT_ID;
    const agent = this.store.getAgent(agentId);
    if (!agent?.enabled) throw new Error(`Enabled agent not found: ${agentId}`);
    return this.launchTask(session, task, agentId);
  }

  private launchTask(
    session: SessionRecord,
    task: TaskRecord,
    agentId: string,
  ): RuntimeTaskHandle {
    if (this.activeSessionIds.has(session.id)) {
      throw new Error(`Session already has an active task: ${session.id}`);
    }
    const controller = new AbortController();
    const activeTask: ActiveTask = { controller };
    this.activeSessionIds.add(session.id);
    this.activeTasks.set(task.id, activeTask);
    const taskSpanId = randomUUID();
    this.startTraceSpan({
      sessionId: session.id,
      taskId: task.id,
      traceId: task.id,
      spanId: taskSpanId,
      kind: "task",
      name: task.prompt,
      input: { prompt: task.prompt, agentId },
      context: this.store.listContextItems(session.id, task.id),
    });
    const completion = this.executionContext.run(
      {
        sessionId: session.id,
        taskId: task.id,
        traceId: task.id,
        taskSpanId,
      },
      () => this.executeTask(session, task, agentId, controller.signal),
    );
    activeTask.completion = completion;
    return {
      sessionId: session.id,
      taskId: task.id,
      completion,
      cancel: () => controller.abort(),
    };
  }

  recordGatewayEvent(event: GatewayEvent): void {
    const context = this.executionContext.getStore();
    if (!context) return;
    const modelParent = this.activeModelSpans.get(context.taskId);
    if (event.type === "routing_attempt_started") {
      const spanId = randomUUID();
      const key = routeTraceKey(context.taskId, modelParent, event);
      this.activeRouteSpans.set(key, spanId);
      this.startTraceSpan({
        sessionId: context.sessionId,
        taskId: context.taskId,
        traceId: context.traceId,
        spanId,
        parentSpanId: modelParent ?? context.taskSpanId,
        kind: "provider_attempt",
        name: `${event.providerId}/${event.modelId ?? "unknown"}`,
        providerId: event.providerId,
        modelId: event.modelId,
        input: event,
      });
    } else if (
      event.type === "routing_attempt_completed" ||
      event.type === "routing_attempt_failed"
    ) {
      const key = routeTraceKey(context.taskId, modelParent, event);
      const spanId = this.activeRouteSpans.get(key);
      if (spanId) {
        this.finishTraceSpan(context.traceId, spanId, {
          status:
            event.type === "routing_attempt_completed" ? "completed" : "failed",
          output: event,
          providerId: event.providerId,
          modelId: event.modelId,
          cost:
            typeof event.estimatedCost === "number"
              ? event.estimatedCost
              : undefined,
          error:
            event.type === "routing_attempt_failed"
              ? event.failure?.code
              : undefined,
        });
        this.activeRouteSpans.delete(key);
      }
    }
    this.store.appendEvent({
      sessionId: context.sessionId,
      taskId: context.taskId,
      type: `gateway_${event.type}`,
      payload: { event },
    });
    void this.emit({
      type: "routing_event",
      sessionId: context.sessionId,
      taskId: context.taskId,
      event,
      occurredAt: Date.now(),
    });
  }

  close(): Promise<void> {
    if (this.closePromise) return this.closePromise;
    this.closed = true;
    this.closePromise = this.closeOwnedResources();
    return this.closePromise;
  }

  private async executeIsolatedQuestion(
    session: SessionRecord,
    agent: AgentDefinition,
    prompt: string,
    signal: AbortSignal,
  ): Promise<RuntimeIsolatedQuestionResult> {
    const traceId = `isolated:${randomUUID()}`;
    const spanId = randomUUID();
    this.startTraceSpan({
      sessionId: session.id,
      traceId,
      spanId,
      kind: "isolated_question",
      name: "/bytheway",
      input: { prompt, agentId: agent.id },
    });
    await this.emit({
      type: "isolated_started",
      sessionId: session.id,
      agentId: agent.id,
      prompt,
      occurredAt: Date.now(),
    });
    try {
      const model = await this.resolveModel(agent);
      const result = await new AgentRunner(model, new ToolRegistry(), {
        cwd: this.projectRoot,
        maxSteps: 1,
        signal,
        compaction: false,
        enforceWorkflowCompletion: false,
        requestApproval: async () => {
          throw new Error("Isolated questions cannot request tool approval.");
        },
      }).run([{ role: "user", content: prompt }]);
      const output = {
        sessionId: session.id,
        agentId: agent.id,
        text: result.text,
      };
      this.finishTraceSpan(traceId, spanId, {
        status: "completed",
        output,
      });
      await this.emit({
        type: "isolated_completed",
        sessionId: session.id,
        agentId: agent.id,
        text: result.text,
        occurredAt: Date.now(),
      });
      return output;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.finishTraceSpan(traceId, spanId, {
        status: signal.aborted ? "cancelled" : "failed",
        error: message,
      });
      await this.emit({
        type: "isolated_failed",
        sessionId: session.id,
        agentId: agent.id,
        error: message,
        occurredAt: Date.now(),
      });
      throw error;
    }
  }

  private async executeTask(
    session: SessionRecord,
    task: TaskRecord,
    agentId: string,
    signal: AbortSignal,
  ): Promise<RuntimeTaskResult> {
    let runId = "";
    const traceContext = this.executionContext.getStore();
    try {
      this.store.updateSession(session.id, { status: "running" });
      this.store.updateTask(task.id, {
        status: "running",
        currentStage: "agent",
      });
      this.store.appendEvent({
        sessionId: session.id,
        taskId: task.id,
        type: "task_started",
        payload: { prompt: task.prompt, agentId },
      });
      await this.emit({
        type: "task_started",
        sessionId: session.id,
        taskId: task.id,
        agentId,
        prompt: task.prompt,
        maxModelSteps: this.limits.maxModelSteps,
        occurredAt: Date.now(),
      });

      const history = session.messages.filter(isSessionHistoryMessage);
      const context = this.store.buildContext(
        session.id,
        task.id,
        this.limits.contextCharacterBudget,
      );
      const verificationOnly = shouldUseVerificationOnly(agentId, task.prompt);
      const result = verificationOnly
        ? await this.executeAgent(
            session.id,
            task.id,
            VERIFIER_AGENT_ID,
            task.prompt,
            context,
            history,
            signal,
            false,
            undefined,
            false,
          )
        : this.retrieval && shouldUsePipeline(agentId, task.prompt)
          ? await this.executePipeline(session, task, context, history, signal)
          : await this.executeAgent(
              session.id,
              task.id,
              agentId,
              task.prompt,
              context,
              history,
              signal,
              true,
            );
      runId = result.runId;
      const messages =
        result.status === "paused"
          ? [...history]
          : transcriptMessages(result.messages, history, task, result.text);
      this.store.saveMessages(session.id, messages);

      const runtimeResult: RuntimeTaskResult = {
        sessionId: session.id,
        taskId: task.id,
        runId: result.runId,
        agentId: result.agentId,
        status: result.status,
        text: result.text,
        handoffs: result.handoffs,
        messages,
      };

      if (result.status === "completed") {
        this.store.updateTask(task.id, {
          status: "completed",
          currentStage: "completed",
          state: {
            ...(this.store.getTask(task.id)?.state ?? task.state),
            result: result.text,
          },
        });
        this.store.appendEvent({
          sessionId: session.id,
          taskId: task.id,
          runId: result.runId,
          type: "task_completed",
          payload: { text: result.text },
        });
        await this.emit({
          type: "task_completed",
          sessionId: session.id,
          taskId: task.id,
          result: runtimeResult,
          occurredAt: Date.now(),
        });
      } else if (result.status === "paused") {
        this.store.updateTask(task.id, {
          status: "paused",
          currentStage: "paused",
          state: {
            ...(this.store.getTask(task.id)?.state ?? task.state),
            pauseReason: result.text,
          },
        });
        this.store.appendEvent({
          sessionId: session.id,
          taskId: task.id,
          runId: result.runId,
          type: "task_paused",
          payload: { reason: result.text },
        });
        await this.emit({
          type: "task_paused",
          sessionId: session.id,
          taskId: task.id,
          result: runtimeResult,
          occurredAt: Date.now(),
        });
      } else {
        this.store.updateTask(task.id, {
          status: "failed",
          currentStage: "failed",
          state: {
            ...(this.store.getTask(task.id)?.state ?? task.state),
            errors: [result.text],
          },
        });
        this.store.appendEvent({
          sessionId: session.id,
          taskId: task.id,
          runId: result.runId,
          type: "task_failed",
          payload: { error: result.text },
        });
        await this.emit({
          type: "task_failed",
          sessionId: session.id,
          taskId: task.id,
          error: result.text,
          result: runtimeResult,
          occurredAt: Date.now(),
        });
      }

      if (traceContext) {
        this.finishTraceSpan(traceContext.traceId, traceContext.taskSpanId, {
          status: runtimeResult.status,
          output: runtimeResult,
        });
      }
      return runtimeResult;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (signal.aborted) {
        const pausedResult: RuntimeTaskResult = {
          sessionId: session.id,
          taskId: task.id,
          runId: runId || task.id,
          agentId,
          status: "paused",
          text: message,
          handoffs: 0,
          messages: session.messages.filter(isSessionHistoryMessage),
        };
        this.store.updateTask(task.id, {
          status: "paused",
          currentStage: "paused",
          state: {
            ...(this.store.getTask(task.id)?.state ?? task.state),
            pauseReason: message,
          },
        });
        this.store.appendEvent({
          sessionId: session.id,
          taskId: task.id,
          runId: runId || undefined,
          type: "task_paused",
          payload: { reason: message },
        });
        if (traceContext) {
          this.finishTraceSpan(traceContext.traceId, traceContext.taskSpanId, {
            status: "cancelled",
            error: message,
          });
        }
        await this.emit({
          type: "task_paused",
          sessionId: session.id,
          taskId: task.id,
          result: pausedResult,
          occurredAt: Date.now(),
        });
        return pausedResult;
      }
      this.store.updateTask(task.id, {
        status: "failed",
        currentStage: "failed",
        state: {
          ...(this.store.getTask(task.id)?.state ?? task.state),
          errors: [message],
        },
      });
      this.store.appendEvent({
        sessionId: session.id,
        taskId: task.id,
        runId: runId || undefined,
        type: "task_failed",
        payload: { error: message },
      });
      if (traceContext) {
        this.finishTraceSpan(traceContext.traceId, traceContext.taskSpanId, {
          status: "failed",
          error: message,
        });
      }
      await this.emit({
        type: "task_failed",
        sessionId: session.id,
        taskId: task.id,
        error: message,
        occurredAt: Date.now(),
      });
      throw error;
    } finally {
      this.activeTasks.delete(task.id);
      this.activeSessionIds.delete(session.id);
      this.store.updateSession(session.id, { status: "idle" });
    }
  }

  private async executeAgent(
    sessionId: string,
    taskId: string,
    agentId: string,
    task: string,
    context: string,
    history: readonly ConversationMessage[],
    signal: AbortSignal,
    allowHandoffs: boolean,
    beforeModelRequest?: () => void,
    enforceWorkflowCompletion = allowHandoffs,
  ): Promise<MultiAgentResult> {
    let runId = "";
    let activeAgentId = agentId;
    const orchestrator = new MultiAgentOrchestrator(
      this.store,
      this.resolveModel,
      this.resolveTools,
      {
        cwd: this.projectRoot,
        maxDepth: this.limits.maxDepth,
        maxHandoffs: this.limits.maxHandoffs,
        maxHandoffsPerPair: this.limits.maxHandoffsPerPair,
        maxModelSteps: this.limits.maxModelSteps,
        maxToolCalls: this.limits.maxToolCalls,
        maxDurationMs: this.limits.maxDurationMs,
        allowHandoffs,
        enforceWorkflowCompletion,
        beforeModelRequest,
        signal,
        requestApproval: async (call, preview) => {
          const request = this.createApprovalRequest(
            sessionId,
            taskId,
            runId,
            activeAgentId,
            call,
            preview,
          );
          return this.handleApproval(request, signal);
        },
        onEvent: async (event) => {
          runId = event.runId;
          activeAgentId = event.agentId;
          await this.handleOrchestrationEvent(sessionId, taskId, event);
        },
      },
    );
    return orchestrator.run(agentId, task, context, history);
  }

  private async executePipeline(
    session: SessionRecord,
    task: TaskRecord,
    context: string,
    history: readonly ConversationMessage[],
    signal: AbortSignal,
  ): Promise<MultiAgentResult> {
    if (!this.retrieval)
      throw new Error("Semantic retrieval is not configured.");
    const plan: OrchestrationPlan = {
      objective: task.prompt,
      steps: [
        {
          id: "plan",
          role: "planner",
          title: "Plan",
          prompt:
            "Create a small, testable implementation plan for the objective.",
        },
        {
          id: "retrieve",
          role: "retriever",
          title: "Retrieve context",
          prompt: "Retrieve compact semantic context for the plan.",
          dependsOn: ["plan"],
        },
        {
          id: "code",
          role: "coder",
          title: "Implement",
          prompt: "Implement the plan using the retrieved evidence.",
          dependsOn: ["retrieve"],
        },
        {
          id: "verify",
          role: "verifier",
          title: "Verify",
          prompt:
            "Run relevant checks and report VERIFICATION_PASSED only when all checks pass.",
          dependsOn: ["code"],
        },
        {
          id: "review",
          role: "reviewer",
          title: "Review",
          prompt:
            "Review the plan, evidence, implementation, diff, and verification result.",
          dependsOn: ["verify"],
        },
      ],
    };
    const startedAt = Date.now();
    let modelSteps =
      typeof task.state.modelRequestsUsed === "number"
        ? task.state.modelRequestsUsed
        : 0;
    const consumeModelRequest = (): void => {
      if (signal.aborted) throw new Error("Pipeline was cancelled.");
      if (Date.now() - startedAt >= this.limits.maxDurationMs) {
        throw new Error("Pipeline exceeded its time budget.");
      }
      if (modelSteps >= this.limits.maxModelSteps) {
        throw new Error(
          `Pipeline exceeded its global ${this.limits.maxModelSteps}-model-step budget.`,
        );
      }
      modelSteps += 1;
      const currentTask = this.store.getTask(task.id);
      if (currentTask) {
        this.store.updateTask(task.id, {
          state: { ...currentTask.state, modelRequestsUsed: modelSteps },
        });
      }
    };
    const runAgentWorker =
      (
        agentId: string,
        includeHistory = false,
        enforceWorkflowCompletion = agentId === CODING_AGENT_ID,
      ) =>
      async (request: AgentWorkRequest): Promise<AgentWorkResult> => {
        const previous = request.previousResults
          .map((result) => `${result.role}: ${result.summary}`)
          .join("\n\n");
        const result = await this.executeAgent(
          session.id,
          task.id,
          agentId,
          `${request.step.prompt}\n\nObjective:\n${request.objective}`,
          [request.context, previous].filter(Boolean).join("\n\n"),
          includeHistory ? history : [],
          signal,
          false,
          consumeModelRequest,
          enforceWorkflowCompletion,
        );
        return {
          success: result.status === "completed",
          summary: result.text,
          output: result.text,
          progressKey:
            result.status === "failed"
              ? `${agentId}:${normalizeFailure(result.text)}`
              : undefined,
          passed:
            request.step.role === "verifier"
              ? /(?:^|\n)VERIFICATION_PASSED\s*$/u.test(result.text.trim())
              : undefined,
        };
      };
    const workers = {
      planner: runAgentWorker(DEFAULT_AGENT_ID, true),
      retriever: async (
        request: AgentWorkRequest,
      ): Promise<AgentWorkResult> => {
        const plannerOutput = request.previousResults.at(-1)?.summary ?? "";
        const retrieval = await this.retrieval!.query({
          query: `${request.objective}\n${plannerOutput}`,
          limit: 10,
          maxSliceLines: 40,
        });
        return {
          success: true,
          summary: JSON.stringify(retrieval),
          output: JSON.stringify(retrieval),
          progressKey: `retrieval:${retrieval.results.map((slice) => `${slice.path}:${slice.startLine}-${slice.endLine}`).join("|")}`,
        };
      },
      coder: runAgentWorker(CODING_AGENT_ID),
      verifier: runAgentWorker(VERIFIER_AGENT_ID),
      reviewer: runAgentWorker(REVIEWER_AGENT_ID),
    };
    const orchestrator = new TaskOrchestrator(workers, {
      maxAttemptsPerStep: 2,
      maxTotalAttempts: 10,
      maxDurationMs: this.limits.maxDurationMs,
      signal,
      checkpoint: createTaskCheckpointStore(this.store, task.id),
      recoverStep: async (request, failure) => {
        if (request.step.role !== "verifier") return undefined;
        return this.recoverVerifierFailure(
          session,
          task,
          request,
          failure,
          runAgentWorker,
        );
      },
      onEvent: (event) => this.handlePipelineEvent(session.id, task.id, event),
    });
    const state = await orchestrator.run(plan, context);
    const final =
      state.results.review ?? state.results.verify ?? state.results.code;
    const text =
      final?.summary ?? state.failure ?? "Pipeline produced no result.";
    return {
      runId: state.runId,
      agentId: REVIEWER_AGENT_ID,
      text,
      status:
        state.stage === "completed"
          ? "completed"
          : state.stage === "paused"
            ? "paused"
            : "failed",
      handoffs: 0,
      messages: [
        ...history,
        { role: "user", content: task.prompt },
        { role: "assistant", content: text },
      ],
    };
  }

  private async recoverVerifierFailure(
    session: SessionRecord,
    task: TaskRecord,
    request: AgentWorkRequest,
    failure: AgentWorkResult,
    runAgentWorker: (
      agentId: string,
      includeHistory?: boolean,
      enforceWorkflowCompletion?: boolean,
    ) => (request: AgentWorkRequest) => Promise<AgentWorkResult>,
  ): Promise<AgentWorkResult> {
    let recovery = this.getWorkspaceRecovery(task.id);
    if (recovery.phase === "ready_to_verify" && recovery.correctiveResult) {
      return { success: true, summary: recovery.correctiveResult };
    }
    recovery = {
      ...recovery,
      phase: "rollback_pending",
      verifierFailure: failure.summary,
    };
    this.saveWorkspaceRecovery(task.id, recovery);
    if (recovery.untrackedSideEffects.length > 0) {
      return {
        success: false,
        summary:
          "Automatic rollback is unsafe after command or external side effects: " +
          recovery.untrackedSideEffects.join(", "),
      };
    }

    recovery.phase = "rolling_back";
    this.saveWorkspaceRecovery(task.id, recovery);
    const workspace = new WorkspaceFileService(this.projectRoot);
    const rolledBack: Array<{ path: string; status: string }> = [];
    for (const mutation of [...recovery.mutations].reverse()) {
      const result = await workspace.rollbackMutation(mutation);
      rolledBack.push({ path: mutation.path, status: result.status });
      if (result.status === "conflict") {
        recovery = { ...recovery, phase: "conflicted", rolledBack };
        this.saveWorkspaceRecovery(task.id, recovery);
        return {
          success: false,
          summary: `Rollback conflict for ${mutation.path}; a later user edit was preserved and automatic replanning stopped.`,
        };
      }
    }

    recovery = {
      ...recovery,
      cycle: recovery.cycle + 1,
      phase: "replanning",
      rolledBack,
      mutations: [],
      untrackedSideEffects: [],
    };
    this.saveWorkspaceRecovery(task.id, recovery);
    await this.retrieval?.indexProject();
    const replanned = await runAgentWorker(
      DEFAULT_AGENT_ID,
      true,
    )({
      ...request,
      step: {
        id: `replan-${recovery.cycle}`,
        role: "planner",
        title: "Replan after verification failure",
        prompt:
          "Produce a materially revised plan after rollback. Do not repeat the failed approach. " +
          `Verifier evidence:\n${failure.summary}\nRollback report:\n${JSON.stringify(rolledBack)}`,
      },
    });
    if (!replanned.success) return replanned;
    const retrieved = await this.retrieval!.query({
      query: `${request.objective}\n${replanned.summary}\n${failure.summary}`,
      limit: 10,
      maxSliceLines: 40,
    });
    recovery = {
      ...this.getWorkspaceRecovery(task.id),
      phase: "recoding",
      revisedPlan: replanned.summary,
    };
    this.saveWorkspaceRecovery(task.id, recovery);
    const corrected = await runAgentWorker(
      CODING_AGENT_ID,
      false,
      false,
    )({
      ...request,
      context: [
        request.context,
        `Revised plan:\n${replanned.summary}`,
        `Fresh retrieval:\n${JSON.stringify(retrieved)}`,
        `Verifier failure:\n${failure.summary}`,
      ]
        .filter(Boolean)
        .join("\n\n"),
      step: {
        id: `code-recovery-${recovery.cycle}`,
        role: "coder",
        title: "Implement revised plan",
        prompt:
          "Implement the revised plan against the rolled-back workspace. All mutations require fresh approval.",
      },
    });
    if (!corrected.success) return corrected;
    recovery = {
      ...this.getWorkspaceRecovery(task.id),
      phase: "ready_to_verify",
      correctiveResult: corrected.summary,
    };
    this.saveWorkspaceRecovery(task.id, recovery);
    return corrected;
  }

  private getWorkspaceRecovery(taskId: string): WorkspaceRecoveryState {
    const task = this.store.getTask(taskId);
    const value = task?.state.workspaceRecovery;
    if (isWorkspaceRecoveryState(value)) return structuredClone(value);
    return {
      version: 1,
      cycle: 0,
      phase: "coding",
      mutations: [],
      untrackedSideEffects: [],
    };
  }

  private saveWorkspaceRecovery(
    taskId: string,
    recovery: WorkspaceRecoveryState,
  ): void {
    const task = this.store.getTask(taskId);
    if (!task) throw new Error(`Task not found: ${taskId}`);
    this.store.updateTask(taskId, {
      state: { ...task.state, workspaceRecovery: recovery },
    });
  }

  private recordWorkspaceMutation(
    taskId: string,
    mutation: FileMutationRecord,
  ): void {
    const recovery = this.getWorkspaceRecovery(taskId);
    if (recovery.mutations.some((item) => item.id === mutation.id)) return;
    const preimageBytes = recovery.mutations.reduce(
      (sum, item) => sum + (item.before?.content.length ?? 0),
      mutation.before?.content.length ?? 0,
    );
    if (recovery.mutations.length >= 10 || preimageBytes > 5_000_000) {
      if (!recovery.untrackedSideEffects.includes("rollback_journal_limit")) {
        recovery.untrackedSideEffects.push("rollback_journal_limit");
        this.saveWorkspaceRecovery(taskId, recovery);
      }
      return;
    }
    recovery.mutations.push(mutation);
    recovery.phase =
      recovery.phase === "ready_to_verify" ? "recoding" : recovery.phase;
    this.saveWorkspaceRecovery(taskId, recovery);
  }

  private async handlePipelineEvent(
    sessionId: string,
    taskId: string,
    event: OrchestrationEvent,
  ): Promise<void> {
    const trace = this.executionContext.getStore();
    const stepKey = `${taskId}:${event.type === "step_started" || event.type === "step_completed" || event.type === "step_retrying" || event.type === "step_recovering" ? event.stepId : "pipeline"}`;
    if (trace && event.type === "step_started") {
      const spanId = randomUUID();
      this.activeStepSpans.set(stepKey, spanId);
      this.startTraceSpan({
        sessionId,
        taskId,
        traceId: trace.traceId,
        spanId,
        parentSpanId: trace.taskSpanId,
        kind: "pipeline_step",
        name: `${event.role}:${event.stepId}`,
        stepId: event.stepId,
        input: event,
      });
    } else if (trace && event.type === "step_completed") {
      const spanId = this.activeStepSpans.get(stepKey);
      if (spanId) {
        this.finishTraceSpan(trace.traceId, spanId, {
          status: "completed",
          output: event,
          stepId: event.stepId,
        });
        this.activeStepSpans.delete(stepKey);
      }
    }
    this.store.appendEvent({
      sessionId,
      taskId,
      runId: event.runId,
      type: event.type,
      payload: { event },
    });
    await this.emit({
      type: "pipeline_event",
      sessionId,
      taskId,
      event,
      occurredAt: Date.now(),
    });
  }

  private createApprovalRequest(
    sessionId: string,
    taskId: string,
    runId: string,
    agentId: string,
    call: ToolCall,
    preview?: ToolPreview,
  ): RuntimeApprovalRequest {
    if (!runId) {
      throw new Error("Approval requested before the run was initialized.");
    }
    return {
      requestId: `${taskId}:${runId}:${call.id}`,
      sessionId,
      taskId,
      runId,
      agentId,
      call,
      preview,
    };
  }

  private async handleApproval(
    request: RuntimeApprovalRequest,
    signal: AbortSignal,
  ): Promise<ToolApprovalResponse> {
    this.store.appendEvent({
      sessionId: request.sessionId,
      taskId: request.taskId,
      runId: request.runId,
      type: "approval_requested",
      payload: {
        requestId: request.requestId,
        agentId: request.agentId,
        call: request.call,
        preview: request.preview,
      },
    });
    await this.emit({
      type: "approval_requested",
      sessionId: request.sessionId,
      taskId: request.taskId,
      request,
      occurredAt: Date.now(),
    });

    const decision = await waitForApproval(
      () => this.requestApproval(request),
      signal,
    );
    const approved =
      decision === true ||
      (typeof decision === "object" && decision.acceptedHunkIds.length > 0);
    this.store.appendEvent({
      sessionId: request.sessionId,
      taskId: request.taskId,
      runId: request.runId,
      type: "approval_resolved",
      payload: { requestId: request.requestId, approved, decision },
    });
    await this.emit({
      type: "approval_resolved",
      sessionId: request.sessionId,
      taskId: request.taskId,
      requestId: request.requestId,
      approved,
      decision,
      occurredAt: Date.now(),
    });
    return decision;
  }

  private async handleOrchestrationEvent(
    sessionId: string,
    taskId: string,
    event: MultiAgentEvent,
  ): Promise<void> {
    this.recordMultiAgentTrace(sessionId, taskId, event);
    if (event.type === "agent_event" && event.agentEvent) {
      if (
        event.agentEvent.type === "tool_completed" &&
        event.agentEvent.result.workspaceMutation
      ) {
        this.recordWorkspaceMutation(
          taskId,
          event.agentEvent.result.workspaceMutation as FileMutationRecord,
        );
      }
      if (
        event.agentId === CODING_AGENT_ID &&
        event.agentEvent.type === "tool_completed" &&
        !event.agentEvent.result.isError &&
        [
          "run_command",
          "git_add",
          "git_commit",
          "git_checkout",
          "git_push",
        ].includes(event.agentEvent.call.name)
      ) {
        const recovery = this.getWorkspaceRecovery(taskId);
        recovery.untrackedSideEffects.push(event.agentEvent.call.name);
        this.saveWorkspaceRecovery(taskId, recovery);
      }
      if (event.agentEvent.type === "context_compacted") {
        this.store.addContextItem({
          sessionId,
          taskId,
          source: "summary",
          content: JSON.stringify(event.agentEvent.checkpoint.state),
          priority: "critical",
          pinned: false,
          tokenEstimate: event.agentEvent.checkpoint.estimatedTokensAfter,
        });
        const currentTask = this.store.getTask(taskId);
        if (currentTask) {
          this.store.updateTask(taskId, {
            state: {
              ...currentTask.state,
              contextCompaction: event.agentEvent.checkpoint,
            },
          });
        }
      }
      this.store.appendEvent({
        sessionId,
        taskId,
        runId: event.runId,
        type: event.agentEvent.type,
        payload: { agentId: event.agentId, event: event.agentEvent },
      });
    } else {
      this.store.appendEvent({
        sessionId,
        taskId,
        runId: event.runId,
        type: event.type,
        payload: { event },
      });
    }

    await this.emit({
      type: "orchestration_event",
      sessionId,
      taskId,
      event,
      occurredAt: Date.now(),
    });
  }

  private recordMultiAgentTrace(
    sessionId: string,
    taskId: string,
    event: MultiAgentEvent,
  ): void {
    const trace = this.executionContext.getStore();
    if (!trace) return;
    const agentKey = agentTraceKey(event);
    if (event.type === "agent_started") {
      const spanId = randomUUID();
      const parentAgentSpan = event.parentAgentId
        ? this.activeAgentSpans.get(
            `${event.runId}:${event.parentAgentId}:${Math.max(0, event.depth - 1)}`,
          )
        : undefined;
      this.activeAgentSpans.set(agentKey, spanId);
      this.startTraceSpan({
        sessionId,
        taskId,
        traceId: trace.traceId,
        spanId,
        parentSpanId:
          parentAgentSpan ??
          this.lastActiveStepSpan(taskId) ??
          trace.taskSpanId,
        kind: "agent",
        name: event.agentId,
        agentId: event.agentId,
        input: { task: event.task, depth: event.depth },
      });
      return;
    }
    if (event.type === "agent_completed" || event.type === "agent_failed") {
      const spanId = this.activeAgentSpans.get(agentKey);
      if (spanId) {
        this.finishTraceSpan(trace.traceId, spanId, {
          status: event.type === "agent_completed" ? "completed" : "failed",
          output: event.output,
          error: event.type === "agent_failed" ? event.reason : undefined,
          agentId: event.agentId,
        });
        this.activeAgentSpans.delete(agentKey);
      }
      return;
    }
    if (event.type !== "agent_event" || !event.agentEvent) return;
    const agentSpan = this.activeAgentSpans.get(agentKey) ?? trace.taskSpanId;
    const agentEvent = event.agentEvent;
    if (agentEvent.type === "model_request" && agentEvent.callId) {
      this.activeModelSpans.set(taskId, agentEvent.callId);
      this.startTraceSpan({
        sessionId,
        taskId,
        traceId: trace.traceId,
        spanId: agentEvent.callId,
        parentSpanId: agentSpan,
        kind: "model_call",
        name: `${event.agentId}:model`,
        agentId: event.agentId,
        input: agentEvent.request,
        context: collectContextArtifacts(agentEvent.request?.messages ?? []),
      });
      return;
    }
    if (agentEvent.type === "model_response" && agentEvent.callId) {
      const route = this.latestRouteForModelSpan(taskId, agentEvent.callId);
      const usage = agentEvent.response?.usage;
      this.finishTraceSpan(trace.traceId, agentEvent.callId, {
        status: "completed",
        output: agentEvent.response,
        usage,
        durationMs:
          agentEvent.response?.timing?.durationMs ?? agentEvent.durationMs,
        providerId: agentEvent.response?.providerId ?? route?.providerId,
        modelId: agentEvent.response?.model ?? route?.modelId,
        agentId: event.agentId,
        cost:
          agentEvent.response?.cost ??
          estimateActualCost(
            this.model,
            usage,
            agentEvent.response?.providerId ?? route?.providerId,
          ),
      });
      return;
    }
    if (agentEvent.type === "tool_requested" && agentEvent.spanId) {
      this.startTraceSpan({
        sessionId,
        taskId,
        traceId: trace.traceId,
        spanId: agentEvent.spanId,
        parentSpanId: agentEvent.parentSpanId ?? agentSpan,
        kind: "tool",
        name: agentEvent.call.name,
        agentId: event.agentId,
        toolName: agentEvent.call.name,
        input: agentEvent.call,
      });
      return;
    }
    if (agentEvent.type === "tool_completed" && agentEvent.spanId) {
      this.finishTraceSpan(trace.traceId, agentEvent.spanId, {
        status: agentEvent.result.isError ? "failed" : "completed",
        output: agentEvent.result,
        context: agentEvent.result.contextArtifacts,
        agentId: event.agentId,
        toolName: agentEvent.call.name,
        error: agentEvent.result.isError ? agentEvent.result.output : undefined,
      });
      return;
    }
    if (agentEvent.type === "context_compacted") {
      const spanId = randomUUID();
      this.startTraceSpan({
        sessionId,
        taskId,
        traceId: trace.traceId,
        spanId,
        parentSpanId: agentSpan,
        kind: "compaction",
        name: agentEvent.checkpoint.reason,
        input: agentEvent.checkpoint,
      });
      this.finishTraceSpan(trace.traceId, spanId, {
        status: "completed",
        output: agentEvent.checkpoint.state,
      });
    }
  }

  private lastActiveStepSpan(taskId: string): string | undefined {
    return [...this.activeStepSpans.entries()]
      .reverse()
      .find(([key]) => key.startsWith(`${taskId}:`))?.[1];
  }

  private latestRouteForModelSpan(
    taskId: string,
    modelSpanId: string,
  ): { providerId?: string; modelId?: string } | undefined {
    const spans = this.store.listTraceSpans(taskId);
    const route = [...spans]
      .reverse()
      .find(
        (span) =>
          span.kind === "provider_attempt" && span.parentSpanId === modelSpanId,
      );
    return route
      ? { providerId: route.providerId, modelId: route.modelId }
      : undefined;
  }

  private startTraceSpan(
    span: Omit<
      TraceSpanRecord,
      "projectId" | "status" | "startedAt" | "endedAt" | "durationMs"
    >,
  ): TraceSpanRecord {
    const sanitized = sanitizeTraceValue(
      span,
      this.credentialValues(),
    ) as typeof span;
    const record = this.store.startTraceSpan(sanitized);
    void this.emit({
      type: "trace_updated",
      sessionId: record.sessionId ?? "",
      taskId: record.taskId,
      span: record,
      occurredAt: Date.now(),
    });
    return record;
  }

  private finishTraceSpan(
    traceId: string,
    spanId: string,
    update: Parameters<SessionStore["finishTraceSpan"]>[2],
  ): TraceSpanRecord | undefined {
    const sanitized = sanitizeTraceValue(
      update,
      this.credentialValues(),
    ) as typeof update;
    const record = this.store.finishTraceSpan(traceId, spanId, sanitized);
    if (record) {
      void this.emit({
        type: "trace_updated",
        sessionId: record.sessionId ?? "",
        taskId: record.taskId,
        span: record,
        occurredAt: Date.now(),
      });
    }
    return record;
  }

  private credentialValues(): string[] {
    return this.store
      .listCredentialProviderIds()
      .map((providerId) => this.store.getCredential(providerId))
      .filter((value): value is string => Boolean(value));
  }

  private requireSession(sessionId: string): SessionRecord {
    const session = this.store.getSession(sessionId);
    if (!session) throw new Error(`Session not found: ${sessionId}`);
    return session;
  }

  private ensureOpen(): void {
    if (this.closed) throw new Error("The headless runtime is closed.");
  }

  private async emit(event: RuntimeEvent): Promise<void> {
    for (const listener of this.listeners) {
      try {
        void Promise.resolve(listener(event)).catch(() => undefined);
      } catch {
        // Presentation and transport observers cannot block runtime progress.
      }
    }
  }

  private async closeOwnedResources(): Promise<void> {
    for (const task of this.activeTasks.values()) task.controller.abort();
    await Promise.allSettled(
      [...this.activeTasks.values()].flatMap((task) =>
        task.completion ? [task.completion] : [],
      ),
    );
    this.listeners.clear();
    this.retrieval?.close();
    this.store.close();
  }
}

function transcriptMessages(
  resultMessages: ConversationMessage[] | undefined,
  history: readonly ConversationMessage[],
  task: TaskRecord,
  text: string,
): ConversationMessage[] {
  const messages = resultMessages ?? [
    ...history,
    { role: "user" as const, content: task.prompt },
    { role: "assistant" as const, content: text },
  ];
  return messages.filter(isSessionHistoryMessage);
}

function isSessionHistoryMessage(message: ConversationMessage): boolean {
  return message.role !== "system" || message.kind === "compaction";
}

function shouldUseVerificationOnly(agentId: string, prompt: string): boolean {
  if (agentId !== DEFAULT_AGENT_ID && agentId !== CODING_AGENT_ID) return false;
  const verificationRequest =
    /\b(run|execute|rerun|check|verify)\b[^.!?\n]{0,120}\b(test(?:s| suite)?|suite|build|lint|type(?:check| checks?| checking)|syntax(?: checks?| checking)|format(?: checks?| checking))\b/i.test(
      prompt,
    );
  if (!verificationRequest) return false;
  const explicitlyReadOnly =
    /\b(without|do not|don't|must not|no)\b[^.!?\n]{0,80}\b(modify|modifying|edit|editing|write|writing|change|changing|delete|deleting|create|creating|mutate|mutating)\b/i.test(
      prompt,
    );
  if (explicitlyReadOnly) return true;
  return !/\b(add|change|create|debug|delete|edit|fix|implement|migrate|modify|patch|refactor|remove|rename|update|write)\b/i.test(
    prompt,
  );
}

function shouldUsePipeline(agentId: string, prompt: string): boolean {
  if (agentId !== DEFAULT_AGENT_ID && agentId !== CODING_AGENT_ID) return false;
  return /\b(add|build|change|create|debug|delete|edit|fix|implement|migrate|modify|patch|refactor|remove|rename|test|update|write)\b/i.test(
    prompt,
  );
}

function waitForApproval(
  request: () => Promise<ToolApprovalResponse>,
  signal: AbortSignal,
): Promise<ToolApprovalResponse> {
  if (signal.aborted) return Promise.resolve(false);
  return new Promise((resolve) => {
    let settled = false;
    const finish = (decision: ToolApprovalResponse): void => {
      if (settled) return;
      settled = true;
      signal.removeEventListener("abort", deny);
      resolve(decision);
    };
    const deny = (): void => finish(false);
    signal.addEventListener("abort", deny, { once: true });
    Promise.resolve()
      .then(request)
      .then(finish, () => finish(false));
  });
}

function normalizeContextRange(
  range: AddFileContextInput["range"],
  content: string,
): { startLine: number; endLine: number } | undefined {
  if (!range) return undefined;
  if (
    !Number.isInteger(range.startLine) ||
    !Number.isInteger(range.endLine) ||
    range.startLine < 1 ||
    range.endLine < range.startLine
  ) {
    throw new Error("Context line ranges must be positive and ordered.");
  }
  const lineCount = splitLinesPreservingEndings(content).length;
  if (range.endLine > lineCount) {
    throw new Error(
      `Context line range ${range.startLine}-${range.endLine} exceeds the ${lineCount}-line file.`,
    );
  }
  return range;
}

function sliceLineRange(
  content: string,
  startLine: number,
  endLine: number,
): string {
  return splitLinesPreservingEndings(content)
    .slice(startLine - 1, endLine)
    .join("");
}

function splitLinesPreservingEndings(content: string): string[] {
  if (!content) return [];
  return content.match(/[^\r\n]*(?:\r\n|\n|\r)|[^\r\n]+$/gu) ?? [];
}

function normalizeWorkspaceRelativePath(root: string, path: string): string {
  return (relative(root, path) || ".").replaceAll("\\", "/");
}

function contextItemToRuntime(
  item: ContextItem,
  content: string,
): RuntimeFileContext {
  return {
    id: item.id,
    sessionId: item.sessionId ?? "",
    path: item.filePath ?? "",
    content,
    startLine: item.startLine,
    endLine: item.endLine,
    tokenEstimate: item.tokenEstimate,
    createdAt: item.createdAt,
  };
}

function stripContextHeader(content: string): string {
  const newline = content.indexOf("\n");
  return content.startsWith("[File context:") && newline >= 0
    ? content.slice(newline + 1)
    : content;
}

function isWorkspaceRecoveryState(
  value: unknown,
): value is WorkspaceRecoveryState {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<WorkspaceRecoveryState>;
  return (
    candidate.version === 1 &&
    typeof candidate.cycle === "number" &&
    typeof candidate.phase === "string" &&
    Array.isArray(candidate.mutations) &&
    Array.isArray(candidate.untrackedSideEffects)
  );
}

function agentTraceKey(event: MultiAgentEvent): string {
  return `${event.runId}:${event.agentId}:${event.depth}`;
}

function routeTraceKey(
  taskId: string,
  modelSpanId: string | undefined,
  event: GatewayEvent,
): string {
  const attempt = "attempt" in event ? event.attempt : 0;
  const modelId = "modelId" in event ? event.modelId : undefined;
  return `${taskId}:${modelSpanId ?? "none"}:${attempt}:${event.providerId}:${modelId ?? "unknown"}`;
}

function collectContextArtifacts(
  messages: readonly ConversationMessage[],
): unknown[] {
  return messages.flatMap((message) =>
    message.role === "tool" ? (message.metadata?.contextArtifacts ?? []) : [],
  );
}

function estimateActualCost(
  selection: RuntimeModelSelection,
  usage: { inputTokens: number; outputTokens: number } | undefined,
  providerId: string | undefined,
): number | undefined {
  if (providerId === "ollama") return 0;
  if (!usage) return undefined;
  const route = [selection, ...(selection.fallbacks ?? [])].find(
    (candidate) => candidate.providerId === providerId,
  );
  if (!route) return undefined;
  if (
    route.inputCostPerMillion === undefined &&
    route.outputCostPerMillion === undefined
  ) {
    return providerId === "groq" ? 0 : undefined;
  }
  return (
    (usage.inputTokens * (route.inputCostPerMillion ?? 0) +
      usage.outputTokens * (route.outputCostPerMillion ?? 0)) /
    1_000_000
  );
}

function sanitizeTraceValue(
  value: unknown,
  secrets: readonly string[],
): unknown {
  if (typeof value === "string") {
    return secrets.reduce(
      (result, secret) =>
        secret ? result.replaceAll(secret, "[REDACTED]") : result,
      value.replace(/(bearer\s+)[^\s"']+/giu, "$1[REDACTED]"),
    );
  }
  if (Array.isArray(value)) {
    return value.map((item) => sanitizeTraceValue(item, secrets));
  }
  if (!value || typeof value !== "object") return value;
  const sanitized: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) {
    sanitized[key] =
      /api.?key|authorization|cookie|credential|password|secret|access.?token|refresh.?token/iu.test(
        key,
      )
        ? "[REDACTED]"
        : sanitizeTraceValue(item, secrets);
  }
  return sanitized;
}

function normalizeFailure(value: string): string {
  return value.toLowerCase().replace(/\s+/g, " ").trim().slice(0, 500);
}

function validateLimits(limits: RuntimeLimits): void {
  if (limits.maxDepth < 0) throw new Error("maxDepth cannot be negative.");
  if (limits.maxHandoffs < 1)
    throw new Error("maxHandoffs must be at least 1.");
  if (limits.maxHandoffsPerPair < 1)
    throw new Error("maxHandoffsPerPair must be at least 1.");
  if (limits.maxModelSteps < 1)
    throw new Error("maxModelSteps must be at least 1.");
  if (limits.maxToolCalls < 1)
    throw new Error("maxToolCalls must be at least 1.");
  if (limits.maxDurationMs < 1)
    throw new Error("maxDurationMs must be at least 1.");
  if (limits.contextCharacterBudget < 1)
    throw new Error("contextCharacterBudget must be at least 1.");
}
