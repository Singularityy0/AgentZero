# Workspace Context

## Identity

- Project: `agentic-runtime`
- Purpose: build an agentic AI runtime in TypeScript first, with future Rust
  components using Rig (`rig.rs`)
- Current phase: workspace setup only
- Repository root: `D:\MediaServer\MEDIA\porno`

## Toolchain

- Node.js 22.5 or newer is required for the built-in `node:sqlite` API; the
  setup was verified with Node.js 24.
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
packages/session/src/    SQLite global/project/session persistence
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
  `@agentic-runtime/ollama`, `@agentic-runtime/command`,
  `@agentic-runtime/search`, `@agentic-runtime/tools`,
  `@agentic-runtime/tui`, and `@agentic-runtime/workspace` compile successfully.
- ESLint and Prettier checks pass.
- `@agentic-runtime/core` exports framework-neutral conversation, tool, and
  tool-registry contracts.
- `@agentic-runtime/openai` exposes `generateOpenAIResponse` using the OpenAI
  Responses API.
- `@agentic-runtime/ollama` implements the same `LanguageModel` interface using
  Ollama's `/api/chat` endpoint and supports structured tool calls.
- `@agentic-runtime/tui` exposes the `agentic-tui` CLI, loads `.env`, selects
  the provider using `MODEL_PROVIDER`, and persists sessions through SQLite.
- `@agentic-runtime/session` separates global settings from project-isolated
  sessions, tasks, events, and context items. It supports session resume.
- `@agentic-runtime/command` executes approved commands through the host native
  shell (`cmd.exe` on Windows, `/bin/sh` on Linux/macOS), with a timeout,
  bounded output, a sanitized environment, and `execa` process handling.
- `@agentic-runtime/tools` exposes separate `list_directory`, `read_file`,
  `write_file`, `create_file`, `delete_file`, `run_command`,
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
- The TUI now renders a colorful ANSI activity view with model-thinking status,
  task/event progress, tool action cards, previews, and styled permission prompts.
- Tool approval is fail-safe: explicitly read-only workspace/search tools run
  automatically, while mutations and all shell-backed tools require approval.
- `@agentic-runtime/core` now exposes `TaskOrchestrator`, a bounded sequential
  multi-agent workflow with dependency checks, retries, stuck-failure detection,
  time/attempt budgets, and checkpoint callbacks.
- `@agentic-runtime/session` exposes `createTaskCheckpointStore` to persist and
  resume orchestration state inside project-isolated SQLite task records.
- `SessionStore` persists registry-driven agent definitions, and
  `MultiAgentOrchestrator` resolves agents by ID with bounded `handoff_agent`
  delegation instead of hardcoded role implementations.
- The TUI uses `MultiAgentOrchestrator` directly, bootstraps a SQLite-backed
  `coding-agent` when needed, and supports `/agents` plus `/agent <id>` for
  selecting registered agents.
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
  ripgrep search, and cross-platform command execution.
- Git repository initialized on `main`; the initial workspace commit is
  `bca0b3b`. The configured GitHub push was blocked by network/authentication.
