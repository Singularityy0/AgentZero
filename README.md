# Agent Zero

An agentic coding IDE built for small open-weight models.

Every model the system uses has 80B total parameters or fewer, and runs on a
free-tier API, a pay-as-you-go API, or local hardware. No subscription APIs are
used anywhere.

## Why it is built this way

A single small model cannot carry a hard multi-step coding task. It loses track
of multi-file work, cannot reliably plan and implement and check itself in one
pass, and produces unreliable structured output. Instead of asking one model to
do all of that, the work is split across specialised agents, each given only the
context its step needs.

The parts that follow from that constraint:

- **A planner that decides the plan's shape.** It can split one objective into
  up to four narrowly scoped coding steps, each seeing only its own slice.
- **Retrieval that reads code, not text.** TypeScript and JavaScript through the
  TypeScript compiler API, and Python, Go, Rust, C, and C++ through tree-sitter
  in a Rust sidecar. Ranking follows the project's call graph with personalised
  PageRank, so a function three calls away from a match still surfaces.
- **Routing that explains itself.** Every request is placed on a provider by
  task complexity, context fit, cost, spend so far, and rate-limit cooldown.
  The reason is visible live in the dashboard.
- **Compaction with no model in the loop.** Context is folded into structured
  state deterministically, so it cannot hallucinate what it summarises.
- **Twelve independent safeguards** against stuck or runaway tasks, including a
  Merkle state tree that notices when the workspace returns to a state it has
  already occupied.
- **A full trace.** Every agent, tool, and model call with its exact input,
  output, context slices, tokens, and time, inspectable while the task runs and
  after it finishes.

Three clients share one headless runtime: a desktop IDE, the same workbench in a
browser, and a terminal UI.

## Documentation

- [Multi-agent architecture](docs/MULTI_AGENT_ARCHITECTURE.md), with diagrams of
  the pipeline, routing, retrieval, compaction, recovery, and safeguards.
- [Architectural decisions](docs/ARCHITECTURE_DECISIONS.md), covering the
  tool-calling format, the alternatives that were rejected, and the real
  problems hit while building the system.

---

# Setup on Linux from scratch

Written for a clean machine with nothing installed. Verified on Ubuntu 22.04 and
24.04. For a different distribution, replace step 1 with the equivalent packages
for your package manager; the rest is identical.

Total download is roughly 1.5 GB, mostly the Rust toolchain and Electron.

## 1. System packages

```sh
sudo apt update
sudo apt install -y curl git build-essential ripgrep
```

What each is for:

- `curl` downloads the Node.js and Rust installers in the next steps.
- `git` clones the repository, and the agent uses it for diffs and commits.
- `build-essential` provides the C toolchain that the Rust crate and the native
  SQLite module link against.
- `ripgrep` backs file and text search.

If your distribution has no `ripgrep` package, install it any other way and
point the runtime at the binary:

```sh
export AGENTIC_RIPGREP_PATH=/full/path/to/rg
```

## 2. Node.js 22

The project needs Node.js 22.5 or newer. Distribution packages are usually
older, so install a version manager.

```sh
curl -fsSL https://fnm.vercel.app/install | bash
exec "$SHELL"
fnm install 22
fnm use 22
fnm default 22
```

Check it:

```sh
node --version
```

Expect `v22.5.0` or newer.

## 3. pnpm

The repository is a pnpm workspace. npm and yarn will not resolve the internal
package links correctly. Install pnpm through corepack, which ships with
Node.js:

```sh
corepack enable
corepack prepare pnpm@9.15.5 --activate
```

Check it:

```sh
pnpm --version
```

Expect `9.15.5`.

## 4. Rust

A small Rust crate provides tree-sitter parsing for five languages, the code
property graph, BLAKE3 workspace hashing, and the AST diff tool.

```sh
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y
. "$HOME/.cargo/env"
```

Check it:

```sh
rustc --version
```

Expect 1.85.0 or newer. The crate uses Rust edition 2024, which older
toolchains cannot compile. If rustup installed an older version:

```sh
rustup update stable
```

Rust is required to build the project and to produce installers. It is optional
at runtime: if the sidecar binary is missing, structural slicing, the AST diff
tool, and signature pruning report a tool error and everything else works
normally.

## 5. Clone and build

```sh
git clone <repository-url> agent-zero
cd agent-zero
pnpm install
pnpm build
```

`pnpm install` fetches Node dependencies. `pnpm build` compiles the Rust crate
and then all TypeScript packages. First build takes a few minutes, mostly
compiling tree-sitter grammars.

Confirm the build is sound:

```sh
pnpm test
```

Expect 114 TypeScript tests and 18 Rust tests passing.

## 6. Provider API keys

Keys can be set two ways. The Settings screen is recommended and takes
precedence over the environment.

**Option A, the Settings screen.** Start the app and open Settings. Keys are
stored in a global SQLite database on this machine and shared by the desktop
IDE, the browser workbench, and the TUI. This screen also validates the key
against the provider and lets you pick the model per provider.

```sh
pnpm settings
```

Open the URL it prints, go to Settings, paste a key, and press Validate.

**Option B, environment variables.**

```sh
cp .env.example .env
```

Then edit `.env`.

You need at least one provider. Groq is the default and has a free tier that
needs no card.

| Provider     | Get a key at                           | Environment variables                    | Notes                                              |
| ------------ | -------------------------------------- | ---------------------------------------- | -------------------------------------------------- |
| Groq         | https://console.groq.com/keys          | `GROQ_API_KEY`, `GROQ_MODEL`             | Default hosted route. Free tier, no card required. |
| OpenRouter   | https://openrouter.ai/keys             | `OPENROUTER_API_KEY`, `OPENROUTER_MODEL` | Use a model id ending in `:free` to stay free.     |
| Mistral      | https://console.mistral.ai/api-keys    | `MISTRAL_API_KEY`, `MISTRAL_MODEL`       | Free Studio tier, pay-as-you-go beyond it.         |
| Cerebras     | https://cloud.cerebras.ai/platform     | `CEREBRAS_API_KEY`, `CEREBRAS_MODEL`     | Free trial requires account verification.          |
| Hugging Face | https://huggingface.co/settings/tokens | `HF_TOKEN`, `HUGGINGFACE_MODEL`          | Inference Providers routing, small monthly credit. |
| Ollama       | no key needed                          | `OLLAMA_ENDPOINT`, `OLLAMA_MODEL`        | Local models. See step 7.                          |

There is also an `openai-compatible` entry in Settings for any self-hosted
endpoint that speaks the OpenAI chat API. It takes a base URL, an optional key,
and a model id.

Two constraints are enforced in code, not by convention. A provider is refused
at registration unless it is on the free-tier, pay-as-you-go, or local
allowlist. A model is dropped if its known total parameter count exceeds 80B.

Configuring more than one provider is worth doing. When a route hits a rate
limit, the gateway cools it down and continues the same request on the next
provider without losing task progress.

## 7. Local models with Ollama

Optional but recommended, because it gives the system a zero-cost fallback when
hosted free tiers are rate limited.

```sh
curl -fsSL https://ollama.com/install.sh | sh
ollama serve &
ollama pull qwen2.5-coder:7b
```

`qwen2.5-coder:7b` is about 4.7 GB and runs within 16 GB RAM and 8 GB VRAM. It
is the default local route.

Verification and review stages avoid the local route when a hosted one is
configured, because running the stage that judges whether the work is correct on
the weakest available model defeats the point of having that stage. The
reasoning is in
[ARCHITECTURE_DECISIONS.md](docs/ARCHITECTURE_DECISIONS.md#8-verification-requires-evidence-and-never-degrades-to-a-weaker-model).

## 8. Run

```sh
pnpm start
```

This opens the desktop IDE. It builds anything missing first, so a fresh clone
needs no separate build step.

Other entry points:

```sh
pnpm tui        # terminal interface
pnpm settings   # loopback server only, open the printed URL in a browser
```

On a headless machine the Electron desktop needs an X or Wayland display. Use
`pnpm settings` and open the printed URL in a browser instead.

## 9. First task

1. Open a project folder from the IDE header.
2. Type a task in the chat box. Use `@` to tag a specific file.
3. Approve the diffs it proposes. Accept or reject individual blocks, not just
   the whole change.
4. Open the Observability tab to watch which model handled each step, what was
   in its context, and what it cost.

Useful commands in the chat box:

- `@path/to/file` tags a file. File and line references in the agent's replies
  are clickable and open at the right line.
- `/bytheway <question>` asks one isolated question with no prior context, then
  returns to the ongoing task untouched.

---

# Troubleshooting

**`pnpm: command not found` after step 3.** Corepack shims are installed into
the active Node version. Re-run `fnm use 22` in the new shell, or add
`eval "$(fnm env --use-on-cd)"` to your shell profile.

**Rust build fails with an edition error.** The toolchain is older than 1.85.
Run `rustup update stable`.

**`pnpm build` fails after a `git pull`.** `tsc -b` skips files whose timestamps
moved backwards during a git operation and can leave stale output. Run
`pnpm build:force`.

**Search returns nothing.** ripgrep is missing. Install it, or set
`AGENTIC_RIPGREP_PATH` to the binary.

**A task stops saying it reached its budget.** Expected behaviour. Each task has
a $0.50 ceiling, a 48 model-request ceiling, and a 30 minute ceiling. The task
is paused with its work intact and can be resumed from the task list.

**Ollama routes fail.** Confirm the daemon is reachable with
`curl http://localhost:11434/api/tags`, and that the model name in Settings
matches a model in that list exactly, including the tag.

---

# Scripts

- `pnpm build` compiles the Rust crate and all TypeScript packages, incrementally
- `pnpm build:force` recompiles everything from scratch
- `pnpm typecheck` runs the TypeScript build in checking mode
- `pnpm test` forces a full rebuild, then runs the Rust and TypeScript suites
- `pnpm test:rust` runs the Rust crate's tests alone
- `pnpm start` builds and opens the desktop IDE
- `pnpm desktop:quick` opens an already-built desktop IDE
- `pnpm tui` builds and starts the terminal interface
- `pnpm settings` starts the loopback server only
- `pnpm desktop:package` builds installers for the current platform, compiling
  the Rust sidecar in release mode first. Cross-building is refused, because
  both bundled binaries are platform-specific, so each platform builds on its
  own machine or CI runner
- `pnpm lint` runs ESLint
- `pnpm format` formats supported files with Prettier
- `pnpm format:check` checks formatting without changing files

# Repository layout

```
packages/
  core         runtime contracts, AgentRunner, orchestrators, compaction
  gateway      provider discovery, routing, failover, cost governance
  runtime      headless application service composing everything below
  retrieval    per-project semantic index and query pipeline
  workspace    workspace-bound file service with hashes and diffs
  search       ripgrep-backed search service
  command      cross-platform shell executor
  tools        IDE, web, and Git tools built on the core contracts
  session      SQLite persistence, global and per project
  openai       OpenAI-compatible provider adapter
  ollama       Ollama local provider adapter
  gui          React workbench
  gui-server   loopback HTTP and SSE boundary
  desktop      thin Electron host
  tui          terminal client
rust/          tree-sitter parsing, code property graph, Merkle state, WAL, diff
docs/          architecture and decision documentation
tests/         runtime, routing, and retrieval test suites
```
