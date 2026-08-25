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

For a local Ollama server, `.env` should contain:

```dotenv
MODEL_PROVIDER=ollama
OLLAMA_ENDPOINT=http://localhost:11434/api/chat
OLLAMA_MODEL=your-local-model
```

For OpenAI, use `MODEL_PROVIDER=openai` and set `OPENAI_API_KEY` and
`OPENAI_MODEL`. The TUI persists conversation history in SQLite and shows
model-requested tool calls for approval before execution. Available commands
are `/help`, `/clear`, `/new`, `/sessions`, `/resume <id>`, `/model`, and
`/exit`.

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
