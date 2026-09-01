# Workspace Context

## Identity

- Project: `agentic-runtime`
- Purpose: build an agentic AI runtime and coding IDE architecture fully in
  TypeScript
- Current phase: core stabilization and hybrid architecture integration
- Repository root: `C:\MY_PROJECT\TAKNEEK-26\agent-0`

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
packages/retrieval/src/  Persistent project-isolated semantic code retrieval
packages/session/src/    SQLite global/project/session persistence
packages/gateway/src/    Provider registry, routing, credential resolution
packages/runtime/src/    Headless application service shared by TUI and future IDE hosts
packages/gui/src/        Browser-based settings/chat/diff/dashboard UI (Vite)
packages/gui-server/src/ Local node:http bridge: settings API + static GUI host
packages/desktop/src/    Electron desktop host owning GUI server/window lifecycle
rust/src/                Rust sidecar for AST slicing, diff hunks, and state primitives
examples/                Runnable provider examples
agent-context/           Persistent context for coding agents
```

## Decision: hybrid core, no Tauri dependency

`packages/gui/src-tauri` was removed. The current UI is a React/Tailwind/Vite
browser workbench backed by `packages/gui-server`, but the core architecture retains
a separate Rust process under `rust/` for performance-sensitive AST slicing,
diff hunk generation, and future state/index primitives. TypeScript remains the
orchestration and package-boundary layer. `pnpm build` compiles the Rust sidecar
before the TypeScript workspace so a clean build produces the binary expected
by `RustClient`.

## Commands

```sh
pnpm install
pnpm build
pnpm typecheck
pnpm test
pnpm tui
pnpm settings
pnpm start
pnpm desktop:quick
pnpm desktop:package
pnpm lint
pnpm format
pnpm format:check
```

Build artifacts are emitted under package `dist/` directories and
`rust/target/`; they are ignored by git.

## Current Status

- The workspace installs successfully with pnpm; building the hybrid core also
  requires a working Rust/Cargo toolchain.
- `@agentic-runtime/core`, `@agentic-runtime/runtime`, `@agentic-runtime/openai`, and
  `@agentic-runtime/ollama`, `@agentic-runtime/command`,
  `@agentic-runtime/search`, `@agentic-runtime/tools`,
  `@agentic-runtime/tui`, and `@agentic-runtime/workspace` compile successfully.
- ESLint and Prettier checks pass.
- `pnpm settings` builds the workspace and the GUI, then serves both the
  provider-settings API and the built GUI from one process
  (`@agentic-runtime/gui-server`, `node:http` only, bound to `127.0.0.1`).
  Saved credentials/base URLs/model IDs are read by the TUI and GUI from the
  same global SQLite database via `SessionStore` and
  `@agentic-runtime/gateway`'s `StoredCredentialResolver` - a key saved once
  works in either client. The TUI also has an equivalent `/settings` command
  for the same records.
- The GUI provides Monaco file inspection, project search, durable sessions,
  bounded manual file context, provider configuration, historical trace
  drill-down, live agent chat, conflict-safe file editing, and a bounded
  workspace command terminal. Its loopback runtime transport supports SSE
  task/routing/pipeline events, cancellation, and approval resolution while
  preserving the headless runtime's safety policy.
- The terminal discovers installed shell profiles (PowerShell, CMD, Git Bash,
  and Bash where available), executes each command through the selected native
  shell with bounded output, and exposes a VS Code-style `Ctrl+\`` focus entry.
- `@agentic-runtime/desktop` hosts the same GUI in a sandboxed Electron window,
  chooses an available loopback port, owns server shutdown, starts without an
  implicit workspace, and provides native open/switch/close-folder workflows.
  The last folder is only the picker's default location. `pnpm start` is the
  single-command source launch path; `pnpm desktop:package` builds the current
  platform's installer formats. Packaging explicitly stages the platform
  ripgrep executable under the application's runtime resources.
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
  multi-agent workflow with dependency checks, persisted retry/failure state,
  verifier recovery, stuck-failure detection, time/attempt budgets, and
  checkpoint callbacks.
- The headless runtime executes coding tasks through the checkpointed
  `planner -> retriever -> coder -> verifier -> reviewer` pipeline and exposes
  `resumeTask()` so completed stages are skipped after process restart.
- `AgentRunner` performs structured token-budget compaction, supports repeated
  compaction, preserves project rules/task facts/file hashes, and retries bounded
  context-length failures without advancing the workflow step.
- File mutation previews contain stable addressable hunks and a base hash.
  Boolean approvals remain compatible, while structured decisions can apply only
  accepted hunks, reject stale bases, and return rejected hunks to the agent.
- Verifier recovery state, hash-guarded rollback primitives, fresh retrieval,
  replanning, and corrective approval exist. Default file tools do not yet return
  their mutation records to the runtime journal, so normal end-to-end rollback
  remains incomplete. Command and Git side effects are not guessed at.
- Session-scoped manual file/line context and isolated `/bytheway` are exposed by
  the headless runtime and TUI without contaminating the durable main transcript.
- SQLite trace schemas and runtime handlers preserve task, pipeline, agent,
  provider, compaction, and isolated-question spans. Model and tool correlation,
  exact request/response data, and context propagation remain incomplete.
- Model requests are abortable; paused tasks, pending recovery, and task-wide
  model budgets survive resume. Tool-call floods and TUI activity memory are
  bounded, and stalled observers cannot block runtime progress.
- `@agentic-runtime/session` exposes `createTaskCheckpointStore` to persist and
  resume orchestration state inside project-isolated SQLite task records.
- `SessionStore` persists registry-driven agent definitions, and
  `MultiAgentOrchestrator` resolves agents by ID with bounded `handoff_agent`
  delegation instead of hardcoded role implementations.
- The TUI consumes `HeadlessRuntimeService`, defaults to the Architect, and
  supports `/agents` plus `/agent <id>` for selection.
- Restricted agents can use `delegatesTo`; blocked tool calls are converted to
  automatic specialist handoffs instead of being executed or silently lost.
- Custom agent definitions persist in global SQLite and project Markdown files.
  The current TUI lists and selects agents but does not expose CRUD commands.
- Versioned project agents can be defined in `.agentic/agents/*.md` using YAML
  frontmatter plus a Markdown system prompt; these are imported at TUI startup.
- The agent runner continues explicit multi-step coding requests when a model
  stops after an intermediate tool result, requiring requested mutation,
  reread, and verification stages. Corrective prompts stop after two retries
  per stalled phase instead of consuming the entire model-step budget.
- Standalone requests to show or generate code bypass the repository-edit
  pipeline and receive a direct answer; Coder pipeline success requires a real
  mutation tool result.
- No-op mutations are detected and do not count as a changed file when deciding
  whether a reread is required.
- Safety limits are layered: Coder may use at most 16 model turns, while the
  task-wide pipeline permits 32 model calls. Focused single-file edits and
  greenfield files stop immediately after their successful mutation instead of
  consuming the remaining per-agent budget.
- Denying an approval pauses the active agent and durable pipeline immediately;
  the model does not receive more tool turns after an explicit human denial.
- Verifier scope is limited to the explicit objective and existing project
  rules. Its pass marker is recognized at the start of its own line even when a
  provider adds Markdown or a trailing checklist, avoiding false recovery after
  a successful check.
- With Groq selected, configured fallbacks are ordered OpenRouter/Nemotron,
  Cerebras, Hugging Face, hosted Mistral, custom OpenAI-compatible, then local
  Ollama. The gateway can attempt all seven eligible provider families.
- HTTP 402 and explicit quota/credit exhaustion are route-level failures: the
  unavailable provider is cooled down and the same request immediately moves to
  the next configured provider instead of repeating the pipeline step.
- Quota failures use a 30-minute circuit-breaker cooldown instead of the normal
  30-second transient cooldown. Simple one-file creation/edit tasks skip a
  redundant Reviewer model call after independent verification, and successful
  file work is summarized in chat as only `Saved <path>.`.
- Gateway-created Ollama requests currently use the adapter's 300-second timeout;
  `OLLAMA_TIMEOUT_MS` is not wired into runtime composition.
- Ollama availability checks normalize the implicit `:latest` tag and confirm
  configured aliases through `/api/show`, preventing installed models such as
  `mistral:latest` from being reported missing when configured as `mistral`.
- Desktop Ollama routes use an 8K context window sent as `num_ctx`, and the fallback parser
  accepts common flat, array, wrapped, nested-function, and
  `tool`/`parameters` JSON call formats.
- An isolated Ollama IDE test successfully created and read a TypeScript file
  through `create_file` and `read_file`.
- The multi-step edit workflow has been tested through inspection, patching,
  rereading, and build execution.
- `tests/runtime.test.ts` covers registry behavior, agent tool execution,
  approval denial, step limits, the IDE tool catalog, workspace diffs/conflicts,
  ripgrep search, and cross-platform command execution.
- `@agentic-runtime/tools` includes bounded `browse_url` and `crawl_site` web
  tools, plus structured read-only and approval-gated Git tools backed by
  Mozilla Readability, JSDOM, Crawlee, and simple-git.
- Git repository initialized on `main`; the initial workspace commit is
  `bca0b3b`. The configured GitHub push was blocked by network/authentication.
