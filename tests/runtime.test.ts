import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
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
import {
  OllamaModel,
  DEFAULT_NUM_PREDICT,
  parseJsonToolCalls,
} from "../packages/ollama/dist/index.js";
import { findFiles, searchText } from "../packages/search/dist/index.js";
import {
  createTaskCheckpointStore,
  loadProjectAgents,
  loadProjectInstructions,
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
  CONVERSATION_AGENT_ID,
  createDefaultAgents,
  DEFAULT_AGENT_ID,
  HeadlessRuntimeService,
  REVIEWER_AGENT_ID,
  VERIFIER_AGENT_ID,
  type RuntimeEvent,
} from "../packages/runtime/dist/index.js";
import {
  assessLocalModel,
  rankModelRoutes,
} from "../packages/gateway/dist/index.js";
import { startSettingsServer } from "../packages/gui-server/dist/index.js";
import {
  createWorkspaceWatcher,
  isIgnoredWorkspacePath,
} from "../packages/gui-server/dist/workspace-watcher.js";
import {
  hasOllamaModel,
  RUNTIME_PROVIDER_PRIORITY,
} from "../packages/gui-server/dist/runtime-transport.js";
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

/** Polls until `read` returns a non-empty result, or the timeout elapses. */
async function waitFor<T>(read: () => T[], timeoutMs: number): Promise<T[]> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = read();
    if (value.length > 0 || Date.now() > deadline) return value;
    await new Promise<void>((resolve) => setTimeout(resolve, 25));
  }
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

test("local models are assessed against the 16GB RAM / 8GB VRAM reference machine", () => {
  const gib = (value: number) => value * 1024 ** 3;
  const host = gib(32);

  // qwen2.5-coder:7b, the documented default local route.
  const small = assessLocalModel(gib(4.7), host);
  assert.equal(small.verdict, "fits");
  assert.match(small.detail, /8 GB VRAM budget/u);

  // Fits system RAM but not VRAM: runs with CPU offload, so it is reported.
  const medium = assessLocalModel(gib(12), host);
  assert.equal(medium.verdict, "tight");
  assert.match(medium.detail, /slower/u);

  // Beyond the reference machine entirely.
  assert.equal(assessLocalModel(gib(20), host).verdict, "exceeds");

  // Nothing is claimed when the provider reports no size.
  const unknown = assessLocalModel(undefined, host);
  assert.equal(unknown.verdict, "unknown");
  assert.match(unknown.detail, /could not be verified/u);
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

test("AgentRunner pauses immediately after the user denies a tool", async () => {
  const call = { id: "call-2", name: "echo", arguments: { value: "secret" } };
  const registry = new ToolRegistry().register(echoTool());
  const model = new FakeModel([assistantResponse("", [call])]);
  const messages = [{ role: "user" as const, content: "Run it." }];

  const result = await new AgentRunner(model, registry, {
    cwd: process.cwd(),
    requestApproval: async () => false,
  }).run(messages);

  const toolMessage = result.messages.at(-1);
  assert.equal(toolMessage?.role, "tool");
  assert.match(toolMessage?.content ?? "", /denied by the user/);
  assert.equal(toolMessage?.metadata?.isError, true);
  assert.equal(toolMessage?.metadata?.denied, true);
  assert.equal(result.stopReason, "approval_denied");
  assert.match(result.text, /paused immediately/);
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

test("AgentRunner refuses to write a mutation whose content was cut off", async () => {
  // The exact shape of the reported failure: a stylesheet that stops inside a
  // rule because the completion hit the output token limit.
  const truncated = [
    "<!DOCTYPE html>",
    '<html lang="en">',
    "<head><title>3D Rotating Cube</title>",
    "<style>",
    "  body { background: #0f0f1a; }",
    "  #controls {",
    "    display: flex;",
    "    align-items: center;",
  ].join("\n");
  const writes: string[] = [];
  let call = 0;
  const model: LanguageModel = {
    respond: async () => {
      call += 1;
      return call === 1
        ? {
            ...assistantResponse("", [
              {
                id: "write-truncated",
                name: "create_file",
                arguments: { path: "cube.html", content: truncated },
              },
            ]),
            finishReason: "length",
          }
        : assistantResponse("Stopped without writing a partial file.");
    },
  };
  const tools = new ToolRegistry().register({
    name: "create_file",
    description: "Record a created artifact.",
    approval: "auto",
    parameters: {
      type: "object",
      properties: { path: { type: "string" }, content: { type: "string" } },
      required: ["path", "content"],
      additionalProperties: false,
    },
    execute: async (input) => {
      writes.push(String((input as { content: string }).content));
      return { output: "created", changed: true };
    },
  });

  const result = await new AgentRunner(model, tools, {
    cwd: process.cwd(),
    enforceWorkflowCompletion: false,
    requestApproval: async () => true,
  }).run([{ role: "user", content: "Make a rotating cube page." }]);

  assert.deepEqual(writes, [], "a truncated file must never reach the tool");
  assert.match(result.text, /without writing a partial file/u);
});

test("AgentRunner accepts complete content that merely contains delimiters", async () => {
  // Braces inside strings and comments must not read as truncation.
  const complete = [
    "<!DOCTYPE html>",
    "<html><head><style>",
    "  /* a comment with an unbalanced { brace */",
    "  .face { transform: translateZ(80px); }",
    "</style></head><body>",
    "<script>",
    '  const note = "a string with { an unbalanced brace";',
    "  document.title = note;",
    "</script></body></html>",
  ].join("\n");
  const writes: string[] = [];
  let call = 0;
  const model: LanguageModel = {
    respond: async () => {
      call += 1;
      return call === 1
        ? assistantResponse("", [
            {
              id: "write-complete",
              name: "create_file",
              arguments: { path: "cube.html", content: complete },
            },
          ])
        : assistantResponse("Saved cube.html.");
    },
  };
  const tools = new ToolRegistry().register({
    name: "create_file",
    description: "Record a created artifact.",
    approval: "auto",
    parameters: {
      type: "object",
      properties: { path: { type: "string" }, content: { type: "string" } },
      required: ["path", "content"],
      additionalProperties: false,
    },
    execute: async (input) => {
      writes.push(String((input as { content: string }).content));
      return { output: "created", changed: true };
    },
  });

  await new AgentRunner(model, tools, {
    cwd: process.cwd(),
    enforceWorkflowCompletion: false,
    requestApproval: async () => true,
  }).run([{ role: "user", content: "Make a rotating cube page." }]);

  assert.equal(writes.length, 1, "valid content must not be rejected");
});

test("AgentRunner stops corrective mutation nudges after two retries", async () => {
  let modelCalls = 0;
  const model: LanguageModel = {
    respond: async () => {
      modelCalls += 1;
      return assistantResponse("I would create the requested file.");
    },
  };
  const registry = new ToolRegistry().register({
    name: "create_file",
    description: "Create a file.",
    parameters: { type: "object", additionalProperties: true },
    execute: async () => ({ output: "created", changed: true }),
  });

  const result = await new AgentRunner(model, registry, {
    cwd: process.cwd(),
    maxSteps: 12,
    requestApproval: async () => true,
  }).run([{ role: "user", content: "Create calculator.py." }]);

  assert.equal(modelCalls, 3);
  assert.equal(result.text, "I would create the requested file.");
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

test("TaskOrchestrator does not replay a terminal worker failure", async () => {
  let attempts = 0;
  const orchestrator = new TaskOrchestrator(
    {
      coder: async () => {
        attempts += 1;
        return {
          success: false,
          summary: "model exhausted its bounded tool-call recovery",
          retryable: false,
        };
      },
    },
    { runId: "run-terminal", maxAttemptsPerStep: 5 },
  );

  const state = await orchestrator.run({
    objective: "Do not replay this implementation.",
    steps: [{ id: "code", role: "coder", title: "Code", prompt: "Implement." }],
  });

  assert.equal(attempts, 1);
  assert.equal(state.stage, "failed");
  assert.match(state.failure ?? "", /failed: model exhausted/);
});

test("TaskOrchestrator pauses instead of retrying a denied step", async () => {
  let attempts = 0;
  const events: string[] = [];
  const orchestrator = new TaskOrchestrator(
    {
      verifier: async () => {
        attempts += 1;
        return {
          success: false,
          paused: true,
          retryable: false,
          summary: "Verification command was denied by the user.",
        };
      },
    },
    {
      maxAttemptsPerStep: 2,
      onEvent: (event) => {
        events.push(event.type);
      },
    },
  );

  const state = await orchestrator.run({
    objective: "Verify a Rust file.",
    steps: [
      {
        id: "verify",
        role: "verifier",
        title: "Verify",
        prompt: "Run the requested verification.",
      },
    ],
  });

  assert.equal(attempts, 1);
  assert.equal(state.stage, "paused");
  assert.match(state.failure ?? "", /denied by the user/);
  assert.ok(events.includes("orchestration_paused"));
  assert.equal(events.includes("step_retrying"), false);
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
      "web_search",
      "browse_url",
      "crawl_site",
      "git_status",
      "git_diff",
      "git_log",
      "git_branches",
      "git_add",
      "git_commit",
      "git_checkout",
      "git_merge",
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
  // Every web tool sends data to a third party, so all of them ask first.
  assert.deepEqual(
    createWebTools().map((tool) => tool.approval),
    ["ask", "ask", "ask"],
  );
  // Reads are automatic; anything that changes history or a remote asks.
  assert.deepEqual(
    createGitTools().map((tool) => tool.approval),
    ["auto", "auto", "auto", "auto", "ask", "ask", "ask", "ask", "ask"],
  );

  const browse = createWebTools().find((tool) => tool.name === "browse_url")!;
  await assert.rejects(
    browse.execute(
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

test("rejecting every hunk of a new file leaves no empty file behind", async () => {
  const root = await mkdtemp(join(tmpdir(), "agentic-empty-"));
  const service = new WorkspaceFileService(root);

  try {
    const change = {
      path: "cube.html",
      newContent: "<!doctype html><html><body>cube</body></html>\n",
      expectedHash: null,
    };
    const prepared = await service.prepareChange(change);
    assert.ok(prepared.hunks.length > 0);

    // Accepting nothing for a path that does not exist yet has nothing to
    // partially apply. Writing the empty merge would leave a 0-byte file that
    // looks like a successful creation.
    const result = await service.applyPreparedChange(change, prepared, []);

    assert.equal(result.changed, false);
    assert.equal(result.appliedHunkIds.length, 0);
    assert.equal(result.mutation, null, "a no-op must not enter the journal");
    assert.equal(
      existsSync(join(root, "cube.html")),
      false,
      "no file may be created when every hunk was rejected",
    );

    // The same rejection against an existing file must preserve it untouched.
    await writeFile(join(root, "existing.txt"), "keep me\n");
    const edit = { path: "existing.txt", newContent: "replaced\n" };
    const editPrepared = await service.prepareChange(edit);
    const editResult = await service.applyPreparedChange(
      edit,
      editPrepared,
      [],
    );
    assert.equal(editResult.changed, false);
    assert.equal(
      await readFile(join(root, "existing.txt"), "utf8"),
      "keep me\n",
      "an existing file must survive a fully rejected edit",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
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

test("nested AGENTS.md files are discovered with their scope and bounded", async () => {
  const root = await mkdtemp(join(tmpdir(), "agentic-instructions-"));
  try {
    await writeFile(join(root, "AGENTS.md"), "Use tabs everywhere.\n");
    await mkdir(join(root, "packages", "api"), { recursive: true });
    await writeFile(
      join(root, "packages", "api", "AGENTS.md"),
      "This package uses spaces, not tabs.\n",
    );
    // Generated trees must never contribute rules.
    await mkdir(join(root, "node_modules", "left-pad"), { recursive: true });
    await writeFile(
      join(root, "node_modules", "left-pad", "AGENTS.md"),
      "Never read me.\n",
    );
    await mkdir(join(root, "dist"), { recursive: true });
    await writeFile(join(root, "dist", "AGENTS.md"), "Never read me either.\n");

    const instructions: string[] = loadProjectInstructions(root);

    assert.equal(instructions.length, 2);
    assert.match(instructions[0]!, /applies to the whole project/u);
    assert.match(instructions[0]!, /Use tabs everywhere/u);
    const scoped = instructions.find((entry) =>
      entry.includes("spaces, not tabs"),
    );
    assert.ok(scoped, "a nested package rule file must be discovered");
    assert.match(
      scoped,
      /packages\/api\/ and below/u,
      "a nested rule file must state the subtree it governs",
    );
    assert.equal(
      instructions.some((entry) => entry.includes("Never read me")),
      false,
      "generated directories must not contribute project rules",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
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

test("Ollama fallback parses common nested and array tool-call formats", () => {
  const calls = parseJsonToolCalls(`[
    {"tool":"create_file","parameters":{"path":"calculator.py","content":"print(2 + 2)"}},
    {"function":{"name":"write_file","arguments":"{\\"path\\":\\"README.md\\",\\"content\\":\\"done\\"}"}}
  ]`);

  assert.deepEqual(
    calls.map((call) => ({ name: call.name, arguments: call.arguments })),
    [
      {
        name: "create_file",
        arguments: { path: "calculator.py", content: "print(2 + 2)" },
      },
      {
        name: "write_file",
        arguments: { path: "README.md", content: "done" },
      },
    ],
  );
});

test("Ollama fallback repairs local-model JSON line continuations", () => {
  const calls = parseJsonToolCalls(`[
    {"name":"create_file","arguments":{"path":"cube.html","content":"\\
<!doctype html>\\
<html></html>"}}
  ]`);

  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.name, "create_file");
  assert.equal(calls[0]?.arguments.path, "cube.html");
  assert.equal(calls[0]?.arguments.content, "\n<!doctype html>\n<html></html>");
});

test("Ollama fallback removes invalid local-model JSON escapes", () => {
  const calls = parseJsonToolCalls(
    String.raw`[{"name":"create_file","arguments":{"path":"index.html","content":"\<!doctype html>\n<html></html>"}}]`,
  );

  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.arguments.content, "<!doctype html>\n<html></html>");
});

test("Ollama sends its configured context window to the local server", async () => {
  const originalFetch = globalThis.fetch;
  let requestBody: Record<string, unknown> | undefined;
  globalThis.fetch = async (_input, init) => {
    requestBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
    return new Response(
      JSON.stringify({
        model: "mistral",
        message: { role: "assistant", content: "done" },
        done: true,
      }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    );
  };

  try {
    const model = new OllamaModel({
      model: "mistral",
      contextWindow: 16_384,
    });
    await model.respond({
      messages: [{ role: "user", content: "Create a file." }],
      tools: [],
    });

    assert.deepEqual(requestBody?.options, {
      num_ctx: 16_384,
      num_predict: DEFAULT_NUM_PREDICT,
    });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("Ollama installed-model matching treats the latest tag as an alias", () => {
  const installed = new Set(["mistral:latest", "llama3.2:latest"]);

  assert.equal(hasOllamaModel(installed, "mistral"), true);
  assert.equal(hasOllamaModel(installed, "MISTRAL:LATEST"), true);
  assert.equal(hasOllamaModel(installed, "mistral:7b"), false);
});

test("desktop failover tries Nemotron before hosted alternatives and Ollama last", () => {
  assert.deepEqual(RUNTIME_PROVIDER_PRIORITY, [
    "groq",
    "openrouter",
    "cerebras",
    "huggingface",
    "mistral",
    "openai-compatible",
    "ollama",
  ]);
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

test("GUI server saves edited files, runs terminal commands, and requests the native folder picker", async () => {
  const root = await mkdtemp(join(tmpdir(), "agentic-gui-features-"));
  await writeFile(join(root, "example.txt"), "before\n");
  let openFolderRequests = 0;
  const server = startSettingsServer({
    projectRoot: root,
    port: 0,
    staticDir: false,
    onOpenFolder: () => {
      openFolderRequests += 1;
    },
  });

  try {
    await server.ready;
    const fileResponse = await fetch(
      `${server.url}/api/files/content?path=example.txt`,
    );
    const original = (await fileResponse.json()) as {
      content: string;
      hash: string;
    };
    const saveResponse = await fetch(`${server.url}/api/files/content`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        path: "example.txt",
        content: "after\n",
        expectedHash: original.hash,
      }),
    });
    const saved = (await saveResponse.json()) as {
      file: { content: string };
    };
    const profilesResponse = await fetch(`${server.url}/api/terminal/profiles`);
    const profiles = (await profilesResponse.json()) as {
      profiles: Array<{ id: string; label: string }>;
    };
    const terminalProfile =
      profiles.profiles.find((profile) =>
        process.platform === "win32"
          ? profile.id === "cmd"
          : profile.id === "bash",
      ) ?? profiles.profiles[0];
    const terminalResponse = await fetch(`${server.url}/api/terminal/execute`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        profileId: terminalProfile?.id,
        command:
          process.platform === "win32"
            ? "echo terminal-ok"
            : "printf terminal-ok",
      }),
    });
    const terminal = (await terminalResponse.json()) as {
      output: string;
      exitCode: number;
    };
    const openResponse = await fetch(`${server.url}/api/desktop/open-folder`, {
      method: "POST",
    });
    await new Promise<void>((resolve) => setImmediate(resolve));

    assert.equal(fileResponse.status, 200);
    assert.equal(saveResponse.status, 200);
    assert.equal(saved.file.content, "after\n");
    assert.equal(await readFile(join(root, "example.txt"), "utf8"), "after\n");
    assert.equal(terminalResponse.status, 200);
    assert.equal(profilesResponse.status, 200);
    assert.ok(profiles.profiles.length >= 1);
    if (process.platform === "win32") {
      assert.ok(
        profiles.profiles.some(
          (profile) => profile.id === "powershell" || profile.id === "pwsh",
        ),
      );
      assert.ok(profiles.profiles.some((profile) => profile.id === "cmd"));
    }
    assert.equal(terminal.exitCode, 0);
    assert.match(terminal.output, /terminal-ok/);
    assert.equal(openResponse.status, 202);
    assert.equal(openFolderRequests, 1);
  } finally {
    await server.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("workspace watcher ignores generated directories and batches real changes", async () => {
  const root = await mkdtemp(join(tmpdir(), "agentic-watch-unit-"));
  const watcher = createWorkspaceWatcher(root, { debounceMs: 30 });

  try {
    assert.equal(
      isIgnoredWorkspacePath("node_modules/left-pad/index.js"),
      true,
    );
    assert.equal(isIgnoredWorkspacePath(".git/HEAD"), true);
    assert.equal(isIgnoredWorkspacePath("dist/bundle.js"), true);
    assert.equal(isIgnoredWorkspacePath("src/app.ts.4321.tmp"), true);
    assert.equal(isIgnoredWorkspacePath("src/app.ts"), false);
    assert.equal(isIgnoredWorkspacePath("calculator.py"), false);

    const batches: string[][] = [];
    watcher.subscribe((change) => batches.push(change.paths));
    await mkdir(join(root, "node_modules"), { recursive: true });
    await writeFile(join(root, "node_modules", "ignored.js"), "noop\n");
    await writeFile(join(root, "calculator.py"), "print(2 + 2)\n");
    await writeFile(join(root, "calculator.js"), "console.log(4);\n");

    // Recursive watching is unavailable on some platforms and filesystems, and
    // the watcher degrades to a no-op there rather than failing the server.
    const observed = await waitFor(() => batches.flat(), 2000);
    if (observed.length > 0) {
      assert.ok(
        observed.some((path) => path.endsWith("calculator.py")),
        `expected a calculator.py notification, saw ${observed.join(", ")}`,
      );
      assert.equal(
        observed.some((path) => path.includes("node_modules")),
        false,
        "generated directories must never reach the IDE",
      );
    }
  } finally {
    watcher.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("GUI server streams workspace changes so the explorer stays live", async () => {
  const root = await mkdtemp(join(tmpdir(), "agentic-watch-sse-"));
  const server = startSettingsServer({
    projectRoot: root,
    port: 0,
    staticDir: false,
  });

  try {
    await server.ready;
    const controller = new AbortController();
    const stream = await fetch(`${server.url}/api/workspace/events`, {
      signal: controller.signal,
    });
    assert.equal(stream.status, 200);
    assert.match(
      stream.headers.get("content-type") ?? "",
      /text\/event-stream/u,
    );

    const frames: string[] = [];
    const reader = stream.body!.getReader();
    const decoder = new TextDecoder();
    const pump = (async () => {
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) return;
          frames.push(decoder.decode(value, { stream: true }));
        }
      } catch {
        // Cancelled at the end of the test.
      }
    })();

    // The agent writing a file must reach the IDE without a manual reopen.
    await writeFile(join(root, "calculator.py"), "print(2 + 2)\n");
    const payload = await waitFor(
      () =>
        frames
          .join("")
          .split("\n")
          .filter((line) => line.startsWith("data: ")),
      2000,
    );
    if (payload.length > 0) {
      const change = JSON.parse(payload[0]!.slice("data: ".length)) as {
        type: string;
        paths: string[];
      };
      assert.equal(change.type, "workspace_changed");
      assert.ok(change.paths.some((path) => path.endsWith("calculator.py")));
    }
    controller.abort();
    await pump;
  } finally {
    await server.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("GUI server creates, renames, and deletes explorer entries inside the workspace", async () => {
  const root = await mkdtemp(join(tmpdir(), "agentic-explorer-"));
  const server = startSettingsServer({
    projectRoot: root,
    port: 0,
    staticDir: false,
  });

  try {
    await server.ready;
    const createdFolder = await fetch(`${server.url}/api/files/entry`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ path: "src", type: "directory" }),
    });
    const createdFile = await fetch(`${server.url}/api/files/entry`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ path: "src/old.ts", type: "file" }),
    });
    const duplicate = await fetch(`${server.url}/api/files/entry`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ path: "src/old.ts", type: "file" }),
    });
    const renamed = await fetch(`${server.url}/api/files/entry`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ from: "src/old.ts", to: "src/new.ts" }),
    });
    const escaped = await fetch(`${server.url}/api/files/entry`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ path: "../outside.ts", type: "file" }),
    });
    assert.equal(createdFolder.status, 201);
    assert.equal(createdFile.status, 201);
    assert.equal(duplicate.status, 400);
    assert.equal(renamed.status, 200);
    assert.equal(existsSync(join(root, "src", "new.ts")), true);
    assert.equal(existsSync(join(root, "src", "old.ts")), false);
    assert.equal(
      escaped.status,
      400,
      "explorer operations must stay inside the workspace",
    );

    const deleted = await fetch(
      `${server.url}/api/files/entry?path=${encodeURIComponent("src")}`,
      { method: "DELETE" },
    );
    assert.equal(deleted.status, 200);
    assert.equal(existsSync(join(root, "src")), false);
  } finally {
    await server.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("GUI server copies and duplicates entries without overwriting a collision", async () => {
  const root = await mkdtemp(join(tmpdir(), "agentic-copy-"));
  await mkdir(join(root, "src"), { recursive: true });
  await writeFile(join(root, "src", "app.ts"), "export const value = 1;\n");
  const server = startSettingsServer({
    projectRoot: root,
    port: 0,
    staticDir: false,
  });

  try {
    await server.ready;
    // Duplicate: same source and target, so the suffix rule has to apply.
    const duplicated = (await (
      await fetch(`${server.url}/api/files/copy`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ from: "src/app.ts", to: "src/app.ts" }),
      })
    ).json()) as { path: string };
    const again = (await (
      await fetch(`${server.url}/api/files/copy`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ from: "src/app.ts", to: "src/app.ts" }),
      })
    ).json()) as { path: string };
    const pasted = (await (
      await fetch(`${server.url}/api/files/copy`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ from: "src", to: "vendor" }),
      })
    ).json()) as { path: string };
    const escaped = await fetch(`${server.url}/api/files/copy`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ from: "src/app.ts", to: "../escaped.ts" }),
    });

    assert.equal(duplicated.path, "src/app copy.ts");
    assert.equal(again.path, "src/app copy 2.ts");
    assert.equal(
      await readFile(join(root, "src", "app copy.ts"), "utf8"),
      "export const value = 1;\n",
    );
    assert.equal(
      await readFile(join(root, "src", "app.ts"), "utf8"),
      "export const value = 1;\n",
      "the original must never be overwritten by a copy",
    );
    assert.equal(pasted.path, "vendor");
    assert.equal(existsSync(join(root, "vendor", "app.ts")), true);
    assert.equal(escaped.status, 400);
    assert.equal(existsSync(join(root, "..", "escaped.ts")), false);
  } finally {
    await server.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("route policy keeps judgement stages off excluded providers", () => {
  const local = {
    id: "mistral",
    name: "mistral",
    providerId: "ollama",
    contextWindow: 8192,
    capabilities: {
      tools: true,
      vision: false,
      reasoning: false,
      streaming: true,
      structuredOutput: true,
    },
    metadata: {},
  };
  const hosted = {
    ...local,
    id: "qwen/qwen3.8-27b",
    name: "qwen",
    providerId: "groq",
    contextWindow: 131_072,
  };
  const rank = (candidates: Parameters<typeof rankModelRoutes>[0]) =>
    rankModelRoutes(candidates, {
      requiresTools: true,
      contextTokens: 2000,
      estimatedOutputTokens: 500,
      now: Date.now(),
    })
      .filter((route) => route.eligible)
      .map((route) => route.model.providerId);

  // Both configured: the hosted route must be the only judgement candidate.
  assert.deepEqual(
    rank([
      { model: hosted, preference: 0 },
      { model: local, preference: 1 },
    ]),
    ["groq", "ollama"],
    "ranking itself still lists every eligible route",
  );

  // The exclusion is applied by the gateway before ranking; when it would empty
  // the candidate set the local route must survive so an offline setup works.
  const excluded = new Set(["ollama"]);
  const onlyLocal = [{ model: local, preference: 0 }];
  const filtered = onlyLocal.filter(
    (candidate) => !excluded.has(candidate.model.providerId),
  );
  assert.deepEqual(
    rank(filtered.length > 0 ? filtered : onlyLocal),
    ["ollama"],
    "excluding every configured route must not leave the caller with nothing",
  );
});

test("GUI server pins whole files and selected line ranges, and completes @-mentions", async () => {
  const root = await mkdtemp(join(tmpdir(), "agentic-gui-context-"));
  await writeFile(
    join(root, "sample.ts"),
    ["one", "two", "three", "four", "five"].join("\n") + "\n",
  );
  const server = startSettingsServer({
    projectRoot: root,
    port: 0,
    staticDir: false,
  });

  try {
    await server.ready;
    const sessionResponse = await fetch(`${server.url}/api/sessions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title: "Context session" }),
    });
    const { session } = (await sessionResponse.json()) as {
      session: { id: string };
    };

    const wholeFile = await fetch(`${server.url}/api/context`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ sessionId: session.id, path: "sample.ts" }),
    });
    const blockResponse = await fetch(`${server.url}/api/context`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        sessionId: session.id,
        path: "sample.ts",
        startLine: 2,
        endLine: 3,
      }),
    });
    const block = (await blockResponse.json()) as {
      item: { id: string; content: string; startLine: number; endLine: number };
    };
    const listed = (await (
      await fetch(
        `${server.url}/api/context?sessionId=${encodeURIComponent(session.id)}`,
      )
    ).json()) as { items: Array<{ id: string }> };
    const lookup = (await (
      await fetch(`${server.url}/api/files/lookup?q=sample`)
    ).json()) as { paths: string[] };
    const removed = await fetch(
      `${server.url}/api/context/${encodeURIComponent(block.item.id)}?sessionId=${encodeURIComponent(session.id)}`,
      { method: "DELETE" },
    );
    const remaining = (await (
      await fetch(
        `${server.url}/api/context?sessionId=${encodeURIComponent(session.id)}`,
      )
    ).json()) as { items: Array<{ id: string }> };

    assert.equal(wholeFile.status, 201);
    assert.equal(blockResponse.status, 201);
    assert.equal(block.item.startLine, 2);
    assert.equal(block.item.endLine, 3);
    assert.match(block.item.content, /two\nthree$/u);
    assert.equal(listed.items.length, 2);
    assert.ok(lookup.paths.includes("sample.ts"));
    assert.equal(removed.status, 200);
    assert.equal(remaining.items.length, 1);
  } finally {
    await server.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("HeadlessRuntimeService answers /bytheway in isolation and leaves the transcript intact", async () => {
  const root = await mkdtemp(join(tmpdir(), "agentic-bytheway-"));
  const store = new SessionStore({
    projectRoot: root,
    dataRoot: join(root, ".runtime-data"),
  });
  for (const agent of createDefaultAgents([])) store.registerAgent(agent);
  const isolatedRequests: ModelRequest[] = [];
  const service = new HeadlessRuntimeService({
    store,
    model: { providerId: "ollama", modelId: "mistral" },
    resolveModel: () => ({
      respond: async (request) => {
        isolatedRequests.push(request);
        return assistantResponse(
          "A monad is a monoid in the category of endofunctors.",
        );
      },
    }),
    resolveTools: () => new ToolRegistry(),
    requestApproval: async () => true,
  });

  try {
    const session = service.createSession("Isolated session");
    store.saveMessages(session.id, [
      { role: "user", content: "keep working on the parser" },
      { role: "assistant", content: "Parser work in progress." },
    ]);

    const handle = service.startIsolatedQuestion({
      sessionId: session.id,
      agentId: CONVERSATION_AGENT_ID,
      prompt: "what is a monad",
    });
    const result = await handle.completion;

    assert.match(result.text, /monoid/u);
    assert.equal(isolatedRequests.length, 1);
    // The runner appends its own reply to the same array, so assert on the
    // prompt that was actually sent rather than the mutated conversation.
    assert.deepEqual(isolatedRequests[0]?.messages[0], {
      role: "user",
      content: "what is a monad",
    });
    assert.equal(
      isolatedRequests[0]?.messages.filter(
        (message) => message.role === "system" || message.role === "tool",
      ).length,
      0,
      "an isolated question must carry no prior or system context",
    );
    assert.equal(
      isolatedRequests[0]?.tools.length,
      0,
      "an isolated question must not expose workspace tools",
    );
    assert.deepEqual(
      store.getSession(session.id)?.messages.map((message) => message.content),
      ["keep working on the parser", "Parser work in progress."],
      "the ongoing transcript must be untouched",
    );
  } finally {
    await service.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("HeadlessRuntimeService routes casual conversation through the neutral chat model", async () => {
  const root = await mkdtemp(join(tmpdir(), "agentic-direct-greeting-"));
  const store = new SessionStore({
    projectRoot: root,
    dataRoot: join(root, ".runtime-data"),
  });
  for (const agent of createDefaultAgents([])) store.registerAgent(agent);
  const requests: ModelRequest[] = [];
  const resolvedAgents: string[] = [];
  const model: LanguageModel = {
    respond: async (request) => {
      requests.push(request);
      const prompt = [...request.messages]
        .reverse()
        .find((message) => message.role === "user")?.content;
      return assistantResponse(
        prompt === "sup" ? "Not much—what's up?" : "Hey!",
      );
    },
  };
  const service = new HeadlessRuntimeService({
    store,
    model: { providerId: "ollama", modelId: "mistral" },
    resolveModel: (agent) => {
      resolvedAgents.push(agent.id);
      return model;
    },
    resolveTools: () => new ToolRegistry(),
    requestApproval: async () => true,
  });

  try {
    const session = service.createSession("Greeting session");
    const result = await service.runTask({
      sessionId: session.id,
      agentId: "general",
      prompt: "hi",
    });
    const persistedSession = service.getSession(session.id);
    const persistedEvents = store.listEvents(session.id);

    assert.equal(result.status, "completed");
    assert.equal(result.text, "Hey!");
    assert.deepEqual(
      persistedSession?.messages.map((message) => [
        message.role,
        message.content,
      ]),
      [
        ["user", "hi"],
        ["assistant", "Hey!"],
      ],
    );
    assert.equal(
      persistedEvents.some((event) => event.type === "model_request"),
      true,
    );

    const casualSession = service.createSession("Casual greeting session");
    const casualResult = await service.runTask({
      sessionId: casualSession.id,
      agentId: "general",
      prompt: "sup",
    });
    assert.equal(casualResult.text, "Not much—what's up?");
    assert.deepEqual(
      service
        .getSession(casualSession.id)
        ?.messages.map((message) => [message.role, message.content]),
      [
        ["user", "sup"],
        ["assistant", "Not much—what's up?"],
      ],
    );
    assert.deepEqual(resolvedAgents, [
      CONVERSATION_AGENT_ID,
      CONVERSATION_AGENT_ID,
    ]);
    assert.equal(requests.length, 2);
    assert.ok(requests.every((request) => request.tools.length === 0));
    assert.ok(
      requests.every((request) =>
        request.messages.every((message) => message.role !== "system"),
      ),
    );
    assert.ok(
      requests.every((request) =>
        request.messages.every(
          (message) => !message.content.includes("You are ARCHITECT"),
        ),
      ),
    );
  } finally {
    await service.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("HeadlessRuntimeService keeps a focused single-file edit local and stops after writing", async () => {
  const root = await mkdtemp(join(tmpdir(), "agentic-focused-edit-"));
  const original = "fn merge_sort(values: &mut [i32]) { values.sort(); }\n";
  await writeFile(join(root, "singu.rs"), original);
  const store = new SessionStore({
    projectRoot: root,
    dataRoot: join(root, ".runtime-data"),
  });
  for (const agent of createDefaultAgents([])) store.registerAgent(agent);
  const retrieval = new SemanticRetrievalIndex({
    root,
    databasePath: join(root, ".runtime-data", "retrieval.db"),
  });
  await retrieval.indexProject();
  const coderRequests: ModelRequest[] = [];
  let plannerCalls = 0;
  const insertionSort = `pub fn insertion_sort(values: &mut [i32]) {
    for index in 1..values.len() {
        let mut current = index;
        while current > 0 && values[current] < values[current - 1] {
            values.swap(current, current - 1);
            current -= 1;
        }
    }
}
`;
  const models = new Map<string, LanguageModel>([
    [
      DEFAULT_AGENT_ID,
      {
        respond: async () => {
          plannerCalls += 1;
          throw new Error("Focused edits must not invoke the planner model.");
        },
      },
    ],
    [
      CODING_AGENT_ID,
      {
        respond: async (request) => {
          coderRequests.push(request);
          return coderRequests.length === 1
            ? assistantResponse("", [
                {
                  id: "focused-read",
                  name: "read_file",
                  arguments: { path: "singu.rs" },
                },
              ])
            : assistantResponse("", [
                {
                  id: "focused-write",
                  name: "write_file",
                  arguments: { path: "singu.rs", content: insertionSort },
                },
              ]);
        },
      },
    ],
    [
      VERIFIER_AGENT_ID,
      new FakeModel([
        assistantResponse("", [
          {
            id: "focused-verify-read",
            name: "read_file",
            arguments: { path: "singu.rs" },
          },
        ]),
        assistantResponse(
          "Verified insertion sort.\n**VERIFICATION_PASSED** for singu.rs\n- Static review passed.",
        ),
      ]),
    ],
    [REVIEWER_AGENT_ID, new FakeModel([assistantResponse("Edit reviewed.")])],
  ]);
  const tools = new ToolRegistry();
  for (const tool of createIdeTools()) tools.register(tool);
  const service = new HeadlessRuntimeService({
    store,
    model: { providerId: "openrouter", modelId: "fake" },
    resolveModel: (agent) => models.get(agent.id)!,
    resolveTools: () => tools,
    requestApproval: async () => true,
    retrieval,
  });

  try {
    const session = service.createSession("Focused edit");
    const result = await service.runTask({
      sessionId: session.id,
      agentId: DEFAULT_AGENT_ID,
      prompt:
        "edit this file singu.rs and replace merge sort with insertion sort",
    });

    assert.equal(result.status, "completed");
    assert.equal(plannerCalls, 0);
    assert.equal(coderRequests.length, 2);
    assert.deepEqual(
      coderRequests[0]?.tools.map((tool) => tool.name),
      ["read_file", "write_file", "apply_patch"],
    );
    assert.ok(
      coderRequests[0]?.tools.every(
        (tool) => tool.name !== "web_search" && tool.name !== "browse_url",
      ),
    );
    const saved = await readFile(join(root, "singu.rs"), "utf8");
    assert.match(saved, /insertion_sort/u);
    assert.doesNotMatch(saved, /merge_sort/u);
  } finally {
    await service.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("HeadlessRuntimeService writes every requested artifact instead of answering in chat", async () => {
  const root = await mkdtemp(join(tmpdir(), "agentic-multi-artifact-"));
  const store = new SessionStore({
    projectRoot: root,
    dataRoot: join(root, ".runtime-data"),
  });
  for (const agent of createDefaultAgents([])) store.registerAgent(agent);
  const retrieval = new SemanticRetrievalIndex({
    root,
    databasePath: join(root, ".runtime-data", "retrieval.db"),
  });
  await retrieval.indexProject();
  const createdPaths: string[] = [];
  const resolvedAgents: string[] = [];
  const languages = ["py", "js", "java", "cpp", "rb"];
  const models = new Map<string, LanguageModel>([
    [
      CODING_AGENT_ID,
      {
        respond: async () =>
          assistantResponse("", [
            {
              id: `create-${createdPaths.length}`,
              name: "create_file",
              arguments: {
                path: `calculator.${languages[createdPaths.length] ?? "txt"}`,
                content: "// complete calculator implementation",
              },
            },
          ]),
      },
    ],
    [
      VERIFIER_AGENT_ID,
      new FakeModel([
        assistantResponse("", [
          {
            id: "verify-read",
            name: "read_file",
            arguments: { path: "calculator.py" },
          },
        ]),
        assistantResponse("VERIFICATION_PASSED"),
      ]),
    ],
    [REVIEWER_AGENT_ID, new FakeModel([assistantResponse("Review complete.")])],
  ]);
  const tools = new ToolRegistry()
    .register({
      name: "create_file",
      description: "Record a created artifact.",
      approval: "auto",
      parameters: {
        type: "object",
        properties: { path: { type: "string" }, content: { type: "string" } },
        required: ["path", "content"],
        additionalProperties: false,
      },
      execute: async (input) => {
        const path = String((input as { path: string }).path);
        createdPaths.push(path);
        return {
          output: `created ${path}`,
          changed: true,
          changedFiles: [{ path }],
        };
      },
    })
    .register({
      name: "read_file",
      description: "Read a created artifact.",
      approval: "auto",
      parameters: {
        type: "object",
        properties: { path: { type: "string" } },
        required: ["path"],
        additionalProperties: false,
      },
      execute: async () => ({
        output: "// complete calculator implementation",
      }),
    });
  const events: RuntimeEvent[] = [];
  const service = new HeadlessRuntimeService({
    store,
    model: { providerId: "ollama", modelId: "mistral" },
    resolveModel: (agent) => {
      resolvedAgents.push(agent.id);
      return models.get(agent.id) ?? new FakeModel([assistantResponse("ok")]);
    },
    resolveTools: () => tools,
    requestApproval: async () => true,
    retrieval,
  });
  service.subscribe((event) => {
    events.push(event);
  });

  try {
    const session = service.createSession("Multi-artifact session");
    const result = await service.runTask({
      sessionId: session.id,
      agentId: DEFAULT_AGENT_ID,
      prompt: "write the code for calculator for me in 5 different languages",
    });

    assert.equal(result.status, "completed", result.text);
    assert.equal(
      resolvedAgents.includes(CONVERSATION_AGENT_ID),
      false,
      "a code request must not be answered by the tool-free chat agent",
    );
    assert.ok(resolvedAgents.includes(CODING_AGENT_ID));
    assert.equal(
      new Set(createdPaths).size,
      5,
      `expected five created files, saw ${createdPaths.join(", ")}`,
    );
    // Each file must come from its own coding step. A single step told to emit
    // five mutation calls is what small local models answer with prose instead.
    const codingStepIds = events.flatMap((event) =>
      event.type === "pipeline_event" && event.event.type === "step_started"
        ? event.event.role === "coder"
          ? [event.event.stepId]
          : []
        : [],
    );
    assert.deepEqual(codingStepIds, [
      "code-1",
      "code-2",
      "code-3",
      "code-4",
      "code-5",
    ]);
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

test("HeadlessRuntimeService halts a task that spends its dollar budget", async () => {
  const root = await mkdtemp(join(tmpdir(), "agentic-budget-"));
  const store = new SessionStore({
    projectRoot: root,
    dataRoot: join(root, ".runtime-data"),
  });
  for (const agent of createDefaultAgents([])) store.registerAgent(agent);
  const events: RuntimeEvent[] = [];
  let calls = 0;
  // A model that never stops calling a tool: without a budget it would run to
  // the step limit, billing every turn.
  const service = new HeadlessRuntimeService({
    store,
    model: { providerId: "groq", modelId: "expensive" },
    resolveModel: () => ({
      respond: async () => {
        calls += 1;
        return {
          ...assistantResponse("", [
            {
              id: `look-${calls}`,
              name: "read_file",
              arguments: { path: `file-${calls}.txt` },
            },
          ]),
          usage: { inputTokens: 1000, outputTokens: 1000, totalTokens: 2000 },
          cost: 0.03,
        };
      },
    }),
    resolveTools: () =>
      new ToolRegistry().register({
        name: "read_file",
        description: "Read a file.",
        approval: "auto",
        parameters: {
          type: "object",
          properties: { path: { type: "string" } },
          required: ["path"],
          additionalProperties: false,
        },
        execute: async () => ({ output: "contents" }),
      }),
    requestApproval: async () => true,
    limits: { maxTaskCostUsd: 0.1, taskCostWarningRatio: 0.5 },
  });
  service.subscribe((event) => {
    events.push(event);
  });

  try {
    const session = service.createSession("Budget session");
    // Exceeding the budget stops the run and surfaces as a task failure rather
    // than silently returning a partial answer that already cost too much.
    await assert.rejects(
      service.runTask({
        sessionId: session.id,
        agentId: DEFAULT_AGENT_ID,
        prompt: "audit this project and tell me what the code does",
      }),
      /reached its \$0\.10 budget/u,
    );

    const taskId = store
      .listTasks(session.id)
      .map((task) => task.id)
      .at(-1)!;
    assert.equal(store.getTask(taskId)?.status, "failed");
    const spend = service.taskSpend(taskId);
    assert.ok(spend.costUsd > 0, "real usage must be billed to the task");
    assert.equal(spend.budgetUsd, 0.1);
    assert.equal(spend.modelCalls, calls);
    assert.equal(spend.inputTokens, 1000 * calls);
    assert.ok(
      calls <= 5,
      `the budget must stop the run early, but it made ${calls} model calls`,
    );

    const spendEvents = events.filter((event) => event.type === "task_spend");
    assert.equal(spendEvents.length, calls, "every call must publish spend");
    assert.ok(
      spendEvents.some((event) => event.level === "warning"),
      "approaching the ceiling must be announced",
    );
    assert.ok(
      spendEvents.some((event) => event.level === "exceeded"),
      "crossing the ceiling must be announced",
    );
    assert.match(
      String(store.getTask(taskId)?.state.errors ?? ""),
      /budget/iu,
      "the recorded failure must name the budget as the cause",
    );
  } finally {
    await service.close();
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

test("rolling back a created file preserves it by default and prunes empty parents otherwise", async () => {
  const root = await mkdtemp(join(tmpdir(), "agentic-rollback-"));
  const service = new WorkspaceFileService(root);

  try {
    const prepared = await service.prepareChange({
      path: "calculator/python/calculator.py",
      newContent: "print(2 + 2)\n",
      expectedHash: null,
    });
    const written = await service.applyPreparedChange(
      {
        path: "calculator/python/calculator.py",
        newContent: "print(2 + 2)\n",
        expectedHash: null,
      },
      prepared,
      prepared.hunks.map((hunk) => hunk.id),
    );
    const created = join(root, "calculator", "python", "calculator.py");
    assert.equal(await readFile(created, "utf8"), "print(2 + 2)\n");

    // Recovery must never delete the only copy of newly generated work.
    const preserved = await service.rollbackMutation(written.mutation!, {
      preserveCreatedFiles: true,
    });
    assert.equal(preserved.status, "preserved");
    assert.equal(await readFile(created, "utf8"), "print(2 + 2)\n");

    // An explicit rollback still removes the file and the directories it made.
    const removed = await service.rollbackMutation(written.mutation!);
    assert.equal(removed.status, "rolled_back");
    assert.equal(existsSync(created), false);
    assert.equal(
      existsSync(join(root, "calculator")),
      false,
      "a rolled-back creation must not leave empty directories behind",
    );
  } finally {
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
  const coderRequests: ModelRequest[] = [];
  let mutationExecutions = 0;
  const models = new Map<string, LanguageModel>([
    [
      DEFAULT_AGENT_ID,
      new FakeModel([assistantResponse("1. Implement safely")]),
    ],
    [
      CODING_AGENT_ID,
      {
        respond: async (request) => {
          coderRequests.push(request);
          return assistantResponse("", [
            {
              id: `write-${coderRequests.length}`,
              name: "write_file",
              arguments: {
                content:
                  coderRequests.length === 1
                    ? '<!doctype html><html><body><canvas></canvas><input type="range"><input type="range"><input type="range"><script>const gl=document.querySelector("canvas").getContext("webgl"); // ... (generate the remaining implementation)</script></body></html>'
                    : coderRequests.length === 2
                      ? '<!doctype html><html><style>.cube{perspective:800px}.face{transform:rotateY(45deg)}</style><body><div class="cube"><div class="face"></div></div><input type="range"><input type="range"><input type="range"></body></html>'
                      : '<!doctype html><html><style>.cube{transform-style:preserve-3d}.face{transform:translateZ(1px)}</style><body><div class="cube"><div class="face"></div></div><input type="range"><input type="range"><input type="range"></body></html>',
              },
            },
          ]);
        },
      },
    ],
    [
      VERIFIER_AGENT_ID,
      new FakeModel([
        assistantResponse("", [
          {
            id: "verify-read",
            name: "read_file",
            arguments: { path: "rotating_cube.html" },
          },
        ]),
        assistantResponse("VERIFICATION_PASSED"),
      ]),
    ],
    [
      REVIEWER_AGENT_ID,
      new FakeModel([
        assistantResponse("Review complete."),
        assistantResponse("Resumed review complete."),
      ]),
    ],
  ]);
  const tools = new ToolRegistry()
    .register({
      name: "write_file",
      description: "Record a test mutation.",
      approval: "auto",
      parameters: {
        type: "object",
        properties: { content: { type: "string" } },
        required: ["content"],
        additionalProperties: false,
      },
      execute: async () => {
        mutationExecutions += 1;
        return { output: "changed", changed: true };
      },
    })
    .register({
      name: "read_file",
      description: "Read the created test artifact.",
      approval: "auto",
      parameters: {
        type: "object",
        properties: { path: { type: "string" } },
        required: ["path"],
        additionalProperties: false,
      },
      execute: async () => ({ output: "<html>cube</html>" }),
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
      prompt:
        "make a file named rotating_cube.html with a 3d rotating cube, we must have 3 sliders of x,y,z axis",
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
    assert.equal(coderRequests.length, 3);
    assert.equal(mutationExecutions, 1);
    assert.deepEqual(
      coderRequests[0]?.tools.map((tool) => tool.name),
      ["write_file"],
    );
    assert.equal(
      events.some(
        (event) =>
          event.type === "pipeline_event" &&
          event.event.type === "step_retrying" &&
          event.event.stepId === "code",
      ),
      false,
    );
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
    assert.match(
      (
        persisted?.state.orchestration as {
          results?: { retrieve?: { summary?: string } };
        }
      ).results?.retrieve?.summary ?? "",
      /Greenfield artifact/,
    );
    assert.equal(persisted?.state.result, "Review complete.");
    const completedSession = store.getSession(session.id);
    const assistantMessages = completedSession?.messages.filter(
      (message) => message.role === "assistant",
    );
    assert.deepEqual(
      assistantMessages?.map((message) => message.content),
      ["Review complete."],
    );
    assert.ok(
      assistantMessages?.[0]?.metadata?.thinking?.includes("Planner started"),
    );
    assert.ok(
      assistantMessages?.[0]?.metadata?.thinking?.includes(
        "Reviewer completed",
      ),
    );

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
