# Takneek PS Implementation Checklist

The TUI is intentionally excluded from this assessment.

Legend: `[x]` done, `[~]` partial, `[ ]` remaining.

## 1. Multi-Agent Orchestration

- [x] Agent loop exists through `AgentRunner`.
- [x] Tool-call repetition detection.
- [x] Step-limit safety handling.
- [x] Multi-step edit, reread, and verification continuation.
- [x] Registry-driven agents and specialist handoff are supported by
      `MultiAgentOrchestrator`.
- [x] The live headless coding path runs a checkpointed planner, retriever,
      coder, verifier, and reviewer pipeline with bounded corrective recovery.
- [x] Attempt/time budgets and repeated-failure safeguards.
- [~] Verifier failure triggers recovery, fresh retrieval, replanning, corrective
  coding, and reverification. Hash-guarded rollback primitives exist, but
  default file tools do not yet forward mutation records into the journal.

## 2. Model and Hosting Constraints

- [x] OpenAI and Ollama provider boundaries exist.
- [x] Local Ollama support exists.
- [~] Provider/model configuration exists through environment variables and
  the settings screen.
- [x] Formal enforcement that every selected model is `<=80B` parameters:
      `ModelRegistry.replace()` drops any model with a _known_ count over
      80B. Partial — the parameter catalog backing this only has 2 real
      entries so far, and models with an _unknown_ count are flagged
      `unverified` rather than blocked (that flag isn't surfaced in any UI
      yet). See `IMPLEMENTATION_PLAN.md` Phase 1.
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

- [~] Provider abstraction exists (Groq, OpenRouter, Ollama, OpenAI-compatible).
- [x] Ordered provider/model route preferences are configurable.
- [~] Routing uses tool need, context fit, cost, preference, and cooldown;
  richer task-complexity classification remains.
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
- [~] Search results are normalized to workspace-relative paths.
- [x] Per-project persistent SQLite code index.
- [x] TypeScript/TSX semantic structure plus mixed-language text fallback.
- [~] Symbols, imports, exports, references, and calls are indexed; full CPG
  control/data-flow analysis remains deferred.
- [x] Ranked line-scoped context selection.
- [x] Broadening/narrowing recovery for poor retrieval.
- [x] Retrieval and memory isolation between canonical project roots.

## 6. Long-Horizon, Multi-Session Tasks

- [x] SQLite persistence package exists.
- [x] Global settings and project-isolated databases.
- [x] Sessions, tasks, events, and context items are persisted.
- [x] Session resume support exists at the persistence level.
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
- [x] Workspace path restrictions and sanitized command environment.
- [x] Web search (`web_search`, keyless via the DuckDuckGo HTML endpoint),
      browsing, and bounded same-domain crawling.
- [x] Git status, diff, log, branches, add, commit, checkout, merge, and push.
      `git_merge` reports conflicted paths as a normal result so the agent can
      resolve them rather than treating a conflict as a crash.
- [~] Git mutations require explicit approval; package-install side effects do
  not yet have a dedicated approval flow.

## 9. Style and Project Memory

- [x] Root `AGENTS.md` exists.
- [x] Project workspace and architecture context exists.
- [x] Build, lint, formatting, and testing commands are documented.
- [~] Agent context is maintained manually.
- [x] Automatic discovery of nested `AGENTS.md` rules. Every rule file in the
      project is collected nearest-to-root first, each labelled with the subtree
      it governs, skipping generated directories and bounded to 4 levels and 24
      files so a deep tree cannot flood the system prompt.
- [ ] Persistence of project preferences across sessions and compaction.

## 10. Human-in-the-Loop Review

- [x] Unified diff generation.
- [x] Mutation previews before approval.
- [x] Whole-operation approval/denial.
- [x] Block-level accept/reject in the IDE. A file-diff approval renders each
      hunk with its own accept/reject toggle plus accept-all and reject-all;
      partial approval applies only the accepted blocks and returns the rejected
      ones to agent context so the task continues around them. Non-diff
      approvals (commands, pushes) keep the plain approve/deny choice.
- [~] Conflict detection prevents stale writes.
- [x] Workspace previews emit stable line hunks bound to the expected base hash.
- [x] Runtime/TUI support per-hunk decisions plus accept-all/reject-all.
- [x] Partial application is atomic, stale bases fail closed, and rejected hunks
      are returned to agent context for continuation.

## 11. Observability Dashboard

- [~] Runtime emits and persists task, pipeline, agent, provider, compaction, and
  isolated-question trace spans.
- [x] TUI agent, tool, approval, routing, pipeline, and task events are persisted.
- [~] The trace schema supports the complete hierarchy, but `AgentRunner` does not
  yet emit model/tool correlation IDs and complete request/response payloads.
- [~] Safe progress and routing/recovery events are persisted.
- [~] Context artifact contracts exist, but tool-message propagation is incomplete.
- [~] Provider timing, route, and available cost are recorded where supplied;
  per-model usage is incomplete in the hierarchy.
- [x] The React IDE renders task traces as a drill-down hierarchy with recorded
      input, output, context, usage, provider/model, cost, and timing fields,
      and follows a running task live: the dashboard switches to the active task,
      refreshes the hierarchy and spend in place while it runs, and marks itself
      Live. Running and finished are the same view, not two modes.
- [x] Historical trace inspection is available through the GUI server API and
      the Observability workbench.

## Deliverables

- [~] Source repository with Git history exists.
- [ ] Submission ZIP including `.git`.
- [~] Windows installers are built and present in `packages/desktop/release`.
  macOS and Linux are configured and wired to CI
  (`.github/workflows/release.yml`, native runner per platform) but have not
  been produced yet. Cross-building from one host is deliberately refused:
  the bundled ripgrep binary is platform-specific and only the host's copy
  is installed, so a cross-built package would ship an unusable binary.
  `prepare-runtime-assets.mjs` now fails loudly instead of producing one.
- [ ] Clean-machine setup documentation.
- [x] Linux setup instructions from scratch with a per-provider API-key table
      (README, "Setup from scratch on Linux").
- [x] Architecture documentation with diagrams.
- [x] Tool-calling format and tradeoff documentation.
- [x] `docs/DESIGN_DECISIONS.md`: ten decisions, each with the alternative
      tried or rejected and the evidence that settled it, including four we got
      wrong first, plus a stated known-gaps section.
- [ ] Presentation plan for a maximum 10-minute presentation with at least 2 presenters.

## Highest-Priority Remaining Work

See [IMPLEMENTATION_PLAN.md](IMPLEMENTATION_PLAN.md) for the ordered,
file-level plan. Summary (Phase 0 - settings screen - is done; Phase 1 -
model/hosting constraints - is mostly done):

1. ~~Mandatory settings screen.~~ Done (Phase 0). The GUI was also rebuilt
   from a static 4-pane mockup into a real editor shell (file explorer,
   Monaco viewer, live status bar) in the same pass - not itself a scored
   requirement, but it's what the settings screen and future manual-context/
   dashboard work (7, 9 below) will build on top of.
2. ~~80B/free-tier enforcement (the hard-block half).~~ Done (Phase 1).
   Remaining: populate `MODEL_PARAMETER_CATALOG` with real entries, surface
   the `unverified` flag in a UI, and add the 16GB/8GB local-hardware
   soft-check.
3. Connect default workspace mutations to verifier rollback.
4. Complete model/tool trace correlation and context propagation.
5. Enforce task cost, parameter verification, and local-hardware constraints.
6. Add task discovery and resume to clients.
7. Add the IDE runtime transport and connect the browser workbench.
8. Connect live runtime events/approvals to the browser and make the existing
   historical observability dashboard update while tasks are running.
9. Verify cross-platform builds and prepare submission materials.
10. Add the thin Tauri packaging layer last.
