import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { test } from "node:test";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  AgentRunner,
  ToolRegistry,
  type LanguageModel,
  type ModelResponse,
  type Tool,
} from "../packages/core/dist/index.js";
import { executePowerShellCommand } from "../packages/powershell/dist/index.js";
import { findFiles, searchText } from "../packages/search/dist/index.js";
import { createIdeTools } from "../packages/tools/dist/index.js";
import { WorkspaceFileService } from "../packages/workspace/dist/index.js";

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

test("ToolRegistry rejects duplicate names and lists definitions", () => {
  const registry = new ToolRegistry().register(echoTool());

  assert.equal(registry.has("echo"), true);
  assert.equal(registry.list()[0]?.name, "echo");
  assert.throws(() => registry.register(echoTool()), /already registered/);
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

test("AgentRunner stops a repeated identical tool call", async () => {
  const call = { id: "call-4", name: "echo", arguments: { value: "repeat" } };
  const registry = new ToolRegistry().register(echoTool());
  const model = new FakeModel([
    assistantResponse("", [call]),
    assistantResponse("", [{ ...call, id: "call-5" }]),
  ]);

  const result = await new AgentRunner(model, registry, {
    cwd: process.cwd(),
    requestApproval: async () => true,
  }).run([{ role: "user", content: "Repeat." }]);

  assert.match(result.text, /same tool call again/);
  assert.match(result.text, /repeat/);
});

test("AgentRunner continues an interrupted edit and verification workflow", async () => {
  const registry = new ToolRegistry();
  for (const name of ["read_file", "apply_patch", "compile_code"]) {
    registry.register({
      name,
      description: name,
      parameters: { type: "object", additionalProperties: true },
      execute: async () => ({ output: `${name} completed` }),
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

test("createIdeTools exposes the separate IDE tool catalog", () => {
  assert.deepEqual(
    createIdeTools().map((tool) => tool.name),
    [
      "list_directory",
      "read_file",
      "write_file",
      "create_file",
      "delete_file",
      "apply_patch",
      "find_files",
      "search_text",
      "run_powershell_command",
      "compile_code",
      "run_code",
      "format_code",
      "syntax_check",
    ],
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

test("PowerShell executor returns bounded command results", async () => {
  const result = await executePowerShellCommand(
    "Write-Output agentic-runtime-test",
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
