import { randomUUID } from "node:crypto";
import type { AgentEvent } from "./events.js";
import type { ConversationMessage } from "./messages.js";
import { AgentRunner } from "./agent.js";
import type { LanguageModel } from "./model.js";
import type { Tool, ToolResult } from "./tools.js";
import { ToolRegistry } from "./tool-registry.js";

export interface AgentDefinition {
  id: string;
  name: string;
  description: string;
  systemPrompt: string;
  capabilities: string[];
  allowedTools?: string[];
  delegatesTo?: string;
  maxSteps?: number;
  enabled: boolean;
}

export interface AgentRegistry {
  getAgent(
    id: string,
  ): AgentDefinition | undefined | Promise<AgentDefinition | undefined>;
  listAgents(): AgentDefinition[] | Promise<AgentDefinition[]>;
}

export type AgentModelResolver = (
  agent: AgentDefinition,
) => LanguageModel | Promise<LanguageModel>;

export type AgentToolResolver = (
  agent: AgentDefinition,
) => ToolRegistry | Promise<ToolRegistry>;

export interface AgentHandoff {
  targetAgentId: string;
  task: string;
  context?: string;
  reason?: string;
}

export interface MultiAgentResult {
  runId: string;
  agentId: string;
  text: string;
  status: "completed" | "failed";
  handoffs: number;
  messages?: ConversationMessage[];
}

export interface MultiAgentEvent {
  type:
    | "agent_started"
    | "agent_completed"
    | "agent_failed"
    | "handoff_requested"
    | "handoff_completed"
    | "handoff_rejected"
    | "agent_event";
  runId: string;
  agentId: string;
  parentAgentId?: string;
  depth: number;
  task?: string;
  targetAgentId?: string;
  reason?: string;
  output?: string;
  agentEvent?: AgentEvent;
}

export interface MultiAgentOptions {
  cwd: string;
  requestApproval: ConstructorParameters<
    typeof AgentRunner
  >[2]["requestApproval"];
  maxDepth?: number;
  maxHandoffs?: number;
  maxHandoffsPerPair?: number;
  maxModelSteps?: number;
  maxDurationMs?: number;
  signal?: AbortSignal;
  onEvent?: (event: MultiAgentEvent) => void | Promise<void>;
}

interface RunState {
  runId: string;
  handoffs: number;
  modelSteps: number;
  startedAt: number;
  activeSignatures: Set<string>;
  handoffPairCounts: Map<string, number>;
}

export class MultiAgentOrchestrator {
  private readonly maxDepth: number;
  private readonly maxHandoffs: number;
  private readonly maxHandoffsPerPair: number;
  private readonly maxModelSteps: number;
  private readonly maxDurationMs: number;

  constructor(
    private readonly registry: AgentRegistry,
    private readonly resolveModel: AgentModelResolver,
    private readonly resolveTools: AgentToolResolver,
    private readonly options: MultiAgentOptions,
  ) {
    this.maxDepth = options.maxDepth ?? 6;
    this.maxHandoffs = options.maxHandoffs ?? 8;
    this.maxHandoffsPerPair = options.maxHandoffsPerPair ?? 2;
    this.maxModelSteps = options.maxModelSteps ?? 36;
    this.maxDurationMs = options.maxDurationMs ?? 15 * 60_000;
    if (this.maxDepth < 0) throw new Error("maxDepth cannot be negative.");
    if (this.maxHandoffs < 1)
      throw new Error("maxHandoffs must be at least 1.");
    if (this.maxHandoffsPerPair < 1)
      throw new Error("maxHandoffsPerPair must be at least 1.");
    if (this.maxModelSteps < 1)
      throw new Error("maxModelSteps must be at least 1.");
    if (this.maxDurationMs < 1)
      throw new Error("maxDurationMs must be at least 1.");
  }

  async run(
    agentId: string,
    task: string,
    context = "",
    history: readonly ConversationMessage[] = [],
  ): Promise<MultiAgentResult> {
    if (!task.trim()) throw new Error("An agent task is required.");
    const state: RunState = {
      runId: randomUUID(),
      handoffs: 0,
      modelSteps: 0,
      startedAt: Date.now(),
      activeSignatures: new Set(),
      handoffPairCounts: new Map(),
    };
    return this.runAgent(state, agentId, task, context, undefined, 0, history);
  }

  private async runAgent(
    state: RunState,
    agentId: string,
    task: string,
    context: string,
    parentAgentId: string | undefined,
    depth: number,
    history: readonly ConversationMessage[] = [],
  ): Promise<MultiAgentResult> {
    this.checkLimits(state, depth);
    const agent = await this.registry.getAgent(agentId);
    if (!agent) {
      return this.failedResult(
        state,
        agentId,
        depth,
        `Agent not found: ${agentId}`,
      );
    }
    if (!agent.enabled) {
      return this.failedResult(
        state,
        agentId,
        depth,
        `Agent is disabled: ${agentId}`,
      );
    }

    await this.emit({
      type: "agent_started",
      runId: state.runId,
      agentId,
      parentAgentId,
      depth,
      task,
    });

    const model = await this.resolveModel(agent);
    const tools = this.scopeTools(
      agent,
      await this.resolveTools(agent),
      state,
      agentId,
      depth,
    );
    if (!tools.has("handoff_agent")) {
      tools.register(this.createHandoffTool(state, agentId, depth));
    }
    const messages: ConversationMessage[] = [
      { role: "system", content: agent.systemPrompt },
      ...history,
      {
        role: "user",
        content: context
          ? `${task}\n\nContext from the parent workflow:\n${context}`
          : task,
      },
    ];
    const runner = new AgentRunner(model, tools, {
      cwd: this.options.cwd,
      maxSteps: agent.maxSteps,
      requestApproval: this.options.requestApproval,
      signal: this.options.signal,
      beforeModelRequest: () => this.consumeModelStep(state),
      onEvent: async (event) => {
        await this.options.onEvent?.({
          type: "agent_event",
          runId: state.runId,
          agentId,
          parentAgentId,
          depth,
          output: "text" in event ? event.text : undefined,
          agentEvent: event,
        });
      },
    });
    const result = await runner.run(messages);
    await this.emit({
      type: result.text.includes("safety limit")
        ? "agent_failed"
        : "agent_completed",
      runId: state.runId,
      agentId,
      parentAgentId,
      depth,
      output: result.text,
    });
    return {
      runId: state.runId,
      agentId,
      text: result.text,
      status: result.text.includes("safety limit") ? "failed" : "completed",
      handoffs: state.handoffs,
      messages,
    };
  }

  private scopeTools(
    agent: AgentDefinition,
    available: ToolRegistry,
    state: RunState,
    parentAgentId: string,
    parentDepth: number,
  ): ToolRegistry {
    const scoped = new ToolRegistry();
    for (const definition of available.list()) {
      const tool = available.get(definition.name);
      if (!tool) continue;
      if (
        !agent.allowedTools ||
        agent.allowedTools.includes(definition.name) ||
        definition.name === "handoff_agent"
      ) {
        scoped.register(tool);
      } else if (agent.delegatesTo) {
        scoped.registerHidden(
          this.createDelegationProxy(
            tool,
            state,
            parentAgentId,
            parentDepth,
            agent.delegatesTo,
          ),
        );
      }
    }
    return scoped;
  }

  private createDelegationProxy(
    tool: Tool,
    state: RunState,
    parentAgentId: string,
    parentDepth: number,
    targetAgentId: string,
  ): Tool {
    return {
      name: tool.name,
      description: `${tool.description} This action is delegated automatically to ${targetAgentId}; do not perform it directly in this agent.`,
      parameters: tool.parameters,
      approval: "auto",
      execute: async (arguments_) => {
        const result = await this.executeHandoff(
          state,
          parentAgentId,
          parentDepth,
          {
            targetAgentId,
            task: `Perform the delegated ${tool.name} operation with these arguments: ${JSON.stringify(arguments_)}`,
            context: `The parent agent requested the ${tool.name} operation. Execute it using your available tools and return the concrete result.`,
            reason: `${parentAgentId} is restricted from ${tool.name}.`,
          },
        );
        return {
          output: JSON.stringify({
            agentId: result.agentId,
            status: result.status,
            summary: result.text,
          }),
          isError: result.status === "failed",
        };
      },
    };
  }

  private createHandoffTool(
    state: RunState,
    parentAgentId: string,
    parentDepth: number,
  ): Tool {
    return {
      name: "handoff_agent",
      description:
        "Delegate a focused task to another registered agent. Use this when a specialist is better suited for the work.",
      approval: "auto",
      parameters: {
        type: "object",
        properties: {
          targetAgentId: { type: "string" },
          task: { type: "string" },
          context: { type: "string" },
          reason: { type: "string" },
        },
        required: ["targetAgentId", "task"],
        additionalProperties: false,
      },
      execute: async (arguments_) => {
        const handoff = arguments_ as unknown as AgentHandoff;
        const result = await this.executeHandoff(
          state,
          parentAgentId,
          parentDepth,
          handoff,
        );
        return {
          output: JSON.stringify({
            agentId: result.agentId,
            status: result.status,
            summary: result.text,
          }),
          isError: result.status === "failed",
        };
      },
    };
  }

  private async executeHandoff(
    state: RunState,
    parentAgentId: string,
    parentDepth: number,
    handoff: AgentHandoff,
  ): Promise<MultiAgentResult> {
    const signature = `${parentAgentId}:${handoff.targetAgentId}:${handoff.task}`;
    const pair = `${parentAgentId}:${handoff.targetAgentId}`;
    const pairCount = state.handoffPairCounts.get(pair) ?? 0;
    if (state.handoffs >= this.maxHandoffs) {
      return this.failedResult(
        state,
        handoff.targetAgentId,
        parentDepth + 1,
        "The maximum handoff budget has been reached.",
      );
    }
    if (pairCount >= this.maxHandoffsPerPair) {
      return this.failedResult(
        state,
        handoff.targetAgentId,
        parentDepth + 1,
        `The ${parentAgentId} -> ${handoff.targetAgentId} handoff limit has been reached. Do not retry verification with reworded tasks.`,
      );
    }
    if (state.activeSignatures.has(signature)) {
      return this.failedResult(
        state,
        handoff.targetAgentId,
        parentDepth + 1,
        "The same handoff is already active and would create a loop.",
      );
    }

    state.handoffs += 1;
    state.handoffPairCounts.set(pair, pairCount + 1);
    state.activeSignatures.add(signature);
    await this.emit({
      type: "handoff_requested",
      runId: state.runId,
      agentId: parentAgentId,
      parentAgentId,
      depth: parentDepth,
      targetAgentId: handoff.targetAgentId,
      task: handoff.task,
      reason: handoff.reason,
    });
    try {
      const result = await this.runAgent(
        state,
        handoff.targetAgentId,
        handoff.task,
        handoff.context ?? "",
        parentAgentId,
        parentDepth + 1,
        [],
      );
      await this.emit({
        type: "handoff_completed",
        runId: state.runId,
        agentId: parentAgentId,
        parentAgentId,
        depth: parentDepth,
        targetAgentId: handoff.targetAgentId,
        output: result.text,
      });
      return result;
    } finally {
      state.activeSignatures.delete(signature);
    }
  }

  private rejectedHandoff(
    state: RunState,
    agentId: string,
    depth: number,
    reason: string,
  ): ToolResult {
    void this.emit({
      type: "handoff_rejected",
      runId: state.runId,
      agentId,
      depth,
      reason,
    });
    return { output: reason, isError: true };
  }

  private consumeModelStep(state: RunState): void {
    this.checkRunBudget(state);
    if (state.modelSteps >= this.maxModelSteps) {
      throw new Error(
        `Multi-agent run exceeded its global ${this.maxModelSteps}-model-step budget.`,
      );
    }
    state.modelSteps += 1;
  }

  private checkLimits(state: RunState, depth: number): void {
    this.checkRunBudget(state);
    if (depth > this.maxDepth) {
      throw new Error(
        `Maximum agent handoff depth (${this.maxDepth}) exceeded.`,
      );
    }
  }

  private checkRunBudget(state: RunState): void {
    if (this.options.signal?.aborted)
      throw new Error("Multi-agent run cancelled.");
    if (Date.now() - state.startedAt >= this.maxDurationMs) {
      throw new Error(
        `Multi-agent run exceeded its ${this.maxDurationMs}-millisecond time budget.`,
      );
    }
  }

  private async failedResult(
    state: RunState,
    agentId: string,
    depth: number,
    reason: string,
  ): Promise<MultiAgentResult> {
    await this.emit({
      type: "agent_failed",
      runId: state.runId,
      agentId,
      depth,
      output: reason,
    });
    return {
      runId: state.runId,
      agentId,
      text: reason,
      status: "failed",
      handoffs: state.handoffs,
    };
  }

  private async emit(event: MultiAgentEvent): Promise<void> {
    await this.options.onEvent?.(event);
  }
}
