import { createHash } from "node:crypto";
import type { Dirent } from "node:fs";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join, relative } from "node:path";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import matter from "gray-matter";
import type {
  AgentDefinition,
  ConversationMessage,
  OrchestrationCheckpointStore,
  OrchestrationState,
} from "@agentic-runtime/core";

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
  sessionId?: string;
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

export interface TraceSpanRecord<
  TInput = unknown,
  TOutput = unknown,
  TContext = unknown,
  TUsage = unknown,
> {
  projectId: string;
  sessionId?: string;
  taskId?: string;
  traceId: string;
  spanId: string;
  parentSpanId?: string;
  kind: string;
  name: string;
  status: string;
  input?: TInput;
  output?: TOutput;
  context?: TContext;
  usage?: TUsage;
  cost?: number;
  startedAt: number;
  endedAt?: number;
  durationMs?: number;
  providerId?: string;
  modelId?: string;
  agentId?: string;
  stepId?: string;
  toolName?: string;
  error?: string;
}

export interface FinishTraceSpanUpdate<
  TOutput = unknown,
  TContext = unknown,
  TUsage = unknown,
> {
  status?: string;
  output?: TOutput;
  context?: TContext;
  usage?: TUsage;
  cost?: number;
  endedAt?: number;
  durationMs?: number;
  providerId?: string;
  modelId?: string;
  agentId?: string;
  stepId?: string;
  toolName?: string;
  error?: string;
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

  /** Run `action` atomically against the project database. */
  private transaction(action: () => void): void {
    this.projectDb.exec("BEGIN IMMEDIATE");
    try {
      action();
      this.projectDb.exec("COMMIT");
    } catch (error) {
      this.projectDb.exec("ROLLBACK");
      throw error;
    }
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

  /**
   * Remove a session and everything recorded under it.
   *
   * Tasks, events, context items, and trace spans reference the session, so
   * deleting only the session row would leave orphaned history that still shows
   * up in the dashboard. Done in one transaction so a failure cannot leave a
   * half-deleted conversation behind.
   */
  deleteSession(sessionId: string): boolean {
    let removed = false;
    this.transaction(() => {
      // Children first: events, context items, and trace spans all reference
      // tasks, and tasks reference the session. Trace spans are removed by
      // session rather than by task so spans that belong to no task - an
      // isolated /bytheway question, for instance - go with the conversation
      // instead of being orphaned in the dashboard.
      for (const table of ["trace_spans", "events", "context_items"]) {
        this.projectDb
          .prepare(
            `DELETE FROM ${table} WHERE session_id = ? AND project_id = ?`,
          )
          .run(sessionId, this.project.id);
      }
      // `tasks` carries no project_id of its own; it is scoped through the
      // session it belongs to, and the database file is per project.
      this.projectDb
        .prepare("DELETE FROM tasks WHERE session_id = ?")
        .run(sessionId);
      const result = this.projectDb
        .prepare("DELETE FROM sessions WHERE id = ? AND project_id = ?")
        .run(sessionId, this.project.id);
      removed = Number(result.changes) > 0;
    });
    return removed;
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

  getTask(taskId: string): TaskRecord | undefined {
    const row = this.projectDb
      .prepare(
        `SELECT tasks.* FROM tasks
         JOIN sessions ON sessions.id = tasks.session_id
         WHERE tasks.id = ? AND sessions.project_id = ?`,
      )
      .get(taskId, this.project.id) as SqliteTask | undefined;
    return row ? deserializeTask(row) : undefined;
  }

  listTasks(sessionId?: string): TaskRecord[] {
    const rows = sessionId
      ? (this.projectDb
          .prepare(
            `SELECT tasks.* FROM tasks
             JOIN sessions ON sessions.id = tasks.session_id
             WHERE sessions.project_id = ? AND tasks.session_id = ?
             ORDER BY tasks.updated_at DESC`,
          )
          .all(this.project.id, sessionId) as unknown as SqliteTask[])
      : (this.projectDb
          .prepare(
            `SELECT tasks.* FROM tasks
             JOIN sessions ON sessions.id = tasks.session_id
             WHERE sessions.project_id = ?
             ORDER BY tasks.updated_at DESC`,
          )
          .all(this.project.id) as unknown as SqliteTask[]);
    return rows.map(deserializeTask);
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
    const sessionId = this.resolveContextSessionId(item.sessionId, item.taskId);
    const result: ContextItem = {
      ...item,
      id: randomId(),
      projectId: this.project.id,
      sessionId,
      createdAt: Date.now(),
    };
    this.projectDb
      .prepare(
        `INSERT INTO context_items
         (id, project_id, session_id, task_id, source, content, file_path, start_line, end_line, priority, pinned, token_estimate, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        result.id,
        result.projectId,
        result.sessionId ?? null,
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

  listContextItems(): ContextItem[];
  listContextItems(taskId: string): ContextItem[];
  listContextItems(
    sessionId: string,
    taskId: string | undefined,
  ): ContextItem[];
  listContextItems(firstId?: string, taskId?: string): ContextItem[] {
    const sessionId =
      taskId !== undefined ||
      (firstId !== undefined && this.isSessionId(firstId))
        ? firstId
        : undefined;
    const resolvedTaskId = sessionId ? taskId : firstId;
    const rows = sessionId
      ? (this.projectDb
          .prepare(
            // An exact session match, deliberately. This previously also
            // matched `session_id IS NULL`, which would have made any
            // unscoped context item visible inside every conversation in the
            // project. Nothing writes such an item today, so the clause was
            // not leaking - but it made the isolation depend on every future
            // caller remembering to pass a session, which is exactly the kind
            // of guarantee that should not rest on discipline.
            `SELECT * FROM context_items
             WHERE project_id = ? AND session_id = ? AND (task_id IS NULL OR task_id = ?)
             ORDER BY pinned DESC, CASE priority WHEN 'critical' THEN 0 WHEN 'high' THEN 1 WHEN 'normal' THEN 2 ELSE 3 END, created_at DESC`,
          )
          .all(
            this.project.id,
            sessionId,
            resolvedTaskId ?? null,
          ) as unknown as SqliteContextItem[])
      : (this.projectDb
          .prepare(
            `SELECT * FROM context_items
             WHERE project_id = ? AND (task_id IS NULL OR task_id = ?)
             ORDER BY pinned DESC, CASE priority WHEN 'critical' THEN 0 WHEN 'high' THEN 1 WHEN 'normal' THEN 2 ELSE 3 END, created_at DESC`,
          )
          .all(
            this.project.id,
            resolvedTaskId ?? null,
          ) as unknown as SqliteContextItem[]);
    return rows.map(deserializeContextItem);
  }

  removeContextItem(itemId: string): boolean;
  removeContextItem(sessionId: string, itemId: string): boolean;
  removeContextItem(firstId: string, secondId?: string): boolean {
    if (!secondId) {
      const result = this.projectDb
        .prepare("DELETE FROM context_items WHERE id = ? AND project_id = ?")
        .run(firstId, this.project.id);
      return result.changes > 0;
    }

    const firstIsSession = this.isSessionId(firstId);
    const sessionId = firstIsSession ? firstId : secondId;
    const itemId = firstIsSession ? secondId : firstId;
    if (!firstIsSession && !this.isSessionId(sessionId)) return false;
    const result = this.projectDb
      .prepare(
        "DELETE FROM context_items WHERE id = ? AND project_id = ? AND session_id = ?",
      )
      .run(itemId, this.project.id, sessionId);
    return result.changes > 0;
  }

  startTraceSpan<
    TInput = unknown,
    TOutput = unknown,
    TContext = unknown,
    TUsage = unknown,
  >(
    span: Omit<
      TraceSpanRecord<TInput, TOutput, TContext, TUsage>,
      "projectId" | "status" | "startedAt" | "endedAt" | "durationMs"
    > &
      Partial<
        Pick<
          TraceSpanRecord<TInput, TOutput, TContext, TUsage>,
          "status" | "startedAt"
        >
      >,
  ): TraceSpanRecord<TInput, TOutput, TContext, TUsage> {
    const sessionId = this.resolveContextSessionId(span.sessionId, span.taskId);
    const result: TraceSpanRecord<TInput, TOutput, TContext, TUsage> = {
      ...span,
      projectId: this.project.id,
      sessionId,
      status: span.status ?? "running",
      startedAt: span.startedAt ?? Date.now(),
    };
    this.projectDb
      .prepare(
        `INSERT INTO trace_spans
         (project_id, session_id, task_id, trace_id, span_id, parent_span_id, kind, name, status, input_json, output_json, context_json, usage_json, cost, started_at, ended_at, duration_ms, provider_id, model_id, agent_id, step_id, tool_name, error)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        result.projectId,
        result.sessionId ?? null,
        result.taskId ?? null,
        result.traceId,
        result.spanId,
        result.parentSpanId ?? null,
        result.kind,
        result.name,
        result.status,
        serializeJson(result.input),
        serializeJson(result.output),
        serializeJson(result.context),
        serializeJson(result.usage),
        result.cost ?? null,
        result.startedAt,
        null,
        null,
        result.providerId ?? null,
        result.modelId ?? null,
        result.agentId ?? null,
        result.stepId ?? null,
        result.toolName ?? null,
        result.error ?? null,
      );
    return result;
  }

  finishTraceSpan<TOutput = unknown, TContext = unknown, TUsage = unknown>(
    traceId: string,
    spanId: string,
    update: FinishTraceSpanUpdate<TOutput, TContext, TUsage> = {},
  ): TraceSpanRecord<unknown, TOutput, TContext, TUsage> | undefined {
    const current = this.getTraceSpan<unknown, TOutput, TContext, TUsage>(
      traceId,
      spanId,
    );
    if (!current) return undefined;

    const endedAt = update.endedAt ?? Date.now();
    const durationMs = update.durationMs ?? endedAt - current.startedAt;
    const status = update.status ?? (update.error ? "failed" : "completed");
    this.projectDb
      .prepare(
        `UPDATE trace_spans SET
           status = ?, output_json = ?, context_json = ?, usage_json = ?, cost = ?,
           ended_at = ?, duration_ms = ?, provider_id = ?, model_id = ?, agent_id = ?,
           step_id = ?, tool_name = ?, error = ?
         WHERE project_id = ? AND trace_id = ? AND span_id = ?`,
      )
      .run(
        status,
        update.output === undefined
          ? serializeJson(current.output)
          : serializeJson(update.output),
        update.context === undefined
          ? serializeJson(current.context)
          : serializeJson(update.context),
        update.usage === undefined
          ? serializeJson(current.usage)
          : serializeJson(update.usage),
        update.cost ?? current.cost ?? null,
        endedAt,
        durationMs,
        update.providerId ?? current.providerId ?? null,
        update.modelId ?? current.modelId ?? null,
        update.agentId ?? current.agentId ?? null,
        update.stepId ?? current.stepId ?? null,
        update.toolName ?? current.toolName ?? null,
        update.error ?? current.error ?? null,
        this.project.id,
        traceId,
        spanId,
      );
    return this.getTraceSpan<unknown, TOutput, TContext, TUsage>(
      traceId,
      spanId,
    );
  }

  getTraceSpan<
    TInput = unknown,
    TOutput = unknown,
    TContext = unknown,
    TUsage = unknown,
  >(
    traceId: string,
    spanId: string,
  ): TraceSpanRecord<TInput, TOutput, TContext, TUsage> | undefined {
    const row = this.projectDb
      .prepare(
        "SELECT * FROM trace_spans WHERE project_id = ? AND trace_id = ? AND span_id = ?",
      )
      .get(this.project.id, traceId, spanId) as SqliteTraceSpan | undefined;
    return row
      ? deserializeTraceSpan<TInput, TOutput, TContext, TUsage>(row)
      : undefined;
  }

  listTraceSpans<
    TInput = unknown,
    TOutput = unknown,
    TContext = unknown,
    TUsage = unknown,
  >(
    traceId: string,
  ): Array<TraceSpanRecord<TInput, TOutput, TContext, TUsage>> {
    const rows = this.projectDb
      .prepare(
        `SELECT * FROM trace_spans
         WHERE project_id = ? AND trace_id = ?
         ORDER BY started_at, rowid`,
      )
      .all(this.project.id, traceId) as unknown as SqliteTraceSpan[];
    return rows.map((row) =>
      deserializeTraceSpan<TInput, TOutput, TContext, TUsage>(row),
    );
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

  clearGlobalSetting(key: string): void {
    this.globalDb.prepare("DELETE FROM settings WHERE key = ?").run(key);
  }

  /**
   * Provider credentials (API keys) are stored in the global, machine-local
   * SQLite database at the same trust level as the .env file they replace -
   * this is plaintext-at-rest, not OS-keychain-backed encryption. Treat the
   * global database file itself as the secret boundary.
   */
  setCredential(providerId: string, value: string): void {
    this.globalDb
      .prepare(
        `INSERT INTO credential_references (provider_id, secret_reference) VALUES (?, ?)
         ON CONFLICT(provider_id) DO UPDATE SET secret_reference = excluded.secret_reference`,
      )
      .run(providerId, value);
  }

  getCredential(providerId: string): string | undefined {
    const row = this.globalDb
      .prepare(
        "SELECT secret_reference FROM credential_references WHERE provider_id = ?",
      )
      .get(providerId) as { secret_reference?: string } | undefined;
    return row?.secret_reference;
  }

  clearCredential(providerId: string): void {
    this.globalDb
      .prepare("DELETE FROM credential_references WHERE provider_id = ?")
      .run(providerId);
  }

  listCredentialProviderIds(): string[] {
    const rows = this.globalDb
      .prepare("SELECT provider_id FROM credential_references")
      .all() as unknown as Array<{ provider_id: string }>;
    return rows.map((row) => row.provider_id);
  }

  setProviderSetting(providerId: string, key: string, value: string): void {
    this.setGlobalSetting(`provider.${providerId}.${key}`, value);
  }

  getProviderSetting(providerId: string, key: string): string | undefined {
    return this.getGlobalSetting(`provider.${providerId}.${key}`);
  }

  clearProviderSetting(providerId: string, key: string): void {
    this.clearGlobalSetting(`provider.${providerId}.${key}`);
  }

  registerAgent(agent: AgentDefinition): AgentDefinition {
    const now = Date.now();
    this.projectDb
      .prepare(
        `INSERT INTO agents
         (id, name, description, system_prompt, capabilities_json, allowed_tools_json, delegates_to, max_steps, enabled, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           name = excluded.name,
           description = excluded.description,
           system_prompt = excluded.system_prompt,
           capabilities_json = excluded.capabilities_json,
           allowed_tools_json = excluded.allowed_tools_json,
           delegates_to = excluded.delegates_to,
           max_steps = excluded.max_steps,
           enabled = excluded.enabled,
           updated_at = excluded.updated_at`,
      )
      .run(
        agent.id,
        agent.name,
        agent.description,
        agent.systemPrompt,
        JSON.stringify(agent.capabilities),
        agent.allowedTools ? JSON.stringify(agent.allowedTools) : null,
        agent.delegatesTo ?? null,
        agent.maxSteps ?? null,
        agent.enabled ? 1 : 0,
        now,
        now,
      );
    return agent;
  }

  updateAgent(
    id: string,
    updates: Partial<Omit<AgentDefinition, "id">>,
  ): AgentDefinition {
    const current = this.getAgent(id);
    if (!current) throw new Error(`Agent not found: ${id}`);
    return this.registerAgent({ ...current, ...updates, id });
  }

  getAgent(id: string): AgentDefinition | undefined {
    const row = this.projectDb
      .prepare("SELECT * FROM agents WHERE id = ?")
      .get(id) as SqliteAgent | undefined;
    return row ? deserializeAgent(row) : undefined;
  }

  listAgents(): AgentDefinition[] {
    const rows = this.projectDb
      .prepare("SELECT * FROM agents ORDER BY name, id")
      .all() as unknown as SqliteAgent[];
    return rows.map(deserializeAgent);
  }

  removeAgent(id: string): boolean {
    const result = this.projectDb
      .prepare("DELETE FROM agents WHERE id = ?")
      .run(id);
    return result.changes > 0;
  }

  buildContext(taskId: string | undefined, maxCharacters: number): string;
  buildContext(
    sessionId: string,
    taskId: string | undefined,
    maxCharacters: number,
  ): string;
  buildContext(
    firstId: string | undefined,
    taskIdOrMaxCharacters: string | number | undefined,
    scopedMaxCharacters?: number,
  ): string {
    const scoped = scopedMaxCharacters !== undefined;
    const items = scoped
      ? this.listContextItems(
          firstId as string,
          taskIdOrMaxCharacters as string | undefined,
        )
      : this.listContextItems(firstId as string);
    let remaining = scoped
      ? scopedMaxCharacters
      : (taskIdOrMaxCharacters as number);
    const selected: string[] = [];
    for (const item of items) {
      if (item.content.length > remaining && selected.length > 0) continue;
      selected.push(item.content);
      remaining -= item.content.length;
      if (remaining <= 0) break;
    }
    return selected.join("\n\n");
  }

  private isSessionId(id: string): boolean {
    return this.projectDb
      .prepare("SELECT 1 FROM sessions WHERE id = ? AND project_id = ?")
      .get(id, this.project.id)
      ? true
      : false;
  }

  private resolveContextSessionId(
    sessionId: string | undefined,
    taskId: string | undefined,
  ): string | undefined {
    if (!taskId) {
      if (sessionId && !this.isSessionId(sessionId)) {
        throw new Error(`Session not found: ${sessionId}`);
      }
      return sessionId;
    }

    const task = this.getTask(taskId);
    if (!task) throw new Error(`Task not found: ${taskId}`);
    if (sessionId && sessionId !== task.sessionId) {
      throw new Error(
        `Task ${taskId} does not belong to session ${sessionId}.`,
      );
    }
    return task.sessionId;
  }
}

export function createTaskCheckpointStore(
  store: SessionStore,
  taskId: string,
): OrchestrationCheckpointStore {
  return {
    async load() {
      const task = store.getTask(taskId);
      const checkpoint = task?.state.orchestration;
      return isOrchestrationState(checkpoint) ? checkpoint : undefined;
    },
    async save(state) {
      const task = store.getTask(taskId);
      if (!task) throw new Error(`Task not found: ${taskId}`);
      const status =
        state.stage === "completed"
          ? "completed"
          : state.stage === "failed"
            ? "failed"
            : state.stage === "paused"
              ? "paused"
              : "running";
      store.updateTask(taskId, {
        status,
        currentStage: state.stage,
        state: { ...task.state, orchestration: state },
      });
      store.updateSession(task.sessionId, { status });
    },
  };
}

/** Directories never worth walking when looking for nested rule files. */
const INSTRUCTION_SCAN_IGNORES: ReadonlySet<string> = new Set([
  ".git",
  ".agentic",
  ".runtime-data",
  ".pnpm-store",
  "node_modules",
  "dist",
  "dist-tests",
  "build",
  "out",
  "target",
  ".next",
  ".turbo",
  ".cache",
  "coverage",
  "vendor",
]);

const MAX_INSTRUCTION_DEPTH = 4;
const MAX_INSTRUCTION_FILES = 24;

/**
 * Collects every `AGENTS.md` in the project, nearest-to-root first.
 *
 * The protocol is scoped: a rule file applies to the directory it sits in and
 * everything under it, so a monorepo package can state conventions that differ
 * from the root. Each file keeps its path as a heading, which is what lets an
 * agent tell which rules govern the file it is editing. The walk is bounded in
 * depth and count so a deep tree cannot flood the system prompt.
 */
export function loadProjectInstructions(rootPath: string): string[] {
  const found: string[] = [];
  const walk = (directory: string, depth: number): void => {
    if (
      depth > MAX_INSTRUCTION_DEPTH ||
      found.length >= MAX_INSTRUCTION_FILES
    ) {
      return;
    }
    const path = join(directory, "AGENTS.md");
    if (existsSync(path)) {
      const scope = relative(rootPath, directory).replaceAll("\\", "/") || ".";
      found.push(
        `## AGENTS.md (applies to ${scope === "." ? "the whole project" : `${scope}/ and below`})\n\n${readFileSync(path, "utf8")}`,
      );
    }
    let entries: Dirent[];
    try {
      entries = readdirSync(directory, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (!entry.isDirectory() || INSTRUCTION_SCAN_IGNORES.has(entry.name)) {
        continue;
      }
      walk(join(directory, entry.name), depth + 1);
    }
  };
  walk(rootPath, 0);
  return found;
}

export function loadProjectAgents(rootPath: string): AgentDefinition[] {
  const agentsPath = join(rootPath, ".agentic", "agents");
  if (!existsSync(agentsPath)) return [];

  return readdirSync(agentsPath, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(".md"))
    .sort((left, right) => left.name.localeCompare(right.name))
    .map((entry) => parseAgentFile(join(agentsPath, entry.name)));
}

function parseAgentFile(path: string): AgentDefinition {
  const parsed = matter(readFileSync(path, "utf8"));
  const data = parsed.data as Record<string, unknown>;
  const id = requireAgentField(data, "id", path);
  const name = requireAgentField(data, "name", path);
  const description = requireAgentField(data, "description", path);
  const systemPrompt = parsed.content.trim();
  if (!systemPrompt) throw new Error(`Agent file has an empty prompt: ${path}`);

  const maxSteps = data.maxSteps;
  if (
    maxSteps !== undefined &&
    (typeof maxSteps !== "number" ||
      !Number.isInteger(maxSteps) ||
      maxSteps < 1)
  ) {
    throw new Error(`Agent file has an invalid maxSteps value: ${path}`);
  }

  return {
    id,
    name,
    description,
    systemPrompt,
    capabilities: stringList(data.capabilities),
    allowedTools: stringList(data.allowedTools),
    ...(typeof data.delegatesTo === "string" && data.delegatesTo.trim()
      ? { delegatesTo: data.delegatesTo.trim() }
      : {}),
    ...(typeof maxSteps === "number" ? { maxSteps } : {}),
    enabled: data.enabled !== false,
  };
}

function requireAgentField(
  data: Record<string, unknown>,
  field: string,
  path: string,
): string {
  const value = data[field];
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`Agent file requires a non-empty ${field}: ${path}`);
  }
  return value.trim();
}

function stringList(value: unknown): string[] {
  if (value === undefined) return [];
  const values = Array.isArray(value) ? value : [value];
  if (values.some((item) => typeof item !== "string" || !item.trim())) {
    throw new Error(
      "Agent capabilities and allowedTools must contain strings.",
    );
  }
  return [...new Set(values.map((item) => (item as string).trim()))];
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

interface SqliteTask {
  id: string;
  session_id: string;
  prompt: string;
  status: TaskStatus;
  current_stage: string;
  state_json: string;
  created_at: number;
  updated_at: number;
}

interface SqliteAgent {
  id: string;
  name: string;
  description: string;
  system_prompt: string;
  capabilities_json: string;
  allowed_tools_json: string | null;
  delegates_to: string | null;
  max_steps: number | null;
  enabled: number;
  created_at: number;
  updated_at: number;
}

interface SqliteContextItem {
  id: string;
  project_id: string;
  session_id: string | null;
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

interface SqliteTraceSpan {
  project_id: string;
  session_id: string | null;
  task_id: string | null;
  trace_id: string;
  span_id: string;
  parent_span_id: string | null;
  kind: string;
  name: string;
  status: string;
  input_json: string | null;
  output_json: string | null;
  context_json: string | null;
  usage_json: string | null;
  cost: number | null;
  started_at: number;
  ended_at: number | null;
  duration_ms: number | null;
  provider_id: string | null;
  model_id: string | null;
  agent_id: string | null;
  step_id: string | null;
  tool_name: string | null;
  error: string | null;
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

function deserializeTask(row: SqliteTask): TaskRecord {
  return {
    id: row.id,
    sessionId: row.session_id,
    prompt: row.prompt,
    status: row.status,
    currentStage: row.current_stage,
    state: JSON.parse(row.state_json) as Record<string, unknown>,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function deserializeAgent(row: SqliteAgent): AgentDefinition {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    systemPrompt: row.system_prompt,
    capabilities: JSON.parse(row.capabilities_json) as string[],
    allowedTools: row.allowed_tools_json
      ? (JSON.parse(row.allowed_tools_json) as string[])
      : undefined,
    ...(row.delegates_to ? { delegatesTo: row.delegates_to } : {}),
    maxSteps: row.max_steps ?? undefined,
    enabled: row.enabled === 1,
  };
}

function deserializeContextItem(row: SqliteContextItem): ContextItem {
  return {
    id: row.id,
    projectId: row.project_id,
    sessionId: row.session_id ?? undefined,
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
  };
}

function deserializeTraceSpan<TInput, TOutput, TContext, TUsage>(
  row: SqliteTraceSpan,
): TraceSpanRecord<TInput, TOutput, TContext, TUsage> {
  return {
    projectId: row.project_id,
    sessionId: row.session_id ?? undefined,
    taskId: row.task_id ?? undefined,
    traceId: row.trace_id,
    spanId: row.span_id,
    parentSpanId: row.parent_span_id ?? undefined,
    kind: row.kind,
    name: row.name,
    status: row.status,
    input: deserializeJson<TInput>(row.input_json),
    output: deserializeJson<TOutput>(row.output_json),
    context: deserializeJson<TContext>(row.context_json),
    usage: deserializeJson<TUsage>(row.usage_json),
    cost: row.cost ?? undefined,
    startedAt: row.started_at,
    endedAt: row.ended_at ?? undefined,
    durationMs: row.duration_ms ?? undefined,
    providerId: row.provider_id ?? undefined,
    modelId: row.model_id ?? undefined,
    agentId: row.agent_id ?? undefined,
    stepId: row.step_id ?? undefined,
    toolName: row.tool_name ?? undefined,
    error: row.error ?? undefined,
  };
}

function serializeJson(value: unknown): string | null {
  if (value === undefined) return null;
  const serialized = JSON.stringify(value);
  if (serialized === undefined) {
    throw new Error("Trace span fields must contain JSON-serializable values.");
  }
  return serialized;
}

function deserializeJson<T>(value: string | null): T | undefined {
  return value === null ? undefined : (JSON.parse(value) as T);
}

function isOrchestrationState(value: unknown): value is OrchestrationState {
  if (!value || typeof value !== "object") return false;
  const state = value as Partial<OrchestrationState>;
  return (
    typeof state.runId === "string" &&
    typeof state.objective === "string" &&
    typeof state.stage === "string" &&
    Array.isArray(state.completedStepIds) &&
    typeof state.results === "object" &&
    typeof state.attempts === "object" &&
    typeof state.totalAttempts === "number" &&
    typeof state.startedAt === "number" &&
    typeof state.updatedAt === "number"
  );
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
  // Agent definitions used to live here. They are per-project memory - a
  // project can ship its own agents under .agentic/agents - so a global table
  // let one codebase's agents appear in another. They now live in the project
  // database; this drop removes the shared copy on first open.
  db.exec("DROP TABLE IF EXISTS agents");
}

function initializeProjectDatabase(db: DatabaseSync): void {
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA foreign_keys = ON;
    CREATE TABLE IF NOT EXISTS agents (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      description TEXT NOT NULL,
      system_prompt TEXT NOT NULL,
      capabilities_json TEXT NOT NULL,
      allowed_tools_json TEXT,
      delegates_to TEXT,
      max_steps INTEGER,
      enabled INTEGER NOT NULL DEFAULT 1,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
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
      session_id TEXT REFERENCES sessions(id),
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
    CREATE TABLE IF NOT EXISTS trace_spans (
      project_id TEXT NOT NULL REFERENCES projects(id),
      session_id TEXT REFERENCES sessions(id),
      task_id TEXT REFERENCES tasks(id),
      trace_id TEXT NOT NULL,
      span_id TEXT NOT NULL,
      parent_span_id TEXT,
      kind TEXT NOT NULL,
      name TEXT NOT NULL,
      status TEXT NOT NULL,
      input_json TEXT,
      output_json TEXT,
      context_json TEXT,
      usage_json TEXT,
      cost REAL,
      started_at INTEGER NOT NULL,
      ended_at INTEGER,
      duration_ms INTEGER,
      provider_id TEXT,
      model_id TEXT,
      agent_id TEXT,
      step_id TEXT,
      tool_name TEXT,
      error TEXT,
      PRIMARY KEY (project_id, trace_id, span_id)
    );
    CREATE INDEX IF NOT EXISTS sessions_project_updated ON sessions(project_id, updated_at DESC);
    CREATE INDEX IF NOT EXISTS events_session_created ON events(session_id, created_at);
    CREATE INDEX IF NOT EXISTS context_project_priority ON context_items(project_id, priority, pinned);
    CREATE INDEX IF NOT EXISTS trace_project_trace_started ON trace_spans(project_id, trace_id, started_at);
  `);
  migrateContextItemSessions(db);
  db.exec(
    "CREATE INDEX IF NOT EXISTS context_session_priority ON context_items(project_id, session_id, priority, pinned)",
  );
}

function migrateContextItemSessions(db: DatabaseSync): void {
  if (!tableHasColumn(db, "agents", "delegates_to")) {
    db.exec("ALTER TABLE agents ADD COLUMN delegates_to TEXT");
  }
  if (!tableHasColumn(db, "context_items", "session_id")) {
    db.exec(
      "ALTER TABLE context_items ADD COLUMN session_id TEXT REFERENCES sessions(id)",
    );
  }
  db.exec(`
    UPDATE context_items
    SET session_id = (
      SELECT tasks.session_id FROM tasks WHERE tasks.id = context_items.task_id
    )
    WHERE session_id IS NULL AND task_id IS NOT NULL
  `);
}

function tableHasColumn(
  db: DatabaseSync,
  tableName: string,
  columnName: string,
): boolean {
  const rows = db
    .prepare(`PRAGMA table_info(${tableName})`)
    .all() as unknown as Array<{ name: string }>;
  return rows.some((row) => row.name === columnName);
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
