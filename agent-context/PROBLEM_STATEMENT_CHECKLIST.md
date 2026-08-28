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
- [~] Dependency-ordered task planning and bounded retry recovery exist.
- [x] Attempt/time budgets and repeated-failure safeguards.
- [~] Delegation is supported; model-driven planning, disagreement handling,
  and replanning remain.

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
- [ ] Verification that local models run within `16GB RAM / 8GB VRAM`.
- [x] Provider eligibility enforcement: `ProviderRegistry.register()` rejects
      any provider ID not on the explicit free-tier/pay-as-you-go/local
      allowlist. Cost enforcement (tracking $ spent against the PS's $0.5
      per-task ceiling) is not implemented.

## 3. Smart Routing

- [~] Provider abstraction exists (Groq, OpenRouter, Ollama, OpenAI-compatible).
- [~] Provider selection exists, but only as configuration.
- [ ] Complexity-aware model routing.
- [ ] Context-size, token-budget, rate-limit, and cost-aware routing.
- [ ] Transparent routing explanations.
- [ ] Automatic fallback while preserving progress.
- [x] Mandatory settings screen for provider API keys. Both TUI (`/settings`)
      and GUI (`pnpm settings`) read/write the same global-SQLite-backed
      credentials via `StoredCredentialResolver`; validated end-to-end with a
      live smoke test against the real Groq API. Known gap: keys are stored
      plaintext-at-rest (no OS keychain integration).

## 4. Automatic Context Compaction

- [~] Automatic context-size monitoring uses character count, not model tokens.
- [~] A fixed 20,000-character trigger exists; model-window-aware policy remains.
- [~] Older messages are summarized, but retention guarantees are not tested.
- [ ] Repeated compaction support.
- [ ] Recovery from provider context-limit errors.

## 5. Code Retrieval Pipeline

- [x] Workspace-isolated filesystem access.
- [x] Ripgrep-backed text and file search.
- [~] Search results are normalized to workspace-relative paths.
- [ ] Per-project persistent code index.
- [ ] Semantic/structural retrieval beyond keyword search.
- [ ] Symbol, dependency, and execution-flow understanding.
- [ ] Context selection and relevance ranking.
- [ ] Retrieval quality detection and recovery.
- [ ] Retrieval-memory isolation between projects.

## 6. Long-Horizon, Multi-Session Tasks

- [x] SQLite persistence package exists.
- [x] Global settings and project-isolated databases.
- [x] Sessions, tasks, events, and context items are persisted.
- [x] Session resume support exists at the persistence level.
- [ ] Durable orchestration checkpoints.
- [ ] Exact resume of interrupted multi-agent tasks.
- [ ] Recovery after crashes, timeouts, or provider failures.

## 7. Manual Context Control

- [ ] Add/remove files from active context.
- [ ] Add/remove selected code blocks.
- [ ] Clickable file tags in user input.
- [ ] Clickable file/line tags in agent output.
- [ ] Isolated `/bytheway` command with context restoration.

## 8. Autonomous Tool Use

- [x] Workspace-safe file read/write/create/delete operations.
- [x] Directory listing and file search.
- [x] Cross-platform native-shell command execution.
- [x] Compile, run, format, and syntax-check tools.
- [x] Approval before mutations and side effects.
- [x] Workspace path restrictions and sanitized command environment.
- [~] Web browsing and bounded same-domain crawling exist; a search-engine tool
  remains.
- [~] Git branch, commit, diff, and related operations exist; merge tooling
  remains.
- [~] Git mutations require explicit approval; package-install side effects do
  not yet have a dedicated approval flow.

## 9. Style and Project Memory

- [x] Root `AGENTS.md` exists.
- [x] Project workspace and architecture context exists.
- [x] Build, lint, formatting, and testing commands are documented.
- [~] Agent context is maintained manually.
- [ ] Automatic discovery and application of nested `AGENTS.md` rules.
- [ ] Persistence of project preferences across sessions and compaction.

## 10. Human-in-the-Loop Review

- [x] Unified diff generation.
- [x] Mutation previews before approval.
- [x] Whole-operation approval/denial.
- [~] Conflict detection prevents stale writes.
- [~] Rust emits addressable line hunks and can apply selected hunks; approval UI
  and runtime contracts are not wired to per-hunk decisions.
- [ ] Accept-all and reject-all review actions.
- [ ] Correct continuation after partial approval or rejection.

## 11. Observability Dashboard

- [~] Runtime event structures are being introduced.
- [x] TUI agent, tool, approval, and task lifecycle events are persisted.
- [ ] Full agent/tool call hierarchy.
- [ ] Drill-down into exact inputs and outputs.
- [ ] Thought/process visibility or suitable progress trace.
- [ ] Exact context files and code chunks per agent.
- [ ] Per-agent token and timing metrics.
- [ ] Live task dashboard.
- [ ] Historical task inspection.

## Deliverables

- [~] Source repository with Git history exists.
- [ ] Submission ZIP including `.git`.
- [ ] Verified Windows, macOS, and Linux builds.
- [ ] Clean-machine setup documentation.
- [ ] Linux setup instructions with provider API-key setup.
- [ ] Architecture documentation with diagrams.
- [ ] Tool-calling format and tradeoff documentation.
- [ ] Comparison of alternative architectural approaches.
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
3. Smart routing signals, visible reasoning, and provider fallback (Phase 2).
4. Context compaction (Phase 3).
5. Code indexing and high-quality retrieval (Phase 4).
6. Multi-agent orchestration with planning, verification, and backtracking
   (Phase 5).
7. Block-level HITL review (Phase 6).
8. Manual context control and `/bytheway` (Phase 7).
9. Observability dashboard (Phase 8).
10. Documentation, cross-platform builds, and presentation prep (Phase 9).
