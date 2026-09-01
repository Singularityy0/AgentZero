# Design Decisions and Trade-offs

Each entry records a decision we actually made, the alternatives we tried or
rejected, and the evidence that drove the choice. Every claim points at code you
can open. Where a decision was forced by an observed failure, the failure is
described, because the failure is the justification.

> Read this alongside `agent-context/WORKLOG.md`, which is the chronological
> record of what broke and what we changed in response.

---

## 1. Prompt routing: one predicate, not two heuristics

**Decision.** A single predicate, `requestsWorkspaceWork` in
`packages/runtime/src/runtime-service.ts`, decides whether a turn is workspace
work. Both the pipeline check and the chat check consume it.

**Alternative we shipped first, and why it failed.** We had two independent
regex checks: `shouldUsePipeline` and `shouldAnswerWithCode`. A request such as
_"make a calculator in 5 different languages"_ matched the second, which routed
it to a tool-free chat agent. The model printed five code fences into the
transcript and wrote nothing. Worse, the two checks could disagree: `run the
test suite` satisfied both "workspace work" and "casual conversation" at once.

**Why one predicate.** Two independent classifiers over the same input have no
mechanism keeping them consistent. Collapsing them makes contradiction
impossible by construction rather than by care.

**What we gave up.** A user who genuinely wants a snippet pasted into chat has
to phrase it as a question (`what does a debounce look like`) rather than an
instruction. We accepted this: in a coding IDE, the cost of not creating a file
someone wanted is lower than the cost of silently refusing to touch the disk.

**Boundary.** `isExplanationRequest` is the escape hatch — a leading
what/why/how-does/explain with no production or mutation verb stays in chat.

---

## 2. Decomposition: one artifact per agent step

**Decision.** For a multi-artifact request the pipeline builds one coding step
per file (`code-1` … `code-N`), chained, each with a single-file objective and a
mutation budget of one.

**Alternative we tried, and why it failed.** Our first attempt kept a single
coding step and raised its mutation budget from 1 to 5. Local Mistral, asked for
five `create_file` calls in one turn, replied with prose and changed nothing —
`Step "code" failed: The coding model did not call a workspace mutation tool.`

**The lesson, and why it generalises.** Raising a budget is not decomposition.
A small model's reliability falls off sharply with the number of distinct
actions demanded per turn; the fix is fewer actions per turn, not permission for
more. This is the premise of the whole system, and we violated it in our own
orchestrator before we noticed.

**What we gave up.** Wall-clock time. Five sequential generations cannot be
batched. We judged reliability worth more than latency, because the scoring
formula multiplies accuracy but only divides by time.

**Boundary.** A single-artifact request keeps the original `code` step id, so
existing checkpoints and resume behaviour are untouched.

---

## 3. Recovery never deletes work it cannot replace

**Decision.** `rollbackMutation` takes `preserveCreatedFiles`
(`packages/workspace/src/index.ts`), and verifier recovery passes it. Edits to
pre-existing files are still reverted; newly created files are kept.

**The failure that forced it.** A five-file run left four empty directories and
no files. The verifier had fabricated tool calls (`js_verify`, `py_verify` —
none exist) and reported success without executing anything. The runtime
correctly rejected the unproven result, then recovery rolled the workspace back.
Rollback treats a creation as "undo by deleting", so it deleted the only copy of
the generated work and left the empty scaffolding behind.

**Why asymmetric.** Reverting an edit restores something that still exists.
Reverting a creation destroys the only copy. Those are not the same operation
and should not share a policy.

**What we gave up.** A rejected artifact can survive on disk. We consider a
stale file the user can inspect and delete strictly better than silent data
loss, particularly when the run may die mid-recovery.

---

## 4. Verification requires evidence, and never degrades to a weaker model

**Two decisions, one principle: a judgement is only worth the evidence and the
model behind it.**

**Evidence.** A verifier result counts only when a verification tool actually
executed (`VERIFICATION_TOOLS` in the runtime service). Fabricated results fail
fast with `verifier:unverified` and a corrective retry that names the invented
tools back to the model alongside the real ones — rather than triggering a full
rollback-and-replan on no evidence at all.

**Routing.** `ModelRoutePolicy` (`packages/core/src/model.ts`) lets a request
exclude providers. Verifier and Reviewer carry `excludeProviders: ["ollama"]`.

**The failure that forced the routing half.** Route ranking is global, so a Groq
rate-limit cooldown during the coding stages pushed the following verify call
onto `ollama/mistral` — the weakest model in the system checking the strongest
one's work.

**Alternative rejected: fail when the preferred route is cooling down.** Instead
the gateway waits out the shortest cooldown, bounded at 45 s. Provider rate
limits clear in seconds; a judgement step is worth waiting for.

**Deliberate exception.** If filtering would leave zero routes, the original
list is used. A local-only offline configuration must still run. So Mistral can
verify — but only when it is the only thing configured, never as a silent
downgrade.

---

## 5. Truncated output is never written

**Decision.** Two independent guards, because the authoritative signal is not
always present.

1. A response with `finishReason: "length"` carrying tool calls is discarded,
   not executed. The model is told its output was cut off and nothing was
   written, then retried up to twice.
2. `findTruncatedMutation` (`packages/core/src/agent.ts`) rejects any write
   whose content stops mid-structure: unbalanced braces, brackets or
   parentheses, or a missing `</html>`, `</style>`, `</script>`.

**The failure that forced it.** A generated page ended mid-CSS-rule, inside
`#controls`, with no closing brace or tags. Root cause: **no output token limit
was ever sent to any provider**, so a whole file had to fit inside whatever
default the provider chose. `finishReason` was captured from every provider and
never read, so the half-written content went to `create_file` and onto disk
looking finished.

**Why both guards.** `finishReason` is authoritative but absent from a tool call
assembled by our Ollama fallback JSON parser. The structural check works from
content alone. Comments and string literals are stripped before counting
delimiters, so a brace inside a CSS comment or a JS string does not false-positive
— verified against a complete file containing exactly those.

**What we gave up.** A deliberately unbalanced fixture file would be rejected.
We have not hit this; the alternative is writing corrupt files.

---

## 6. Cost is measured from real usage, and enforced

**Decision.** `recordSpend` sums the actual billed cost of every completed model
call; `assertWithinBudget` stops a task at `maxTaskCostUsd` (default 0.5,
matching the evaluation ceiling). Spend is published live as `task_spend` events
with `warning` and `exceeded` levels.

**Alternative rejected: the pre-call estimate.** The gateway already computes an
estimated cost for route ranking. We deliberately do not accumulate that number.
It is computed before the call from a token estimate, and it is the routing
input, not the billed amount. Only post-call usage reflects what was actually
spent.

**Why enforcement lives at the model-call boundary.** It is the only point that
every path — pipeline step, direct agent run, recovery — must pass through.
Enforcing per pipeline step would have missed direct agent runs entirely.

**Trade-off.** Exceeding the budget surfaces as a task failure rather than a
partial answer. A partial answer that has already cost too much is worse than a
clear stop: the evaluation scores an over-budget task as a total failure
regardless of progress, so the system must stop itself first and say why.

---

## 7. Web search without an API key

**Decision.** `web_search` queries the DuckDuckGo HTML endpoint and returns
titles, URLs, and snippets.

**Alternatives rejected.** Brave Search, Serper, and Google CSE all return
better-structured results, and all require their own key and account. That would
add a provider the evaluator must configure before the agent can search at all,
against a problem statement that already mandates a settings screen for the
model providers.

**Trade-off we accept.** We are parsing HTML, so a markup change breaks the
tool. Results are titles and snippets only; the agent follows up with
`browse_url` when it wants the page, which also keeps a search cheap in tokens.

---

## 8. Live workspace updates via a watcher, not polling

**Decision.** A recursive `fs.watch` over the project root
(`packages/gui-server/src/workspace-watcher.ts`), streamed on its own SSE
endpoint, `GET /api/workspace/events`.

**Alternative rejected: refresh on agent mutation events.** We already know when
the agent writes a file, so refreshing the tree from `tool_completed` would have
been less code. It only covers _our_ writes. A `git checkout`, a second editor,
or a build step would leave the tree stale. Watching the filesystem covers every
source uniformly.

**Why a separate stream.** The runtime event stream is session-scoped. The tree
must stay live before any session exists.

**Trade-off.** Recursive watching is unavailable on some platforms and
filesystems (network shares, some Linux configurations). A watch that cannot
start, or that dies when the folder is renamed, degrades to a no-op watcher:
live updates stop, nothing else breaks.

**Dirty-buffer rule.** A changed file reloads its editor tab only when the
buffer is clean. Silently replacing unsaved edits with the agent's version is
the one outcome worse than a stale tree.

---

## 9. Explorer operations are not approval-gated

**Decision.** Agent file mutations require approval. Explorer operations — new,
rename, delete, copy, paste — do not.

**Reasoning.** The approval gate exists so a human authorises actions an agent
took on its own initiative. A human clicking "Delete" in a file tree _is_ that
authorisation; prompting again would be a confirmation dialog wearing the
approval system's clothes, and would train the user to dismiss approvals
reflexively — which is exactly what we need them not to do when the agent asks.

**Where we kept a confirmation.** Recursive directory delete asks, because the
blast radius exceeds what the click communicated.

**Safety is unchanged.** Every operation goes through `resolvePath` and the
symlink guard, so none can escape the workspace. This is enforced by test, not
convention.

---

## 10. Nested `AGENTS.md`, bounded

**Decision.** Every `AGENTS.md` in the project is collected nearest-to-root
first, each labelled with the subtree it governs, skipping generated
directories, bounded to 4 levels and 24 files.

**Why scoped rather than merged.** A monorepo package may contradict the root
("this package uses spaces, not tabs"). Merging them into one block loses the
information that resolves the contradiction. The scope label is what lets the
agent tell which rule governs the file it is editing.

**Why bounded.** An unbounded walk on a large repository would flood the system
prompt with rules, which is a context-budget problem in a system built around
small context windows.

---

## Known gaps

Stated plainly, because an unclaimed gap is cheaper than a claimed feature that
fails under questioning.

- **Local hardware verification (16 GB / 8 GB).** Not implemented. Model
  parameter counts are enforced against `MODEL_PARAMETER_CATALOG`, but that
  catalog has few entries, and models with unknown counts are flagged
  `unverified` rather than blocked — and that flag is not surfaced in any UI.
- **Task resume from the IDE.** `resumeTask` works and is tested, but there is
  no UI affordance to discover and resume an interrupted task.
- **Explorer parity.** No drag-and-drop, multi-select, or nested tree; the
  explorer shows one folder at a time.
- **Cross-platform builds.** Only the Windows build has been produced.
  macOS and Linux packaging is configured but unverified.
