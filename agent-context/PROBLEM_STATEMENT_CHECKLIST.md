# Takneek PS Implementation Checklist

The TUI is intentionally excluded from this assessment.

Legend: `[x]` done, `[~]` partial, `[ ]` remaining.

## 1. Multi-Agent Orchestration

- [x] Work is routed to the cheapest sufficient path: read-only verification
      goes straight to the Verifier, a question about the opened project goes
      to the read-only Architect, general knowledge goes to a tool-free chat
      agent, and only workspace work enters the coding pipeline. No path lets
      a general question reach the Coder.

- [x] Agent loop exists through `AgentRunner`.
- [x] Tool-call repetition detection.
- [x] Step-limit safety handling.
- [x] Multi-step edit, reread, and verification continuation.
- [x] Registry-driven agents and specialist handoff are supported by
      `MultiAgentOrchestrator`.
- [x] The live headless coding path runs a checkpointed planner, retriever,
      coder, verifier, and reviewer pipeline with bounded corrective recovery.
- [x] Attempt/time budgets and repeated-failure safeguards.
- [x] Planner-driven decomposition for existing codebases. The planner may
      return a fenced `subtasks` block; `TaskOrchestrator` then replaces the
      placeholder coding step with up to four scoped steps and rewires the
      dependencies around it. Parsing fails closed and the orchestrator drops an
      invalid rewrite silently, so a model that cannot emit structured output
      falls back to the single generic step. Expansions are checkpointed and
      replayed on resume.
- [x] Verifier failure triggers recovery: hash-guarded rollback, fresh
      retrieval, replanning, corrective coding, and reverification. The default
      file tools forward their mutation records as `ToolResult.workspaceMutation`
      (`packages/tools/src/index.ts:331`), which the runtime writes into the
      recovery journal, so rollback covers ordinary edits and not just the
      primitives. A created file is preserved rather than deleted, and a
      rollback that would overwrite a later user edit stops instead.
- [x] Twelve independent safeguards against runaway or stuck tasks: attempts per
      step, total attempts, model steps, tool calls, wall clock, dollar cost,
      handoff depth, handoff count, consecutive duplicate tool calls, truncated
      output retries, repeated failure fingerprints, and a Merkle workspace
      state tree that catches an edit/revert/re-edit loop a fingerprint cannot
      see.

## 2. Model and Hosting Constraints

- [x] OpenAI and Ollama provider boundaries exist.
- [x] Local Ollama support exists.
- [x] Provider/model configuration through the settings screen, with
      environment variables as fallback. Validation sends a one-token completion
      rather than only listing models, so a key that can list but not infer -
      an unverified trial, an account without billing - fails at configuration
      time instead of mid-task, and the message names the likely cause.
- [~] Formal enforcement that every selected model is `<=80B` parameters:
  `ModelRegistry.replace()` drops any model with a _known_ count over 80B.
  Partial, and this is the one compliance risk worth naming: the catalog has
  15 entries, models with an _unknown_ count are flagged `unverified` rather
  than blocked, that flag is not surfaced in the settings screen, and the
  default Groq, Mistral, and Cerebras model IDs have not been checked against
  a live API.
- [x] Local models are assessed against the `16GB RAM / 8GB VRAM` reference
      machine. `assessLocalModel` judges an Ollama model by its reported weight
      size — the quantity that actually decides whether it loads — returning
      `fits`, `tight` (runs with CPU offload), `exceeds`, or `unknown`, exposed
      on each model's metadata. Deliberately advisory rather than blocking: a
      `tight` model still runs, and the user should see that choice rather than
      have it made silently. VRAM is not readable portably from Node without a
      native dependency, so weight size stands in for it.
- [x] Provider eligibility enforcement: `ProviderRegistry.register()` rejects
      any provider ID not on the explicit free-tier/pay-as-you-go/local
      allowlist.
- [x] Per-task cost ceiling. Real spend is summed from provider usage on every
      completed model call (`HeadlessRuntimeService.recordSpend`), published live
      as `task_spend` events with `warning`/`exceeded` levels, and enforced at
      every model-call boundary by `assertWithinBudget`. Default
      `maxTaskCostUsd` is 0.5, matching the evaluation ceiling. Exceeding it
      halts the task with a message naming the spend and the budget.

## 3. Smart Routing

- [x] Provider abstraction covers Groq, OpenRouter, Mistral, Cerebras, Hugging
      Face, Ollama, and any OpenAI-compatible endpoint. Registration rejects any
      provider not on the free-tier / pay-as-you-go / local allowlist.
- [x] Ordered provider/model route preferences are configurable.
- [x] Routing uses tool need, context fit, cost, preference, cooldown, and a
      per-stage bias driven by syntactic task-complexity classification
      (`classifyTaskComplexity`, `routePolicyForStage`): `capacity` for planning
      a complex task and for verification/review, `economy` for retrieval
      summarisation and chat, `balanced` otherwise. Bias only reorders routes
      that are already eligible, and a context-window floor is relaxed rather
      than allowed to empty the route list.
- [x] Context-size, rate-limit cooldown, and estimated-cost-aware ranking.
- [x] Transparent routing explanations are emitted live and persisted.
- [x] Automatic retryable fallback reuses the exact request and task state.
- [x] Mandatory settings screen for provider API keys. Both TUI (`/settings`)
      and GUI (`pnpm settings`) read/write the same global-SQLite-backed
      credentials via `StoredCredentialResolver`; validated end-to-end with a
      live smoke test against the real Groq API. Known gap: keys are stored
      plaintext-at-rest (no OS keychain integration).

## 4. Automatic Context Compaction

- [x] Automatic context monitoring estimates provider-visible request tokens.
- [x] Compaction uses the selected route window and configurable trigger/target.
- [x] Structured state retains objective, work, failures, files/hashes,
      verification, retrieval, project rules, and open questions.
- [x] Repeated compaction is bounded and regression-tested.
- [x] Context-limit errors trigger bounded compaction and same-step retry.

## 5. Code Retrieval Pipeline

- [x] Workspace-isolated filesystem access.
- [x] Ripgrep-backed text and file search.
- [x] Search and index results are normalized to workspace-relative paths, with
      separators unified so a path means the same thing on every platform.
- [x] Discovery honours ignore rules at the source. A positive ripgrep `--glob`
      overrides `.gitignore`, so the previous wildcard turned a 116-file listing
      into a 40,000-file one; the wildcard case now passes no positive glob and
      every call carries explicit exclusions.
- [x] Per-project persistent SQLite code index.
- [x] TypeScript/TSX/JS/JSX semantic structure plus mixed-language text fallback.
- [x] Incremental indexing is stat-gated, so the refresh that runs on every
      query does not re-read the project. Discovery passes explicit ignore
      exclusions to ripgrep: a positive `--glob` overrides `.gitignore`, so the
      previous wildcard glob was enumerating `node_modules` (21,653 paths here
      against 116 real ones) and could have tripped the index's 25,000-file
      ceiling on a normal project.
- [x] Semantic extraction for seven languages in three tiers: the TypeScript
      compiler API for TS/TSX/JS/JSX (bindings resolved), tree-sitter in the
      Rust sidecar for Python, Go, Rust, C, and C++ (multi-line spans,
      per-language visibility rules, call graph attributed to the enclosing
      function), and the regex fallback for everything else. A missing sidecar
      degrades a tier rather than failing the index.
- [x] Ranking follows the whole call graph, not one hop. `FlatCPG` holds the
      project symbol graph and personalised PageRank seeds on the matched
      symbols, so a function three calls from the match surfaces and a
      disconnected file does not. Persisted between runs through the
      memory-mapped WAL and keyed by canonical project id.
- [~] Full CPG control/data-flow analysis remains deferred: the graph is a
  symbol graph, and there is no type resolution outside TypeScript.
- [x] Ranked line-scoped context selection.
- [x] Broadening/narrowing recovery for poor retrieval.
- [x] Retrieval and agent memory isolation between canonical project roots.
      Files/symbols/edges, sessions/tasks/traces, and agent definitions each
      live in a per-project database keyed by the canonical root, and every
      tool is rooted at the workspace. Agent definitions were the hole: a
      project can ship its own agents under `.agentic/agents`, and those were
      written to the shared global table, so one codebase's private agents
      appeared in the next. Regression-tested by opening two projects against
      one data root. Provider credentials stay global on purpose - a key
      belongs to the machine, not to a codebase.

## 6. Long-Horizon, Multi-Session Tasks

- [x] SQLite persistence package exists.
- [x] Global settings and project-isolated databases.
- [x] Sessions, tasks, events, and context items are persisted.
- [x] Session resume support exists at the persistence level.
- [x] Chat history per codebase, in the IDE sidebar: previous conversations
      listed newest-first with an auto-generated title, relative time, and
      message count; click to reopen the transcript and continue in the same
      session; rename and delete, with delete cascading to that conversation's
      tasks, events, and trace spans. History is project-scoped, so one
      codebase never shows another's conversations.
- [x] Durable orchestration checkpoints in project SQLite.
- [x] `resumeTask()` skips completed stages and is reachable from the IDE: the
      dashboard task list offers Resume on any paused, failed, or pending task
      (`POST /api/tasks/:id/resume`), which continues from the last durable
      checkpoint instead of restarting. Active shell/model calls restart from
      the last durable boundary rather than mid-call.
- [x] Retryable provider failures preserve the live request/checkpoint.

## 7. Manual Context Control

- [x] Add/remove session-scoped file snapshots from active context.
- [x] Add/remove inclusive selected line blocks.
- [x] File/line tags are clickable in the IDE input box: `@` opens a ranked
      workspace file picker (`GET /api/files/lookup`), and picking a file both
      completes the token and pins the file to session context.
- [x] File/line tags are clickable in the IDE output chat: `MessageBody` renders
      every `path` and `path:line[-line]` reference in user, assistant, live, and
      `/bytheway` messages as a button that opens the file and selects the lines.
- [x] Selected editor blocks can be pinned from the composer ("Selection" button)
      and every pinned entry is clickable back to its source lines.
- [x] Isolated `/bytheway` has zero prior context and preserves the main
      transcript, in the TUI and in the IDE composer
      (`POST /api/bytheway`); the answer renders inline without entering
      session context.

## 8. Autonomous Tool Use

- [x] Workspace-safe file read/write/create/delete operations.
- [x] Directory listing and file search.
- [x] Cross-platform native-shell command execution.
- [x] Compile, run, format, and syntax-check tools.
- [x] Approval before mutations and side effects.
- [x] The Rust sidecar (`analyze_code_structure`, `compute_ast_diff`, and
      signature pruning during compaction) is registered in the default tool
      registry, reachable from the IDE, and now bundled into the desktop
      installer via `AGENTIC_RUST_PATH`; it was previously absent from
      packaged builds. A missing sidecar degrades to a tool error rather than
      failing the task.
- [x] Workspace path restrictions and sanitized command environment.
- [x] Web search (`web_search`, keyless via the DuckDuckGo HTML endpoint),
      browsing, and bounded same-domain crawling.
- [x] Git status, diff, log, branches, add, commit, checkout, merge, and push.
      `git_merge` reports conflicted paths as a normal result so the agent can
      resolve them rather than treating a conflict as a crash.
- [~] Git mutations require explicit approval. Package installs are gated by the
  general command approval rather than a dedicated flow that names the packages.

## 9. Style and Project Memory

- [x] Root `AGENTS.md` exists.
- [x] Project workspace and architecture context exists.
- [x] Build, lint, formatting, and testing commands are documented.
- [x] Automatic discovery of nested `AGENTS.md` rules. Every rule file in the
      project is collected nearest-to-root first, each labelled with the subtree
      it governs, skipping generated directories and bounded to 4 levels and 24
      files so a deep tree cannot flood the system prompt.
- [x] Project preferences survive both. `AGENTS.md` is re-read when a session
      opens, so a rule applies to every later conversation; and compaction
      copies the instruction messages into `CompactedTaskState.projectRules`
      (`packages/core/src/agent.ts:1115`), so a rule stated before a compaction
      is still in front of the model after it. This is a direct consequence of
      compacting deterministically: a summarising model could drop a rule, a
      structured fold carries it by construction.

## 10. Human-in-the-Loop Review

- [x] Unified diff generation.
- [x] Mutation previews before approval.
- [x] Whole-operation approval/denial.
- [x] Block-level accept/reject in the IDE. A file-diff approval renders each
      hunk with its own accept/reject toggle plus accept-all and reject-all;
      partial approval applies only the accepted blocks and returns the rejected
      ones to agent context so the task continues around them. Non-diff
      approvals (commands, pushes) keep the plain approve/deny choice.
- [x] Conflict detection prevents stale writes. Every write carries the hash it
      read; a mismatch fails closed rather than overwriting, and `expectedHash:
null` means "this path must not exist", which is what makes save-as report
      a collision instead of clobbering a file.
- [x] Workspace previews emit stable line hunks bound to the expected base hash.
- [x] Runtime/TUI support per-hunk decisions plus accept-all/reject-all.
- [x] Partial application is atomic, stale bases fail closed, and rejected hunks
      are returned to agent context for continuation.

## 11. Observability Dashboard

- [x] Runtime emits and persists task, pipeline-step, plan-expansion, agent,
      model-call, provider-attempt, tool, compaction, and isolated-question
      trace spans, each with one stable parent.
- [x] TUI agent, tool, approval, routing, pipeline, and task events are persisted.
- [x] `AgentRunner` emits a stable model call ID before each request and the
      matching ID on the response, and tool spans carry the model call that
      requested them, so every node has one parent and the hierarchy
      reconstructs exactly after reopening SQLite. Credentials are redacted from
      recorded inputs and outputs.
- [x] Safe progress, routing, and recovery events are persisted and rendered as
      the per-task execution summary.
- [x] Every trace node shows the files and slices that were in its context,
      each with the reason it was selected (exact symbol match, call-graph
      proximity, text hit) and the analyser tier that produced its symbols.
      The pipeline retrieval stage records its selection on its own span while
      the task is still running, so a live task is as inspectable as a
      finished one.
- [x] Tokens and wall-clock time are recorded for every node. Providers report
      usage per model call (Groq, OpenAI-compatible, and Ollama via
      `prompt_eval_count`/`eval_count`); those calls are summed onto their
      agent, their pipeline stage, and the task span, so the dashboard can
      answer "how many tokens and how long did this agent take". Totals are
      also available without walking the trace via `taskSpend(taskId)`, and
      are persisted in task state so a restart resumes the same running total
      instead of granting a fresh budget.
- [x] The React IDE renders task traces as a drill-down hierarchy with recorded
      input, output, context, usage, provider/model, cost, and timing fields,
      and follows a running task live: the dashboard switches to the active task,
      refreshes the hierarchy and spend in place while it runs, and marks itself
      Live. Running and finished are the same view, not two modes.
- [x] Historical trace inspection is available through the GUI server API and
      the Observability workbench.

## Deliverables

- [x] Source repository with full Git history.
- [ ] Submission ZIP including `.git`.
- [~] **Windows installers built and verified** at 125 MB, in
  `packages/desktop/release`: `Agent Zero Setup 0.1.0.exe` (NSIS) and
  `Agent Zero 0.1.0.exe` (portable). Both bundle ripgrep and the release-mode
  Rust sidecar. macOS and Linux build on their own native runners in
  `.github/workflows/release.yml`, which has not been run. Cross-building is
  refused on purpose: both bundled binaries are platform-specific, so a
  cross-built package would ship unusable executables, and
  `prepare-runtime-assets.mjs` fails loudly rather than producing one.
- [x] Setup from scratch on Linux, with a per-provider API-key table
      (README, "Setup from scratch on Linux").
- [x] Architecture documentation with diagrams
      (`docs/ARCHITECTURE_AND_STATUS.md`).
- [x] Tool-calling format and tradeoff documentation.
- [x] `docs/DESIGN_DECISIONS.md`: 37 decisions, each with the alternative tried
      or rejected and the evidence that settled it - including the ones we got
      wrong first - plus a stated known-gaps section.
- [ ] Presentation for a maximum of 10 minutes with at least 2 presenters.

## Verification

- 113 TypeScript tests and 16 Rust tests, run by `pnpm test`, which forces a
  full rebuild first so a green run means the current sources are green.
- ESLint and Prettier clean.
- **Not verified: end-to-end performance.** No real multi-step task has been run
  against a real repository and measured for accuracy, cost, and wall clock.
  That is the largest single scoring component and the biggest open risk.
- **Not verified: the default model IDs.** `MODEL_PARAMETER_CATALOG` is the only
  evidence behind the <=80B constraint, and the Groq, Mistral, and Cerebras
  defaults have not been checked against a live API.

## Remaining work

See `docs/ARCHITECTURE_AND_STATUS.md`, "Remaining work", for the ordered list:
measure end-to-end performance, ground the model parameter catalog, produce the
macOS and Linux installers, widen retrieval past the seven parsed languages, add
type resolution and flow analysis, and move credentials off plaintext at rest.
