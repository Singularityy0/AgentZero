import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import { relative } from "node:path";
import {
  AgentRunner,
  MultiAgentOrchestrator,
  TaskOrchestrator,
  ToolRegistry,
  rustClient,
  type AgentDefinition,
  type AgentWorkRequest,
  type AgentWorkResult,
  type AgentModelResolver,
  type AgentToolResolver,
  type ConversationMessage,
  type MultiAgentEvent,
  type MultiAgentResult,
  type ModelRoutePolicy,
  type ModelUsage,
  type OrchestrationEvent,
  type OrchestrationPlan,
  type StepResult,
  type OrchestrationStep,
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
  type SessionEvent,
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
  type RuntimeTaskSpend,
  type RuntimeModelSelection,
  type RuntimeSettingsStore,
  type RuntimeTaskHandle,
  type RuntimeTaskResult,
  type StartIsolatedQuestionInput,
  type StartTaskInput,
} from "./types.js";
import {
  CODING_AGENT_ID,
  CONVERSATION_AGENT_ID,
  DEFAULT_AGENT_ID,
  RETRIEVER_AGENT_ID,
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
  private readonly spendByTask = new Map<string, RuntimeTaskSpend>();
  private readonly exceededBudgetTaskIds = new Set<string>();
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

    // Name the conversation after the work that started it. A history list
    // where every entry reads "IDE session" is a list of nothing, and the user
    // is not going to stop and title a chat before asking their question.
    if (isPlaceholderSessionTitle(session.title)) {
      this.store.updateSession(session.id, { title: sessionTitleFor(prompt) });
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

  /**
   * Fold what a task has already spent into its routing preference.
   *
   * The problem statement lists tokens already used as a routing signal, and it
   * is the one signal that changes mid-task: a stage that deserved the strongest
   * model at the start does not deserve it once the task is most of the way
   * through its budget, because being halted at the ceiling scores zero however
   * good the model was. Past the warning ratio, capacity requests degrade to
   * economy and window floors are dropped, which keeps the task alive to finish.
   *
   * Provider exclusions are never relaxed: a verifier running on the model it is
   * checking is worthless whatever it costs.
   */
  private budgetAwareRoutePolicy(
    taskId: string,
    policy: ModelRoutePolicy | undefined,
  ): ModelRoutePolicy | undefined {
    const spend = this.taskSpend(taskId);
    if (spend.budgetUsd <= 0) return policy;
    const consumed = spend.costUsd / spend.budgetUsd;
    if (consumed < this.limits.taskCostWarningRatio) return policy;
    const reason =
      `${Math.round(consumed * 100)}% of the task budget is spent ` +
      `(${spend.inputTokens + spend.outputTokens} tokens over ${spend.modelCalls} calls), ` +
      "so the cheapest capable route is used to finish within the ceiling";
    return {
      ...policy,
      bias: "economy" as const,
      minContextWindow: undefined,
      reason: policy?.reason ? `${policy.reason}; ${reason}` : reason,
    };
  }

  /**
   * Current spend for a task, or a zeroed record when nothing was billed.
   *
   * Falls back to the copy persisted in task state, so a task resumed in a new
   * process continues counting from what it already spent. An in-memory total
   * alone would reset the dollar ceiling every time the IDE restarted, which is
   * exactly the case a long-horizon task hits.
   */
  taskSpend(taskId: string): RuntimeTaskSpend {
    const live = this.spendByTask.get(taskId);
    if (live) return live;
    const persisted = readPersistedSpend(
      this.store.getTask(taskId)?.state.spend,
    );
    const spend: RuntimeTaskSpend = {
      taskId,
      budgetUsd: this.limits.maxTaskCostUsd,
      costUsd: persisted?.costUsd ?? 0,
      inputTokens: persisted?.inputTokens ?? 0,
      outputTokens: persisted?.outputTokens ?? 0,
      modelCalls: persisted?.modelCalls ?? 0,
    };
    if (persisted) this.spendByTask.set(taskId, spend);
    return spend;
  }

  /**
   * Adds one model call to a task's running total and publishes it.
   *
   * The evaluation halts any task that exceeds its dollar budget and scores it
   * as a total failure, so the system must notice first. Spend is summed from
   * real provider usage rather than the pre-call estimate used for routing,
   * because only the former reflects what was actually billed.
   */
  private recordSpend(
    sessionId: string,
    taskId: string,
    cost: number | undefined,
    usage: ModelUsage | undefined,
  ): void {
    const previous = this.taskSpend(taskId);
    const spend: RuntimeTaskSpend = {
      taskId,
      budgetUsd: this.limits.maxTaskCostUsd,
      costUsd: previous.costUsd + (cost ?? 0),
      inputTokens: previous.inputTokens + (usage?.inputTokens ?? 0),
      outputTokens: previous.outputTokens + (usage?.outputTokens ?? 0),
      modelCalls: previous.modelCalls + 1,
    };
    this.spendByTask.set(taskId, spend);
    // Persist alongside the task so a restart resumes the same running total
    // rather than granting the task a fresh budget.
    const record = this.store.getTask(taskId);
    if (record) {
      this.store.updateTask(taskId, {
        state: {
          ...record.state,
          spend: {
            costUsd: spend.costUsd,
            inputTokens: spend.inputTokens,
            outputTokens: spend.outputTokens,
            modelCalls: spend.modelCalls,
          },
        },
      });
    }
    const exceeded = spend.costUsd >= spend.budgetUsd;
    const warning =
      !exceeded &&
      spend.costUsd >= spend.budgetUsd * this.limits.taskCostWarningRatio;
    if (exceeded) this.exceededBudgetTaskIds.add(taskId);
    this.store.appendEvent({
      sessionId,
      taskId,
      type: "task_spend",
      payload: { spend, ...(exceeded || warning ? {} : {}) },
    });
    void this.emit({
      type: "task_spend",
      sessionId,
      taskId,
      spend,
      ...(exceeded
        ? { level: "exceeded" as const }
        : warning
          ? { level: "warning" as const }
          : {}),
      occurredAt: Date.now(),
    });
  }

  /** Throws when a task has spent its budget, stopping it before the next call. */
  private assertWithinBudget(taskId: string): void {
    if (!this.exceededBudgetTaskIds.has(taskId)) return;
    const spend = this.taskSpend(taskId);
    throw new Error(
      `Task halted: it reached its $${spend.budgetUsd.toFixed(2)} budget ` +
        `after ${spend.modelCalls} model calls ($${spend.costUsd.toFixed(4)} spent). ` +
        "Raise maxTaskCostUsd or narrow the task before retrying.",
    );
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
      const conversationOnly = shouldUseConversationAgent(agentId, task.prompt);
      const directAgentId =
        conversationOnly && this.store.getAgent(CONVERSATION_AGENT_ID)
          ? CONVERSATION_AGENT_ID
          : agentId;
      const result: MultiAgentResult = verificationOnly
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
              directAgentId,
              task.prompt,
              conversationOnly ? "" : context,
              history,
              signal,
              !conversationOnly,
            );
      runId = result.runId;
      const thinking = taskThinkingSummary(
        this.store.listEvents(session.id),
        task.id,
      );
      const messages =
        result.status === "paused"
          ? [...history]
          : transcriptMessages(history, task, result.text, thinking);
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
        // The task node is what the evaluation's wall-clock and token totals
        // are read from, so it carries the whole run's usage, not just its own.
        const rolled = this.rollUpUsage(
          task.id,
          traceContext.traceId,
          traceContext.taskSpanId,
        );
        this.finishTraceSpan(traceContext.traceId, traceContext.taskSpanId, {
          status: runtimeResult.status,
          output: runtimeResult,
          ...(rolled.usage ? { usage: rolled.usage } : {}),
          ...(rolled.cost !== undefined ? { cost: rolled.cost } : {}),
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
    stopAfterMutationCount = 0,
    rejectIncompleteMutations = false,
    toolAllowlist?: readonly string[],
    workflowMode?: "mutation" | "verification",
    routePolicy?: ModelRoutePolicy,
    maxOutputTokens?: number,
    maxSteps?: number,
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
        maxSteps,
        maxDurationMs: this.limits.maxDurationMs,
        allowHandoffs,
        enforceWorkflowCompletion,
        stopAfterMutationCount,
        rejectIncompleteMutations,
        toolAllowlist,
        workflowMode,
        routePolicy,
        maxOutputTokens,
        beforeModelRequest: () => {
          this.assertWithinBudget(taskId);
          beforeModelRequest?.();
        },
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
    const greenfieldArtifact = isGreenfieldArtifactRequest(task.prompt);
    const focusedFileEdit = isFocusedFileEditRequest(task.prompt);
    const focusedFilePath = focusedFileEdit
      ? extractExplicitWorkspacePath(task.prompt)
      : undefined;
    const focusedFileSnapshot = focusedFilePath
      ? await new WorkspaceFileService(this.projectRoot)
          .readText(focusedFilePath)
          .catch(() => undefined)
      : undefined;
    // A focused single-file edit is a simple task by construction, whatever its
    // wording suggests; everything else is judged from the prompt itself.
    const complexity: TaskComplexity = focusedFileEdit
      ? "simple"
      : classifyTaskComplexity(task.prompt);
    const producedFiles = new Set<string>();
    let lastVerifierFinding: string | undefined;
    let focusedVerifierSnapshotAvailable = false;
    const requestedVariants = requestedVariantLabels(task.prompt);
    // "in 5 different languages" gives a count; "in Python and Rust" gives the
    // languages instead. Either form has to produce one file per variant.
    const artifactCount = greenfieldArtifact
      ? Math.min(
          Math.max(
            requestedArtifactCount(task.prompt),
            requestedVariants.length,
          ),
          10,
        )
      : 1;
    const fastSingleFilePath =
      focusedFileEdit || (greenfieldArtifact && artifactCount === 1);
    // A 7B model cannot reliably emit five mutation calls from one prompt: asked
    // for all of them at once it answers with prose and changes nothing. Each
    // artifact therefore gets its own coding step with a single-file objective,
    // which is the decomposition the whole system is built around.
    const codingSteps: OrchestrationStep[] =
      artifactCount === 1
        ? [
            {
              id: "code",
              role: "coder",
              title: "Implement",
              prompt: greenfieldArtifact
                ? "Create one complete, self-contained artifact file that satisfies the objective exactly. Use native HTML/CSS/JavaScript when suitable. The file must contain the full implementation: no placeholders, ellipses, TODOs, template markers, or tutorial prose. Call create_file for a new path or write_file when the path already exists. Stop after the successful mutation; the verifier will inspect the saved file."
                : focusedFileEdit
                  ? focusedFileSnapshot
                    ? "This is a focused local file edit. The runtime already read the explicitly named file and supplied its exact current content below. Make exactly the requested replacement with apply_patch or write_file, then stop after the successful mutation. Do not read, search, browse, compile, or inspect Git."
                    : "This is a focused local file edit. Read the explicitly named file once, make exactly the requested replacement with apply_patch or write_file, and stop after the successful mutation. Do not search or browse the web; the existing file and objective are the authoritative context."
                  : "Implement the plan using the retrieved evidence. Satisfy every acceptance item exactly; never substitute an easier artifact or explain what could be built instead of creating it. After mutation, re-read every changed file and compare its actual contents with the original acceptance checklist.",
              dependsOn: ["retrieve"],
            },
          ]
        : Array.from({ length: artifactCount }, (_, index) => {
            const variant = requestedVariants[index];
            return {
              id: `code-${index + 1}`,
              role: "coder" as const,
              title: `Implement ${index + 1} of ${artifactCount}${variant ? ` (${variant})` : ""}`,
              prompt:
                `Create exactly ONE file: artifact ${index + 1} of ${artifactCount} for the objective` +
                (variant ? `, implemented in ${variant}.` : ".") +
                ` Do not create the other ${artifactCount - 1} artifacts; separate steps handle those.` +
                (variant
                  ? ""
                  : " Pick a language that none of the earlier steps listed above already used.") +
                " Give the file a clear workspace-relative path whose extension matches its language." +
                " The file must contain the full working implementation: no placeholders, ellipses, TODOs, or tutorial prose." +
                " Call create_file once with the complete content, then stop.",
              dependsOn: [index === 0 ? "retrieve" : `code-${index}`],
            };
          });
    const plan: OrchestrationPlan = {
      objective: task.prompt,
      steps: [
        {
          id: "plan",
          role: "planner",
          title: "Plan",
          prompt:
            "Create a small, testable implementation plan. Extract every explicit user requirement into an acceptance checklist; do not weaken, replace, or omit requested behavior. For a new self-contained artifact, do not invent downloads, libraries, models, or assets when native HTML/CSS/JavaScript can satisfy the request.",
        },
        {
          id: "retrieve",
          role: "retriever",
          title: "Retrieve context",
          prompt: "Retrieve compact semantic context for the plan.",
          dependsOn: ["plan"],
        },
        ...codingSteps,
        {
          id: "verify",
          role: "verifier",
          title: "Verify",
          prompt:
            "Verify the saved files against every explicit objective requirement and existing project rule, without inventing requirements. Call read_file on each changed artifact and use a relevant automated check when supported. Do not require a new executable entry point, demo, test suite, documentation, dependency, or Git repository unless the objective or surrounding project requires it. For a standalone source file that cannot be executed as-is, use a syntax/library-mode check when available or a detailed static behavior review, and report unavailable tooling as a limitation rather than an implementation failure. Report VERIFICATION_PASSED only when the requested behavior passes.",
          dependsOn: [codingSteps.at(-1)!.id],
        },
        {
          id: "review",
          role: "reviewer",
          title: "Review",
          prompt:
            "Review the plan, evidence, implementation, diff, and verification result against every explicit requirement in the original objective. Reject downgraded or missing behavior.",
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
      this.assertWithinBudget(task.id);
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
        enforceWorkflowCompletion = agentId === CODING_AGENT_ID ||
          agentId === VERIFIER_AGENT_ID,
        requireWorkspaceMutation = agentId === CODING_AGENT_ID,
        stopAfterMutationCount = 0,
        rejectIncompleteMutations = false,
        toolAllowlist?: readonly string[],
        maxSteps?: number,
      ) =>
      async (request: AgentWorkRequest): Promise<AgentWorkResult> => {
        const previous = request.previousResults
          .map((result) => `${result.role}: ${result.summary}`)
          .join("\n\n");
        const hostContext = executionEnvironmentContext(agentId);
        const result = await this.executeAgent(
          session.id,
          task.id,
          agentId,
          `${request.step.prompt}\n\nObjective:\n${request.objective}`,
          [request.context, previous, hostContext].filter(Boolean).join("\n\n"),
          includeHistory ? history : [],
          signal,
          false,
          consumeModelRequest,
          enforceWorkflowCompletion,
          stopAfterMutationCount,
          rejectIncompleteMutations,
          toolAllowlist,
          agentId === VERIFIER_AGENT_ID
            ? "verification"
            : agentId === CODING_AGENT_ID
              ? "mutation"
              : undefined,
          focusedFileEdit &&
            (agentId === CODING_AGENT_ID || agentId === VERIFIER_AGENT_ID)
            ? undefined
            : routePolicyForStage(agentId, complexity),
          outputBudgetForStage(agentId, {
            focusedFileEdit,
            greenfieldArtifact,
            complexity,
          }),
          maxSteps,
        );
        // Read the run's own record of what it changed, not its transcript.
        //
        // Compaction folds old exchanges into a summary and deletes the
        // messages it replaced, so a long coding step could apply a patch,
        // compact, and then be judged to have changed nothing because the tool
        // message proving otherwise had been compacted away. The step failed
        // with "did not call a workspace mutation tool" after having edited the
        // file. The runner tracks mutations independently for exactly this
        // reason; the transcript is only a fallback for a successful command.
        for (const file of result.changedFiles ?? []) {
          if (file.path) producedFiles.add(file.path);
        }
        // Workspace-level loop detection, complementary to the per-step failure
        // fingerprint. A run that edits a file, reverts it, and edits it again
        // succeeds at every individual step and produces different output each
        // time, so a fingerprint never fires - but the workspace has returned
        // to a state it already occupied, which is the definition of no
        // progress. The Merkle state tree in the sidecar is what notices.
        const cycleDepth = await this.detectWorkspaceCycle(result, agentId);
        if (cycleDepth !== undefined) {
          return {
            success: false,
            retryable: false,
            summary:
              `The workspace returned to a state it was already in ${cycleDepth} step(s) ago, ` +
              "so the run is undoing and redoing the same change instead of progressing. " +
              "Stopped before it could loop.",
            progressKey: `workspace-cycle:${cycleDepth}`,
          };
        }
        const commandSucceeded = (result.messages ?? []).some(
          (message) =>
            message.role === "tool" &&
            message.toolName === "run_command" &&
            message.metadata?.isError !== true &&
            message.metadata?.exitCode === 0,
        );
        const completedMutation =
          (result.mutationCount ?? 0) > 0 || commandSucceeded;
        let rejectedMutation:
          Extract<ConversationMessage, { role: "tool" }> | undefined;
        for (const message of result.messages ?? []) {
          if (
            message.role === "tool" &&
            message.metadata?.isError === true &&
            typeof message.toolName === "string" &&
            MUTATION_TOOLS.has(message.toolName)
          ) {
            rejectedMutation = message;
          }
        }
        const approvalDenied = result.status === "paused";
        const success = enforceWorkflowCompletion
          ? requireWorkspaceMutation
            ? completedMutation && !approvalDenied
            : result.status === "completed"
          : result.status === "completed";
        const summary =
          requireWorkspaceMutation && !completedMutation
            ? rejectedMutation
              ? `The coding model called ${rejectedMutation.toolName}, but the mutation was rejected and no files were changed: ${rejectedMutation.content.replace(/\n\[[^\]]*\]\s*$/u, "")}`
              : "The coding model did not call a workspace mutation tool. No files were changed."
            : result.text;
        const verifierEvidence =
          request.step.role === "verifier"
            ? focusedVerifierSnapshotAvailable ||
              (result.messages ?? []).some(
                (message) =>
                  message.role === "tool" &&
                  message.metadata?.isError !== true &&
                  VERIFICATION_TOOLS.has(String(message.toolName)),
              )
            : true;
        const fabricatedTools =
          request.step.role === "verifier" && !verifierEvidence
            ? describeFabricatedTools(result.text)
            : undefined;
        if (request.step.role === "verifier" && !success) {
          lastVerifierFinding = summary;
        }
        const verifierSummary = !verifierEvidence
          ? "The verifier reported results without running any verification tool" +
            `${fabricatedTools ? `, naming tools that do not exist (${fabricatedTools})` : ""}. ` +
            `Call read_file on each changed path, then run_command, compile_code, or syntax_check. Available tools: ${[...VERIFICATION_TOOLS].join(", ")}.`
          : summary;
        return {
          success:
            request.step.role === "verifier" ? verifierEvidence : success,
          summary: verifierSummary,
          output: verifierSummary,
          progressKey: !verifierEvidence
            ? "verifier:unverified"
            : !success
              ? `${agentId}:${normalizeFailure(summary)}`
              : undefined,
          retryable:
            approvalDenied || (requireWorkspaceMutation && !completedMutation)
              ? false
              : undefined,
          paused: approvalDenied,
          passed:
            request.step.role === "verifier"
              ? verifierEvidence && hasVerificationPassedMarker(result.text)
              : undefined,
        };
      };
    const workers = {
      planner:
        greenfieldArtifact || focusedFileEdit
          ? async (request: AgentWorkRequest): Promise<AgentWorkResult> => {
              const summary = focusedFileEdit
                ? [
                    "Focused file edit plan:",
                    `- Preserve the objective verbatim: ${request.objective}`,
                    "- Read the explicitly named local file.",
                    "- Replace only the requested implementation with one workspace mutation.",
                    "- Verify the saved file against the requested replacement.",
                  ].join("\n")
                : [
                    "Greenfield artifact plan:",
                    `- Preserve the objective verbatim: ${request.objective}`,
                    artifactCount === 1
                      ? "- Create one complete self-contained file at a clear workspace-relative path."
                      : `- Create ${artifactCount} complete self-contained files in ${artifactCount} separate coding steps, one file per step${requestedVariants.length > 0 ? `: ${requestedVariants.join(", ")}` : "."}`,
                    "- Include every requested behavior and control; do not substitute a simpler artifact.",
                    "- Reject placeholders, ellipses, TODOs, missing assets, and tutorial-only output.",
                    "- Verify the saved file's syntax and interactive behavior against the objective.",
                  ].join("\n");
              return { success: true, summary, output: summary };
            }
          : // The general path lets the planner decide the shape of the work.
            // The static plan carries one placeholder coding step; when the
            // planner returns a usable decomposition it replaces that
            // placeholder with one narrowly scoped step per sub-task, so each
            // coder call sees only the slice of the objective it owns.
            async (request: AgentWorkRequest): Promise<AgentWorkResult> => {
              const result = await runAgentWorker(
                DEFAULT_AGENT_ID,
                true,
              )(request);
              if (!result.success) return result;
              const subtasks = parsePlannedSubtasks(
                result.output ?? result.summary,
              );
              if (!subtasks) return result;
              // The block has been turned into steps, and each step carries its
              // own prompt. Leaving the raw JSON in the planner summary would
              // repeat every sub-task prompt in the context of every later
              // stage, for no benefit.
              const summary = stripSubtaskBlock(result.summary);
              return {
                ...result,
                summary,
                output: stripSubtaskBlock(result.output ?? result.summary),
                expandPlan: {
                  targetId: "code",
                  steps: subtasks.map((subtask, index) => ({
                    id: `code-${index + 1}`,
                    role: "coder" as const,
                    title: subtask.title,
                    prompt:
                      `Implement sub-task ${index + 1} of ${subtasks.length} from the plan, and nothing else. ` +
                      `Separate steps cover the others; do not implement them here.\n\n${subtask.prompt}\n\n` +
                      "Use the retrieved evidence, apply the change with a mutation tool, then re-read every file you changed.",
                    ...(index === 0 ? {} : { dependsOn: [`code-${index}`] }),
                  })),
                },
              };
            },
      retriever: async (
        request: AgentWorkRequest,
      ): Promise<AgentWorkResult> => {
        if (greenfieldArtifact || focusedFileEdit) {
          const summary = focusedFileEdit
            ? "Focused local edit: no semantic or web retrieval is required. The Coder must read the explicitly named file and apply only the requested replacement."
            : "Greenfield artifact: no existing project code is required. Create the requested file at a clear workspace-relative path using a self-contained implementation and the original acceptance criteria.";
          return {
            success: true,
            summary,
            output: summary,
            progressKey: focusedFileEdit
              ? "retrieval:focused-file-edit"
              : "retrieval:greenfield-artifact",
          };
        }
        const plannerOutput = request.previousResults.at(-1)?.summary ?? "";
        const retrieval = await this.retrieval!.query({
          query: `${request.objective}\n${plannerOutput}`,
          limit: 10,
          maxSliceLines: 40,
        });
        // Every later stage carries this payload in its context, so an
        // unbounded dump is charged repeatedly and can push the coder's first
        // request past the model's window before it has done anything. Dropping
        // the lowest-ranked slices costs the least: they are the ones retrieval
        // was least confident about.
        const payload = boundedRetrievalPayload(retrieval);
        // The pipeline's retriever is a direct index call, not a tool call, so
        // nothing was recording what it put into context. The dashboard's
        // per-node context view is fed by artifacts, which meant the stage that
        // chooses most of the coder's context was the one stage invisible in it.
        this.recordRetrievalContext(task.id, retrieval);
        return {
          success: true,
          summary: payload,
          output: payload,
          progressKey: `retrieval:${retrieval.results.map((slice) => `${slice.path}:${slice.startLine}-${slice.endLine}`).join("|")}`,
        };
      },
      coder: greenfieldArtifact
        ? runAgentWorker(CODING_AGENT_ID, false, true, true, 1, true, [
            "create_file",
            "write_file",
          ])
        : focusedFileEdit
          ? async (request: AgentWorkRequest): Promise<AgentWorkResult> => {
              const hasSnapshot = focusedFileSnapshot !== undefined;
              return runAgentWorker(
                CODING_AGENT_ID,
                false,
                true,
                true,
                1,
                true,
                hasSnapshot
                  ? [
                      "apply_patch",
                      "write_file",
                      "analyze_code_structure",
                      "compute_ast_diff",
                    ]
                  : [
                      "read_file",
                      "apply_patch",
                      "write_file",
                      "analyze_code_structure",
                      "compute_ast_diff",
                    ],
                hasSnapshot ? 2 : 3,
              )(
                hasSnapshot
                  ? {
                      ...request,
                      context: [
                        request.context,
                        `Authoritative current file snapshot (${focusedFileSnapshot.path}, sha256 ${focusedFileSnapshot.hash}):\n${focusedFileSnapshot.content}`,
                      ]
                        .filter(Boolean)
                        .join("\n\n"),
                    }
                  : request,
              );
            }
          : runAgentWorker(CODING_AGENT_ID),
      verifier: async (request: AgentWorkRequest): Promise<AgentWorkResult> => {
        const changed = [...producedFiles];
        if (focusedFileEdit && changed.length > 0) {
          const workspace = new WorkspaceFileService(this.projectRoot);
          const snapshots = (
            await Promise.all(
              changed.map((path) =>
                workspace.readText(path).catch(() => undefined),
              ),
            )
          ).filter(
            (file): file is NonNullable<typeof file> => file !== undefined,
          );
          focusedVerifierSnapshotAvailable =
            snapshots.length === changed.length;
          return runAgentWorker(
            VERIFIER_AGENT_ID,
            false,
            false,
            false,
            0,
            false,
            focusedVerifierSnapshotAvailable
              ? ["compile_code", "syntax_check"]
              : ["read_file", "compile_code", "syntax_check"],
            3,
          )({
            ...request,
            context: [
              request.context,
              ...snapshots.map(
                (file) =>
                  `Authoritative changed file snapshot (${file.path}, sha256 ${file.hash}):\n${file.content}`,
              ),
            ]
              .filter(Boolean)
              .join("\n\n"),
            step: {
              ...request.step,
              prompt:
                `${request.step.prompt}\n\nThis is a focused single-file verification. The runtime already supplied the exact saved file content, so do not read it again. ` +
                "Use at most one compile_code or syntax_check call when appropriate. Do not use run_command, Git, directory listing, or create test files. After that single check returns, immediately decide and emit VERIFICATION_PASSED when the implementation is correct.",
            },
          });
        }
        return runAgentWorker(VERIFIER_AGENT_ID)(
          changed.length === 0
            ? request
            : {
                ...request,
                step: {
                  ...request.step,
                  prompt:
                    `${request.step.prompt}\n\nThis task changed ${changed.length} file(s). Call read_file on every one before judging: ` +
                    changed.join(", "),
                },
              },
        );
      },
      reviewer: fastSingleFilePath
        ? async (): Promise<AgentWorkResult> => {
            const summary =
              "Independent verification already passed for this bounded single-file task; a second model review is unnecessary.";
            return { success: true, summary, output: summary };
          }
        : runAgentWorker(REVIEWER_AGENT_ID),
    };
    const orchestrator = new TaskOrchestrator(workers, {
      maxAttemptsPerStep: focusedFileEdit ? 1 : 2,
      maxTotalAttempts: 10,
      maxDurationMs: this.limits.maxDurationMs,
      signal,
      checkpoint: createTaskCheckpointStore(this.store, task.id),
      recoverStep: async (request, failure) => {
        if (request.step.role !== "verifier") return undefined;
        // A verifier that answered from imagination has told us nothing about
        // the artifact, so rolling the workspace back would discard good work
        // on no evidence. Send it back to run real tools instead.
        if (failure.progressKey?.startsWith("verifier:unverified")) {
          return undefined;
        }
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
    // The planner may have replaced the static coding step with its own
    // sub-steps, so the last implementation result is found by role rather than
    // by the id the plan was built with.
    const lastCodingResult = state.completedStepIds
      .map((id) => state.results[id])
      .filter((result): result is StepResult => result?.role === "coder")
      .at(-1);
    const final =
      state.results.review ??
      state.results.verify ??
      lastCodingResult ??
      state.results[codingSteps.at(-1)!.id] ??
      state.results.code;
    // A failed verification does not undo the implementation. Reporting the run
    // as a plain failure hides files that exist on disk and invites the user to
    // re-run work that is already done, so an unverified-but-written result is
    // surfaced as paused for a human decision, with the artifacts named.
    const unverifiedArtifacts =
      state.stage !== "completed" && producedFiles.size > 0;
    const completedArtifacts =
      state.stage === "completed" && producedFiles.size > 0;
    const text = unverifiedArtifacts
      ? [
          `Implementation finished, but verification did not pass. ${producedFiles.size} file(s) were written and kept:`,
          ...[...producedFiles].map((path) => `- ${path}`),
          "",
          "Unresolved verification findings:",
          lastVerifierFinding ??
            state.results.verify?.summary ??
            state.failure ??
            "The verifier did not report a specific finding.",
          "",
          "Review the files above, then either accept them or ask for the specific fix.",
        ].join("\n")
      : completedArtifacts
        ? formatSavedFiles(producedFiles)
        : (final?.summary ?? state.failure ?? "Pipeline produced no result.");
    return {
      runId: state.runId,
      agentId: REVIEWER_AGENT_ID,
      text,
      status:
        state.stage === "completed"
          ? "completed"
          : state.stage === "paused" || unverifiedArtifacts
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

  /**
   * Attach the slices a retrieval stage selected to its trace span.
   *
   * Records the reason each slice was chosen and which analyser produced its
   * symbols, so the dashboard can answer why a file is in context rather than
   * only that it is.
   */
  private recordRetrievalContext(
    taskId: string,
    retrieval: RetrievalQueryResult,
  ): void {
    const trace = this.executionContext.getStore();
    if (!trace) return;
    const spanId = this.lastActiveStepSpan(taskId);
    if (!spanId) return;
    this.store.updateTraceSpanContext(
      trace.traceId,
      spanId,
      retrieval.results.map((slice) => ({
        source: "retrieval" as const,
        path: slice.path,
        startLine: slice.startLine,
        endLine: slice.endLine,
        content: slice.content,
        tokenEstimate: Math.max(1, Math.ceil(slice.content.length / 4)),
        reasons: slice.reasons,
        extractor: this.retrieval?.getFileMetadata(slice.path)?.extractor,
      })),
    );
  }

  /**
   * Ask the sidecar whether this agent left the workspace in a state it has
   * already been in during this task.
   *
   * Only mutating runs are recorded: a read-only stage legitimately leaves the
   * workspace unchanged every time, and recording it would report a cycle for
   * doing its job correctly. A sidecar that is unavailable simply contributes
   * no signal, because this is an additional safeguard rather than the only one.
   */
  private async detectWorkspaceCycle(
    result: MultiAgentResult,
    agentId: string,
  ): Promise<number | undefined> {
    if (agentId !== CODING_AGENT_ID) return undefined;
    const changed = result.changedFiles ?? [];
    if (changed.length === 0) return undefined;
    try {
      rustClient.start();
      const depth = await rustClient.checkWorkspaceCycle(
        changed.map((file) => `${file.path}:${file.hash ?? ""}`),
        // The sidecar keeps one rolling state history for the whole process,
        // so the task id is folded into the snapshot alongside the agent.
        // Without it, a second task that legitimately brings the same files
        // back to a state an earlier task also produced - the common case when
        // two tasks touch one file in the same repository - is reported as a
        // loop it never entered. Namespacing rather than clearing the history
        // on task start, because clearing is not safe while another session's
        // task may be recording into the same history.
        `${this.executionContext.getStore()?.taskId ?? "unknown-task"}:${agentId}`,
      );
      return typeof depth === "number" ? depth : undefined;
    } catch {
      return undefined;
    }
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
      requireWorkspaceMutation?: boolean,
      stopAfterMutationCount?: number,
      rejectIncompleteMutations?: boolean,
      toolAllowlist?: readonly string[],
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
      // Undoing a creation would delete the only copy of the work. Edits to
      // pre-existing files are still reverted so a bad patch cannot survive.
      const result = await workspace.rollbackMutation(mutation, {
        preserveCreatedFiles: true,
      });
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
    const greenfieldArtifact = isGreenfieldArtifactRequest(request.objective);
    await this.retrieval?.indexProject();
    const replanned = greenfieldArtifact
      ? {
          success: true,
          summary:
            "Rebuild the standalone artifact from scratch and correct every verifier finding. " +
            `Do not repeat the rejected implementation. Verifier evidence:\n${failure.summary}`,
        }
      : await runAgentWorker(
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
    const retrieved = greenfieldArtifact
      ? { results: [], query: request.objective }
      : await this.retrieval!.query({
          query: `${request.objective}\n${replanned.summary}\n${failure.summary}`,
          limit: 10,
          maxSliceLines: 40,
          // The rollback above already re-indexed the workspace, and nothing
          // has written to it since, so this query reuses that pass instead of
          // walking the project a second time.
          refresh: false,
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
      true,
      true,
      greenfieldArtifact ? 1 : 0,
      greenfieldArtifact,
      greenfieldArtifact ? ["create_file", "write_file"] : undefined,
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
    if (!corrected.success) {
      return {
        ...corrected,
        summary: corrected.summary.includes("did not call a workspace mutation")
          ? "The verifier did not identify a concrete, actionable defect, so no corrective edit could be made. " +
            `Verifier report:\n${failure.summary}`
          : corrected.summary,
      };
    }
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
        const rolled = this.rollUpUsage(taskId, trace.traceId, spanId);
        this.finishTraceSpan(trace.traceId, spanId, {
          status: "completed",
          output: event,
          stepId: event.stepId,
          ...(rolled.usage ? { usage: rolled.usage } : {}),
          ...(rolled.cost !== undefined ? { cost: rolled.cost } : {}),
        });
        this.activeStepSpans.delete(stepKey);
      }
    } else if (
      trace &&
      (event.type === "step_recovering" || event.type === "step_retrying")
    ) {
      const spanId = this.activeStepSpans.get(stepKey);
      if (spanId) {
        const rolled = this.rollUpUsage(taskId, trace.traceId, spanId);
        this.finishTraceSpan(trace.traceId, spanId, {
          status: "failed",
          output: event,
          error: event.reason,
          stepId: event.stepId,
          ...(rolled.usage ? { usage: rolled.usage } : {}),
          ...(rolled.cost !== undefined ? { cost: rolled.cost } : {}),
        });
        this.activeStepSpans.delete(stepKey);
      }
    } else if (trace && event.type === "plan_expanded") {
      // Decomposition is a decision the user is entitled to see, so it gets its
      // own node in the hierarchy rather than living only in the event log.
      const spanId = randomUUID();
      this.startTraceSpan({
        sessionId,
        taskId,
        traceId: trace.traceId,
        spanId,
        parentSpanId: trace.taskSpanId,
        kind: "plan_expansion",
        name: `${event.targetId} -> ${event.steps.length} sub-steps`,
        stepId: event.stepId,
        input: event,
      });
      this.finishTraceSpan(trace.traceId, spanId, {
        status: "completed",
        output: { steps: event.steps },
      });
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
        // Usage is reported per model call, but the dashboard has to answer
        // "how many tokens did this agent use", so the agent's own calls are
        // summed onto its span. Without this the hierarchy showed time per
        // agent and tokens only on the leaves.
        const rolled = this.rollUpUsage(taskId, trace.traceId, spanId);
        this.finishTraceSpan(trace.traceId, spanId, {
          status: event.type === "agent_completed" ? "completed" : "failed",
          output: event.output,
          error: event.type === "agent_failed" ? event.reason : undefined,
          agentId: event.agentId,
          ...(rolled.usage ? { usage: rolled.usage } : {}),
          ...(rolled.cost !== undefined ? { cost: rolled.cost } : {}),
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
      const callCost =
        agentEvent.response?.cost ??
        estimateActualCost(
          this.model,
          usage,
          agentEvent.response?.providerId ?? route?.providerId,
        );
      this.finishTraceSpan(trace.traceId, agentEvent.callId, {
        status: "completed",
        output: agentEvent.response,
        usage,
        durationMs:
          agentEvent.response?.timing?.durationMs ?? agentEvent.durationMs,
        providerId: agentEvent.response?.providerId ?? route?.providerId,
        modelId: agentEvent.response?.model ?? route?.modelId,
        agentId: event.agentId,
        cost: callCost,
      });
      this.recordSpend(sessionId, taskId, callCost, usage);
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

  /**
   * Sum usage and cost across every span beneath `rootSpanId`.
   *
   * Providers report usage per model call, so any node above a model call - an
   * agent, a pipeline step, the task itself - only has a total if one is
   * computed. Walking the persisted spans means the numbers agree with what the
   * dashboard renders, rather than being tracked separately and drifting.
   */
  private rollUpUsage(
    taskId: string,
    traceId: string,
    rootSpanId: string,
  ): { usage?: ModelUsage; cost?: number } {
    const spans = this.store
      .listTraceSpans(taskId)
      .filter((span) => span.traceId === traceId);
    const childrenOf = new Map<string, TraceSpanRecord[]>();
    for (const span of spans) {
      if (!span.parentSpanId) continue;
      const siblings = childrenOf.get(span.parentSpanId) ?? [];
      siblings.push(span);
      childrenOf.set(span.parentSpanId, siblings);
    }
    let inputTokens = 0;
    let outputTokens = 0;
    let totalTokens = 0;
    let cost = 0;
    let sawUsage = false;
    let sawCost = false;
    const visit = (spanId: string, depth: number): void => {
      if (depth > MAX_TRACE_ROLLUP_DEPTH) return;
      for (const child of childrenOf.get(spanId) ?? []) {
        // Only leaf model calls carry provider-reported usage; adding an
        // already-rolled-up ancestor would double count.
        if (child.kind === "model_call") {
          const usage = child.usage as ModelUsage | undefined;
          if (usage) {
            sawUsage = true;
            inputTokens += usage.inputTokens ?? 0;
            outputTokens += usage.outputTokens ?? 0;
            totalTokens +=
              usage.totalTokens ??
              (usage.inputTokens ?? 0) + (usage.outputTokens ?? 0);
          }
          if (typeof child.cost === "number") {
            sawCost = true;
            cost += child.cost;
          }
        }
        visit(child.spanId, depth + 1);
      }
    };
    visit(rootSpanId, 0);
    return {
      ...(sawUsage
        ? { usage: { inputTokens, outputTokens, totalTokens } }
        : {}),
      ...(sawCost ? { cost } : {}),
    };
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
  history: readonly ConversationMessage[],
  task: TaskRecord,
  text: string,
  thinking: string[],
): ConversationMessage[] {
  return [
    ...history.filter(isConversationTranscriptMessage),
    { role: "user" as const, content: task.prompt },
    {
      role: "assistant" as const,
      content: text,
      metadata: {
        taskId: task.id,
        ...(thinking.length > 0 ? { thinking } : {}),
      },
    },
  ];
}

function isSessionHistoryMessage(message: ConversationMessage): boolean {
  return message.role !== "system" || message.kind === "compaction";
}

function isConversationTranscriptMessage(
  message: ConversationMessage,
): boolean {
  return (
    message.role === "user" ||
    message.role === "assistant" ||
    (message.role === "system" && message.kind === "compaction")
  );
}

function taskThinkingSummary(
  events: readonly SessionEvent[],
  taskId: string,
): string[] {
  const summary: string[] = [];
  const append = (value: string | undefined): void => {
    if (!value || summary.includes(value) || summary.length >= 40) return;
    summary.push(value);
  };
  for (const event of events) {
    if (event.taskId !== taskId) continue;
    const payloadEvent = recordValue(event.payload.event);
    if (event.type === "gateway_routing_attempt_started") {
      const provider = stringValue(payloadEvent?.providerId);
      const model = stringValue(payloadEvent?.modelId);
      append(
        provider && model
          ? `Selected ${provider} / ${model}`
          : provider
            ? `Selected ${provider}`
            : undefined,
      );
    } else if (event.type === "step_started") {
      append(`${stageLabel(payloadEvent)} started`);
    } else if (event.type === "step_completed") {
      append(`${stageLabel(payloadEvent)} completed`);
    } else if (event.type === "step_retrying") {
      append(`${stageLabel(payloadEvent)} retrying`);
    } else if (event.type === "step_recovering") {
      append(`${stageLabel(payloadEvent)} recovering`);
    } else if (event.type === "tool_requested") {
      const call = recordValue(payloadEvent?.call);
      const tool = stringValue(call?.name);
      append(tool ? `Using ${tool}` : undefined);
    } else if (event.type === "tool_completed") {
      const call = recordValue(payloadEvent?.call);
      const tool = stringValue(call?.name);
      append(tool ? `Completed ${tool}` : undefined);
    } else if (event.type === "agent_started") {
      append(`${agentLabel(payloadEvent)} started`);
    } else if (event.type === "handoff_requested") {
      const target = stringValue(payloadEvent?.targetAgentId);
      append(target ? `Delegating to ${target}` : "Delegating work");
    } else if (event.type === "handoff_completed") {
      const target = stringValue(payloadEvent?.targetAgentId);
      append(
        target
          ? `${target} completed delegated work`
          : "Delegated work completed",
      );
    } else if (event.type === "approval_requested") {
      append("Waiting for tool approval");
    } else if (event.type === "approval_resolved") {
      append(event.payload.approved === true ? "Tool approved" : "Tool denied");
    } else if (event.type === "context_compacted") {
      append("Compacted conversation context");
    }
  }
  return summary;
}

function stageLabel(event: Record<string, unknown> | undefined): string {
  const role = stringValue(event?.role);
  const stepId = stringValue(event?.stepId);
  const label = titleCase(role ?? stepId ?? "Pipeline stage");
  // Repeated stages share a role, and the client de-duplicates identical
  // progress lines. Without the ordinal, five coding steps collapse into one
  // "Coder started" and the run looks stuck when it is making progress.
  const ordinal = /-(\d+)$/u.exec(stepId ?? "")?.[1];
  return ordinal ? `${label} ${ordinal}` : label;
}

function agentLabel(event: Record<string, unknown> | undefined): string {
  return titleCase(stringValue(event?.agentId) ?? "Agent");
}

function titleCase(value: string): string {
  return value
    .replaceAll("-", " ")
    .replace(/\b\w/gu, (character) => character.toLocaleUpperCase());
}

function numberValue(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value)
    ? value
    : undefined;
}

function recordValue(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object"
    ? (value as Record<string, unknown>)
    : undefined;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function formatSavedFiles(paths: ReadonlySet<string>): string {
  const files = [...paths];
  if (files.length === 1) return `Saved \`${files[0]}\`.`;
  return [
    `Saved ${files.length} files:`,
    ...files.map((path) => `- \`${path}\``),
  ].join("\n");
}

/**
 * Models otherwise assume a Unix shell and waste a tool turn on `cat`/`ls` in
 * the Windows desktop host. Keep this runtime fact next to the task context so
 * both Coder and Verifier use the shell that `run_command` actually exposes.
 */
function executionEnvironmentContext(agentId: string): string | undefined {
  if (agentId !== CODING_AGENT_ID && agentId !== VERIFIER_AGENT_ID) {
    return undefined;
  }
  if (process.platform === "win32") {
    return [
      "Host execution environment:",
      "- Operating system: Windows.",
      "- run_command uses cmd.exe unless a specialized tool handles the operation.",
      "- Prefer read_file/list_directory for inspection. If a shell command is necessary, use Windows commands such as type and dir; do not use cat or ls.",
    ].join("\n");
  }
  return [
    "Host execution environment:",
    `- Operating system: ${process.platform}.`,
    "- run_command uses a POSIX shell; use POSIX command syntax.",
  ].join("\n");
}

/**
 * Stages that judge someone else's work. Running these on a weaker model than
 * the one that produced the work makes the judgement less useful, so hosted
 * routes are preferred. The gateway may still use a local route as a last
 * resort when every hosted route is unavailable beyond the bounded wait.
 */
const JUDGEMENT_AGENT_IDS: ReadonlySet<string> = new Set([
  VERIFIER_AGENT_ID,
  REVIEWER_AGENT_ID,
]);

const JUDGEMENT_ROUTE_POLICY: ModelRoutePolicy = {
  excludeProviders: ["ollama"],
  // Brief provider cooldowns are worth waiting through before demoting the check.
  maxCooldownWaitMs: 45_000,
  bias: "capacity",
  reason: "verification and review must not run on a weaker local model",
};

/**
 * How hard the task looks before any model has seen it.
 *
 * This is deliberately a cheap syntactic estimate rather than a model call: a
 * classifier that costs a round trip to save a round trip is a bad trade at
 * this scale, and getting it wrong only changes route order among models that
 * are all already eligible. The signals are the ones that actually correlate
 * with multi-step work in this system - how much the user wrote, how many
 * concrete files or paths they named, and whether the request describes
 * several operations rather than one.
 */
export type TaskComplexity = "simple" | "standard" | "complex";

/**
 * Provider limits commonly charge the requested completion allowance, not only
 * the tokens eventually emitted. Reserve a whole-file budget only when a stage
 * may actually create a whole file; focused patches and judgement need much
 * less and therefore consume far less free-tier token quota.
 */
function outputBudgetForStage(
  agentId: string,
  task: {
    focusedFileEdit: boolean;
    greenfieldArtifact: boolean;
    complexity: TaskComplexity;
  },
): number {
  if (agentId === CODING_AGENT_ID) {
    if (task.greenfieldArtifact) return 8_192;
    if (task.focusedFileEdit) return 3_072;
    return task.complexity === "complex" ? 6_144 : 4_096;
  }
  if (JUDGEMENT_AGENT_IDS.has(agentId)) return 2_048;
  return task.complexity === "complex" ? 4_096 : 2_048;
}

const MULTI_STEP_PATTERN =
  /\b(?:refactor|migrat\w*|redesign|architect\w*|across|throughout|each|every|all\s+(?:the\s+)?(?:files?|modules?|tests?|callers?)|then\b.*\bthen|as\s+well\s+as|integrat\w*|end[- ]to[- ]end|backward[- ]compat\w*)\b/iu;

export function classifyTaskComplexity(prompt: string): TaskComplexity {
  const referencedPaths = new Set(
    prompt.match(/\b[\w./-]+\.[A-Za-z]{1,5}\b/gu) ?? [],
  ).size;
  const conjunctions = (prompt.match(/\b(?:and|also|plus|then)\b/giu) ?? [])
    .length;
  let score = 0;
  if (prompt.length > 280) score += 1;
  if (prompt.length > 800) score += 1;
  if (referencedPaths >= 2) score += 1;
  if (referencedPaths >= 4) score += 1;
  if (conjunctions >= 3) score += 1;
  if (MULTI_STEP_PATTERN.test(prompt)) score += 2;
  if (score >= 3) return "complex";
  // The two misclassifications are not symmetric. Routing a hard task down to a
  // weak model costs accuracy, which dominates the score; routing an easy task
  // up costs a fraction of a cent. So "simple" is deliberately narrow: a short
  // request that names no file and asks for one thing. Anything that points at
  // concrete code stays on the operator's configured route.
  if (score === 0 && prompt.length < 160 && referencedPaths === 0) {
    return "simple";
  }
  return "standard";
}

/**
 * Route policy for one pipeline stage at one complexity.
 *
 * Planning and judgement decide whether the whole task succeeds, so on a
 * complex task they ask for the largest eligible model and real context
 * headroom. Retrieval summarisation is mechanical, so it asks for the cheapest
 * eligible model at every complexity - that is where the token budget is saved
 * without touching accuracy.
 */
export function routePolicyForStage(
  agentId: string,
  complexity: TaskComplexity,
): ModelRoutePolicy | undefined {
  if (JUDGEMENT_AGENT_IDS.has(agentId)) {
    return complexity === "complex"
      ? { ...JUDGEMENT_ROUTE_POLICY, minContextWindow: 32_000 }
      : JUDGEMENT_ROUTE_POLICY;
  }
  if (agentId === RETRIEVER_AGENT_ID) {
    return {
      bias: "economy",
      reason: "retrieval summarisation does not need the strongest model",
    };
  }
  if (agentId === CONVERSATION_AGENT_ID) {
    return {
      bias: "economy",
      reason: "plain conversation does not need the strongest model",
    };
  }
  if (complexity === "simple") {
    return {
      bias: "economy",
      reason: "short single-file request; cheapest capable route is sufficient",
    };
  }
  if (complexity === "complex" && agentId === DEFAULT_AGENT_ID) {
    return {
      bias: "capacity",
      minContextWindow: 32_000,
      reason:
        "multi-step objective; planning quality decides the whole task, so the largest eligible route is used",
    };
  }
  return undefined;
}

/** Tools whose successful execution counts as real verification evidence. */
const VERIFICATION_TOOLS: ReadonlySet<string> = new Set([
  "read_file",
  "run_command",
  "compile_code",
  "syntax_check",
  "git_diff",
  "list_directory",
  "find_files",
]);

/** File tools whose rejected calls deserve a truthful pipeline failure. */
const MUTATION_TOOLS: ReadonlySet<string> = new Set([
  "apply_patch",
  "create_file",
  "delete_file",
  "write_file",
]);

/**
 * Treat the verifier marker as a protocol token, not a formatting trick.
 * Hosted models commonly bold the marker or append a short file/check label,
 * even when instructed to place it at the very end. Requiring it to be the
 * absolute final bytes turned an explicitly successful verification into a
 * failed pipeline run. The marker must still begin its own line so prose such
 * as "I cannot emit VERIFICATION_PASSED" cannot accidentally pass.
 */
function hasVerificationPassedMarker(text: string): boolean {
  return text.split(/\r?\n/u).some((line) => {
    const normalized = line
      .trim()
      .replace(/^#{1,6}\s*/u, "")
      .replaceAll("**", "")
      .replaceAll("__", "")
      .trim();
    return /^VERIFICATION_PASSED(?:\b|$)/u.test(normalized);
  });
}

/**
 * Small models routinely invent plausible tool names ("py_verify", "go_verify")
 * and narrate their output. Naming the invented tools back to the model makes
 * the corrective retry far more likely to call a real one.
 */
function describeFabricatedTools(text: string): string | undefined {
  const named = new Set<string>();
  for (const match of text.matchAll(
    /\b([a-z][a-z0-9]*(?:_[a-z0-9]+)+)\b(?=\s*(?:\(|tool\b))/giu,
  )) {
    const name = match[1]!.toLowerCase();
    if (!VERIFICATION_TOOLS.has(name)) named.add(name);
  }
  return named.size > 0 ? [...named].slice(0, 6).join(", ") : undefined;
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

/**
 * Nouns naming something the user expects to exist when the turn ends.
 *
 * `code`, `script`, and `program` are deliberately included. In an agentic
 * coding IDE, "write a calculator program" is answered by creating a file the
 * user can run, not by printing a fence into the chat transcript. Routing those
 * requests to a tool-less chat agent is what made the IDE look like a chatbot.
 */
const ARTIFACT_NOUN_PATTERN =
  "files?|folders?|director(?:y|ies)|pages?|documents?|components?|websites?|web ?pages?|apps?|applications?|scripts?|programs?|code|codebase|snippets?|examples?|implementations?|modules?|packages?|librar(?:y|ies)|projects?|games?|servers?|apis?|clis?|classes?|functions?|tests?|suites?|readmes?|demos?|prototypes?";

/** Verbs asking for something new to exist. */
const PRODUCE_VERB_PATTERN =
  "add|build|code|create|draft|generate|implement|make|produce|scaffold|set ?up|write";

/** Verbs asking for something that already exists to change. */
const MUTATE_VERB_PATTERN =
  "change|debug|delete|edit|fix|migrate|modify|patch|refactor|remove|rename|replace|update|upgrade";

// "Implement X in @file.cpp" and "add X to file.ts" modify a named artifact
// even though `implement` and `add` can also create unnamed greenfield work.
const FOCUSED_FILE_VERB_PATTERN = new RegExp(
  `\\b(?:${MUTATE_VERB_PATTERN}|add|implement)\\b`,
  "iu",
);

const LANGUAGE_PATTERN =
  "languages?|bash|shell|powershell|c|c\\+\\+|c#|csharp|css|dart|elixir|go|golang|haskell|html|java|javascript|js|jsx|kotlin|lua|matlab|perl|php|python|ruby|rust|scala|sql|swift|typescript|tsx?";

const produceArtifactPattern = new RegExp(
  `\\b(?:${PRODUCE_VERB_PATTERN})\\b[^.!?\\n]{0,120}\\b(?:${ARTIFACT_NOUN_PATTERN})\\b`,
  "iu",
);

const produceInLanguagePattern = new RegExp(
  `\\b(?:${PRODUCE_VERB_PATTERN})\\b[^.!?\\n]{0,120}\\b(?:in|using|with|for)\\b[^.!?\\n]{0,60}\\b(?:${LANGUAGE_PATTERN})\\b`,
  "iu",
);

const mutateArtifactPattern = new RegExp(
  `\\b(?:${MUTATE_VERB_PATTERN}|save|commit|stage|run|test)\\b`,
  "iu",
);

// `@path` is the IDE's file-mention syntax. Treat it exactly like a bare path
// for routing purposes; otherwise a question such as "what is @cp.rs doing"
// is mistaken for general conversation and loses all workspace context.
const explicitPathPattern =
  /(?:^|\s)@?(?:\.\.?[/\\]|[A-Za-z]:[/\\]|[\w.-]+\.[A-Za-z0-9]{1,8})(?=\s|$|[:;,!?)}\]])/u;

const explicitPathCapturePattern =
  /(?:^|\s)@?((?:(?:\.\.?[/\\]|[A-Za-z]:[/\\])?[\w.-]+(?:[/\\][\w.-]+)*)\.[A-Za-z0-9]{1,8})(?=\s|$|[:;,!?)}\]])/u;

function extractExplicitWorkspacePath(prompt: string): string | undefined {
  return explicitPathCapturePattern.exec(prompt)?.[1]?.replaceAll("\\", "/");
}

const existingWorkPattern =
  /\b(?:existing|current|opened|this)\s+(?:file|page|document|component|website|webpage|app|application|project|workspace|repo|repository|codebase)\b/iu;

/**
 * True when the user asked for code or another artifact to be produced. Such a
 * request is workspace work: the agent must call a mutation tool, and therefore
 * ask for approval, instead of answering with a chat-only code fence.
 */
function requestsCodeArtifact(prompt: string): boolean {
  return (
    produceArtifactPattern.test(prompt) || produceInLanguagePattern.test(prompt)
  );
}

/**
 * Conversational lead-in that carries no intent of its own.
 *
 * The explanation test below is anchored, because an unanchored "what" would
 * match the middle of "change the parser so it reports what failed". But people
 * do not open with the keyword: they write "yo can you tell me what this does".
 * Stripping the preamble keeps the anchor's precision while letting it see the
 * real question. Every alternative here is a filler, a greeting, or a politeness
 * wrapper - never a verb that could describe work.
 */
const QUESTION_PREAMBLE_PATTERN =
  /^(?:\s*(?:yo|hey|hi|hello|ok|okay|so|um|uh|well|please|pls|plz|thanks|sorry|btw|quick question|question)\b[\s,.!:;-]*)*(?:\s*(?:can|could|would|will)\s+(?:you|u)\b[\s,]*)?(?:\s*(?:please|pls|plz|kindly)\b[\s,]*)?(?:\s*(?:do\s+you\s+know|any\s+idea|i(?:'d| would)?\s+(?:like|want)\s+to\s+know|let\s+me\s+know|i(?:'m| am)\s+curious)\b[\s,]*(?:about\b[\s,]*)?)?/iu;

/** Openers that ask for information rather than for work to be done. */
const EXPLANATION_OPENER_PATTERN =
  /^\s*(?:what|whats|what's|why|who|when|where|which|how\s+(?:do|does|did|is|are|can|could|would|should)|explain|describe|summari[sz]e|clarify|tell\s+me|walk\s+me\s+through|give\s+me\s+(?:a|an|the)?\s*(?:overview|summary|rundown|tour|idea|sense)|compare)\b/iu;

/**
 * True for questions that only want an explanation, never a new artifact.
 *
 * The two guards come first, and they are what make the opener list safe to
 * broaden: anything that asks for an artifact, or names a mutation of one, is
 * work no matter how politely it is phrased.
 */
function isExplanationRequest(prompt: string): boolean {
  if (requestsCodeArtifact(prompt)) return false;
  if (mutateArtifactPattern.test(prompt)) return false;
  return EXPLANATION_OPENER_PATTERN.test(
    prompt.replace(QUESTION_PREAMBLE_PATTERN, ""),
  );
}

const NUMBER_WORDS: Record<string, number> = {
  one: 1,
  two: 2,
  three: 3,
  four: 4,
  five: 5,
  six: 6,
  seven: 7,
  eight: 8,
  nine: 9,
  ten: 10,
};

/**
 * How many separate artifacts the request asks for. A greenfield run stops after
 * its first successful mutation by default; "in 5 different languages" has to
 * keep the coder alive for five files instead of one.
 */
function requestedArtifactCount(prompt: string): number {
  const match =
    /\b(\d{1,2}|one|two|three|four|five|six|seven|eight|nine|ten)\s+(?:different\s+|separate\s+|distinct\s+|various\s+)*(?:programming\s+)?(?:languages?|files?|versions?|variants?|implementations?|examples?|scripts?|programs?)\b/iu.exec(
      prompt,
    );
  if (!match) return 1;
  const token = match[1]!.toLowerCase();
  const value = NUMBER_WORDS[token] ?? Number.parseInt(token, 10);
  return Number.isFinite(value) ? Math.min(Math.max(value, 1), 10) : 1;
}

/**
 * Character ceiling on the retrieval payload handed to later pipeline stages.
 *
 * Roughly 2,000 tokens. The coder's request also carries its system prompt, the
 * objective, the planner's output, the manual context budget, and ~1,750 tokens
 * of tool schemas, so retrieval cannot be allowed to take an open-ended share of
 * a small model's window.
 */
const MAX_RETRIEVAL_PAYLOAD_CHARS = 8_000;

/**
 * Serialize a retrieval result, dropping the lowest-ranked slices until it fits.
 *
 * Slices arrive ranked, so truncating the list removes what retrieval was least
 * confident about — strictly better than cutting the JSON mid-string, which
 * would leave the payload unparseable, and better than trimming every slice,
 * which would damage the ones that matter most. The count is reported so a
 * reader can tell evidence was withheld rather than never found.
 */
function boundedRetrievalPayload(retrieval: RetrievalQueryResult): string {
  const full = JSON.stringify(retrieval);
  if (full.length <= MAX_RETRIEVAL_PAYLOAD_CHARS) return full;
  const results = [...retrieval.results];
  while (results.length > 1) {
    results.pop();
    const candidate = JSON.stringify({
      ...retrieval,
      results,
      omittedResults: retrieval.results.length - results.length,
    });
    if (candidate.length <= MAX_RETRIEVAL_PAYLOAD_CHARS) return candidate;
  }
  // A single slice can still exceed the ceiling; the compaction trim in
  // AgentRunner is the backstop for that.
  return JSON.stringify({
    ...retrieval,
    results,
    omittedResults: retrieval.results.length - results.length,
  });
}

/** Read a persisted spend total back out of task state, ignoring bad shapes. */
function readPersistedSpend(value: unknown):
  | {
      costUsd: number;
      inputTokens: number;
      outputTokens: number;
      modelCalls: number;
    }
  | undefined {
  const record = recordValue(value);
  if (!record) return undefined;
  const costUsd = numberValue(record.costUsd);
  const inputTokens = numberValue(record.inputTokens);
  const outputTokens = numberValue(record.outputTokens);
  const modelCalls = numberValue(record.modelCalls);
  if (costUsd === undefined) return undefined;
  return {
    costUsd,
    inputTokens: inputTokens ?? 0,
    outputTokens: outputTokens ?? 0,
    modelCalls: modelCalls ?? 0,
  };
}

/** Titles a client assigns before it knows what the conversation is about. */
const PLACEHOLDER_SESSION_TITLES: ReadonlySet<string> = new Set([
  "new session",
  "ide session",
  "session",
  "untitled",
  "",
]);

function isPlaceholderSessionTitle(title: string): boolean {
  return PLACEHOLDER_SESSION_TITLES.has(title.trim().toLowerCase());
}

/**
 * A short, human-scannable title taken from the first prompt.
 *
 * Cut at a sentence or line boundary when one falls in range, so a title ends
 * on a natural break instead of mid-word.
 */
export function sessionTitleFor(prompt: string): string {
  const cleaned = prompt.replace(/\s+/gu, " ").trim();
  if (!cleaned) return "New session";
  if (cleaned.length <= MAX_SESSION_TITLE_CHARS) return cleaned;
  const window = cleaned.slice(0, MAX_SESSION_TITLE_CHARS);
  const boundary = Math.max(
    window.lastIndexOf(". "),
    window.lastIndexOf("? "),
    window.lastIndexOf("! "),
    window.lastIndexOf(", "),
    window.lastIndexOf(" "),
  );
  const cut = boundary > MAX_SESSION_TITLE_CHARS / 2 ? boundary : window.length;
  return `${window.slice(0, cut).trimEnd()}…`;
}

const MAX_SESSION_TITLE_CHARS = 60;

/** Depth ceiling for the trace roll-up walk; the hierarchy is far shallower. */
const MAX_TRACE_ROLLUP_DEPTH = 24;

/** Upper bound on planner-produced coding steps. */
const MAX_PLANNED_SUBTASKS = 4;

interface PlannedSubtask {
  title: string;
  prompt: string;
}

/**
 * Read a planner's decomposition out of its reply.
 *
 * Small models are unreliable structured-output producers, so this is written to
 * fail silently: anything that is not a well-formed, non-trivial subtask list
 * yields `undefined` and the pipeline keeps its single generic coding step. A
 * bad parse must never be able to turn one implementation step into a series of
 * empty ones, because every extra step costs a model call.
 */
export function parsePlannedSubtasks(
  plannerOutput: string,
): PlannedSubtask[] | undefined {
  const block =
    /```(?:subtasks|json)?\s*(\[[\s\S]*?\])\s*```/iu.exec(plannerOutput)?.[1] ??
    /(?:^|\n)\s*(\[\s*\{[\s\S]*?\}\s*\])\s*(?:\n|$)/u.exec(plannerOutput)?.[1];
  if (!block) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(block);
  } catch {
    return undefined;
  }
  if (!Array.isArray(parsed)) return undefined;
  const subtasks: PlannedSubtask[] = [];
  for (const entry of parsed) {
    const record = recordValue(entry);
    const prompt = stringValue(record?.prompt)?.trim();
    if (!prompt) continue;
    const title = stringValue(record?.title)?.trim();
    subtasks.push({
      title: (title || prompt).slice(0, 80),
      prompt: prompt.slice(0, 2_000),
    });
    if (subtasks.length === MAX_PLANNED_SUBTASKS) break;
  }
  // One subtask is what the default plan already does, so a single-entry list is
  // not a decomposition and is not worth rewriting the plan for.
  return subtasks.length >= 2 ? subtasks : undefined;
}

/** Remove a consumed `subtasks` block from planner prose. */
function stripSubtaskBlock(text: string): string {
  return text
    .replace(/```(?:subtasks|json)?\s*\[[\s\S]*?\]\s*```/giu, "")
    .trimEnd();
}

const bareActionPattern = new RegExp(
  `\\b(?:${PRODUCE_VERB_PATTERN}|${MUTATE_VERB_PATTERN}|save|commit|stage|install|run|test)\\b`,
  "iu",
);

/**
 * True when the turn should end with the workspace in a different state. Both
 * the pipeline check and the chat check read this one predicate so a prompt can
 * never be classified as workspace work and casual conversation at once.
 */
function requestsWorkspaceWork(prompt: string): boolean {
  if (isExplanationRequest(prompt)) return false;
  // Naming a workspace file only establishes where the answer must come from;
  // it does not authorize or request a mutation. Path-only turns belong to the
  // read-capable Architect. Enter the coding pipeline only when the user also
  // asks for an artifact or uses an explicit action verb.
  return requestsCodeArtifact(prompt) || bareActionPattern.test(prompt);
}

const KNOWN_LANGUAGES: readonly string[] = [
  "python",
  "javascript",
  "typescript",
  "java",
  "c++",
  "c#",
  "c",
  "go",
  "rust",
  "ruby",
  "php",
  "swift",
  "kotlin",
  "scala",
  "haskell",
  "lua",
  "perl",
  "dart",
  "elixir",
  "bash",
  "sql",
  "html",
];

/**
 * Languages the user named explicitly, in the order they appear. When the
 * request only says "5 different languages" this is empty and each coding step
 * picks a language the earlier steps did not use.
 */
function requestedVariantLabels(prompt: string): string[] {
  const lowered = prompt.toLowerCase();
  const found: string[] = [];
  for (const language of KNOWN_LANGUAGES) {
    // Only `+` is a regex metacharacter here; escaping `#` is an invalid escape
    // under the `u` flag, so the name is escaped rather than pattern-built.
    const escaped = language.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
    if (new RegExp(`(?:^|[^\\w+#])${escaped}(?![\\w+#])`, "iu").test(prompt)) {
      found.push(language);
    }
  }
  return found.sort((a, b) => lowered.indexOf(a) - lowered.indexOf(b));
}

function shouldUsePipeline(agentId: string, prompt: string): boolean {
  if (agentId !== DEFAULT_AGENT_ID && agentId !== CODING_AGENT_ID) return false;
  return requestsWorkspaceWork(prompt);
}

/**
 * The tool-free chat agent is only correct when the answer cannot depend on the
 * opened project.
 *
 * "What is a closure" is answerable from the model's own knowledge. "What files
 * are in this repo" is not, and routing it to an agent with no tools and no
 * context produces a confident invention. Both are explanation requests, so
 * `requestsWorkspaceWork` says no to each; the workspace reference is what
 * separates them. A question about the project therefore falls through to the
 * Architect agent, which has read-only tools and the session context but still
 * cannot mutate anything.
 */
function shouldUseConversationAgent(agentId: string, prompt: string): boolean {
  if (agentId !== DEFAULT_AGENT_ID) return false;
  if (requestsWorkspaceWork(prompt)) return false;
  return !hasWorkspaceReference(prompt);
}

function hasWorkspaceReference(prompt: string): boolean {
  return (
    /\b(?:this|the|current|existing|opened)\s+(?:project|workspace|repository|repo|codebase|file|folder|app|application)\b/iu.test(
      prompt,
    ) ||
    requestsCodeArtifact(prompt) ||
    new RegExp(
      `\\b(?:${MUTATE_VERB_PATTERN})\\b[^.!?\\n]{0,120}\\b(?:${ARTIFACT_NOUN_PATTERN})\\b`,
      "iu",
    ).test(prompt) ||
    explicitPathPattern.test(prompt)
  );
}

function isGreenfieldArtifactRequest(prompt: string): boolean {
  return requestsCodeArtifact(prompt) && !existingWorkPattern.test(prompt);
}

/**
 * A direct edit to one named file does not need open-ended planning, semantic
 * retrieval, or internet research. Keeping this path local prevents a weak
 * fallback model from turning a two-tool edit into a long browsing session.
 */
function isFocusedFileEditRequest(prompt: string): boolean {
  return (
    FOCUSED_FILE_VERB_PATTERN.test(prompt) && explicitPathPattern.test(prompt)
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
