# Agentic Runtime

Minimal TypeScript monorepo workspace for building an agent runtime.

## Requirements

- Node.js 22.5 or newer
- pnpm 9 or newer

## Getting started

```sh
pnpm install
pnpm build
```

The workspace contains framework-neutral runtime contracts in
`@agentic-runtime/core`, an `@agentic-runtime/openai` provider, a guarded
cross-platform command backend in `@agentic-runtime/command`, separate IDE
tools in `@agentic-runtime/tools`, and an interactive TUI.

IDE tooling uses established libraries: `diff` for patches and diffs, `ajv` for
tool argument validation, `@vscode/ripgrep` for fast search, and `execa` for
process execution. File operations use Node's workspace service; command
execution uses the host operating system's native shell. Language-specific
intelligence is intentionally not included yet.

## Tool approval policy

The runtime uses a fail-safe tool approval policy. Read-only workspace tools
(`list_directory`, `read_file`, `find_files`, and `search_text`) run
automatically. File mutations, PowerShell commands, builds, code execution,
formatting, and syntax checks require approval and show a preview when one is
available. New tools require approval unless they explicitly declare
`approval: "auto"` in their core tool definition.

## Orchestration

`TaskOrchestrator` in `@agentic-runtime/core` runs a bounded, sequential plan
through role-specific workers. Steps can depend on earlier steps, and each
worker receives the objective, scoped context, and completed results. The
orchestrator checkpoints before and after steps, retries transient failures,
stops repeated failure fingerprints, and enforces total-attempt and time
limits. `createTaskCheckpointStore` connects those checkpoints to a persisted
SQLite task.

## Registry-driven agents

`MultiAgentOrchestrator` loads an `AgentDefinition` by ID from an injected
`AgentRegistry`, resolves its model and tools, and runs its prompt through the
generic `AgentRunner` tool loop. Each active agent receives a `handoff_agent`
tool for delegating focused work to another enabled registry agent. Handoffs
are bounded by depth, count, cancellation, and time limits and are returned to
the parent as normalized tool results. Agents with restricted tool lists can
declare `delegatesTo`; blocked tools then become automatic delegation proxies,
so a model cannot bypass the meta-agent boundary by hallucinating a direct
mutation tool call.

The session package stores agent definitions in the global SQLite database.
Definitions contain the name, description, system prompt, capabilities,
allowed tools, enabled state, and optional step limit. Provider routing is
injected through the model resolver and is not embedded in the agent runtime.

Project-specific agents can also be shared with a codebase under
`.agentic/agents/*.md`. Each file uses YAML frontmatter for its identity and
tool permissions, followed by the agent's system prompt. The TUI imports these
definitions into SQLite at startup. `AGENTS.md` remains project-wide coding
guidance and is not an agent definition file.

## Web and Git tooling

`@agentic-runtime/tools` includes `browse_url` for readable HTTP(S) article
extraction and `crawl_site` for bounded same-domain crawling. Web requests do
not execute page scripts, reject non-HTTP protocols, cap responses at 2 MB, and
limit crawls to 25 pages with per-page excerpt limits. The implementation uses
Mozilla Readability, JSDOM, and Crawlee.

The same package includes read-only `git_status`, `git_diff`, `git_log`, and
`git_branches` tools, plus approval-gated `git_add`, `git_commit`,
`git_checkout`, and `git_push` tools backed by `simple-git`.

## OpenAI response example

Set your API key in the shell; do not place it in source files:

```sh
OPENAI_API_KEY=your-key pnpm example:openai "Explain monorepos briefly."
```

On Windows PowerShell:

```powershell
$env:OPENAI_API_KEY = "your-key"
pnpm example:openai "Explain monorepos briefly."
```

The example uses `gpt-4.1-mini` by default. Set `OPENAI_MODEL` for a different
model.

## Interactive TUI

Copy `.env.example` to `.env`, set `MODEL_PROVIDER` and the matching model
settings, then start the terminal chat interface:

```powershell
Copy-Item .env.example .env
# Edit .env and set OLLAMA_MODEL to a model installed in Ollama.
pnpm tui
```

To develop the runtime from this repository while sandboxing it to another
workspace, pass the target directory after `--`:

```powershell
pnpm tui -- D:\path\to\test-workspace
```

The target directory becomes the only workspace root for file, search, command,
and Git tools. Its `.env` supplies provider configuration unless `ENV_FILE` is
set explicitly.

For a local Ollama server, `.env` should contain:

```dotenv
MODEL_PROVIDER=ollama
OLLAMA_ENDPOINT=http://localhost:11434/api/chat
OLLAMA_MODEL=your-local-model
# Optional; defaults to 45000 milliseconds.
OLLAMA_TIMEOUT_MS=45000
```

## Provider Gateway

`@agentic-runtime/gateway` separates provider configuration, discovered models,
and execution routes. Credentials are read by reference from environment
variables and are never included in task/session state or gateway events.

OpenRouter can be configured with:

```dotenv
MODEL_PROVIDER=openrouter
OPENROUTER_API_KEY=your-key
OPENROUTER_MODEL=provider/model-id
```

The gateway discovers OpenRouter models dynamically from its `/models` API and
normalizes their capability, context, and pricing metadata. Existing Ollama
configuration continues to work through the same gateway. An OpenAI-compatible
local endpoint can use `MODEL_PROVIDER=openai-compatible`,
`OPENAI_COMPATIBLE_BASE_URL`, `OPENAI_COMPATIBLE_API_KEY` when required, and a
model ID through `OPENROUTER_MODEL` or `OPENAI_MODEL`.

For OpenAI, use `MODEL_PROVIDER=openai` and set `OPENAI_API_KEY` and
`OPENAI_MODEL`. The TUI persists conversation history in SQLite and shows
model-requested tool calls for approval before execution. Available commands
are `/help`, `/clear`, `/new`, `/sessions`, `/resume <id>`, `/model`, `/agents`,
`/agent <id>`, `/agent-create <id>`, `/agent-edit <id>`, `/agent-delete <id>`,
and `/exit`. Agent management prompts for the definition fields and persists
custom agents in the global SQLite database. The reserved `general` and
`coding-agent` definitions cannot be edited or deleted. `general` is the
default and delegates implementation work to `coding-agent`; `AGENT_ID` can
override the default.

Session data is stored outside the repository under the platform's local
application-data directory. Global settings use a global database, while each
project has a separate database keyed by the canonical project path. API keys
are still supplied through `.env` and are not stored in SQLite.

## Scripts

- `pnpm build` compiles all current packages
- `pnpm typecheck` runs the TypeScript build in checking mode
- `pnpm test` runs the core agent and tool contract tests
- `pnpm example:openai` builds the workspace and sends a prompt to OpenAI
- `pnpm tui` builds the workspace and starts the interactive OpenAI TUI
- `pnpm lint` runs ESLint
- `pnpm format` formats supported files with Prettier
- `pnpm format:check` checks formatting without changing files
