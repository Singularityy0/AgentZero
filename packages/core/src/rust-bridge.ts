import { spawn, ChildProcess } from 'node:child_process';
import { createInterface, ReadLine } from 'node:readline';
import { join } from 'node:path';

import { fileURLToPath } from 'url';

export interface DiffChunk {
  start_line: number;
  end_line: number;
  replacement: string;
}

export class RustClient {
  private process: ChildProcess | null = null;
  private rl: ReadLine | null = null;
  private messageIdCounter = 1;
  private pendingRequests = new Map<number, { resolve: (val: any) => void, reject: (err: any) => void }>();

  constructor(private rustBinaryPath?: string) {
    if (!this.rustBinaryPath) {
      const ext = process.platform === 'win32' ? '.exe' : '';
      const __filename = fileURLToPath(import.meta.url);
      this.rustBinaryPath = join(__filename, '..', '..', '..', '..', 'rust', 'target', 'debug', `rust${ext}`);
    }
  }

  start() {
    if (this.process) return;

    this.process = spawn(this.rustBinaryPath!, [], { stdio: ['pipe', 'pipe', 'inherit'] });
    
    this.rl = createInterface({
      input: this.process.stdout!,
      terminal: false
    });

    this.rl.on('line', (line) => {
      try {
        const data = JSON.parse(line);
        if (data.id !== undefined && this.pendingRequests.has(data.id)) {
          const { resolve, reject } = this.pendingRequests.get(data.id)!;
          if (data.error) {
            reject(new Error(data.error));
          } else {
            resolve(data.result);
          }
          this.pendingRequests.delete(data.id);
        }
      } catch (e) {
        console.error("RustClient: Failed to parse line from Rust:", line, e);
      }
    });

    this.process.on('close', (code) => {
      this.process = null;
      this.rl = null;
      for (const { reject } of this.pendingRequests.values()) {
        reject(new Error(`Rust process exited with code ${code}`));
      }
      this.pendingRequests.clear();
    });
  }

  stop() {
    if (this.process) {
      this.process.kill();
      this.process = null;
    }
  }

  private request<T>(method: string, params: any): Promise<T> {
    return new Promise((resolve, reject) => {
      if (!this.process || !this.process.stdin) {
        return reject(new Error("Rust process is not running. Call start() first."));
      }

      const id = this.messageIdCounter++;
      this.pendingRequests.set(id, { resolve, reject });

      const payload = JSON.stringify({ id, method, params }) + '\n';
      this.process.stdin.write(payload, (err) => {
        if (err) {
          this.pendingRequests.delete(id);
          reject(err);
        }
      });
    });
  }

  async sliceAst(code: string, symbols: string[]): Promise<string[]> {
    return this.request<string[]>('slice_ast', { code, symbols });
  }

  async computeDiff(original: string, proposal: string): Promise<DiffChunk[]> {
    return this.request<DiffChunk[]>('compute_diff', { original, proposal });
  }

  async checkCycle(fileHash: number[], cmd?: string): Promise<number | null> {
    return this.request<number | null>('check_cycle', { file_hash: fileHash, cmd });
  }
}
