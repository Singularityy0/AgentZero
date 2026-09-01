import { randomUUID } from "node:crypto";

export type AgentRole =
  "planner" | "retriever" | "researcher" | "coder" | "verifier" | "reviewer";

export type OrchestrationStage =
  | "planning"
  | "researching"
  | "implementing"
  | "verifying"
  | "reviewing"
  | "completed"
  | "failed"
  | "paused";

export interface OrchestrationStep {
  id: string;
  role: AgentRole;
  title: string;
  prompt: string;
  dependsOn?: readonly string[];
}

export interface OrchestrationPlan {
  objective: string;
  steps: readonly OrchestrationStep[];
}

export interface AgentWorkRequest {
  runId: string;
  step: OrchestrationStep;
  objective: string;
  context: string;
  previousResults: readonly StepResult[];
  signal?: AbortSignal;
}

/**
 * A worker's request to rewrite the remaining plan. The planner uses this to
 * turn one placeholder implementation step into the sub-steps the task actually
 * needs, so decomposition comes from the model that read the objective rather
 * than from a fixed pipeline shape.
 */
export interface PlanExpansion {
  /** An existing, not-yet-completed step to replace. */
  targetId: string;
  /** The steps that take its place, in execution order. */
  steps: readonly OrchestrationStep[];
}

export interface AgentWorkResult {
  success: boolean;
  summary: string;
  output?: string;
  progressKey?: string;
  passed?: boolean;
  /** False when repeating the same worker input cannot make progress. */
  retryable?: boolean;
  /** Pause the durable pipeline instead of retrying after human intervention. */
  paused?: boolean;
  /** Replace a pending step with a decomposed sub-plan. */
  expandPlan?: PlanExpansion;
}

export interface StepResult extends AgentWorkResult {
  stepId: string;
  role: AgentRole;
  attempts: number;
  completedAt: number;
}

export interface PendingStepRecovery {
  stepId: string;
  afterAttempt: number;
  failure: AgentWorkResult;
}

export interface OrchestrationState {
  runId: string;
  objective: string;
  stage: OrchestrationStage;
  completedStepIds: string[];
  results: Record<string, StepResult>;
  attempts: Record<string, number>;
  failureFingerprints?: Record<string, string>;
  pendingRecovery?: PendingStepRecovery;
  /**
   * Plan rewrites applied so far, in the order they were applied. Persisting
   * them is what makes a decomposed run resumable: replaying them against the
   * static plan reproduces the exact step list the interrupted run was using.
   */
  expansions?: PlanExpansion[];
  totalAttempts: number;
  failure?: string;
  startedAt: number;
  updatedAt: number;
}

export interface OrchestrationCheckpointStore {
  load(): Promise<OrchestrationState | undefined>;
  save(state: OrchestrationState): Promise<void>;
}

export type AgentWorker = (
  request: AgentWorkRequest,
) => Promise<AgentWorkResult>;

export type OrchestrationEvent =
  | {
      type: "orchestration_started";
      runId: string;
      objective: string;
    }
  | {
      type: "step_started";
      runId: string;
      stepId: string;
      role: AgentRole;
      attempt: number;
    }
  | {
      type: "step_completed";
      runId: string;
      stepId: string;
      role: AgentRole;
      attempt: number;
      summary: string;
    }
  | {
      type: "step_recovering";
      runId: string;
      stepId: string;
      role: AgentRole;
      attempt: number;
      reason: string;
    }
  | {
      type: "step_retrying";
      runId: string;
      stepId: string;
      role: AgentRole;
      attempt: number;
      reason: string;
    }
  | {
      type: "plan_expanded";
      runId: string;
      /** The step whose result requested the rewrite. */
      stepId: string;
      /** The placeholder step that was replaced. */
      targetId: string;
      steps: ReadonlyArray<{ id: string; role: AgentRole; title: string }>;
    }
  | {
      type: "orchestration_paused";
      runId: string;
      reason: string;
    }
  | {
      type: "orchestration_completed";
      runId: string;
    }
  | {
      type: "orchestration_failed";
      runId: string;
      reason: string;
    };

export interface TaskOrchestratorOptions {
  runId?: string;
  maxAttemptsPerStep?: number;
  maxTotalAttempts?: number;
  maxDurationMs?: number;
  signal?: AbortSignal;
  checkpoint?: OrchestrationCheckpointStore;
  recoverStep?: (
    request: AgentWorkRequest,
    failure: AgentWorkResult,
  ) => Promise<AgentWorkResult | undefined>;
  onEvent?: (event: OrchestrationEvent) => void | Promise<void>;
}

const DEFAULT_MAX_ATTEMPTS_PER_STEP = 3;
const DEFAULT_MAX_TOTAL_ATTEMPTS = 20;

export class TaskOrchestrator {
  private readonly options: Required<
    Pick<TaskOrchestratorOptions, "maxAttemptsPerStep" | "maxTotalAttempts">
  > &
    Omit<TaskOrchestratorOptions, "maxAttemptsPerStep" | "maxTotalAttempts">;

  constructor(
    private readonly workers: Partial<Record<AgentRole, AgentWorker>>,
    options: TaskOrchestratorOptions = {},
  ) {
    this.options = {
      ...options,
      maxAttemptsPerStep:
        options.maxAttemptsPerStep ?? DEFAULT_MAX_ATTEMPTS_PER_STEP,
      maxTotalAttempts: options.maxTotalAttempts ?? DEFAULT_MAX_TOTAL_ATTEMPTS,
    };
    if (this.options.maxAttemptsPerStep < 1) {
      throw new Error("maxAttemptsPerStep must be at least 1.");
    }
    if (this.options.maxTotalAttempts < 1) {
      throw new Error("maxTotalAttempts must be at least 1.");
    }
  }

  async run(
    plan: OrchestrationPlan,
    context = "",
  ): Promise<OrchestrationState> {
    validatePlan(plan);
    const invokedAt = Date.now();
    const saved = await this.options.checkpoint?.load();
    // The live step list starts as the static plan and is rewritten in place by
    // accepted expansions. A resumed run replays the persisted expansions first
    // so it continues against the same steps the interrupted run was executing.
    let steps: OrchestrationStep[] = [...plan.steps];
    const state = saved
      ? restoreState(saved, plan)
      : createState(plan, this.options.runId ?? randomUUID(), invokedAt);
    for (const expansion of state.expansions ?? []) {
      steps = applyExpansion(steps, expansion, state.completedStepIds);
    }
    validateSteps(steps);

    if (state.stage === "completed") return state;
    await this.emit({
      type: "orchestration_started",
      runId: state.runId,
      objective: plan.objective,
    });
    await this.save(state);

    try {
      while (state.completedStepIds.length < steps.length) {
        this.checkLimits(state, invokedAt);
        const step = nextReadyStep(steps, state);
        if (!step) {
          return this.fail(
            state,
            "No runnable step remains; the plan has a dependency cycle or failed dependency.",
          );
        }

        const worker = this.workers[step.role];
        if (!worker) {
          return this.fail(
            state,
            `No worker is registered for role "${step.role}".`,
          );
        }

        state.stage = stageForRole(step.role);
        const previousResults = steps
          .filter((candidate) => state.completedStepIds.includes(candidate.id))
          .map((candidate) => state.results[candidate.id])
          .filter((result): result is StepResult => result !== undefined);
        const result = await this.runStep(
          state,
          step,
          worker,
          plan.objective,
          context,
          previousResults,
          invokedAt,
        );

        if (!result) return state;
        state.results[step.id] = result;
        state.completedStepIds.push(step.id);
        if (result.expandPlan) {
          const expanded = this.acceptExpansion(
            steps,
            state,
            result.expandPlan,
          );
          if (expanded) {
            steps = expanded;
            await this.emit({
              type: "plan_expanded",
              runId: state.runId,
              stepId: step.id,
              targetId: result.expandPlan.targetId,
              steps: result.expandPlan.steps.map((item) => ({
                id: item.id,
                role: item.role,
                title: item.title,
              })),
            });
          }
        }
        state.updatedAt = Date.now();
        await this.emit({
          type: "step_completed",
          runId: state.runId,
          stepId: step.id,
          role: step.role,
          attempt: result.attempts,
          summary: result.summary,
        });
        await this.save(state);
      }
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      state.stage = this.options.signal?.aborted ? "paused" : "failed";
      state.failure = reason;
      state.updatedAt = Date.now();
      await this.save(state);
      await this.emit({
        type:
          state.stage === "paused"
            ? "orchestration_paused"
            : "orchestration_failed",
        runId: state.runId,
        reason,
      });
      return state;
    }

    state.stage = "completed";
    state.updatedAt = Date.now();
    await this.save(state);
    await this.emit({ type: "orchestration_completed", runId: state.runId });
    return state;
  }

  private async runStep(
    state: OrchestrationState,
    step: OrchestrationStep,
    worker: AgentWorker,
    objective: string,
    context: string,
    previousResults: readonly StepResult[],
    startedAt: number,
  ): Promise<StepResult | undefined> {
    const failureFingerprints = (state.failureFingerprints ??= {});
    let previousFailureKey: string | undefined = failureFingerprints[step.id];
    const recoveryRequest: AgentWorkRequest = {
      runId: state.runId,
      step,
      objective,
      context,
      previousResults,
      signal: this.options.signal,
    };
    if (state.pendingRecovery?.stepId === step.id) {
      const pending = state.pendingRecovery;
      const recovered = await this.performRecovery(
        state,
        recoveryRequest,
        pending.failure,
        pending.afterAttempt,
      );
      if (!recovered) return undefined;
    }
    const firstAttempt = (state.attempts[step.id] ?? 0) + 1;
    for (
      let attempt = firstAttempt;
      attempt <= this.options.maxAttemptsPerStep;
      attempt += 1
    ) {
      this.checkLimits(state, startedAt);
      state.attempts[step.id] = attempt;
      state.totalAttempts += 1;
      state.updatedAt = Date.now();
      await this.emit({
        type: "step_started",
        runId: state.runId,
        stepId: step.id,
        role: step.role,
        attempt,
      });
      await this.save(state);

      let result: AgentWorkResult;
      try {
        result = await worker({
          runId: state.runId,
          step,
          objective,
          context,
          previousResults,
          signal: this.options.signal,
        });
      } catch (error) {
        result = {
          success: false,
          summary: error instanceof Error ? error.message : String(error),
        };
      }
      const passed = step.role === "verifier" ? result.passed === true : true;
      const failureKey =
        result.success && passed
          ? undefined
          : (result.progressKey ?? `${result.summary}:${result.output ?? ""}`);

      if (result.success && passed) {
        return {
          ...result,
          stepId: step.id,
          role: step.role,
          attempts: attempt,
          completedAt: Date.now(),
        };
      }

      const reason = result.summary || "The worker did not complete the step.";
      if (result.paused === true) {
        await this.pause(state, reason);
        return undefined;
      }
      if (failureKey && failureKey === previousFailureKey) {
        await this.fail(
          state,
          `Step "${step.id}" is stuck repeating the same failure: ${reason}`,
        );
        return undefined;
      }
      previousFailureKey = failureKey;
      if (failureKey) failureFingerprints[step.id] = failureKey;
      state.updatedAt = Date.now();
      await this.save(state);
      if (result.retryable === false) {
        await this.fail(state, `Step "${step.id}" failed: ${reason}`);
        return undefined;
      }
      if (attempt < this.options.maxAttemptsPerStep) {
        if (this.options.recoverStep) {
          state.pendingRecovery = {
            stepId: step.id,
            afterAttempt: attempt,
            failure: result,
          };
          state.updatedAt = Date.now();
          await this.save(state);
          const recovered = await this.performRecovery(
            state,
            recoveryRequest,
            result,
            attempt,
          );
          if (!recovered) return undefined;
        }
        await this.emit({
          type: "step_retrying",
          runId: state.runId,
          stepId: step.id,
          role: step.role,
          attempt,
          reason,
        });
      }
    }

    await this.fail(
      state,
      `Step "${step.id}" failed after ${this.options.maxAttemptsPerStep} attempts.`,
    );
    return undefined;
  }

  /**
   * Validate and record a plan rewrite. An expansion that would break the plan
   * is dropped rather than thrown: a small model producing a malformed
   * decomposition should fall back to the placeholder step, not fail the task.
   */
  private acceptExpansion(
    steps: readonly OrchestrationStep[],
    state: OrchestrationState,
    expansion: PlanExpansion,
  ): OrchestrationStep[] | undefined {
    try {
      const next = applyExpansion(steps, expansion, state.completedStepIds);
      validateSteps(next);
      (state.expansions ??= []).push({
        targetId: expansion.targetId,
        steps: expansion.steps.map((step) => ({ ...step })),
      });
      return next;
    } catch {
      return undefined;
    }
  }

  private async performRecovery(
    state: OrchestrationState,
    request: AgentWorkRequest,
    failure: AgentWorkResult,
    attempt: number,
  ): Promise<boolean> {
    const reason = failure.summary || "The worker did not complete the step.";
    await this.emit({
      type: "step_recovering",
      runId: state.runId,
      stepId: request.step.id,
      role: request.step.role,
      attempt,
      reason,
    });
    const recovery = await this.options.recoverStep?.(request, failure);
    if (recovery && !recovery.success) {
      await this.fail(
        state,
        `Recovery for step "${request.step.id}" failed: ${recovery.summary}`,
      );
      return false;
    }
    delete state.pendingRecovery;
    state.updatedAt = Date.now();
    await this.save(state);
    return true;
  }

  private checkLimits(state: OrchestrationState, startedAt: number): void {
    if (this.options.signal?.aborted) {
      state.stage = "paused";
      throw new Error("Orchestration was cancelled.");
    }
    if (state.totalAttempts >= this.options.maxTotalAttempts) {
      throw new Error(
        `Orchestration stopped after reaching the ${this.options.maxTotalAttempts}-attempt safety limit.`,
      );
    }
    if (
      this.options.maxDurationMs !== undefined &&
      Date.now() - startedAt >= this.options.maxDurationMs
    ) {
      throw new Error("Orchestration stopped after reaching its time budget.");
    }
  }

  private async fail(
    state: OrchestrationState,
    reason: string,
  ): Promise<OrchestrationState> {
    state.stage = "failed";
    state.failure = reason;
    state.updatedAt = Date.now();
    await this.save(state);
    await this.emit({
      type: "orchestration_failed",
      runId: state.runId,
      reason,
    });
    return state;
  }

  private async pause(
    state: OrchestrationState,
    reason: string,
  ): Promise<OrchestrationState> {
    state.stage = "paused";
    state.failure = reason;
    state.updatedAt = Date.now();
    await this.save(state);
    await this.emit({
      type: "orchestration_paused",
      runId: state.runId,
      reason,
    });
    return state;
  }

  private async save(state: OrchestrationState): Promise<void> {
    await this.options.checkpoint?.save(state);
  }

  private async emit(event: OrchestrationEvent): Promise<void> {
    await this.options.onEvent?.(event);
  }
}

function createState(
  plan: OrchestrationPlan,
  runId: string,
  startedAt: number,
): OrchestrationState {
  return {
    runId,
    objective: plan.objective,
    stage: "planning",
    completedStepIds: [],
    results: {},
    attempts: {},
    failureFingerprints: {},
    totalAttempts: 0,
    startedAt,
    updatedAt: startedAt,
  };
}

function restoreState(
  saved: OrchestrationState,
  plan: OrchestrationPlan,
): OrchestrationState {
  if (saved.objective !== plan.objective) {
    throw new Error(
      "The saved orchestration objective does not match the plan.",
    );
  }
  // Completed ids are checked against the static plan plus every step any
  // persisted expansion introduced, so a resumed decomposed run is not
  // mistaken for a checkpoint belonging to a different plan.
  const stepIds = new Set(plan.steps.map((step) => step.id));
  for (const expansion of saved.expansions ?? []) {
    for (const step of expansion.steps) stepIds.add(step.id);
  }
  if (saved.completedStepIds.some((id) => !stepIds.has(id))) {
    throw new Error(
      "The saved orchestration contains an unknown completed step.",
    );
  }
  return {
    ...saved,
    completedStepIds: [...saved.completedStepIds],
    results: { ...saved.results },
    attempts: { ...saved.attempts },
    failureFingerprints: { ...(saved.failureFingerprints ?? {}) },
    expansions: (saved.expansions ?? []).map((expansion) => ({
      targetId: expansion.targetId,
      steps: expansion.steps.map((step) => ({ ...step })),
    })),
  };
}

/**
 * Replace `targetId` with `expansion.steps`, rewiring dependencies so the rest
 * of the plan still runs in the right order:
 *
 * - the first inserted step inherits the placeholder's dependencies unless it
 *   declares its own, so it still waits for retrieval;
 * - every later step that depended on the placeholder now depends on the last
 *   inserted step, so verification still runs after all the work.
 */
function applyExpansion(
  steps: readonly OrchestrationStep[],
  expansion: PlanExpansion,
  completedStepIds: readonly string[],
): OrchestrationStep[] {
  const index = steps.findIndex((step) => step.id === expansion.targetId);
  if (index === -1) {
    throw new Error(`Unknown expansion target step: ${expansion.targetId}`);
  }
  if (completedStepIds.includes(expansion.targetId)) {
    throw new Error(
      `Step "${expansion.targetId}" already ran and cannot be expanded.`,
    );
  }
  if (expansion.steps.length === 0) {
    throw new Error("A plan expansion requires at least one step.");
  }
  const target = steps[index]!;
  const existingIds = new Set(steps.map((step) => step.id));
  for (const step of expansion.steps) {
    if (existingIds.has(step.id) && step.id !== target.id) {
      throw new Error(`Expansion step "${step.id}" duplicates an existing id.`);
    }
  }
  const inserted = expansion.steps.map((step, position) => ({
    ...step,
    dependsOn:
      position === 0
        ? (step.dependsOn ?? target.dependsOn)
        : (step.dependsOn ?? [expansion.steps[position - 1]!.id]),
  }));
  const lastInsertedId = inserted.at(-1)!.id;
  return steps.flatMap((step) => {
    if (step.id === target.id) return inserted;
    const dependsOn = step.dependsOn;
    if (!dependsOn?.includes(target.id)) return [step];
    return [
      {
        ...step,
        dependsOn: dependsOn.map((id) =>
          id === target.id ? lastInsertedId : id,
        ),
      },
    ];
  });
}

function nextReadyStep(
  steps: readonly OrchestrationStep[],
  state: OrchestrationState,
): OrchestrationStep | undefined {
  return steps.find(
    (step) =>
      !state.completedStepIds.includes(step.id) &&
      (step.dependsOn ?? []).every((dependency) =>
        state.completedStepIds.includes(dependency),
      ),
  );
}

function stageForRole(role: AgentRole): OrchestrationStage {
  switch (role) {
    case "planner":
      return "planning";
    case "retriever":
    case "researcher":
      return "researching";
    case "coder":
      return "implementing";
    case "verifier":
      return "verifying";
    case "reviewer":
      return "reviewing";
  }
}

function validatePlan(plan: OrchestrationPlan): void {
  if (!plan.objective.trim())
    throw new Error("An orchestration objective is required.");
  validateSteps(plan.steps);
}

function validateSteps(steps: readonly OrchestrationStep[]): void {
  if (steps.length === 0)
    throw new Error("An orchestration plan requires at least one step.");

  const ids = new Set<string>();
  for (const step of steps) {
    if (!step.id.trim())
      throw new Error("Every orchestration step requires an id.");
    if (ids.has(step.id))
      throw new Error(`Duplicate orchestration step: ${step.id}`);
    ids.add(step.id);
    if (!step.prompt.trim())
      throw new Error(`Step "${step.id}" requires a prompt.`);
    for (const dependency of step.dependsOn ?? []) {
      if (dependency === step.id)
        throw new Error(`Step "${step.id}" cannot depend on itself.`);
      if (!steps.some((candidate) => candidate.id === dependency)) {
        throw new Error(
          `Step "${step.id}" depends on unknown step "${dependency}".`,
        );
      }
    }
  }
}
