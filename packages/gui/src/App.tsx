import { useCallback, useEffect, useRef, useState } from "react";
import {
  Activity,
  Bot,
  Boxes,
  ChevronLeft,
  ChevronRight,
  ChevronUp,
  CircleDot,
  Clock3,
  Code2,
  Database,
  ExternalLink,
  File,
  FileCode2,
  Folder,
  FolderOpen,
  GitBranch,
  KeyRound,
  LayoutDashboard,
  PanelBottomClose,
  PanelBottomOpen,
  Plus,
  RefreshCw,
  Search,
  Send,
  Settings,
  ShieldCheck,
  Sparkles,
  Square,
  TerminalSquare,
  Trash2,
  X,
  Zap,
} from "lucide-react";
import * as monaco from "monaco-editor";
import editorWorker from "monaco-editor/esm/vs/editor/editor.worker?worker";
import jsonWorker from "monaco-editor/esm/vs/language/json/json.worker?worker";
import cssWorker from "monaco-editor/esm/vs/language/css/css.worker?worker";
import htmlWorker from "monaco-editor/esm/vs/language/html/html.worker?worker";
import tsWorker from "monaco-editor/esm/vs/language/typescript/ts.worker?worker";

self.MonacoEnvironment = {
  getWorker(_workerId: string, label: string) {
    if (label === "json") return new jsonWorker();
    if (["css", "scss", "less"].includes(label)) return new cssWorker();
    if (["html", "handlebars", "razor"].includes(label))
      return new htmlWorker();
    if (["typescript", "javascript"].includes(label)) return new tsWorker();
    return new editorWorker();
  },
};

type Section = "explorer" | "search" | "agents" | "dashboard" | "settings";
type BottomTab = "problems" | "output" | "terminal";

interface ProjectView {
  id: string;
  name: string;
  rootPath: string;
}

interface FileEntry {
  name: string;
  path: string;
  type: "file" | "directory";
  size?: number;
}

interface OpenFileView {
  path: string;
  content: string;
  savedContent: string;
  hash: string;
}

interface TerminalResultView {
  command: string;
  profileId: string;
  profileLabel: string;
  cwd: string;
  output: string;
  exitCode: number;
  timedOut: boolean;
  truncated: boolean;
}

interface TerminalProfileView {
  id: string;
  label: string;
}

interface SessionView {
  id: string;
  title: string;
  status: string;
  updatedAt: number;
  messages: ConversationMessageView[];
}

interface ConversationMessageView {
  role: "user" | "assistant" | "system" | "tool";
  content: string;
  toolName?: string;
  metadata?: {
    taskId?: string;
    thinking?: string[];
  };
}

interface TaskView {
  id: string;
  sessionId: string;
  prompt: string;
  status: string;
  currentStage: string;
  updatedAt: number;
}

interface AgentView {
  id: string;
  name: string;
  description: string;
  enabled: boolean;
}

interface TraceSpan {
  traceId: string;
  spanId: string;
  parentSpanId?: string;
  kind: string;
  name: string;
  status: string;
  input?: unknown;
  output?: unknown;
  context?: unknown;
  usage?: unknown;
  cost?: number;
  startedAt: number;
  durationMs?: number;
  providerId?: string;
  modelId?: string;
  agentId?: string;
  toolName?: string;
  error?: string;
}

interface ContextItem {
  id: string;
  filePath?: string;
  startLine?: number;
  endLine?: number;
  tokenEstimate: number;
}

interface ProviderView {
  id: string;
  label: string;
  fields: Array<"apiKey" | "baseUrl" | "manualModelId">;
  credentialRequired: boolean;
  helpUrl?: string;
  description?: string;
  defaultModelId?: string;
  modelOptions?: string[];
  hasCredential: boolean;
  maskedCredential?: string;
  baseUrl?: string;
  manualModelId?: string;
  lastValidation?: { ok: boolean; message?: string; at: number };
}

interface WorkbenchResponse {
  project: ProjectView;
  sessions: SessionView[];
  tasks: TaskView[];
  agents: AgentView[];
}

interface RuntimeRouteView {
  providerId: string;
  label: string;
  modelId: string;
  configured: boolean;
  selected: boolean;
}

interface RuntimeApprovalView {
  requestId: string;
  sessionId: string;
  taskId: string;
  agentId: string;
  call: { id: string; name: string; arguments: Record<string, unknown> };
  preview?: unknown;
}

interface RuntimeStatusView {
  ready: boolean;
  connected: boolean;
  providerId: string;
  modelId: string;
  routes: RuntimeRouteView[];
  activeTaskIds: string[];
  pendingApprovals: RuntimeApprovalView[];
}

interface RuntimeEventView {
  type: string;
  sessionId: string;
  taskId?: string;
  prompt?: string;
  agentId?: string;
  error?: string;
  request?: RuntimeApprovalView;
  requestId?: string;
  event?: Record<string, unknown>;
  result?: {
    text: string;
    status: string;
  };
}

interface LiveTurn {
  taskId: string;
  sessionId: string;
  prompt: string;
  response?: string;
  thinking: string[];
  status: "running" | "completed" | "failed" | "paused";
}

const languageByExtension: Record<string, string> = {
  ts: "typescript",
  tsx: "typescript",
  js: "javascript",
  jsx: "javascript",
  json: "json",
  html: "html",
  css: "css",
  md: "markdown",
  yml: "yaml",
  yaml: "yaml",
  sh: "shell",
  py: "python",
  rs: "rust",
  go: "go",
};

async function requestJson<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, init);
  const body = (await response.json().catch(() => ({}))) as T & {
    error?: string;
  };
  if (!response.ok)
    throw new Error(body.error ?? `Request failed (${response.status}).`);
  return body;
}

function runtimeThinkingLabel(event: RuntimeEventView): string | undefined {
  const detail = event.event;
  const type = stringField(detail, "type");
  if (event.type === "routing_event" && type === "routing_attempt_started") {
    const provider = stringField(detail, "providerId");
    const model = stringField(detail, "modelId");
    return provider && model ? `Selected ${provider} / ${model}` : undefined;
  }
  if (event.type === "pipeline_event") {
    const role = stringField(detail, "role");
    const step = titleCaseLabel(
      role ?? stringField(detail, "stepId") ?? "stage",
    );
    if (type === "step_started") return `${step} started`;
    if (type === "step_completed") return `${step} completed`;
    if (type === "step_retrying") return `${step} retrying`;
    if (type === "step_recovering") return `${step} recovering`;
  }
  if (event.type === "orchestration_event") {
    const agent = titleCaseLabel(stringField(detail, "agentId") ?? "agent");
    if (type === "agent_started") return `${agent} started`;
    if (type === "agent_completed") return `${agent} completed`;
    if (type === "handoff_requested") {
      const target = stringField(detail, "targetAgentId");
      return target ? `Delegating to ${target}` : "Delegating work";
    }
    const agentEvent = recordField(detail, "agentEvent");
    const agentEventType = stringField(agentEvent, "type");
    if (agentEventType === "tool_requested") {
      const call = recordField(agentEvent, "call");
      const tool = stringField(call, "name");
      return tool ? `Using ${tool}` : undefined;
    }
    if (agentEventType === "tool_completed") {
      const call = recordField(agentEvent, "call");
      const tool = stringField(call, "name");
      return tool ? `Completed ${tool}` : undefined;
    }
    if (agentEventType === "context_compacted") {
      return "Compacted conversation context";
    }
  }
  if (event.type === "approval_requested" && event.request) {
    return `Waiting for approval: ${event.request.call.name}`;
  }
  if (event.type === "approval_resolved") return "Tool approval resolved";
  return undefined;
}

function recordField(
  value: Record<string, unknown> | undefined,
  key: string,
): Record<string, unknown> | undefined {
  const field = value?.[key];
  return field && typeof field === "object"
    ? (field as Record<string, unknown>)
    : undefined;
}

function stringField(
  value: Record<string, unknown> | undefined,
  key: string,
): string | undefined {
  const field = value?.[key];
  return typeof field === "string" && field.trim() ? field.trim() : undefined;
}

function titleCaseLabel(value: string): string {
  return value
    .replace(/-/gu, " ")
    .replace(/\b\w/gu, (character: string) => character.toLocaleUpperCase());
}

function languageForPath(path: string): string {
  return (
    languageByExtension[path.split(".").pop()?.toLowerCase() ?? ""] ??
    "plaintext"
  );
}

function formatDuration(milliseconds?: number): string {
  if (milliseconds === undefined) return "running";
  if (milliseconds < 1000) return `${milliseconds}ms`;
  return `${(milliseconds / 1000).toFixed(milliseconds < 10_000 ? 1 : 0)}s`;
}

function shortDate(timestamp: number): string {
  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(timestamp);
}

function StatusDot({ status }: { status: string }) {
  const tone =
    status === "completed"
      ? "bg-emerald-400"
      : status === "failed"
        ? "bg-rose-400"
        : status === "running"
          ? "bg-indigo-400 animate-pulse"
          : "bg-neutral-600";
  return <span className={`inline-block size-1.5 rounded-full ${tone}`} />;
}

function IconButton({
  label,
  active,
  onClick,
  children,
}: {
  label: string;
  active?: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      onClick={onClick}
      className={`group relative flex h-11 w-12 items-center justify-center border-l-2 transition duration-75 hover:bg-white/5 hover:text-neutral-200 ${
        active
          ? "border-indigo-400 bg-white/[0.035] text-neutral-200"
          : "border-transparent text-neutral-600"
      }`}
    >
      {children}
    </button>
  );
}

function MonacoPane({
  file,
  onPosition,
  onChange,
  onSave,
}: {
  file?: OpenFileView;
  onPosition: (line: number, column: number) => void;
  onChange: (content: string) => void;
  onSave: () => void;
}) {
  const host = useRef<HTMLDivElement>(null);
  const editor = useRef<monaco.editor.IStandaloneCodeEditor | null>(null);
  const models = useRef(new Map<string, monaco.editor.ITextModel>());
  const onPositionRef = useRef(onPosition);
  const onChangeRef = useRef(onChange);
  const onSaveRef = useRef(onSave);

  useEffect(() => {
    onPositionRef.current = onPosition;
    onChangeRef.current = onChange;
    onSaveRef.current = onSave;
  }, [onChange, onPosition, onSave]);

  useEffect(() => {
    if (!host.current) return;
    editor.current = monaco.editor.create(host.current, {
      theme: "vs-dark",
      readOnly: false,
      automaticLayout: true,
      minimap: { enabled: true, scale: 0.75, showSlider: "mouseover" },
      fontFamily: "'JetBrains Mono', 'Cascadia Code', Consolas, monospace",
      fontSize: 13,
      lineHeight: 21,
      padding: { top: 12 },
      scrollBeyondLastLine: false,
      renderLineHighlight: "gutter",
      overviewRulerBorder: false,
      wordWrap: "off",
    });
    const subscription = editor.current.onDidChangeCursorPosition((event) =>
      onPositionRef.current(event.position.lineNumber, event.position.column),
    );
    const changeSubscription = editor.current.onDidChangeModelContent(() => {
      onChangeRef.current(editor.current?.getValue() ?? "");
    });
    editor.current.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () =>
      onSaveRef.current(),
    );
    const currentModels = models.current;
    return () => {
      subscription.dispose();
      changeSubscription.dispose();
      editor.current?.dispose();
      currentModels.forEach((model) => model.dispose());
      currentModels.clear();
    };
  }, []);

  useEffect(() => {
    if (!file || !editor.current) return;
    let model = models.current.get(file.path);
    if (!model) {
      model = monaco.editor.createModel(
        file.content,
        languageForPath(file.path),
        monaco.Uri.file(file.path),
      );
      models.current.set(file.path, model);
    }
    if (model.getValue() !== file.content) model.setValue(file.content);
    editor.current.setModel(model);
  }, [file]);

  return <div ref={host} className="h-full min-h-0 w-full bg-canvas" />;
}

export function App() {
  const [section, setSection] = useState<Section>("explorer");
  const [workbench, setWorkbench] = useState<WorkbenchResponse>();
  const [connectionError, setConnectionError] = useState<string>();
  const [entries, setEntries] = useState<FileEntry[]>([]);
  const [folderPath, setFolderPath] = useState(".");
  const [openFiles, setOpenFiles] = useState<OpenFileView[]>([]);
  const [activePath, setActivePath] = useState<string>();
  const [line, setLine] = useState(1);
  const [column, setColumn] = useState(1);
  const [bottomOpen, setBottomOpen] = useState(true);
  const [bottomTab, setBottomTab] = useState<BottomTab>("output");
  const [selectedSessionId, setSelectedSessionId] = useState<string>();
  const [selectedAgentId, setSelectedAgentId] = useState<string>();
  const [context, setContext] = useState<ContextItem[]>([]);
  const [notice, setNotice] = useState("Workbench ready");
  const [runtimeStatus, setRuntimeStatus] = useState<RuntimeStatusView>();
  const [runtimeError, setRuntimeError] = useState<string>();
  const [liveTurns, setLiveTurns] = useState<LiveTurn[]>([]);
  const [pendingApproval, setPendingApproval] = useState<RuntimeApprovalView>();
  const [composerText, setComposerText] = useState("");
  const [submitting, setSubmitting] = useState(false);

  const appendThinking = useCallback((taskId: string, detail: string) => {
    setLiveTurns((current) =>
      current.map((turn) =>
        turn.taskId === taskId && !turn.thinking.includes(detail)
          ? {
              ...turn,
              thinking: [...turn.thinking, detail].slice(-40),
            }
          : turn,
      ),
    );
  }, []);

  const refreshWorkbench = useCallback(async () => {
    try {
      const data = await requestJson<WorkbenchResponse>("/api/workbench");
      setWorkbench(data);
      setConnectionError(undefined);
      setSelectedSessionId((current) => current ?? data.sessions[0]?.id);
      setSelectedAgentId(
        (current) => current ?? data.agents.find((agent) => agent.enabled)?.id,
      );
    } catch (error) {
      setConnectionError(
        error instanceof Error ? error.message : String(error),
      );
    }
  }, []);

  const loadRuntimeStatus = useCallback(async () => {
    try {
      const body = await requestJson<{ runtime: RuntimeStatusView }>(
        "/api/runtime/status",
      );
      setRuntimeStatus(body.runtime);
      setRuntimeError(undefined);
    } catch (error) {
      setRuntimeError(error instanceof Error ? error.message : String(error));
    }
  }, []);

  const loadFolder = useCallback(async (path: string) => {
    try {
      const body = await requestJson<{ entries: FileEntry[] }>(
        `/api/files?path=${encodeURIComponent(path)}`,
      );
      setEntries(body.entries);
      setFolderPath(path);
    } catch (error) {
      setNotice(error instanceof Error ? error.message : String(error));
    }
  }, []);

  useEffect(() => {
    void refreshWorkbench();
    void loadFolder(".");
    void loadRuntimeStatus();
  }, [loadFolder, loadRuntimeStatus, refreshWorkbench]);

  useEffect(() => {
    const openTerminal = () => {
      setBottomOpen(true);
      setBottomTab("terminal");
    };
    window.addEventListener("agentic:open-terminal", openTerminal);
    return () =>
      window.removeEventListener("agentic:open-terminal", openTerminal);
  }, []);

  useEffect(() => {
    setPendingApproval(
      runtimeStatus?.pendingApprovals.find(
        (request) => request.sessionId === selectedSessionId,
      ),
    );
  }, [runtimeStatus, selectedSessionId]);

  useEffect(() => {
    if (!selectedSessionId) return;
    const source = new EventSource(
      `/api/runtime/events?sessionId=${encodeURIComponent(selectedSessionId)}`,
    );
    source.onopen = () => setRuntimeError(undefined);
    source.onerror = () =>
      setRuntimeError("Runtime event stream reconnecting…");
    source.onmessage = (message) => {
      let event: RuntimeEventView;
      try {
        event = JSON.parse(message.data) as RuntimeEventView;
      } catch {
        return;
      }
      if (event.type === "task_started" && event.taskId && event.prompt) {
        setLiveTurns((current) =>
          current.some((turn) => turn.taskId === event.taskId)
            ? current
            : [
                ...current,
                {
                  taskId: event.taskId!,
                  sessionId: event.sessionId,
                  prompt: event.prompt!,
                  thinking: [],
                  status: "running",
                },
              ],
        );
        setNotice(`Agent ${event.agentId ?? "runtime"} is working…`);
      } else if (event.type === "approval_requested" && event.request) {
        setPendingApproval(event.request);
        setNotice(`Approval required for ${event.request.call.name}`);
      } else if (event.type === "approval_resolved") {
        setPendingApproval((current) =>
          current?.requestId === event.requestId ? undefined : current,
        );
      } else if (event.type === "routing_event") {
        const provider = String(event.event?.providerId ?? "provider");
        const model = String(event.event?.modelId ?? "model");
        setNotice(`Routing through ${provider}/${model}`);
      } else if (event.type === "pipeline_event") {
        const stage = String(
          event.event?.stepId ?? event.event?.type ?? "pipeline",
        );
        setNotice(`Pipeline: ${stage}`);
      } else if (event.type === "task_completed" && event.taskId) {
        setLiveTurns((current) =>
          current.map((turn) =>
            turn.taskId === event.taskId
              ? {
                  ...turn,
                  response: event.result?.text ?? "Task completed.",
                  status: "completed",
                }
              : turn,
          ),
        );
        setNotice("Agent task completed");
        void Promise.all([refreshWorkbench(), loadRuntimeStatus()]).then(() =>
          setLiveTurns((current) =>
            current.filter((turn) => turn.taskId !== event.taskId),
          ),
        );
      } else if (
        (event.type === "task_failed" || event.type === "task_paused") &&
        event.taskId
      ) {
        const status = event.type === "task_paused" ? "paused" : "failed";
        const rawResponse =
          event.error ?? event.result?.text ?? `Task ${status}.`;
        const response =
          status === "failed" &&
          rawResponse === "fetch failed" &&
          runtimeStatus?.providerId === "ollama"
            ? "Could not reach Ollama. Start the Ollama service, then validate Ollama in Settings and try again."
            : rawResponse;
        setLiveTurns((current) =>
          current.map((turn) =>
            turn.taskId === event.taskId ? { ...turn, response, status } : turn,
          ),
        );
        setNotice(response);
        void Promise.all([refreshWorkbench(), loadRuntimeStatus()]);
      }
      const thinking = runtimeThinkingLabel(event);
      if (event.taskId && thinking) appendThinking(event.taskId, thinking);
    };
    return () => source.close();
  }, [
    loadRuntimeStatus,
    appendThinking,
    refreshWorkbench,
    runtimeStatus?.providerId,
    selectedSessionId,
  ]);

  useEffect(() => {
    const runningTaskIds = liveTurns
      .filter((turn) => turn.status === "running")
      .map((turn) => turn.taskId);
    if (runningTaskIds.length === 0) return;
    let checking = false;
    const interval = window.setInterval(() => {
      if (checking) return;
      checking = true;
      void Promise.all(
        runningTaskIds.map((taskId) =>
          requestJson<{ task: TaskView }>(
            `/api/tasks/${encodeURIComponent(taskId)}`,
          ).catch(() => undefined),
        ),
      )
        .then(async (results) => {
          const terminal = results.filter(
            (result) => result && result.task.status !== "running",
          );
          if (terminal.length === 0) return;
          await Promise.all([refreshWorkbench(), loadRuntimeStatus()]);
          setLiveTurns((current) =>
            current
              .map((turn) => {
                const snapshot = terminal.find(
                  (result) => result?.task.id === turn.taskId,
                )?.task;
                if (!snapshot) return turn;
                if (snapshot.status === "completed") return undefined;
                return {
                  ...turn,
                  status: snapshot.status === "paused" ? "paused" : "failed",
                  response:
                    snapshot.status === "paused"
                      ? "Task paused."
                      : "Task failed. Open Observability for the recorded error.",
                } as LiveTurn;
              })
              .filter((turn): turn is LiveTurn => Boolean(turn)),
          );
        })
        .finally(() => {
          checking = false;
        });
    }, 1_200);
    return () => window.clearInterval(interval);
  }, [liveTurns, loadRuntimeStatus, refreshWorkbench]);

  const loadContext = useCallback(async (sessionId: string) => {
    try {
      const body = await requestJson<{ items: ContextItem[] }>(
        `/api/context?sessionId=${encodeURIComponent(sessionId)}`,
      );
      setContext(body.items);
    } catch {
      setContext([]);
    }
  }, []);

  useEffect(() => {
    if (selectedSessionId) void loadContext(selectedSessionId);
    else setContext([]);
  }, [loadContext, selectedSessionId]);

  const openFile = useCallback(async (path: string) => {
    setSection("explorer");
    setActivePath(path);
    setOpenFiles((current) =>
      current.some((file) => file.path === path) ? current : current,
    );
    try {
      const body = await requestJson<{ content: string; hash: string }>(
        `/api/files/content?path=${encodeURIComponent(path)}`,
      );
      setOpenFiles((current) => {
        const existing = current.find((item) => item.path === path);
        return existing
          ? current.map((item) =>
              item.path === path
                ? {
                    path,
                    content: body.content,
                    savedContent: body.content,
                    hash: body.hash,
                  }
                : item,
            )
          : [
              ...current,
              {
                path,
                content: body.content,
                savedContent: body.content,
                hash: body.hash,
              },
            ];
      });
    } catch (error) {
      setNotice(error instanceof Error ? error.message : String(error));
    }
  }, []);

  const updateOpenFile = useCallback((path: string, content: string) => {
    setOpenFiles((current) =>
      current.map((file) => (file.path === path ? { ...file, content } : file)),
    );
  }, []);

  const saveOpenFile = useCallback(
    async (path: string) => {
      const file = openFiles.find((candidate) => candidate.path === path);
      if (!file || file.content === file.savedContent) return;
      try {
        const body = await requestJson<{
          file: { path: string; content: string; hash: string };
        }>("/api/files/content", {
          method: "PUT",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            path: file.path,
            content: file.content,
            expectedHash: file.hash,
          }),
        });
        setOpenFiles((current) =>
          current.map((candidate) =>
            candidate.path === path
              ? {
                  ...candidate,
                  content: body.file.content,
                  savedContent: body.file.content,
                  hash: body.file.hash,
                }
              : candidate,
          ),
        );
        setNotice(`Saved ${path}`);
      } catch (error) {
        setNotice(error instanceof Error ? error.message : String(error));
      }
    },
    [openFiles],
  );

  const openFolder = useCallback(async () => {
    try {
      await requestJson("/api/desktop/open-folder", { method: "POST" });
      setNotice("Opening the native folder picker…");
    } catch (error) {
      setNotice(error instanceof Error ? error.message : String(error));
    }
  }, []);

  const closeFile = (path: string) => {
    setOpenFiles((current) => {
      const index = current.findIndex((file) => file.path === path);
      const next = current.filter((file) => file.path !== path);
      if (activePath === path)
        setActivePath(next[Math.max(0, index - 1)]?.path);
      return next;
    });
  };

  const addActiveFileToContext = async () => {
    if (!activePath) return;
    try {
      const sessionId = selectedSessionId ?? (await createSession());
      await requestJson("/api/context", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          sessionId,
          path: activePath,
        }),
      });
      await loadContext(sessionId);
      setNotice(`Pinned ${activePath} to session context`);
    } catch (error) {
      setNotice(error instanceof Error ? error.message : String(error));
    }
  };

  const removeContext = async (itemId: string) => {
    if (!selectedSessionId) return;
    await requestJson(
      `/api/context/${encodeURIComponent(itemId)}?sessionId=${encodeURIComponent(selectedSessionId)}`,
      { method: "DELETE" },
    );
    await loadContext(selectedSessionId);
  };

  const createSession = async () => {
    const body = await requestJson<{ session: SessionView }>("/api/sessions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title: "IDE session" }),
    });
    await refreshWorkbench();
    setSelectedSessionId(body.session.id);
    setNotice("Created a durable project session");
    return body.session.id;
  };

  const startTask = async () => {
    const prompt = composerText.trim();
    if (!prompt || submitting) return;
    setSubmitting(true);
    try {
      const sessionId = selectedSessionId ?? (await createSession());
      if (!selectedAgentId) throw new Error("Select an enabled agent.");
      const body = await requestJson<{
        sessionId: string;
        taskId: string;
      }>("/api/tasks", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          sessionId,
          agentId: selectedAgentId,
          prompt,
        }),
      });
      setLiveTurns((current) =>
        current.some((turn) => turn.taskId === body.taskId)
          ? current
          : [
              ...current,
              {
                taskId: body.taskId,
                sessionId,
                prompt,
                thinking: [],
                status: "running",
              },
            ],
      );
      setComposerText("");
      setNotice("Task submitted to the agent runtime");
      await loadRuntimeStatus();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setNotice(message);
      setRuntimeError(message);
    } finally {
      setSubmitting(false);
    }
  };

  const cancelTask = async (taskId: string) => {
    try {
      await requestJson(`/api/tasks/${encodeURIComponent(taskId)}/cancel`, {
        method: "POST",
      });
      setNotice("Cancellation requested");
    } catch (error) {
      setNotice(error instanceof Error ? error.message : String(error));
    }
  };

  const resolveApproval = async (approved: boolean) => {
    if (!pendingApproval) return;
    try {
      await requestJson(
        `/api/approvals/${encodeURIComponent(pendingApproval.requestId)}`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ approved }),
        },
      );
      setPendingApproval(undefined);
      setNotice(approved ? "Tool action approved" : "Tool action denied");
    } catch (error) {
      setNotice(error instanceof Error ? error.message : String(error));
    }
  };

  const configureRuntime = async (providerId: string) => {
    try {
      const body = await requestJson<{ runtime: RuntimeStatusView }>(
        "/api/runtime/config",
        {
          method: "PUT",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ providerId }),
        },
      );
      setRuntimeStatus(body.runtime);
      setRuntimeError(undefined);
      setNotice(`Runtime provider set to ${body.runtime.providerId}`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setRuntimeError(message);
      setNotice(message);
    }
  };

  const activeFile = openFiles.find((file) => file.path === activePath);
  const language = activePath ? languageForPath(activePath) : "plaintext";

  return (
    <div className="flex h-screen w-full flex-col overflow-hidden bg-canvas text-neutral-300">
      <div className="flex h-9 shrink-0 items-center border-b border-white/5 bg-panel px-3 text-xs">
        <div className="flex w-[284px] items-center gap-2 font-medium text-neutral-300">
          <div className="flex size-5 items-center justify-center rounded-sm bg-indigo-500/10 text-indigo-400">
            <Sparkles size={13} />
          </div>
          <span>Agentic IDE</span>
          <span className="text-neutral-700">/</span>
          <button
            type="button"
            onClick={() => void openFolder()}
            className="truncate text-neutral-500 hover:text-neutral-300"
            title="Open another folder"
          >
            {workbench?.project.name ?? "workspace"}
          </button>
        </div>
        <button
          type="button"
          className="mx-auto flex h-6 w-[420px] items-center justify-center gap-2 rounded-sm border border-white/5 bg-black/20 text-neutral-500 transition duration-75 hover:bg-white/5 hover:text-neutral-300"
          onClick={() => setSection("search")}
        >
          <Search size={12} /> Search files and symbols <kbd>Ctrl K</kbd>
        </button>
        <div className="flex w-[284px] justify-end gap-3 text-neutral-600">
          <span className="flex items-center gap-1.5">
            <GitBranch size={12} /> main
          </span>
          <span className="flex items-center gap-1.5 text-emerald-500/80">
            <CircleDot size={10} /> local
          </span>
        </div>
      </div>

      <div className="flex min-h-0 flex-1">
        <nav className="flex w-12 shrink-0 flex-col justify-between border-r border-white/5 bg-[#0d0d0d]">
          <div>
            <IconButton
              label="Explorer"
              active={section === "explorer"}
              onClick={() => setSection("explorer")}
            >
              <FolderOpen size={20} />
            </IconButton>
            <IconButton
              label="Search"
              active={section === "search"}
              onClick={() => setSection("search")}
            >
              <Search size={20} />
            </IconButton>
            <IconButton
              label="Agents"
              active={section === "agents"}
              onClick={() => setSection("agents")}
            >
              <Bot size={20} />
            </IconButton>
            <IconButton
              label="Observability"
              active={section === "dashboard"}
              onClick={() => setSection("dashboard")}
            >
              <LayoutDashboard size={20} />
            </IconButton>
          </div>
          <div>
            <IconButton
              label="Settings"
              active={section === "settings"}
              onClick={() => setSection("settings")}
            >
              <Settings size={20} />
            </IconButton>
          </div>
        </nav>

        <aside className="flex w-[260px] shrink-0 flex-col border-r border-white/5 bg-panel">
          <SidebarHeader
            section={section}
            onRefresh={() => void refreshWorkbench()}
          />
          {section === "explorer" && (
            <ExplorerPanel
              entries={entries}
              path={folderPath}
              projectName={workbench?.project.name ?? "workspace"}
              onOpen={openFile}
              onFolder={loadFolder}
              onOpenFolder={() => void openFolder()}
            />
          )}
          {section === "search" && <SearchPanel onOpen={openFile} />}
          {section === "agents" && (
            <AgentsPanel agents={workbench?.agents ?? []} />
          )}
          {section === "dashboard" && (
            <TaskList tasks={workbench?.tasks ?? []} />
          )}
          {section === "settings" && <SettingsSummary />}
        </aside>

        <main className="flex min-w-0 flex-1 flex-col bg-canvas">
          {section === "dashboard" ? (
            <Dashboard tasks={workbench?.tasks ?? []} />
          ) : section === "settings" ? (
            <ProviderSettings />
          ) : (
            <>
              <div className="flex h-9 shrink-0 items-stretch overflow-x-auto border-b border-white/5 bg-panel">
                {openFiles.length === 0 ? (
                  <div className="flex items-center border-r border-white/5 bg-canvas px-4 text-xs text-neutral-500">
                    Welcome
                  </div>
                ) : (
                  openFiles.map((file) => (
                    <button
                      type="button"
                      key={file.path}
                      onClick={() => setActivePath(file.path)}
                      className={`group flex min-w-32 max-w-52 items-center gap-2 border-r border-white/5 px-3 text-xs transition duration-75 ${
                        file.path === activePath
                          ? "bg-canvas text-neutral-200"
                          : "bg-panel text-neutral-500 hover:bg-white/[0.03]"
                      }`}
                    >
                      <FileCode2
                        size={13}
                        className="shrink-0 text-indigo-400/80"
                      />
                      <span className="truncate">
                        {file.path.split(/[\\/]/).pop()}
                      </span>
                      {file.content !== file.savedContent && (
                        <span
                          className="size-1.5 shrink-0 rounded-full bg-indigo-300"
                          title="Unsaved changes"
                        />
                      )}
                      <X
                        size={12}
                        className="ml-auto opacity-0 hover:text-neutral-200 group-hover:opacity-100"
                        onClick={(event) => {
                          event.stopPropagation();
                          closeFile(file.path);
                        }}
                      />
                    </button>
                  ))
                )}
              </div>
              <div className="relative min-h-0 flex-1">
                {activeFile ? (
                  <MonacoPane
                    file={activeFile}
                    onPosition={(nextLine, nextColumn) => {
                      setLine(nextLine);
                      setColumn(nextColumn);
                    }}
                    onChange={(content) =>
                      updateOpenFile(activeFile.path, content)
                    }
                    onSave={() => void saveOpenFile(activeFile.path)}
                  />
                ) : (
                  <Welcome
                    project={workbench?.project}
                    onDashboard={() => setSection("dashboard")}
                    onOpenFolder={() => void openFolder()}
                  />
                )}
              </div>
              {bottomOpen && (
                <BottomPanel
                  active={bottomTab}
                  onTab={setBottomTab}
                  onClose={() => setBottomOpen(false)}
                  tasks={workbench?.tasks ?? []}
                  notice={notice}
                  projectRoot={workbench?.project.rootPath ?? "workspace"}
                />
              )}
            </>
          )}
        </main>

        <AssistantPanel
          sessions={workbench?.sessions ?? []}
          selectedSessionId={selectedSessionId}
          onSelectSession={setSelectedSessionId}
          onCreateSession={() => void createSession()}
          agents={workbench?.agents ?? []}
          selectedAgentId={selectedAgentId}
          onSelectAgent={setSelectedAgentId}
          runtimeStatus={runtimeStatus}
          runtimeError={runtimeError}
          onConfigureRuntime={(providerId) => void configureRuntime(providerId)}
          liveTurns={liveTurns.filter(
            (turn) => turn.sessionId === selectedSessionId,
          )}
          pendingApproval={pendingApproval}
          composerText={composerText}
          onComposerText={setComposerText}
          submitting={submitting}
          onSubmit={() => void startTask()}
          onCancel={(taskId) => void cancelTask(taskId)}
          onApprove={(approved) => void resolveApproval(approved)}
          context={context}
          activePath={activePath}
          onAddContext={() => void addActiveFileToContext()}
          onRemoveContext={(id) => void removeContext(id)}
        />
      </div>

      <footer className="flex h-6 shrink-0 items-center justify-between border-t border-white/5 bg-[#0d0d0d] px-2 font-mono text-[10px] text-neutral-600">
        <div className="flex items-center gap-4">
          <span className="flex items-center gap-1.5">
            <ShieldCheck size={11} className="text-emerald-500/80" /> workspace
            sandboxed
          </span>
          <span
            className={connectionError ? "text-rose-400" : "text-neutral-500"}
          >
            {connectionError ? `API: ${connectionError}` : "API connected"}
          </span>
          <span className="max-w-[360px] truncate">{notice}</span>
        </div>
        <div className="flex items-center gap-4">
          <button
            type="button"
            onClick={() => setBottomOpen((value) => !value)}
            className="hover:text-neutral-300"
            aria-label="Toggle bottom panel"
          >
            {bottomOpen ? (
              <PanelBottomClose size={12} />
            ) : (
              <PanelBottomOpen size={12} />
            )}
          </button>
          <span>
            Ln {line}, Col {column}
          </span>
          <span>UTF-8</span>
          <span>{language}</span>
        </div>
      </footer>
    </div>
  );
}

function SidebarHeader({
  section,
  onRefresh,
}: {
  section: Section;
  onRefresh: () => void;
}) {
  return (
    <div className="flex h-10 shrink-0 items-center justify-between px-3 text-[10px] font-semibold uppercase tracking-[0.12em] text-neutral-500">
      <span>{section === "dashboard" ? "Task traces" : section}</span>
      <button
        type="button"
        onClick={onRefresh}
        className="rounded-sm p-1 hover:bg-white/5 hover:text-neutral-300"
        aria-label="Refresh"
      >
        <RefreshCw size={12} />
      </button>
    </div>
  );
}

function ExplorerPanel({
  entries,
  path,
  projectName,
  onOpen,
  onFolder,
  onOpenFolder,
}: {
  entries: FileEntry[];
  path: string;
  projectName: string;
  onOpen: (path: string) => void;
  onFolder: (path: string) => void;
  onOpenFolder: () => void;
}) {
  const parent = path.split(/[\\/]/).slice(0, -1).join("/") || ".";
  return (
    <div className="min-h-0 flex-1 overflow-y-auto pb-3 text-xs">
      <div className="flex h-7 items-center gap-1.5 border-y border-white/5 px-2 font-medium uppercase text-neutral-400">
        <ChevronUp size={12} /> {projectName}
        <button
          type="button"
          onClick={onOpenFolder}
          className="ml-auto rounded-sm p-1 text-neutral-600 hover:bg-white/5 hover:text-indigo-300"
          aria-label="Open Folder"
          title="Open Folder"
        >
          <FolderOpen size={12} />
        </button>
      </div>
      {path !== "." && (
        <button
          type="button"
          onClick={() => onFolder(parent)}
          className="tree-row text-neutral-500"
        >
          <ChevronLeft size={13} /> ..
        </button>
      )}
      {entries.map((entry) => (
        <button
          type="button"
          key={entry.path}
          onClick={() =>
            entry.type === "directory"
              ? onFolder(entry.path)
              : onOpen(entry.path)
          }
          className="tree-row"
        >
          {entry.type === "directory" ? (
            <Folder size={14} className="text-neutral-500" />
          ) : (
            <FileCode2 size={14} className="text-indigo-400/70" />
          )}
          <span className="truncate">{entry.name}</span>
          {entry.type === "file" && entry.size !== undefined && (
            <span className="ml-auto text-[9px] text-neutral-700">
              {Math.ceil(entry.size / 1024)}k
            </span>
          )}
        </button>
      ))}
    </div>
  );
}

function SearchPanel({ onOpen }: { onOpen: (path: string) => void }) {
  const [query, setQuery] = useState("");
  const [matches, setMatches] = useState<
    Array<{ path: string; line: number; text: string }>
  >([]);
  useEffect(() => {
    if (!query.trim()) {
      setMatches([]);
      return;
    }
    const timeout = window.setTimeout(() => {
      void requestJson<{
        matches: Array<{ path: string; line: number; text: string }>;
      }>(`/api/search?q=${encodeURIComponent(query)}`)
        .then((body) => setMatches(body.matches.slice(0, 100)))
        .catch(() => setMatches([]));
    }, 220);
    return () => window.clearTimeout(timeout);
  }, [query]);
  return (
    <div className="min-h-0 flex-1 overflow-y-auto px-2">
      <div className="relative mb-2">
        <Search size={12} className="absolute left-2 top-2 text-neutral-600" />
        <input
          autoFocus
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          className="field w-full pl-7"
          placeholder="Search text"
        />
      </div>
      {matches.map((match, index) => (
        <button
          type="button"
          key={`${match.path}:${match.line}:${index}`}
          onClick={() => onOpen(match.path)}
          className="block w-full border-b border-white/5 px-1 py-2 text-left hover:bg-white/[0.03]"
        >
          <div className="truncate text-[11px] text-neutral-400">
            {match.path}:{match.line}
          </div>
          <div className="mt-1 truncate font-mono text-[10px] text-neutral-600">
            {match.text}
          </div>
        </button>
      ))}
    </div>
  );
}

function AgentsPanel({ agents }: { agents: AgentView[] }) {
  return (
    <div className="min-h-0 flex-1 overflow-y-auto px-2">
      {agents.map((agent) => (
        <div
          key={agent.id}
          className="mb-2 border border-white/5 bg-black/10 p-2"
        >
          <div className="flex items-center gap-2 text-xs text-neutral-300">
            <Bot size={13} className="text-indigo-400" />
            {agent.name}
            <StatusDot status={agent.enabled ? "completed" : "idle"} />
          </div>
          <p className="mt-1.5 text-[10px] leading-4 text-neutral-600">
            {agent.description}
          </p>
        </div>
      ))}
    </div>
  );
}

function TaskList({ tasks }: { tasks: TaskView[] }) {
  return (
    <div className="min-h-0 flex-1 overflow-y-auto">
      {tasks.length === 0 ? (
        <Empty label="No persisted tasks yet" />
      ) : (
        tasks.map((task) => (
          <div key={task.id} className="border-b border-white/5 px-3 py-2">
            <div className="flex items-center gap-2 text-[11px] text-neutral-400">
              <StatusDot status={task.status} />
              <span className="truncate">{task.prompt}</span>
            </div>
            <div className="mt-1 flex justify-between text-[9px] uppercase tracking-wide text-neutral-700">
              <span>{task.currentStage}</span>
              <span>{shortDate(task.updatedAt)}</span>
            </div>
          </div>
        ))
      )}
    </div>
  );
}

function SettingsSummary() {
  return (
    <div className="space-y-3 px-3 text-[11px] text-neutral-600">
      <p>
        Provider credentials are stored in the shared machine-local SQLite
        settings database.
      </p>
      <div className="flex items-center gap-2 border border-amber-500/10 bg-amber-500/5 p-2 text-amber-200/60">
        <KeyRound size={14} /> Plaintext at rest
      </div>
      <p>Use the main settings view to save and validate each route.</p>
    </div>
  );
}

function Welcome({
  project,
  onDashboard,
  onOpenFolder,
}: {
  project?: ProjectView;
  onDashboard: () => void;
  onOpenFolder: () => void;
}) {
  return (
    <div className="flex h-full items-center justify-center">
      <div className="w-[520px] max-w-[80%]">
        <div className="mb-5 flex size-10 items-center justify-center rounded-md border border-indigo-400/10 bg-indigo-500/10 text-indigo-400">
          <Code2 size={20} />
        </div>
        <h1 className="text-xl font-medium tracking-tight text-neutral-200">
          Build with a coordinated agent team.
        </h1>
        <p className="mt-2 text-sm leading-6 text-neutral-600">
          {project?.name ?? "This workspace"} is indexed, isolated, and ready
          for durable multi-stage tasks. Open a file to inspect code or review
          persisted execution traces.
        </p>
        <div className="mt-6 grid grid-cols-2 gap-2">
          <button type="button" onClick={onOpenFolder} className="text-left">
            <WelcomeAction
              icon={<FolderOpen size={15} />}
              title="Open another folder"
              caption="Use the native folder picker"
            />
          </button>
          <button type="button" onClick={onDashboard} className="text-left">
            <WelcomeAction
              icon={<Activity size={15} />}
              title="Inspect traces"
              caption="Agents, tools, tokens and time"
            />
          </button>
        </div>
      </div>
    </div>
  );
}

function WelcomeAction({
  icon,
  title,
  caption,
}: {
  icon: React.ReactNode;
  title: string;
  caption: string;
}) {
  return (
    <div className="border border-white/5 bg-panel p-3 transition duration-75 hover:bg-white/[0.035]">
      <div className="flex items-center gap-2 text-xs text-neutral-300">
        {icon}
        {title}
      </div>
      <div className="mt-1 pl-6 text-[10px] text-neutral-700">{caption}</div>
    </div>
  );
}

function BottomPanel({
  active,
  onTab,
  onClose,
  tasks,
  notice,
  projectRoot,
}: {
  active: BottomTab;
  onTab: (tab: BottomTab) => void;
  onClose: () => void;
  tasks: TaskView[];
  notice: string;
  projectRoot: string;
}) {
  return (
    <section className="h-56 shrink-0 border-t border-white/5 bg-[#0c0c0c]">
      <div className="flex h-8 items-center border-b border-white/5 px-2">
        <div className="flex h-full gap-4">
          {(["problems", "output", "terminal"] as const).map((tab) => (
            <button
              type="button"
              key={tab}
              onClick={() => onTab(tab)}
              className={`border-b px-1 text-[10px] font-medium uppercase tracking-wider ${active === tab ? "border-indigo-400 text-neutral-300" : "border-transparent text-neutral-600"}`}
            >
              {tab}
            </button>
          ))}
        </div>
        <button
          type="button"
          onClick={onClose}
          className="ml-auto p-1 text-neutral-600 hover:text-neutral-300"
          aria-label="Close panel"
        >
          <X size={12} />
        </button>
      </div>
      <div className="h-[calc(100%-2rem)] overflow-auto p-3 font-mono text-[10px] leading-5 text-neutral-600">
        {active === "problems" && (
          <span>
            No editor diagnostics are currently exposed by the browser
            transport.
          </span>
        )}
        {active === "output" && (
          <>
            <div className="text-neutral-400">{notice}</div>
            <div>
              {tasks.length} persisted task{tasks.length === 1 ? "" : "s"}{" "}
              available for trace inspection.
            </div>
          </>
        )}
        {active === "terminal" && (
          <IntegratedTerminal projectRoot={projectRoot} />
        )}
      </div>
    </section>
  );
}

function IntegratedTerminal({ projectRoot }: { projectRoot: string }) {
  const [command, setCommand] = useState("");
  const [history, setHistory] = useState<TerminalResultView[]>([]);
  const [running, setRunning] = useState(false);
  const [profiles, setProfiles] = useState<TerminalProfileView[]>([]);
  const [profileId, setProfileId] = useState("");

  useEffect(() => {
    void requestJson<{ profiles: TerminalProfileView[] }>(
      "/api/terminal/profiles",
    )
      .then((body) => {
        setProfiles(body.profiles);
        setProfileId((current) => current || body.profiles[0]?.id || "");
      })
      .catch(() => setProfiles([]));
  }, []);

  const execute = async () => {
    const nextCommand = command.trim();
    if (!nextCommand || running) return;
    setCommand("");
    setRunning(true);
    try {
      const result = await requestJson<TerminalResultView>(
        "/api/terminal/execute",
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ command: nextCommand, profileId }),
        },
      );
      setHistory((current) => [...current.slice(-49), result]);
    } catch (error) {
      setHistory((current) => [
        ...current.slice(-49),
        {
          command: nextCommand,
          profileId,
          profileLabel:
            profiles.find((profile) => profile.id === profileId)?.label ??
            "Terminal",
          cwd: "workspace",
          output: error instanceof Error ? error.message : String(error),
          exitCode: -1,
          timedOut: false,
          truncated: false,
        },
      ]);
    } finally {
      setRunning(false);
    }
  };

  const prompt = terminalPrompt(profileId);

  return (
    <div className="flex min-h-full flex-col bg-[#080808] text-neutral-500">
      <div className="mb-2 flex items-center gap-2 border-b border-white/5 pb-2 text-[9px] text-neutral-700">
        <span className="max-w-[65%] truncate">{projectRoot}</span>
        <select
          value={profileId}
          onChange={(event) => setProfileId(event.target.value)}
          className="ml-auto bg-transparent text-[9px] text-neutral-500 outline-none"
          aria-label="Terminal profile"
        >
          {profiles.map((profile) => (
            <option key={profile.id} value={profile.id}>
              {profile.label}
            </option>
          ))}
        </select>
        <button
          type="button"
          onClick={() => setHistory([])}
          className="hover:text-neutral-300"
          title="Clear terminal"
          aria-label="Clear terminal"
        >
          <Trash2 size={10} />
        </button>
      </div>
      {history.length === 0 && (
        <div className="mb-1 text-neutral-800">Terminal ready.</div>
      )}
      {history.map((entry, index) => (
        <div key={`${entry.command}-${index}`}>
          <div className="text-neutral-400">
            <span className="text-emerald-500/80">
              {terminalPrompt(entry.profileId)}
            </span>{" "}
            {entry.command}
          </div>
          {entry.output && (
            <pre
              className={`whitespace-pre-wrap font-mono ${entry.exitCode === 0 ? "text-neutral-500" : "text-rose-300/70"}`}
            >
              {entry.output}
            </pre>
          )}
          {(entry.exitCode !== 0 || entry.timedOut || entry.truncated) && (
            <div className="text-[9px] text-rose-400/50">
              exit {entry.exitCode}
              {entry.timedOut ? " · timed out" : ""}
              {entry.truncated ? " · output truncated" : ""}
            </div>
          )}
        </div>
      ))}
      <form
        className="mt-auto flex items-center gap-2"
        onSubmit={(event) => {
          event.preventDefault();
          void execute();
        }}
      >
        <span className="text-emerald-500/80">{prompt}</span>
        <input
          value={command}
          onChange={(event) => setCommand(event.target.value)}
          disabled={running}
          autoComplete="off"
          spellCheck={false}
          className="terminal-input min-w-0 flex-1 border-0 bg-transparent p-0 font-mono text-[10px] text-neutral-300 outline-none placeholder:text-neutral-800"
          placeholder={
            running ? "Command running…" : "Type a command and press Enter"
          }
          aria-label="Terminal command"
        />
        {running && <RefreshCw size={10} className="animate-spin" />}
      </form>
    </div>
  );
}

function terminalPrompt(profileId: string): string {
  if (profileId.includes("powershell") || profileId === "pwsh") return "PS>";
  if (profileId === "cmd") return ">";
  return "$";
}

function AssistantPanel({
  sessions,
  selectedSessionId,
  onSelectSession,
  onCreateSession,
  agents,
  selectedAgentId,
  onSelectAgent,
  runtimeStatus,
  runtimeError,
  onConfigureRuntime,
  liveTurns,
  pendingApproval,
  composerText,
  onComposerText,
  submitting,
  onSubmit,
  onCancel,
  onApprove,
  context,
  activePath,
  onAddContext,
  onRemoveContext,
}: {
  sessions: SessionView[];
  selectedSessionId?: string;
  onSelectSession: (id: string) => void;
  onCreateSession: () => void;
  agents: AgentView[];
  selectedAgentId?: string;
  onSelectAgent: (id: string) => void;
  runtimeStatus?: RuntimeStatusView;
  runtimeError?: string;
  onConfigureRuntime: (providerId: string) => void;
  liveTurns: LiveTurn[];
  pendingApproval?: RuntimeApprovalView;
  composerText: string;
  onComposerText: (value: string) => void;
  submitting: boolean;
  onSubmit: () => void;
  onCancel: (taskId: string) => void;
  onApprove: (approved: boolean) => void;
  context: ContextItem[];
  activePath?: string;
  onAddContext: () => void;
  onRemoveContext: (id: string) => void;
}) {
  const session = sessions.find((item) => item.id === selectedSessionId);
  const messages = (session?.messages ?? []).filter(
    (message) => message.role === "user" || message.role === "assistant",
  );
  const activeTurn = liveTurns.find((turn) => turn.status === "running");
  const canSubmit = Boolean(
    selectedAgentId &&
    runtimeStatus?.ready &&
    composerText.trim() &&
    !submitting &&
    !activeTurn,
  );
  const submitBlockedReason = activeTurn
    ? "Wait for the active task or stop it first"
    : submitting
      ? "Submitting task…"
      : !runtimeStatus?.ready
        ? "Configure a provider model in Settings"
        : !selectedAgentId
          ? "Select an enabled agent"
          : !composerText.trim()
            ? "Type a message"
            : undefined;
  const approvalPreview = pendingApproval?.preview
    ? JSON.stringify(pendingApproval.preview, null, 2).slice(0, 1800)
    : undefined;

  return (
    <aside className="flex w-[320px] shrink-0 flex-col border-l border-white/5 bg-panel">
      <div className="flex h-10 items-center gap-2 border-b border-white/5 px-3 text-xs font-medium text-neutral-300">
        <Sparkles size={14} className="text-indigo-400" /> Agent chat{" "}
        <span
          className={`ml-auto rounded-sm border px-1.5 py-0.5 text-[9px] font-normal ${
            runtimeError
              ? "border-rose-400/20 text-rose-400"
              : runtimeStatus?.ready
                ? "border-emerald-400/20 text-emerald-400"
                : "border-amber-400/20 text-amber-400"
          }`}
        >
          {runtimeError
            ? "reconnecting"
            : runtimeStatus?.ready
              ? "runtime ready"
              : "setup required"}
        </span>
      </div>
      <div className="border-b border-white/5 p-2">
        <div className="flex gap-1">
          <select
            value={selectedSessionId ?? ""}
            onChange={(event) => onSelectSession(event.target.value)}
            className="field min-w-0 flex-1"
          >
            {sessions.length === 0 && <option value="">No session</option>}
            {sessions.map((session) => (
              <option key={session.id} value={session.id}>
                {session.title}
              </option>
            ))}
          </select>
          <button
            type="button"
            onClick={onCreateSession}
            className="icon-control"
            title="New session"
          >
            <Plus size={13} />
          </button>
        </div>
        <div className="mt-1 flex gap-1">
          <select
            value={selectedAgentId ?? ""}
            onChange={(event) => onSelectAgent(event.target.value)}
            className="field min-w-0 flex-1"
            aria-label="Active agent"
          >
            {agents
              .filter((agent) => agent.enabled)
              .map((agent) => (
                <option key={agent.id} value={agent.id}>
                  {agent.name}
                </option>
              ))}
          </select>
          <select
            value={runtimeStatus?.providerId ?? "ollama"}
            onChange={(event) => onConfigureRuntime(event.target.value)}
            className="field min-w-0 flex-1"
            aria-label="Runtime provider"
          >
            {(runtimeStatus?.routes ?? []).map((route) => (
              <option key={route.providerId} value={route.providerId}>
                {route.label}
                {route.configured ? "" : " · setup"}
              </option>
            ))}
          </select>
        </div>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto p-3">
        <div
          className={`mb-3 border p-3 ${
            runtimeError
              ? "border-rose-400/15 bg-rose-500/5"
              : "border-indigo-400/10 bg-indigo-500/5"
          }`}
        >
          <div className="flex items-center gap-2 text-[11px] text-indigo-200/80">
            <Bot size={14} />
            {runtimeError
              ? runtimeError
              : runtimeStatus?.ready
                ? `${runtimeStatus.providerId} / ${runtimeStatus.modelId}`
                : "Configure a provider model in Settings"}
          </div>
          <p className="mt-1 text-[10px] leading-4 text-neutral-600">
            Live task events, cancellation, and approval decisions use the local
            runtime transport.
          </p>
        </div>

        <div className="space-y-3">
          {messages.length === 0 && liveTurns.length === 0 && (
            <div className="py-5 text-center text-[10px] leading-4 text-neutral-700">
              Ask the selected agent about this workspace.
            </div>
          )}
          {messages.map((message, index) => (
            <div
              key={`${message.role}-${index}`}
              className={
                message.role === "user"
                  ? "ml-6 rounded-md bg-indigo-500/10 px-3 py-2 text-xs leading-5 text-indigo-100/80"
                  : "mr-2 border-l border-indigo-400/20 pl-3 text-xs leading-5 text-neutral-400"
              }
            >
              {message.role === "assistant" && (
                <ThinkingDisclosure items={message.metadata?.thinking ?? []} />
              )}
              <div className="whitespace-pre-wrap">{message.content}</div>
            </div>
          ))}
          {liveTurns.map((turn) => (
            <div key={turn.taskId} className="space-y-3">
              <div className="ml-6 rounded-md bg-indigo-500/10 px-3 py-2 text-xs leading-5 text-indigo-100/80">
                {turn.prompt}
              </div>
              <div
                className={`mr-2 border-l pl-3 text-xs leading-5 ${
                  turn.status === "failed"
                    ? "border-rose-400/30 text-rose-300/80"
                    : "border-indigo-400/20 text-neutral-400"
                }`}
              >
                <ThinkingDisclosure
                  items={turn.thinking}
                  active={!turn.response}
                />
                {turn.response ?? (
                  <span className="flex items-center gap-2 text-indigo-300/70">
                    <RefreshCw size={11} className="animate-spin" /> Agent is
                    working…
                  </span>
                )}
              </div>
            </div>
          ))}
        </div>

        {pendingApproval && (
          <div className="mt-4 border border-amber-400/20 bg-amber-500/5 p-3">
            <div className="flex items-center gap-2 text-[11px] font-medium text-amber-200/90">
              <ShieldCheck size={13} /> Approval required
            </div>
            <div className="mt-2 text-xs text-neutral-300">
              {pendingApproval.call.name}
            </div>
            <pre className="mt-2 max-h-40 overflow-auto whitespace-pre-wrap rounded bg-black/25 p-2 font-mono text-[9px] leading-4 text-neutral-500">
              {approvalPreview ??
                JSON.stringify(pendingApproval.call.arguments, null, 2)}
            </pre>
            <div className="mt-2 flex justify-end gap-2">
              <button
                type="button"
                onClick={() => onApprove(false)}
                className="rounded border border-white/10 px-2 py-1 text-[10px] text-neutral-400 hover:text-rose-300"
              >
                Deny
              </button>
              <button
                type="button"
                onClick={() => onApprove(true)}
                className="rounded bg-amber-400/15 px-2 py-1 text-[10px] text-amber-200 hover:bg-amber-400/20"
              >
                Approve
              </button>
            </div>
          </div>
        )}

        <div className="my-4 h-px bg-white/5" />
        <div className="mb-2 flex items-center justify-between text-[9px] font-medium uppercase tracking-[0.12em] text-neutral-600">
          <span>
            Active context ·{" "}
            {context.reduce((sum, item) => sum + item.tokenEstimate, 0)} tokens
          </span>
          {activePath && selectedSessionId && (
            <button
              type="button"
              onClick={onAddContext}
              className="text-indigo-400 hover:text-indigo-300"
            >
              + current file
            </button>
          )}
        </div>
        <div className="space-y-1">
          {context.length === 0 ? (
            <div className="border border-dashed border-white/5 p-3 text-center text-[10px] text-neutral-700">
              Pin files from the editor
            </div>
          ) : (
            context.map((item) => (
              <div
                key={item.id}
                className="flex items-center gap-2 border border-white/5 bg-black/10 px-2 py-1.5 text-[10px] text-neutral-500"
              >
                <File size={11} className="shrink-0 text-indigo-400/70" />
                <span className="truncate">
                  {item.filePath}
                  {item.startLine ? `:${item.startLine}-${item.endLine}` : ""}
                </span>
                <button
                  type="button"
                  onClick={() => onRemoveContext(item.id)}
                  className="ml-auto hover:text-rose-400"
                  aria-label="Remove context"
                >
                  <X size={11} />
                </button>
              </div>
            ))
          )}
        </div>
      </div>
      <div className="border-t border-white/5 p-2">
        <div className="rounded-md border border-white/5 bg-black/25 p-2 shadow-2xl shadow-black/30 transition focus-within:border-indigo-400/20">
          <textarea
            rows={3}
            value={composerText}
            onChange={(event) => onComposerText(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter" && !event.shiftKey) {
                event.preventDefault();
                if (canSubmit) onSubmit();
              }
            }}
            disabled={!runtimeStatus?.ready || Boolean(activeTurn)}
            placeholder={
              runtimeStatus?.ready
                ? activeTurn
                  ? "Wait for the active task or stop it…"
                  : "Ask the agent about your code…"
                : "Configure a provider model in Settings…"
            }
            className="w-full resize-none bg-transparent text-xs text-neutral-300 outline-none placeholder:text-neutral-700 disabled:text-neutral-600"
          />
          <div className="mt-2 flex items-center">
            <button
              type="button"
              disabled={!activePath}
              onClick={onAddContext}
              className="flex items-center gap-1 text-[10px] text-neutral-500 hover:text-indigo-300 disabled:text-neutral-700"
              title={
                activePath
                  ? "Add the active file to agent context"
                  : "Open a file before adding context"
              }
            >
              <Plus size={12} /> Context
            </button>
            {activeTurn ? (
              <button
                type="button"
                onClick={() => onCancel(activeTurn.taskId)}
                className="ml-auto rounded-sm bg-rose-500/10 p-1.5 text-rose-300 hover:bg-rose-500/15"
                title="Stop task"
              >
                <Square size={12} fill="currentColor" />
              </button>
            ) : (
              <button
                type="button"
                disabled={!canSubmit}
                onClick={onSubmit}
                className="ml-auto rounded-sm bg-indigo-500/15 p-1.5 text-indigo-300 hover:bg-indigo-500/20 disabled:text-indigo-400/30"
                title={submitBlockedReason ?? "Send task (Enter)"}
                aria-label={submitBlockedReason ?? "Send task"}
              >
                <Send size={13} />
              </button>
            )}
          </div>
        </div>
        <div
          className={`mt-1 text-center text-[9px] ${composerText.trim() && submitBlockedReason ? "text-amber-300/60" : "text-neutral-700"}`}
        >
          {composerText.trim() && submitBlockedReason
            ? submitBlockedReason
            : "Enter to send · Shift+Enter for a new line"}
        </div>
      </div>
    </aside>
  );
}

function Dashboard({ tasks }: { tasks: TaskView[] }) {
  const [selectedTaskId, setSelectedTaskId] = useState<string>();
  const [spans, setSpans] = useState<TraceSpan[]>([]);
  const [selectedSpanId, setSelectedSpanId] = useState<string>();
  useEffect(() => {
    setSelectedTaskId((current) => current ?? tasks[0]?.id);
  }, [tasks]);
  useEffect(() => {
    if (!selectedTaskId) {
      setSpans([]);
      return;
    }
    void requestJson<{ spans: TraceSpan[] }>(
      `/api/tasks/${encodeURIComponent(selectedTaskId)}/traces`,
    )
      .then((body) => {
        setSpans(body.spans);
        setSelectedSpanId(body.spans[0]?.spanId);
      })
      .catch(() => setSpans([]));
  }, [selectedTaskId]);
  const selected = spans.find((span) => span.spanId === selectedSpanId);
  const totalDuration = spans.reduce(
    (total, span) => total + (span.durationMs ?? 0),
    0,
  );
  const totalCost = spans.reduce((total, span) => total + (span.cost ?? 0), 0);
  const modelCalls = spans.filter((span) => span.kind === "model").length;
  const toolCalls = spans.filter((span) => span.kind === "tool").length;
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex h-14 shrink-0 items-center border-b border-white/5 px-4">
        <div>
          <h2 className="text-sm font-medium text-neutral-200">
            Observability
          </h2>
          <p className="mt-0.5 text-[10px] text-neutral-600">
            Persisted task hierarchy and exact recorded payloads
          </p>
        </div>
        <select
          value={selectedTaskId ?? ""}
          onChange={(event) => setSelectedTaskId(event.target.value)}
          className="field ml-auto w-72"
        >
          {tasks.length === 0 && <option value="">No tasks</option>}
          {tasks.map((task) => (
            <option key={task.id} value={task.id}>
              {task.prompt.slice(0, 60)}
            </option>
          ))}
        </select>
      </div>
      <div className="grid grid-cols-4 border-b border-white/5 bg-panel/50">
        <Metric
          icon={<Clock3 size={13} />}
          label="Recorded time"
          value={formatDuration(totalDuration)}
        />
        <Metric
          icon={<Bot size={13} />}
          label="Model calls"
          value={String(modelCalls)}
        />
        <Metric
          icon={<TerminalSquare size={13} />}
          label="Tool calls"
          value={String(toolCalls)}
        />
        <Metric
          icon={<Zap size={13} />}
          label="Known cost"
          value={`$${totalCost.toFixed(4)}`}
        />
      </div>
      <div className="grid min-h-0 flex-1 grid-cols-[minmax(280px,0.9fr)_minmax(360px,1.1fr)]">
        <div className="overflow-y-auto border-r border-white/5 p-2">
          {spans.length === 0 ? (
            <Empty label="No trace spans recorded for this task" />
          ) : (
            spans.map((span) => {
              const depth = traceDepth(span, spans);
              return (
                <button
                  type="button"
                  key={span.spanId}
                  onClick={() => setSelectedSpanId(span.spanId)}
                  style={{ paddingLeft: `${8 + depth * 16}px` }}
                  className={`mb-0.5 flex h-8 w-full items-center gap-2 rounded-sm pr-2 text-left text-[11px] transition duration-75 ${span.spanId === selectedSpanId ? "bg-indigo-500/10 text-neutral-200" : "text-neutral-500 hover:bg-white/[0.035]"}`}
                >
                  <TraceIcon kind={span.kind} />
                  <span className="truncate">{span.name}</span>
                  <span className="ml-auto shrink-0 font-mono text-[9px] text-neutral-700">
                    {formatDuration(span.durationMs)}
                  </span>
                  <StatusDot status={span.status} />
                </button>
              );
            })
          )}
        </div>
        <TraceDetails span={selected} />
      </div>
    </div>
  );
}

function traceDepth(span: TraceSpan, spans: TraceSpan[]): number {
  let depth = 0;
  let parent = span.parentSpanId;
  const visited = new Set<string>();
  while (parent && depth < 8 && !visited.has(parent)) {
    visited.add(parent);
    depth += 1;
    parent = spans.find((item) => item.spanId === parent)?.parentSpanId;
  }
  return depth;
}

function TraceIcon({ kind }: { kind: string }) {
  if (kind === "agent")
    return <Bot size={13} className="shrink-0 text-indigo-400" />;
  if (kind === "tool")
    return <TerminalSquare size={13} className="shrink-0 text-amber-400/80" />;
  if (kind === "provider" || kind === "model")
    return <Zap size={13} className="shrink-0 text-cyan-400/80" />;
  if (kind === "pipeline")
    return <Boxes size={13} className="shrink-0 text-violet-400/80" />;
  return <Activity size={13} className="shrink-0 text-neutral-500" />;
}

function TraceDetails({ span }: { span?: TraceSpan }) {
  const [tab, setTab] = useState<"input" | "output" | "context" | "metadata">(
    "input",
  );
  if (!span) return <Empty label="Select a trace node to inspect it" />;
  const value =
    tab === "input"
      ? span.input
      : tab === "output"
        ? span.output
        : tab === "context"
          ? span.context
          : {
              kind: span.kind,
              status: span.status,
              providerId: span.providerId,
              modelId: span.modelId,
              agentId: span.agentId,
              toolName: span.toolName,
              durationMs: span.durationMs,
              usage: span.usage,
              cost: span.cost,
              error: span.error,
            };
  return (
    <div className="flex min-h-0 flex-col">
      <div className="border-b border-white/5 p-4">
        <div className="flex items-center gap-2 text-sm text-neutral-200">
          <TraceIcon kind={span.kind} />
          {span.name}
        </div>
        <div className="mt-2 flex flex-wrap gap-2 text-[9px] uppercase tracking-wide text-neutral-600">
          <span className="tag">{span.kind}</span>
          <span className="tag">{span.status}</span>
          {span.providerId && <span className="tag">{span.providerId}</span>}
          {span.modelId && (
            <span className="tag normal-case">{span.modelId}</span>
          )}
          <span className="tag">{formatDuration(span.durationMs)}</span>
        </div>
      </div>
      <div className="flex h-9 shrink-0 items-end gap-4 border-b border-white/5 px-4">
        {(["input", "output", "context", "metadata"] as const).map((item) => (
          <button
            type="button"
            key={item}
            onClick={() => setTab(item)}
            className={`h-full border-b text-[10px] font-medium uppercase tracking-wider ${tab === item ? "border-indigo-400 text-neutral-300" : "border-transparent text-neutral-600"}`}
          >
            {item}
          </button>
        ))}
      </div>
      <pre className="min-h-0 flex-1 overflow-auto whitespace-pre-wrap break-words p-4 font-mono text-[10px] leading-5 text-neutral-500">
        {value === undefined
          ? "No data was recorded for this field."
          : JSON.stringify(value, null, 2)}
      </pre>
    </div>
  );
}

function Metric({
  icon,
  label,
  value,
}: {
  icon: React.ReactNode;
  label: string;
  value: string;
}) {
  return (
    <div className="border-r border-white/5 px-4 py-3 last:border-r-0">
      <div className="flex items-center gap-2 text-[9px] uppercase tracking-wider text-neutral-700">
        {icon}
        {label}
      </div>
      <div className="mt-1 font-mono text-sm text-neutral-300">{value}</div>
    </div>
  );
}

function ProviderSettings() {
  const [providers, setProviders] = useState<ProviderView[]>([]);
  const [message, setMessage] = useState(
    "Keys and model choices are saved once on this machine and shared with the TUI.",
  );
  const load = useCallback(
    () =>
      requestJson<{ providers: ProviderView[] }>("/api/providers")
        .then((body) => setProviders(body.providers))
        .catch((error: unknown) =>
          setMessage(error instanceof Error ? error.message : String(error)),
        ),
    [],
  );
  useEffect(() => {
    void load();
  }, [load]);
  return (
    <div className="min-h-0 flex-1 overflow-y-auto">
      <div className="mx-auto max-w-4xl p-6">
        <div className="mb-6">
          <h2 className="text-base font-medium text-neutral-200">
            Models & providers
          </h2>
          <p className="mt-1 text-xs text-neutral-600">
            Configure eligible pay-as-you-go, free-tier, or local routes.
            Secrets never enter the repository. Ollama is started automatically
            after its one-time installation.
          </p>
        </div>
        <div className="grid grid-cols-2 gap-3">
          {providers.map((provider) => (
            <ProviderCard
              key={provider.id}
              provider={provider}
              onMessage={setMessage}
              onChanged={load}
            />
          ))}
        </div>
        <div className="mt-4 flex items-center gap-2 border border-white/5 bg-panel px-3 py-2 text-[10px] text-neutral-600">
          <Database size={12} />
          {message}
        </div>
      </div>
    </div>
  );
}

function ProviderCard({
  provider,
  onMessage,
  onChanged,
}: {
  provider: ProviderView;
  onMessage: (message: string) => void;
  onChanged: () => Promise<void>;
}) {
  const [apiKey, setApiKey] = useState("");
  const [baseUrl, setBaseUrl] = useState(provider.baseUrl ?? "");
  const [modelId, setModelId] = useState(provider.manualModelId ?? "");
  const save = async () => {
    const body: Record<string, string> = { baseUrl, manualModelId: modelId };
    if (apiKey) body.apiKey = apiKey;
    await requestJson(`/api/providers/${provider.id}`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    setApiKey("");
    onMessage(`Saved ${provider.label}.`);
    await onChanged();
  };
  const validate = async () => {
    onMessage(`Validating ${provider.label}…`);
    const body = await requestJson<{
      result: { ok: boolean; message?: string };
    }>(`/api/providers/${provider.id}/validate`, { method: "POST" });
    onMessage(
      body.result.ok
        ? `${provider.label} is reachable.`
        : (body.result.message ?? "Validation failed."),
    );
    await onChanged();
  };
  const clear = async () => {
    await requestJson(`/api/providers/${provider.id}`, { method: "DELETE" });
    setApiKey("");
    setBaseUrl("");
    setModelId("");
    onMessage(`Cleared ${provider.label}.`);
    await onChanged();
  };
  const state = provider.lastValidation?.ok
    ? "Validated"
    : provider.hasCredential || !provider.credentialRequired
      ? "Configured"
      : "Not configured";
  return (
    <div className="border border-white/5 bg-panel p-4">
      <div className="mb-4 flex items-start">
        <div>
          <div className="text-sm font-medium text-neutral-300">
            {provider.label}
          </div>
          <div className="mt-1 text-[10px] text-neutral-700">{provider.id}</div>
          {provider.description && (
            <div className="mt-2 max-w-[250px] text-[10px] leading-relaxed text-neutral-600">
              {provider.description}
            </div>
          )}
        </div>
        <span
          className={`ml-auto flex items-center gap-1.5 text-[9px] ${provider.lastValidation?.ok ? "text-emerald-400/80" : "text-neutral-600"}`}
        >
          <StatusDot
            status={provider.lastValidation?.ok ? "completed" : "idle"}
          />
          {state}
        </span>
      </div>
      <div className="space-y-2">
        {provider.fields.includes("apiKey") && (
          <label className="block text-[10px] text-neutral-600">
            API key
            <input
              type="password"
              value={apiKey}
              onChange={(event) => setApiKey(event.target.value)}
              placeholder={
                provider.hasCredential
                  ? `${provider.maskedCredential} · leave blank to keep`
                  : "Enter key"
              }
              className="field mt-1 w-full"
            />
          </label>
        )}
        {provider.fields.includes("baseUrl") && (
          <label className="block text-[10px] text-neutral-600">
            Base URL
            <input
              value={baseUrl}
              onChange={(event) => setBaseUrl(event.target.value)}
              placeholder="http://localhost:11434"
              className="field mt-1 w-full"
            />
          </label>
        )}
        {provider.fields.includes("manualModelId") && (
          <label className="block text-[10px] text-neutral-600">
            Model ID
            <input
              value={modelId}
              onChange={(event) => setModelId(event.target.value)}
              placeholder={provider.defaultModelId ?? "Enter model ID"}
              list={`models-${provider.id}`}
              className="field mt-1 w-full"
            />
            {provider.modelOptions && (
              <datalist id={`models-${provider.id}`}>
                {provider.modelOptions.map((model) => (
                  <option key={model} value={model} />
                ))}
              </datalist>
            )}
          </label>
        )}
      </div>
      <div className="mt-4 flex items-center gap-2">
        <button
          type="button"
          onClick={() => void save()}
          className="btn-primary"
        >
          Save
        </button>
        <button
          type="button"
          onClick={() => void validate()}
          className="btn-secondary"
        >
          Validate
        </button>
        <button
          type="button"
          onClick={() => void clear()}
          className="icon-control ml-auto"
          aria-label="Clear provider"
        >
          <Trash2 size={12} />
        </button>
        {provider.helpUrl && (
          <a
            href={provider.helpUrl}
            target="_blank"
            rel="noreferrer"
            className="icon-control"
            aria-label="Provider help"
          >
            <ExternalLink size={12} />
          </a>
        )}
      </div>
    </div>
  );
}

function ThinkingDisclosure({
  items,
  active = false,
}: {
  items: string[];
  active?: boolean;
}) {
  if (items.length === 0) return null;
  return (
    <details className="group mb-2 border border-white/5 bg-black/10">
      <summary className="flex cursor-pointer list-none items-center gap-1.5 px-2 py-1.5 text-[10px] text-neutral-600 transition hover:text-neutral-400">
        <ChevronRight
          size={11}
          className="transition-transform group-open:rotate-90"
        />
        Thinking
        {active && <RefreshCw size={9} className="ml-1 animate-spin" />}
      </summary>
      <div className="space-y-1 border-t border-white/5 px-2 py-2 text-[10px] leading-4 text-neutral-600">
        <p className="text-neutral-700">Execution summary</p>
        {items.map((item, index) => (
          <div key={`${item}-${index}`} className="flex gap-2">
            <span className="text-indigo-400/40">{index + 1}.</span>
            <span>{item}</span>
          </div>
        ))}
      </div>
    </details>
  );
}

function Empty({ label }: { label: string }) {
  return (
    <div className="flex h-full min-h-28 items-center justify-center text-center text-[10px] text-neutral-700">
      {label}
    </div>
  );
}
