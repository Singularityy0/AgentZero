import { createHash } from "node:crypto";
import {
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  unlink,
  writeFile,
} from "node:fs/promises";
import { dirname, relative, resolve, sep } from "node:path";
import { createTwoFilesPatch } from "diff";

const DEFAULT_MAX_FILE_BYTES = 1_000_000;

export interface WorkspaceFile {
  path: string;
  content: string;
  hash: string;
}

export interface WorkspaceEntry {
  name: string;
  path: string;
  type: "file" | "directory" | "symlink";
  size?: number;
}

export interface FileChange {
  path: string;
  newContent: string;
  expectedHash?: string | null;
  expectedContent?: string;
}

export interface FileChangeResult {
  path: string;
  hash: string;
  diff: string;
  changed: boolean;
  additions: number;
  deletions: number;
}

export class WorkspaceFileService {
  constructor(
    readonly root: string,
    private readonly maxFileBytes = DEFAULT_MAX_FILE_BYTES,
  ) {}

  resolvePath(inputPath: string): string {
    const candidate = resolve(this.root, inputPath);
    const relativePath = relative(this.root, candidate);
    if (
      relativePath &&
      (relativePath === ".." || relativePath.startsWith(`..${sep}`))
    ) {
      throw new Error(`Path is outside the workspace: ${inputPath}`);
    }
    return candidate;
  }

  async readText(inputPath: string): Promise<WorkspaceFile> {
    const path = this.resolvePath(inputPath);
    const data = await readFile(path);
    this.assertText(data, inputPath);
    if (data.byteLength > this.maxFileBytes) {
      throw new Error(
        `File exceeds the ${this.maxFileBytes}-byte limit: ${inputPath}`,
      );
    }
    const content = data.toString("utf8");
    return { path: this.relativePath(path), content, hash: hash(content) };
  }

  async listDirectory(inputPath = "."): Promise<WorkspaceEntry[]> {
    const path = this.resolvePath(inputPath);
    const entries = await readdir(path, { withFileTypes: true });
    return Promise.all(
      entries.map(async (entry) => {
        const entryPath = resolve(path, entry.name);
        const type = entry.isDirectory()
          ? "directory"
          : entry.isSymbolicLink()
            ? "symlink"
            : "file";
        return {
          name: entry.name,
          path: this.relativePath(entryPath),
          type,
          size: type === "file" ? (await stat(entryPath)).size : undefined,
        };
      }),
    );
  }

  async previewChange(change: FileChange): Promise<string> {
    const current = await this.readOptional(change.path);
    this.assertExpected(change, current);
    return this.diff(change.path, current?.content ?? "", change.newContent);
  }

  async applyChange(change: FileChange): Promise<FileChangeResult> {
    const current = await this.readOptional(change.path);
    this.assertExpected(change, current);
    const oldContent = current?.content ?? "";
    const diff = this.diff(change.path, oldContent, change.newContent);
    const path = this.resolvePath(change.path);
    await mkdir(dirname(path), { recursive: true });
    const temporaryPath = `${path}.${process.pid}.${Date.now()}.tmp`;
    try {
      await writeFile(temporaryPath, change.newContent, "utf8");
      try {
        await rename(temporaryPath, path);
      } catch (error) {
        if (!current) {
          throw error;
        }
        await rm(path, { force: true });
        await rename(temporaryPath, path);
      }
    } finally {
      await rm(temporaryPath, { force: true });
    }
    return {
      path: this.relativePath(path),
      hash: hash(change.newContent),
      diff,
      changed: oldContent !== change.newContent,
      additions: countLines(diff, "+"),
      deletions: countLines(diff, "-"),
    };
  }

  async deleteFile(
    inputPath: string,
    expectedHash?: string | null,
  ): Promise<FileChangeResult> {
    const current = await this.readText(inputPath);
    if (expectedHash !== undefined && expectedHash !== current.hash) {
      throw new Error(`File changed since it was read: ${inputPath}`);
    }
    const diff = this.diff(inputPath, current.content, "");
    await unlink(this.resolvePath(inputPath));
    return {
      path: current.path,
      hash: hash(""),
      diff,
      changed: true,
      additions: 0,
      deletions: countLines(diff, "-"),
    };
  }

  private async readOptional(
    inputPath: string,
  ): Promise<WorkspaceFile | undefined> {
    try {
      return await this.readText(inputPath);
    } catch (error) {
      if (isMissing(error)) {
        return undefined;
      }
      throw error;
    }
  }

  private assertExpected(
    change: FileChange,
    current: WorkspaceFile | undefined,
  ): void {
    if (change.expectedHash === undefined) {
      if (change.expectedContent === undefined) {
        return;
      }
      if (change.expectedContent !== current?.content) {
        throw new Error(`File changed since it was read: ${change.path}`);
      }
      return;
    }
    if (change.expectedHash === null && current) {
      throw new Error(`File already exists: ${change.path}`);
    }
    if (change.expectedHash !== null && change.expectedHash !== current?.hash) {
      throw new Error(`File changed since it was read: ${change.path}`);
    }
  }

  private diff(
    inputPath: string,
    oldContent: string,
    newContent: string,
  ): string {
    return createTwoFilesPatch(
      inputPath,
      inputPath,
      oldContent,
      newContent,
      "original",
      "proposed",
      { context: 3 },
    );
  }

  private relativePath(path: string): string {
    const value = relative(this.root, path);
    return (value || ".").replaceAll("\\", "/");
  }

  private assertText(data: Buffer, inputPath: string): void {
    if (data.includes(0)) {
      throw new Error(`Binary files are not supported: ${inputPath}`);
    }
  }
}

export function hash(content: string): string {
  return createHash("sha256").update(content, "utf8").digest("hex");
}

function countLines(diff: string, prefix: "+" | "-"): number {
  return diff
    .split("\n")
    .filter(
      (line) =>
        line.startsWith(prefix) && !line.startsWith(`${prefix}${prefix}`),
    ).length;
}

function isMissing(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}
