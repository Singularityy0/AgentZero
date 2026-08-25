import { randomUUID } from "node:crypto";

export type AgentRole =
  "planner" | "researcher" | "coder" | "verifier" | "reviewer";

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

export interface AgentWorkResult {
  success: boolean;
  summary: string;
  output?: string;
  progressKey?: string;
  passed?: boolean;
}

export interface StepResult extends AgentWorkResult {
  stepId: string;
  role: AgentRole;
  attempts: number;
  completedAt: number;
}

export interface OrchestrationState {
  runId: string;
  objective: string;
  stage: OrchestrationStage;
  completedStepIds: string[];
  results: Record<string, StepResult>;
  attempts: Record<string, number>;
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
      type: "step_retrying";
      runId: string;
      stepId: string;
      role: AgentRole;
      attempt: number;
      reason: string;
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
    const startedAt = Date.now();
    const saved = await this.options.checkpoint?.load();
    const state = saved
      ? restoreState(saved, plan)
      : createState(plan, this.options.runId ?? randomUUID(), startedAt);

    if (state.stage === "completed") return state;
    await this.emit({
      type: "orchestration_started",
      runId: state.runId,
      objective: plan.objective,
    });
    await this.save(state);

    try {
      while (state.completedStepIds.length < plan.steps.length) {
        this.checkLimits(state, startedAt);
        const step = nextReadyStep(plan, state);
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
        const previousResults = plan.steps
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
          startedAt,
        );

        if (!result) return state;
        state.results[step.id] = result;
        state.completedStepIds.push(step.id);
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
    let previousFailureKey: string | undefined;
    for (
      let attempt = 1;
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
      const failureKey = result.success
        ? undefined
        : (result.progressKey ?? `${result.summary}:${result.output ?? ""}`);
      const passed = step.role === "verifier" ? result.passed === true : true;

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
      if (failureKey && failureKey === previousFailureKey) {
        await this.fail(
          state,
          `Step "${step.id}" is stuck repeating the same failure: ${reason}`,
        );
        return undefined;
      }
      previousFailureKey = failureKey;
      if (attempt < this.options.maxAttemptsPerStep) {
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
  const stepIds = new Set(plan.steps.map((step) => step.id));
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
  };
}

function nextReadyStep(
  plan: OrchestrationPlan,
  state: OrchestrationState,
): OrchestrationStep | undefined {
  return plan.steps.find(
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
  if (plan.steps.length === 0)
    throw new Error("An orchestration plan requires at least one step.");

  const ids = new Set<string>();
  for (const step of plan.steps) {
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
      if (!plan.steps.some((candidate) => candidate.id === dependency)) {
        throw new Error(
          `Step "${step.id}" depends on unknown step "${dependency}".`,
        );
      }
    }
  }
}
