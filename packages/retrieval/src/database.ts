import { dirname } from "node:path";
import { mkdirSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import type {
  IndexedEdge,
  IndexedFileMetadata,
  IndexedSymbol,
  ProjectIdentity,
  RetrievalExtractor,
} from "./types.js";

export interface StoredFile {
  project_id: string;
  path: string;
  hash: string;
  language: string;
  extractor: RetrievalExtractor;
  size: number;
  line_count: number;
  modified_at: number;
  indexed_at: number;
}

export interface StoredSymbol {
  path: string;
  name: string;
  kind: string;
  start_line: number;
  end_line: number;
  exported: number;
  signature: string | null;
  language: string;
  modified_at: number;
}

export interface StoredEdge {
  source_path: string;
  source_symbol: string | null;
  target_path: string | null;
  target_name: string;
  kind: IndexedEdge["kind"];
  line: number;
  module_specifier: string | null;
  language: string;
  modified_at: number;
}

export class RetrievalDatabase {
  private closed = false;
  private readonly db: DatabaseSync;

  constructor(
    readonly path: string,
    private readonly project: ProjectIdentity,
  ) {
    mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.initialize();
    this.db
      .prepare(
        `INSERT INTO retrieval_projects (id, root_path, created_at, updated_at)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           root_path = excluded.root_path,
           updated_at = excluded.updated_at`,
      )
      .run(project.id, project.rootPath, Date.now(), Date.now());
  }

  /**
   * Idempotent: the index can be owned by a runtime that closes it and also
   * held by a caller that closes it too, and a second close should be a no-op
   * rather than an error that masks the real shutdown path.
   */
  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.db.close();
  }

  files(): Map<string, StoredFile> {
    const rows = this.db
      .prepare("SELECT * FROM retrieval_files WHERE project_id = ?")
      .all(this.project.id) as unknown as StoredFile[];
    return new Map(rows.map((row) => [row.path, row]));
  }

  file(path: string): StoredFile | undefined {
    return this.db
      .prepare(
        "SELECT * FROM retrieval_files WHERE project_id = ? AND path = ?",
      )
      .get(this.project.id, path) as StoredFile | undefined;
  }

  /**
   * Record a new stat for a file whose content hash did not change, so the
   * next index pass can skip reading it. Content-derived columns are untouched.
   */
  touchFile(path: string, modifiedAt: number, size: number): void {
    this.db
      .prepare(
        `UPDATE retrieval_files SET modified_at = ?, size = ?, indexed_at = ?
         WHERE project_id = ? AND path = ?`,
      )
      .run(modifiedAt, size, Date.now(), this.project.id, path);
  }

  replaceFile(
    file: Omit<StoredFile, "project_id">,
    symbols: IndexedSymbol[],
    edges: IndexedEdge[],
  ): void {
    this.transaction(() => {
      this.deleteFileData(file.path);
      this.db
        .prepare(
          `INSERT INTO retrieval_files
           (project_id, path, hash, language, extractor, size, line_count, modified_at, indexed_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          this.project.id,
          file.path,
          file.hash,
          file.language,
          file.extractor,
          file.size,
          file.line_count,
          file.modified_at,
          file.indexed_at,
        );
      const insertSymbol = this.db.prepare(
        `INSERT INTO retrieval_symbols
         (project_id, path, name, kind, start_line, end_line, exported, signature)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      );
      for (const symbol of symbols) {
        insertSymbol.run(
          this.project.id,
          file.path,
          symbol.name,
          symbol.kind,
          symbol.startLine,
          symbol.endLine,
          symbol.exported ? 1 : 0,
          symbol.signature ?? null,
        );
      }
      const insertEdge = this.db.prepare(
        `INSERT INTO retrieval_edges
         (project_id, source_path, source_symbol, target_path, target_name, kind, line, module_specifier)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      );
      for (const edge of edges) {
        insertEdge.run(
          this.project.id,
          file.path,
          edge.sourceSymbol ?? null,
          edge.targetPath ?? null,
          edge.targetName,
          edge.kind,
          edge.line,
          edge.moduleSpecifier ?? null,
        );
      }
    });
  }

  /**
   * Every indexed symbol, and every edge whose target names a known symbol.
   *
   * This is the whole project graph in one pass, which is what the Rust code
   * property graph is built from. Edges are resolved here rather than in the
   * sidecar because only SQLite knows which of several same-named symbols an
   * edge should attach to.
   */
  /**
   * The revision string a graph built from this index would carry.
   *
   * Cheap on purpose: two aggregates, no symbol scan. It exists so a caller can
   * decide whether a persisted graph is still current without paying to rebuild
   * the graph in order to find out.
   */
  graphRevisionStamp(): string {
    const stamp = this.db
      .prepare(
        `SELECT COUNT(*) AS files, COALESCE(MAX(indexed_at), 0) AS newest
         FROM retrieval_files WHERE project_id = ?`,
      )
      .get(this.project.id) as { files: number; newest: number };
    const symbols = this.db
      .prepare(
        "SELECT COUNT(*) AS total FROM retrieval_symbols WHERE project_id = ?",
      )
      .get(this.project.id) as { total: number };
    return `${stamp.files}:${stamp.newest}:${symbols.total}`;
  }

  graphSnapshot(): {
    nodes: Array<{
      symbol: string;
      path: string;
      start_line: number;
      end_line: number;
    }>;
    edges: Array<{ head: number; tail: number; kind: string }>;
    revision: string;
  } {
    const rows = this.db
      .prepare(
        `SELECT path, name, start_line, end_line FROM retrieval_symbols
         WHERE project_id = ? ORDER BY path, start_line, name`,
      )
      .all(this.project.id) as unknown as Array<{
      path: string;
      name: string;
      start_line: number;
      end_line: number;
    }>;
    const nodes = rows.map((row) => ({
      symbol: row.name,
      path: row.path,
      start_line: row.start_line,
      end_line: row.end_line,
    }));
    // A symbol name can be declared in several places; an edge points at all of
    // them, because deciding which one without type resolution would be a guess.
    const byName = new Map<string, number[]>();
    const byPath = new Map<string, number[]>();
    nodes.forEach((node, index) => {
      const name = node.symbol.toLowerCase();
      byName.set(name, [...(byName.get(name) ?? []), index]);
      byPath.set(node.path, [...(byPath.get(node.path) ?? []), index]);
    });

    const edgeRows = this.db
      .prepare(
        `SELECT source_path, source_symbol, target_name, kind FROM retrieval_edges
         WHERE project_id = ? AND kind IN ('call', 'import', 'reference')`,
      )
      .all(this.project.id) as unknown as Array<{
      source_path: string;
      source_symbol: string | null;
      target_name: string;
      kind: string;
    }>;

    const edges: Array<{ head: number; tail: number; kind: string }> = [];
    const seen = new Set<string>();
    for (const row of edgeRows) {
      const heads = row.source_symbol
        ? (byName.get(row.source_symbol.toLowerCase()) ?? [])
        : (byPath.get(row.source_path) ?? []);
      const tails = byName.get(row.target_name.toLowerCase()) ?? [];
      for (const head of heads) {
        for (const tail of tails) {
          if (head === tail) continue;
          const key = `${head}:${tail}:${row.kind}`;
          if (seen.has(key)) continue;
          seen.add(key);
          edges.push({ head, tail, kind: row.kind });
        }
      }
    }

    return { nodes, edges, revision: this.graphRevisionStamp() };
  }

  deleteAbsent(seenPaths: Set<string>): number {
    const stale = [...this.files().keys()].filter(
      (path) => !seenPaths.has(path),
    );
    if (stale.length === 0) return 0;
    this.transaction(() => {
      for (const path of stale) this.deleteFileData(path);
    });
    return stale.length;
  }

  metadata(path: string): IndexedFileMetadata | undefined {
    const file = this.file(path);
    if (!file) return undefined;
    const symbols = this.db
      .prepare(
        `SELECT name, kind, start_line, end_line, exported, signature
         FROM retrieval_symbols
         WHERE project_id = ? AND path = ?
         ORDER BY start_line, end_line, name`,
      )
      .all(this.project.id, path) as unknown as Array<{
      name: string;
      kind: string;
      start_line: number;
      end_line: number;
      exported: number;
      signature: string | null;
    }>;
    const edges = this.db
      .prepare(
        `SELECT kind, source_symbol, target_path, target_name, line, module_specifier
         FROM retrieval_edges
         WHERE project_id = ? AND source_path = ?
         ORDER BY line, kind, target_name`,
      )
      .all(this.project.id, path) as unknown as Array<{
      kind: IndexedEdge["kind"];
      source_symbol: string | null;
      target_path: string | null;
      target_name: string;
      line: number;
      module_specifier: string | null;
    }>;
    return {
      projectId: this.project.id,
      path: file.path,
      hash: file.hash,
      language: file.language,
      extractor: file.extractor,
      size: file.size,
      lineCount: file.line_count,
      modifiedAt: file.modified_at,
      indexedAt: file.indexed_at,
      symbols: symbols.map((symbol) => ({
        name: symbol.name,
        kind: symbol.kind,
        startLine: symbol.start_line,
        endLine: symbol.end_line,
        exported: symbol.exported === 1,
        signature: symbol.signature ?? undefined,
      })),
      edges: edges.map((edge) => ({
        kind: edge.kind,
        sourceSymbol: edge.source_symbol ?? undefined,
        targetPath: edge.target_path ?? undefined,
        targetName: edge.target_name,
        line: edge.line,
        moduleSpecifier: edge.module_specifier ?? undefined,
      })),
    };
  }

  symbols(terms: string[], limit: number): StoredSymbol[] {
    if (terms.length === 0) return [];
    const where = terms
      .map(() => "lower(s.name) LIKE ? ESCAPE '\\'")
      .join(" OR ");
    const values = terms.map((term) => `%${escapeLike(term.toLowerCase())}%`);
    return this.db
      .prepare(
        `SELECT s.path, s.name, s.kind, s.start_line, s.end_line, s.exported,
                s.signature, f.language, f.modified_at
         FROM retrieval_symbols s
         JOIN retrieval_files f ON f.project_id = s.project_id AND f.path = s.path
         WHERE s.project_id = ? AND (${where})
         ORDER BY s.exported DESC, length(s.name), s.path
         LIMIT ?`,
      )
      .all(this.project.id, ...values, limit) as unknown as StoredSymbol[];
  }

  edges(terms: string[], limit: number): StoredEdge[] {
    if (terms.length === 0) return [];
    const where = terms
      .map(
        () =>
          "(lower(e.target_name) LIKE ? ESCAPE '\\' OR lower(coalesce(e.module_specifier, '')) LIKE ? ESCAPE '\\')",
      )
      .join(" OR ");
    const values = terms.flatMap((term) => {
      const value = `%${escapeLike(term.toLowerCase())}%`;
      return [value, value];
    });
    return this.db
      .prepare(
        `SELECT e.source_path, e.source_symbol, e.target_path, e.target_name,
                e.kind, e.line, e.module_specifier, f.language, f.modified_at
         FROM retrieval_edges e
         JOIN retrieval_files f ON f.project_id = e.project_id AND f.path = e.source_path
         WHERE e.project_id = ? AND (${where})
         ORDER BY CASE e.kind
           WHEN 'definition' THEN 0 WHEN 'call' THEN 1 WHEN 'import' THEN 2
           WHEN 'export' THEN 3 ELSE 4 END, e.source_path, e.line
         LIMIT ?`,
      )
      .all(this.project.id, ...values, limit) as unknown as StoredEdge[];
  }

  paths(terms: string[], limit: number): StoredFile[] {
    if (terms.length === 0) return [];
    const where = terms
      .map(() => "lower(path) LIKE ? ESCAPE '\\'")
      .join(" OR ");
    const values = terms.map((term) => `%${escapeLike(term.toLowerCase())}%`);
    return this.db
      .prepare(
        `SELECT * FROM retrieval_files
         WHERE project_id = ? AND (${where})
         ORDER BY path LIMIT ?`,
      )
      .all(this.project.id, ...values, limit) as unknown as StoredFile[];
  }

  neighbors(paths: string[], limit: number): StoredEdge[] {
    if (paths.length === 0) return [];
    const placeholders = paths.map(() => "?").join(", ");
    return this.db
      .prepare(
        `SELECT e.source_path, e.source_symbol, e.target_path, e.target_name,
                e.kind, e.line, e.module_specifier, f.language, f.modified_at
         FROM retrieval_edges e
         JOIN retrieval_files f ON f.project_id = e.project_id AND f.path = e.source_path
         WHERE e.project_id = ? AND
           (e.source_path IN (${placeholders}) OR e.target_path IN (${placeholders}))
         ORDER BY e.source_path, e.line LIMIT ?`,
      )
      .all(
        this.project.id,
        ...paths,
        ...paths,
        limit,
      ) as unknown as StoredEdge[];
  }

  moduleEdges(): Array<{
    id: number;
    source_path: string;
    module_specifier: string;
  }> {
    return this.db
      .prepare(
        `SELECT id, source_path, module_specifier FROM retrieval_edges
         WHERE project_id = ? AND module_specifier IS NOT NULL`,
      )
      .all(this.project.id) as unknown as Array<{
      id: number;
      source_path: string;
      module_specifier: string;
    }>;
  }

  updateEdgeTarget(id: number, targetPath: string | undefined): void {
    this.db
      .prepare(
        "UPDATE retrieval_edges SET target_path = ? WHERE id = ? AND project_id = ?",
      )
      .run(targetPath ?? null, id, this.project.id);
  }

  private deleteFileData(path: string): void {
    this.db
      .prepare(
        "DELETE FROM retrieval_edges WHERE project_id = ? AND source_path = ?",
      )
      .run(this.project.id, path);
    this.db
      .prepare(
        "DELETE FROM retrieval_symbols WHERE project_id = ? AND path = ?",
      )
      .run(this.project.id, path);
    this.db
      .prepare("DELETE FROM retrieval_files WHERE project_id = ? AND path = ?")
      .run(this.project.id, path);
  }

  private transaction(action: () => void): void {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      action();
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  private initialize(): void {
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA foreign_keys = ON;
      CREATE TABLE IF NOT EXISTS retrieval_projects (
        id TEXT PRIMARY KEY,
        root_path TEXT NOT NULL UNIQUE,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS retrieval_files (
        project_id TEXT NOT NULL REFERENCES retrieval_projects(id),
        path TEXT NOT NULL,
        hash TEXT NOT NULL,
        language TEXT NOT NULL,
        extractor TEXT NOT NULL,
        size INTEGER NOT NULL,
        line_count INTEGER NOT NULL,
        modified_at INTEGER NOT NULL,
        indexed_at INTEGER NOT NULL,
        PRIMARY KEY (project_id, path)
      );
      CREATE TABLE IF NOT EXISTS retrieval_symbols (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        project_id TEXT NOT NULL,
        path TEXT NOT NULL,
        name TEXT NOT NULL,
        kind TEXT NOT NULL,
        start_line INTEGER NOT NULL,
        end_line INTEGER NOT NULL,
        exported INTEGER NOT NULL DEFAULT 0,
        signature TEXT,
        FOREIGN KEY (project_id, path) REFERENCES retrieval_files(project_id, path)
      );
      CREATE TABLE IF NOT EXISTS retrieval_edges (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        project_id TEXT NOT NULL,
        source_path TEXT NOT NULL,
        source_symbol TEXT,
        target_path TEXT,
        target_name TEXT NOT NULL,
        kind TEXT NOT NULL,
        line INTEGER NOT NULL,
        module_specifier TEXT,
        FOREIGN KEY (project_id, source_path) REFERENCES retrieval_files(project_id, path)
      );
      CREATE INDEX IF NOT EXISTS retrieval_symbols_name
        ON retrieval_symbols(project_id, name);
      CREATE INDEX IF NOT EXISTS retrieval_symbols_path
        ON retrieval_symbols(project_id, path, start_line);
      CREATE INDEX IF NOT EXISTS retrieval_edges_target
        ON retrieval_edges(project_id, target_name, kind);
      CREATE INDEX IF NOT EXISTS retrieval_edges_source
        ON retrieval_edges(project_id, source_path, line);
    `);
  }
}

function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, "\\$&");
}
