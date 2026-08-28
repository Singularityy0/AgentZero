import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { dirname, join } from "node:path";
import { createInterface, type Interface } from "node:readline";
import { fileURLToPath } from "node:url";

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
    const extension = process.platform === "win32" ? ".exe" : "";
    const moduleDirectory = dirname(fileURLToPath(import.meta.url));
    this.rustBinaryPath =
      normalizedOptions.binaryPath ??
      join(
        moduleDirectory,
        "..",
        "..",
        "..",
        "rust",
        "target",
        "debug",
        `rust${extension}`,
      );
    this.requestTimeoutMs = normalizedOptions.requestTimeoutMs ?? 30_000;
  }

  start(): void {
    if (this.process) return;

    const child = spawn(this.rustBinaryPath, [], {
      stdio: ["pipe", "pipe", "pipe"],
    });
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

  async pruneAst(code: string, extension: string): Promise<string> {
    return this.request<string>("prune_ast", { code, ext: extension });
  }

  async computeDiff(original: string, proposal: string): Promise<DiffChunk[]> {
    return this.request<DiffChunk[]>("compute_diff", { original, proposal });
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
