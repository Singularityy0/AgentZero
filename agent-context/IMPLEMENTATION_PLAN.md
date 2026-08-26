# Implementation Plan — Closing the Takneek PS Gap

This is the authoritative, session-persistent execution plan for bringing
`agentic-runtime` up to the Takneek "High Prep" problem statement
([Problem_statement.md](../Problem_statement.md)). It is more granular than
[PROBLEM_STATEMENT_CHECKLIST.md](PROBLEM_STATEMENT_CHECKLIST.md)
(requirement-level checklist): this file is ordered, step-by-step, and names
exact files/functions so a new session can pick up mid-phase without
re-deriving context. (A root-level `implementation_plan.md` and `coreplan.md`
previously duplicated this content outside the `AGENTS.md` read chain — they
were removed; their unique content was merged into
[ARCHITECTURE.md](ARCHITECTURE.md) or this file.)

## How to use this file every session

1. Read this file first, then [CURRENT_IMPLEMENTATION.md](CURRENT_IMPLEMENTATION.md)
   for what actually exists.
2. Work phases in order — later phases assume earlier ones landed. Do not skip
   ahead unless the user explicitly redirects.
3. Before starting a phase, re-verify its "Current state" line against the
   code (docs drift; the code is ground truth). Correct this file if it's
   stale.
4. When a step is done: check it `[x]`, and if it changes user-facing
   behavior, update [CURRENT_IMPLEMENTATION.md](CURRENT_IMPLEMENTATION.md) and
   [PROBLEM_STATEMENT_CHECKLIST.md](PROBLEM_STATEMENT_CHECKLIST.md) in the same
   commit.
5. Never remove a completed step's checkbox history — this file is the trail
   of what happened and why, not just a TODO list.
6. Run `pnpm build && pnpm test && pnpm lint && pnpm format:check` before
   considering any phase's steps done.

## Snapshot at time of writing (2026-08-26)

Verified by direct code inspection, not just docs:

- Gateway (`packages/gateway/src/index.ts`) has real provider adapters (Groq,
  OpenRouter, Ollama, OpenAI-compatible) but `select()` is manual — no
  complexity/cost-aware routing, no failover, no `reason`/`estimatedCost` on
  `GatewayEvent`.
- 80B parameter cap and 16GB/8GB local-hardware constraint exist only in
  comments/docs, enforced nowhere in code
  (`packages/gateway/src/index.ts:497-499`).
- GUI settings screen (`packages/gui/src/main.ts`) is a localStorage scaffold
  for 3 hardcoded providers, **not wired to the gateway's
  `CredentialResolver`**. This is the disqualifying requirement — treat Phase
  0 as blocking.
- No context compaction exists anywhere in `packages/core/src`.
- Retrieval is ripgrep/keyword only (`packages/search`, `find_files`,
  `search_text`) — no index, no ranking, no structural understanding.
- `TaskOrchestrator` (retry/budget/checkpoint engine) exists in
  `packages/core/src/orchestrator.ts` but is not the TUI's live execution
  path; `MultiAgentOrchestrator` is used directly instead.
- HITL review is whole-diff approve/deny only, no block-level accept/reject.
- No observability dashboard exists (grep for `dashboard|tracing` hits docs
  only).
- No manual context control UI, no clickable file/line tags, no `/bytheway`.
- Tool autonomy (file/shell/web/Git) and approval gating are solid and mostly
  meet the bar already.

## Priority ordering and rationale

Ordered by (a) disqualification risk, (b) evaluation weight
(Core Agentic Architecture is 36%: routing 5, compaction 5, retrieval 12,
orchestration 14), (c) dependency order (routing/compaction need gateway
events; dashboard needs the event stream those phases produce).

---

## Phase 0 — Settings screen must actually work (blocking, disqualifying if skipped)

**PS requirement:** 3d. **Current state:** cosmetic scaffold, not connected to
runtime.

- [ ] Define a `SettingsService` in `packages/session` (or a new
      `packages/settings` if it doesn't belong in session's scope) that reads
      and writes provider credentials to the **global SQLite** database
      (`packages/session` already separates global vs. project scope — reuse
      that split).
- [ ] Add a `SqliteCredentialResolver implements CredentialResolver` in
      `packages/gateway` (alongside `EnvironmentCredentialResolver` in
      `packages/gateway/src/index.ts:72`) that reads from the settings
      service instead of `process.env`.
- [ ] Wire `createDefaultProviderGateway()` (`packages/gateway/src/index.ts:480`)
      to accept the SQLite resolver when running under the GUI/TUI, falling
      back to env vars only for local dev/examples.
- [ ] Rebuild `packages/gui/src/main.ts` to call the real settings service
      (via IPC if Tauri, via a local HTTP/service bridge otherwise — confirm
      which shell `packages/gui` targets before choosing; `tauri.svg` asset
      suggests Tauri) instead of `localStorage`.
- [ ] Support all providers the gateway registers (Groq, OpenRouter, Ollama,
      OpenAI-compatible/local) in the settings form, not just 3 hardcoded
      ones.
- [ ] Add credential validation in the UI: call `ProviderGateway.validate()`
      on save and surface pass/fail per provider.
- [ ] Add a TUI equivalent (`/settings` command or a startup prompt) so the
      terminal client can also configure keys without editing `.env` — the
      evaluators need to be able to test via whichever client is running.
- [ ] Remove/replace the "simulated via local storage" and "Uncomment when
      ready" comments in `main.ts` once this is real.

**Acceptance:** entering a key in the settings UI, restarting the app, and
running a task actually uses that key end-to-end with no `.env` involvement.

---

## Phase 1 — Enforce model/hosting constraints

**PS requirement:** 2. **Current state:** unenforced.

- [ ] Add a `totalParameters?: number` field to `ModelInfo`
      (`packages/gateway/src/index.ts:9`).
- [ ] Build a static catalog override table (JSON or TS const) mapping known
      model IDs (Groq/OpenRouter/Ollama model names) to their published total
      parameter count, since provider APIs don't expose this reliably (see
      the existing comment at `packages/gateway/src/index.ts:497`).
- [ ] In `ModelRegistry.replace()` / the `normalize*Model()` functions, drop
      or flag models with unknown or >80B total parameters. Unknown-parameter
      models should be visibly flagged "unverified" in the UI rather than
      silently allowed.
- [ ] Reject paid-subscription-only providers at the `ProviderAdapter`
      registration level — document per-provider why each one qualifies as
      free-tier/pay-as-you-go in `packages/gateway/README.md` (create if
      missing).
- [ ] For local models (Ollama), add a soft-check: read `ollama show <model>`
      output or the catalog override table to warn if a model is unlikely to
      fit 16GB RAM / 8GB VRAM (quantization + parameter count heuristic).
      Document the heuristic's limits — this can't be perfectly verified
      from software alone.
- [ ] Add a unit test asserting an >80B or unknown model is excluded from
      `discover()` results by default.

**Acceptance:** `ModelRegistry.list()` never returns a disqualified model
without an explicit override flag the user had to set knowingly.

---

## Phase 2 — Smart routing, visible reasoning, and failover

**PS requirement:** 3a-3c. **Eval weight:** 5%. **Current state:** manual
`select()` only.

- [ ] Extend `GatewayEvent` (`packages/gateway/src/index.ts:50`) with
      `reason: string` and `estimatedCost?: number` fields, matching the
      shape already sketched in `ARCHITECTURE.md ("Target routing behavior")`.
- [ ] Build a `RoutingPolicy` module in `packages/gateway` that takes signals
      — task/step complexity hint from the calling agent, estimated context
      tokens, tokens already used this task, known provider rate-limit state
      — and returns a ranked list of acceptable `(providerId, modelId)`
      routes with a human-readable `reason` per candidate.
- [ ] Add a minimal complexity signal from the orchestrator: tag each agent
      step (e.g., `planner`/`retriever` = low complexity, `coder` on a large
      diff = high) so routing has something real to key off, per
      ARCHITECTURE.md's "Target multi-agent pipeline" (planner/retriever/
      coder/verifier/reviewer).
- [ ] Implement `ProviderGateway.routeWithPolicy(step)` that calls
      `RoutingPolicy`, tries the top candidate, and on failure (timeout, rate
      limit, 5xx) automatically retries the next candidate **without losing
      the task checkpoint** — reuse `createTaskCheckpointStore`
      (`packages/session`) so a failed call resumes from the last checkpoint,
      not from scratch.
- [ ] Surface routing events live in both TUI (`packages/tui/src/app.tsx`,
      alongside the existing approval/event handling around line 54-92) and
      GUI as they happen — this satisfies "can never be hidden" (3b)
      directly, not just in a log file.
- [ ] Persist routing decisions as task events in SQLite so the dashboard
      (Phase 6) can replay them later.
- [ ] Add tests: complexity-based route selection, failover on simulated
      provider error, checkpoint preserved across failover.

**Acceptance:** killing/rate-limiting the primary provider mid-task causes a
visible fallback and the task finishes without repeating already-completed
steps.

---

## Phase 3 — Automatic context compaction

**PS requirement:** 4. **Eval weight:** 5%. **Current state:** none.

- [ ] Add token accounting to `AgentRunner` (`packages/core/src/agent.ts`):
      track cumulative input/output tokens per run using each model's
      reported usage (or an estimate if the provider doesn't report it).
- [ ] Add a `contextWindow` lookup from the selected `ModelInfo`
      (`packages/gateway`) so the runner knows the budget it's compacting
      against.
- [ ] Implement a `ContextCompactor` in `packages/core` that triggers at 75%
      of context window **or** immediately on a provider context-limit error
      response, and produces a compact state containing: original objective,
      current plan/completed steps, accepted/rejected approaches, key tool
      outputs, active file slices with line refs, `AGENTS.md` rules, and open
      questions — this exact structure is already specified in
      ARCHITECTURE.md ("Target compaction design"), implement it as written.
- [ ] Replace old conversation turns with the compacted state in the message
      history sent to the model, keeping the compacted summary itself in
      project SQLite (`packages/session`) so it survives process restarts.
- [ ] Support repeated compaction within one task (compact the compacted
      state again if needed) — test this explicitly, it's called out in the
      rubric (2b.ii).
- [ ] Add a regression test: seed a fact early in a long fake conversation,
      force compaction, and assert a later turn still has access to that
      fact.

**Acceptance:** a deliberately long synthetic task compacts automatically,
never hits a hard context-limit crash, and a fact from turn 1 is still
correctly used at turn 50.

---

## Phase 4 — Code retrieval pipeline

**PS requirement:** 5. **Eval weight:** 12% (highest single sub-score).
**Current state:** ripgrep keyword search only.

- [ ] Add a `packages/index` (or extend `packages/search`) package that
      builds a per-project SQLite index, keyed the same way project sessions
      already are (canonical project root hash — reuse the pattern from
      `packages/session`) so indexes never leak across projects (PS 5b, a
      hard requirement).
- [ ] Use the TypeScript Compiler API to extract symbols, imports, exports,
      definitions, references, and line spans for `.ts`/`.tsx` files (as
      ARCHITECTURE.md's "Target retrieval design" specifies). Store file hash
      so re-indexing only touches changed files.
- [ ] Fall back to ripgrep-based indexing (filename + text match) for
      non-TypeScript files so the pipeline still works on mixed-language
      repos.
- [ ] Implement a ranking function combining: symbol name match, import-graph
      distance from files already in context, prompt term overlap, recently
      edited files, and failing-test/diagnostic locations.
- [ ] Return compact slices (file + line range + short surrounding context),
      never whole files, as the retrieval tool's output — this is explicitly
      graded (2c.i).
- [ ] Add a retrieval-quality check: if a query returns zero or a huge number
      of matches, broaden or narrow automatically and log that it did so
      (satisfies 2c.iv — "detect and recover from poor retrieval").
- [ ] Wire this as the `retriever` role's primary tool in the orchestration
      pipeline (ties into Phase 5).
- [ ] Document in the README why TS-compiler-API + ripgrep was chosen over
      vector embeddings (the rubric explicitly rewards a justified,
      non-default choice — 2c.v, and Guideline 3 in
      `Problem_statement.md:251` penalizes unexplained default choices).

**Acceptance:** a multi-file query returns ranked, line-scoped slices, not
raw file dumps; re-opening the same project reuses the persisted index
instead of rebuilding from scratch.

---

## Phase 5 — Orchestration: planning, verification, backtracking

**PS requirement:** 1, eval category 2d. **Eval weight:** 14%. **Current
state:** handoff-based delegation works; no planner, no backtracking, no
self-verification gate.

- [ ] Promote `TaskOrchestrator` (`packages/core/src/orchestrator.ts`) to be
      the TUI/GUI's actual execution path for multi-step requests, replacing
      direct `MultiAgentOrchestrator` calls at the top level (keep
      `MultiAgentOrchestrator`'s handoff mechanism as the tool `TaskOrchestrator`
      steps use internally — they're complementary, not competing).
- [ ] Add a `planner` step that turns the user request into small, testable
      sub-tasks before any coding starts, per the pipeline already named in
      ARCHITECTURE.md's "Target multi-agent pipeline" (planner → retriever →
      coder → verifier → reviewer).
- [ ] Add a `verifier` step that runs before a task is marked complete: run
      relevant tests/build/lint and require a pass (or an explicit,
      surfaced failure) before finalizing — satisfies 2d.vi.
- [ ] Add backtracking: when `verifier` fails or a failure fingerprint repeats
      (the repeated-failure detection already exists per
      `CURRENT_IMPLEMENTATION.md:38-39`), let the orchestrator discard the
      last step's changes and re-plan instead of only retrying the same
      action — satisfies 2d.v.
- [ ] Ensure parallel-safe steps (read-only planning/retrieval) can run
      concurrently while mutation stays serialized, per the trade-off already
      recorded in ARCHITECTURE.md's "Trade-offs" table. Don't parallelize
      edits — that's an intentional, defensible constraint, keep it and
      document why.
- [ ] Add tests for: stuck-task detection triggering a stop/step-in instead of
      infinite retry, backtracking after a verifier failure, and no
      conflicting concurrent edits.

**Acceptance:** an injected failing test causes the system to diagnose,
backtrack, and retry with a different approach rather than repeating the
identical failed edit.

---

## Phase 6 — Block-level HITL review

**PS requirement:** 10. **Eval weight:** 3%. **Current state:** whole-diff
approve/deny only.

- [ ] Extend `packages/workspace`'s diff generation to produce addressable
      hunks/blocks (unified diff already exists — parse it into blocks with
      stable IDs rather than one opaque string).
- [ ] Add per-block accept/reject to the approval flow in
      `packages/tui/src/app.tsx` (`ApprovalPanel`, around line 434) and the
      GUI diff view, plus "accept all"/"reject all" shortcuts.
- [ ] On partial approval, apply only the accepted blocks and feed the agent
      the rejected blocks as explicit context so it can continue the rest of
      the task working around them, instead of erroring out or reapplying
      rejected changes.
- [ ] Add a test: reject one block of a multi-block patch, assert the file
      only contains the accepted blocks, and assert the agent's next step
      references the rejected portion correctly.

**Acceptance:** a multi-hunk diff can be partially approved and the task
finishes correctly around the rejected hunk.

---

## Phase 7 — Manual context control + `/bytheway`

**PS requirement:** 7. **Eval weight:** 6%. **Current state:** none.

- [ ] Add explicit add/remove-from-context actions in the TUI (a command like
      `/context add <file>[:<line-range>]` / `/context remove <file>`) backed
      by the existing project context-items table in `packages/session`.
- [ ] Add clickable file/line tags: parse `path:line` or `path:line-range`
      tokens in both user input and agent output text, render them as
      clickable in the GUI, and make the TUI equivalent (e.g., a keybind to
      jump/insert) functional.
- [ ] Implement `/bytheway <question>` as a one-off `AgentRunner` invocation
      with an empty message history and no injected task context, using the
      same model/provider as the active session, then discard that
      sub-conversation and resume the original context exactly as it was —
      this should be a thin wrapper, not a new orchestrator mode.
- [ ] Add a test: run `/bytheway`, assert it has zero access to prior
      context, then assert the next normal message still has full prior
      context intact.

**Acceptance:** `/bytheway` answers in isolation and the main conversation is
unaffected afterward.

---

## Phase 8 — Observability dashboard

**PS requirement:** 11. **Eval weight:** 8%. **Current state:** none (event
persistence exists in `packages/session`, no UI consumes it as a hierarchy).

- [ ] Confirm/extend the session event schema so every agent/tool
      call records: parent call ID (for hierarchy), exact input, exact
      output, token usage, start/end timestamps, and route (from Phase 2's
      routing events).
- [ ] Build a dashboard view in `packages/gui` that renders the call
      hierarchy as a tree, using persisted events for finished tasks and a
      live subscription (poll or event stream) for running ones — same view,
      no mode switch, per rubric 4a.ii.
- [ ] Add drill-down: clicking a node shows its exact input/output, context
      files/slices at that point, and token/time cost.
- [ ] Add a lightweight "thought process" surface: stream the model's
      intermediate reasoning/tool-call rationale into the same event log so
      it's visible live and after the fact (rubric 11b.iii).
- [ ] Add a TUI-side minimal equivalent (a `/trace <taskId>` command) so the
      terminal client isn't second-class for this requirement.

**Acceptance:** for any completed or in-progress task, every agent/tool node
is inspectable with real input/output/timing, live and after completion,
without switching views.

---

## Phase 9 — Documentation and deliverables

**PS requirement:** Deliverables section + eval category 5 (15%).

- [ ] Rewrite the README to match actual shipped architecture (not the
      aspirational one) with a system diagram, the multi-agent pipeline
      diagram, and the tool-calling format used, each with an explicit
      trade-off rationale — the rubric explicitly penalizes
      unexplained/default-following choices (5a.ii) and AI-sounding
      explanations nobody on the team can defend (Guideline 3).
- [ ] Write from-scratch Linux setup instructions including API key setup for
      every provider actually supported.
- [ ] Verify and document cross-platform builds (Windows/macOS/Linux) with
      exact run steps on a clean machine.
- [ ] Update [PROBLEM_STATEMENT_CHECKLIST.md](PROBLEM_STATEMENT_CHECKLIST.md)
      to reflect true status after each phase above (it currently understates
      the gateway's progress and will drift further as phases land — keep it
      honest, not aspirational).
- [ ] Prepare the package/zip with full `.git` history per deliverable 1.
- [ ] Prep presentation: assign at least 2 presenters, rehearse answering
      "why" for every architectural choice — per Guideline 1, an unexplained
      feature during Q&A is scored as if it doesn't exist at all, and
      Guideline 5 means Y26 members specifically need to be able to answer
      implementation-level questions, not just talking points.

---

## Cross-cutting rules (apply to every phase)

- Never weaken the existing approval gate — every side-effecting tool call
  stays human-approved, no phase above should introduce an unapproved
  mutation path.
- Keep `packages/core` provider- and framework-neutral; new logic (routing
  policy, compaction, retrieval ranking) belongs in `gateway`/`core`/new
  packages, not leaking provider-specific code upward.
- Every new package/module gets tests in the same PR that introduces it —
  don't defer test coverage to a later phase.
- Prefer extending existing packages (`gateway`, `session`, `core`,
  `workspace`) over new ones unless responsibility genuinely doesn't fit
  anywhere existing, consistent with the boundary rules in
  [ARCHITECTURE.md](ARCHITECTURE.md).
