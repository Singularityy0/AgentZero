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

## 3. Decomposition for existing codebases: the planner decides the shape

**Decision.** For work on an existing codebase the Planner, not a regex, decides
how many coding steps there are. Its reply may end with a fenced `subtasks`
block; when it does, `TaskOrchestrator` replaces the placeholder `code` step
with one step per sub-task and rewires the dependencies around it
(`applyExpansion` in `packages/core/src/orchestrator.ts`).

**Alternative we shipped first, and why it was wrong.** Decision 2 above solved
decomposition for _greenfield_ requests, by counting artifacts out of the prompt
with `requestedArtifactCount` — "five different languages" gives five steps.
That works for the phrasing it was written for and does nothing for anything
else. Every real repository task — fix this bug, add this field, migrate these
callers — matched none of the patterns and got exactly one Coder step. We had
built decomposition for the easy case and left the hard case with a single shot,
which is the opposite of what the problem demands.

**Why the planner and not a better regex.** How a task splits is a property of
the code, not of the sentence. "Add rate limiting to the API" is one step or
four depending on how many call sites exist, and only something that has read
the objective and the retrieved evidence can tell. No amount of prompt-pattern
work recovers that.

**What we gave up, and the guard rails.** A small model producing structured
output is unreliable, so an unusable decomposition must cost nothing. Parsing
fails closed: a missing block, malformed JSON, a single-entry list, or entries
without prompts all yield no expansion and the original single step runs. The
orchestrator independently validates the rewrite and drops it silently if it
would break the plan, rather than failing the task. And the split is capped at
four, because each extra step is another model call — the Planner is told
explicitly not to split work that touches one file.

**Boundary.** Expansions are persisted in the orchestration state and replayed
on resume, so an interrupted decomposed run continues on the same step list
rather than rejecting `code-2` as an unknown step.

---

## 4. Compaction summarises without calling a model

**Decision.** Compaction is deterministic. `compactOldestExchanges` in
`packages/core/src/agent.ts` folds the oldest exchanges into a structured
`CompactedTaskState` — objective, plan, completed work, failures, changed files
with hashes, verification status, retrieved slices, project rules, open
questions — by bucketing message content, and never calls a model to do it.

**Alternative we rejected.** The common approach is to ask an LLM to summarise
the transcript. We rejected it on two grounds. First, cost: compaction fires
exactly when the context is largest, so an LLM summarisation is the single most
expensive call in the task, repeated on every compaction event, and cost enters
the score with the heavier weight. Second, and more important, correctness: a
summarising model can hallucinate. A summary that says a test passed when it
failed, or drops the one file hash the verifier needs, poisons everything
downstream — and the requirement is explicitly that information "must not be
lost or misremembered". A deterministic fold cannot misremember. It can only
drop, and what it drops is bounded and known.

**What we gave up.** Prose quality. The compacted state is structured fields of
bounded, truncated raw text, not a fluent narrative, and a model reading it gets
less connective tissue than a good summary would give. We accepted that: the
fields that decide correctness — changed files and their hashes, verification
outcomes, project rules — are carried exactly, and those are what later stages
actually consult.

**Boundary.** Compaction runs in bounded passes, stops as soon as a pass fails
to shrink the request, keeps the most recent exchanges and the last user message
uncompacted, and is entered a second way — on a provider context-limit error —
with a tighter target ratio.

---

## 5. Recovery never deletes work it cannot replace

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

## 6. Verification requires evidence, and never degrades to a weaker model

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

## 7. Truncated output is never written

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

## 8. Cost is measured from real usage, and enforced

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

## 9. Web search without an API key

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

## 10. Live workspace updates via a watcher, not polling

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

## 11. Explorer operations are not approval-gated

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

## 12. Nested `AGENTS.md`, bounded

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

## 13. Route order is a per-stage decision, not one global preference list

**Decision.** Every model request may carry a `ModelRoutePolicy` with a `bias`.
`capacity` sorts eligible routes by largest known parameter count, `economy` by
lowest estimated cost, `balanced` keeps the operator's configured order.
`routePolicyForStage` in `packages/runtime/src/runtime-service.ts` assigns one
per stage and task complexity.

**Alternative we shipped first, and why it was insufficient.** We had a single
ordered preference list for the whole system, with one exception bolted on:
verification and review excluded the local provider (decision 6). That handles
"never judge with something weaker" but not "don't spend the strongest model on
mechanical work". Retrieval summarisation and a hard refactor were routed
identically.

**Why complexity is classified syntactically, not by a model.** A classifier
that costs a round trip to save a round trip is a bad trade at this scale, and
the classification only reorders models that are all already eligible, so being
wrong is cheap. `classifyTaskComplexity` reads prompt length, how many concrete
file paths are named, conjunction count, and multi-step vocabulary.

**The asymmetry that set the threshold.** Routing a hard task down costs
accuracy, which the scoring formula multiplies by ten. Routing an easy task up
costs a fraction of a cent. So `simple` is deliberately narrow — a short request
naming no file at all. Our first threshold classified "Add a retry to
src/client.ts when the request times out" as simple; a request pointing at
concrete code is not trivial, and it now stays on the configured route.

**Boundary.** Bias never overrides eligibility — a route that lacks tool support
or cannot fit the context is last regardless. A `minContextWindow` floor is a
preference too: if nothing clears it, ranking repeats without it rather than
failing a task a smaller window could have completed. And `capacity` treats an
unknown parameter count as zero, so a model is only promoted above the
operator's order on evidence that it is bigger.

---

## 14. Ignore rules belong at discovery, not after it

**Decision.** `findFiles` and `searchText` in `packages/search/src/index.ts`
pass explicit `!**/node_modules/**`-style exclusions to ripgrep, and the
wildcard case passes no positive `--glob` at all.

**The bug this fixed.** `findFiles` called `rg --files --glob "*"`. In ripgrep a
positive `--glob` is an _override_, and overrides take precedence over
`.gitignore`. The wildcard therefore disabled every ignore file. On this
repository that turned a 116-file listing into a 40,000-file one. The filtering
still happened — `shouldIgnore` dropped the dependency paths afterwards — so
nothing looked broken, which is why it survived so long. What it cost was paid
everywhere else: every retrieval pass walked `node_modules`, the `find_files`
tool handed dependency paths back to agents as context, and a normal project
would have tripped the index's own 25,000-file ceiling and failed retrieval
outright.

**Why exclusions and not just dropping the glob.** Dropping the wildcard glob
restores `.gitignore`, but a user can open any folder as a codebase, including
one with no `.gitignore` at all, and a caller-supplied pattern like `*.js`
reintroduces the same override. Explicit exclusions hold in both cases.

**Measured effect.** Project discovery went from 21,653 paths to 116. A warm
index pass — which runs on essentially every retrieval query — went from roughly
750 ms to 131 ms, together with the stat-gated incremental check in decision 15.

---

## 15. Incremental indexing trusts `stat` before it trusts a hash

**Decision.** `indexProject` skips reading a file entirely when its size and
mtime both match what was indexed. Only a stat mismatch triggers a read and
hash, and only a hash mismatch triggers re-extraction.

**What it replaced.** The previous pass read and hashed every file on every
call, using the content hash as the sole change signal. That is the most
_correct_ possible check, and `query()` refreshes the index by default, so it
ran on nearly every retrieval.

**Why the weaker check is the right one here.** Size-and-mtime can theoretically
miss a change; in this system it cannot miss the changes that matter, because
every write the agent makes moves mtime. The residual risk is an external tool
rewriting a file to the same byte length while preserving mtime. We took that
trade for a 5-6x cut in the cost of the most frequent operation in the pipeline.

**Boundary.** The middle tier exists for exactly the case that would otherwise
churn: a file touched but not changed — a rebuild, a checkout, a formatter
writing identical bytes — is read once, found identical, and has its new stat
recorded so the next pass takes the fast path instead of re-reading forever.

---

## 16. Agent definitions are per-project, because they are project memory

**Decision.** The `agents` table lives in the project database, not the global
one. The global database keeps only what belongs to the machine: settings,
provider base URLs, and credentials.

**The bug this fixed.** A project can ship its own agents under
`.agentic/agents/*.md`, and `registerAgents` wrote them into the shared global
table on open. Opening project A and then project B therefore left A's private
agents listed and selectable in B. We confirmed it before fixing it: two
temporary projects against one data root, and `alpha-internal` appeared in
beta's agent list. That is a direct violation of the requirement that agent
memory must not cross projects.

**Why the table moved rather than gaining a `project_id` column.** A column
would have worked, but it makes isolation a property of every query remembering
to filter — one forgotten `WHERE` reopens the hole. Separate database files make
it structural: there is no shared table left to leak from. Sessions, tasks, and
traces were already isolated this way, so agents now match them.

**What we gave up.** An agent created purely through the UI in one project is
not visible in another, and the pre-existing global table is dropped on first
open. In practice nothing is lost: built-in agents and `.agentic/agents` files
are re-registered from source on every open, so both self-heal.

**Boundary.** Credentials stay global on purpose. An API key belongs to the
machine, not to a codebase, and copying keys per project would multiply the
plaintext-at-rest surface for no benefit.

---

## 17. The chat agent only answers what the project cannot change

**Decision.** A prompt reaches the tool-free chat agent only when it is neither
workspace work nor a reference to the opened project. A question _about_ the
project falls through to the Architect, which has read-only tools and the
session context but no mutation tools.

**The bug this fixed.** `shouldUseConversationAgent` was the negation of
`requestsWorkspaceWork`, and `requestsWorkspaceWork` returns false for anything
shaped as a question. So "what files are in this repo" went to an agent with no
tools and no context, which can only invent an answer. "What is a closure"
correctly went to the same place. The two are not the same question.

**Why not send it to the pipeline instead.** It needs no mutation, so planning,
coding, verification, and review would all be wasted model calls on a question
that one `list_directory` answers. The Architect path is the middle rung that
already existed; the classifier just never reached it.

**Boundary.** This is the fourth branch of task routing, after verification-only
and the pipeline. No branch lets a general question reach the Coder: reaching a
mutation-capable agent requires an artifact request, a workspace reference, or a
bare action verb, and a question satisfies none of them.

---

## 18. The Rust sidecar ships with the app, and is optional at runtime

**Decision.** `prepare-runtime-assets.mjs` copies the sidecar binary beside
ripgrep, the desktop main process points `AGENTIC_RUST_PATH` at it, and
`RustClient` falls back to `rust/target/release` then `rust/target/debug` in a
source checkout.

**The bug this fixed.** The binary path was hard-coded to `target/debug`, and
only ripgrep was bundled. In a source checkout a release build was never found;
in a packaged app there is no `rust/target` tree at all, so the installer
shipped without the sidecar entirely. That silently removed
`analyze_code_structure`, `compute_ast_diff`, and the signature-pruning half of
compaction from the product we would have handed over — with no error, because
every caller already degrades quietly.

**Why ripgrep is fatal when missing and Rust is not.** Ripgrep backs all file
and text discovery; without it retrieval returns nothing and the system is
broken, so its absence throws at startup. The sidecar accelerates and sharpens
work that has a working fallback: the two tools return a tool error the model
can read, and compaction keeps its structured-exchange path. Treating them the
same would turn a degraded feature into a dead application.

**What the fix also caught.** The child process and its three pipes each hold a
handle on the Node event loop, so an idle sidecar kept the host alive — a
finished run hung instead of exiting. All four are now unreferenced, and
`stopRustEngine()` runs when the server closes so the helper does not outlive
the application that spawned it.

---

## 19. The explanation test reads past the greeting

**Decision.** `isExplanationRequest` strips a leading conversational preamble -
greetings, fillers, "can you", "do you know" - before applying its anchored
opener test, and the opener list covers the forms people actually use
("summarise", "walk me through", "give me an overview").

**The bug this fixed, reported from a real run.** A user typed _"yo can you tell
me what this project directory about"_ and the system started the full coding
pipeline on it, then failed inside the Coder. The opener test is anchored at
`^`, deliberately - an unanchored "what" would match the middle of "change the
parser so it reports what failed". But nobody opens with the keyword. With the
anchor unmatched, the prompt was not an explanation request, so
`hasWorkspaceReference` saw "this project" and classified a question as
workspace work.

**Why strip rather than unanchor.** Unanchoring trades one error for a worse
one: it would pull genuine work requests into the read-only path, and failing to
edit a file someone asked for is more damaging than reading one they did not.
Stripping keeps the anchor's precision and only lets it see past text that
carries no intent - every alternative in the preamble is a greeting, a filler,
or a politeness wrapper, never a verb that could describe work.

**What makes broadening the opener list safe.** Two guards run first: a request
for an artifact, or a named mutation of one, is work however politely it is
phrased. That is why _"can you explain why the build fails and then fix it"_
still reaches the Coder.

---

## 20. A request that cannot fit is shrunk, not retried

**Decision.** When compaction has no exchanges left to fold, it truncates the
largest message in place, keeping the head and cutting the tail. The retrieval
payload handed to later pipeline stages is separately capped, by dropping
lowest-ranked slices rather than cutting the JSON.

**The bug this fixed.** The same real run then failed with `Step "code" is stuck
repeating the same failure: No configured route can fit the request context.`
Compaction folds _conversation exchanges_, and a pipeline worker's first call
has none: the task and all the retrieved evidence live in a single user message,
and the most recent user message is deliberately protected from folding. So
`compactContextIfNecessary` returned false, the runner rethrew, the step retried
with an identical request, and the orchestrator correctly declared it stuck. The
stuck detection worked; the thing it was detecting should not have existed.

**Why truncate the tail.** The instruction is written first and the evidence is
appended after it, so cutting from the end preserves what the agent was asked to
do and loses the least relevant end of its context. Non-system messages are cut
before the agent's own prompt, so its role and constraints survive as long as
any evidence remains to give up.

**Why also cap retrieval at the source.** Truncation is a backstop, and a
backstop that fires routinely is a design failure. Every later stage carries the
retrieval payload in its context, so an unbounded dump is charged repeatedly.
Dropping the lowest-ranked slices costs the least - they are the ones retrieval
was least confident about - and keeps the JSON parseable, which cutting mid-
string would not. The count of dropped slices is reported so a reader can tell
evidence was withheld rather than never found.

**What we gave up.** On a very small window against a very large context the
agent is left with little evidence, and will likely fail on the merits. That is
strictly better than failing to make a request at all, and it fails with a
readable answer instead of a repeated routing error.

---

## 21. Validation exercises the thing it validates

**Decision.** `validateCredentials` sends a one-token completion after listing
models. A provider only reports "validated" once it has actually served a
request.

**The bug this fixed.** Validation was `GET /models` plus a 401/403 check. A
Cerebras trial that has not been verified, an account without billing, and a key
with no entitlement to the chosen model all return a healthy model list and then
refuse every real request. So the settings screen said validated, and the first
task died with a bare `402 status code (no body)`. The user's reasonable
conclusion was that the app was broken, not the account.

**Why probe rather than just report better.** A validation button exists so the
user can find out _before_ running a task. Checking a weaker property than the
one it implies is the failure; a clearer error at task time would not have
restored the button's purpose. The probe costs one output token.

**What we also fixed.** The message. `402` alone is useless; the difference
between "your key is wrong", "your account is not activated", and "this key
cannot use that model" is what decides what the user does next, so each status
now maps to a sentence naming the likely cause.

---

## 22. A billing failure is terminal for the account, not for the task

**Decision.** HTTP 402 and quota-exhaustion messages classify as `quota`,
retryable, so the gateway cools that route down and immediately tries the next
configured provider.

**Why this is not obvious.** 402 is a 4xx, and the generic 4xx branch calls
those `invalid_request`, retryable `false` — correctly, for a malformed request
that will fail identically everywhere. Billing is the exception: the request is
fine, this _account_ cannot serve it, and another provider can. Ordering the
402 check before the 4xx catch-all is what separates the two.

**How it surfaced anyway.** Compiled output had gone stale, so the running app
still had the pre-fix classification and ended the task on the first 402 instead
of failing over — see the note below. The lesson we took is that a fix nobody
can observe is indistinguishable from no fix.

---

## 23. A green test run must mean the current source is green

**Decision.** `pnpm test` runs `tsc -b --force`. `pnpm build:force` does the
same for a manual build.

**The bug this fixed.** `tsc -b` skipped recompiling a source file that had been
rewritten by a git operation, leaving `dist/model.js` hours older than its
source and missing an entire branch of error classification. Everything
downstream was consistent with itself and wrong: the app failed over incorrectly,
and the test suite passed because it was testing the same stale output. We only
caught it by testing the compiled classifier directly against the error shapes a
provider actually throws.

**Why force the whole build rather than detect staleness.** A staleness detector
is more code that can itself be wrong about the thing it is guarding. The full
build takes 17 seconds. Incremental builds remain the default for `pnpm start`,
`pnpm tui`, and `pnpm settings`, where the feedback loop matters and a mistake is
visible immediately; the test command is where a wrong answer is silent, so that
is where the guarantee belongs.

---

## 24. A picker should not offer a choice that does not exist

**Decision.** The agent picker offers Architect (labelled "Auto") and Coder, plus
any agents the project ships itself. Retriever, Verifier, Reviewer, and Chat are
hidden. `isSelectableAgent` owns the distinction in the runtime; the workbench
API exposes `selectable` and `automatic` flags so clients never hardcode IDs.

**The bug this fixed.** The dropdown listed every enabled agent, and the default
was `agents.find((agent) => agent.enabled)` — whichever sorted first. Architect
happened to win alphabetically, so the right thing happened by accident; a
project shipping `.agentic/agents/aardvark.md` would have silently become the
default agent for every prompt.

**Why hide the stages.** Retriever, Verifier, and Reviewer are steps the
pipeline drives, not modes: a Verifier run standalone has nothing to verify.
Chat is selected automatically for prompts that need no project access. Listing
them beside Architect implies a decision the user should be making, and taking
that decision silently turns off the automatic routing that is the point of the
system.

**Why keep any manual override at all.** Two cases are genuine. A user who
already knows the work is an edit can skip straight to Coder. And a project
agent exists precisely to be chosen — being selectable is its entire purpose.
Both are deliberate acts, which is the difference between an override and a
default.

---

## 25. Usage is measured, rolled up, and persisted

**Decision.** Providers report token usage per model call. Those calls are summed
onto their agent span, their pipeline-stage span, and the task span, so every
node in the hierarchy answers "how many tokens and how long". The same totals are
available directly through `taskSpend(taskId)`, and are written into task state
on every call.

**What was missing.** Time was on every span already, and usage was on the model
calls, but nothing above a leaf had a total — the dashboard could show how long
an agent took and not how many tokens it used, which is half of what the problem
statement asks a trace node to show. Rolling up by walking the persisted spans,
rather than tracking a parallel counter, means the number shown always agrees
with the tree it is shown in.

**Why persistence matters more than it looks.** `spendByTask` was an in-memory
Map. Every restart handed a resumed task a fresh $0.50 budget, so the ceiling
that exists to stop a runaway task was the one thing a long-running task could
reset by crashing. Cost is now written to task state next to the orchestration
checkpoint, and read back when the map is cold.

**Boundary.** A provider that reports no usage contributes zero rather than an
estimate. Under-reporting a total is safer than inventing one, and every
provider we ship does report: Groq and the OpenAI-compatible routes through
`usage`, Ollama through `prompt_eval_count` and `eval_count`.

---

## 26. Spending changes the route, not just the alarm

**Decision.** Once a task passes its cost warning ratio, `budgetAwareRoutePolicy`
rewrites the stage's policy: capacity becomes economy and context-window floors
are dropped. Provider exclusions are never relaxed.

**Why cumulative spend is the routing signal that matters.** The other signals -
complexity, context size, tool support - are properties of a request and do not
change while a task runs. Spend does. A stage that deserved the strongest model
at the start does not deserve it three quarters of the way through the budget,
because a task halted at the ceiling scores zero however good the model was. The
degradation is stated in the routing reason, so the change is visible rather
than mysterious.

**What stays fixed.** Exclusions. A verifier demoted onto the same local model
that wrote the code is worthless at any price, so cost pressure can make
judgement cheaper but never let it grade its own work.

---

## 27. A repeated tool call gets its result back, moved rather than copied

**Decision.** When a model repeats a tool call with identical arguments and an
unchanged workspace, the cached result is served again as the newest tool
message, and the earlier copy is replaced by a one-line pointer. The nudge to
stop repeating is a separate message appended after every tool result for that
turn. The repeat limit counts _consecutive_ repeats.

**The bug this fixed, from a real run.** The coding step failed with `did not
call a workspace mutation tool`, and the dashboard showed the cause: `The model
repeatedly requested cached tool calls without making progress.` The guard used
to answer a repeat with a refusal - "use the earlier tool result already present
in the conversation" - which assumes that result is still readable. It often is
not: compaction replaces `read_file` bodies with signatures to save tokens. So
the model re-read, was told to look at content that no longer existed, re-read
again, and hit the loop limit having changed nothing. Two safeguards, each
correct alone, deadlocked when combined.

**Why move the payload instead of copying it.** Copying it back fixes the
deadlock and inflates context, which is what the refusal was protecting against

- a 3 KB result repeated four times is 12 KB of nothing. Moving it keeps context
  flat, puts the data at the position a small model attends to best, and leaves
  the earlier message in place so every `tool_call` in that turn still has a
  matching response. Deleting the earlier message instead would make the provider
  reject the request.

**Why the nudge is deferred.** A provider rejects a non-tool message inserted
between the tool results answering one assistant turn's tool calls, so the
instruction is collected and flushed once the turn's results are complete.

**Why consecutive rather than cumulative.** The counter never reset, so a long
productive run - read A, edit, read B, edit - accumulated toward the limit and
could be stopped for looping while it was making progress. It exists to catch a
model spinning on one call, so it now resets whenever a tool actually executes.

---

## 28. The desktop renderer has no native dialogs

**Decision.** Create, rename, and save-as collect their input through an in-app
`PromptDialog`. `window.prompt` is not used anywhere.

**The bug this fixed.** Electron's renderer does not implement `prompt()`: it
returns undefined without showing anything. Every explorer action built on it -
new file, new folder, rename - returned early on a falsy name and did nothing,
so the menu items looked like unimplemented stubs. The server endpoints behind
them worked the whole time and were already covered by tests; only the way the
UI asked for a name was broken. `window.confirm` had already been replaced for
delete for the same class of reason, which is the clue we should have followed.

**Boundary.** The dialog restores what the native one gave for free: Enter to
confirm, Escape and backdrop click to cancel, focus moved in and restored on
close, and a rename pre-selecting the filename stem so the extension survives
unless the user types over it.

---

## 29. Save-as refuses a collision instead of resolving one

**Decision.** Save-as writes with `expectedHash: null`, which the workspace
reads as "this path must not already exist", and reports the collision back to
the user.

**What we got wrong first.** The obvious implementation - create the entry, then
write to it - trips that same guard against the empty file it just created, so
save-as failed with `File already exists` on a path that was free a millisecond
earlier. The write alone creates the file; the create step was both redundant
and self-defeating.

**Why refuse rather than overwrite.** The three hash modes are a deliberate
contract: `undefined` writes unconditionally, a hash requires that exact
version, and `null` requires absence. Save-as is the one operation where the
user has typed a path from memory, which is exactly when silently overwriting
an existing file does the most damage. Refusing costs one more keystroke;
clobbering costs someone's work.

---

## 30. Conversations are named by what was asked, not by the client

**Decision.** The first prompt in a session becomes its title, assigned by the
runtime rather than the client, and only when the existing title is a
placeholder. A title the user chose is never overwritten, and later prompts
never rename an already-named conversation.

**What was actually missing.** Sessions were persisted, project-scoped, and
already reloaded their transcript when selected - continuing an old chat worked.
What did not work was _finding_ one: the IDE created every session as "IDE
session" and the TUI as "New session", so the history was a list of identical
labels. The storage was right and the affordance was missing.

**Why the runtime titles it.** Both clients had the same problem, and a user is
never going to name a conversation before asking their question. Putting it at
the point where a task starts means the TUI and the IDE get it from one place
and cannot drift.

**Boundary.** Titling triggers on a known set of placeholder strings rather than
on "is this the first task", so a conversation the user has deliberately named
keeps that name even if its first task is deleted and re-run.

---

## 31. Deleting a conversation deletes what it produced

**Decision.** `deleteSession` removes the session's trace spans, events, context
items, and tasks in one transaction before the session row itself.

**Why cascade rather than delete the row.** Tasks, events, and traces reference
the session, so removing only the session leaves history the dashboard still
lists and the user believes they discarded. Trace spans are removed by
_session_ rather than by task, because a span can belong to no task at all - an
isolated `/bytheway` question is the case that would otherwise be left behind.

**What we got wrong first.** The initial cascade filtered `tasks` by
`project_id`, which that table does not have: it is scoped through the session
it belongs to, and the database file is per project already. SQLite reported
`no such column: project_id`, the transaction rolled back, and the delete
silently returned false. A test that asserted the return value rather than just
"it did not throw" is what caught it.

**Boundary.** A session with a running task is refused rather than deleted, so a
task cannot keep writing into history the user has thrown away.

---

## 32. Evidence of work lives outside the transcript

**Decision.** `AgentRunner` reports `changedFiles` and `mutationCount` on its
result, tracked as the run proceeds. The pipeline reads those to decide whether
a coding step did anything, instead of scanning tool messages.

**The bug this fixed, from a real run.** A coding step applied a patch, compacted
its context, wrote a file, checked the diff - and then failed with `The coding
model did not call a workspace mutation tool. No files were changed.` The
execution summary showed both mutations completing. The file on disk had been
edited.

The cause is that two mechanisms had contradictory assumptions about one data
structure. Compaction _rewrites_ `messages`: it folds old exchanges into a
summary and deletes what it replaced. Mutation detection _read_ `messages`,
looking for a tool result with `changed: true`. So a step long enough to compact
could delete the only proof that it had succeeded, and then be told it had done
nothing. The longer and harder the task, the more likely it was to happen -
exactly backwards.

**Why this class of bug is worth naming.** Neither mechanism was wrong on its
own. The fault was treating a lossy, deliberately-rewritten structure as the
system of record for a fact that has to survive. Anything a later decision
depends on has to be recorded where nothing is allowed to rewrite it - which the
runner was already doing internally for its own mutation budget, and simply
never reported.

**Boundary.** A successful `run_command` still counts as progress and is still
read from the transcript. It is not a file mutation, has no durable record, and
a command that ran before a compaction is not evidence a later step depends on.

---

## 33. Three extraction tiers, not one parser for everything

**Decision.** TypeScript and JavaScript are extracted in-process by the
TypeScript compiler API. Python, Go, Rust, C, and C++ go to tree-sitter grammars
in the Rust sidecar. Everything else keeps the regex fallback.

**Why not one parser.** Tree-sitter could parse TS and JS too, and using it
everywhere would be simpler. It would also be worse: the compiler API resolves
bindings, so its reference edges point at the declaration a name actually refers
to, where a syntax tree can only match text. Giving up real resolution on the
languages where we have it, to gain uniformity, trades accuracy for tidiness.

**Why not extend the regex extractor.** It could recognise more declaration
shapes, and would still produce single-line anchors, no scoping, and no call
graph — because a line-oriented matcher cannot know where a function ends or who
is calling whom. The problem statement asks whether the index understands
structure and execution flow; regex cannot answer yes at any level of effort.

**What the middle tier buys.** Per-language visibility rules (Rust `pub`, Go's
leading capital, C's `static`, Python's underscore), real multi-line spans, and
a call graph attributed to the enclosing function rather than to the file.

**Boundary.** The sidecar is an enhancement, not a prerequisite. A missing or
failing binary degrades that tier to the regex fallback rather than failing the
index, so a machine where the native build did not run still has a searchable
project.

---

## 34. Relatedness is a graph property, not a hop count

**Decision.** The project's symbol graph is held in `FlatCPG`'s flat arrays and
queried with personalised PageRank seeded on the symbols a query matched. Results
are added as candidates below a direct symbol match and above a bare text hit.

**What it replaced.** A one-hop expansion over per-file edges. That finds a
direct caller and stops, which is the wrong shape for the question retrieval is
actually answering: a change to a handler breaks the driver three calls away, and
one hop never sees it. Raising the hop count is not the fix either — two hops is
as arbitrary as one, and each level multiplies the candidate set.

PageRank makes distance continuous instead of discrete. A node four edges away
on a dense path can outrank a node two edges away on a sparse one, which is what
"related" actually means in a call graph.

**Where the work is split.** Edges are resolved in SQLite and traversal happens
in Rust. Only the database knows which of several same-named symbols an edge
should attach to; only the flat arrays make a ten-iteration power method cheap.
Putting resolution in the sidecar would have meant shipping it a symbol table it
would then have to rebuild.

**Boundary.** The seed symbols are excluded from the results — the caller already
has them, and the value is what they reach. The reason string names the
mechanism, so a file the user did not ask for arrives with an explanation.

---

## 35. The write-ahead log is the graph's on-disk format

**Decision.** `Wal` stores each project's graph snapshot: bincode payload behind
an 8-byte little-endian length. A fresh index adopts the persisted graph when its
revision matches the database and rebuilds only when it does not.

**Why this and not a table.** The graph is read whole and written whole, never
queried by field, which is exactly the access pattern a memory map serves and
SQLite does not. It also gave the WAL a real consumer: it existed, compiled, and
had no caller, which is worse than not having it.

**Why the length prefix.** The original WAL appended raw bytes and always started
at offset zero, so a truncated write was indistinguishable from a complete one.
Framing makes a short tail detectable at load, and the load path returns nothing
rather than deserialising garbage.

**Boundary.** The revision is a cheap aggregate — file count, newest index time,
symbol count — so staleness is detected without rebuilding the graph to find out.

---

## 36. Two loop detectors, because they catch different loops

**Decision.** The orchestrator keeps its per-step failure fingerprint, and the
coding stage additionally records the workspace state in the Merkle `StateTree`
after every mutating run.

**Why one is not enough.** A fingerprint compares a step's _failure_ to its last
failure. It cannot see a run that edits a file, reverts it, and edits it again:
every step succeeds, and every step's output differs. What repeats is the
workspace, not the error. Hashing the changed files with the action that produced
them makes that visible, and the tree reports how many steps ago the state was
last seen.

**Boundary.** Only mutating stages are recorded. A read-only stage legitimately
leaves the workspace unchanged every time, and recording it would report a cycle
for doing its job correctly. A sidecar that is unavailable contributes no signal,
because this is an additional safeguard rather than the only one.

---

## 37. Retrieval's reasoning reaches the dashboard, not just the log

**Decision.** `ContextArtifact` carries the relevance reasons and the analyser
tier alongside the slice, the pipeline's retrieval stage records its selection on
its own trace span, and the dashboard renders context as a list of slices with
their reasons rather than as JSON.

**The gap this closed.** Three things were true at once and added up to an
invisible feature. The reasons were computed and then dropped when building
context artifacts, so the graph work that decided which files to include left no
trace of having decided anything. The pipeline's retriever is a direct index call
rather than a tool call, so it produced no artifacts at all - the stage that
chooses most of the coder's context was the one stage missing from the view whose
whole job is showing what was in context. And the context tab printed escaped
source, which is not an answer to a question a person asks while debugging a bad
result.

**Why the span is updated mid-run.** A pipeline stage picks its context early and
finishes much later. Waiting for `finishTraceSpan` would leave the panel empty
for exactly the window in which someone is watching a live task, so
`updateTraceSpanContext` writes it as soon as it is chosen.

**Boundary.** A slice with no reasons still renders; the reason list is
supplementary, and a fallback-tier file legitimately has little to say about why
it matched.

---

## Known gaps

Stated plainly, because an unclaimed gap is cheaper than a claimed feature that
fails under questioning.

- **Model parameter catalog.** `MODEL_PARAMETER_CATALOG` is hand-maintained and
  is the only evidence behind the <=80B constraint. Models absent from it are
  flagged `unverified` rather than blocked, and that flag is not surfaced in the
  settings screen.
- **Semantic retrieval outside the seven parsed languages.** Java, Ruby, PHP,
  C#, and the rest still use the per-line regex extractor.
- **No type resolution outside TypeScript.** An edge naming a symbol declared in
  several places attaches to all of them rather than to the right one, because
  deciding without types would be a guess.
- **The graph is a symbol graph.** No data-flow or control-flow analysis, so it
  answers "what calls what", not "what value reaches where".
- **Explorer parity.** No drag-and-drop, multi-select, or nested tree; the
  explorer shows one folder at a time.
- **Cross-platform builds.** Only the Windows build has been produced.
  macOS and Linux packaging is configured but unverified.
- **Credentials at rest.** Provider keys are stored plaintext in the global
  SQLite database, with no OS keychain integration.
