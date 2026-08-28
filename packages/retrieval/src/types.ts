export type RetrievalExtractor = "typescript" | "ripgrep-text";

export type RetrievalEdgeKind =
  "definition" | "reference" | "call" | "import" | "export";

export interface ProjectIdentity {
  id: string;
  rootPath: string;
}

export interface ProjectPersistenceContext {
  project: {
    id: string;
    rootPath: string;
  };
  projectDatabasePath: string;
}

export interface RetrievalWorkspaceFile {
  path: string;
  content: string;
  hash: string;
}

export interface RetrievalWorkspace {
  readonly root: string;
  readText(path: string): Promise<RetrievalWorkspaceFile>;
}

export interface RetrievalSearchMatch {
  path: string;
  line: number;
  column: number;
  text: string;
}

export interface RetrievalSearch {
  findFiles(
    root: string,
    pattern?: string,
    maxResults?: number,
  ): Promise<string[]>;
  searchText(options: {
    root: string;
    pattern: string;
    glob?: string;
    maxResults?: number;
  }): Promise<RetrievalSearchMatch[]>;
}

export interface RetrievalIndexOptions {
  root: string;
  databasePath?: string;
  projectContext?: ProjectPersistenceContext;
  workspace?: RetrievalWorkspace;
  search?: RetrievalSearch;
  maxFileBytes?: number;
  maxFiles?: number;
}

export interface RetrievalIndexReport {
  projectId: string;
  databasePath: string;
  discovered: number;
  indexed: number;
  reused: number;
  deleted: number;
  ignored: number;
  errors: Array<{ path: string; message: string }>;
  durationMs: number;
}

export interface IndexedSymbol {
  name: string;
  kind: string;
  startLine: number;
  endLine: number;
  exported: boolean;
  signature?: string;
}

export interface IndexedEdge {
  kind: RetrievalEdgeKind;
  sourceSymbol?: string;
  targetPath?: string;
  targetName: string;
  line: number;
  moduleSpecifier?: string;
}

export interface IndexedFileMetadata {
  projectId: string;
  path: string;
  hash: string;
  language: string;
  extractor: RetrievalExtractor;
  size: number;
  lineCount: number;
  modifiedAt: number;
  indexedAt: number;
  symbols: IndexedSymbol[];
  edges: IndexedEdge[];
}

export interface RetrievalQueryOptions {
  query: string;
  limit?: number;
  maxCandidates?: number;
  maxSliceLines?: number;
  contextLines?: number;
  refresh?: boolean;
}

export interface RetrievalSlice {
  path: string;
  language: string;
  startLine: number;
  endLine: number;
  content: string;
  score: number;
  reasons: string[];
  symbols: string[];
  truncated: boolean;
}

export interface RetrievalRecovery {
  strategy: "none" | "broadened" | "narrowed" | "empty";
  attempted: boolean;
  candidateCount: number;
  message?: string;
}

export interface RetrievalQueryResult {
  project: ProjectIdentity;
  query: string;
  results: RetrievalSlice[];
  recovery: RetrievalRecovery;
  index?: RetrievalIndexReport;
}

export interface ExtractedFile {
  symbols: IndexedSymbol[];
  edges: IndexedEdge[];
}
