# Workspace Context

## Identity

- Project: `agentic-runtime`
- Purpose: build an agentic AI runtime in TypeScript first, with future Rust
  components using Rig (`rig.rs`)
- Current phase: workspace setup only
- Repository root: `D:\MediaServer\MEDIA\porno`

## Toolchain

- Node.js 20 or newer is required; the setup was verified with Node.js 24.
- pnpm 9 or newer is required.
- The pinned package manager is `pnpm@9.15.5`.
- TypeScript uses strict checking, ES2022, and NodeNext modules.

## Layout

```text
packages/core/src/       Framework-neutral runtime package entry point
packages/openai/src/     OpenAI response provider
packages/ollama/src/     Ollama local model provider
packages/tui/src/        Interactive terminal chat interface
packages/tools/src/      Separate IDE-facing tools
packages/workspace/src/  Safe file operations and patch/diff service
packages/search/src/     Ripgrep-backed text and file search
examples/                Placeholder for runnable examples
rust/                    Placeholder for future Rust packages/components
agent-context/           Persistent context for coding agents
```

## Commands

```sh
pnpm install
pnpm build
pnpm typecheck
pnpm test
pnpm example:openai "your prompt"
pnpm tui
pnpm lint
pnpm format
pnpm format:check
```

Build artifacts are emitted to `packages/core/dist/` and are ignored by git.

## Current Status

- The workspace installs successfully with pnpm.
- `@agentic-runtime/core`, `@agentic-runtime/openai`, and
  `@agentic-runtime/ollama`, `@agentic-runtime/powershell`,
  `@agentic-runtime/search`, `@agentic-runtime/tools`,
  `@agentic-runtime/tui`, and `@agentic-runtime/workspace` compile successfully.
- ESLint and Prettier checks pass.
- `@agentic-runtime/core` exports framework-neutral conversation, tool, and
  tool-registry contracts.
- `@agentic-runtime/openai` exposes `generateOpenAIResponse` using the OpenAI
  Responses API.
- `@agentic-runtime/ollama` implements the same `LanguageModel` interface using
  Ollama's `/api/chat` endpoint and supports structured tool calls.
- `@agentic-runtime/tui` exposes the `agentic-tui` CLI and streams a simple
  multi-turn conversation with approval-based tool execution. It loads `.env`
  and selects the provider using `MODEL_PROVIDER`.
- `@agentic-runtime/powershell` executes approved commands with `pwsh`, a
  timeout, bounded output, a sanitized environment, and `execa` process
  handling.
- `@agentic-runtime/tools` exposes separate `list_directory`, `read_file`,
  `write_file`, `create_file`, `delete_file`, `run_powershell_command`,
  `apply_patch`, `find_files`, `search_text`, `compile_code`, `run_code`,
  `format_code`, and `syntax_check` tools.
- `@agentic-runtime/workspace` provides workspace-bound file reads, writes,
  creates, deletes, hashes, conflict checks, atomic writes, and unified diffs.
- `@agentic-runtime/search` uses the packaged ripgrep binary for search.
- `ajv` validates model-generated tool arguments before approval or execution.
- Filesystem tools restrict paths to the configured workspace; all registered
  tools require TUI approval through the agent runner.
- File mutations produce unified diffs and use workspace file conflict checks;
  TUI approval receives the preview before execution.
- OpenAI credentials are read from `OPENAI_API_KEY` by the example and are
  never stored in the repository.
- The local `.env` is configured for `qwen2.5-coder:latest` at the local Ollama
  endpoint; `.env` is ignored and must not be committed.
- The agent runner stops identical repeated tool calls within one run and
  returns the previous result instead of exhausting the step limit; safety-limit
  runs now return a visible warning instead of throwing.
- The agent runner continues explicit multi-step coding requests when a model
  stops after an intermediate tool result, requiring requested mutation,
  reread, and verification stages.
- No-op mutations are detected and do not count as a changed file when deciding
  whether a reread is required.
- The default agent safety budget is 12 model steps to allow read, edit,
  approval, verification, and final-response workflows.
- An isolated Ollama IDE test successfully created and read a TypeScript file
  through `create_file` and `read_file`.
- The multi-step edit workflow has been tested through inspection, patching,
  rereading, and build execution.
- `tests/runtime.test.ts` covers registry behavior, agent tool execution,
  approval denial, step limits, the IDE tool catalog, workspace diffs/conflicts,
  ripgrep search, and PowerShell execution.
- No git repository has been initialized in this directory yet.
