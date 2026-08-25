# Work Log

## 2026-08-25

- Created the initial pnpm TypeScript monorepo workspace.
- Added the `@agentic-runtime/core` package with an empty entry point.
- Added strict TypeScript compilation, ESLint, and Prettier.
- Verified install, build, lint, and formatting checks.
- Added persistent agent context under `agent-context/` and root instructions
  in `AGENTS.md`.
- Added `@agentic-runtime/openai` with a minimal OpenAI Responses API wrapper
  and a runnable `examples/openai-response.ts` example.
- Kept API keys out of source and documented `OPENAI_API_KEY` usage.
- Verified the provider builds, lints, and formats; the example reached the
  OpenAI API and returned HTTP 401 for the currently configured environment key.
- Added `@agentic-runtime/tui`, a dependency-light interactive terminal chat
  interface with streaming, history, and `/help`, `/clear`, `/model`, and
  `/exit` commands.
- Verified the complete workspace build, typecheck, lint, formatting, and TUI
  startup path.
- Added `tests/runtime.test.ts` and a `pnpm test` command covering the core
  agent/tool behavior and IDE tool catalog.
- Added the first core runtime contracts: conversation messages, structured
  tool calls/results, tool execution context, and `ToolRegistry`.
- Added provider-neutral `LanguageModel` contracts and an `AgentRunner` that
  loops over model tool calls until a final response.
- Added an approval-gated PowerShell tool with timeout, output limits, and
  sanitized child-process environment.
- Updated the TUI to register PowerShell and route OpenAI tool calls through the
  generic agent runner.
- Added separate IDE-facing tools for filesystem operations, PowerShell,
  compile/run/format, and syntax checks. They share the PowerShell executor but
  expose structured schemas to the model.
- Verified all ten tools register, read-only tools execute locally, paths outside
  the workspace are blocked, and the TUI starts with the tool catalog.
- Added the researched IDE tooling stack: `diff`, `ajv`, `@vscode/ripgrep`, and
  `execa`.
- Added workspace-safe file operations with hashes, conflict detection,
  atomic writes, and diff previews; added ripgrep-backed search tools.
- Added `apply_patch` and TUI diff previews, with `ajv` validation before tool
  approval and execution.
- Migrated PowerShell process execution to `execa` and added eight tests for
  the expanded runtime/tooling path.
- Added `workspace` and `search` packages using `diff`,
  `@vscode/ripgrep`, and Node filesystem APIs; the final suite now passes eight
  tests plus build, lint, and formatting checks.
- Fixed repeated Ollama tool-call loops by correcting assistant tool-call
  serialization and adding a repeated-call guard in `AgentRunner`.
- Verified the local Ollama model can call `list_directory`, execute it through
  the PowerShell backend, and receive a final summary.
- Fixed Ollama fallback parsing for multiple JSON tool calls returned on
  separate lines and verified create/read file operations in an isolated
  temporary workspace.
- Strengthened the TUI system instruction to require completion of all steps in
  multi-step coding requests instead of stopping after an intermediate read.
- Added deterministic follow-through in `AgentRunner` for explicit edit,
  reread, and verification requests, plus a regression test for interrupted
  coding workflows.
- Corrected Ollama assistant/tool message fields (`type: function` and
  `tool_name`) and verified the requested model-file edit/build workflow.
- Changed step-limit handling to return a visible warning instead of failing the
  entire TUI request.
- Added SQLite-backed global/project session management with persisted sessions,
  tasks, events, context items, and global settings, plus `/new`, `/sessions`,
  and `/resume` TUI commands.
- Verified the TUI starts with SQLite session state and the session command
  path; full persistence is covered by the automated test suite.
- Strengthened workflow continuation prompts with the original user request and
  explicit next-tool requirements after the model stopped at `read_file`.
- Removed a hallucinated nonexistent `constants.js` import from the test edit,
  increased the default workflow budget to 12 steps, and made post-approval
  continuation instructions explicit.
- Added no-op mutation reporting so an already-present requested change can
  proceed to verification without entering a reread loop, and corrected build
  package ordering for generated declaration dependencies.
- Added `@agentic-runtime/ollama` with local endpoint/model configuration and
  structured tool-call support. The TUI now loads `.env` and selects OpenAI or
  Ollama using `MODEL_PROVIDER`.
- Added a constrained JSON tool-call fallback for local models that return a
  function call as assistant JSON text instead of native `tool_calls`.
- Verified Ollama connectivity and the complete local agent loop: the model
  requested `list_directory`, PowerShell-backed execution completed, and the
  model summarized the result.
- Reworked the TUI presentation layer with ANSI color, live model activity,
  task progress, tool cards, previews, and clearer approval prompts. Verified
  build, lint, formatting, and all existing runtime tests.
- Added explicit tool approval metadata. Read-only workspace/search tools are
  auto-approved; mutations and shell-backed commands remain approval-gated by
  default, with a regression test for the auto-approval path.
- Replaced the PowerShell-only command boundary with the cross-platform
  `@agentic-runtime/command` package. Commands now use `cmd.exe` on Windows and
  `/bin/sh` on Linux/macOS, with the agent-facing tool renamed to `run_command`.
- Extended the Ollama fallback parser to recognize tagged and fenced JSON tool
  calls, preventing model-emitted `<tool_response>` calls from being displayed
  as ordinary assistant text.
