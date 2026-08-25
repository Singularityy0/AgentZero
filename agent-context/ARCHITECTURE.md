# Architecture Context

## Design Direction

The runtime should be developed as independent TypeScript packages under
`packages/`. `@agentic-runtime/core` is the initial package and should contain
the framework-neutral runtime primitives once implementation begins.

Rust packages/components belong under `rust/` and should be introduced only
when there is a concrete boundary and integration plan. Rig is a future
integration target, not a current dependency.

## Planned Boundaries

These are future boundaries, not implemented modules:

- `core`: runtime abstractions and orchestration primitives
- `openai`: OpenAI provider adapter and response API boundary
- `ollama`: Ollama local provider adapter and response API boundary
- `tui`: terminal presentation layer depending on the OpenAI provider
- `command`: cross-platform native shell command executor
- `tools`: semantic IDE tools using workspace/search services and command execution
- `workspace`: workspace-bound file service with hashes, diffs, and atomic writes
- `search`: packaged ripgrep search service
- `session`: SQLite persistence for global settings and project state
- future Rust components: performance-sensitive or native integrations

Keep the core package independent of specific LLM vendors and agent
frameworks.

## Explicitly Not Implemented

- Advanced scheduling
- Additional provider adapters
- Prompt management
- Tool execution
- Terminal or filesystem agent access
- Memory, planning, or retrieval systems
- Rust bindings or Rig integration

The core `LanguageModel` interface is provider-neutral. `OpenAIModel` and
`OllamaModel` implement it independently. The TUI selects one from
`MODEL_PROVIDER`; the `AgentRunner` owns the model/tool loop, while the TUI
owns presentation and approval decisions.

Command execution is isolated in its own package. The executor selects
`cmd.exe` on Windows and `/bin/sh` on Linux/macOS, unless explicitly configured.
Commands require approval, have a timeout and output limit, and do not receive
the OpenAI API key.

The IDE-facing tools in `packages/tools` use Node-based workspace and search
services for IDE operations. The generic `run_command` tool and project command
tools use the platform command executor for operations that require a shell.

The `workspace` service uses `diff` to generate previews and rejects stale file
changes when the expected content no longer matches. The `search` service uses
`@vscode/ripgrep` and normalizes results to workspace-relative paths.

`ToolRegistry` validates every model argument object with `ajv` before the
`AgentRunner` asks for approval. Mutating tools provide a preview to the TUI;
the TUI displays that preview before allowing execution.

Session persistence is split by scope: global SQLite stores user settings and
credential references, while a project SQLite database stores sessions, tasks,
events, context items, and future checkpoints. The project ID is derived from
the canonical project root, and all project queries are scoped to that ID.
The TUI is only the current client; it does not own durable conversation state.

`AgentRunner` also tracks tool name/argument signatures during a run. If a
model repeats an identical call, it stops safely and returns the previous tool
result rather than entering an unbounded repair loop. If the global step limit
is reached, the runner returns the last response with a visible safety warning
instead of throwing an opaque request failure.

For explicit multi-step coding requests, `AgentRunner` tracks required
follow-through stages such as mutation, reread, and build/verification. If the
model returns text before those stages, it receives an internal continuation
request instead of ending the run early.

Language-specific services, LSP, tree-sitter grammars, and image analysis are
intentionally deferred.

## Extension Guidance

Before adding a package, define its responsibility and dependency direction.
Prefer small public interfaces and keep provider-specific behavior outside the
core runtime. The OpenAI adapter demonstrates this separation. Add
dependencies only when they support an implemented need.

Core tool contracts are defined in `packages/core/src/tools.ts`, message types
in `packages/core/src/messages.ts`, and registration in
`packages/core/src/tool-registry.ts`. Concrete tools must depend on these
contracts rather than the OpenAI provider.
