import { stat } from "node:fs/promises";
import { extname, join, posix, resolve } from "node:path";
import { findFiles, searchText } from "@agentic-runtime/search";
import { WorkspaceFileService } from "@agentic-runtime/workspace";
import { RetrievalDatabase, type StoredEdge } from "./database.js";
import { extractTextMetadata, extractTypeScript } from "./extract.js";
import { createProjectIdentity, sameCanonicalRoot } from "./project.js";
import type {
  IndexedFileMetadata,
  ProjectIdentity,
  RetrievalIndexOptions,
  RetrievalIndexReport,
  RetrievalQueryOptions,
  RetrievalQueryResult,
  RetrievalRecovery,
  RetrievalSearch,
  RetrievalSlice,
  RetrievalWorkspace,
} from "./types.js";

export * from "./types.js";
export { createProjectIdentity } from "./project.js";

const DEFAULT_MAX_FILE_BYTES = 1_000_000;
const DEFAULT_MAX_FILES = 25_000;
const DEFAULT_LIMIT = 8;
const DEFAULT_MAX_CANDIDATES = 120;
const DEFAULT_MAX_SLICE_LINES = 24;
const DEFAULT_CONTEXT_LINES = 2;

interface Candidate {
  path: string;
  language: string;
  startLine: number;
  endLine: number;
  score: number;
  modifiedAt: number;
  reasons: Set<string>;
  symbols: Set<string>;
}

export class SemanticRetrievalIndex {
  readonly project: ProjectIdentity;
  readonly databasePath: string;
  private readonly database: RetrievalDatabase;
  private readonly workspace: RetrievalWorkspace;
  private readonly search: RetrievalSearch;
  private readonly maxFileBytes: number;
  private readonly maxFiles: number;

  constructor(options: RetrievalIndexOptions) {
    this.project = createProjectIdentity(options.root);
    if (
      options.projectContext &&
      !sameCanonicalRoot(
        this.project.rootPath,
        options.projectContext.project.rootPath,
      )
    ) {
      throw new Error(
        "The retrieval root does not match the supplied project persistence context.",
      );
    }
    this.databasePath = resolve(
      options.databasePath ??
        options.projectContext?.projectDatabasePath ??
        join(this.project.rootPath, ".agentic", "data", "retrieval.db"),
    );
    this.maxFileBytes = options.maxFileBytes ?? DEFAULT_MAX_FILE_BYTES;
    this.maxFiles = options.maxFiles ?? DEFAULT_MAX_FILES;
    this.workspace =
      options.workspace ??
      new WorkspaceFileService(this.project.rootPath, this.maxFileBytes);
    if (!sameCanonicalRoot(this.project.rootPath, this.workspace.root)) {
      throw new Error(
        "The retrieval workspace must use the same canonical root.",
      );
    }
    this.search =
      options.search ??
      ({
        findFiles,
        searchText,
      } satisfies RetrievalSearch);
    this.database = new RetrievalDatabase(this.databasePath, this.project);
  }

  close(): void {
    this.database.close();
  }

  async indexProject(): Promise<RetrievalIndexReport> {
    const startedAt = Date.now();
    const existing = this.database.files();
    const seen = new Set<string>();
    const errors: RetrievalIndexReport["errors"] = [];
    let indexed = 0;
    let reused = 0;
    let ignored = 0;
    const discoveredPaths = await this.search.findFiles(
      this.project.rootPath,
      "*",
      this.maxFiles + 1,
    );
    if (discoveredPaths.length > this.maxFiles) {
      throw new Error(
        `Project contains more than the configured ${this.maxFiles} indexable files.`,
      );
    }

    for (const rawPath of discoveredPaths) {
      const path = normalizeRelativePath(rawPath);
      if (!path || shouldIgnore(path)) {
        ignored += 1;
        continue;
      }
      seen.add(path);
      try {
        const details = await stat(resolve(this.project.rootPath, path));
        if (!details.isFile() || details.size > this.maxFileBytes) {
          ignored += 1;
          continue;
        }
        const file = await this.workspace.readText(path);
        const prior = existing.get(path);
        if (prior?.hash === file.hash) {
          reused += 1;
          continue;
        }
        const language = languageForPath(path);
        const extracted = isTypeScript(path)
          ? extractTypeScript(path, file.content)
          : extractTextMetadata(file.content);
        this.database.replaceFile(
          {
            path,
            hash: file.hash,
            language,
            extractor: isTypeScript(path) ? "typescript" : "ripgrep-text",
            size: details.size,
            line_count: lineCount(file.content),
            modified_at: Math.trunc(details.mtimeMs),
            indexed_at: Date.now(),
          },
          extracted.symbols,
          extracted.edges,
        );
        indexed += 1;
      } catch (error) {
        errors.push({ path, message: errorMessage(error) });
      }
    }

    const deleted = this.database.deleteAbsent(seen);
    this.resolveModuleEdges();
    return {
      projectId: this.project.id,
      databasePath: this.databasePath,
      discovered: discoveredPaths.length,
      indexed,
      reused,
      deleted,
      ignored,
      errors,
      durationMs: Date.now() - startedAt,
    };
  }

  getFileMetadata(path: string): IndexedFileMetadata | undefined {
    return this.database.metadata(normalizeRelativePath(path));
  }

  async query(options: RetrievalQueryOptions): Promise<RetrievalQueryResult> {
    const query = options.query.trim();
    if (!query) throw new Error("Retrieval query must not be empty.");
    const limit = boundedInteger(options.limit, DEFAULT_LIMIT, 1, 50);
    const maxCandidates = boundedInteger(
      options.maxCandidates,
      DEFAULT_MAX_CANDIDATES,
      limit,
      2_000,
    );
    const maxSliceLines = boundedInteger(
      options.maxSliceLines,
      DEFAULT_MAX_SLICE_LINES,
      1,
      200,
    );
    const contextLines = boundedInteger(
      options.contextLines,
      DEFAULT_CONTEXT_LINES,
      0,
      20,
    );
    const index =
      options.refresh === false ? undefined : await this.indexProject();

    const primaryTerms = [query.toLowerCase()];
    let candidates = await this.collectCandidates(primaryTerms, maxCandidates);
    let strategy: RetrievalRecovery["strategy"] = "none";
    let attempted = false;
    if (candidates.size === 0) {
      const broadTerms = queryTerms(query);
      if (
        broadTerms.length > 0 &&
        (broadTerms.length > 1 || broadTerms[0] !== primaryTerms[0])
      ) {
        attempted = true;
        candidates = await this.collectCandidates(broadTerms, maxCandidates);
        if (candidates.size > 0) strategy = "broadened";
      }
    }

    const candidateCount = candidates.size;
    if (candidateCount === 0) {
      return {
        project: this.project,
        query,
        results: [],
        recovery: {
          strategy: "empty",
          attempted: true,
          candidateCount: 0,
          message:
            "No semantic, path, or text matches were found after broadening the query.",
        },
        index,
      };
    }

    const directPaths = [...candidates.values()]
      .sort(compareCandidates)
      .slice(0, 12)
      .map((candidate) => candidate.path);
    this.addGraphNeighbors(candidates, directPaths, maxCandidates);
    let ranked = mergeOverlapping(
      [...candidates.values()].sort(compareCandidates),
    );
    if (candidateCount > maxCandidates) {
      attempted = true;
      strategy = "narrowed";
      ranked = limitPerFile(ranked, 2);
    }

    const results: RetrievalSlice[] = [];
    for (const candidate of ranked) {
      if (results.length >= limit) break;
      const slice = await this.readSlice(
        candidate,
        maxSliceLines,
        contextLines,
      );
      if (slice) results.push(slice);
    }
    return {
      project: this.project,
      query,
      results,
      recovery: {
        strategy,
        attempted,
        candidateCount,
        ...(strategy === "narrowed"
          ? {
              message:
                "The query produced excessive matches, so results were ranked and capped per file.",
            }
          : strategy === "broadened"
            ? {
                message:
                  "The exact query had no matches, so identifier and prompt terms were searched separately.",
              }
            : {}),
      },
      index,
    };
  }

  private async collectCandidates(
    terms: string[],
    maxCandidates: number,
  ): Promise<Map<string, Candidate>> {
    const candidates = new Map<string, Candidate>();
    const fetchLimit = maxCandidates + 1;
    for (const symbol of this.database.symbols(terms, fetchLimit)) {
      const exact = terms.some(
        (term) => compactIdentifier(term) === compactIdentifier(symbol.name),
      );
      addCandidate(candidates, {
        path: symbol.path,
        language: symbol.language,
        startLine: symbol.start_line,
        endLine: symbol.end_line,
        score: exact ? 120 : symbol.exported === 1 ? 88 : 76,
        modifiedAt: symbol.modified_at,
        reasons: new Set([
          exact
            ? `exact ${symbol.kind} symbol match: ${symbol.name}`
            : `${symbol.kind} symbol match: ${symbol.name}`,
          ...(symbol.exported === 1 ? ["exported definition"] : []),
        ]),
        symbols: new Set([symbol.name]),
      });
    }
    for (const edge of this.database.edges(terms, fetchLimit)) {
      const score = edgeScore(edge.kind);
      addCandidate(candidates, {
        path: edge.source_path,
        language: edge.language,
        startLine: edge.line,
        endLine: edge.line,
        score,
        modifiedAt: edge.modified_at,
        reasons: new Set([
          `${edge.kind} edge to ${edge.target_name}`,
          ...(edge.module_specifier ? [`module ${edge.module_specifier}`] : []),
        ]),
        symbols: new Set(
          [edge.source_symbol, edge.target_name].filter(
            (value): value is string => Boolean(value),
          ),
        ),
      });
    }
    for (const file of this.database.paths(terms, fetchLimit)) {
      addCandidate(candidates, {
        path: file.path,
        language: file.language,
        startLine: 1,
        endLine: 1,
        score: 42,
        modifiedAt: file.modified_at,
        reasons: new Set(["file path match"]),
        symbols: new Set(),
      });
    }
    const pattern = terms.map(regexEscape).filter(Boolean).join("|");
    if (pattern) {
      try {
        const matches = await this.search.searchText({
          root: this.project.rootPath,
          pattern: `(?i:${pattern})`,
          maxResults: fetchLimit,
        });
        for (const match of matches) {
          const path = normalizeRelativePath(match.path);
          const file = this.database.file(path);
          if (!file) continue;
          addCandidate(candidates, {
            path,
            language: file.language,
            startLine: match.line,
            endLine: match.line,
            score: file.extractor === "ripgrep-text" ? 52 : 34,
            modifiedAt: file.modified_at,
            reasons: new Set([
              file.extractor === "ripgrep-text"
                ? "ripgrep fallback text match"
                : "source text match",
            ]),
            symbols: new Set(),
          });
        }
      } catch {
        // Persisted semantic and path results remain usable if ripgrep is unavailable.
      }
    }
    return candidates;
  }

  private addGraphNeighbors(
    candidates: Map<string, Candidate>,
    paths: string[],
    maxCandidates: number,
  ): void {
    for (const edge of this.database.neighbors(paths, maxCandidates + 1)) {
      if (!paths.includes(edge.source_path)) {
        addCandidate(candidates, graphCandidate(edge, edge.source_path));
      }
      if (edge.target_path && !paths.includes(edge.target_path)) {
        const target = this.database.file(edge.target_path);
        if (target) {
          addCandidate(candidates, {
            path: target.path,
            language: target.language,
            startLine: 1,
            endLine: 1,
            score: 20,
            modifiedAt: target.modified_at,
            reasons: new Set([
              `${edge.kind} graph neighbor from ${edge.source_path}`,
            ]),
            symbols: new Set([edge.target_name]),
          });
        }
      }
    }
  }

  private async readSlice(
    candidate: Candidate,
    maxSliceLines: number,
    contextLines: number,
  ): Promise<RetrievalSlice | undefined> {
    const indexed = this.database.file(candidate.path);
    if (!indexed) return undefined;
    let file;
    try {
      file = await this.workspace.readText(candidate.path);
    } catch {
      return undefined;
    }
    if (file.hash !== indexed.hash) return undefined;
    const lines = file.content.split(/\r?\n/);
    const requestedStart = Math.max(1, candidate.startLine - contextLines);
    const requestedEnd = Math.min(
      lines.length,
      candidate.endLine + contextLines,
    );
    let startLine = requestedStart;
    let endLine = Math.min(requestedEnd, startLine + maxSliceLines - 1);
    let truncated =
      startLine !== candidate.startLine ||
      endLine !== candidate.endLine ||
      requestedEnd > endLine;
    if (startLine === 1 && endLine === lines.length && lines.length > 1) {
      if (candidate.startLine > 1) startLine = 2;
      else endLine -= 1;
      truncated = true;
    }
    const ageDays = Math.max(0, Date.now() - candidate.modifiedAt) / 86_400_000;
    const recency = Math.max(0, 8 - Math.floor(ageDays));
    const reasons = [...candidate.reasons];
    if (recency > 0) reasons.push("recently modified file");
    return {
      path: candidate.path,
      language: candidate.language,
      startLine,
      endLine,
      content: lines.slice(startLine - 1, endLine).join("\n"),
      score: Math.round((candidate.score + recency) * 100) / 100,
      reasons,
      symbols: [...candidate.symbols],
      truncated,
    };
  }

  private resolveModuleEdges(): void {
    const paths = new Set(this.database.files().keys());
    for (const edge of this.database.moduleEdges()) {
      this.database.updateEdgeTarget(
        edge.id,
        resolveModulePath(edge.source_path, edge.module_specifier, paths),
      );
    }
  }
}

function graphCandidate(edge: StoredEdge, path: string): Candidate {
  return {
    path,
    language: edge.language,
    startLine: edge.line,
    endLine: edge.line,
    score: 18,
    modifiedAt: edge.modified_at,
    reasons: new Set([`${edge.kind} graph neighbor`]),
    symbols: new Set(
      [edge.source_symbol, edge.target_name].filter((value): value is string =>
        Boolean(value),
      ),
    ),
  };
}

function addCandidate(
  candidates: Map<string, Candidate>,
  candidate: Candidate,
): void {
  const key = `${candidate.path}:${candidate.startLine}:${candidate.endLine}`;
  const current = candidates.get(key);
  if (!current) {
    candidates.set(key, candidate);
    return;
  }
  current.score = Math.max(current.score, candidate.score) + 2;
  for (const reason of candidate.reasons) current.reasons.add(reason);
  for (const symbol of candidate.symbols) current.symbols.add(symbol);
}

function mergeOverlapping(candidates: Candidate[]): Candidate[] {
  const merged: Candidate[] = [];
  for (const candidate of candidates) {
    const overlap = merged.find(
      (item) =>
        item.path === candidate.path &&
        candidate.startLine <= item.endLine + 1 &&
        candidate.endLine >= item.startLine - 1,
    );
    if (!overlap) {
      merged.push(candidate);
      continue;
    }
    overlap.startLine = Math.min(overlap.startLine, candidate.startLine);
    overlap.endLine = Math.max(overlap.endLine, candidate.endLine);
    overlap.score = Math.max(overlap.score, candidate.score) + 1;
    for (const reason of candidate.reasons) overlap.reasons.add(reason);
    for (const symbol of candidate.symbols) overlap.symbols.add(symbol);
  }
  return merged.sort(compareCandidates);
}

function limitPerFile(candidates: Candidate[], maximum: number): Candidate[] {
  const counts = new Map<string, number>();
  return candidates.filter((candidate) => {
    const count = counts.get(candidate.path) ?? 0;
    if (count >= maximum) return false;
    counts.set(candidate.path, count + 1);
    return true;
  });
}

function compareCandidates(left: Candidate, right: Candidate): number {
  return (
    right.score - left.score ||
    right.modifiedAt - left.modifiedAt ||
    left.path.localeCompare(right.path) ||
    left.startLine - right.startLine
  );
}

function edgeScore(kind: StoredEdge["kind"]): number {
  switch (kind) {
    case "definition":
      return 72;
    case "call":
      return 64;
    case "import":
      return 58;
    case "export":
      return 54;
    case "reference":
      return 46;
  }
}

function queryTerms(query: string): string[] {
  const terms = query
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .toLowerCase()
    .match(/[a-z_$][\w$.-]*/g);
  return [...new Set((terms ?? []).filter((term) => term.length >= 2))].slice(
    0,
    12,
  );
}

function compactIdentifier(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9_$]/g, "");
}

function regexEscape(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function resolveModulePath(
  sourcePath: string,
  moduleSpecifier: string,
  paths: Set<string>,
): string | undefined {
  if (!moduleSpecifier.startsWith(".")) return undefined;
  const base = posix.normalize(
    posix.join(posix.dirname(sourcePath), moduleSpecifier),
  );
  const extension = posix.extname(base);
  const withoutJavaScriptExtension = /\.[cm]?jsx?$/.test(extension)
    ? base.slice(0, -extension.length)
    : base;
  const candidates = [
    base,
    `${withoutJavaScriptExtension}.ts`,
    `${withoutJavaScriptExtension}.tsx`,
    `${withoutJavaScriptExtension}.mts`,
    `${withoutJavaScriptExtension}.cts`,
    `${base}.js`,
    `${base}.jsx`,
    posix.join(base, "index.ts"),
    posix.join(base, "index.tsx"),
    posix.join(base, "index.js"),
  ];
  return candidates.find((candidate) => paths.has(candidate));
}

function normalizeRelativePath(path: string): string {
  const normalized = posix.normalize(
    path.replaceAll("\\", "/").replace(/^\.\//, ""),
  );
  if (
    normalized === "." ||
    normalized === ".." ||
    normalized.startsWith("../") ||
    normalized.startsWith("/")
  ) {
    return "";
  }
  return normalized;
}

function shouldIgnore(path: string): boolean {
  const segments = path.toLowerCase().split("/");
  if (
    segments.some((segment) =>
      [".git", "node_modules", "dist", "coverage", ".next", "target"].includes(
        segment,
      ),
    )
  ) {
    return true;
  }
  if (path.toLowerCase().startsWith(".agentic/data/")) return true;
  return [
    ".db",
    ".sqlite",
    ".png",
    ".jpg",
    ".jpeg",
    ".gif",
    ".webp",
    ".ico",
    ".pdf",
    ".zip",
    ".gz",
    ".wasm",
    ".exe",
    ".dll",
    ".so",
    ".lock",
  ].includes(extname(path).toLowerCase());
}

function isTypeScript(path: string): boolean {
  return [".ts", ".tsx", ".mts", ".cts"].includes(extname(path).toLowerCase());
}

function languageForPath(path: string): string {
  const extension = extname(path).toLowerCase();
  const languages: Record<string, string> = {
    ".ts": "typescript",
    ".tsx": "typescriptreact",
    ".mts": "typescript",
    ".cts": "typescript",
    ".js": "javascript",
    ".jsx": "javascriptreact",
    ".mjs": "javascript",
    ".cjs": "javascript",
    ".py": "python",
    ".rs": "rust",
    ".go": "go",
    ".java": "java",
    ".kt": "kotlin",
    ".cs": "csharp",
    ".c": "c",
    ".h": "c",
    ".cc": "cpp",
    ".cpp": "cpp",
    ".hpp": "cpp",
    ".rb": "ruby",
    ".php": "php",
    ".swift": "swift",
    ".sh": "shell",
    ".ps1": "powershell",
    ".sql": "sql",
    ".json": "json",
    ".md": "markdown",
    ".yaml": "yaml",
    ".yml": "yaml",
    ".toml": "toml",
    ".html": "html",
    ".css": "css",
    ".scss": "scss",
    ".vue": "vue",
    ".svelte": "svelte",
  };
  return languages[extension] ?? (extension.slice(1) || "text");
}

function lineCount(content: string): number {
  return content.length === 0 ? 1 : content.split(/\r?\n/).length;
}

function boundedInteger(
  value: number | undefined,
  fallback: number,
  minimum: number,
  maximum: number,
): number {
  const selected = value ?? fallback;
  if (!Number.isInteger(selected) || selected < minimum || selected > maximum) {
    throw new Error(`Expected an integer between ${minimum} and ${maximum}.`);
  }
  return selected;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
