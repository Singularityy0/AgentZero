# Architecture Context

## Design Direction

The runtime should be developed as independent TypeScript packages under
`packages/`. Runtime orchestration, provider routing, persistence, and UI-facing services
live behind TypeScript package boundaries. Performance-sensitive AST slicing,
diff generation, and future index/state primitives may run in the isolated Rust
sidecar through the typed `RustClient` boundary.

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
- `gateway`: provider discovery, model metadata, routing, failover, and cost
  governance
- `gui`: future TypeScript interface for settings, context control, review, and
  observability

Keep the core package independent of specific LLM vendors and agent
frameworks.

`@agentic-runtime/runtime` is the headless application boundary above these
packages. It composes the provider gateway, `SessionStore`, concrete IDE/Rust
tools, built-in agent policy, approvals, task lifecycle, cancellation, and event
persistence. Clients do not construct orchestration directly: the TUI consumes
this service now, and future IDE/Tauri hosts should expose the same service over
HTTP, SSE/WebSocket, or Tauri commands/events. Browser or webview code must not
import Node-only runtime packages directly.

`TaskOrchestrator` is the provider-neutral multi-agent workflow boundary. It
executes a dependency-checked plan sequentially through role-specific workers
(`planner`, `retriever`, `coder`, `verifier`, and `reviewer`; `researcher`
remains a compatibility role). Sequential
execution is intentional for the first reliable path: it prevents concurrent
agents from conflicting over the same working tree. Workers can internally use
`AgentRunner` and receive only scoped context plus prior step results.

The orchestrator checkpoints before and after each step, resumes completed
steps, retries failures with a per-step limit, detects repeated failure
fingerprints, and enforces total-attempt and optional wall-clock budgets. The
session package provides `createTaskCheckpointStore`, which stores the
serializable orchestration state inside the existing project-isolated task
record. Provider routing remains outside this boundary and can supply a
different `LanguageModel` to each worker.

The registry-driven runtime is the general multi-agent boundary. `AgentRunner`
is only a generic model/tool conversation executor; it does not represent a
role or contain a fixed agent. `MultiAgentOrchestrator` loads agent definitions
by ID from an injected registry, resolves each agent's model and tools, and
injects the generic `handoff_agent` tool. Agent definitions are data, so adding
or changing an agent does not require changing orchestration code.

A handoff contains a target agent ID, focused task, optional context, and
reason. The child result is returned to the parent as a tool result. Unknown or
disabled agents, duplicate active handoffs, excessive depth, excessive handoff
count, cancellation, and time-budget violations are rejected or stopped.
Agent definitions are stored globally; task and orchestration state remains
project-isolated.

Tool boundaries are enforced by the orchestrator, not only by prompts. If an
agent has `allowedTools` and `delegatesTo`, every blocked registered tool is
exposed as an automatic delegation proxy to the target agent. This prevents a
small model from bypassing a meta-agent by emitting a blocked tool name as if it
were available.

## Explicitly Not Implemented

- Rollback of arbitrary shell, Git, network, package-manager, or external-process
  side effects. Recovery safely restores only approved workspace file-tool
  mutations and stops instead of guessing when untracked side effects occurred.
- Exact continuation of an in-flight arbitrary shell process; model HTTP calls
  are cancellable and resume starts a fresh call from the durable checkpoint.
  resume starts from the last durable stage checkpoint.
- Complete hierarchical tracing with token, timing, cost, and context-slice metrics
- Parallel execution of independent read-only pipeline stages

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

Web and Git capabilities are exposed as specialized tools in
`packages/tools/src/web-git.ts`. Web browsing uses `@mozilla/readability` and
`jsdom` without executing page scripts; crawling uses Crawlee with same-domain
and request-count limits. Read-only Git inspection uses `simple-git`, while
staging, commits, checkout, and pushes remain approval-gated.

The TUI exposes read-only web and Git tools directly to the general agent, while
mutation tools remain available to the coding agent through the normal approval
boundary. Agent prompts explicitly select specialized tools instead of shell
emulation, and the default per-agent model budget is 24 steps.

Runtime agent definitions can be versioned with a project in
`.agentic/agents/*.md`. YAML frontmatter stores the registry fields and the
Markdown body stores the system prompt. `AGENTS.md` is intentionally separate:
it contains project rules loaded into the coding prompt, not agent identity or
permissions. Project files are imported into the global registry at TUI startup;
reserved built-in IDs cannot be overridden.

`ToolRegistry` validates every model argument object with `ajv` before the
`AgentRunner` asks for approval. File mutations prepare a base-hash-bound diff
with stable line hunks. Approval can remain boolean (accept/reject all) or carry
accepted/rejected hunk IDs. The workspace rereads the file, rejects stale bases,
and applies accepted hunks atomically; rejected hunks are returned in model
context so execution can continue around them.

Session persistence is split by scope: global SQLite stores user settings and
credential references, while a project SQLite database stores sessions, tasks,
events, session/task-scoped context items, orchestration checkpoints, workspace
recovery journals, and hierarchical trace spans. Manual file snapshots are
session-isolated. `/bytheway` uses one model call with only its prompt and never
reads or mutates the durable main transcript. The project ID is derived from
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

After verifier failure, the runtime persists pending recovery state and can roll
back journaled file mutations in reverse order when current hashes match, then
refresh retrieval, replan, and invoke the Coder with fresh approval. Default file
tools do not yet return mutation records to this journal, so normal end-to-end
rollback remains incomplete. A later user edit must never be overwritten.

Trace persistence currently covers tasks, pipeline steps, agents, provider
attempts, compaction, and isolated questions. The schema supports model and tool
spans, exact sanitized I/O, context artifacts, usage, timing, route, and cost,
but `AgentRunner` does not yet emit the correlation fields and complete payloads
needed to populate the full hierarchy. Sensitive fields are redacted.

The persistent retrieval package indexes TypeScript/TSX symbols, imports,
exports, references, calls, hashes, and line spans in project-isolated SQLite,
with text fallback for mixed-language repositories. LSP diagnostics, image
analysis, and a full control/data-flow graph remain deferred.

## Target Design Reference

This section preserves the still-relevant target design also described in the
root `coreplan.md`. Treat both as designs to build toward, not descriptions of
what exists today;
current state lives in [CURRENT_IMPLEMENTATION.md](CURRENT_IMPLEMENTATION.md)
and the phase-by-phase steps to get there live in
[IMPLEMENTATION_PLAN.md](IMPLEMENTATION_PLAN.md).

### System topology

```text
+--------------------------------------------------------------------------------+
|                         TypeScript GUI / IDE Shell                              |
|  Chat | Context Manager | Diff Review | Provider Settings | Observability        |
+----------------------------------------+---------------------------------------+
                                         |
                                         v
+--------------------------------------------------------------------------------+
|                         TypeScript Agent Runtime                                |
|  MultiAgentOrchestrator | Task Checkpoints | Tool Approval | Event Trace         |
+----------------------------------------+---------------------------------------+
                                         |
                                         v
+--------------------------------------------------------------------------------+
|                         TypeScript Services                                     |
|  Provider Gateway | Context Compactor | Code Index | Workspace | Search | Git    |
+--------------------------------------------------------------------------------+
```

### Target multi-agent pipeline

A practical default pipeline for hard, multi-step tasks:

1. `planner`: converts the user request into small, testable steps.
2. `retriever`: selects relevant files, symbols, line ranges, diagnostics, and
   test clues.
3. `coder`: proposes minimal patches using only scoped context.
4. `verifier`: runs static checks, tests, and targeted commands.
5. `reviewer`: inspects diffs, failures, and rejected chunks before finalizing.

Execution is sequential when edits are involved so agents do not fight over
the same working tree. Read-only retrieval and analysis can run in parallel
later, but mutation stays serialized — this is an intentional trade-off (see
below), not a temporary limitation.

### Target routing behavior

Every model route should be selected using visible criteria: task type and
complexity, required context window, tool-calling capability, provider health
and recent rate limits, estimated input/output tokens, expected dollar cost,
local availability through Ollama, and total parameter count capped at 80B.
The router should emit an event for each decision, for example:

```json
{
  "agentId": "coder",
  "providerId": "ollama",
  "modelId": "qwen2.5-coder:7b",
  "reason": "local zero-cost route for scoped patch generation",
  "estimatedCost": 0,
  "contextTokens": 4200
}
```

If a provider fails with a timeout, rate limit, or transient server error, the
gateway should retry through a lower-risk fallback route while keeping the
same task checkpoint and compacted context.

### Target retrieval design

- Build a per-project SQLite index keyed by canonical project root.
- Track file hash, language, symbols, imports, exports, definitions,
  references, line spans, and diagnostics.
- Use the TypeScript compiler API for `.ts`/`.tsx` structure, ripgrep as a
  universal fallback for unsupported languages.
- Rank results by symbol match, import graph distance, prompt terms, recent
  edits, failing tests, and diagnostics.
- Return compact slices with file/line metadata instead of whole files.

### Target compaction design

The compactor watches each model's context budget. At 75% usage, or after a
context-limit error, it replaces old conversation turns with a compact task
state containing: original user objective, current plan and completed steps,
accepted and rejected approaches, important tool outputs, active file slices
and line references, project rules from `AGENTS.md`, and verification status
plus open questions. Compacted state is stored in project SQLite so long
tasks can resume after the IDE closes, a provider fails, or the process
crashes.

### Trade-offs

| Area          | Selected approach                          | Rejected alternative              | Reason                                                                  |
| ------------- | ------------------------------------------ | --------------------------------- | ----------------------------------------------------------------------- |
| Runtime       | TypeScript packages                        | Mixed native runtime              | Faster to build, easier to explain, enough performance for the deadline |
| Retrieval     | TypeScript compiler API plus ripgrep       | Heavy custom graph engine first   | Achievable and testable while still supporting structural slices        |
| Orchestration | Sequential edits, parallel read-only later | Fully parallel agents immediately | Prevents conflicting edits and simplifies recovery                      |
| Persistence   | SQLite                                     | In-memory task state              | Required for long-horizon resume and historical dashboard               |
| Review        | Unified diffs evolving to block approval   | All-or-nothing patch approval     | Matches HITL requirements without overbuilding first                    |

## Extension Guidance

Before adding a package, define its responsibility and dependency direction.
Prefer small public interfaces and keep provider-specific behavior outside the
core runtime. The OpenAI adapter demonstrates this separation. Add
dependencies only when they support an implemented need.

Core tool contracts are defined in `packages/core/src/tools.ts`, message types
in `packages/core/src/messages.ts`, and registration in
`packages/core/src/tool-registry.ts`. Concrete tools must depend on these
contracts rather than the OpenAI provider.
