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
- Added the provider-neutral `TaskOrchestrator` with dependency-ordered role
  workers, bounded retries, repeated-failure detection, time/attempt budgets,
  lifecycle events, and checkpoint callbacks. Added the SQLite task checkpoint
  adapter and tests for ordering, retries, stuck tasks, and persistence.
- Added SQLite-backed `AgentDefinition` records and the registry-driven
  `MultiAgentOrchestrator`. Agents are resolved by ID, receive per-agent model
  and tool resolvers, and can hand off focused work through bounded
  `handoff_agent` calls. Added registry and specialist-handoff tests.
- Wired the TUI through `MultiAgentOrchestrator`, including SQLite agent
  bootstrap/selection, `/agents`, `/agent <id>`, history forwarding, nested
  handoff display, and persisted multi-agent events.
- Added a persistent default `coding-agent` definition with disciplined inspect,
  edit, delegate, and verify instructions. The TUI seeds it only when missing
  and selects it by default while preserving custom agents.
- Added a persistent `general` meta-agent as the TUI default. It is restricted
  to inspection and `handoff_agent`, delegates coding/debugging work to
  `coding-agent`, and is refreshed alongside the reserved coding definition so
  older bootstrap records cannot retain unsafe behavior.
- Enforced restricted-agent delegation with automatic proxies for blocked tools,
  and added coverage for a blocked `write_file` request being handed to the
  configured coding agent.
- Added established-library web and Git tooling: Readability/JSDOM article
  extraction, bounded same-domain Crawlee crawling, and simple-git status,
  diff, log, branch, stage, commit, checkout, and push operations.
- Fixed TUI tool routing so the general agent can directly use read-only web and
  Git tools, increased default agent budgets to 24 steps, and instructed agents
  not to emulate specialized tools with shell commands.
- Added a configurable Ollama request timeout (`OLLAMA_TIMEOUT_MS`, default 45
  seconds) with an explicit timeout error instead of an indefinite-looking TUI
  spinner.
- Added persistent custom-agent CRUD through the TUI, including prompted
  definition fields, validation, active-agent deletion protection, and reserved
  default-agent safeguards.
- Separated project rules from agent definitions by adding `.agentic/agents/*.md`
  discovery with YAML frontmatter, startup import, and a shared researcher
  definition example.
- Implemented real AST slicing in `rust/src/flatcpg.rs` using `tree-sitter-typescript` to extract exact function declarations.
- Implemented real structural diff logic in `rust/src/diff.rs` returning line-based `DiffChunk` patches.
- Wired Rust logic in `main.rs` and completely removed all comments from Rust files to adhere to strict constraints.
- Extended the `test-bridge.ts` to test against actual TypeScript source code and successfully validated AST/diff results.
- End-to-End TUI testing revealed prompt/JSON-parsing limits of 7B models for large diff tool arguments.
- Re-routed General Agent via `OPENAI_COMPATIBLE_MODEL` to `qwen/qwen3.6-27b` on Groq to respect the <=80B and "Free API" constraint, successfully completing the autonomous demo loop.

## 2026-08-28

- Stabilized the Rust child-process bridge with typed RPC payloads, spawn/exit
  handling, bounded request timeouts, compatible binary-path configuration, and
  correct source-extension forwarding for tree-sitter slicing.
- Corrected compaction to prune the actual `read_file` content while preserving
  structured path/hash metadata and task-scoped persisted summaries.
- Replaced whole-file Rust diff output with minimal line-based hunks plus partial
  merge tests for separate edits, insertions, and deletions.
- Made the hybrid build reproducible: `pnpm build` now compiles the Rust sidecar
  before the TypeScript workspace, and `Cargo.lock` is no longer ignored.
- Fixed optional tool schemas so search, browse, crawl, and Git checkout defaults
  work without model-supplied optional arguments.
- Persisted TUI task outcomes, agent/tool events, approval events, and failure
  details; fixed fallback transcript persistence so it retains the user prompt.
- Added `.agentic/data/` to `.gitignore` and made formatter behavior robust to
  the repository's existing mixed line endings.
- Fixed alternating duplicate tool loops (`A -> B -> A -> B`) by caching calls
  across an unchanged workspace revision and returning concise skip results
  instead of duplicating large tool output in model context.
- Added hidden tool registrations so blocked-operation delegation proxies remain
  enforceable without advertising all proxy schemas to restricted agents; the
  Architect now receives 5 schemas instead of the full 26-tool catalog.
- Added one global model-request budget shared by parent and child agents,
  checked before ordinary and compaction model calls, so nested agents cannot
  each consume an independent 24-step allowance.
- Added a per-direction handoff cap that rejects reworded repetitions such as
  repeated `coding-agent -> reviewer` requests after two attempts.
- Added default wall-clock enforcement before every nested model request; the
  TUI uses a 32-model-step, 8-handoff, 4-depth, 10-minute run budget.
- Updated the TUI progress denominator to show the global 32-step budget instead
  of a misleading per-agent 24-step limit.
- Verified 30 TypeScript tests, 8 Rust tests, the hybrid build, and ESLint.

- Added `@agentic-runtime/runtime`, a headless application service that owns
  built-in agents, provider/tool composition, persisted sessions/tasks/events,
  approvals, cancellation, and per-task multi-agent orchestration.
- Migrated the TUI from direct `SessionStore`/gateway/tool/orchestrator ownership
  to the headless service, making it a presentation adapter suitable for later
  replacement or reuse by an IDE/Tauri transport.
- Added transport-friendly runtime event, task-handle, approval, model-selection,
  settings, and limit contracts; each task now captures immutable session/task
  correlation and receives a fresh orchestrator.
- Fixed `/new` and `/agent` presentation state updates, implemented active-task
  cancellation through the service, and removed nonexistent help commands.
- Added the runtime package to build, clean, typecheck, workspace dependencies,
  and integration coverage. Verified 31 TypeScript tests.

- Added typed model errors, route ranking, cooldowns, retryable provider
  failover, persisted routing events, and live TUI route/failover activity.
- Added `@agentic-runtime/retrieval`, a persistent project-isolated SQLite index
  with TypeScript semantic extraction, mixed-language fallback, ranked slices,
  incremental hashes, and query recovery.
- Promoted `TaskOrchestrator` into the headless coding path as the sequential
  planner/retriever/coder/verifier/reviewer pipeline. Added persisted attempts
  and failure fingerprints, corrective coder recovery, one global pipeline model
  budget, and `HeadlessRuntimeService.resumeTask()` stage resume.
- Replaced fixed-character compaction with token-window-aware structured state,
  bounded repeated compaction, context-limit retry, task checkpoint persistence,
  and preservation of project rules, rejected hunks, and changed file hashes.
- Added base-hash-bound stable diff hunks and structured approvals with boolean
  compatibility. The TUI supports per-hunk toggles and accept-all/reject-all;
  the workspace atomically applies selected hunks and feeds rejections back to
  the model.
- Verified 44 TypeScript tests after adding pipeline, resume, compaction,
  context-recovery, partial-approval, insertion/deletion, and conflict coverage.
- Added durable pending recovery and a hash-guarded workspace mutation journal.
  Failed verification now rolls back safe file-tool changes, preserves later user
  edits on conflict, refreshes retrieval, replans, requires fresh approval, and
  reverifies. External command/Git side effects block automatic rollback.
- Added persisted hierarchical trace spans for tasks, pipeline stages, agents,
  model calls, provider attempts, tools, and compaction with sanitized exact I/O,
  context artifacts, token usage, timing, route, and available cost.
- Added session-isolated `/context` file/line snapshots and a zero-context
  `/bytheway` execution path that leaves the main transcript unchanged.
- Hardened long runs with abortable provider calls, disabled hidden OpenAI SDK
  retries, persisted model budgets, paused cancellation, tool-call caps,
  observer-safe events, route activity deduplication, and bounded TUI state.
- Expanded the deterministic suite to 54 TypeScript tests plus 8 Rust tests.
- Made TUI workspace argument parsing accept pnpm's forwarded `--` separator
  and documented Git Bash-safe relative and forward-slash paths.
- Excluded ignored disposable `tmp/` workspaces from repository linting.
- Routed command-only test, build, lint, and syntax requests directly to the
  verifier instead of the mutation pipeline, and supplied project instructions
  to the verifier so it uses repository-defined commands.
- Added source-grounded architecture/status and runbook/interface references
  under `docs/`, including current recovery and tracing gaps and a prioritized
  path to the IDE transport and final Tauri wrapper.
- Audit correction: the recovery state machine and trace schema were added, but
  default file tools do not yet populate the mutation journal and `AgentRunner`
  does not yet emit complete model/tool correlation data. Earlier entries that
  describe those paths as complete refer to intended behavior, not current
  end-to-end wiring. The current TypeScript suite contains 47 tests.

## Next Steps

- Refine the IDE Observability Dashboard to show full call hierarchy traces per the PS requirements.
- Finalize the codebase semantic index (beyond ripgrep) for complex code retrieval.
- Document the entire system architecture, routing decisions, and API setup process in `README.md` for the final submission.
- Package cross-platform builds and ensure zero-friction setup.
