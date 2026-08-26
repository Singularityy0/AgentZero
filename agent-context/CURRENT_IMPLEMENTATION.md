# Current Implementation

## 1. Project Purpose

`agentic-runtime` is a TypeScript monorepo for an agentic coding IDE designed
around small and medium local or low-cost open-weight models. The central idea
is to keep each model's job narrow, limit the context and tools it receives,
and use orchestration and verification to compensate for weaker single-model
planning.

The current implementation is a terminal client and runtime foundation. It is
not yet a complete desktop IDE, provider gateway, semantic code index, or
parallel multi-agent scheduler.

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
- `tools`: concrete IDE, web, and Git tools assembled into a registry.
- `session`: SQLite persistence for global settings, agents, sessions, tasks,
  events, and project context.
- `tui`: terminal interface, provider selection, agent selection, approvals,
  and runtime event display.

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

Every agent also receives the internal `handoff_agent` tool. The orchestrator
enforces a maximum handoff depth of 6 and a maximum of 20 handoffs per run by
default. It rejects unknown or disabled targets and detects duplicate active
handoffs.

## 4. Built-In and Project Agents

The TUI defines two built-in agents in `packages/tui/src/index.ts`:

- `general`: a restricted meta-agent. It can inspect files, search, browse the
  web, crawl sites, and inspect Git. It delegates implementation and mutation
  work to `coding-agent`.
- `coding-agent`: the implementation agent. It can use workspace, command,
  verification, web, and Git tools. Side-effecting tools still require user
  approval.

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

The current agent CRUD commands are:

```text
/agents
/agent <id>
/agent-create <id>
/agent-edit <id>
/agent-delete <id>
```

CRUD-created agents are stored in SQLite. Project Markdown agents are the
version-controlled source and are re-imported when the TUI starts. Reserved
built-ins cannot be edited or deleted, and the active agent cannot be deleted.

## 5. Runtime Execution Flow

The normal flow is:

1. The TUI loads `.env`, opens the global and project SQLite databases, and
   loads project instructions from the root `AGENTS.md`.
2. The TUI registers or refreshes the built-in agents and imports
   `.agentic/agents/*.md` files.
3. The user selects an agent or uses the default `general` agent.
4. A user message becomes a persisted session task and a `MultiAgentOrchestrator`
   run.
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

`TaskOrchestrator` is a separate provider-neutral planner that supports
dependency-ordered sequential steps, retries, repeated-failure detection,
attempt budgets, time budgets, and checkpoint callbacks. It is not yet the
primary TUI execution path for every request, and independent steps are not
currently executed in parallel.

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

- OpenAI Responses API through `@agentic-runtime/openai`.
- Ollama `/api/chat` through `@agentic-runtime/ollama`.

The Ollama adapter supports native structured tool calls and a constrained JSON
fallback for models that emit tool calls as text. Requests default to a
45-second timeout in the TUI, configurable with `OLLAMA_TIMEOUT_MS`. The TUI
currently selects one provider and model through environment variables; it does
not yet perform complexity-aware routing or provider failover.

## 10. Verification and Known Gaps

The current automated suite covers tool registry behavior, agent execution,
handoffs, delegation proxies, workspace conflicts, search, command execution,
project agent file loading, Ollama parsing, and SQLite persistence.

Current checks:

```text
pnpm build
pnpm test
pnpm lint
pnpm format:check
```

The most important remaining gaps against the problem statement are:

- Parallel orchestration for independent tasks.
- Complexity-, context-, cost-, and rate-limit-aware provider routing.
- Provider failover with progress preservation.
- Automatic context compaction.
- Structural code indexing and semantic retrieval.
- Full resumable multi-agent execution after crashes.
- Block-level diff review.
- Git merge tooling.
- Mandatory provider settings screen.
- Full observability dashboard with per-agent token and timing metrics.
