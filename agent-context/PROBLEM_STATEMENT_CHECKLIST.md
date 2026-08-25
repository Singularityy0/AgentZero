# Takneek PS Implementation Checklist

The TUI is intentionally excluded from this assessment.

Legend: `[x]` done, `[~]` partial, `[ ]` remaining.

## 1. Multi-Agent Orchestration

- [~] Agent loop exists through `AgentRunner`.
- [x] Tool-call repetition detection.
- [x] Step-limit safety handling.
- [x] Multi-step edit, reread, and verification continuation.
- [ ] Multiple specialized agents working together.
- [ ] Task planning, delegation, disagreement handling, and replanning.
- [ ] Agent spawning limits and orchestration-level failure recovery.

## 2. Model and Hosting Constraints

- [x] OpenAI and Ollama provider boundaries exist.
- [x] Local Ollama support exists.
- [~] Provider/model configuration exists through environment variables.
- [ ] Formal enforcement that every selected model is `<=80B` parameters.
- [ ] Verification that local models run within `16GB RAM / 8GB VRAM`.
- [ ] Cost and provider eligibility enforcement.

## 3. Smart Routing

- [~] Provider abstraction exists.
- [~] Provider selection exists, but only as configuration.
- [ ] Complexity-aware model routing.
- [ ] Context-size, token-budget, rate-limit, and cost-aware routing.
- [ ] Transparent routing explanations.
- [ ] Automatic fallback while preserving progress.
- [ ] Mandatory settings screen for provider API keys.

## 4. Automatic Context Compaction

- [ ] Automatic context-size monitoring.
- [ ] Compaction trigger policy.
- [ ] Context summarization with important-fact retention.
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
- [ ] Web search tool.
- [ ] Git branch, commit, diff, merge, and related operations.
- [ ] Explicit approval flow for Git and package-install side effects.

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
- [ ] Block-level accept/reject.
- [ ] Accept-all and reject-all review actions.
- [ ] Correct continuation after partial approval or rejection.

## 11. Observability Dashboard

- [~] Runtime event structures are being introduced.
- [~] Session events are persisted.
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

1. Smart routing, provider fallback, and the mandatory settings screen.
2. Multi-agent orchestration with planning, delegation, and recovery.
3. Code indexing and high-quality retrieval.
4. Context compaction and resumable checkpoints.
5. Block-level HITL review.
6. Observability dashboard.
7. Web/Git tools and complete documentation.
