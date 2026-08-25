# Agentic Runtime

Minimal TypeScript monorepo workspace for building an agent runtime.

## Requirements

- Node.js 20 or newer
- pnpm 9 or newer

## Getting started

```sh
pnpm install
pnpm build
```

The workspace contains framework-neutral runtime contracts in
`@agentic-runtime/core`, an `@agentic-runtime/openai` provider, a guarded
`@agentic-runtime/powershell` backend, separate IDE tools in
`@agentic-runtime/tools`, and an interactive TUI.

IDE tooling uses established libraries: `diff` for patches and diffs, `ajv` for
tool argument validation, `@vscode/ripgrep` for fast search, and `execa` for
process execution. File operations use Node's workspace service; PowerShell is
reserved for explicit shell and project commands. Language-specific
intelligence is intentionally not included yet.

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
`OPENAI_MODEL`. The TUI keeps conversation history and shows model-requested
tool calls for approval before execution. Available commands are `/help`,
`/clear`, `/model`, and `/exit`.

## Scripts

- `pnpm build` compiles all current packages
- `pnpm typecheck` runs the TypeScript build in checking mode
- `pnpm test` runs the core agent and tool contract tests
- `pnpm example:openai` builds the workspace and sends a prompt to OpenAI
- `pnpm tui` builds the workspace and starts the interactive OpenAI TUI
- `pnpm lint` runs ESLint
- `pnpm format` formats supported files with Prettier
- `pnpm format:check` checks formatting without changing files
