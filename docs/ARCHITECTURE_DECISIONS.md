# Architectural Decisions

Why the system is built the way it is, what was tried first, and what was
rejected. Each entry states the decision, the alternative, and what the choice
costs.

The architecture itself is described in
[MULTI_AGENT_ARCHITECTURE.md](MULTI_AGENT_ARCHITECTURE.md).

---

## 1. Tool-calling format

**Decision.** Tools are declared once in a provider-neutral contract: name,
description, JSON Schema parameters, approval policy, optional preview, execute
function. Each provider adapter translates that contract into its own wire
format. For OpenAI-compatible providers (Groq, OpenRouter, Mistral, Cerebras,
Hugging Face, and any compatible endpoint) that is native
`tools` / `tool_calls` function calling. For Ollama it is the native tool
structure, with a constrained JSON fallback when the model does not produce it.

**Why not a text protocol.** The obvious alternative for small models is a
hand-rolled format: XML tags, or "reply with ACTION: read_file(path)". It is
tempting because it works on any model, including ones with no tool training.
We rejected it as the primary path for three reasons.

- Native function calling is constrained by the provider. The model is far more
  likely to emit a well-formed call because the serving stack biases it that
  way, and several providers enforce the schema server-side.
- A text protocol has to be parsed out of prose, and the failure mode is
  silent. A model that writes about calling `read_file` and one that calls it
  become indistinguishable.
- Arguments containing code break naive text formats constantly. File contents
  contain the delimiters. JSON string escaping is the problem already solved.

**Why a fallback exists anyway.** Small local models advertise tool support and
then return the call as text in the content field. Refusing to parse that means
the local route is unusable, and the local route is what keeps cost at zero.
So `parseJsonToolCalls` accepts the shapes we actually observed:

- a bare JSON object or array in the content
- `<tool_call>` or `<tool_response>` tagged blocks
- fenced code blocks, with or without a `json` language tag
- embedded JSON objects inside surrounding prose
- one JSON object per line

and within each candidate it accepts `name`, `tool_name`, `tool`, or
`function.name` for the name, and `arguments`, `parameters`, `input`,
`function.arguments`, or `function.parameters` for the arguments, parsing the
arguments again if they arrive as a string. Duplicate calls are collapsed by
signature.

That list is not speculative design. Each entry was added after a specific
model produced that shape and the run failed.

**What the fallback costs.** It is lenient, and leniency can misread prose that
merely looks like a call. The mitigation is that parsing is not the last line of
defence: Ajv validates every argument object against the tool's schema before
anything is previewed or approved, so a malformed or hallucinated call is
rejected with a readable error the model can act on rather than executed.

**Boundary.** Tool results return to the model as tool messages with the
originating call id. An assistant message carrying tool calls is always followed
by a result for every call it made. Getting this wrong caused an early class of
infinite Ollama loops where the model reissued a call it had already made
because it never saw the answer in a shape it recognised.

---

## 2. Compaction summarises without calling a model

**Decision.** `compactOldestExchanges` folds the oldest exchanges into a
structured `CompactedTaskState` by bucketing message content. No model is
involved.

**Alternative rejected.** The common approach is to ask an LLM to summarise the
transcript. Rejected on two grounds.

Cost: compaction fires exactly when the context is largest, so an LLM
summarisation is the single most expensive call in the task, repeated on every
compaction event, and cost carries the heavier weight in the score.

Correctness: a summarising model can hallucinate. A summary that says a test
passed when it failed, or that drops the one file hash the Verifier needs,
poisons everything downstream. The requirement is that information must not be
lost or misremembered. A deterministic fold cannot misremember. It can only
drop, and what it drops is bounded and known.

**What it costs.** Prose quality. The compacted state is structured fields of
bounded, truncated raw text, not a fluent narrative, and a model reading it gets
less connective tissue than a good summary would give. The fields that decide
correctness, meaning changed files and their hashes, verification outcomes, and
project rules, are carried exactly, and those are what later stages consult.

---

## 3. Retrieval ranks over a code graph, not embeddings

**Decision.** A per-project SQLite index of symbols, imports, exports,
references, calls, spans, and hashes, plus a flat code property graph in the
Rust sidecar ranked with personalised PageRank.

**Alternative rejected: vector embeddings.** The default answer for code search
is to embed chunks and rank by cosine similarity. Rejected because it answers
the wrong question. Embeddings find code that _reads_ like the query. A coding
task needs code that is _connected_ to the change: the caller that breaks, the
interface that has to move with it, the test that covers it. Those are often
lexically dissimilar to the prompt and to each other. Embeddings also need an
embedding model, which is another API cost per file on every index, or another
local model competing for the same 8 GB of VRAM.

**Alternative rejected: keyword search alone.** Ripgrep is fast and needs no
index, and it remains the fallback for unparsed languages. It cannot rank, it
cannot tell a definition from a mention in a comment, and it returns whole
files.

**What we compared.** One-hop expansion against full personalised PageRank. One
hop is cheaper and simpler, and it finds the direct caller. The regression test
that settled it builds `handler -> service -> repository -> driver` and asks
what a change to `handler` reaches. One hop stops at `service`. PageRank returns
`driver`, three edges out, while still excluding a disconnected node. The thing
a change actually breaks is frequently not adjacent to it.

**What it costs.** The graph is a symbol graph. It has no control-flow or
data-flow analysis, so it answers what calls what, not what value reaches where.
Outside TypeScript there is no type resolution, so an edge naming a symbol
declared in several places attaches to all of them. Deciding without types would
be a guess, and a wrong edge is worse than a missing one.

---

## 4. Three extraction tiers instead of one

**Decision.** TypeScript and JavaScript go through the TypeScript compiler API
in process. Python, Go, Rust, C, and C++ go through tree-sitter in the Rust
sidecar. Everything else uses a regex fallback.

**Why not tree-sitter for everything.** It would be simpler and more uniform.
The compiler API resolves bindings, so its reference edges are real rather than
name matches. Tree-sitter parses syntax and cannot tell two same-named symbols
apart. Where the better analyser is available we use it.

**Why not the compiler API for everything.** It only knows TypeScript and
JavaScript.

**Why the regex tier stays.** A project should still be searchable on a machine
where the native binary did not build, and in a language no grammar covers. A
sidecar failure degrades to regex rather than failing the index.

**What it costs.** Three code paths producing one row shape, and a real risk of
them drifting. The shared extractor contract and per-tier tests exist for that
reason.

---

## 5. Sequential execution, not parallel agents

**Decision.** Pipeline stages run one at a time. Mutation is serialised.

**Alternative rejected.** Running independent read-only stages in parallel is
genuinely faster, and time enters the score.

Rejected for the first reliable path because two agents editing one working tree
produce conflicts that are harder to recover from than the time saved. The
recovery machinery is hash-guarded and assumes it knows which mutation came
from where. Concurrent writers break that assumption.

**What it costs.** Wall clock on tasks with genuinely independent read-only
work. Parallel read-only retrieval remains the obvious next step, and the
boundary is drawn so it can be added without touching mutation ordering.

---

## 6. Route order is a per-stage decision

**Decision.** Every model request may carry a route policy with a bias.
`capacity` sorts eligible routes by largest known parameter count, `economy` by
lowest estimated cost, `balanced` keeps the operator's configured order. Stage
and task complexity decide which applies.

**What we shipped first, and why it was not enough.** A single ordered
preference list for the whole system, with one exception bolted on: verification
and review excluded the local provider. That handles "never judge with something
weaker" but not "do not spend the strongest model on mechanical work".
Retrieval summarisation and a hard refactor were routed identically.

**Why complexity is classified syntactically.** A classifier that costs a round
trip to save a round trip is a bad trade at this scale, and the classification
only reorders models that are already eligible, so being wrong is cheap.
`classifyTaskComplexity` reads prompt length, how many concrete file paths are
named, conjunction count, and multi-step vocabulary.

**The asymmetry that set the threshold.** Routing a hard task down costs
accuracy, which the scoring formula multiplies by ten. Routing an easy task up
costs a fraction of a cent. So `simple` is deliberately narrow. Our first
threshold classified "Add a retry to src/client.ts when the request times out"
as simple. A request pointing at concrete code is not trivial, and it now stays
on the configured route.

**Boundary.** Bias never overrides eligibility. A route lacking tool support or
unable to fit the context ranks last regardless. A minimum context window is a
preference too: if nothing clears it, ranking repeats without it rather than
failing a task a smaller window could have completed. And `capacity` treats an
unknown parameter count as zero, so a model is promoted above the operator's
order only on evidence that it is bigger.

---

## 7. Quota exhaustion is terminal for the account, not for the task

**Decision.** The gateway classifies failures. Rate limits and transient server
errors cool the route for two minutes. Quota and billing exhaustion, including
HTTP 402, cool it for thirty. Both continue through the fallback chain with the
identical request. Authentication and malformed-request failures are terminal.

**Reasoning.** A 402 means that account is finished, not that the work is. The
same request on another provider is the correct response. But an invalid API key
or a malformed request will fail identically everywhere, and silently trying
five providers hides a configuration error behind five failures and five
delays.

---

## 8. Verification requires evidence and never degrades to a weaker model

**Decision.** Verification and review avoid the local route when a hosted one is
configured. A verifier result is accepted only when a real verification tool
actually executed.

**Reasoning.** A judgement stage decides whether the work is done. Running it on
the weakest available model inverts the value of having a judgement stage. The
evidence rule exists because a Verifier once narrated calls to five verification
tools that do not exist and reported success for all of them.

**Known limitation.** Route ranking is eligibility, then cooldown, then
preference. A rate-limit cooldown during the coding calls can still push the
following verify call onto the local model. Judgement stages therefore wait
briefly for a preferred hosted route before accepting the excluded local one as
a last resort, which is better than ending with no eligible model but is not the
same as a guarantee.

---

## 9. Recovery never deletes work it cannot replace

**Decision.** Rollback restores approved workspace file mutations only, in
reverse order, guarded by hash. Creations are preserved rather than deleted
during verifier recovery. A hash mismatch stops recovery instead of overwriting.

**Reasoning.** This came directly from a data-loss defect. A five-language run
left four empty directories and no files. Recovery had treated each creation as
"undo by deleting" and removed the only copy of the generated work. Reverting an
edit to a pre-existing file is safe because the previous content is known.
Deleting a creation is not, because nothing else holds that content.

**Boundary.** Shell, Git, network, package-manager, and external process effects
cannot be rolled back. When they occurred, recovery stops and says so instead of
guessing.

---

## 10. Approval is per hunk, and rejection is context

**Decision.** File mutations prepare a base-hash-bound diff with stable hunk
ids. Approval can be boolean or carry accepted and rejected ids. Rejected hunks
are returned into model context.

**Alternative rejected.** All-or-nothing patch approval is much simpler. It
forces the user to reject an entire correct change because one block is wrong,
and it gives the model no information about what was wrong, so the retry is
blind.

**Boundary.** The workspace re-reads the file before applying and rejects a
stale base. Approving a diff computed against content that has since changed is
how a partial approval silently corrupts a file.

---

## 11. The Rust sidecar ships with the app and is optional at runtime

**Decision.** A separate process over line-delimited JSON-RPC on stdin and
stdout. Every call site degrades to a readable tool error if it is absent.
`pnpm build` and packaging fail hard without it.

**Why a separate process rather than native bindings.** Node native addons have
to be built per platform and per Node ABI, and a crash takes the host process
with it. A child process is a stable boundary, and a parse error in a grammar
cannot take down the IDE.

**Why Rust rather than more TypeScript.** tree-sitter grammars, BLAKE3 hashing,
a memory-mapped write-ahead log, and PageRank over flat arrays are the parts
where the language actually matters. The rest of the system stays TypeScript.

**Why it is optional at runtime but required at build.** A developer without
Cargo should still be able to run the app. An installer shipped without the
sidecar is a silently reduced product, which is worse.

---

## 12. Electron, not Tauri

**Decision.** A deliberately thin Electron host. Node integration disabled,
context isolation and sandboxing on, renderer talking only to the loopback HTTP
boundary.

**Reasoning.** The Electron main process can reuse `gui-server` and the SQLite
backend directly. Under Tauri both would have to be reimplemented in Rust or
shipped as a sidecar with its own lifecycle, for a smaller binary that no
grading criterion measures. Because the client only speaks HTTP and SSE, the
host is swappable later.

**What it costs.** Installer size, and Chromium's memory footprint.

---

## 13. Storage split by scope, in SQLite

**Decision.** A global database for user settings and credential references. A
per-project database, keyed by canonical project root, for sessions, tasks,
events, context items, orchestration checkpoints, recovery journals, and trace
spans.

**Alternative rejected.** In-memory task state with a single log file. It cannot
support resuming a task after the IDE closes, and it cannot support a dashboard
that reads a finished task's exact per-node input and output.

**Why the split.** The requirement is explicit that retrieval and agent memory
must never leak between projects. Deriving the project id from the canonical
root and scoping every query to it makes leakage a schema property rather than
something enforced by discipline.

**Known gap.** Credentials are plaintext at rest. OS keychain integration is the
correct fix and is not done.

---

## 14. Web search without an API key

**Decision.** Article extraction with Readability and jsdom, page scripts never
executed, crawling bounded to the same domain with request and concurrency
limits.

**Reasoning.** A search API key is another credential the grader has to
provision, and several are subscription-based, which the constraints disallow.
Not executing page scripts is a security decision as much as a performance one:
the agent reads attacker-influenced text either way, but it should not run
attacker-supplied code. HTTP and HTTPS only, and private or reserved network
targets are rejected, so a prompt cannot turn the tool into a port scanner of
the host's own network.

---

## 15. Manual context is session-isolated

**Decision.** Files and line ranges pinned to context are stored per session.
`/bytheway` runs one model call with only its own prompt, an empty tool
registry, and a single step, and never reads or mutates the durable transcript.

**Reasoning.** The requirement is one isolated question with zero prior context,
returning cleanly to the ongoing task. Anything that writes to the main
transcript fails the second half. Giving it no tools is what makes the isolation
real rather than nominal.

---

# Challenges and solutions

Real defects, and what each one changed. Every entry below came from running
tasks, not from the test suite.

## Small models emit tool calls as prose

**Problem.** Local models advertised tool support, then returned the call inside
the content field, in a different shape almost every time: bare JSON, fenced
blocks, `<tool_call>` tags, one object per line, backslash-newline
continuations inside JSON strings.

**Solution.** The layered fallback parser in decision 1, built up shape by shape
as each was observed. Ajv validation behind it so leniency in parsing does not
become leniency in execution.

## Infinite tool loops

**Problem.** Two distinct loops. A model reissuing a call it had just made,
because assistant tool-call fields were serialised incorrectly and it never saw
the result. And alternating `A -> B -> A -> B` loops where each call succeeded.

**Solution.** Corrected the assistant and tool message structure so every call
is answered with a matching result. Then added signature tracking in
`AgentRunner`: an identical repeated call returns the previous result and the
run continues instead of entering an unbounded repair loop. The limit counts
consecutive repeats, not repeats over a whole run, so legitimate re-reads after
an edit still work.

## Compaction erased the proof of a mutation

**Problem.** A long coding step applied a patch, compacted, and was then judged
to have changed nothing. The tool message proving the mutation had been folded
away, and the step failed with "did not call a workspace mutation tool" after
having correctly edited the file.

**Solution.** The runner tracks mutations independently of the transcript. The
step reads its own record of what changed rather than re-reading the
conversation. There is now a regression test that a mutation survives a
compaction that happens after it.

## Recovery deleted the work it was recovering

**Problem.** Described in decision 9. A five-file generated result was destroyed
by its own recovery cycle, leaving empty directories.

**Solution.** `preserveCreatedFiles` on rollback, explicit pruning of
directories created by a rolled-back creation, and the evidence rule that stops
a fabricated verifier result from triggering a full rollback and replan on no
evidence at all.

## The Verifier could not see what to verify

**Problem.** A run finished paused with the artifacts intact but reported
`Recovery for step "verify" failed: The coding model did not call a workspace
mutation tool`. Three faults behind one line. The Verifier was never told which
files the task produced, so it read one of five and could not conclude. Recovery
then overwrote the verify result, so the message shown to the user was recovery
plumbing rather than the defect. And when corrective coding changed nothing,
that was reported as the coding model misbehaving.

**Solution.** The verify step receives the tracked produced-files list and is
told to read every one. The Verifier's own finding is captured on failure and is
what the paused summary quotes. Corrective coding that changes nothing now
reports that the Verifier named no actionable defect, and quotes it.

## A valid patch was rejected as truncated

**Problem.** A safety check counted braces in a patch replacement fragment in
isolation and rejected it. The fragment's trailing `class DSU {` had been copied
from the matched old fragment, so it was a valid partial patch, not truncated
output.

**Solution.** Patch fragments are validated as patches, not as standalone source
files, using preview validation rather than standalone brace balance. The same
check remains correct for `write_file`, where a fragment genuinely is not a
complete file.

## One provider key, probed by every turn

**Problem.** A rate-limited free-tier key was re-probed by every continuation
turn, producing repeated 413s and burning the quota faster.

**Solution.** Transient route cooldowns of two minutes, quota cooldowns of
thirty, and per-stage output token budgets so a request reserves what the stage
needs instead of the global maximum on every call.

## A single-file edit took nine minutes

**Problem.** `implement convex hull algorithm in @vishu.cpp` took 554 seconds.
The Coder spent one full provider request only to call `read_file`. A Groq rate
limit then forced the mutation onto a slower route. The first Verifier spent 107
seconds improvising shell commands and checking Git, said the code compiled and
was correct, but omitted the exact pass marker, so the general recovery graph
rolled correct code back, replanned, re-indexed, and ran a second Verifier.

**Solution.** The focused edit path in section 2 of the architecture document.
The named file and its hash are loaded before the Coder starts, `read_file` is
removed from its tools, it is capped at two turns, the Verifier gets the saved
snapshot and only compile or syntax tools with a three-turn ceiling, and a
focused verifier failure reports the written artifact instead of launching the
rollback graph.

## The dashboard reported the wrong elapsed time

**Problem.** A task whose root span was 554 seconds displayed 2290 seconds, and
showed zero model calls despite 37 having been recorded.

**Solution.** Elapsed time comes from the root task span rather than summing
nested spans, which describe overlapping intervals. Provider calls are counted
from `model_call` spans and persisted spend. Retry transitions close the failed
attempt span before opening the next one.

## Agent writes were invisible until the folder was reopened

**Problem.** Nothing watched the filesystem, and the explorer only refetched on
navigation.

**Solution.** A recursive watcher over the project root, filtering generated
directories and atomic-write temporaries, coalescing notifications over a 120 ms
window so one save is one refresh. Exposed as its own SSE stream, deliberately
not session-scoped, because the tree has to stay live before any session exists
and has to reflect edits made outside the IDE. A tab with unsaved edits is never
replaced; the user is told the file changed on disk instead. Where recursive
watching is unavailable the watcher becomes a no-op rather than taking the
server down.

## Ranking was silently arbitrary

**Problem.** Personalised PageRank returned node indices in index order, and the
caller discarded the mass entirely. Truncating that list to a limit kept
whichever related symbols were inserted into the graph first rather than the
most related ones.

**Solution.** The sidecar returns index and mass pairs ordered by descending
mass, ties broken by index for determinism. Retrieval scales the mass against
the strongest neighbour and spreads it across the graph score band, so graph
hits stay below a named symbol match and above a text hit while ordering
themselves by relatedness. A regression test uses a graph whose node order
deliberately disagrees with its graph order.

## Cross-task loop false positives

**Problem.** The sidecar keeps one rolling workspace-state history for the whole
process, and nothing in production reset it. Two tasks touching the same file in
the same repository could leave identical state and have the second reported as
a loop it never entered.

**Solution.** Snapshots are namespaced by task id alongside the agent id.
Namespacing rather than clearing the history on task start, because clearing is
unsafe while another session's task may be recording into the same history and
would silently disable that peer's safeguard.
