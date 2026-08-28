import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { test } from "node:test";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  AgentRunner,
  ModelError,
  MultiAgentOrchestrator,
  TaskOrchestrator,
  ToolRegistry,
  type AgentEvent,
  type LanguageModel,
  type ModelRequest,
  type ModelResponse,
  type Tool,
} from "../packages/core/dist/index.js";
import { executeCommand } from "../packages/command/dist/index.js";
import { parseJsonToolCalls } from "../packages/ollama/dist/index.js";
import { findFiles, searchText } from "../packages/search/dist/index.js";
import {
  createTaskCheckpointStore,
  loadProjectAgents,
  SessionStore,
} from "../packages/session/dist/index.js";
import {
  createGitTools,
  assertSafeGitPaths,
  createIdeTools,
  createWebTools,
} from "../packages/tools/dist/index.js";
import { WorkspaceFileService } from "../packages/workspace/dist/index.js";
import { SemanticRetrievalIndex } from "../packages/retrieval/dist/index.js";
import {
  OpenRouterProvider,
  ProviderGateway,
  ProviderRegistry,
  StoredCredentialResolver,
} from "../packages/gateway/dist/index.js";
import {
  CODING_AGENT_ID,
  createDefaultAgents,
  DEFAULT_AGENT_ID,
  HeadlessRuntimeService,
  REVIEWER_AGENT_ID,
  VERIFIER_AGENT_ID,
  type RuntimeEvent,
} from "../packages/runtime/dist/index.js";
import {
  initialTuiState,
  reduceTuiState,
} from "../packages/tui/dist/ui-state.js";
import { resolveWorkspaceRoot } from "../packages/tui/dist/workspace.js";

class FakeModel implements LanguageModel {
  private index = 0;

  constructor(private readonly responses: ModelResponse[]) {}

  respond(): Promise<ModelResponse> {
    const response = this.responses[this.index];
    this.index += 1;
    if (!response) {
      throw new Error("Fake model ran out of responses.");
    }
    return Promise.resolve(response);
  }
}

function assistantResponse(
  text: string,
  toolCalls: ModelResponse["toolCalls"] = [],
): ModelResponse {
  return {
    message: { role: "assistant", content: text, toolCalls },
    text,
    toolCalls,
  };
}

function completedStep(
  stepId: string,
  role: "planner" | "retriever" | "coder" | "verifier" | "reviewer",
  summary: string,
) {
  return {
    stepId,
    role,
    success: true,
    summary,
    attempts: 1,
    completedAt: Date.now(),
  };
}

function echoTool(): Tool {
  return {
    name: "echo",
    description: "Return the provided value.",
    parameters: {
      type: "object",
      properties: { value: { type: "string" } },
      required: ["value"],
      additionalProperties: false,
    },
    execute: async (arguments_) => ({
      output: String(arguments_.value),
    }),
  };
}

test("ToolRegistry rejects duplicates and hides internal tools from model schemas", () => {
  const registry = new ToolRegistry().register(echoTool()).registerHidden({
    ...echoTool(),
    name: "hidden_echo",
  });

  assert.equal(registry.has("echo"), true);
  assert.equal(registry.has("hidden_echo"), true);
  assert.deepEqual(
    registry.list().map((tool) => tool.name),
    ["echo"],
  );
  assert.throws(() => registry.register(echoTool()), /already registered/);
});

test("TUI state reducer tracks model, tool, handoff, and approval activity", () => {
  const started = reduceTuiState(initialTuiState, {
    type: "task_started",
    taskId: "task-1",
    sessionId: "session-1",
    agentId: "general",
    maxSteps: 24,
  });
  const requested = reduceTuiState(started, {
    type: "agent_event",
    agentId: "general",
    event: {
      type: "tool_requested",
      call: { id: "call-1", name: "git_status", arguments: {} },
    },
  });
  const approval = reduceTuiState(requested, {
    type: "approval_requested",
    call: {
      id: "call-2",
      name: "git_push",
      arguments: { remote: "origin", branch: "main" },
    },
  });
  const resolved = reduceTuiState(approval, {
    type: "approval_resolved",
    approved: true,
  });
  const switchedSession = reduceTuiState(resolved, {
    type: "session_changed",
    sessionId: "session-2",
  });
  const switchedAgent = reduceTuiState(switchedSession, {
    type: "agent_changed",
    agentId: "reviewer",
  });

  assert.equal(requested.toolActivities[0]?.status, "running");
  assert.equal(approval.status, "approval");
  assert.equal(resolved.approval, undefined);
  assert.equal(resolved.status, "tool");
  assert.equal(switchedAgent.sessionId, "session-2");
  assert.equal(switchedAgent.activeAgentId, "reviewer");
});

test("TUI reducer selects individual approval hunks and tracks pipeline retries", () => {
  const preview = {
    kind: "file_diff" as const,
    path: "file.ts",
    baseHash: "base",
    proposedHash: "proposal",
    text: "diff",
    hunks: [
      {
        id: "h1:first",
        path: "file.ts",
        startLine: 1,
        endLine: 2,
        original: "a\n",
        replacement: "A\n",
      },
      {
        id: "h1:second",
        path: "file.ts",
        startLine: 5,
        endLine: 6,
        original: "b\n",
        replacement: "B\n",
      },
    ],
  };
  const requested = reduceTuiState(initialTuiState, {
    type: "approval_requested",
    call: { id: "patch", name: "apply_patch", arguments: {} },
    preview,
  });
  const toggled = reduceTuiState(requested, {
    type: "approval_hunk_toggled",
  });
  const retrying = reduceTuiState(toggled, {
    type: "pipeline_event",
    event: {
      type: "step_retrying",
      runId: "run",
      stepId: "verify",
      role: "verifier",
      attempt: 1,
      reason: "tests failed",
    },
  });

  assert.deepEqual(toggled.approval?.selectedHunkIds, ["h1:second"]);
  assert.equal(retrying.status, "thinking");
  assert.match(retrying.lastProgress ?? "", /Retrying verify/);
});

test("TUI resolves an explicit workspace root and rejects invalid sandbox paths", async () => {
  const root = await mkdtemp(join(tmpdir(), "agentic-tui-workspace-"));
  try {
    assert.equal(resolveWorkspaceRoot([root]), root);
    assert.equal(resolveWorkspaceRoot(["--", root]), root);
    assert.throws(
      () => resolveWorkspaceRoot([join(root, "missing")]),
      /does not exist/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("ProviderGateway discovers, selects, and executes an OpenRouter model without logging credentials", async () => {
  const events: string[] = [];
  const secret = "secret-not-for-events";
  const fetcher: typeof fetch = async (input, init) => {
    assert.equal(input, "https://openrouter.ai/api/v1/models");
    assert.equal(
      (init?.headers as Record<string, string>).Authorization,
      `Bearer ${secret}`,
    );
    return new Response(
      JSON.stringify({
        data: [
          {
            id: "acme/model",
            name: "Acme Model",
            context_length: 32768,
            supported_parameters: ["tools", "response_format"],
            pricing: { prompt: "0.000001", completion: "0.000002" },
          },
        ],
      }),
      { status: 200 },
    );
  };
  const provider = new OpenRouterProvider({ get: () => secret }, fetcher);
  const gateway = new ProviderGateway(
    new ProviderRegistry().register(provider),
    (event) => events.push(JSON.stringify(event)),
  );
  gateway.configure({
    providerId: "openrouter",
    credentialRef: "OPENROUTER_API_KEY",
  });
  const models = await gateway.discover("openrouter");
  const selected = gateway.select("openrouter", "acme/model");

  assert.equal(models[0]?.contextWindow, 32768);
  assert.equal(models[0]?.pricing?.inputPerMillion, 1);
  assert.equal(selected.capabilities.tools, true);
  assert.equal(gateway.getSelected()?.id, "acme/model");
  assert.ok(events.some((event) => event.includes("model_selected")));
  assert.equal(
    events.some((event) => event.includes(secret)),
    false,
  );
});

test("StoredCredentialResolver prefers the settings store over the env fallback", () => {
  const store = new Map([["groq", "stored-key"]]);
  const resolver = new StoredCredentialResolver(
    { getCredential: (id) => store.get(id) },
    { groq: "GROQ_API_KEY", openrouter: "OPENROUTER_API_KEY" },
  );
  assert.equal(resolver.get("groq"), "stored-key");

  process.env.OPENROUTER_API_KEY = "env-key";
  try {
    assert.equal(resolver.get("openrouter"), "env-key");
  } finally {
    delete process.env.OPENROUTER_API_KEY;
  }
  assert.equal(resolver.get("openrouter"), undefined);
});

test("AgentRunner executes a tool and continues to a final response", async () => {
  const call = { id: "call-1", name: "echo", arguments: { value: "hello" } };
  const registry = new ToolRegistry().register(echoTool());
  const model = new FakeModel([
    assistantResponse("", [call]),
    assistantResponse("The tool returned hello."),
  ]);
  const approved: string[] = [];
  const messages = [{ role: "user" as const, content: "Say hello." }];

  const result = await new AgentRunner(model, registry, {
    cwd: process.cwd(),
    requestApproval: async (requestedCall) => {
      approved.push(requestedCall.name);
      return true;
    },
  }).run(messages);

  assert.equal(result.text, "The tool returned hello.");
  assert.deepEqual(approved, ["echo"]);
  assert.equal(result.messages.at(-1)?.role, "assistant");
  assert.equal(result.messages.at(-2)?.role, "tool");
});

test("AgentRunner returns a denied tool result to the model", async () => {
  const call = { id: "call-2", name: "echo", arguments: { value: "secret" } };
  const registry = new ToolRegistry().register(echoTool());
  const model = new FakeModel([
    assistantResponse("", [call]),
    assistantResponse("I could not run the tool."),
  ]);
  const messages = [{ role: "user" as const, content: "Run it." }];

  const result = await new AgentRunner(model, registry, {
    cwd: process.cwd(),
    requestApproval: async () => false,
  }).run(messages);

  const toolMessage = result.messages.at(-2);
  assert.equal(toolMessage?.role, "tool");
  assert.match(toolMessage?.content ?? "", /denied by the user/);
});

test("AgentRunner auto-approves explicitly read-only tools", async () => {
  const registry = new ToolRegistry().register({
    ...echoTool(),
    approval: "auto",
  });
  const model = new FakeModel([
    assistantResponse("", [
      { id: "call-auto", name: "echo", arguments: { value: "safe" } },
    ]),
    assistantResponse("The read-only tool completed."),
  ]);
  let approvalRequests = 0;

  const result = await new AgentRunner(model, registry, {
    cwd: process.cwd(),
    requestApproval: async () => {
      approvalRequests += 1;
      return false;
    },
  }).run([{ role: "user", content: "Inspect it." }]);

  assert.equal(approvalRequests, 0);
  assert.equal(result.text, "The read-only tool completed.");
});

test("AgentRunner reports the tool step limit without throwing", async () => {
  const call = { id: "call-3", name: "echo", arguments: { value: "loop" } };
  const registry = new ToolRegistry().register(echoTool());
  const model = new FakeModel([
    assistantResponse("", [call]),
    assistantResponse("", [call]),
  ]);

  const result = await new AgentRunner(model, registry, {
    cwd: process.cwd(),
    maxSteps: 1,
    requestApproval: async () => true,
  }).run([{ role: "user", content: "Loop." }]);

  assert.match(result.text, /1-step safety limit/);
});

test("AgentRunner skips a repeated identical tool call and lets the model finish", async () => {
  let executions = 0;
  const call = { id: "call-4", name: "echo", arguments: { value: "repeat" } };
  const registry = new ToolRegistry().register({
    ...echoTool(),
    execute: async () => {
      executions += 1;
      return { output: "repeat" };
    },
  });
  const model = new FakeModel([
    assistantResponse("", [call]),
    assistantResponse("", [{ ...call, id: "call-5" }]),
    assistantResponse("Used the earlier result without reading again."),
  ]);

  const result = await new AgentRunner(model, registry, {
    cwd: process.cwd(),
    requestApproval: async () => true,
  }).run([{ role: "user", content: "Repeat." }]);

  assert.equal(executions, 1);
  assert.equal(result.text, "Used the earlier result without reading again.");
  assert.ok(
    result.messages.some(
      (message) =>
        message.role === "tool" &&
        message.content.includes("Duplicate echo call skipped"),
    ),
  );
});

test("AgentRunner detects alternating duplicate calls without duplicating large results", async () => {
  let executions = 0;
  const registry = new ToolRegistry().register({
    ...echoTool(),
    execute: async (arguments_) => {
      executions += 1;
      return { output: `${String(arguments_.value)}:${"x".repeat(3_000)}` };
    },
  });
  const firstCalls = [
    { id: "a-1", name: "echo", arguments: { value: "a" } },
    { id: "b-1", name: "echo", arguments: { value: "b" } },
  ];
  const model = new FakeModel([
    assistantResponse("", firstCalls),
    assistantResponse(
      "",
      firstCalls.map((call) => ({ ...call, id: `${call.id}-duplicate` })),
    ),
    assistantResponse("Finished from the original results."),
  ]);

  const result = await new AgentRunner(model, registry, {
    cwd: process.cwd(),
    requestApproval: async () => true,
  }).run([{ role: "user", content: "Inspect A and B once." }]);

  assert.equal(executions, 2);
  assert.equal(result.text, "Finished from the original results.");
  const duplicateMessages = result.messages.filter(
    (message) =>
      message.role === "tool" &&
      message.content.includes("Duplicate echo call skipped"),
  );
  assert.equal(duplicateMessages.length, 2);
  assert.ok(duplicateMessages.every((message) => message.content.length < 300));
});

test("AgentRunner continues an interrupted edit and verification workflow", async () => {
  const registry = new ToolRegistry();
  for (const name of ["read_file", "apply_patch", "compile_code"]) {
    registry.register({
      name,
      description: name,
      parameters: { type: "object", additionalProperties: true },
      execute: async () => ({
        output: `${name} completed`,
        changed: name === "apply_patch" ? true : undefined,
      }),
    });
  }
  const model = new FakeModel([
    assistantResponse("", [
      { id: "read-1", name: "read_file", arguments: { path: "file.ts" } },
    ]),
    assistantResponse("I inspected the file."),
    assistantResponse("", [
      {
        id: "patch-1",
        name: "apply_patch",
        arguments: { path: "file.ts", oldContent: "a", newContent: "b" },
      },
    ]),
    assistantResponse("The edit is complete."),
    assistantResponse("", [
      { id: "read-2", name: "read_file", arguments: { path: "file.ts" } },
    ]),
    assistantResponse("The file is verified."),
    assistantResponse("", [
      { id: "build-1", name: "compile_code", arguments: { command: "build" } },
    ]),
    assistantResponse("Build completed successfully."),
  ]);

  const result = await new AgentRunner(model, registry, {
    cwd: process.cwd(),
    requestApproval: async () => true,
  }).run([
    {
      role: "user",
      content:
        "Read file.ts, add the requested change using apply_patch, read the file again to verify it, and run the build.",
    },
  ]);

  assert.equal(result.text, "Build completed successfully.");
});

test("TaskOrchestrator runs dependent steps in order and checkpoints progress", async () => {
  const calls: string[] = [];
  const checkpoints: string[][] = [];
  const worker = async ({ step }: { step: { id: string } }) => {
    calls.push(step.id);
    return {
      success: true,
      summary: `${step.id} complete`,
      passed: step.id === "verify" ? true : undefined,
    };
  };
  const orchestrator = new TaskOrchestrator(
    { researcher: worker, coder: worker, verifier: worker },
    {
      runId: "run-order",
      checkpoint: {
        load: async () => undefined,
        save: async (state) => {
          checkpoints.push([...state.completedStepIds]);
        },
      },
    },
  );

  const state = await orchestrator.run({
    objective: "Implement and verify the change.",
    steps: [
      {
        id: "research",
        role: "researcher",
        title: "Research",
        prompt: "Inspect the code.",
      },
      {
        id: "code",
        role: "coder",
        title: "Code",
        prompt: "Implement the change.",
        dependsOn: ["research"],
      },
      {
        id: "verify",
        role: "verifier",
        title: "Verify",
        prompt: "Run checks.",
        dependsOn: ["code"],
      },
    ],
  });

  assert.deepEqual(calls, ["research", "code", "verify"]);
  assert.deepEqual(state.completedStepIds, ["research", "code", "verify"]);
  assert.equal(state.stage, "completed");
  assert.ok(checkpoints.some((completed) => completed.length === 1));
});

test("TaskOrchestrator retries a failed worker within its limit", async () => {
  let attempts = 0;
  const orchestrator = new TaskOrchestrator(
    {
      coder: async () => {
        attempts += 1;
        return attempts === 1
          ? { success: false, summary: "transient failure" }
          : { success: true, summary: "fixed" };
      },
    },
    { runId: "run-retry", maxAttemptsPerStep: 2 },
  );

  const state = await orchestrator.run({
    objective: "Retry this implementation.",
    steps: [{ id: "code", role: "coder", title: "Code", prompt: "Implement." }],
  });

  assert.equal(attempts, 2);
  assert.equal(state.results.code?.attempts, 2);
  assert.equal(state.stage, "completed");
});

test("TaskOrchestrator stops a repeated failure instead of looping", async () => {
  let attempts = 0;
  const orchestrator = new TaskOrchestrator(
    {
      coder: async () => {
        attempts += 1;
        return {
          success: false,
          summary: "same failure",
          progressKey: "same-failure",
        };
      },
    },
    { runId: "run-stuck", maxAttemptsPerStep: 5 },
  );

  const state = await orchestrator.run({
    objective: "Stop when stuck.",
    steps: [{ id: "code", role: "coder", title: "Code", prompt: "Implement." }],
  });

  assert.equal(attempts, 2);
  assert.equal(state.stage, "failed");
  assert.match(state.failure ?? "", /stuck repeating/);
});

test("MultiAgentOrchestrator hands work to a registered specialist", async () => {
  const agents = [
    {
      id: "lead",
      name: "Lead",
      description: "Coordinates work.",
      systemPrompt: "You coordinate work.",
      capabilities: ["delegation"],
      enabled: true,
    },
    {
      id: "network",
      name: "Network specialist",
      description: "Investigates network details.",
      systemPrompt: "You investigate network details.",
      capabilities: ["network"],
      enabled: true,
    },
  ];
  const events: string[] = [];
  const models = new Map([
    [
      "lead",
      new FakeModel([
        assistantResponse("", [
          {
            id: "handoff-1",
            name: "handoff_agent",
            arguments: {
              targetAgentId: "network",
              task: "Inspect the network configuration.",
              context: "The user needs details.",
              reason: "The network specialist is better suited.",
            },
          },
        ]),
        assistantResponse("The specialist reported successfully."),
      ]),
    ],
    ["network", new FakeModel([assistantResponse("Network details found.")])],
  ]);
  const runtime = new MultiAgentOrchestrator(
    {
      getAgent: (id) => agents.find((agent) => agent.id === id),
      listAgents: () => agents,
    },
    (agent) => models.get(agent.id)!,
    () => new ToolRegistry(),
    {
      cwd: process.cwd(),
      requestApproval: async () => {
        throw new Error("Agent handoffs must not ask for user approval.");
      },
      onEvent: (event) => {
        events.push(`${event.type}:${event.agentId}`);
      },
    },
  );

  const result = await runtime.run("lead", "Get network details.");

  assert.equal(result.status, "completed");
  assert.equal(result.handoffs, 1);
  assert.match(result.text, /specialist reported/);
  assert.ok(events.includes("agent_started:network"));
  assert.ok(events.includes("handoff_completed:lead"));
});

test("MultiAgentOrchestrator enforces a global model-step budget across handoffs", async () => {
  const agents = [
    {
      id: "lead",
      name: "Lead",
      description: "Coordinates work.",
      systemPrompt: "Delegate once, then finish.",
      capabilities: ["delegation"],
      enabled: true,
    },
    {
      id: "worker",
      name: "Worker",
      description: "Does focused work.",
      systemPrompt: "Complete the task.",
      capabilities: ["work"],
      enabled: true,
    },
  ];
  const models = new Map([
    [
      "lead",
      new FakeModel([
        assistantResponse("", [
          {
            id: "budget-handoff",
            name: "handoff_agent",
            arguments: { targetAgentId: "worker", task: "Do the work." },
          },
        ]),
        assistantResponse("Lead finished."),
      ]),
    ],
    ["worker", new FakeModel([assistantResponse("Worker finished.")])],
  ]);
  const runtime = new MultiAgentOrchestrator(
    {
      getAgent: (id) => agents.find((agent) => agent.id === id),
      listAgents: () => agents,
    },
    (agent) => models.get(agent.id)!,
    () => new ToolRegistry(),
    {
      cwd: process.cwd(),
      maxModelSteps: 2,
      requestApproval: async () => true,
    },
  );

  await assert.rejects(
    runtime.run("lead", "Complete the task."),
    /global 2-model-step budget/,
  );
});

test("MultiAgentOrchestrator rejects reworded handoff loops between the same pair", async () => {
  const agents = [
    {
      id: "coder",
      name: "Coder",
      description: "Implements work.",
      systemPrompt: "Ask the reviewer to verify.",
      capabilities: ["coding"],
      enabled: true,
    },
    {
      id: "reviewer",
      name: "Reviewer",
      description: "Verifies work.",
      systemPrompt: "Return a verification result.",
      capabilities: ["review"],
      enabled: true,
    },
  ];
  const models = new Map([
    [
      "coder",
      new FakeModel([
        assistantResponse("", [
          {
            id: "review-1",
            name: "handoff_agent",
            arguments: { targetAgentId: "reviewer", task: "Review pass one." },
          },
        ]),
        assistantResponse("", [
          {
            id: "review-2",
            name: "handoff_agent",
            arguments: { targetAgentId: "reviewer", task: "Review pass two." },
          },
        ]),
        assistantResponse("", [
          {
            id: "review-3",
            name: "handoff_agent",
            arguments: {
              targetAgentId: "reviewer",
              task: "Review pass three.",
            },
          },
        ]),
        assistantResponse("Stopped retrying verification."),
      ]),
    ],
    [
      "reviewer",
      new FakeModel([
        assistantResponse("First review complete."),
        assistantResponse("Second review complete."),
      ]),
    ],
  ]);
  const result = await new MultiAgentOrchestrator(
    {
      getAgent: (id) => agents.find((agent) => agent.id === id),
      listAgents: () => agents,
    },
    (agent) => models.get(agent.id)!,
    () => new ToolRegistry(),
    {
      cwd: process.cwd(),
      maxHandoffsPerPair: 2,
      requestApproval: async () => true,
    },
  ).run("coder", "Coordinate the review cycle.");

  assert.equal(result.handoffs, 2);
  assert.equal(result.text, "Stopped retrying verification.");
  assert.ok(
    result.messages?.some(
      (message) =>
        message.role === "tool" &&
        message.content.includes("handoff limit has been reached"),
    ),
  );
});

test("MultiAgentOrchestrator proxies blocked tools to the configured delegate", async () => {
  const agents = [
    {
      id: "general",
      name: "General",
      description: "Coordinates work.",
      systemPrompt: "Delegate blocked operations.",
      capabilities: ["delegation"],
      allowedTools: [],
      delegatesTo: "coder",
      enabled: true,
    },
    {
      id: "coder",
      name: "Coder",
      description: "Writes code.",
      systemPrompt: "Perform the requested operation.",
      capabilities: ["coding"],
      enabled: true,
    },
  ];
  const models = new Map([
    [
      "general",
      new FakeModel([
        assistantResponse("", [
          {
            id: "blocked-write",
            name: "write_file",
            arguments: { path: "tmp/example.py", content: "print('ok')" },
          },
        ]),
        assistantResponse("The coding agent completed the write."),
      ]),
    ],
    ["coder", new FakeModel([assistantResponse("File written.")])],
  ]);
  const tools = new ToolRegistry().register({
    name: "write_file",
    description: "Write a file.",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string" },
        content: { type: "string" },
      },
      required: ["path", "content"],
      additionalProperties: false,
    },
    approval: "auto",
    execute: async () => ({ output: "File written." }),
  });

  let generalToolCount: number | undefined;
  const result = await new MultiAgentOrchestrator(
    {
      getAgent: (id) => agents.find((agent) => agent.id === id),
      listAgents: () => agents,
    },
    (agent) => models.get(agent.id)!,
    () => tools,
    {
      cwd: process.cwd(),
      requestApproval: async () => {
        throw new Error("The delegation proxy should not request approval.");
      },
      onEvent: (event) => {
        if (
          event.type === "agent_event" &&
          event.agentId === "general" &&
          event.agentEvent?.type === "model_request"
        ) {
          generalToolCount = event.agentEvent.toolCount;
        }
      },
    },
  ).run("general", "Create the file.");

  assert.equal(generalToolCount, 1);
  assert.equal(result.status, "completed");
  assert.equal(result.handoffs, 1);
  assert.match(result.text, /coding agent completed/);
});

test("createIdeTools exposes the separate IDE tool catalog", () => {
  assert.deepEqual(
    createIdeTools().map((tool) => tool.name),
    [
      "browse_url",
      "crawl_site",
      "git_status",
      "git_diff",
      "git_log",
      "git_branches",
      "git_add",
      "git_commit",
      "git_checkout",
      "git_push",
      "list_directory",
      "read_file",
      "write_file",
      "create_file",
      "delete_file",
      "apply_patch",
      "find_files",
      "search_text",
      "run_command",
      "compile_code",
      "run_code",
      "format_code",
      "syntax_check",
    ],
  );
});

test("optional tool arguments are not rejected by schema validation", () => {
  const registry = new ToolRegistry();
  for (const tool of createIdeTools()) registry.register(tool);

  assert.deepEqual(
    registry.validateArguments("search_text", { pattern: "AgentRunner" }),
    [],
  );
  assert.deepEqual(
    registry.validateArguments("browse_url", { url: "https://example.com" }),
    [],
  );
  assert.deepEqual(
    registry.validateArguments("crawl_site", { url: "https://example.com" }),
    [],
  );
  assert.deepEqual(
    registry.validateArguments("git_checkout", { branch: "feature/test" }),
    [],
  );
});

test("web and Git tools use bounded read-only and approval-gated operations", async () => {
  assert.deepEqual(
    createWebTools().map((tool) => tool.approval),
    ["ask", "ask"],
  );
  assert.deepEqual(
    createGitTools().map((tool) => tool.approval),
    ["auto", "auto", "auto", "auto", "ask", "ask", "ask", "ask"],
  );

  const browse = createWebTools()[0];
  await assert.rejects(
    browse?.execute(
      { url: "file:///secret.txt", maxCharacters: 500 },
      {
        cwd: process.cwd(),
        signal: new AbortController().signal,
        requestApproval: async () => true,
      },
    ),
    /HTTP or HTTPS/,
  );
});

test("Git guard rejects generated dependency output", () => {
  assert.throws(
    () => assertSafeGitPaths(["node_modules/package/index.js"]),
    /Refusing to stage/,
  );
  assert.throws(
    () => assertSafeGitPaths(["target/debug/app"]),
    /generated dependency output/,
  );
  assert.doesNotThrow(() =>
    assertSafeGitPaths(["src/index.ts", "pnpm-lock.yaml"]),
  );
});

test("WorkspaceFileService creates files, previews changes, and detects conflicts", async () => {
  const root = await mkdtemp(join(tmpdir(), "agentic-runtime-"));
  try {
    const service = new WorkspaceFileService(root);
    const created = await service.applyChange({
      path: "src/example.ts",
      newContent: "export const value = 1;\n",
      expectedHash: null,
    });
    const file = await service.readText("src/example.ts");

    assert.equal(created.path, "src/example.ts");
    assert.equal(file.content, "export const value = 1;\n");
    assert.match(
      await service.previewChange({
        path: "src/example.ts",
        newContent: "export const value = 2;\n",
        expectedContent: file.content,
      }),
      /-export const value = 1;\n\+export const value = 2;/,
    );
    await assert.rejects(
      service.applyChange({
        path: "src/example.ts",
        newContent: "changed",
        expectedContent: "stale",
      }),
      /changed since it was read/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("search uses ripgrep for file and text discovery", async () => {
  const files = await findFiles(process.cwd(), "packages/tools/src/*.ts");
  const matches = await searchText({
    root: process.cwd(),
    pattern: "createIdeTools",
    glob: "packages/tools/src/*.ts",
  });

  assert.ok(files.includes("packages/tools/src/index.ts"));
  assert.ok(
    matches.some((match) => match.path === "packages/tools/src/index.ts"),
  );
});

test("project agent files load separately from AGENTS.md instructions", async () => {
  const root = await mkdtemp(join(tmpdir(), "agentic-agents-"));
  try {
    const agentsPath = join(root, ".agentic", "agents");
    await mkdir(agentsPath, { recursive: true });
    await writeFile(
      join(agentsPath, "researcher.md"),
      `---
id: researcher
name: Research Agent
description: Finds evidence.
capabilities: [research, web]
allowedTools: [browse_url, git_log]
maxSteps: 9
enabled: true
---

Use primary sources and return evidence.
`,
    );

    assert.deepEqual(loadProjectAgents(root), [
      {
        id: "researcher",
        name: "Research Agent",
        description: "Finds evidence.",
        systemPrompt: "Use primary sources and return evidence.",
        capabilities: ["research", "web"],
        allowedTools: ["browse_url", "git_log"],
        maxSteps: 9,
        enabled: true,
      },
    ]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Command executor runs a native shell command with bounded results", async () => {
  const result = await executeCommand(
    process.platform === "win32"
      ? "echo agentic-runtime-test"
      : "printf agentic-runtime-test",
    {
      cwd: process.cwd(),
      signal: new AbortController().signal,
      requestApproval: async () => true,
    },
  );

  assert.equal(result.exitCode, 0);
  assert.equal(result.isError, false);
  assert.match(result.output, /agentic-runtime-test/);
});

test("Ollama fallback parses tagged JSON tool calls", () => {
  const calls = parseJsonToolCalls(`<tool_response>
{
  "name": "run_command",
  "arguments": { "command": "ipconfig" }
}
</tool_response>`);

  assert.deepEqual(calls[0]?.name, "run_command");
  assert.deepEqual(calls[0]?.arguments, { command: "ipconfig" });
});

test("Ollama fallback parses embedded assistant JSON tool calls", () => {
  const calls = parseJsonToolCalls(
    'I will inspect the file first. {"name":"read_file","arguments":{"path":"README.md"}}',
  );

  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.name, "read_file");
  assert.deepEqual(calls[0]?.arguments, { path: "README.md" });
});

test("HeadlessRuntimeService owns task lifecycle and persists IDE-ready events", async () => {
  const root = await mkdtemp(join(tmpdir(), "agentic-headless-runtime-"));
  const store = new SessionStore({
    projectRoot: root,
    dataRoot: join(root, ".runtime-data"),
  });
  store.registerAgent({
    id: "general",
    name: "General",
    description: "Answers a task.",
    systemPrompt: "Answer the user task directly.",
    capabilities: ["conversation"],
    enabled: true,
  });
  const events: RuntimeEvent[] = [];
  const service = new HeadlessRuntimeService({
    store,
    model: { providerId: "ollama", modelId: "fake-model" },
    resolveModel: () =>
      new FakeModel([assistantResponse("Headless task completed.")]),
    resolveTools: () => new ToolRegistry(),
    requestApproval: async () => true,
  });
  service.subscribe((event) => {
    events.push(event);
  });

  try {
    const session = service.createSession("IDE session");
    const result = await service.runTask({
      sessionId: session.id,
      agentId: "general",
      prompt: "Complete this headless task.",
    });
    const persistedSession = service.getSession(session.id);
    const persistedTask = store.getTask(result.taskId);
    const persistedEvents = store.listEvents(session.id);

    assert.equal(result.status, "completed");
    assert.equal(result.text, "Headless task completed.");
    assert.equal(persistedSession?.status, "idle");
    assert.equal(persistedSession?.messages.at(-1)?.content, result.text);
    assert.equal(persistedTask?.status, "completed");
    assert.ok(result.runId);
    assert.ok(
      persistedEvents.some(
        (event) =>
          event.type === "model_request" && event.runId === result.runId,
      ),
    );
    assert.ok(events.some((event) => event.type === "task_started"));
    assert.ok(events.some((event) => event.type === "task_completed"));
  } finally {
    await service.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("AgentRunner compacts repeatedly and recovers from a context limit", async () => {
  const events: AgentEvent[] = [];
  const requests: ModelRequest[] = [];
  let calls = 0;
  const model: LanguageModel = {
    estimateContext: (request) => ({
      inputTokens: Math.ceil(JSON.stringify(request).length / 4),
      contextWindowTokens: 1200,
      reservedOutputTokens: 100,
    }),
    respond: async (request) => {
      requests.push(request);
      calls += 1;
      if (calls === 1) {
        throw new ModelError("maximum context length exceeded", {
          code: "context_length",
          retryable: true,
          status: 413,
        });
      }
      return assistantResponse("Recovered after compaction.");
    },
  };
  const messages = [
    { role: "system" as const, content: "Preserve project rules." },
    ...Array.from({ length: 14 }, (_, index) => [
      {
        role: "user" as const,
        content: `Historical request ${index}: ${"x".repeat(220)}`,
      },
      {
        role: "assistant" as const,
        content: `Completed historical work. ${"same".repeat(45)}`,
      },
    ]).flat(),
    { role: "user" as const, content: "Current objective must survive." },
  ];
  const runner = new AgentRunner(model, new ToolRegistry(), {
    cwd: process.cwd(),
    requestApproval: async () => true,
    compaction: {
      triggerRatio: 100,
      recoveryTargetRatio: 0.05,
      maxPasses: 4,
      minimumRecentExchanges: 1,
    },
    onEvent: (event) => {
      events.push(event);
    },
  });

  const result = await runner.run(messages);
  const compactions = events.filter(
    (event) => event.type === "context_compacted",
  );

  assert.equal(result.text, "Recovered after compaction.");
  assert.equal(requests.length, 2);
  assert.ok(compactions.length >= 2);
  assert.ok(
    result.messages.some(
      (message) =>
        message.role === "system" &&
        message.kind === "compaction" &&
        message.content.includes("Current objective must survive."),
    ),
  );
  assert.ok(events.some((event) => event.type === "context_limit_recovery"));
});

test("TaskOrchestrator resumes attempts and detects repeated verifier failure", async () => {
  const saved = {
    runId: "resume-run",
    objective: "Resume verification.",
    stage: "verifying" as const,
    completedStepIds: ["code"],
    results: {
      code: {
        stepId: "code",
        role: "coder" as const,
        success: true,
        summary: "Implementation complete.",
        attempts: 1,
        completedAt: 1,
      },
    },
    attempts: { code: 1, verify: 1 },
    failureFingerprints: { verify: "same verifier failure" },
    totalAttempts: 2,
    startedAt: Date.now(),
    updatedAt: Date.now(),
  };
  let verifierCalls = 0;
  const orchestrator = new TaskOrchestrator(
    {
      verifier: async () => {
        verifierCalls += 1;
        return {
          success: true,
          passed: false,
          summary: "same verifier failure",
          progressKey: "same verifier failure",
        };
      },
    },
    {
      maxAttemptsPerStep: 3,
      checkpoint: {
        load: async () => saved,
        save: async () => undefined,
      },
    },
  );

  const state = await orchestrator.run({
    objective: saved.objective,
    steps: [
      { id: "code", role: "coder", title: "Code", prompt: "Code." },
      {
        id: "verify",
        role: "verifier",
        title: "Verify",
        prompt: "Verify.",
        dependsOn: ["code"],
      },
    ],
  });

  assert.equal(verifierCalls, 1);
  assert.equal(state.attempts.verify, 2);
  assert.equal(state.totalAttempts, 3);
  assert.equal(state.stage, "failed");
  assert.match(state.failure ?? "", /stuck repeating/);
});

test("WorkspaceFileService applies selected stable hunks and rejects stale bases", async () => {
  const root = await mkdtemp(join(tmpdir(), "agentic-hunks-"));
  const path = join(root, "sample.txt");
  const original = "one\ntwo\nthree\nfour\nfive\n";
  const proposal = "ONE\ntwo\nthree\nfour\nFIVE\n";
  await writeFile(path, original);
  const service = new WorkspaceFileService(root);
  try {
    const change = { path: "sample.txt", newContent: proposal };
    const first = await service.prepareChange(change);
    const second = await service.prepareChange(change);
    assert.equal(first.hunks.length, 2);
    assert.deepEqual(
      first.hunks.map((hunk) => hunk.id),
      second.hunks.map((hunk) => hunk.id),
    );

    const partial = await service.applyPreparedChange(change, first, [
      first.hunks[0]!.id,
    ]);
    assert.equal(await readFile(path, "utf8"), "ONE\ntwo\nthree\nfour\nfive\n");
    assert.deepEqual(partial.appliedHunkIds, [first.hunks[0]!.id]);
    assert.deepEqual(
      partial.rejectedHunks.map((hunk) => hunk.id),
      [first.hunks[1]!.id],
    );

    const insertionDeletion = {
      path: "sample.txt",
      newContent: "zero\nONE\nthree\nfour\nfive\nsix\n",
    };
    const prepared = await service.prepareChange(insertionDeletion);
    await service.applyPreparedChange(insertionDeletion, prepared);
    assert.equal(await readFile(path, "utf8"), insertionDeletion.newContent);

    const stale = await service.prepareChange({
      path: "sample.txt",
      newContent: "stale proposal\n",
    });
    await writeFile(path, "user changed this\n");
    await assert.rejects(
      service.applyPreparedChange(
        { path: "sample.txt", newContent: "stale proposal\n" },
        stale,
      ),
      /changed after approval preview/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("AgentRunner applies accepted hunks and returns rejected hunks to the model", async () => {
  const root = await mkdtemp(join(tmpdir(), "agentic-hunk-agent-"));
  const original = "alpha\nbeta\ngamma\ndelta\nepsilon\n";
  const proposal = "ALPHA\nbeta\ngamma\ndelta\nEPSILON\n";
  await writeFile(join(root, "sample.txt"), original);
  let requestCount = 0;
  const model: LanguageModel = {
    respond: async (request) => {
      requestCount += 1;
      if (requestCount === 1) {
        return assistantResponse("", [
          {
            id: "partial-patch",
            name: "apply_patch",
            arguments: {
              path: "sample.txt",
              oldContent: original,
              newContent: proposal,
            },
          },
        ]);
      }
      const toolMessage = request.messages
        .filter((message) => message.role === "tool")
        .at(-1);
      assert.match(toolMessage?.content ?? "", /Rejected hunks/);
      assert.match(toolMessage?.content ?? "", /EPSILON/);
      return assistantResponse("Continued around the rejected hunk.");
    },
  };
  const registry = new ToolRegistry();
  for (const tool of createIdeTools()) registry.register(tool);
  try {
    const result = await new AgentRunner(model, registry, {
      cwd: root,
      enforceWorkflowCompletion: false,
      compaction: false,
      requestApproval: async (_call, preview) => {
        assert.equal(typeof preview, "object");
        if (typeof preview !== "object") return false;
        return {
          acceptedHunkIds: [preview.hunks[0]!.id],
          rejectedHunkIds: preview.hunks.slice(1).map((hunk) => hunk.id),
        };
      },
    }).run([{ role: "user", content: "Apply the proposed patch." }]);

    assert.equal(result.text, "Continued around the rejected hunk.");
    assert.equal(
      await readFile(join(root, "sample.txt"), "utf8"),
      "ALPHA\nbeta\ngamma\ndelta\nepsilon\n",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("HeadlessRuntimeService routes read-only test commands directly to verifier", async () => {
  const root = await mkdtemp(join(tmpdir(), "agentic-verify-only-"));
  const store = new SessionStore({
    projectRoot: root,
    dataRoot: join(root, ".runtime-data"),
  });
  const projectRule =
    "Run python -m unittest discover -s tests -v after behavior changes.";
  const agents = createDefaultAgents([projectRule]);
  for (const agent of agents) store.registerAgent(agent);
  assert.match(
    agents.find((agent) => agent.id === VERIFIER_AGENT_ID)?.systemPrompt ?? "",
    /python -m unittest discover -s tests -v/,
  );
  const retrieval = new SemanticRetrievalIndex({
    root,
    databasePath: join(root, ".runtime-data", "retrieval.db"),
  });
  const resolvedAgents: string[] = [];
  const commands: string[] = [];
  const tools = new ToolRegistry().register({
    name: "run_command",
    description: "Run the requested verification command.",
    approval: "auto",
    parameters: {
      type: "object",
      properties: { command: { type: "string" } },
      required: ["command"],
      additionalProperties: false,
    },
    execute: async (arguments_) => {
      commands.push(String(arguments_.command));
      return { output: "Ran 7 tests in 0.003s\n\nOK", exitCode: 0 };
    },
  });
  const verifierModel = new FakeModel([
    assistantResponse("", [
      {
        id: "run-tests",
        name: "run_command",
        arguments: {
          command: "python -m unittest discover -s tests -v",
        },
      },
    ]),
    assistantResponse(
      "Command: python -m unittest discover -s tests -v\nTests: 7\nResult: OK",
    ),
  ]);
  const events: RuntimeEvent[] = [];
  const service = new HeadlessRuntimeService({
    store,
    model: { providerId: "ollama", modelId: "fake" },
    resolveModel: (agent) => {
      resolvedAgents.push(agent.id);
      if (agent.id !== VERIFIER_AGENT_ID) {
        throw new Error(`Unexpected agent: ${agent.id}`);
      }
      return verifierModel;
    },
    resolveTools: () => tools,
    requestApproval: async () => true,
    retrieval,
  });
  service.subscribe((event) => {
    events.push(event);
  });

  try {
    const session = service.createSession();
    const result = await service.runTask({
      sessionId: session.id,
      agentId: DEFAULT_AGENT_ID,
      prompt:
        "Run the existing Python test suite without modifying any files. Report the exact command, number of tests, and final result.",
    });

    assert.equal(result.status, "completed");
    assert.equal(result.agentId, VERIFIER_AGENT_ID);
    assert.deepEqual(resolvedAgents, [VERIFIER_AGENT_ID]);
    assert.deepEqual(commands, ["python -m unittest discover -s tests -v"]);
    assert.equal(
      events.some((event) => event.type === "pipeline_event"),
      false,
    );
  } finally {
    await service.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("HeadlessRuntimeService checkpoints the five-stage pipeline in order", async () => {
  const root = await mkdtemp(join(tmpdir(), "agentic-pipeline-"));
  await writeFile(join(root, "index.ts"), "export const value = 1;\n");
  const store = new SessionStore({
    projectRoot: root,
    dataRoot: join(root, ".runtime-data"),
  });
  for (const agent of createDefaultAgents(["Run targeted tests."])) {
    store.registerAgent(agent);
  }
  const retrieval = new SemanticRetrievalIndex({
    root,
    databasePath: join(root, ".runtime-data", "retrieval.db"),
  });
  await retrieval.indexProject();
  const models = new Map<string, LanguageModel>([
    [
      DEFAULT_AGENT_ID,
      new FakeModel([assistantResponse("1. Implement safely")]),
    ],
    [
      CODING_AGENT_ID,
      new FakeModel([
        assistantResponse("", [
          { id: "write", name: "write_file", arguments: {} },
        ]),
        assistantResponse("Implementation complete."),
      ]),
    ],
    [
      VERIFIER_AGENT_ID,
      new FakeModel([assistantResponse("VERIFICATION_PASSED")]),
    ],
    [
      REVIEWER_AGENT_ID,
      new FakeModel([
        assistantResponse("Review complete."),
        assistantResponse("Resumed review complete."),
      ]),
    ],
  ]);
  const tools = new ToolRegistry().register({
    name: "write_file",
    description: "Record a test mutation.",
    approval: "auto",
    parameters: { type: "object", properties: {}, additionalProperties: false },
    execute: async () => ({ output: "changed", changed: true }),
  });
  const events: RuntimeEvent[] = [];
  const service = new HeadlessRuntimeService({
    store,
    model: { providerId: "ollama", modelId: "fake" },
    resolveModel: (agent) => models.get(agent.id)!,
    resolveTools: () => tools,
    requestApproval: async () => true,
    retrieval,
  });
  service.subscribe((event) => {
    events.push(event);
  });
  try {
    const session = service.createSession();
    const result = await service.runTask({
      sessionId: session.id,
      agentId: DEFAULT_AGENT_ID,
      prompt: "Implement a pipeline change.",
    });
    const roles = events
      .filter((event) => event.type === "pipeline_event")
      .flatMap((event) =>
        event.type === "pipeline_event" && event.event.type === "step_started"
          ? [event.event.role]
          : [],
      );
    const persisted = store.getTask(result.taskId);

    assert.equal(result.status, "completed");
    assert.deepEqual(roles, [
      "planner",
      "retriever",
      "coder",
      "verifier",
      "reviewer",
    ]);
    assert.deepEqual(
      (persisted?.state.orchestration as { completedStepIds?: string[] })
        .completedStepIds,
      ["plan", "retrieve", "code", "verify", "review"],
    );
    assert.equal(persisted?.state.result, "Review complete.");

    const resumedTask = store.createTask(
      session.id,
      "Implement a resumed pipeline change.",
    );
    store.updateTask(resumedTask.id, {
      state: { ...resumedTask.state, agentId: DEFAULT_AGENT_ID },
    });
    await createTaskCheckpointStore(store, resumedTask.id).save({
      runId: "persisted-pipeline-run",
      objective: resumedTask.prompt,
      stage: "reviewing",
      completedStepIds: ["plan", "retrieve", "code", "verify"],
      results: {
        plan: completedStep("plan", "planner", "Plan complete."),
        retrieve: completedStep("retrieve", "retriever", "Retrieval complete."),
        code: completedStep("code", "coder", "Code complete."),
        verify: {
          ...completedStep("verify", "verifier", "VERIFICATION_PASSED"),
          passed: true,
        },
      },
      attempts: { plan: 1, retrieve: 1, code: 1, verify: 1 },
      failureFingerprints: {},
      totalAttempts: 4,
      startedAt: Date.now(),
      updatedAt: Date.now(),
    });
    const eventOffset = events.length;
    const resumed = await service.resumeTask({ taskId: resumedTask.id })
      .completion;
    const resumedRoles = events
      .slice(eventOffset)
      .filter((event) => event.type === "pipeline_event")
      .flatMap((event) =>
        event.type === "pipeline_event" && event.event.type === "step_started"
          ? [event.event.role]
          : [],
      );
    assert.equal(resumed.text, "Resumed review complete.");
    assert.deepEqual(resumedRoles, ["reviewer"]);
  } finally {
    await service.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("SessionStore persists project-isolated sessions, tasks, events, and context", async () => {
  return (async () => {
    const root = await mkdtemp(join(tmpdir(), "agentic-session-"));
    const globalDatabasePath = join(root, "global.db");
    const projectDatabasePath = join(root, "project.db");
    const first = new SessionStore({
      projectRoot: root,
      globalDatabasePath,
      projectDatabasePath,
    });
    const session = first.createSession("Persistent test");
    const messages = [{ role: "user" as const, content: "Remember this." }];
    first.saveMessages(session.id, messages);
    const task = first.createTask(session.id, "Test persistence");
    first.updateTask(task.id, { status: "running", currentStage: "testing" });
    const checkpoint = createTaskCheckpointStore(first, task.id);
    await checkpoint.save({
      runId: "checkpoint-run",
      objective: task.prompt,
      stage: "implementing",
      completedStepIds: [],
      results: {},
      attempts: {},
      totalAttempts: 0,
      startedAt: 1,
      updatedAt: 2,
    });
    first.appendEvent({
      sessionId: session.id,
      taskId: task.id,
      type: "test_event",
      payload: { ok: true },
    });
    first.addContextItem({
      taskId: task.id,
      source: "user",
      content: "Pinned context",
      priority: "critical",
      pinned: true,
      tokenEstimate: 2,
    });
    first.setGlobalSetting("test.setting", "persisted");
    first.setCredential("groq", "gsk_test_key_1234");
    first.setProviderSetting("ollama", "baseUrl", "http://localhost:11434");
    first.registerAgent({
      id: "network-specialist",
      name: "Network Specialist",
      description: "Investigates network issues.",
      systemPrompt: "Focus on network diagnostics.",
      capabilities: ["network", "diagnostics"],
      allowedTools: ["read_file", "run_command"],
      delegatesTo: "general",
      maxSteps: 6,
      enabled: true,
    });
    first.close();

    const second = new SessionStore({
      projectRoot: root,
      globalDatabasePath,
      projectDatabasePath,
    });
    try {
      const restored = second.getSession(session.id);
      assert.equal(restored?.title, "Persistent test");
      assert.deepEqual(restored?.messages, messages);
      assert.equal(second.listEvents(session.id)[0]?.type, "test_event");
      assert.equal(
        second.listContextItems(task.id)[0]?.content,
        "Pinned context",
      );
      assert.equal(second.getGlobalSetting("test.setting"), "persisted");
      assert.equal(second.getCredential("groq"), "gsk_test_key_1234");
      assert.deepEqual(second.listCredentialProviderIds(), ["groq"]);
      assert.equal(
        second.getProviderSetting("ollama", "baseUrl"),
        "http://localhost:11434",
      );
      second.clearCredential("groq");
      assert.equal(second.getCredential("groq"), undefined);
      assert.deepEqual(second.getAgent("network-specialist"), {
        id: "network-specialist",
        name: "Network Specialist",
        description: "Investigates network issues.",
        systemPrompt: "Focus on network diagnostics.",
        capabilities: ["network", "diagnostics"],
        allowedTools: ["read_file", "run_command"],
        delegatesTo: "general",
        maxSteps: 6,
        enabled: true,
      });
      assert.equal(
        second.updateAgent("network-specialist", { maxSteps: 10 }).maxSteps,
        10,
      );
      assert.equal(second.removeAgent("network-specialist"), true);
      assert.equal(second.getAgent("network-specialist"), undefined);
      assert.equal(
        (await createTaskCheckpointStore(second, task.id).load())?.runId,
        "checkpoint-run",
      );
    } finally {
      second.close();
      await rm(root, { recursive: true, force: true });
    }
  })();
});
