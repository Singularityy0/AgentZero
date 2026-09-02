import { createHash, randomUUID } from "node:crypto";
import {
  cp,
  lstat,
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  unlink,
  writeFile,
} from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";
import { createTwoFilesPatch, diffLines } from "diff";

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

export interface FileChangeHunk {
  id: string;
  path: string;
  startLine: number;
  endLine: number;
  original: string;
  replacement: string;
}

export interface PreparedFileChange {
  kind: "file_diff";
  path: string;
  baseHash: string | null;
  proposedHash: string;
  diff: string;
  hunks: FileChangeHunk[];
  /**
   * Top-level symbols (function/class/const/exported names) present in the
   * original file but absent from the proposed content. A full-file rewrite
   * from a weak model routinely drops unrelated existing code without
   * noticing; this is a best-effort heuristic to surface that to a reviewer
   * and the model itself, not a hard block (legitimate removals happen too).
   */
  removedSymbols: string[];
}

export interface FileChangeResult {
  path: string;
  hash: string;
  diff: string;
  changed: boolean;
  additions: number;
  deletions: number;
}

export interface FileMutationPreimage {
  content: string;
  hash: string;
}

export interface FileMutationRecord {
  id: string;
  path: string;
  operation: "write" | "delete";
  before: FileMutationPreimage | null;
  afterHash: string | null;
  acceptedHunkIds: string[];
}

export interface FileMutationResult extends FileChangeResult {
  /**
   * The rollback record for this change, or null when nothing was written.
   * A no-op has no state to restore, so it must not enter the recovery journal.
   */
  mutation: FileMutationRecord | null;
}

export interface ReviewedFileChangeResult extends FileMutationResult {
  appliedHunkIds: string[];
  rejectedHunks: FileChangeHunk[];
}

export interface FileMutationRollbackSuccess {
  /**
   * `preserved` means the mutation created a file that did not exist before and
   * the caller asked to keep it. Undoing a creation deletes the only copy of the
   * work, so recovery keeps it and lets the corrective pass overwrite it.
   */
  status: "rolled_back" | "preserved";
  mutationId: string;
  path: string;
  operation: "write" | "delete";
  hash: string | null;
}

export interface RollbackOptions {
  /** Keep files this mutation created instead of deleting them. */
  preserveCreatedFiles?: boolean;
}

export interface FileMutationRollbackConflict {
  status: "conflict";
  mutationId: string;
  path: string;
  operation: "write" | "delete";
  expectedHash: string | null;
  actualHash: string | null;
}

export type FileMutationRollbackResult =
  FileMutationRollbackSuccess | FileMutationRollbackConflict;

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
    await this.assertNoSymlinkPath(path, inputPath);
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
    await this.assertNoSymlinkPath(path, inputPath);
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
    return (await this.prepareChange(change)).diff;
  }

  /** Creates an empty file, failing if anything already occupies the path. */
  async createEmptyFile(inputPath: string): Promise<string> {
    const path = this.resolvePath(inputPath);
    await this.assertNoSymlinkPath(path, inputPath);
    if (await this.pathExists(path)) {
      throw new Error(`Path already exists: ${inputPath}`);
    }
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, "", { encoding: "utf8", flag: "wx" });
    return relative(this.root, path).replaceAll("\\", "/");
  }

  /** Creates a directory, failing if anything already occupies the path. */
  async createDirectory(inputPath: string): Promise<string> {
    const path = this.resolvePath(inputPath);
    await this.assertNoSymlinkPath(path, inputPath);
    if (await this.pathExists(path)) {
      throw new Error(`Path already exists: ${inputPath}`);
    }
    await mkdir(path, { recursive: true });
    return relative(this.root, path).replaceAll("\\", "/");
  }

  /** Renames or moves a file or directory inside the workspace. */
  async renameEntry(fromPath: string, toPath: string): Promise<string> {
    const source = this.resolvePath(fromPath);
    const target = this.resolvePath(toPath);
    await this.assertNoSymlinkPath(source, fromPath);
    await this.assertNoSymlinkPath(target, toPath);
    if (!(await this.pathExists(source))) {
      throw new Error(`Path not found: ${fromPath}`);
    }
    if (await this.pathExists(target)) {
      throw new Error(`Path already exists: ${toPath}`);
    }
    await mkdir(dirname(target), { recursive: true });
    await rename(source, target);
    return relative(this.root, target).replaceAll("\\", "/");
  }

  /** Removes a file, or a directory and everything inside it. */
  async removeEntry(inputPath: string): Promise<void> {
    const path = this.resolvePath(inputPath);
    if (path === resolve(this.root)) {
      throw new Error("The workspace root cannot be deleted.");
    }
    await this.assertNoSymlinkPath(path, inputPath);
    if (!(await this.pathExists(path))) {
      throw new Error(`Path not found: ${inputPath}`);
    }
    await rm(path, { recursive: true, force: true });
  }

  /**
   * Copies a file or directory, choosing a non-colliding name when the target
   * is taken. Used by both Copy/Paste and Duplicate in the explorer.
   */
  async copyEntry(fromPath: string, toPath: string): Promise<string> {
    const source = this.resolvePath(fromPath);
    await this.assertNoSymlinkPath(source, fromPath);
    if (!(await this.pathExists(source))) {
      throw new Error(`Path not found: ${fromPath}`);
    }
    const target = await this.availablePath(toPath);
    const resolvedTarget = this.resolvePath(target);
    if (
      resolvedTarget === source ||
      resolvedTarget.startsWith(`${source}${sep}`)
    ) {
      throw new Error("A directory cannot be copied into itself.");
    }
    await this.assertNoSymlinkPath(resolvedTarget, target);
    await mkdir(dirname(resolvedTarget), { recursive: true });
    await cp(source, resolvedTarget, { recursive: true, errorOnExist: true });
    return relative(this.root, resolvedTarget).replaceAll("\\", "/");
  }

  /** Appends " copy", " copy 2", … until the path is free, like Finder. */
  async availablePath(inputPath: string): Promise<string> {
    const path = this.resolvePath(inputPath);
    if (!(await this.pathExists(path))) return inputPath;
    const name = inputPath.split("/").at(-1) ?? inputPath;
    const parent = inputPath.slice(0, inputPath.length - name.length);
    const dot = name.lastIndexOf(".");
    const stem = dot > 0 ? name.slice(0, dot) : name;
    const extension = dot > 0 ? name.slice(dot) : "";
    for (let index = 1; index < 1000; index += 1) {
      const suffix = index === 1 ? " copy" : ` copy ${index}`;
      const candidate = `${parent}${stem}${suffix}${extension}`;
      if (!(await this.pathExists(this.resolvePath(candidate)))) {
        return candidate;
      }
    }
    throw new Error(`Could not find a free name for ${inputPath}.`);
  }

  private async pathExists(path: string): Promise<boolean> {
    try {
      await lstat(path);
      return true;
    } catch {
      return false;
    }
  }

  async prepareChange(change: FileChange): Promise<PreparedFileChange> {
    const current = await this.readOptional(change.path);
    this.assertExpected(change, current);
    const path = this.relativePath(this.resolvePath(change.path));
    const original = current?.content ?? "";
    return {
      kind: "file_diff",
      path,
      baseHash: current?.hash ?? null,
      proposedHash: hash(change.newContent),
      diff: this.diff(path, original, change.newContent),
      hunks: createFileChangeHunks(path, original, change.newContent),
      removedSymbols:
        current === undefined
          ? []
          : findRemovedSymbols(original, change.newContent),
    };
  }

  async applyChange(change: FileChange): Promise<ReviewedFileChangeResult> {
    return this.applyPreparedChange(change, await this.prepareChange(change));
  }

  async applyPreparedChange(
    change: FileChange,
    prepared: PreparedFileChange,
    acceptedHunkIds = prepared.hunks.map((hunk) => hunk.id),
  ): Promise<ReviewedFileChangeResult> {
    const current = await this.readOptional(change.path);
    const currentHash = current?.hash ?? null;
    if (currentHash !== prepared.baseHash) {
      throw new Error(`File changed after approval preview: ${change.path}`);
    }
    this.assertExpected(change, current);
    const recreated = await this.prepareChange(change);
    if (!samePreparedChange(prepared, recreated)) {
      throw new Error(
        `Approved preview no longer matches proposal: ${change.path}`,
      );
    }
    const accepted = new Set(acceptedHunkIds);
    if (accepted.size !== acceptedHunkIds.length) {
      throw new Error("Accepted hunk IDs must not be duplicated.");
    }
    for (const id of accepted) {
      if (!prepared.hunks.some((hunk) => hunk.id === id)) {
        throw new Error(`Unknown approved hunk: ${id}`);
      }
    }
    const oldContent = current?.content ?? "";
    const mergedContent = applyFileChangeHunks(
      oldContent,
      prepared.hunks.filter((hunk) => accepted.has(hunk.id)),
    );

    // Creating a file out of an empty merge is never what anyone asked for.
    // When the target does not exist yet and no hunk was accepted there is
    // nothing to partially apply, and writing the empty merge would leave a
    // 0-byte file on disk that looks like a successful creation. Report no
    // change instead and leave the workspace untouched.
    if (
      current === undefined &&
      prepared.hunks.length > 0 &&
      accepted.size === 0
    ) {
      return {
        path: prepared.path,
        hash: hash(""),
        diff: "",
        changed: false,
        additions: 0,
        deletions: 0,
        appliedHunkIds: [],
        rejectedHunks: [...prepared.hunks],
        mutation: null,
      };
    }

    const path = this.resolvePath(prepared.path);
    await this.assertNoSymlinkPath(path, prepared.path);
    const afterHash = hash(mergedContent);
    const mutation: FileMutationRecord = {
      id: randomUUID(),
      path: prepared.path,
      operation: "write",
      before: current ? { content: current.content, hash: current.hash } : null,
      afterHash,
      acceptedHunkIds: [...accepted],
    };
    await mkdir(dirname(path), { recursive: true });
    await this.atomicWrite(path, mergedContent, Boolean(current));
    const diff = this.diff(prepared.path, oldContent, mergedContent);
    return {
      path: prepared.path,
      hash: afterHash,
      diff,
      changed: oldContent !== mergedContent,
      additions: countLines(diff, "+"),
      deletions: countLines(diff, "-"),
      mutation,
      appliedHunkIds: [...accepted],
      rejectedHunks: prepared.hunks.filter((hunk) => !accepted.has(hunk.id)),
    };
  }

  async deleteFile(
    inputPath: string,
    expectedHash?: string | null,
  ): Promise<FileMutationResult> {
    const current = await this.readText(inputPath);
    if (expectedHash !== undefined && expectedHash !== current.hash) {
      throw new Error(`File changed since it was read: ${inputPath}`);
    }
    const diff = this.diff(inputPath, current.content, "");
    const path = this.resolvePath(inputPath);
    await this.assertNoSymlinkPath(path, inputPath);
    const mutation: FileMutationRecord = {
      id: randomUUID(),
      path: current.path,
      operation: "delete",
      before: { content: current.content, hash: current.hash },
      afterHash: null,
      acceptedHunkIds: [],
    };
    await unlink(path);
    return {
      path: current.path,
      hash: hash(""),
      diff,
      changed: true,
      additions: 0,
      deletions: countLines(diff, "-"),
      mutation,
    };
  }

  async rollbackMutation(
    mutation: FileMutationRecord,
    options: RollbackOptions = {},
  ): Promise<FileMutationRollbackResult> {
    this.assertMutationRecord(mutation);
    const actualHash = await this.readOptionalHash(mutation.path);
    if (actualHash !== mutation.afterHash) {
      return {
        status: "conflict",
        mutationId: mutation.id,
        path: mutation.path,
        operation: mutation.operation,
        expectedHash: mutation.afterHash,
        actualHash,
      };
    }

    const path = this.resolvePath(mutation.path);
    await this.assertNoSymlinkPath(path, mutation.path);
    if (mutation.before === null) {
      if (options.preserveCreatedFiles) {
        return {
          status: "preserved",
          mutationId: mutation.id,
          path: mutation.path,
          operation: mutation.operation,
          hash: mutation.afterHash,
        };
      }
      await unlink(path);
      await this.removeEmptyParents(path);
      return {
        status: "rolled_back",
        mutationId: mutation.id,
        path: mutation.path,
        operation: mutation.operation,
        hash: null,
      };
    }

    await mkdir(dirname(path), { recursive: true });
    await this.atomicWrite(path, mutation.before.content, actualHash !== null);
    return {
      status: "rolled_back",
      mutationId: mutation.id,
      path: mutation.path,
      operation: mutation.operation,
      hash: mutation.before.hash,
    };
  }

  /**
   * Removes directories that a rolled-back creation left behind, stopping at the
   * workspace root and at the first directory that still has contents.
   */
  private async removeEmptyParents(path: string): Promise<void> {
    let directory = dirname(path);
    while (directory.startsWith(this.root) && directory !== this.root) {
      try {
        const entries = await readdir(directory);
        if (entries.length > 0) return;
        // fs.rm on a directory requires the recursive flag; the emptiness check
        // above is what keeps this from removing anything the user still has.
        await rm(directory, { recursive: true, force: true });
      } catch {
        return;
      }
      directory = dirname(directory);
    }
  }

  private async atomicWrite(
    path: string,
    content: string,
    replaceExisting: boolean,
  ): Promise<void> {
    const temporaryPath = `${path}.${process.pid}.${Date.now()}.tmp`;
    try {
      await writeFile(temporaryPath, content, "utf8");
      try {
        await rename(temporaryPath, path);
      } catch (error) {
        if (!replaceExisting) throw error;
        await rm(path, { force: true });
        await rename(temporaryPath, path);
      }
    } finally {
      await rm(temporaryPath, { force: true });
    }
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

  private async readOptionalHash(inputPath: string): Promise<string | null> {
    const path = this.resolvePath(inputPath);
    await this.assertNoSymlinkPath(path, inputPath);
    try {
      return hashBuffer(await readFile(path));
    } catch (error) {
      if (isMissing(error)) {
        return null;
      }
      throw error;
    }
  }

  private assertMutationRecord(mutation: FileMutationRecord): void {
    if (!mutation.id) {
      throw new Error("Mutation record ID must not be empty.");
    }
    if (
      mutation.before !== null &&
      hash(mutation.before.content) !== mutation.before.hash
    ) {
      throw new Error(
        `Mutation preimage hash does not match: ${mutation.path}`,
      );
    }
    if (mutation.operation === "write" && mutation.afterHash === null) {
      throw new Error(
        `Write mutation must have an after hash: ${mutation.path}`,
      );
    }
    if (
      mutation.operation === "delete" &&
      (mutation.before === null || mutation.afterHash !== null)
    ) {
      throw new Error(`Delete mutation record is invalid: ${mutation.path}`);
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

  private async assertNoSymlinkPath(
    path: string,
    inputPath: string,
  ): Promise<void> {
    const relativePath = relative(this.root, path);
    let current = this.root;
    for (const segment of relativePath.split(sep).filter(Boolean)) {
      current = join(current, segment);
      try {
        if ((await lstat(current)).isSymbolicLink()) {
          throw new Error(`Symlink paths are not supported: ${inputPath}`);
        }
      } catch (error) {
        if (isMissing(error)) return;
        throw error;
      }
    }
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

function hashBuffer(content: Buffer): string {
  return createHash("sha256").update(content).digest("hex");
}

const SYMBOL_DECLARATION_PATTERN =
  /^(?:export\s+)?(?:default\s+)?(?:async\s+)?function\s*\*?\s+([A-Za-z_$][\w$]*)|^(?:export\s+)?class\s+([A-Za-z_$][\w$]*)|^(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=/gm;
const EXPORT_LIST_PATTERN = /(?:export\s*\{([^}]*)\}|module\.exports\s*=\s*\{([^}]*)\})/g;

/**
 * Best-effort extraction of top-level JS/TS symbol names, so a full-file
 * rewrite can be checked for accidental loss of unrelated existing code.
 * Deliberately simple (regex, not a parser): false positives/negatives are
 * acceptable for a reviewer hint, unlike a correctness-critical check.
 */
function extractTopLevelSymbols(content: string): Set<string> {
  const names = new Set<string>();
  for (const match of content.matchAll(SYMBOL_DECLARATION_PATTERN)) {
    const name = match[1] ?? match[2] ?? match[3];
    if (name) names.add(name);
  }
  for (const match of content.matchAll(EXPORT_LIST_PATTERN)) {
    const list = match[1] ?? match[2] ?? "";
    for (const entry of list.split(",")) {
      const name = entry.split(":")[0]?.trim().split(/\s+as\s+/)[0]?.trim();
      if (name) names.add(name);
    }
  }
  return names;
}

function findRemovedSymbols(original: string, proposal: string): string[] {
  const before = extractTopLevelSymbols(original);
  if (before.size === 0) return [];
  const after = extractTopLevelSymbols(proposal);
  return [...before].filter((name) => !after.has(name));
}

function createFileChangeHunks(
  path: string,
  original: string,
  proposal: string,
): FileChangeHunk[] {
  const changes = diffLines(original, proposal);
  const hunks: FileChangeHunk[] = [];
  let originalLine = 1;
  for (let index = 0; index < changes.length;) {
    const change = changes[index];
    if (!change) break;
    if (!change.added && !change.removed) {
      originalLine += lineCount(change.value);
      index += 1;
      continue;
    }
    const startLine = originalLine;
    let removed = "";
    let replacement = "";
    let removedLines = 0;
    while (index < changes.length) {
      const part = changes[index];
      if (!part || (!part.added && !part.removed)) break;
      if (part.removed) {
        removed += part.value;
        const count = lineCount(part.value);
        removedLines += count;
        originalLine += count;
      }
      if (part.added) replacement += part.value;
      index += 1;
    }
    const endLine = startLine + removedLines;
    const identity = JSON.stringify({
      version: 1,
      path,
      startLine,
      endLine,
      originalHash: hash(removed),
      replacementHash: hash(replacement),
    });
    hunks.push({
      id: `h1:${hash(identity)}`,
      path,
      startLine,
      endLine,
      original: removed,
      replacement,
    });
  }
  return hunks;
}

function applyFileChangeHunks(
  original: string,
  hunks: readonly FileChangeHunk[],
): string {
  let content = original;
  const ordered = [...hunks].sort(
    (left, right) =>
      right.startLine - left.startLine || right.endLine - left.endLine,
  );
  let previousStart = Number.POSITIVE_INFINITY;
  for (const hunk of ordered) {
    if (hunk.endLine > previousStart) {
      throw new Error(`Overlapping approved hunk: ${hunk.id}`);
    }
    const start = lineOffset(original, hunk.startLine);
    const end = lineOffset(original, hunk.endLine);
    if (original.slice(start, end) !== hunk.original) {
      throw new Error(`Approved hunk does not match its base: ${hunk.id}`);
    }
    content = `${content.slice(0, start)}${hunk.replacement}${content.slice(end)}`;
    previousStart = hunk.startLine;
  }
  return content;
}

function lineOffset(content: string, oneBasedLine: number): number {
  if (oneBasedLine < 1) throw new Error("Hunk line numbers must be positive.");
  if (oneBasedLine === 1) return 0;
  let line = 1;
  const endings = /\r\n|\n|\r/g;
  for (const match of content.matchAll(endings)) {
    line += 1;
    if (line === oneBasedLine) return (match.index ?? 0) + match[0].length;
  }
  if (line === oneBasedLine - 1 || oneBasedLine === line + 1) {
    return content.length;
  }
  if (oneBasedLine === line) return content.length;
  throw new Error(`Hunk line ${oneBasedLine} is outside the file.`);
}

function lineCount(value: string): number {
  if (!value) return 0;
  const endings = value.match(/\r\n|\n|\r/g)?.length ?? 0;
  return endings + (/\r\n$|\n$|\r$/.test(value) ? 0 : 1);
}

function samePreparedChange(
  left: PreparedFileChange,
  right: PreparedFileChange,
): boolean {
  return (
    left.kind === right.kind &&
    left.path === right.path &&
    left.baseHash === right.baseHash &&
    left.proposedHash === right.proposedHash &&
    JSON.stringify(left.hunks) === JSON.stringify(right.hunks)
  );
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
