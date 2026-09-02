# Runbook and Interface Reference

This document describes the repository as it works today. Source code and checked-in configuration are the ground truth. Where older documentation or declared scripts do not match the current implementation, that difference is called out explicitly.

## 1. Prerequisites

Required tools:

- Node.js 22.5.0 or newer. The session and retrieval packages use the built-in `node:sqlite` API.
- pnpm 9 or newer. The repository pins `pnpm@9.15.5`.
- A working Rust and Cargo toolchain. The root build compiles the Rust sidecar before TypeScript.
- Git for the Git tools.

The workspace is TypeScript-first and uses strict TypeScript checking, ES2022, NodeNext modules, pnpm workspaces, and a Rust 2024 sidecar.

## 2. Install, build, test, and run

Run commands from the repository root.

### Install

```sh
pnpm install
```

Cargo resolves Rust dependencies during the Rust build. There is no separate Rust install script.

### Build everything used by the runtime

```sh
pnpm build
```

Exact expansion:

```sh
pnpm build:rust && pnpm build:ts
```

Rust build:

```sh
cargo build --manifest-path rust/Cargo.toml
```

TypeScript build:

```sh
tsc -b packages/core/tsconfig.json packages/openai/tsconfig.json packages/ollama/tsconfig.json packages/gateway/tsconfig.json packages/command/tsconfig.json packages/search/tsconfig.json packages/session/tsconfig.json packages/workspace/tsconfig.json packages/tools/tsconfig.json packages/retrieval/tsconfig.json packages/runtime/tsconfig.json packages/gui-server/tsconfig.json packages/tui/tsconfig.json
```

The browser GUI is not part of `pnpm build`. Build it separately:

```sh
pnpm --filter @agentic-runtime/gui build
```

### Clean TypeScript outputs

```sh
pnpm clean
```

This cleans TypeScript project outputs. It does not clean `rust/target/` or `packages/gui/dist/`.

### Type checking and code quality

```sh
pnpm typecheck
pnpm lint
pnpm format:check
```

To rewrite files with Prettier:

```sh
pnpm format
```

### TypeScript tests

```sh
pnpm test
```

Exact expansion:

```sh
pnpm build && tsc -p tests/tsconfig.json && node --test dist-tests/runtime.test.js dist-tests/routing.test.js dist-tests/retrieval.test.js
```

At the time of this document, the command runs 47 TypeScript tests. It performs a Rust build because `pnpm build` is included, but it does not run Rust unit tests.

### Rust tests

Run the eight Rust unit tests separately:

```sh
cargo test --manifest-path rust/Cargo.toml
```

### Run the TUI

Run against the current directory:

```sh
pnpm tui
```

Exact expansion:

```sh
pnpm build && node packages/tui/dist/index.js
```

The package binary accepts this interface:

```sh
agentic-tui [workspace-path]
```

### Run the settings GUI and API server

```sh
pnpm settings
```

Exact expansion:

```sh
pnpm build && pnpm --filter @agentic-runtime/gui build && node packages/gui-server/dist/cli.js
```

After building, the server can also be started directly:

```sh
node packages/gui-server/dist/cli.js
```

The package declares the binary name:

```sh
agentic-gui-server
```

### GUI development

Start the API server, then run Vite in another terminal:

```sh
pnpm --filter @agentic-runtime/gui dev
```

Vite listens on port `1420` and proxies `/api` to `http://127.0.0.1:4737`.

Preview a built GUI with Vite:

```sh
pnpm --filter @agentic-runtime/gui preview
```

### Removed example scripts

The old OpenAI response and Groq model-list examples were removed together with
their root scripts. Provider setup and endpoint behavior are documented below.

## 3. Environment configuration

The repository includes `.env.example`. Copy it to the workspace that the TUI will operate on, then use placeholders rather than real keys in committed files.

PowerShell:

```powershell
Copy-Item .env.example .env
```

Git Bash or another POSIX-style shell:

```sh
cp .env.example .env
```

Never commit `.env`, provider keys, or tokens. `.env` and `.env.*` are ignored, while `.env.example` is allowed.

A source-grounded local Ollama configuration is:

```dotenv
MODEL_PROVIDER=ollama
OLLAMA_ENDPOINT=http://localhost:11434
OLLAMA_MODEL=your-installed-model
```

A Groq configuration is:

```dotenv
MODEL_PROVIDER=groq
GROQ_API_KEY=replace-me
GROQ_MODEL=qwen/qwen3.6-27b
```

An OpenRouter configuration is:

```dotenv
MODEL_PROVIDER=openrouter
OPENROUTER_API_KEY=replace-me
OPENROUTER_MODEL=provider/model-id
```

An OpenAI-compatible local server configuration is:

```dotenv
MODEL_PROVIDER=openai-compatible
OPENAI_COMPATIBLE_BASE_URL=http://127.0.0.1:8000/v1
OPENAI_COMPATIBLE_MODEL=model-id
OPENAI_COMPATIBLE_API_KEY=optional-key
```

Saved SQLite provider settings take precedence over environment credential fallbacks.

### Active environment variables

| Variable                     | Current behavior                                                                                                                                               |
| ---------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `MODEL_PROVIDER`             | Selects the primary TUI provider. Accepted values are `ollama`, `groq`, `openrouter`, and `openai-compatible`. Defaults to `ollama`.                           |
| `OLLAMA_MODEL`               | Supplies the Ollama model ID and adds an Ollama fallback route when set.                                                                                       |
| `OLLAMA_ENDPOINT`            | Supplies the Ollama base URL or `/api/chat` URL. Defaults to `http://localhost:11434`. A trailing `/api/chat` is stripped before provider endpoints are built. |
| `GROQ_MODEL`                 | Supplies the Groq model ID and adds a Groq fallback route when set.                                                                                            |
| `OPENROUTER_MODEL`           | Supplies the OpenRouter model ID and adds an OpenRouter fallback route. It is also the first model fallback considered for `openai-compatible`.                |
| `OPENAI_COMPATIBLE_MODEL`    | Supplies a model fallback for Groq, OpenRouter, and OpenAI-compatible selection. It adds an OpenAI-compatible fallback when a base URL is also present.        |
| `OPENAI_MODEL`               | Final model-ID fallback for OpenRouter and OpenAI-compatible selection. It does not select the direct OpenAI Responses adapter.                                |
| `OPENAI_COMPATIBLE_BASE_URL` | Required base URL for an OpenAI-compatible route.                                                                                                              |
| `GROQ_API_KEY`               | Environment credential fallback for provider ID `groq`.                                                                                                        |
| `OPENROUTER_API_KEY`         | Environment credential fallback for provider ID `openrouter`.                                                                                                  |
| `OPENAI_COMPATIBLE_API_KEY`  | Optional environment credential fallback for provider ID `openai-compatible`.                                                                                  |
| `ENV_FILE`                   | Overrides the dotenv file path used by the TUI. Without it, the TUI loads `<target-workspace>/.env`.                                                           |
| `AGENTIC_PROJECT_ROOT`       | Selects the gui-server project root. Defaults to the server process working directory.                                                                         |
| `AGENTIC_GUI_PORT`           | Selects the gui-server port. Defaults to `4737` and is parsed with `Number(...)`.                                                                              |
| `LOCALAPPDATA`               | Windows base directory for default SQLite persistence.                                                                                                         |
| `XDG_DATA_HOME`              | POSIX base directory for default SQLite persistence.                                                                                                           |
| `COMSPEC`                    | Windows command shell executable. Defaults to `cmd.exe`.                                                                                                       |
| `SHELL`                      | POSIX command shell executable. Defaults to `/bin/sh`.                                                                                                         |

The environment-backed credential resolver can resolve any explicitly requested variable name, but the default runtime credential fallback map uses only `GROQ_API_KEY`, `OPENROUTER_API_KEY`, and `OPENAI_COMPATIBLE_API_KEY`.

### Model selection order

- Ollama: `OLLAMA_MODEL`
- Groq: `GROQ_MODEL`, then `OPENAI_COMPATIBLE_MODEL`, then `qwen/qwen3.6-27b`
- OpenRouter: `OPENROUTER_MODEL`, then `OPENAI_COMPATIBLE_MODEL`, then `OPENAI_MODEL`
- OpenAI-compatible: `OPENROUTER_MODEL`, then `OPENAI_COMPATIBLE_MODEL`, then `OPENAI_MODEL`

Routes constructed from environment values are deduplicated by provider ID and model ID.

### Inactive or stale environment names

These names appear in older documentation or setup guidance but are not active in the current runtime source:

- `OLLAMA_TIMEOUT_MS` is not read. Gateway-created Ollama clients currently use the adapter default timeout of 300,000 ms.
- `AGENT_ID` is not read. The TUI starts with the enabled `general` agent when available.
- `OPENAI_API_KEY` is not read by the current package runtime. The direct `OpenAIModel` accepts an API key programmatically.

## 4. Target workspace and `ENV_FILE`

The TUI can operate on a directory other than the repository:

```powershell
pnpm tui -- "D:\path\to\target-workspace"
```

Git Bash should use a relative path or quoted forward slashes:

```sh
pnpm tui -- ./tmp/target-workspace
pnpm tui -- "C:/path/to/target-workspace"
```

The TUI strips pnpm's forwarded leading `--`, requires zero or one workspace argument, verifies that the target exists and is a directory, and canonicalizes it with `realpath`.

The canonical target becomes the only root used by:

- workspace file tools
- ripgrep search tools
- command tools
- Git tools
- semantic retrieval
- project session persistence
- project `AGENTS.md`
- project `.agentic/agents/*.md`

By default, provider variables are loaded from `<target-workspace>/.env`.

To keep provider configuration somewhere else:

PowerShell:

```powershell
$env:ENV_FILE = "C:\secure-config\agentic.env"
pnpm tui -- "C:\work\target"
```

Git Bash:

```sh
ENV_FILE="C:/secure-config/agentic.env" pnpm tui -- "C:/work/target"
```

On Windows, launching from Git Bash does not change the agent command shell. Command tools still use `cmd.exe` because the runtime selects the shell from `process.platform`.

## 5. Runtime request routing

The headless runtime routes requests in this order:

1. A command-only verification request goes directly to the `verifier` agent.
2. A mutation-oriented request from `general` or `coding-agent` uses the five-stage pipeline when retrieval is available.
3. Other requests use the selected agent directly, with handoffs enabled.

Command-only verification detection looks for a verification verb such as `run`, `execute`, `rerun`, `check`, or `verify`, followed by a check target such as tests, suite, build, lint, typecheck, syntax check, or format check. It routes directly to `verifier` when no mutation verb is present, or when the prompt explicitly says not to modify files.

Examples that route directly to `verifier`:

```text
Run the tests
Check the build without modifying files
Verify lint and typecheck
```

The verifier route disables handoffs and workflow-completion forcing. Commands still require user approval.

Mutation requests use the sequential pipeline:

1. planner
2. retriever
3. coder
4. verifier
5. reviewer

## 6. TUI commands

These are the commands implemented by the current TUI dispatcher.

| Command                             | Behavior                                                                                           |
| ----------------------------------- | -------------------------------------------------------------------------------------------------- |
| `/help`                             | Shows concise built-in help.                                                                       |
| `/exit`                             | Exits the TUI.                                                                                     |
| `/quit`                             | Undocumented alias for `/exit`.                                                                    |
| `/new`                              | Creates and selects a new persisted session, then clears displayed messages.                       |
| `/clear`                            | Clears the current displayed transcript and saves an empty transcript for the session.             |
| `/sessions`                         | Lists project sessions and marks the active session. It does not select or resume another session. |
| `/agents`                           | Lists registered agents and marks the active agent.                                                |
| `/agent`                            | Shows the active agent and the full agent list.                                                    |
| `/agent <id>`                       | Selects an enabled agent for later tasks.                                                          |
| `/context`                          | Same as `/context list`.                                                                           |
| `/context list`                     | Lists manual file context snapshots for the current session.                                       |
| `/context add <path>`               | Adds a snapshot of a complete UTF-8 workspace file.                                                |
| `/context add <path>:<line>`        | Adds a one-line snapshot.                                                                          |
| `/context add <path>:<start>-<end>` | Adds an inclusive line-range snapshot.                                                             |
| `/context remove <path>[:range]`    | Removes matching manual context snapshots.                                                         |
| `/bytheway <message>`               | Runs one isolated model call with no tools and no main transcript mutation.                        |
| `/settings`                         | Lists provider configuration status.                                                               |
| `/settings <id>`                    | Shows masked provider details.                                                                     |
| `/settings <id> key=<value>`        | Saves a provider key when supported.                                                               |
| `/settings <id> baseUrl=<value>`    | Saves a provider base URL when supported.                                                          |
| `/settings <id> model=<value>`      | Saves a manual model ID when supported.                                                            |
| `/settings <id> validate`           | Validates the saved provider configuration and stores the result.                                  |
| `/settings <id> clear`              | Clears the provider key, base URL, manual model ID, and last validation result.                    |

Supported settings IDs:

- `groq`
- `openrouter`
- `ollama`
- `openai-compatible`

Settings arguments are split on whitespace. Values containing spaces are not supported.

Context paths can be quoted:

```text
/context add "src/path with spaces/file.ts":10-20
```

An unknown slash-prefixed input is submitted as a normal model task.

### TUI commands that are not currently implemented

Older documentation mentions these commands, but the current dispatcher does not implement them:

- `/resume <id>`
- `/model`
- `/agent-create`
- `/agent-edit`
- `/agent-delete`

The runtime service has a programmatic `resumeTask()` API, but the current TUI has no slash command for it.

## 7. Approval policy and keys

### Core approval sequence

For each model tool call, `AgentRunner`:

1. Looks up the registered tool.
2. Validates arguments with Ajv and the tool JSON schema.
3. Prepares a preview when the tool provides one.
4. Requests approval unless the tool explicitly declares `approval: "auto"`.
5. Normalizes a boolean or structured hunk decision.
6. Executes with the workspace root and cancellation signal.

A tool with no explicit approval metadata requires approval. Approval is per invocation. There is no persistent "always allow" mode.

If no TUI approval handler is available, approval fails closed.

### Non-diff approval keys

- `y`: allow once
- `n`: deny
- `Ctrl+C`: deny and cancel the active task
- Enter alone: no action

### File-diff approval keys

All hunks start selected.

- Up or Down: move focus between hunks
- Space: toggle the focused hunk
- `y` or Enter: apply selected hunks
- `a`: accept all hunks
- `r` or `n`: reject all hunks
- `Ctrl+C`: reject and cancel the active task

A file preview contains the path, base hash, proposed hash, unified diff, stable hunk IDs, and original and replacement text.

Before writing, the workspace rereads the file and verifies the approved base hash and preview. Stale files fail closed. Accepted hunks are applied atomically. Rejected hunks are returned to the model.

### General TUI cancellation

- `Ctrl+C` during a task: cancel the task
- `Ctrl+C` during approval: reject approval and cancel the task
- `Ctrl+C` while idle: exit

## 8. Registered tools

`createHeadlessRuntime()` registers 26 base tools. `handoff_agent` is added dynamically when handoffs are enabled.

| Tool                     | Responsibility                                              | Approval |
| ------------------------ | ----------------------------------------------------------- | -------- |
| `browse_url`             | Fetch a public HTTP(S) page and extract readable text.      | Ask      |
| `crawl_site`             | Crawl a bounded set of same-domain public pages.            | Ask      |
| `git_status`             | Read working-tree and branch status.                        | Auto     |
| `git_diff`               | Read unstaged changes.                                      | Auto     |
| `git_log`                | Read up to 20 recent commits.                               | Auto     |
| `git_branches`           | List local and remote branches.                             | Auto     |
| `git_add`                | Stage explicit paths after generated-output checks.         | Ask      |
| `git_commit`             | Commit staged changes after checking staged paths.          | Ask      |
| `git_checkout`           | Checkout an existing branch or create a local branch.       | Ask      |
| `git_push`               | Push an explicit branch to an explicit remote.              | Ask      |
| `list_directory`         | List files and directories inside the workspace.            | Auto     |
| `read_file`              | Read a UTF-8 workspace file with its path and SHA-256 hash. | Auto     |
| `write_file`             | Replace or create a UTF-8 file with a diff preview.         | Ask      |
| `create_file`            | Create a file only when it does not already exist.          | Ask      |
| `delete_file`            | Delete a file with a deletion preview.                      | Ask      |
| `apply_patch`            | Apply an exact old-content to new-content replacement.      | Ask      |
| `find_files`             | Find workspace files using a glob.                          | Auto     |
| `search_text`            | Search workspace text with a regular expression.            | Auto     |
| `run_command`            | Run a command through the native host shell.                | Ask      |
| `compile_code`           | Run a model-selected compile command.                       | Ask      |
| `run_code`               | Run a model-selected project command.                       | Ask      |
| `format_code`            | Run a model-selected formatting command.                    | Ask      |
| `syntax_check`           | Run a model-selected syntax command.                        | Ask      |
| `retrieve_context`       | Refresh and query the persistent semantic index.            | Auto     |
| `analyze_code_structure` | Extract named source blocks through the Rust sidecar.       | Auto     |
| `compute_ast_diff`       | Compute minimal line replacement chunks through Rust.       | Auto     |

Additional tool behavior:

- `handoff_agent` is dynamically registered and auto-approved.
- Hidden delegation proxies use a blocked tool's name but delegate to another agent. They are hidden from model schemas and auto-approved at the parent. Any real specialist mutation still follows the specialist tool's approval policy.
- The `@agentic-runtime/command` package exports a generic tool named `command`, but the default headless runtime does not register it. Its missing approval metadata means it would ask if another host registered it.
- `retrieve_context` is read-only with respect to workspace source, but normally refreshes a SQLite retrieval index.

### Agent-visible tools

- Architect (`general`): `list_directory`, `read_file`, `find_files`, `retrieve_context`, `browse_url`
- Retriever: `retrieve_context`, `read_file`, `find_files`
- Coder (`coding-agent`): read/list/find/retrieve, file mutation, `run_command`, Rust analysis, and read-only Git tools
- Verifier: read/list/find, `run_command`, `compile_code`, `syntax_check`, `git_diff`
- Reviewer: `read_file`, `git_diff`, `git_status`

## 9. Command execution boundary

On Windows, commands run as:

```text
cmd.exe /d /s /c <command>
```

`COMSPEC` can replace `cmd.exe`.

On Linux and macOS, commands run as:

```text
/bin/sh -c <command>
```

`SHELL` can replace `/bin/sh`.

Defaults:

- timeout: 30,000 ms
- maximum output: 100,000 bytes
- nonzero exit codes are returned as tool errors
- cancellation uses the runtime abort signal
- Windows child windows are hidden

The child receives a sanitized environment.

Windows allowlist:

- `APPDATA`
- `COMSPEC`
- `HOMEDRIVE`
- `HOMEPATH`
- `LOCALAPPDATA`
- `PATH`
- `PATHEXT`
- `SYSTEMROOT`
- `TEMP`
- `TMP`
- `USERPROFILE`
- `WINDIR`

POSIX allowlist:

- `HOME`
- `LANG`
- `LC_ALL`
- `LC_CTYPE`
- `PATH`
- `TEMP`
- `TMP`
- `TMPDIR`

Provider credentials are not forwarded to commands.

## 10. gui-server HTTP interface

### Server properties

- Default URL: `http://127.0.0.1:4737`
- Bind address: `127.0.0.1` only
- Port override: `AGENTIC_GUI_PORT`
- Project override: `AGENTIC_PROJECT_ROOT`
- Maximum JSON request body: 64 KiB
- Maximum search results: 200
- Static directory default: `packages/gui/dist`
- No authentication layer
- No CORS configuration
- API responses use JSON
- Uncaught request errors return HTTP 500

The loopback binding is important because provider settings can write credentials.

### `GET /api/project`

Query: none.

Body: none.

Success result:

```json
{
  "rootPath": "canonical project path",
  "name": "last path component"
}
```

### `GET /api/files`

Query:

- `path`: optional workspace-relative directory, default `.`

Body: none.

Success result:

```json
{
  "entries": [
    {
      "name": "src",
      "path": "src",
      "type": "directory"
    },
    {
      "name": "file.ts",
      "path": "file.ts",
      "type": "file",
      "size": 123
    }
  ]
}
```

Directories sort before files, then names sort lexically. Workspace errors return HTTP 400.

### `GET /api/files/content`

Query:

- `path`: required workspace-relative file path

Body: none.

Success result:

```json
{
  "path": "src/file.ts",
  "content": "file contents",
  "hash": "sha256 hex digest"
}
```

A missing `path` or file-read failure returns HTTP 400.

### `GET /api/search`

Query:

- `q`: optional regular expression
- `glob`: optional file glob filter

Body: none.

If `q` is absent or empty:

```json
{
  "matches": []
}
```

Success result:

```json
{
  "matches": [
    {
      "path": "src/file.ts",
      "line": 10,
      "column": 4,
      "text": "matching line"
    }
  ]
}
```

Search errors return HTTP 400. Results are capped at 200.

### `GET /api/providers`

Query: none.

Body: none.

Success result:

```json
{
  "providers": [
    {
      "id": "groq",
      "label": "Groq",
      "fields": ["apiKey"],
      "credentialRequired": true,
      "helpUrl": "https://console.groq.com/keys",
      "hasCredential": true,
      "maskedCredential": "********abcd",
      "baseUrl": null,
      "manualModelId": null,
      "lastValidation": {
        "ok": true,
        "at": 0
      }
    }
  ]
}
```

Actual undefined optional fields may be omitted by JSON serialization. Raw credentials are never returned.

### `PUT /api/providers/:providerId`

Supported provider IDs:

- `groq`
- `openrouter`
- `ollama`
- `openai-compatible`

Query: none.

JSON body, limited to fields supported by the provider:

```json
{
  "apiKey": "new key",
  "baseUrl": "http://localhost:11434",
  "manualModelId": "model-id"
}
```

Behavior:

- An omitted field is unchanged.
- A provided non-empty value is trimmed and saved.
- A provided empty string clears that field.
- Unsupported fields are ignored.

Success result:

```json
{
  "provider": {
    "id": "provider-id",
    "hasCredential": true,
    "maskedCredential": "masked value"
  }
}
```

Unknown providers return HTTP 404. Malformed JSON, oversized bodies, and uncaught update failures reach the outer HTTP 500 handler.

### `DELETE /api/providers/:providerId`

Query: none.

Body: none.

Clears:

- stored credential
- base URL
- manual model ID
- last validation result

Success result:

```json
{
  "provider": {
    "id": "provider-id",
    "hasCredential": false
  }
}
```

Unknown providers return HTTP 404.

### `POST /api/providers/:providerId/validate`

Query: none.

Body: none.

The server builds a one-off provider gateway from saved settings and environment credential fallback, calls the provider validation method, stores the result with a timestamp, and returns:

```json
{
  "result": {
    "ok": true,
    "at": 0
  }
}
```

A provider validation failure is returned as HTTP 200 with `ok: false` and a message. Unknown providers return HTTP 404.

### `GET /*` for non-API paths

When static serving is enabled:

- Existing files are streamed from the configured static directory.
- Missing paths fall back to `index.html` for browser routing.
- Known MIME types include HTML, JavaScript, CSS, SVG, JSON, PNG, and ICO.
- If the GUI build is missing, the server returns HTTP 404 JSON with a build instruction.

Unsupported `/api/...` paths and unsupported methods return HTTP 404 JSON.

### GUI limitations

The browser GUI currently provides:

- project connection status
- workspace explorer
- read-only Monaco file display
- provider settings
- a local chat mockup

The chat mockup is not connected to `HeadlessRuntimeService`. gui-server currently has no task, chat, event-stream, approval, cancellation, session, or trace HTTP endpoint.

## 11. External provider endpoints and protocols

### OpenRouter

Credential validation and discovery:

```text
GET https://openrouter.ai/api/v1/models
Authorization: Bearer <credential>
```

Model calls use OpenAI-compatible Chat Completions:

```text
Base URL: https://openrouter.ai/api/v1
Effective SDK path: POST /chat/completions
```

Tools use OpenAI function-tool schemas. Streaming is not requested. The settings help URL is `https://openrouter.ai/keys`.

### Groq

Credential validation and discovery:

```text
GET https://api.groq.com/openai/v1/models
Authorization: Bearer <credential>
```

Model calls use OpenAI-compatible Chat Completions:

```text
Base URL: https://api.groq.com/openai/v1
Effective SDK path: POST /chat/completions
```

Tools use OpenAI function-tool schemas. Streaming is not requested. The settings help URL is `https://console.groq.com/keys`.

### Ollama

Default base URL:

```text
http://localhost:11434
```

Validation and model discovery:

```text
GET /api/tags
```

Model requests:

```text
POST /api/chat
Content-Type: application/json
```

Request shape:

```json
{
  "model": "model-id",
  "messages": [],
  "tools": [],
  "stream": false
}
```

Native tools use:

```json
{
  "type": "function",
  "function": {
    "name": "tool_name",
    "arguments": {}
  }
}
```

The adapter also recognizes JSON tool calls in ordinary text, fenced JSON, `<tool_call>`, and `<tool_response>` blocks.

The standalone `OllamaModel` accepts an optional bearer token, but the default gateway's Ollama route does not pass one.

### OpenAI-compatible local endpoint

A base URL is required.

Validation and discovery:

```text
GET <baseUrl>/models
Authorization: Bearer <optional credential>
```

A 404 is accepted during validation. During discovery, a 404 can fall back to the saved manual model ID.

Model calls use OpenAI-compatible Chat Completions:

```text
Effective SDK path: POST <baseUrl>/chat/completions
```

For common local servers, the configured base URL normally includes `/v1`.

### Direct OpenAI adapter

`@agentic-runtime/openai` contains a direct adapter, but it is not registered by the default gateway and cannot be selected by the current `MODEL_PROVIDER` values.

Protocol:

```text
OpenAI Responses API
Normal default endpoint: POST https://api.openai.com/v1/responses
```

The base URL can be overridden programmatically. The default model is `gpt-4.1-mini`. Function tools are strict, and SDK retries are disabled with `maxRetries: 0`.

The same package provides the OpenAI-compatible Chat Completions adapter used by Groq, OpenRouter, and local endpoints.

### Web tools

`browse_url` and `crawl_site` accept only HTTP and HTTPS.

Safety boundaries:

- private and reserved IP addresses are rejected
- redirects are checked before following
- `browse_url` follows at most five redirects
- content must be `text/html` or `text/plain`
- response bodies are limited to 2 MB
- page scripts are not executed by the article extraction path
- crawling is limited to the same domain
- crawl requests are limited to 25 pages
- crawl concurrency is 2
- crawl request-handler timeout is 20 seconds

### Git

Git tools use the locally installed Git through `simple-git`. There is no fixed network endpoint. `git_push` uses the URL and protocol configured for the named repository remote.

### Browser GUI external resources

`packages/gui/index.html` loads Inter and Space Mono CSS from Google Fonts through `fonts.googleapis.com` and font content from `fonts.gstatic.com`.

## 12. Rust sidecar RPC

### Process and transport

The TypeScript client starts:

Windows:

```text
rust/target/debug/rust.exe
```

Linux and macOS:

```text
rust/target/debug/rust
```

Transport is newline-delimited JSON over child-process stdin and stdout. Each request and response occupies one line.

Default TypeScript-side request timeout: 30,000 ms.

Request:

```json
{
  "id": 1,
  "method": "slice_ast",
  "params": {}
}
```

Success response:

```json
{
  "id": 1,
  "result": {}
}
```

Error response:

```json
{
  "id": 1,
  "error": "message"
}
```

### `slice_ast`

Parameters:

```json
{
  "code": "source text",
  "symbols": ["name"],
  "ext": "ts"
}
```

Result: array of matching semantic source blocks.

Tree-sitter support:

- TypeScript, TSX, JavaScript, JSX through the TypeScript grammar
- Python
- Rust

Other extensions use a declaration and indentation fallback.

### `prune_ast`

Parameters:

```json
{
  "code": "source text",
  "ext": "ts"
}
```

Result: source text with supported function bodies replaced by placeholders. Unsupported extensions return the original source.

### `compute_diff`

Parameters:

```json
{
  "original": "old text",
  "proposal": "new text"
}
```

Result:

```json
[
  {
    "start_line": 2,
    "end_line": 3,
    "replacement": "replacement text"
  }
]
```

The engine uses line-based longest common subsequence chunks. Inputs whose line-grid size exceeds 4,000,000 cells use a trimmed single-replacement fallback.

### `check_cycle`

Parameters:

```json
{
  "file_hash": [0, 1, 2],
  "cmd": "optional command"
}
```

The file hash is copied into a 32-byte array. The sidecar combines it with the optional command in a BLAKE3 state snapshot and compares it with a rolling history of 10 states.

Result: the number of steps back to a repeated state, or `null`.

## 13. Persistence

### Default data root

Windows:

```text
%LOCALAPPDATA%\agentic-runtime
```

If `LOCALAPPDATA` is absent, the fallback is:

```text
<home>\AppData\Local\agentic-runtime
```

Linux and macOS:

```text
$XDG_DATA_HOME/agentic-runtime
```

If `XDG_DATA_HOME` is absent:

```text
~/.local/share/agentic-runtime
```

### Database layout

Global database:

```text
<data-root>/global.db
```

Per-project database:

```text
<data-root>/projects/<project-id>/project.db
```

Headless runtime retrieval database:

```text
<data-root>/projects/<project-id>/retrieval.db
```

The project ID is the first 32 hexadecimal characters of a SHA-256 hash of the canonical project root. Windows root comparison normalizes slashes and case.

### Stored globally

- provider credentials
- provider base URLs
- manual model IDs
- validation results
- agent definitions

### Stored per project

- project identity
- sessions and transcripts
- tasks and task state
- runtime and agent events
- manual context snapshots
- orchestration checkpoints
- workspace recovery journals
- hierarchical trace spans
- semantic retrieval files, symbols, and edges in the sibling retrieval database

Credentials are masked in UI responses and sanitized from persisted tracing paths. Saved credentials take precedence over environment fallbacks.

`SessionStore` accepts programmatic data-root and database-path overrides. A standalone `SemanticRetrievalIndex` without a project persistence context defaults to `<project>/.agentic/data/retrieval.db`, but the composed headless runtime places retrieval beside `project.db`.

## 14. Troubleshooting

### `node:sqlite` is missing

Use Node.js 22.5.0 or newer:

```sh
node --version
```

### `cargo` is not found during `pnpm build`

Install Rust and ensure `cargo` is on `PATH`:

```sh
cargo --version
```

Then retry:

```sh
pnpm build:rust
```

### Rust tools report that the engine cannot start

Build the sidecar:

```sh
cargo build --manifest-path rust/Cargo.toml
```

Confirm the expected binary exists:

```text
rust/target/debug/rust.exe
```

on Windows, or:

```text
rust/target/debug/rust
```

on POSIX systems.

### TUI says the workspace does not exist

Pass one existing directory after `--`:

```sh
pnpm tui -- "C:/work/project"
```

In Git Bash, use forward slashes or a relative path. Backslashes can be consumed as escape characters.

### TUI rejects `MODEL_PROVIDER`

Use one of:

```text
ollama
groq
openrouter
openai-compatible
```

Direct `openai` is not a supported current TUI provider ID.

### Ollama has no model ID

Set `OLLAMA_MODEL` to a model shown by:

```sh
ollama list
```

Make sure the Ollama server is available at `OLLAMA_ENDPOINT`.

### Provider credential is unavailable

Set the matching environment variable or save the key with `/settings` or the GUI:

- Groq: `GROQ_API_KEY`
- OpenRouter: `OPENROUTER_API_KEY`
- OpenAI-compatible: `OPENAI_COMPATIBLE_API_KEY`

SQLite credentials override environment fallbacks.

### `OLLAMA_TIMEOUT_MS` has no effect

This variable is not currently read. The gateway-created Ollama adapter uses a 300,000 ms timeout.

### Commands behave differently in Git Bash

On Windows, agent tools run through `cmd.exe`, not Bash. Use commands valid for `cmd.exe`, or invoke the desired executable explicitly.

### A command cannot see an environment variable

The command executor uses an allowlist and intentionally removes provider credentials and most parent variables. Put non-secret executable locations on `PATH`. Do not depend on provider keys inside shell tools.

### Tool approval was denied

The denial is returned to the model as a tool error. Submit the task again if execution is still wanted. There is no persistent always-allow setting.

### A file edit says the file changed after preview

The workspace compares the current file hash with the approved base hash. Reread the file and let the agent prepare a fresh preview. The runtime will not apply stale hunks.

### gui-server reports that the GUI build is missing

Build the GUI:

```sh
pnpm --filter @agentic-runtime/gui build
```

or use:

```sh
pnpm settings
```

### Port 4737 is already in use

Choose another port before starting gui-server.

PowerShell:

```powershell
$env:AGENTIC_GUI_PORT = "4740"
pnpm settings
```

Git Bash:

```sh
AGENTIC_GUI_PORT=4740 pnpm settings
```

When using Vite development mode, update the proxy target in `packages/gui/vite.config.ts` if the API port changes.

### Browser chat does not run tasks

This is expected. The current GUI chat is a local preview only. Use `pnpm tui` for agent tasks.

### `/resume`, `/model`, or agent CRUD commands do not work

They are not implemented in the current TUI dispatcher. `resumeTask()` exists only as a programmatic runtime API.

### Search fails

The search package uses the ripgrep binary supplied by `@vscode/ripgrep`. Reinstall dependencies and check that the workspace is readable:

```sh
pnpm install
```

## 15. Responsibility catalog

This catalog covers authored source and configuration under `packages/`, `rust/src/`, `tests/`, the currently absent `examples/` area, and key root configuration.

### Key root files

| File                                      | Responsibility                                                                                                    |
| ----------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| `.env.example`                            | Committed provider configuration template. Real credentials belong in ignored `.env` files or SQLite settings.    |
| `.gitignore`                              | Excludes dependencies, build output, environment files, temporary workspaces, Rust output, and `.agentic/data/`.  |
| `.prettierrc.json`                        | Defines double quotes, semicolons, trailing commas, and automatic line-ending handling.                           |
| `AGENTS.md`                               | Repository-specific instructions for coding agents.                                                               |
| `README.md`                               | User-facing project overview and setup notes. Some command and TUI sections are stale relative to current source. |
| `eslint.config.mjs`                       | Applies recommended JavaScript and TypeScript ESLint rules and ignores generated and temporary paths.             |
| `package.json`                            | Defines requirements, pinned pnpm version, scripts, and root development dependencies.                            |
| `pnpm-lock.yaml`                          | Generated exact pnpm dependency graph.                                                                            |
| `pnpm-workspace.yaml`                     | Includes `packages/*` in the pnpm workspace.                                                                      |
| `tsconfig.json`                           | Shared strict ES2022 NodeNext compiler settings.                                                                  |
| `rust/Cargo.toml`                         | Defines the Rust 2024 sidecar package and dependencies.                                                           |
| `rust/Cargo.lock`                         | Generated exact Rust dependency graph.                                                                            |
| `tests/tsconfig.json`                     | Compiles root tests to `dist-tests/`.                                                                             |
| `docs/RUNBOOK_AND_INTERFACE_REFERENCE.md` | Operational and interface reference for the current implementation.                                               |

### Package manifests and TypeScript configuration

All non-GUI package TypeScript configs extend the root config, compile `src/` to `dist/`, and write incremental state to `dist/.tsbuildinfo`.

| Files                                                                   | Responsibility                                                                                                                    |
| ----------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| `packages/command/package.json`, `packages/command/tsconfig.json`       | Private ESM command-execution package and build configuration.                                                                    |
| `packages/core/package.json`, `packages/core/tsconfig.json`             | Framework-neutral core contracts, orchestration, and build configuration.                                                         |
| `packages/gateway/package.json`, `packages/gateway/tsconfig.json`       | Provider gateway package and build configuration.                                                                                 |
| `packages/gui/package.json`, `packages/gui/tsconfig.json`               | Vite and Monaco GUI package. The GUI config uses bundler resolution, DOM libraries, strict unused checks, and no TypeScript emit. |
| `packages/gui-server/package.json`, `packages/gui-server/tsconfig.json` | Node HTTP GUI bridge package and `agentic-gui-server` binary build.                                                               |
| `packages/ollama/package.json`, `packages/ollama/tsconfig.json`         | Ollama adapter package and build configuration.                                                                                   |
| `packages/openai/package.json`, `packages/openai/tsconfig.json`         | OpenAI adapters package and build configuration.                                                                                  |
| `packages/retrieval/package.json`, `packages/retrieval/tsconfig.json`   | Semantic retrieval package and build configuration.                                                                               |
| `packages/runtime/package.json`, `packages/runtime/tsconfig.json`       | Headless runtime service package and build configuration.                                                                         |
| `packages/search/package.json`, `packages/search/tsconfig.json`         | Ripgrep search package and build configuration.                                                                                   |
| `packages/session/package.json`, `packages/session/tsconfig.json`       | SQLite persistence package and build configuration.                                                                               |
| `packages/tools/package.json`, `packages/tools/tsconfig.json`           | IDE, web, Git, and command tools package and build configuration.                                                                 |
| `packages/tui/package.json`, `packages/tui/tsconfig.json`               | Ink and React TUI package, `agentic-tui` binary, JSX configuration, and React types.                                              |
| `packages/workspace/package.json`, `packages/workspace/tsconfig.json`   | Safe workspace file service package and build configuration.                                                                      |

`packages/server/` is empty and has no authored source or configuration files.

### `packages/command`

| File                            | Responsibility                                                                                  |
| ------------------------------- | ----------------------------------------------------------------------------------------------- |
| `packages/command/src/index.ts` | Runs bounded, cancellable commands through `cmd.exe` or `/bin/sh` with a sanitized environment. |

### `packages/core`

| File                                 | Responsibility                                                                                                             |
| ------------------------------------ | -------------------------------------------------------------------------------------------------------------------------- |
| `packages/core/src/agent.ts`         | Generic model and tool loop, approvals, compaction, duplicate-call protection, workflow follow-through, and safety limits. |
| `packages/core/src/agents.ts`        | Registry-driven multi-agent execution, tool scoping, hidden delegation proxies, and bounded handoffs.                      |
| `packages/core/src/events.ts`        | Agent model, tool, compaction, completion, and safety event contracts.                                                     |
| `packages/core/src/index.ts`         | Public core export surface.                                                                                                |
| `packages/core/src/messages.ts`      | Conversation, tool call, tool result metadata, and compacted-state message contracts.                                      |
| `packages/core/src/model.ts`         | Provider-neutral model interface, token estimates, usage and timing records, and typed model error classification.         |
| `packages/core/src/orchestrator.ts`  | Sequential dependency-aware role pipeline with retries, recovery, limits, events, and checkpoints.                         |
| `packages/core/src/rust-bridge.ts`   | Child-process lifecycle and typed newline-JSON RPC client for Rust.                                                        |
| `packages/core/src/rust-tools.ts`    | Agent tool wrappers for Rust AST slicing and diff calculation.                                                             |
| `packages/core/src/test-bridge.ts`   | Manual console smoke program for Rust RPC methods.                                                                         |
| `packages/core/src/tool-registry.ts` | Exposed and hidden tool registration plus Ajv argument validation.                                                         |
| `packages/core/src/tools.ts`         | Tool, preview, approval, review, mutation, and context-artifact contracts.                                                 |
| `packages/core/test.ts`              | Small TypeScript fixture outside the package build include.                                                                |

### `packages/gateway`

| File                            | Responsibility                                                                                                                                         |
| ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `packages/gateway/src/index.ts` | Provider adapters, credential lookup, model discovery, route ranking, cooldowns, failover, cost estimates, validation, and provider settings metadata. |

### `packages/gui`

| File                                     | Responsibility                                                                                             |
| ---------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| `packages/gui/index.html`                | Browser IDE shell for explorer, local chat preview, provider settings, editor, and status bar.             |
| `packages/gui/src/main.ts`               | Initializes the GUI, project status, local chat preview, activity views, and provider settings operations. |
| `packages/gui/src/editor.ts`             | Configures read-only Monaco workers, language selection, models, cursor status, and file loading.          |
| `packages/gui/src/explorer.ts`           | Loads directories and handles file selection through gui-server.                                           |
| `packages/gui/src/env.d.ts`              | Adds Vite client types.                                                                                    |
| `packages/gui/src/styles.css`            | Defines the dark IDE layout and component styling.                                                         |
| `packages/gui/vite.config.ts`            | Configures Vite port `1420` and the `/api` proxy to `127.0.0.1:4737`.                                      |
| `packages/gui/.gitignore`                | Excludes GUI logs, dependencies, output, and editor-local files.                                           |
| `packages/gui/.vscode/extensions.json`   | Recommends Tauri and rust-analyzer extensions. The Tauri recommendation is stale.                          |
| `packages/gui/README.md`                 | Original Tauri template notes. This is stale because the current GUI has no Tauri package.                 |
| `packages/gui/src/assets/tauri.svg`      | Legacy Tauri logo asset.                                                                                   |
| `packages/gui/src/assets/typescript.svg` | TypeScript logo asset.                                                                                     |
| `packages/gui/src/assets/vite.svg`       | Vite logo asset.                                                                                           |

### `packages/gui-server`

| File                               | Responsibility                                                                             |
| ---------------------------------- | ------------------------------------------------------------------------------------------ |
| `packages/gui-server/src/index.ts` | Loopback HTTP project, file, search, provider-settings, validation, and static-GUI server. |
| `packages/gui-server/src/cli.ts`   | Reads server environment settings, starts the server, and closes on `SIGINT` or `SIGTERM`. |

### Provider packages

| File                           | Responsibility                                                                                                                                       |
| ------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/ollama/src/index.ts` | Ollama `/api/chat` adapter, message and tool conversion, usage and timing normalization, cancellation, timeout, and fallback JSON tool-call parsing. |
| `packages/openai/src/index.ts` | Direct OpenAI Responses adapter, OpenAI-compatible Chat Completions adapter, message and tool conversion, usage normalization, and one-shot helper.  |

### `packages/retrieval`

| File                                 | Responsibility                                                                          |
| ------------------------------------ | --------------------------------------------------------------------------------------- |
| `packages/retrieval/src/database.ts` | Project-scoped SQLite schema and queries for indexed files, symbols, and graph edges.   |
| `packages/retrieval/src/extract.ts`  | TypeScript AST declaration and edge extraction plus mixed-language text fallback.       |
| `packages/retrieval/src/index.ts`    | Incremental indexing, ranking, graph expansion, recovery, and compact slice generation. |
| `packages/retrieval/src/project.ts`  | Canonical project identity hashing and Windows-aware root comparison.                   |
| `packages/retrieval/src/types.ts`    | Retrieval index, metadata, search, workspace, edge, slice, and result contracts.        |

### `packages/runtime`

| File                                      | Responsibility                                                                                                                                                        |
| ----------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/runtime/src/composition.ts`     | Composes persistence, retrieval, provider gateway, tool registry, built-in agents, and the headless service.                                                          |
| `packages/runtime/src/default-agents.ts`  | Defines reserved Architect, Retriever, Coder, Verifier, and Reviewer records and tool permissions.                                                                    |
| `packages/runtime/src/index.ts`           | Public runtime export surface.                                                                                                                                        |
| `packages/runtime/src/runtime-service.ts` | Owns task and session lifecycle, direct verifier routing, the five-stage pipeline, approvals, cancellation, recovery, context, tracing, and persistence coordination. |
| `packages/runtime/src/types.ts`           | Runtime model selection, limits, approvals, tasks, sessions, context, settings, and event contracts.                                                                  |

### Service and tool packages

| File                              | Responsibility                                                                                                                                                                                          |
| --------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/search/src/index.ts`    | Ripgrep-backed regular-expression search and glob file discovery with normalized paths.                                                                                                                 |
| `packages/session/src/index.ts`   | Global and project SQLite persistence for settings, credentials, agents, sessions, tasks, events, context, checkpoints, recovery state, and traces; also loads project instructions and agent Markdown. |
| `packages/tools/src/index.ts`     | Creates the IDE tool catalog and implements file, search, command, preview, and partial-hunk behavior.                                                                                                  |
| `packages/tools/src/web-git.ts`   | Implements bounded public web access and read-only or approval-gated Git tools.                                                                                                                         |
| `packages/workspace/src/index.ts` | Enforces workspace path containment, symlink blocking, UTF-8 limits, hashing, stable hunks, atomic writes, conflict checks, deletion, and rollback.                                                     |

### `packages/tui`

| File                            | Responsibility                                                                                                           |
| ------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| `packages/tui/src/index.tsx`    | CLI entry point, target workspace resolution, dotenv loading, and Ink rendering.                                         |
| `packages/tui/src/app.tsx`      | TUI rendering, slash commands, provider selection, settings, approvals, task execution, cancellation, and event display. |
| `packages/tui/src/commands.ts`  | Parses and formats `/context` and `/bytheway`.                                                                           |
| `packages/tui/src/ui-state.ts`  | Reducer state for model routes, pipeline stages, handoffs, tools, approvals, tasks, and errors.                          |
| `packages/tui/src/workspace.ts` | Validates and canonicalizes the optional workspace argument.                                                             |

### Rust source

| File                  | Responsibility                                                                                                                                       |
| --------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| `rust/src/lib.rs`     | Exposes Rust modules to the binary and unit tests.                                                                                                   |
| `rust/src/main.rs`    | Implements the newline-delimited JSON RPC loop and dispatches four methods.                                                                          |
| `rust/src/diff.rs`    | Computes minimal line chunks, supports partial merge, and contains three unit tests.                                                                 |
| `rust/src/flatcpg.rs` | Provides flat graph primitives, personalized PageRank slicing, tree-sitter extraction, signature pruning, fallback extraction, and three unit tests. |
| `rust/src/merkle.rs`  | Builds BLAKE3 state snapshots and detects repeated states in bounded history; contains one unit test.                                                |
| `rust/src/wal.rs`     | Experimental memory-mapped append and read write-ahead log; contains one unit test.                                                                  |

### Examples

The legacy example files and their root scripts were removed. Provider setup and protocols are covered in this runbook.

### Tests

| File                      | Responsibility                                                                                                                                                                                    |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `tests/runtime.test.ts`   | Broad integration coverage for registries, approval, TUI state, tools, workspace changes, command execution, agents, orchestration, runtime pipeline, compaction, recovery, sessions, and traces. |
| `tests/routing.test.ts`   | Covers model error classification, route ranking, cooldowns, failover, terminal errors, context limits, observer isolation, and sanitized events.                                                 |
| `tests/retrieval.test.ts` | Covers persistent indexing, TypeScript and fallback extraction, ranking, query recovery, incremental changes, deletion, reopening, and project isolation.                                         |

## 16. Known gaps and stale surfaces

- The browser chat is not connected to the headless runtime.
- gui-server has no task, streaming-event, approval, cancellation, session, or trace transport.
- The TUI has no `/resume`, `/model`, or agent CRUD commands despite older documentation.
- `OLLAMA_TIMEOUT_MS` and `AGENT_ID` are documented in older material but are not active.
- The direct OpenAI Responses adapter is not registered in the default provider gateway.
- `packages/gui/README.md`, the Tauri VS Code recommendation, and `tauri.svg` are legacy template artifacts.
- `packages/server/` is empty.
- Shell, Git, package-manager, network, and external-process side effects cannot be automatically rolled back.
- The default file tools forward mutation records as `ToolResult.workspaceMutation`, which the runtime writes into the recovery journal, so hash-guarded rollback covers ordinary edits. It cannot reverse command, Git, network, or other external side effects, and stops rather than overwriting a later user edit.
