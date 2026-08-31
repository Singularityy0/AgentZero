# Current Implementation

## 1. Project Purpose

`agentic-runtime` is a TypeScript monorepo for an agentic coding IDE designed
around small and medium local or low-cost open-weight models. The central idea
is to keep each model's job narrow, limit the context and tools it receives,
and use orchestration and verification to compensate for weaker single-model
planning.

The current implementation is a terminal client and headless runtime foundation
with smart provider failover, persistent semantic retrieval, a checkpointed
five-stage coding pipeline, recovery and replanning machinery, structured context
compaction, block-level file approval, manual context control, isolated
`/bytheway`, and persisted trace infrastructure. Default file tools do not yet
forward mutation records into the recovery journal, and model/tool trace
correlation remains incomplete. It is not yet the final desktop IDE transport or
a parallel multi-agent scheduler.

## 2. Package Boundaries

The repository uses independent packages under `packages/`:

- `core`: provider-neutral messages, tool contracts, `AgentRunner`, and
  orchestration.
- `openai`: OpenAI Responses API adapter.
- `ollama`: local Ollama `/api/chat` adapter with structured tool-call support
  and a JSON fallback parser.
- `command`: cross-platform shell execution through `cmd.exe` on Windows or
  `/bin/sh` on Unix-like systems.
- `workspace`: workspace-bound file access, hashes, atomic writes, conflict
  detection, and unified diff previews.
- `search`: packaged ripgrep file and text search.
- `retrieval`: project-isolated SQLite semantic index and ranked compact slices.
- `tools`: concrete IDE, web, and Git tools assembled into a registry.
- `session`: SQLite persistence for global settings, agents, sessions, tasks,
  events, and project context.
- `tui`: terminal interface, provider selection, agent selection, approvals,
  and runtime event display.
- `gateway`: provider registry, model catalog, Groq/OpenRouter/Ollama/
  OpenAI-compatible route support, and `StoredCredentialResolver` for
  settings-backed credentials.
- `runtime`: reusable headless application service that owns built-in agents,
  provider/tool composition, sessions, cancellable task execution, approvals,
  event persistence, and task/session lifecycle. The TUI consumes this package;
  a future IDE/Tauri host will expose the same API over transport.
- `gui`: browser-based settings/chat/diff/dashboard UI (plain TypeScript +
  Vite, no Tauri/Electron).
- `gui-server`: local `node:http` bridge exposing the provider-settings API
  and serving the built GUI; loopback-only.

Dependencies point toward the core contracts. The core package does not depend
on a specific model provider or user interface.

## 3. Agent Definition Model

An agent is represented by `AgentDefinition` in
`packages/core/src/agents.ts`:

```ts
interface AgentDefinition {
  id: string;
  name: string;
  description: string;
  systemPrompt: string;
  capabilities: string[];
  allowedTools?: string[];
  delegatesTo?: string;
  maxSteps?: number;
  enabled: boolean;
}
```

The fields have separate responsibilities:

- `id` is the stable registry key used by the TUI and handoffs.
- `name` and `description` help users and parent agents understand the role.
- `systemPrompt` is the role-specific instruction sent to the model.
- `capabilities` are descriptive routing metadata, not permissions.
- `allowedTools` is the enforced tool permission boundary.
- `delegatesTo` identifies the specialist that should receive blocked tools.
- `maxSteps` limits the model/tool loop for that agent.
- `enabled` determines whether the orchestrator may start the agent.

Direct registry-driven runs can receive the internal `handoff_agent` tool when
handoffs are enabled. The default runtime limits depth to 4, total handoffs to 8,
and handoffs per source/target pair to 2. Unknown, disabled, duplicate, and
excessive handoffs are rejected.

## 4. Built-In and Project Agents

The runtime defines six built-in agents in
`packages/runtime/src/default-agents.ts`:

- `conversation`: a neutral, tool-free Chat role for normal model-driven
  conversation, general questions, and standalone code output.
- `general`: the read-only Architect and planner.
- `retriever`: a registered retrieval specialist. The fixed pipeline currently
  uses deterministic retrieval directly instead of invoking this agent.
- `coding-agent`: the implementation specialist.
- `verifier`: the command-only verification specialist.
- `reviewer`: the final read-only reviewer.

Built-in agents are registered at startup with `SessionStore.registerAgent()`.
The operation is an SQLite upsert, so their current source definition refreshes
the local database on each TUI start.

Project-specific agents live separately from project instructions:

```text
AGENTS.md
.agentic/
  agents/
    researcher.md
```

`AGENTS.md` contains project-wide coding rules. It is loaded into the coding
prompt and is not an agent definition. Files under `.agentic/agents/` contain
one runtime agent each. Their YAML frontmatter supplies registry fields and
their Markdown body supplies the system prompt.

Example:

```md
---
id: researcher
name: Research Agent
description: Researches documentation without modifying files.
capabilities:
  - research
  - web
allowedTools:
  - browse_url
  - crawl_site
  - git_log
maxSteps: 16
enabled: true
---

Use primary sources and return concise findings with evidence.
```

`loadProjectAgents()` in `packages/session/src/index.ts` discovers these files,
parses them with `gray-matter`, validates required fields, and returns
`AgentDefinition` objects. The TUI imports them into the global SQLite registry
after registering built-ins. A project file cannot override the reserved
`general` or `coding-agent` IDs.

The current TUI supports `/agents`, `/agent`, and `/agent <id>`. Agent CRUD
methods exist in persistence, but the current TUI does not expose create, edit,
or delete commands. Project Markdown agents are re-imported when the TUI starts.

## 5. Runtime Execution Flow

The normal flow is:

1. The TUI translates `.env` into an explicit model selection and constructs
   `HeadlessRuntimeService`.
2. The runtime opens global/project SQLite, loads project instructions,
   refreshes built-in agents, and imports `.agentic/agents/*.md` files.
3. The user selects an agent or uses the default `general` agent.
4. A user message enters the headless runtime, which persists the task and
   constructs a fresh `MultiAgentOrchestrator` for that task.
5. The orchestrator loads the agent definition, resolves its model and complete
   tool registry, then scopes the registry using `allowedTools`.
6. The agent receives its system prompt, prior session history, and task.
7. `AgentRunner` asks the model for a response and available tools.
8. Tool arguments are validated by `ajv` before execution.
9. Read-only tools run automatically. Mutations and side effects produce an
   approval request and optional preview.
10. Tool results are returned to the model as structured tool messages.
11. The loop continues until the model gives a final answer, repeats an
    identical tool call, is cancelled, times out, or reaches its safety limit.
12. TUI events and session state are persisted so the result can be inspected
    and the session can be resumed.

## 6. Multi-Agent Behavior

`MultiAgentOrchestrator` is the registry-driven runtime boundary. It does not
hardcode specialist roles. The model resolver receives the `AgentDefinition`
and can select a different model per agent, although the current TUI injects
the same configured model for every agent.

A handoff includes a target ID, focused task, optional context, and reason. The
child agent receives the focused task rather than the entire parent history.
The child result is returned to the parent as a normalized tool result.

Blocked tools can become automatic delegation proxies when `delegatesTo` is
configured. This prevents a restricted agent from bypassing its permission
boundary by emitting the name of a blocked tool. Handoffs are currently nested
and sequential.

`TaskOrchestrator` is the provider-neutral checkpoint engine for coding tasks.
The headless runtime runs planner, deterministic semantic retrieval, coder,
verifier, and read-only reviewer stages in order. Verifier failure persists a
pending recovery and can roll back journaled file mutations when their hashes
still match, then refresh retrieval, obtain a revised Planner approach, and run
a freshly approved corrective Coder. Default file tools currently omit the
`workspaceMutation` result needed to populate that journal, so end-to-end
rollback is incomplete. Persisted attempts,
failure fingerprints, recovery phase, mutation journal, and model-request count
survive resume. Conversational/read-only prompts and explicitly selected custom
agents continue through the direct registry-driven path. Independent stages are
not currently executed in parallel.

## 7. Tool Catalog and Safety

The concrete tools are assembled by `createIdeTools()` in
`packages/tools/src/index.ts`.

Workspace tools include file listing, reading, writing, creating, deleting,
exact patching, file discovery, text search, command execution, compilation,
running, formatting, and syntax checks.

Web tools use established libraries rather than custom HTML parsing:

- `browse_url` uses `fetch`, Mozilla Readability, and JSDOM to extract readable
  text without executing page scripts.
- `crawl_site` uses Crawlee with same-domain crawling, a 25-page maximum, and
  per-page excerpt limits.
- URLs must use HTTP or HTTPS.
- Responses are limited to 2 MB and only HTML or plain text is accepted.

Git tools use `simple-git`:

- Read-only: `git_status`, `git_diff`, `git_log`, `git_branches`.
- Approval-gated: `git_add`, `git_commit`, `git_checkout`, `git_push`.

All tool definitions use JSON schemas. The `ToolRegistry` validates model
arguments before approval or execution. The TUI never gives approval to a
mutation silently. Shell execution removes model-provider credentials from the
child environment and is bounded by timeout and output limits.

## 8. Persistence

The session package separates global and project scope:

- Global SQLite stores settings and agent definitions.
- Project SQLite stores the project record, sessions, tasks, events, context
  items, and orchestration checkpoints.

On Windows, the default data root is:

```text
C:\Users\<username>\AppData\Local\agentic-runtime
```

The project database is selected using a hash of the canonical project path.
This prevents session state from one opened codebase being mixed with another.

## 9. Provider Behavior

The core uses a provider-neutral `LanguageModel` interface. The current
providers are:

- Ollama `/api/chat` through `@agentic-runtime/ollama`.
- Groq, OpenRouter, Mistral AI, Cerebras, Hugging Face Inference Providers,
  and OpenAI-compatible/local endpoints through `@agentic-runtime/gateway`.

`@agentic-runtime/openai` also contains a direct OpenAI Responses adapter, but
the default runtime gateway does not register it as a selectable provider.

The Ollama adapter supports native structured tool calls and constrained JSON
fallbacks for flat, array, wrapped, nested-function, and `tool`/`parameters`
text formats. Desktop Ollama routes use an 8K context window and send it to the
server as `num_ctx`. Gateway-created
requests use the adapter's current 300-second timeout; `OLLAMA_TIMEOUT_MS` is not
wired. The TUI supplies an ordered primary/fallback route list. The gateway ranks
configured routes using preference, tools, context fit, estimated cost, and
cooldown state, emits visible routing reasons, and fails over on rate limits,
context errors, timeouts, connections, and transient server failures without
rebuilding the model request.

Provider credentials, base URLs, and manual model IDs are stored in the global
SQLite database via `SessionStore.setCredential`/`setProviderSetting` and
resolved at call time by `StoredCredentialResolver`, which checks the store
first and falls back to a per-provider environment variable
(`DEFAULT_CREDENTIAL_ENV_FALLBACK`) only if nothing has been saved. Both the
TUI (`/settings`) and the GUI (`pnpm settings`, served by
`@agentic-runtime/gui-server`) read and write the same records, so a key saved
in either client works in both without editing `.env`. `PROVIDER_FIELD_SPECS`
in `@agentic-runtime/gateway` is the single source of truth for which fields
(API key, base URL, manual model ID) each provider needs; the settings UI and
`/settings` command both derive their forms from it instead of hardcoding
provider names.

The desktop runtime uses explicit <=80B presets rather than unrestricted
"auto" routers: Qwen 3.6 27B / GPT-OSS 20B on Groq, Nemotron 3.5 Lightning 30B
on OpenRouter, Ministral 3B/8B/14B, Gemma 4 31B on Cerebras, Qwen Coder
30B/32B on Hugging Face, and Qwen 2.5 Coder 7B on Ollama. When the selected
route is local Ollama, the server probes it and launches `ollama serve` in the
background if the installed service is not already available. Model downloads
remain an explicit one-time action because they are multi-gigabyte artifacts.

The runtime distinguishes requests to display standalone code from requests to
change the opened workspace. Standalone code goes directly to the Architect in
one response; workspace changes use the checkpointed coding pipeline and only
complete the Coder stage after an actual mutation tool call. Corrective prompts
are limited to two retries per stalled workflow phase.

## 10. Verification and Known Gaps

The current automated suite covers tool registry behavior, agent execution,
handoffs, delegation proxies, workspace conflicts, search, command execution,
project agent file loading, Ollama parsing, SQLite persistence (including
credential/provider-setting storage), and `StoredCredentialResolver`
fallback behavior.

Current checks:

```text
pnpm build
pnpm test
pnpm lint
pnpm format:check
```

The most important remaining gaps against the problem statement are:

- Parallel orchestration for independent tasks.
- Default file mutation tools do not yet forward mutation records into the
  recovery journal, so verifier rollback is not complete end to end.
- Arbitrary command, Git, and external side effects cannot be rolled back.
- Exact resumption of an in-flight arbitrary shell process; cancellable model
  calls restart from the last durable boundary.
- Parallel read-only pipeline stages.
- The final IDE dashboard/workbench that renders persisted traces and clickable
  file references.
- Git merge tooling.
- Complete model/tool trace correlation and a dashboard with per-agent token and
  timing metrics.
- A write/save path from the GUI editor (currently read-only by design — see
  below — since there's no approval-gating wired to GUI-initiated edits yet).
- Clickable file/line tags in the browser workbench.
- Completing `MODEL_PARAMETER_CATALOG` for arbitrary manually entered models,
  an Ollama RAM/VRAM soft-check, and surfacing the `unverified`
  model flag anywhere in the UI (80B/free-tier hard-blocking itself is
  enforced — see `IMPLEMENTATION_PLAN.md` Phase 1).
- Encryption-at-rest for stored provider credentials (the settings screen
  now works end-to-end, but saved keys sit in the global SQLite file as
  plaintext, the same trust level as the `.env` file they replace).

## 11. GUI

`packages/gui` is a real editor workbench, not a settings-only screen:
activity bar (Explorer / AI Chat / Settings), a file explorer backed by
`gui-server`'s `/api/files` and `/api/files/content` (built on the existing
`WorkspaceFileService`, so it's workspace-root-scoped like every other file
tool), and Monaco — the same editor engine VSCode uses — as the code viewer,
wired through Vite's `?worker` imports for language workers. The editor is
read-only: there's no save/write path or approval flow from the GUI yet. The
status bar shows real state (workspace name and `gui-server` connectivity,
live cursor position and detected language from Monaco's own events) rather
than placeholder text. The AI chat panel accepts input and appends real user
messages but is explicitly labeled preview-only; it is not wired to
`HeadlessRuntimeService`. `packages/gui/src-tauri` has been removed in favor of
`gui-server`. The Rust sidecar remains available for syntax slicing, signature
pruning, advisory line diffs, and experimental state primitives. It is not the
authoritative HITL diff engine.
