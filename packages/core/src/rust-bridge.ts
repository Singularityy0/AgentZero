import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { statSync } from "node:fs";
import { dirname, join } from "node:path";
import { createInterface, type Interface } from "node:readline";
import { fileURLToPath } from "node:url";

/**
 * Locate the Rust sidecar.
 *
 * A packaged desktop build has no `rust/target` tree next to the JavaScript, so
 * the path is taken from `AGENTIC_RUST_PATH` when the host sets one — the
 * desktop main process points it at the bundled binary, exactly as it already
 * does for ripgrep. In a source checkout, a release build is preferred over a
 * debug build when both exist; the previous hard-coded `target/debug` path
 * meant a release build was never found.
 *
 * Returning a best-guess path rather than throwing is deliberate: every caller
 * treats a missing sidecar as a lost capability, not an error. Structural
 * slicing and the AST diff tool report a tool error, and compaction silently
 * falls back to its structured-exchange path.
 */
function resolveRustBinaryPath(): string {
  const configured = process.env.AGENTIC_RUST_PATH?.trim();
  if (configured) return configured;
  const extension = process.platform === "win32" ? ".exe" : "";
  const moduleDirectory = dirname(fileURLToPath(import.meta.url));
  const candidates = ["release", "debug"].map((profile) =>
    join(
      moduleDirectory,
      "..",
      "..",
      "..",
      "rust",
      "target",
      profile,
      `rust${extension}`,
    ),
  );
  // Pick the most recently built profile, not a fixed preference. The dev
  // scripts build debug, so preferring release outright would silently run a
  // stale release binary after someone edits the crate and restarts - the
  // hardest kind of bug to notice, because the old binary still answers.
  const built = candidates
    .map((path) => ({ path, builtAt: modifiedAt(path) }))
    .filter(
      (candidate): candidate is { path: string; builtAt: number } =>
        candidate.builtAt !== undefined,
    )
    .sort((left, right) => right.builtAt - left.builtAt);
  return built[0]?.path ?? candidates[1]!;
}

function modifiedAt(path: string): number | undefined {
  try {
    return statSync(path).mtimeMs;
  } catch {
    return undefined;
  }
}

export interface ExtractedSymbol {
  name: string;
  kind: string;
  startLine: number;
  endLine: number;
  exported: boolean;
  signature: string;
}

export interface ExtractedEdge {
  kind: "definition" | "reference" | "call" | "import" | "export";
  sourceSymbol?: string;
  targetName: string;
  line: number;
  moduleSpecifier?: string;
}

export interface ExtractedFile {
  symbols: ExtractedSymbol[];
  edges: ExtractedEdge[];
  /** Grammar that produced this, or null when none matched. */
  language: string | null;
}

export interface CpgNode {
  symbol: string;
  path: string;
  start_line: number;
  end_line: number;
}

export interface CpgEdge {
  head: number;
  tail: number;
  kind: "definition" | "reference" | "call" | "import" | "export";
}

export interface RankedGraphNode {
  symbol: string;
  path: string;
  startLine: number;
  endLine: number;
  score: number;
}

export interface DiffChunk {
  start_line: number;
  end_line: number;
  replacement: string;
}

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (reason: Error) => void;
  timeout: NodeJS.Timeout;
}

interface RpcResponse {
  id?: number;
  result?: unknown;
  error?: string;
}

export interface RustClientOptions {
  binaryPath?: string;
  requestTimeoutMs?: number;
}

export class RustClient {
  private process: ChildProcessWithoutNullStreams | null = null;
  private rl: Interface | null = null;
  private messageIdCounter = 1;
  private readonly pendingRequests = new Map<number, PendingRequest>();
  private readonly rustBinaryPath: string;
  private readonly requestTimeoutMs: number;

  constructor(options: RustClientOptions | string = {}) {
    const normalizedOptions =
      typeof options === "string" ? { binaryPath: options } : options;
    this.rustBinaryPath =
      normalizedOptions.binaryPath ?? resolveRustBinaryPath();
    this.requestTimeoutMs = normalizedOptions.requestTimeoutMs ?? 30_000;
  }

  start(): void {
    if (this.process) return;

    const child = spawn(this.rustBinaryPath, [], {
      stdio: ["pipe", "pipe", "pipe"],
    });
    // The sidecar is a helper, not a reason for the host to stay alive. The
    // child and each of its pipes hold their own handle on the event loop, so
    // all four are released: without this a run that had finished its work hung
    // instead of exiting, because an idle sidecar kept the loop open. Pending
    // requests are unaffected - they are kept alive by their own timers.
    child.unref();
    for (const stream of [child.stdin, child.stdout, child.stderr]) {
      (stream as unknown as { unref?: () => void }).unref?.();
    }
    this.process = child;
    this.rl = createInterface({ input: child.stdout, terminal: false });

    this.rl.on("line", (line) => this.handleResponse(line));
    child.stderr.on("data", (data: Buffer) => {
      const message = data.toString("utf8").trim();
      if (message) console.error(`Rust engine: ${message}`);
    });
    child.on("error", (error) => {
      this.failAll(
        new Error(
          `Unable to start Rust engine at ${this.rustBinaryPath}: ${error.message}`,
        ),
      );
      this.resetProcess(child);
    });
    child.on("close", (code) => {
      this.failAll(
        new Error(`Rust engine exited with code ${code ?? "unknown"}.`),
      );
      this.resetProcess(child);
    });
  }

  stop(): void {
    const child = this.process;
    if (!child) return;

    this.failAll(
      new Error("Rust engine stopped before completing the request."),
    );
    this.resetProcess(child);
    child.kill();
  }

  private handleResponse(line: string): void {
    let response: RpcResponse;
    try {
      response = JSON.parse(line) as RpcResponse;
    } catch (error) {
      console.error("RustClient: Failed to parse line from Rust:", line, error);
      return;
    }

    if (typeof response.id !== "number") return;
    const pending = this.pendingRequests.get(response.id);
    if (!pending) return;

    clearTimeout(pending.timeout);
    this.pendingRequests.delete(response.id);
    if (response.error) pending.reject(new Error(response.error));
    else pending.resolve(response.result);
  }

  private resetProcess(child: ChildProcessWithoutNullStreams): void {
    if (this.process !== child) return;
    this.rl?.close();
    this.rl = null;
    this.process = null;
  }

  private failAll(error: Error): void {
    for (const pending of this.pendingRequests.values()) {
      clearTimeout(pending.timeout);
      pending.reject(error);
    }
    this.pendingRequests.clear();
  }

  private request<T>(
    method: string,
    params: Record<string, unknown>,
  ): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const child = this.process;
      if (!child) {
        reject(new Error("Rust engine is not running. Call start() first."));
        return;
      }

      const id = this.messageIdCounter++;
      const timeout = setTimeout(() => {
        this.pendingRequests.delete(id);
        reject(
          new Error(
            `Rust engine request ${method} timed out after ${this.requestTimeoutMs} ms.`,
          ),
        );
      }, this.requestTimeoutMs);
      this.pendingRequests.set(id, {
        resolve: (value) => resolve(value as T),
        reject,
        timeout,
      });

      const payload = `${JSON.stringify({ id, method, params })}\n`;
      child.stdin.write(payload, (error) => {
        if (!error) return;
        clearTimeout(timeout);
        this.pendingRequests.delete(id);
        reject(error);
      });
    });
  }

  async sliceAst(
    code: string,
    symbols: string[],
    extension = "ts",
  ): Promise<string[]> {
    return this.request<string[]>("slice_ast", {
      code,
      symbols,
      ext: extension,
    });
  }

  /**
   * Symbols and edges for a source file, via the sidecar's tree-sitter
   * grammars. `language` is null when no grammar matched, which is the caller's
   * signal to fall back rather than to treat an empty result as "no symbols".
   */
  async extractSymbols(
    code: string,
    extension: string,
  ): Promise<ExtractedFile> {
    return this.request<ExtractedFile>("extract_symbols", {
      code,
      ext: extension,
    });
  }

  /** Replace a project's code property graph and persist it through the WAL. */
  async putCodeGraph(input: {
    projectId: string;
    dir: string;
    revision: string;
    nodes: CpgNode[];
    edges: CpgEdge[];
  }): Promise<{ nodes: number }> {
    return this.request<{ nodes: number }>("cpg_put", { ...input });
  }

  /** Revision of the persisted graph on disk, or null when there is none. */
  async codeGraphRevision(input: {
    projectId: string;
    dir: string;
  }): Promise<string | null> {
    return this.request<string | null>("cpg_revision", { ...input });
  }

  /** Symbols the graph says are closest to the ones a query already matched. */
  async rankByCodeGraph(input: {
    projectId: string;
    dir: string;
    seeds: string[];
    limit?: number;
  }): Promise<RankedGraphNode[]> {
    return this.request<RankedGraphNode[]>("cpg_rank", { ...input });
  }

  async pruneAst(code: string, extension: string): Promise<string> {
    return this.request<string>("prune_ast", { code, ext: extension });
  }

  async computeDiff(original: string, proposal: string): Promise<DiffChunk[]> {
    return this.request<DiffChunk[]>("compute_diff", { original, proposal });
  }

  /**
   * Record a workspace state and report whether it repeats a recent one.
   *
   * Returns how many steps ago the same state was seen, or null. This catches
   * the failure a per-step fingerprint cannot: a task that edits a file, undoes
   * it, and edits it again is looping even though every individual step
   * succeeded and every step's output was different.
   */
  async checkWorkspaceCycle(
    fileHashes: readonly string[],
    command?: string,
    exitCode?: number,
  ): Promise<number | null> {
    return this.request<number | null>("check_cycle", {
      file_hashes: [...fileHashes].sort(),
      ...(command === undefined ? {} : { cmd: command }),
      ...(exitCode === undefined ? {} : { exit_code: exitCode }),
    });
  }

  /** Forget recorded states, so a new task starts with a clean history. */
  async resetCycles(): Promise<void> {
    await this.request<boolean>("reset_cycles", {});
  }

  async checkCycle(
    fileHash: number[],
    command?: string,
  ): Promise<number | null> {
    return this.request<number | null>("check_cycle", {
      file_hash: fileHash,
      cmd: command,
    });
  }
}
