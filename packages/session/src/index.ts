import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import type { ConversationMessage } from "@agentic-runtime/core";

export type SessionStatus =
  "idle" | "running" | "paused" | "completed" | "failed";

export type TaskStatus = SessionStatus | "queued";

export interface ProjectRecord {
  id: string;
  rootPath: string;
  createdAt: number;
  updatedAt: number;
}

export interface SessionRecord {
  id: string;
  projectId: string;
  title: string;
  status: SessionStatus;
  messages: ConversationMessage[];
  createdAt: number;
  updatedAt: number;
}

export interface TaskRecord {
  id: string;
  sessionId: string;
  prompt: string;
  status: TaskStatus;
  currentStage: string;
  state: Record<string, unknown>;
  createdAt: number;
  updatedAt: number;
}

export interface ContextItem {
  id: string;
  projectId: string;
  taskId?: string;
  source:
    | "user"
    | "instruction"
    | "file"
    | "search"
    | "tool_result"
    | "summary"
    | "handoff";
  content: string;
  filePath?: string;
  startLine?: number;
  endLine?: number;
  priority: "critical" | "high" | "normal" | "low";
  pinned: boolean;
  tokenEstimate: number;
  createdAt: number;
}

export interface SessionEvent {
  id?: string;
  sessionId: string;
  taskId?: string;
  runId?: string;
  type: string;
  payload: Record<string, unknown>;
  createdAt?: number;
}

export interface SessionStoreOptions {
  projectRoot: string;
  dataRoot?: string;
  globalDatabasePath?: string;
  projectDatabasePath?: string;
}

export class SessionStore {
  readonly project: ProjectRecord;
  readonly projectDatabasePath: string;
  readonly globalDatabasePath: string;
  private readonly projectDb: DatabaseSync;
  private readonly globalDb: DatabaseSync;

  constructor(options: SessionStoreOptions) {
    const rootPath = realpathSync(options.projectRoot);
    this.project = {
      id: projectId(rootPath),
      rootPath,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
    const dataRoot = options.dataRoot ?? defaultDataRoot();
    this.globalDatabasePath =
      options.globalDatabasePath ?? join(dataRoot, "global.db");
    this.projectDatabasePath =
      options.projectDatabasePath ??
      join(dataRoot, "projects", this.project.id, "project.db");
    mkdirSync(dirname(this.globalDatabasePath), { recursive: true });
    mkdirSync(dirname(this.projectDatabasePath), { recursive: true });
    this.globalDb = new DatabaseSync(this.globalDatabasePath);
    this.projectDb = new DatabaseSync(this.projectDatabasePath);
    initializeGlobalDatabase(this.globalDb);
    initializeProjectDatabase(this.projectDb);
    this.projectDb
      .prepare(
        `INSERT INTO projects (id, root_path, created_at, updated_at)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET root_path = excluded.root_path, updated_at = excluded.updated_at`,
      )
      .run(
        this.project.id,
        this.project.rootPath,
        this.project.createdAt,
        this.project.updatedAt,
      );
  }

  close(): void {
    this.projectDb.close();
    this.globalDb.close();
  }

  createSession(title = "New session"): SessionRecord {
    const now = Date.now();
    const session: SessionRecord = {
      id: randomId(),
      projectId: this.project.id,
      title,
      status: "idle",
      messages: [],
      createdAt: now,
      updatedAt: now,
    };
    this.projectDb
      .prepare(
        `INSERT INTO sessions (id, project_id, title, status, messages_json, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        session.id,
        session.projectId,
        session.title,
        session.status,
        JSON.stringify(session.messages),
        session.createdAt,
        session.updatedAt,
      );
    return session;
  }

  getSession(id: string): SessionRecord | undefined {
    const row = this.projectDb
      .prepare("SELECT * FROM sessions WHERE id = ? AND project_id = ?")
      .get(id, this.project.id) as SqliteSession | undefined;
    return row ? deserializeSession(row) : undefined;
  }

  latestSession(): SessionRecord | undefined {
    const row = this.projectDb
      .prepare(
        "SELECT * FROM sessions WHERE project_id = ? ORDER BY updated_at DESC LIMIT 1",
      )
      .get(this.project.id) as SqliteSession | undefined;
    return row ? deserializeSession(row) : undefined;
  }

  listSessions(): SessionRecord[] {
    const rows = this.projectDb
      .prepare(
        "SELECT * FROM sessions WHERE project_id = ? ORDER BY updated_at DESC",
      )
      .all(this.project.id) as unknown as SqliteSession[];
    return rows.map(deserializeSession);
  }

  saveMessages(sessionId: string, messages: ConversationMessage[]): void {
    this.updateSession(sessionId, { messages, status: "idle" });
  }

  updateSession(
    sessionId: string,
    update: Partial<Pick<SessionRecord, "title" | "status" | "messages">>,
  ): void {
    const fields: string[] = [];
    const values: SQLInputValue[] = [];
    if (update.title !== undefined) {
      fields.push("title = ?");
      values.push(update.title);
    }
    if (update.status !== undefined) {
      fields.push("status = ?");
      values.push(update.status);
    }
    if (update.messages !== undefined) {
      fields.push("messages_json = ?");
      values.push(JSON.stringify(update.messages));
    }
    if (fields.length === 0) return;
    fields.push("updated_at = ?");
    values.push(Date.now(), sessionId, this.project.id);
    this.projectDb
      .prepare(
        `UPDATE sessions SET ${fields.join(", ")} WHERE id = ? AND project_id = ?`,
      )
      .run(...values);
  }

  createTask(sessionId: string, prompt: string): TaskRecord {
    const now = Date.now();
    const task: TaskRecord = {
      id: randomId(),
      sessionId,
      prompt,
      status: "queued",
      currentStage: "queued",
      state: {
        objective: prompt,
        completedSteps: [],
        pendingSteps: [],
        changedFiles: [],
        errors: [],
        decisions: [],
      },
      createdAt: now,
      updatedAt: now,
    };
    this.projectDb
      .prepare(
        `INSERT INTO tasks (id, session_id, prompt, status, current_stage, state_json, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        task.id,
        task.sessionId,
        task.prompt,
        task.status,
        task.currentStage,
        JSON.stringify(task.state),
        task.createdAt,
        task.updatedAt,
      );
    return task;
  }

  updateTask(
    taskId: string,
    update: Partial<Pick<TaskRecord, "status" | "currentStage" | "state">>,
  ): void {
    const fields: string[] = [];
    const values: SQLInputValue[] = [];
    if (update.status !== undefined) {
      fields.push("status = ?");
      values.push(update.status);
    }
    if (update.currentStage !== undefined) {
      fields.push("current_stage = ?");
      values.push(update.currentStage);
    }
    if (update.state !== undefined) {
      fields.push("state_json = ?");
      values.push(JSON.stringify(update.state));
    }
    if (fields.length === 0) return;
    fields.push("updated_at = ?");
    values.push(Date.now(), taskId);
    this.projectDb
      .prepare(`UPDATE tasks SET ${fields.join(", ")} WHERE id = ?`)
      .run(...values);
  }

  appendEvent(event: SessionEvent): string {
    const id = event.id ?? randomId();
    this.projectDb
      .prepare(
        `INSERT INTO events (id, project_id, session_id, task_id, run_id, type, payload_json, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        this.project.id,
        event.sessionId,
        event.taskId ?? null,
        event.runId ?? null,
        event.type,
        JSON.stringify(event.payload),
        event.createdAt ?? Date.now(),
      );
    return id;
  }

  listEvents(sessionId: string): SessionEvent[] {
    const rows = this.projectDb
      .prepare(
        "SELECT * FROM events WHERE project_id = ? AND session_id = ? ORDER BY created_at, rowid",
      )
      .all(this.project.id, sessionId) as unknown as SqliteEvent[];
    return rows.map((row) => ({
      id: row.id,
      sessionId: row.session_id,
      taskId: row.task_id ?? undefined,
      runId: row.run_id ?? undefined,
      type: row.type,
      payload: JSON.parse(row.payload_json) as Record<string, unknown>,
      createdAt: row.created_at,
    }));
  }

  addContextItem(
    item: Omit<ContextItem, "id" | "projectId" | "createdAt">,
  ): ContextItem {
    const result: ContextItem = {
      ...item,
      id: randomId(),
      projectId: this.project.id,
      createdAt: Date.now(),
    };
    this.projectDb
      .prepare(
        `INSERT INTO context_items
         (id, project_id, task_id, source, content, file_path, start_line, end_line, priority, pinned, token_estimate, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        result.id,
        result.projectId,
        result.taskId ?? null,
        result.source,
        result.content,
        result.filePath ?? null,
        result.startLine ?? null,
        result.endLine ?? null,
        result.priority,
        result.pinned ? 1 : 0,
        result.tokenEstimate,
        result.createdAt,
      );
    return result;
  }

  listContextItems(taskId?: string): ContextItem[] {
    const rows = this.projectDb
      .prepare(
        `SELECT * FROM context_items WHERE project_id = ? AND (task_id IS NULL OR task_id = ?)
         ORDER BY pinned DESC, CASE priority WHEN 'critical' THEN 0 WHEN 'high' THEN 1 WHEN 'normal' THEN 2 ELSE 3 END, created_at DESC`,
      )
      .all(this.project.id, taskId ?? null) as unknown as SqliteContextItem[];
    return rows.map((row) => ({
      id: row.id,
      projectId: row.project_id,
      taskId: row.task_id ?? undefined,
      source: row.source as ContextItem["source"],
      content: row.content,
      filePath: row.file_path ?? undefined,
      startLine: row.start_line ?? undefined,
      endLine: row.end_line ?? undefined,
      priority: row.priority as ContextItem["priority"],
      pinned: row.pinned === 1,
      tokenEstimate: row.token_estimate,
      createdAt: row.created_at,
    }));
  }

  setGlobalSetting(key: string, value: string): void {
    this.globalDb
      .prepare(
        `INSERT INTO settings (key, value) VALUES (?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
      )
      .run(key, value);
  }

  getGlobalSetting(key: string): string | undefined {
    const row = this.globalDb
      .prepare("SELECT value FROM settings WHERE key = ?")
      .get(key) as { value?: string } | undefined;
    return row?.value;
  }

  buildContext(taskId: string | undefined, maxCharacters: number): string {
    const items = this.listContextItems(taskId);
    let remaining = maxCharacters;
    const selected: string[] = [];
    for (const item of items) {
      if (item.content.length > remaining && selected.length > 0) continue;
      selected.push(item.content);
      remaining -= item.content.length;
      if (remaining <= 0) break;
    }
    return selected.join("\n\n");
  }
}

export function loadProjectInstructions(rootPath: string): string[] {
  const paths = [
    join(rootPath, "AGENTS.md"),
    join(rootPath, "agent-context", "WORKSPACE.md"),
    join(rootPath, "agent-context", "ARCHITECTURE.md"),
  ];
  return paths
    .filter(existsSync)
    .map((path) => `## ${path}\n\n${readFileSync(path, "utf8")}`);
}

interface SqliteSession {
  id: string;
  project_id: string;
  title: string;
  status: SessionStatus;
  messages_json: string;
  created_at: number;
  updated_at: number;
}

interface SqliteEvent {
  id: string;
  session_id: string;
  task_id: string | null;
  run_id: string | null;
  type: string;
  payload_json: string;
  created_at: number;
}

interface SqliteContextItem {
  id: string;
  project_id: string;
  task_id: string | null;
  source: string;
  content: string;
  file_path: string | null;
  start_line: number | null;
  end_line: number | null;
  priority: string;
  pinned: number;
  token_estimate: number;
  created_at: number;
}

function deserializeSession(row: SqliteSession): SessionRecord {
  return {
    id: row.id,
    projectId: row.project_id,
    title: row.title,
    status: row.status,
    messages: JSON.parse(row.messages_json) as ConversationMessage[],
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function initializeGlobalDatabase(db: DatabaseSync): void {
  db.exec(`
    PRAGMA journal_mode = WAL;
    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS credential_references (
      provider_id TEXT PRIMARY KEY,
      secret_reference TEXT NOT NULL
    );
  `);
}

function initializeProjectDatabase(db: DatabaseSync): void {
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA foreign_keys = ON;
    CREATE TABLE IF NOT EXISTS projects (
      id TEXT PRIMARY KEY,
      root_path TEXT NOT NULL UNIQUE,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS sessions (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL REFERENCES projects(id),
      title TEXT NOT NULL,
      status TEXT NOT NULL,
      messages_json TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS tasks (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL REFERENCES sessions(id),
      prompt TEXT NOT NULL,
      status TEXT NOT NULL,
      current_stage TEXT NOT NULL,
      state_json TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS events (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL REFERENCES projects(id),
      session_id TEXT NOT NULL REFERENCES sessions(id),
      task_id TEXT REFERENCES tasks(id),
      run_id TEXT,
      type TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      created_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS context_items (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL REFERENCES projects(id),
      task_id TEXT REFERENCES tasks(id),
      source TEXT NOT NULL,
      content TEXT NOT NULL,
      file_path TEXT,
      start_line INTEGER,
      end_line INTEGER,
      priority TEXT NOT NULL,
      pinned INTEGER NOT NULL DEFAULT 0,
      token_estimate INTEGER NOT NULL,
      created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS sessions_project_updated ON sessions(project_id, updated_at DESC);
    CREATE INDEX IF NOT EXISTS events_session_created ON events(session_id, created_at);
    CREATE INDEX IF NOT EXISTS context_project_priority ON context_items(project_id, priority, pinned);
  `);
}

function projectId(rootPath: string): string {
  return createHash("sha256").update(rootPath).digest("hex").slice(0, 32);
}

function randomId(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;
}

function defaultDataRoot(): string {
  if (process.platform === "win32") {
    return join(
      process.env.LOCALAPPDATA ?? join(homedir(), "AppData", "Local"),
      "agentic-runtime",
    );
  }
  return join(
    process.env.XDG_DATA_HOME ?? join(homedir(), ".local", "share"),
    "agentic-runtime",
  );
}
