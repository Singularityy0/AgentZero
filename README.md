# Agent Zero

Minimal TypeScript monorepo workspace for building an agent runtime.

## Requirements

- Node.js 22.5 or newer
- pnpm 9 or newer

## Getting started

```sh
pnpm install
pnpm build
```

## Setup from scratch on Linux

Verified on Ubuntu 22.04 and 24.04. Every step starts from a clean machine.

### 1. System packages

```sh
sudo apt update
sudo apt install -y curl git build-essential ripgrep
```

`ripgrep` backs file and text search. If your distribution has no `ripgrep`
package, install it any way you like and point the runtime at the binary:

```sh
export AGENTIC_RIPGREP_PATH=/full/path/to/rg
```

### 2. Node.js 22 and pnpm

```sh
curl -fsSL https://fnm.vercel.app/install | bash
exec "$SHELL"
fnm install 22
fnm use 22
corepack enable
corepack prepare pnpm@9.15.5 --activate
node --version   # expect v22.5 or newer
pnpm --version   # expect 9.x
```

### 3. Rust (for the native helper crate)

`pnpm build` compiles a small Rust crate. It backs `analyze_code_structure`,
`compute_ast_diff`, and signature pruning during context compaction; all three
degrade to a readable tool error without it, so `pnpm start`, `pnpm tui`, and
`pnpm settings` run either way. Use `pnpm build:ts` if you want the TypeScript
packages alone.

```sh
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y
. "$HOME/.cargo/env"
```

### 4. Build and test

```sh
git clone <repository-url> agentic-runtime
cd agentic-runtime
pnpm install
pnpm build
pnpm test
```

### 5. Provider API keys

Keys can be set **either** in the Settings screen (recommended; stored in the
global SQLite settings database and shared by the TUI and the IDE) **or** as
environment variables in a `.env` file at the workspace root. The Settings
screen takes precedence over the environment.

To use the settings screen:

```sh
pnpm settings     # opens the loopback server; go to Settings in the UI
```

To use environment variables instead:

```sh
cp .env.example .env
```

| Provider           | Where to get a key                                   | Variables                                | Notes                                            |
| ------------------ | ---------------------------------------------------- | ---------------------------------------- | ------------------------------------------------ |
| **Groq**           | <https://console.groq.com/keys> — free tier          | `GROQ_API_KEY`, `GROQ_MODEL`             | Default hosted route. One key serves all stages. |
| **OpenRouter**     | <https://openrouter.ai/keys> — free tier             | `OPENROUTER_API_KEY`, `OPENROUTER_MODEL` | Use a `:free` model id to stay on the free tier. |
| **Mistral**        | <https://console.mistral.ai/api-keys> — free tier    | `MISTRAL_API_KEY`, `MISTRAL_MODEL`       | Pay-as-you-go beyond the free allowance.         |
| **Cerebras**       | <https://cloud.cerebras.ai> — free tier              | `CEREBRAS_API_KEY`, `CEREBRAS_MODEL`     |                                                  |
| **Hugging Face**   | <https://huggingface.co/settings/tokens> — free tier | `HF_TOKEN`, `HUGGINGFACE_MODEL`          | Inference providers routing.                     |
| **Ollama** (local) | no key                                               | `OLLAMA_ENDPOINT`, `OLLAMA_MODEL`        | Local fallback; see below.                       |

Every provider is rejected at registration unless it is on the free-tier /
pay-as-you-go / local allowlist, and every model is rejected if its known total
parameter count exceeds 80B.

### 6. Local models with Ollama

```sh
curl -fsSL https://ollama.com/install.sh | sh
ollama serve &                       # if not already running as a service
ollama pull qwen2.5-coder:7b         # ~4.7 GB, fits 8 GB VRAM
```

`qwen2.5-coder:7b` is the default local route and runs comfortably within
16 GB RAM / 8 GB VRAM. Verification and review stages deliberately avoid the
local route when a hosted one is configured; see
[docs/DESIGN_DECISIONS.md](docs/DESIGN_DECISIONS.md#6-verification-requires-evidence-and-never-degrades-to-a-weaker-model).

### 7. Run

```sh
pnpm start        # desktop IDE (Electron window)
pnpm tui          # terminal interface
pnpm settings     # loopback server only, open the printed URL in a browser
```

All three build what they need first, so a fresh clone needs no separate build
step. They also try to build the Rust sidecar and continue with a warning if
Cargo is missing: structural slicing, the AST diff tool, and signature pruning
are then unavailable, but nothing else changes. `pnpm build` and
`pnpm desktop:package` still fail hard without it, because an installer shipped
without the sidecar is a silently reduced product.

On a headless Linux box the Electron desktop needs an X or Wayland display. Use
`pnpm settings` and open the printed URL in a browser instead.

## Desktop application

Start the complete workbench as a native desktop window from the repository
root:

```sh
pnpm start
```

The desktop host builds the required TypeScript and GUI packages, starts its
own loopback server on an available port, opens the React/Monaco workbench, and
stops the server when the application exits. It therefore does not require a
separate browser tab or server terminal. Startup is intentionally folderless;
use **Open Folder** or **File → Open Folder** to select a codebase. A recent
folder is used only as the native picker's starting location and is never
opened automatically. The workbench includes editable Monaco tabs with
conflict-safe saves — `Ctrl+S` from anywhere in the window, `Ctrl+Shift+S` for
save-as, a Save/Save as/Auto control beside the tabs, and an optional debounced
auto-save remembered per machine — and a workspace command terminal with discovered
PowerShell, Command Prompt, Git Bash, and Bash profiles.
A **Chat history** sidebar lists this project's previous conversations, newest
first, titled from their opening prompt. Selecting one reopens its transcript
and continues in the same session; conversations can be renamed or deleted, and
deleting one removes its tasks, events, and traces with it. History is scoped to
the opened codebase.

The assistant panel is connected to the headless runtime: it streams task
progress, persists messages, supports cancellation, and surfaces tool approval
requests. A usable model provider is still required. Configure and validate
Ollama, Groq, OpenRouter, Mistral AI, Cerebras, Hugging Face, or an
OpenAI-compatible endpoint from **Settings**. Keys and model choices are saved
once on the machine. For Ollama, install the Windows application once and pull
the selected model once; the desktop runtime starts the service automatically
when a task needs it.

After a successful build, `pnpm desktop:quick` skips compilation and opens the
application immediately. Create an installer for the current operating system
with:

```sh
pnpm desktop:package
```

Installer artifacts are written under `packages/desktop/release/`.

The workspace contains framework-neutral runtime contracts in
`@agentic-runtime/core`, an `@agentic-runtime/openai` provider, a guarded
cross-platform command backend in `@agentic-runtime/command`, separate IDE
tools in `@agentic-runtime/tools`, a reusable headless application boundary in
`@agentic-runtime/runtime`, and an interactive TUI.

Detailed project references:

- [Architecture and implementation status](docs/ARCHITECTURE_AND_STATUS.md)
- [Runbook and interface reference](docs/RUNBOOK_AND_INTERFACE_REFERENCE.md)

IDE tooling uses established libraries: `diff` for patches and diffs, `ajv` for
tool argument validation, `@vscode/ripgrep` for fast search, and `execa` for
process execution. The persistent retrieval package extracts in three tiers: the TypeScript
compiler API for TypeScript and JavaScript (bindings resolved), tree-sitter
grammars in the Rust sidecar for Python, Go, Rust, C, and C++, and a regex
fallback for everything else. Ranking then follows the project's call graph via
personalised PageRank over `FlatCPG`, so a function several calls from the match
still surfaces; that graph is persisted between runs in the memory-mapped
write-ahead log. Indexing is
incremental and stat-gated: a file whose size and mtime match the index is not
re-read at all, so the refresh that runs on every query stays cheap. File operations use the workspace service; command execution uses the
host operating system's native shell.

## Tool approval policy

The runtime uses a fail-safe tool approval policy. Read-only workspace tools
(`list_directory`, `read_file`, `find_files`, and `search_text`) run
automatically. File mutations, shell commands, builds, code execution, formatting, and syntax
checks require approval. File previews are bound to a base hash and contain
stable hunks, allowing accept-all, reject-all, or block-level decisions. Stale
files fail closed and rejected hunks are returned to agent context. New tools require approval unless they explicitly declare
`approval: "auto"` in their core tool definition.

## Orchestration

`TaskOrchestrator` in `@agentic-runtime/core` runs a bounded, sequential plan
through role-specific workers. Steps can depend on earlier steps, and each
worker receives the objective, scoped context, and completed results.
The headless coding path executes planner, semantic retriever, coder, verifier,
and read-only reviewer stages.

The plan's shape is fixed but its length is not. The static plan carries one
placeholder coding step; the planner may return a fenced `subtasks` block, and
the orchestrator then replaces that placeholder with up to four narrowly scoped
coding steps, rewiring dependencies so retrieval still runs first and
verification still runs over the whole change. A missing or malformed block
leaves the single step in place, so a model that cannot emit structured output
loses nothing. Accepted rewrites are checkpointed and replayed on resume, and
surface as `plan_expanded` events and `plan_expansion` trace spans. Failed verification rolls back journaled file-tool
mutations only when hashes still match, refreshes retrieval, asks the planner for
a revised approach, and requires fresh approval for corrective coding. It checkpoints before and after steps, invokes a
corrective coder after verifier failure, stops repeated failure fingerprints,
and enforces shared model-request, attempt, and time limits.
`createTaskCheckpointStore` connects those checkpoints to a persisted SQLite
task; `HeadlessRuntimeService.resumeTask()` skips already completed stages.

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
allowed tools, enabled state, and optional step limit. Provider routing is injected through the model resolver and is not embedded in
the agent runtime. The gateway ranks configured routes by preference, tool
support, context fit, estimated cost, and cooldown state, then visibly fails over
on retryable provider failures.

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

## Headless runtime boundary

`@agentic-runtime/runtime` composes sessions, built-in/project agents, provider
selection, concrete tools, approvals, cancellation, task state, manual context,
isolated questions, recovery journals, and persisted trace spans behind
`HeadlessRuntimeService`. `listTraceSpans(taskId)` returns the currently persisted
trace hierarchy for IDE transport and dashboard clients. Model and tool span
correlation is still incomplete, as documented in the architecture status. The
TUI uses this service instead of owning runtime behavior. The desktop GUI hosts
the same service behind a loopback HTTP/SSE adapter, including task start,
cancellation, live events, and approval decisions.

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
pnpm tui -- "D:\path\to\test-workspace"
```

In Git Bash, use a relative path or quoted forward slashes so backslashes are
not consumed as escape characters:

```sh
pnpm tui -- ./tmp/python-manual-workspace
pnpm tui -- "C:/path/to/test-workspace"
```

The target directory becomes the only workspace root for file, search, command,
and Git tools. Its `.env` supplies provider configuration unless `ENV_FILE` is
set explicitly.

For a local Ollama server, `.env` should contain:

```dotenv
MODEL_PROVIDER=ollama
OLLAMA_ENDPOINT=http://localhost:11434/api/chat
OLLAMA_MODEL=your-local-model
```

## Provider Gateway

`@agentic-runtime/gateway` separates provider configuration, discovered models,
and execution routes. Routes are filtered by tool support, context fit, an
optional per-stage context-window floor, and cooldown; the survivors are then
ordered by the request's bias — `capacity` (largest known parameter count) for
planning a complex task and for verification and review, `economy` (cheapest)
for retrieval summarisation and plain chat, `balanced` (the operator's
configured order) otherwise. Task complexity is classified syntactically from
the prompt rather than with a model call. Every route decision is emitted with
a human-readable reason. Credentials are read by reference from environment
variables and are never included in task/session state or gateway events.
The desktop settings screen persists credentials in the machine-local global
SQLite database, so normal users do not need to create or repeatedly edit an
`.env` file. The default provider presets are explicit models with published
total parameter counts at or below the problem statement's 80B limit.

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
model ID through `OPENAI_COMPATIBLE_MODEL`.

The TUI persists conversation history in SQLite and shows model-requested tool
calls for approval before execution. Current commands include `/help`, `/clear`,
`/new`, `/sessions`, `/agents`, `/agent <id>`, `/settings`, `/context`,
`/context add <file>[:line-range]`, `/context remove <file>`,
`/bytheway <question>`, and `/exit`. See the runbook for exact syntax and current
limitations.

Session data is stored outside the repository under the platform's local
application-data directory. Global settings use a global database, while each
project has a separate database keyed by the canonical project path. Provider
keys can be saved through `/settings` or `pnpm settings`; environment variables
remain supported as fallback configuration.

## Scripts

- `pnpm build` compiles all current packages (incremental)
- `pnpm build:force` recompiles everything from scratch; run it after pulling,
  because `tsc -b` has skipped files whose timestamps moved backwards during a
  git operation and left stale JavaScript behind
- `pnpm typecheck` runs the TypeScript build in checking mode
- `pnpm test` runs the core agent and tool contract tests
- `pnpm tui` builds the workspace and starts the interactive agentic TUI
- `pnpm start` builds and opens the desktop IDE
- `pnpm desktop:quick` opens an already-built desktop IDE
- `pnpm desktop:package` creates desktop installers for the current platform
- `pnpm lint` runs ESLint
- `pnpm format` formats supported files with Prettier
- `pnpm format:check` checks formatting without changing files
