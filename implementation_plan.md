# Rigza (AgentZero) Hybrid Architecture Implementation Plan

This plan establishes a modular, parallel-development roadmap for Rigza. It strictly separates the Rust/Tauri systems core (your track) from the TypeScript Agentic Orchestration layer (your friend's track).

The goal is to allow both of you to build independently by defining clear integration boundaries and API contracts, ensuring that components can be seamlessly merged without breaking existing functionality.

## User Review Required

> [!IMPORTANT]
> Please review the **Integration Boundaries & IPC Strategy** section. We need to align on exactly _how_ the TypeScript layer communicates with the Rust core (e.g., N-API bindings vs. Tauri Sidecar standard I/O vs. local HTTP). The plan currently assumes **N-API / Neon** for direct Node-to-Rust library calls, and **Tauri IPC** for Frontend-to-TypeScript communication.

## Proposed Development Tracks

### 1. Rust & Tauri Track (Your Focus)

This track focuses on the high-performance memory, parsing, and UI layers. Build these as independent Rust libraries (`crates`) first, exposing them via tests before integrating them into Tauri.

#### Phase 1: Systems Core Foundation

- `[ ]` **Initialize Rust Workspace**: Set up a Cargo workspace in the `rust/` directory.
- `[ ]` **Write-Ahead Log (WAL)**: Implement zero-latency memory-mapped I/O using `memmap2`. Expose an append-only interface for logging agent states.
- `[ ]` **BLAKE3 Merkle State Tree**: Implement workspace hashing and cycle detection (rolling $K=10$ history buffer) to break infinite retry loops.

#### Phase 2: AST & Diff Engines (The Hardest Part)

- `[ ]` **FlatCPG AST Slicer**: Integrate `tree-sitter` for TypeScript/Rust/Python. Implement the Structure of Arrays (SoA) memory layout and Bi-Directional Personalized PageRank (PPR) slicing to extract precise 10% AST slices.
- `[ ]` **Zhang-Shasha 3-Way AST Diff Engine**: Implement structural tree distance calculations. Build the logic to deconstruct edits into `DiffChunk` hunks and support partial merges.

#### Phase 3: Tauri Desktop Scaffold

- `[ ]` **Initialize Tauri v2**: Scaffold the cross-platform GUI framework.
- `[ ]` **Settings Vault**: Build the mandatory API keys settings screen (saving to `.rigza/config.json`).
- `[ ]` **IPC Commands**: Define the zero-copy async Tauri commands that the TypeScript layer will invoke (e.g., `compute_diff`, `slice_ast`, `check_cycle`).

#### Phase 4: UI/UX Implementation

- `[ ]` **4-Pane GUI**: Build the Chat & Thought stream, Visual AST Diff Reviewer, Observability DAG, and API Vault interfaces.
- `[ ]` **Clickable Code Tokens**: Implement logic to intercept `file.rs:45` tags in chat and open the respective files.

---

### 2. TypeScript Orchestration Track (Your Friend's Focus)

This track expands the existing `@agentic-runtime/*` packages into a full Tri-Agent architecture with smart routing.

#### Phase 1: Smart Routing & Multi-Provider Gateway

- `[ ]` **Expand Providers**: Extend the existing gateway to support Groq, Cerebras, DeepInfra, and OpenRouter (ensuring models are $\le 80\text{B}$).
- `[ ]` **Failover Protocol**: Implement automatic fallback on HTTP 429/500 errors without losing task progress.
- `[ ]` **Cost Governor**: Implement token counting and the $0.05 emergency threshold that routes to 0-cost local models (Ollama).

#### Phase 2: Tri-Agent FSM (Architect -> Coder -> Critic)

- `[ ]` **Architect Agent (Planning)**: Refactor `TaskOrchestrator` to spawn an Architect that strictly emits numbered execution steps (zero-cost models).
- `[ ]` **Surgical Coder Agent**: Implement the agent that receives FlatCPG slices and outputs Zhang-Shasha compatible diff hunks.
- `[ ]` **Critic Agent (Verification)**: Implement dual-blind verification (syntax checks, compilation).

#### Phase 3: Context Compaction & Advanced Features

- `[ ]` **Auto-Compaction Engine**: Implement a sliding window summary that triggers when context reaches 75% capacity, preserving `AGENTS.md` and AST signatures.
- `[ ]` **Isolated Sidecar**: Implement the `/bytheway` command to spawn an isolated, zero-context execution frame and return seamlessly.

#### Phase 4: Integration Adapters

- `[ ]` **Rust Bridge Interfaces**: Write the TypeScript interface definitions (e.g., `interface IDiffEngine`) that will eventually wrap the Rust N-API/IPC calls. Initially, implement these as mock/stub functions so TS development isn't blocked by Rust progress.

---

## Integration Strategy & Next Steps

To prevent breaking each other's code, we will use a **Contract-First approach**:

1. **Define the Schema**: Before writing logic, define the JSON/Type definitions for data passing between TS and Rust (e.g., what does a `DiffChunk` look like? What does a `PPRSlice` look like?).
2. **Mock the Boundaries**: Your friend will write TS interfaces with mock responses for the Rust tools. You will write Rust functions with mock TS inputs.
3. **Iterative Binding**: Once a Rust component (like BLAKE3 hashing) is ready, replace the TS mock with the actual FFI / N-API / Tauri Command call.

### Immediate Recommended Next Steps

**For You (Rust/Tauri):**

1. Initialize the Cargo workspace in `rust/`.
2. Start with the **BLAKE3 Merkle State Tree** module. It's self-contained, highly testable, and provides immediate value to the TS orchestrator.

**For Your Friend (TypeScript):**

1. Expand the `@agentic-runtime/openai` adapter into a generic **Provider Gateway** that supports Groq and Cerebras.
2. Implement the provider **Failover Protocol**.

## Verification Plan

- **Automated Tests**: Unit tests in Rust (`cargo test`) for AST parsing and Merkle hashing. `pnpm test` for the TS Tri-Agent state machine using mock Rust adapters.
- **Manual Verification**: Launching the Tauri app and successfully triggering a TS agent workflow that calls a Rust command (e.g., hashing the workspace) and displays the result in the TUI/GUI.
