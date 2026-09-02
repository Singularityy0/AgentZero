import { useCallback, useEffect, useRef, useState } from "react";
import {
  Activity,
  Bot,
  Boxes,
  ChevronLeft,
  ChevronRight,
  ChevronUp,
  Code2,
  CircleDot,
  Clock3,
  Database,
  ExternalLink,
  File,
  FileCode2,
  Folder,
  FolderOpen,
  GitBranch,
  History,
  KeyRound,
  Layers,
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
import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
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

type Section =
  "explorer" | "search" | "history" | "agents" | "dashboard" | "settings";

/** An inclusive 1-based line span selected in the editor or named by a tag. */
interface LineRange {
  startLine: number;
  endLine: number;
}

/** A jump request from a clickable file tag; `nonce` re-fires repeat clicks. */
interface RevealTarget extends Partial<LineRange> {
  path: string;
  startLine: number;
  nonce: number;
}

/** One `/bytheway` exchange, held in the panel and never in session context. */
interface IsolatedExchange {
  id: string;
  question: string;
  answer?: string;
  error?: string;
}
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
  /** False for pipeline stages the runtime drives itself. */
  selectable?: boolean;
  /** True for the agent that routes a prompt to the right place on its own. */
  automatic?: boolean;
}

interface TaskSpendView {
  taskId: string;
  costUsd: number;
  budgetUsd: number;
  inputTokens: number;
  outputTokens: number;
  modelCalls: number;
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

interface ProposedHunk {
  id: string;
  path: string;
  startLine: number;
  endLine: number;
  original: string;
  replacement: string;
}

interface FileDiffPreview {
  kind: "file_diff";
  path: string;
  baseHash: string | null;
  proposedHash: string;
  text: string;
  hunks: ProposedHunk[];
}

interface RuntimeApprovalView {
  requestId: string;
  sessionId: string;
  taskId: string;
  agentId: string;
  call: { id: string; name: string; arguments: Record<string, unknown> };
  preview?: unknown;
}

/** Narrows an approval preview to a reviewable, hunk-level file diff. */
function asFileDiff(preview: unknown): FileDiffPreview | undefined {
  const candidate = preview as FileDiffPreview | undefined;
  return candidate?.kind === "file_diff" && Array.isArray(candidate.hunks)
    ? candidate
    : undefined;
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

/**
 * Matches a workspace-relative path, optionally suffixed with `:line` or
 * `:start-end`. The extension allow-list keeps ordinary prose ("v1.2", "e.g.")
 * from being rendered as a file tag.
 */
const FILE_REFERENCE_PATTERN =
  /@?([\w.-]+(?:[/\\][\w.-]+)*\.(?:ts|tsx|js|jsx|mjs|cjs|json|md|css|scss|html|htm|py|rs|go|java|rb|php|c|h|cpp|hpp|cs|sh|yml|yaml|toml|sql|txt|ini|env))(?::(\d+)(?:-(\d+))?)?(?![\w/\\]|\.(?=\w))/gu;

const FILE_REFERENCE_URL_SCHEME = "agentic-file://";

interface MarkdownAstNode {
  type?: string;
  value?: string;
  url?: string;
  children?: MarkdownAstNode[];
}

/**
 * Remark plugin that turns file-reference tags inside text nodes into mdast
 * link nodes (`agentic-file://<path>:<start>-<end>`), so the markdown renderer
 * can hand them to the `a` component override below instead of leaving them
 * as inert text.
 */
function remarkFileReferences() {
  return (tree: MarkdownAstNode) => {
    const walk = (node: MarkdownAstNode) => {
      if (!Array.isArray(node.children)) return;
      for (let i = node.children.length - 1; i >= 0; i--) {
        const child = node.children[i];
        if (child.type !== "text" || typeof child.value !== "string") {
          walk(child);
          continue;
        }
        const text = child.value;
        FILE_REFERENCE_PATTERN.lastIndex = 0;
        const parts: MarkdownAstNode[] = [];
        let cursor = 0;
        let found = false;
        for (
          let match = FILE_REFERENCE_PATTERN.exec(text);
          match;
          match = FILE_REFERENCE_PATTERN.exec(text)
        ) {
          found = true;
          const [tag, path, startLine, endLine] = match;
          if (match.index > cursor) {
            parts.push({
              type: "text",
              value: text.slice(cursor, match.index),
            });
          }
          const range = startLine
            ? `:${startLine}-${endLine ?? startLine}`
            : "";
          parts.push({
            type: "link",
            url: `${FILE_REFERENCE_URL_SCHEME}${encodeURIComponent(path!)}${range}`,
            children: [{ type: "text", value: tag }],
          });
          cursor = match.index + tag.length;
        }
        if (!found) continue;
        if (cursor < text.length) {
          parts.push({ type: "text", value: text.slice(cursor) });
        }
        node.children.splice(i, 1, ...parts);
      }
    };
    walk(tree);
  };
}

function markdownComponents(
  onOpenReference: (path: string, range?: LineRange) => void,
): Components {
  return {
    a: ({ href, children }) => {
      if (href?.startsWith(FILE_REFERENCE_URL_SCHEME)) {
        const raw = href.slice(FILE_REFERENCE_URL_SCHEME.length);
        const [rawPath, range] = raw.split(/:(\d+-\d+)$/);
        const path = decodeURIComponent(rawPath!);
        const [start, end] = range ? range.split("-") : [];
        return (
          <button
            type="button"
            onClick={() =>
              onOpenReference(
                path,
                start
                  ? { startLine: Number(start), endLine: Number(end) }
                  : undefined,
              )
            }
            className="rounded-sm bg-indigo-400/10 px-1 font-mono text-[10px] text-indigo-300 hover:bg-indigo-400/20"
            title={`Open ${path}${range ? `:${range}` : ""}`}
          >
            {children}
          </button>
        );
      }
      return (
        <a
          href={href}
          target="_blank"
          rel="noopener noreferrer"
          className="text-indigo-300 underline hover:text-indigo-200"
        >
          {children}
        </a>
      );
    },
    p: ({ children }) => <p className="mb-2 last:mb-0">{children}</p>,
    ul: ({ children }) => (
      <ul className="mb-2 list-disc space-y-0.5 pl-4 last:mb-0">{children}</ul>
    ),
    ol: ({ children }) => (
      <ol className="mb-2 list-decimal space-y-0.5 pl-4 last:mb-0">
        {children}
      </ol>
    ),
    li: ({ children }) => <li>{children}</li>,
    h1: ({ children }) => (
      <h1 className="mb-2 mt-1 text-sm font-semibold text-neutral-200 first:mt-0">
        {children}
      </h1>
    ),
    h2: ({ children }) => (
      <h2 className="mb-2 mt-1 text-[13px] font-semibold text-neutral-200 first:mt-0">
        {children}
      </h2>
    ),
    h3: ({ children }) => (
      <h3 className="mb-1 mt-1 text-xs font-semibold text-neutral-200 first:mt-0">
        {children}
      </h3>
    ),
    blockquote: ({ children }) => (
      <blockquote className="mb-2 border-l-2 border-indigo-400/30 pl-2 text-neutral-500 last:mb-0">
        {children}
      </blockquote>
    ),
    strong: ({ children }) => (
      <strong className="font-semibold text-neutral-200">{children}</strong>
    ),
    code: ({ className, children }) => (
      <code
        className={`rounded-sm bg-white/10 px-1 py-0.5 font-mono text-[10px] text-neutral-200 ${className ?? ""}`}
      >
        {children}
      </code>
    ),
    pre: ({ children }) => (
      <pre className="mb-2 overflow-x-auto rounded-sm border border-white/10 bg-black/40 p-2 last:mb-0">
        {children}
      </pre>
    ),
    table: ({ children }) => (
      <table className="mb-2 w-full border-collapse text-[10px] last:mb-0">
        {children}
      </table>
    ),
    th: ({ children }) => (
      <th className="border border-white/10 px-1.5 py-1 text-left font-semibold">
        {children}
      </th>
    ),
    td: ({ children }) => (
      <td className="border border-white/10 px-1.5 py-1">{children}</td>
    ),
    hr: () => <hr className="my-2 border-white/10" />,
  };
}

/**
 * Renders chat text as markdown, with every file reference turned into a
 * button that opens the file and scrolls to the referenced lines.
 */
function MessageBody({
  text,
  onOpenReference,
}: {
  text: string;
  onOpenReference: (path: string, range?: LineRange) => void;
}) {
  return (
    <div className="[&>*:last-child]:mb-0">
      <ReactMarkdown
        remarkPlugins={[remarkGfm, remarkFileReferences]}
        components={markdownComponents(onOpenReference)}
      >
        {text}
      </ReactMarkdown>
    </div>
  );
}

function MonacoPane({
  file,
  reveal,
  onPosition,
  onSelection,
  onChange,
  onSave,
}: {
  file?: OpenFileView;
  reveal?: RevealTarget;
  onPosition: (line: number, column: number) => void;
  onSelection: (range?: LineRange) => void;
  onChange: (content: string) => void;
  onSave: () => void;
}) {
  const host = useRef<HTMLDivElement>(null);
  const editor = useRef<monaco.editor.IStandaloneCodeEditor | null>(null);
  const models = useRef(new Map<string, monaco.editor.ITextModel>());
  const onPositionRef = useRef(onPosition);
  const onSelectionRef = useRef(onSelection);
  const onChangeRef = useRef(onChange);
  const onSaveRef = useRef(onSave);

  useEffect(() => {
    onPositionRef.current = onPosition;
    onSelectionRef.current = onSelection;
    onChangeRef.current = onChange;
    onSaveRef.current = onSave;
  }, [onChange, onPosition, onSelection, onSave]);

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
    const selectionSubscription = editor.current.onDidChangeCursorSelection(
      (event) => {
        const { selection } = event;
        onSelectionRef.current(
          selection.isEmpty()
            ? undefined
            : {
                startLine: selection.startLineNumber,
                endLine: selection.endLineNumber,
              },
        );
      },
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
      selectionSubscription.dispose();
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

  // Scroll to and highlight a line the user clicked in the chat transcript.
  useEffect(() => {
    if (!reveal || !editor.current || reveal.path !== file?.path) return;
    const endLine = reveal.endLine ?? reveal.startLine;
    editor.current.revealLineNearTop(reveal.startLine);
    editor.current.setSelection({
      startLineNumber: reveal.startLine,
      startColumn: 1,
      endLineNumber: endLine,
      endColumn: Number.MAX_SAFE_INTEGER,
    });
    editor.current.focus();
  }, [file?.path, reveal]);

  return <div ref={host} className="h-full min-h-0 w-full bg-canvas" />;
}

/** Quiet period before an auto-save write, so typing is one save. */
const AUTO_SAVE_DELAY_MS = 1_200;

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
  const [selection, setSelection] = useState<LineRange>();
  const [reveal, setReveal] = useState<RevealTarget>();
  const [isolated, setIsolated] = useState<IsolatedExchange[]>([]);
  const [fileClipboard, setFileClipboard] = useState<{
    path: string;
    mode: "copy" | "cut";
  }>();
  const [autoSave, setAutoSave] = useState(() => {
    try {
      return localStorage.getItem("agentic.autoSave") === "on";
    } catch {
      return false;
    }
  });
  const [deleteCandidate, setDeleteCandidate] = useState<FileEntry>();
  const [sessionToDelete, setSessionToDelete] = useState<SessionView>();
  // A pending in-app prompt: what to ask, and what to do with the answer.
  const [prompt, setPrompt] = useState<{
    title: string;
    label: string;
    initialValue?: string;
    confirmLabel: string;
    submit: (value: string) => void | Promise<void>;
  }>();
  const [deletingPath, setDeletingPath] = useState<string>();
  const submissionInFlight = useRef(false);
  const openFilesRef = useRef<OpenFileView[]>([]);
  const folderPathRef = useRef(".");

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
      // Default to the agent that decides for itself, not to whichever agent
      // sorted first. Picking any other entry is an explicit override.
      setSelectedAgentId(
        (current) =>
          current ??
          data.agents.find((agent) => agent.enabled && agent.automatic)?.id ??
          data.agents.find((agent) => agent.enabled)?.id,
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

  useEffect(() => {
    openFilesRef.current = openFiles;
  }, [openFiles]);

  useEffect(() => {
    folderPathRef.current = folderPath;
  }, [folderPath]);

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

  /** Creates a file or folder under the folder currently shown in the tree. */
  const createEntry = async (type: "file" | "directory", name: string) => {
    const target =
      folderPath === "." ? name.trim() : `${folderPath}/${name.trim()}`;
    try {
      const body = await requestJson<{ path: string }>("/api/files/entry", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ path: target, type }),
      });
      await loadFolder(folderPath);
      setNotice(`Created ${body.path}`);
      if (type === "file") await openFile(body.path);
    } catch (error) {
      setNotice(error instanceof Error ? error.message : String(error));
    }
  };

  const renameEntry = async (entry: FileEntry, name: string) => {
    if (name.trim() === entry.name) return;
    const parent = entry.path.split("/").slice(0, -1).join("/");
    const target = parent ? `${parent}/${name.trim()}` : name.trim();
    try {
      const body = await requestJson<{ path: string }>("/api/files/entry", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ from: entry.path, to: target }),
      });
      // Keep an open editor tab pointing at the file the user still sees.
      setOpenFiles((current) =>
        current.map((file) =>
          file.path === entry.path ? { ...file, path: body.path } : file,
        ),
      );
      setActivePath((current) =>
        current === entry.path ? body.path : current,
      );
      await loadFolder(folderPath);
      setNotice(`Renamed to ${body.path}`);
    } catch (error) {
      setNotice(error instanceof Error ? error.message : String(error));
    }
  };

  /**
   * Writes to the system clipboard, falling back to a hidden textarea because
   * the async Clipboard API is unavailable outside a secure context.
   */
  const copyText = async (value: string, label: string) => {
    try {
      await navigator.clipboard.writeText(value);
    } catch {
      const element = document.createElement("textarea");
      element.value = value;
      element.style.position = "fixed";
      element.style.opacity = "0";
      document.body.append(element);
      element.select();
      document.execCommand("copy");
      element.remove();
    }
    setNotice(`Copied ${label}: ${value}`);
  };

  const copyEntryTo = async (from: string, to: string, verb: string) => {
    try {
      const body = await requestJson<{ path: string }>("/api/files/copy", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ from, to }),
      });
      await loadFolder(folderPath);
      setNotice(`${verb} to ${body.path}`);
    } catch (error) {
      setNotice(error instanceof Error ? error.message : String(error));
    }
  };

  const pasteClipboardEntry = async (targetFolder: string) => {
    const source = fileClipboard;
    if (!source) return;
    const name = source.path.split("/").at(-1) ?? source.path;
    const destination = targetFolder === "." ? name : `${targetFolder}/${name}`;
    if (source.mode === "cut") {
      try {
        const body = await requestJson<{ path: string }>("/api/files/entry", {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ from: source.path, to: destination }),
        });
        setFileClipboard(undefined);
        await loadFolder(folderPath);
        setNotice(`Moved to ${body.path}`);
      } catch (error) {
        setNotice(error instanceof Error ? error.message : String(error));
      }
      return;
    }
    await copyEntryTo(source.path, destination, "Pasted");
  };

  const deleteEntry = async (entry: FileEntry) => {
    setDeletingPath(entry.path);
    try {
      await requestJson(
        `/api/files/entry?path=${encodeURIComponent(entry.path)}`,
        { method: "DELETE" },
      );
      setOpenFiles((current) =>
        current.filter(
          (file) =>
            file.path !== entry.path && !file.path.startsWith(`${entry.path}/`),
        ),
      );
      setActivePath((current) =>
        current === entry.path || current?.startsWith(`${entry.path}/`)
          ? undefined
          : current,
      );
      await loadFolder(folderPath);
      setNotice(`Deleted ${entry.path}`);
    } catch (error) {
      setNotice(error instanceof Error ? error.message : String(error));
    } finally {
      setDeleteCandidate(undefined);
      setDeletingPath(undefined);
    }
  };

  /**
   * Reloads a file that changed on disk, but only when the editor copy is
   * clean. Silently replacing unsaved edits with the agent's version would lose
   * the user's work, so a dirty buffer is left alone and flagged instead.
   */
  const syncChangedFiles = useCallback(async (changed: readonly string[]) => {
    const paths = new Set(changed);
    const targets = openFilesRef.current.filter((file) => paths.has(file.path));
    for (const file of targets) {
      if (file.content !== file.savedContent) {
        setNotice(
          `${file.path} changed on disk; your unsaved edits were kept. Close the tab to load the new version.`,
        );
        continue;
      }
      try {
        const body = await requestJson<{ content: string; hash: string }>(
          `/api/files/content?path=${encodeURIComponent(file.path)}`,
        );
        setOpenFiles((current) =>
          current.map((candidate) =>
            candidate.path === file.path
              ? {
                  ...candidate,
                  content: body.content,
                  savedContent: body.content,
                  hash: body.hash,
                }
              : candidate,
          ),
        );
      } catch {
        // The file was deleted or moved; the explorer refresh below reflects it.
      }
    }
  }, []);

  // Live workspace updates. Without this the tree only reflects agent writes
  // after the folder is reopened, which makes the IDE feel disconnected from
  // the work the agent is doing in it.
  useEffect(() => {
    const source = new EventSource("/api/workspace/events");
    source.onmessage = (message) => {
      try {
        const change = JSON.parse(message.data) as { paths?: string[] };
        if (!Array.isArray(change.paths) || change.paths.length === 0) return;
        void loadFolder(folderPathRef.current);
        void syncChangedFiles(change.paths);
      } catch {
        // Ignore malformed frames; the next change re-synchronises the tree.
      }
    };
    source.onerror = () => undefined;
    return () => source.close();
  }, [loadFolder, syncChangedFiles]);

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

  /**
   * Pins a whole file or a single selected block to the session context. The
   * range is optional so the same call serves the "add file" button, the "add
   * selection" button, and an @-mention picked in the composer.
   */
  const addToContext = async (path: string, range?: LineRange) => {
    try {
      const sessionId = selectedSessionId ?? (await createSession());
      await requestJson("/api/context", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ sessionId, path, ...range }),
      });
      await loadContext(sessionId);
      setNotice(
        range
          ? `Pinned ${path}:${range.startLine}-${range.endLine} to session context`
          : `Pinned ${path} to session context`,
      );
    } catch (error) {
      setNotice(error instanceof Error ? error.message : String(error));
    }
  };

  /** Opens a file tagged in the chat transcript and scrolls to its lines. */
  const openReference = async (path: string, range?: LineRange) => {
    await openFile(path);
    setReveal({
      path,
      startLine: range?.startLine ?? 1,
      ...(range?.endLine === undefined ? {} : { endLine: range.endLine }),
      nonce: Date.now(),
    });
  };

  /**
   * Runs one question with no prior context and no transcript mutation, then
   * leaves the ongoing task exactly as it was.
   */
  const askIsolated = async (question: string) => {
    const id = `bytheway-${Date.now()}`;
    setIsolated((current) => [...current, { id, question }]);
    try {
      const sessionId = selectedSessionId ?? (await createSession());
      const body = await requestJson<{ text: string }>("/api/bytheway", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ sessionId, prompt: question }),
      });
      setIsolated((current) =>
        current.map((item) =>
          item.id === id ? { ...item, answer: body.text } : item,
        ),
      );
      setNotice("Answered an isolated /bytheway question");
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setIsolated((current) =>
        current.map((item) =>
          item.id === id ? { ...item, error: message } : item,
        ),
      );
      setNotice(message);
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

  const renameSession = async (session: SessionView, title: string) => {
    try {
      await requestJson(`/api/sessions/${encodeURIComponent(session.id)}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ title }),
      });
      await refreshWorkbench();
      setNotice(`Renamed to ${title}`);
    } catch (error) {
      setNotice(error instanceof Error ? error.message : String(error));
    }
  };

  const deleteSession = async (session: SessionView) => {
    try {
      await requestJson(`/api/sessions/${encodeURIComponent(session.id)}`, {
        method: "DELETE",
      });
      // Selecting a deleted conversation would render an empty transcript that
      // looks like a bug, so selection falls back to whatever remains.
      setSelectedSessionId((current) =>
        current === session.id ? undefined : current,
      );
      await refreshWorkbench();
      setNotice(`Deleted ${session.title}`);
    } catch (error) {
      setNotice(error instanceof Error ? error.message : String(error));
    }
  };

  const startTask = async () => {
    const prompt = composerText.trim();
    if (!prompt || submitting || submissionInFlight.current) return;
    const isolatedQuestion = /^\/bytheway\b\s*(.*)$/su.exec(prompt);
    if (isolatedQuestion) {
      const question = (isolatedQuestion[1] ?? "").trim();
      if (!question) {
        setNotice("Usage: /bytheway <isolated question>");
        return;
      }
      setComposerText("");
      submissionInFlight.current = true;
      setSubmitting(true);
      try {
        await askIsolated(question);
      } finally {
        submissionInFlight.current = false;
        setSubmitting(false);
      }
      return;
    }
    submissionInFlight.current = true;
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
      submissionInFlight.current = false;
      setSubmitting(false);
    }
  };

  /** Continues an interrupted task from its last durable checkpoint. */
  const resumeTask = async (task: TaskView) => {
    try {
      const body = await requestJson<{ sessionId: string; taskId: string }>(
        `/api/tasks/${encodeURIComponent(task.id)}/resume`,
        { method: "POST" },
      );
      setSelectedSessionId(body.sessionId);
      setLiveTurns((current) =>
        current.some((turn) => turn.taskId === body.taskId)
          ? current
          : [
              ...current,
              {
                taskId: body.taskId,
                sessionId: body.sessionId,
                prompt: task.prompt,
                thinking: [],
                status: "running",
              },
            ],
      );
      setNotice("Resumed the task from its last saved stage");
      await loadRuntimeStatus();
    } catch (error) {
      setNotice(error instanceof Error ? error.message : String(error));
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

  /**
   * Resolves an approval. A boolean is the all-or-nothing answer; a hunk split
   * accepts part of a diff and returns the rest to the agent so it can continue
   * the task around what was rejected.
   */
  const resolveApproval = async (
    decision:
      boolean | { acceptedHunkIds: string[]; rejectedHunkIds: string[] },
  ) => {
    if (!pendingApproval) return;
    try {
      await requestJson(
        `/api/approvals/${encodeURIComponent(pendingApproval.requestId)}`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(
            typeof decision === "boolean" ? { approved: decision } : decision,
          ),
        },
      );
      setPendingApproval(undefined);
      setNotice(
        typeof decision === "boolean"
          ? decision
            ? "Tool action approved"
            : "Tool action denied"
          : `Applied ${decision.acceptedHunkIds.length} of ${
              decision.acceptedHunkIds.length + decision.rejectedHunkIds.length
            } changes; the agent continues around the rest`,
      );
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

  /**
   * Write the active buffer to a new path.
   *
   * Composed from the same endpoints the explorer uses - create the entry, then
   * write to it - so a "save as" cannot reach a path the workspace guard would
   * refuse for a normal write.
   */
  const saveOpenFileAs = useCallback(
    async (targetPath: string) => {
      const file = openFiles.find((candidate) => candidate.path === activePath);
      if (!file) return;
      try {
        const body = await requestJson<{
          file: { path: string; content: string; hash: string };
        }>("/api/files/content", {
          method: "PUT",
          headers: { "content-type": "application/json" },
          // `expectedHash: null` means "this path must not already exist", so
          // a save-as reports a collision instead of silently overwriting
          // someone's file. Creating the entry first would trip that guard
          // against the empty file it had just made.
          body: JSON.stringify({
            path: targetPath,
            content: file.content,
            expectedHash: null,
          }),
        });
        setOpenFiles((current) => [
          ...current.filter((candidate) => candidate.path !== body.file.path),
          {
            path: body.file.path,
            content: body.file.content,
            savedContent: body.file.content,
            hash: body.file.hash,
          },
        ]);
        setActivePath(body.file.path);
        await loadFolder(folderPath);
        setNotice(`Saved as ${body.file.path}`);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        setNotice(
          message.includes("already exists")
            ? `${targetPath} already exists. Choose a different path.`
            : message,
        );
      }
    },
    [activePath, folderPath, loadFolder, openFiles],
  );

  // Ctrl/Cmd+S was bound only inside Monaco, so it did nothing whenever focus
  // sat in the explorer, a tab, or the assistant. Binding it on the window also
  // stops the browser's own "save page" from taking the shortcut.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (
        !(event.ctrlKey || event.metaKey) ||
        event.key.toLowerCase() !== "s"
      ) {
        return;
      }
      event.preventDefault();
      if (!activePath) return;
      if (event.shiftKey) {
        const file = openFiles.find(
          (candidate) => candidate.path === activePath,
        );
        setPrompt({
          title: "Save as",
          label: "Workspace-relative path",
          initialValue: file?.path ?? "",
          confirmLabel: "Save",
          submit: (value) => saveOpenFileAs(value),
        });
        return;
      }
      void saveOpenFile(activePath);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [activePath, openFiles, saveOpenFile, saveOpenFileAs]);

  // Auto-save debounces on the active buffer rather than saving on every
  // keystroke, so a burst of typing is one write and one conflict check.
  useEffect(() => {
    if (!autoSave || !activeFile) return;
    if (activeFile.content === activeFile.savedContent) return;
    const timer = setTimeout(() => {
      void saveOpenFile(activeFile.path);
    }, AUTO_SAVE_DELAY_MS);
    return () => clearTimeout(timer);
  }, [autoSave, activeFile, saveOpenFile]);

  useEffect(() => {
    try {
      localStorage.setItem("agentic.autoSave", autoSave ? "on" : "off");
    } catch {
      // A renderer with site data disabled still works; the choice just does
      // not persist across restarts.
    }
  }, [autoSave]);
  const language = activePath ? languageForPath(activePath) : "plaintext";

  return (
    <div className="flex h-screen w-full flex-col overflow-hidden bg-canvas text-neutral-300">
      <div className="flex h-9 shrink-0 items-center border-b border-white/5 bg-panel px-3 text-xs">
        <div className="flex w-[284px] items-center gap-2 font-medium text-neutral-300">
          <img
            src="/logo.jpeg"
            alt=""
            className="size-5 shrink-0 rounded-sm object-cover"
          />
          <span>Agent Zero</span>
          <span className="text-neutral-700">/</span>
          <button
            type="button"
            onClick={() => void openFolder()}
            className="truncate text-neutral-500 hover:text-neutral-300"
            title={
              workbench?.project.rootPath
                ? `Agent writes go to ${workbench.project.rootPath} — click to open another folder`
                : "Open another folder"
            }
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
              label="Chat history"
              active={section === "history"}
              onClick={() => setSection("history")}
            >
              <History size={20} />
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
              onCreate={(type) =>
                setPrompt({
                  title: type === "directory" ? "New folder" : "New file",
                  label: "Name",
                  confirmLabel: "Create",
                  submit: (name) => createEntry(type, name),
                })
              }
              onRename={(entry) =>
                setPrompt({
                  title: `Rename ${entry.name}`,
                  label: "New name",
                  initialValue: entry.name,
                  confirmLabel: "Rename",
                  submit: (name) => renameEntry(entry, name),
                })
              }
              onDelete={setDeleteCandidate}
              onRefresh={() => void loadFolder(folderPath)}
              projectRootPath={workbench?.project.rootPath ?? ""}
              clipboard={fileClipboard}
              onClipboard={(path, mode) => {
                setFileClipboard({ path, mode });
                setNotice(`${mode === "cut" ? "Cut" : "Copied"} ${path}`);
              }}
              onPaste={(folder) => void pasteClipboardEntry(folder)}
              onDuplicate={(entry) =>
                void copyEntryTo(entry.path, entry.path, "Duplicated")
              }
              onCopyText={(value, label) => void copyText(value, label)}
            />
          )}
          {section === "search" && <SearchPanel onOpen={openFile} />}
          {section === "history" && (
            <HistoryPanel
              sessions={workbench?.sessions ?? []}
              selectedSessionId={selectedSessionId}
              onOpen={(sessionId) => setSelectedSessionId(sessionId)}
              onCreate={() => void createSession()}
              onRename={(session) =>
                setPrompt({
                  title: "Rename conversation",
                  label: "Title",
                  initialValue: session.title,
                  confirmLabel: "Rename",
                  submit: (value) => renameSession(session, value),
                })
              }
              onDelete={(session) => setSessionToDelete(session)}
            />
          )}
          {section === "agents" && (
            <AgentsPanel agents={workbench?.agents ?? []} />
          )}
          {section === "dashboard" && (
            <TaskList
              tasks={workbench?.tasks ?? []}
              onResume={(task) => void resumeTask(task)}
            />
          )}
          {section === "settings" && <SettingsSummary />}
        </aside>

        <main className="flex min-w-0 flex-1 flex-col bg-canvas">
          {section === "dashboard" ? (
            <Dashboard
              tasks={workbench?.tasks ?? []}
              liveTaskId={
                liveTurns.find((turn) => turn.status === "running")?.taskId
              }
            />
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
                {activeFile && (
                  <div className="ml-auto flex shrink-0 items-center gap-1 border-l border-white/5 px-2">
                    <button
                      type="button"
                      onClick={() => void saveOpenFile(activeFile.path)}
                      disabled={activeFile.content === activeFile.savedContent}
                      className="px-2 py-1 text-[11px] text-neutral-400 hover:text-neutral-200 disabled:opacity-30"
                      title="Save (Ctrl+S)"
                    >
                      Save
                    </button>
                    <button
                      type="button"
                      onClick={() =>
                        setPrompt({
                          title: "Save as",
                          label: "Workspace-relative path",
                          initialValue: activeFile.path,
                          confirmLabel: "Save",
                          submit: (value) => saveOpenFileAs(value),
                        })
                      }
                      className="px-2 py-1 text-[11px] text-neutral-400 hover:text-neutral-200"
                      title="Save as (Ctrl+Shift+S)"
                    >
                      Save as
                    </button>
                    <label
                      className="flex cursor-pointer items-center gap-1 px-2 py-1 text-[11px] text-neutral-500"
                      title="Save the active file automatically after you stop typing"
                    >
                      <input
                        type="checkbox"
                        checked={autoSave}
                        onChange={(event) => setAutoSave(event.target.checked)}
                        className="size-3 accent-indigo-400"
                      />
                      Auto
                    </label>
                  </div>
                )}
              </div>
              <div className="relative min-h-0 flex-1">
                {activeFile ? (
                  <MonacoPane
                    file={activeFile}
                    reveal={reveal}
                    onPosition={(nextLine, nextColumn) => {
                      setLine(nextLine);
                      setColumn(nextColumn);
                    }}
                    onSelection={setSelection}
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
          onApprove={(decision) => void resolveApproval(decision)}
          context={context}
          activePath={activePath}
          selection={selection}
          isolated={isolated}
          onAddContext={(path, range) => void addToContext(path, range)}
          onRemoveContext={(id) => void removeContext(id)}
          onOpenReference={(path, range) => void openReference(path, range)}
        />
      </div>

      <footer className="flex h-6 shrink-0 items-center justify-between border-t border-white/5 bg-[#0d0d0d] px-2 font-mono text-[10px] text-neutral-600">
        <div className="flex items-center gap-4">
          <span className="flex items-center gap-1.5">
            <ShieldCheck size={11} className="text-emerald-500/80" />
            <span
              className="max-w-[420px] truncate"
              title={`Every agent file write is sandboxed to ${workbench?.project.rootPath ?? "the open workspace"}`}
            >
              {workbench?.project.rootPath ?? "no folder open"}
            </span>
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
      {prompt && (
        <PromptDialog
          title={prompt.title}
          label={prompt.label}
          initialValue={prompt.initialValue}
          confirmLabel={prompt.confirmLabel}
          onCancel={() => setPrompt(undefined)}
          onConfirm={(value) => {
            const pending = prompt;
            setPrompt(undefined);
            void pending.submit(value);
          }}
        />
      )}
      {sessionToDelete && (
        <ConfirmDialog
          title="Delete conversation"
          body={`"${sessionToDelete.title}" and its tasks, events, and traces will be removed from this project. This cannot be undone.`}
          confirmLabel="Delete"
          onCancel={() => setSessionToDelete(undefined)}
          onConfirm={() => {
            const pending = sessionToDelete;
            setSessionToDelete(undefined);
            void deleteSession(pending);
          }}
        />
      )}
      {deleteCandidate && (
        <DeleteConfirmation
          entry={deleteCandidate}
          busy={deletingPath === deleteCandidate.path}
          onCancel={() => setDeleteCandidate(undefined)}
          onConfirm={() => void deleteEntry(deleteCandidate)}
        />
      )}
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
      <span>
        {section === "dashboard"
          ? "Task traces"
          : section === "history"
            ? "Chat history"
            : section}
      </span>
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
  onCreate,
  onRename,
  onDelete,
  onRefresh,
  projectRootPath,
  clipboard,
  onClipboard,
  onPaste,
  onDuplicate,
  onCopyText,
}: {
  entries: FileEntry[];
  path: string;
  projectName: string;
  onOpen: (path: string) => void;
  onFolder: (path: string) => void;
  onOpenFolder: () => void;
  onCreate: (type: "file" | "directory") => void;
  onRename: (entry: FileEntry) => void;
  onDelete: (entry: FileEntry) => void;
  onRefresh: () => void;
  projectRootPath: string;
  clipboard?: { path: string; mode: "copy" | "cut" };
  onClipboard: (path: string, mode: "copy" | "cut") => void;
  onPaste: (folder: string) => void;
  onDuplicate: (entry: FileEntry) => void;
  onCopyText: (value: string, label: string) => void;
}) {
  const parent = path.split(/[\\/]/).slice(0, -1).join("/") || ".";
  // `entry` is undefined for the background menu, which offers only the actions
  // that make sense with nothing selected, exactly as the editor does.
  const [menu, setMenu] = useState<{
    entry?: FileEntry;
    x: number;
    y: number;
  }>();
  const [selected, setSelected] = useState<FileEntry>();

  // A removed entry must not remain the target of global explorer shortcuts.
  // This also gives focus restoration a stable fallback after deletion.
  useEffect(() => {
    if (selected && !entries.some((entry) => entry.path === selected.path)) {
      setSelected(undefined);
    }
  }, [entries, selected]);

  // Keyboard parity with the editor: the shortcuts shown in the menu have to
  // work, and they must not fire while the user is typing somewhere else.
  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      const target = event.target as HTMLElement | null;
      if (
        target?.tagName === "INPUT" ||
        target?.tagName === "TEXTAREA" ||
        target?.isContentEditable
      ) {
        return;
      }
      if (event.key === "F2" && selected) {
        event.preventDefault();
        onRename(selected);
        return;
      }
      if (event.key === "Delete" && selected) {
        event.preventDefault();
        onDelete(selected);
        return;
      }
      if (!event.ctrlKey && !event.metaKey) return;
      const key = event.key.toLowerCase();
      if (key === "c" && selected) {
        event.preventDefault();
        onClipboard(selected.path, "copy");
      } else if (key === "x" && selected) {
        event.preventDefault();
        onClipboard(selected.path, "cut");
      } else if (key === "v" && clipboard) {
        event.preventDefault();
        onPaste(selected?.type === "directory" ? selected.path : path);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [clipboard, onClipboard, onDelete, onPaste, onRename, path, selected]);

  // Any click or Escape anywhere dismisses the context menu, matching the
  // behaviour of the editor menus people already expect.
  useEffect(() => {
    if (!menu) return;
    const close = (): void => setMenu(undefined);
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === "Escape") close();
    };
    window.addEventListener("click", close);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("click", close);
      window.removeEventListener("keydown", onKey);
    };
  }, [menu]);

  return (
    <div
      className="relative min-h-0 flex-1 overflow-y-auto pb-3 text-xs"
      onContextMenu={(event) => {
        if (event.target !== event.currentTarget) return;
        event.preventDefault();
        setSelected(undefined);
        setMenu({ x: event.clientX, y: event.clientY });
      }}
    >
      <div className="flex h-7 items-center gap-1.5 border-y border-white/5 px-2 font-medium uppercase text-neutral-400">
        <ChevronUp size={12} /> {projectName}
        <button
          type="button"
          onClick={() => onCreate("file")}
          className="ml-auto rounded-sm p-1 text-neutral-600 hover:bg-white/5 hover:text-indigo-300"
          aria-label="New File"
          title="New File"
        >
          <FileCode2 size={12} />
        </button>
        <button
          type="button"
          onClick={() => onCreate("directory")}
          className="rounded-sm p-1 text-neutral-600 hover:bg-white/5 hover:text-indigo-300"
          aria-label="New Folder"
          title="New Folder"
        >
          <Folder size={12} />
        </button>
        <button
          type="button"
          onClick={onRefresh}
          className="rounded-sm p-1 text-neutral-600 hover:bg-white/5 hover:text-indigo-300"
          aria-label="Refresh Explorer"
          title="Refresh Explorer"
        >
          <RefreshCw size={12} />
        </button>
        <button
          type="button"
          onClick={onOpenFolder}
          className="rounded-sm p-1 text-neutral-600 hover:bg-white/5 hover:text-indigo-300"
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
          onClick={() => {
            setSelected(entry);
            if (entry.type === "directory") onFolder(entry.path);
            else onOpen(entry.path);
          }}
          onContextMenu={(event) => {
            event.preventDefault();
            event.stopPropagation();
            setSelected(entry);
            setMenu({ entry, x: event.clientX, y: event.clientY });
          }}
          className={`tree-row ${
            selected?.path === entry.path ? "bg-white/5 text-neutral-200" : ""
          } ${clipboard?.mode === "cut" && clipboard.path === entry.path ? "opacity-50" : ""}`}
          title={`${entry.path} — right-click for rename and delete`}
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
      {menu && (
        <ExplorerContextMenu
          menu={menu}
          folder={path}
          projectRootPath={projectRootPath}
          canPaste={Boolean(clipboard)}
          onClose={() => setMenu(undefined)}
          onOpen={onOpen}
          onFolder={onFolder}
          onCreate={onCreate}
          onRename={onRename}
          onDelete={onDelete}
          onRefresh={onRefresh}
          onClipboard={onClipboard}
          onPaste={onPaste}
          onDuplicate={onDuplicate}
          onCopyText={onCopyText}
        />
      )}
    </div>
  );
}

/**
 * Human-in-the-loop review of a proposed change.
 *
 * A file diff is reviewed hunk by hunk: each block can be accepted or rejected
 * independently, with accept-all and reject-all as shortcuts. Partial approval
 * applies only the accepted blocks and hands the rejected ones back to the
 * agent, which then continues the task around them. Anything that is not a file
 * diff (a command, a push) has no blocks to split, so it keeps the plain
 * approve/deny choice.
 */
function ApprovalReview({
  approval,
  fallbackPreview,
  onApprove,
}: {
  approval: RuntimeApprovalView;
  fallbackPreview: string;
  onApprove: (
    decision:
      boolean | { acceptedHunkIds: string[]; rejectedHunkIds: string[] },
  ) => void;
}) {
  const diff = asFileDiff(approval.preview);
  const hunks = diff?.hunks ?? [];
  const [accepted, setAccepted] = useState<Set<string>>(new Set());

  // Default to accepting everything, and reset whenever a new request arrives.
  // Keyed on the request id rather than the hunk array, which is a fresh object
  // on every render and would reset the user's selections as they clicked.
  const { requestId, preview } = approval;
  useEffect(() => {
    setAccepted(
      new Set((asFileDiff(preview)?.hunks ?? []).map((hunk) => hunk.id)),
    );
  }, [requestId, preview]);

  const toggle = (id: string): void =>
    setAccepted((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const acceptedIds = hunks
    .map((hunk) => hunk.id)
    .filter((id) => accepted.has(id));
  const rejectedIds = hunks
    .map((hunk) => hunk.id)
    .filter((id) => !accepted.has(id));

  return (
    <div className="mt-4 border border-amber-400/20 bg-amber-500/5 p-3">
      <div className="flex items-center gap-2 text-[11px] font-medium text-amber-200/90">
        <ShieldCheck size={13} /> Approval required
      </div>
      <div className="mt-2 flex items-center gap-2 text-xs text-neutral-300">
        <span>{approval.call.name}</span>
        {diff && (
          <span className="truncate font-mono text-[10px] text-neutral-600">
            {diff.path}
          </span>
        )}
      </div>

      {hunks.length === 0 ? (
        <pre className="mt-2 max-h-40 overflow-auto whitespace-pre-wrap rounded bg-black/25 p-2 font-mono text-[9px] leading-4 text-neutral-500">
          {fallbackPreview}
        </pre>
      ) : (
        <>
          <div className="mt-2 flex items-center gap-2 text-[9px] text-neutral-500">
            <span>
              {acceptedIds.length} of {hunks.length} blocks selected
            </span>
            <button
              type="button"
              onClick={() => setAccepted(new Set(hunks.map((hunk) => hunk.id)))}
              className="ml-auto text-emerald-400/80 hover:text-emerald-300"
            >
              Accept all
            </button>
            <button
              type="button"
              onClick={() => setAccepted(new Set())}
              className="text-rose-400/80 hover:text-rose-300"
            >
              Reject all
            </button>
          </div>
          <div className="mt-2 max-h-64 space-y-2 overflow-auto">
            {hunks.map((hunk) => {
              const isAccepted = accepted.has(hunk.id);
              return (
                <label
                  key={hunk.id}
                  className={`block cursor-pointer rounded border p-2 transition ${
                    isAccepted
                      ? "border-emerald-400/25 bg-emerald-500/[0.04]"
                      : "border-white/5 bg-black/20 opacity-60"
                  }`}
                >
                  <div className="flex items-center gap-2 text-[9px] text-neutral-500">
                    <input
                      type="checkbox"
                      checked={isAccepted}
                      onChange={() => toggle(hunk.id)}
                      className="accent-emerald-500"
                    />
                    <span className="font-mono">
                      lines {hunk.startLine}-{hunk.endLine}
                    </span>
                    <span
                      className={`ml-auto ${isAccepted ? "text-emerald-400/80" : "text-rose-400/80"}`}
                    >
                      {isAccepted ? "accept" : "reject"}
                    </span>
                  </div>
                  <pre className="mt-1 max-h-32 overflow-auto whitespace-pre-wrap font-mono text-[9px] leading-4">
                    {hunk.original && (
                      <span className="text-rose-300/70">
                        {prefixLines(hunk.original, "-")}
                      </span>
                    )}
                    {hunk.replacement && (
                      <span className="text-emerald-300/70">
                        {prefixLines(hunk.replacement, "+")}
                      </span>
                    )}
                  </pre>
                </label>
              );
            })}
          </div>
        </>
      )}

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
          onClick={() =>
            onApprove(
              hunks.length === 0 || rejectedIds.length === 0
                ? true
                : {
                    acceptedHunkIds: acceptedIds,
                    rejectedHunkIds: rejectedIds,
                  },
            )
          }
          disabled={hunks.length > 0 && acceptedIds.length === 0}
          className="rounded bg-amber-400/15 px-2 py-1 text-[10px] text-amber-200 hover:bg-amber-400/20 disabled:text-amber-200/30"
        >
          {hunks.length === 0 || rejectedIds.length === 0
            ? "Approve"
            : `Apply ${acceptedIds.length} block${acceptedIds.length === 1 ? "" : "s"}`}
        </button>
      </div>
    </div>
  );
}

/** Renders each line of a hunk side with a unified-diff marker. */
function prefixLines(value: string, marker: "+" | "-"): string {
  const lines = value.replace(/\n$/u, "").split("\n");
  return `${lines.map((line) => `${marker}${line}`).join("\n")}\n`;
}

function MenuItem({
  label,
  shortcut,
  danger,
  disabled,
  onSelect,
}: {
  label: string;
  shortcut?: string;
  danger?: boolean;
  disabled?: boolean;
  onSelect: () => void;
}) {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onSelect}
      className={`flex w-full items-center gap-3 px-3 py-1 text-left text-[11px] disabled:text-neutral-700 disabled:hover:bg-transparent ${
        danger
          ? "text-rose-300/80 hover:bg-rose-500/10 hover:text-rose-300"
          : "text-neutral-400 hover:bg-white/5 hover:text-neutral-200"
      }`}
    >
      <span className="flex-1 truncate">{label}</span>
      {shortcut && (
        <span className="font-mono text-[9px] text-neutral-600">
          {shortcut}
        </span>
      )}
    </button>
  );
}

/** Confirmation for a destructive action that is not a file deletion. */
function ConfirmDialog({
  title,
  body,
  confirmLabel,
  onCancel,
  onConfirm,
}: {
  title: string;
  body: string;
  confirmLabel: string;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const cancelButton = useRef<HTMLButtonElement>(null);
  const previousFocus = useRef<HTMLElement | null>(null);

  useEffect(() => {
    previousFocus.current =
      document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null;
    // Focus lands on Cancel, so an accidental Enter does not destroy anything.
    cancelButton.current?.focus();
    return () => {
      const target = previousFocus.current;
      if (target?.isConnected) target.focus();
    };
  }, []);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      onCancel();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onCancel]);

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60"
      role="dialog"
      aria-modal="true"
      aria-label={title}
      onClick={(event) => {
        if (event.target === event.currentTarget) onCancel();
      }}
    >
      <div className="w-80 border border-white/10 bg-panel p-4 shadow-xl">
        <p className="text-xs font-medium text-neutral-200">{title}</p>
        <p className="mt-2 text-[11px] leading-4 text-neutral-500">{body}</p>
        <div className="mt-4 flex justify-end gap-2">
          <button
            ref={cancelButton}
            type="button"
            onClick={onCancel}
            className="border border-white/10 px-3 py-1 text-[11px] text-neutral-400 hover:text-neutral-200"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={onConfirm}
            className="border border-red-400/40 bg-red-500/20 px-3 py-1 text-[11px] text-red-200"
          >
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}

/**
 * In-app replacement for `window.prompt`.
 *
 * Electron's renderer does not implement `prompt()`: it returns undefined
 * without showing anything, so every explorer action built on it - create file,
 * create folder, rename - silently did nothing in the desktop app. The same
 * reason `window.confirm` was already replaced for delete.
 */
function PromptDialog({
  title,
  label,
  initialValue = "",
  confirmLabel = "Create",
  busy,
  onCancel,
  onConfirm,
}: {
  title: string;
  label: string;
  initialValue?: string;
  confirmLabel?: string;
  busy?: boolean;
  onCancel: () => void;
  onConfirm: (value: string) => void;
}) {
  const [value, setValue] = useState(initialValue);
  const input = useRef<HTMLInputElement>(null);
  const previousFocus = useRef<HTMLElement | null>(null);

  useEffect(() => {
    previousFocus.current =
      document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null;
    input.current?.focus();
    // Select the stem of a filename so a rename replaces the name but keeps
    // the extension unless the user types over it.
    const dot = initialValue.lastIndexOf(".");
    input.current?.setSelectionRange(0, dot > 0 ? dot : initialValue.length);
    return () => {
      const target = previousFocus.current;
      if (target?.isConnected) target.focus();
    };
  }, [initialValue]);

  const submit = (): void => {
    const trimmed = value.trim();
    if (!trimmed || busy) return;
    onConfirm(trimmed);
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60"
      role="dialog"
      aria-modal="true"
      aria-label={title}
      onClick={(event) => {
        if (event.target === event.currentTarget && !busy) onCancel();
      }}
    >
      <div className="w-80 border border-white/10 bg-panel p-4 shadow-xl">
        <p className="text-xs font-medium text-neutral-200">{title}</p>
        <label className="mt-3 block text-[10px] uppercase tracking-wide text-neutral-600">
          {label}
        </label>
        <input
          ref={input}
          value={value}
          disabled={busy}
          onChange={(event) => setValue(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.preventDefault();
              submit();
            } else if (event.key === "Escape") {
              event.preventDefault();
              if (!busy) onCancel();
            }
          }}
          className="field mt-1 w-full"
        />
        <div className="mt-4 flex justify-end gap-2">
          <button
            type="button"
            onClick={onCancel}
            disabled={busy}
            className="border border-white/10 px-3 py-1 text-[11px] text-neutral-400 hover:text-neutral-200"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={submit}
            disabled={busy || !value.trim()}
            className="border border-indigo-400/40 bg-indigo-500/20 px-3 py-1 text-[11px] text-indigo-200 disabled:opacity-40"
          >
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}

/**
 * Non-blocking destructive-action confirmation for the desktop renderer.
 * Native `window.confirm()` blocks Electron's web contents and can leave the
 * renderer without a usable focus owner after the selected row is removed.
 */
function DeleteConfirmation({
  entry,
  busy,
  onCancel,
  onConfirm,
}: {
  entry: FileEntry;
  busy: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const cancelButton = useRef<HTMLButtonElement>(null);
  const previousFocus = useRef<HTMLElement | null>(null);

  useEffect(() => {
    previousFocus.current =
      document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null;
    cancelButton.current?.focus();
    return () => {
      const target = previousFocus.current;
      if (target?.isConnected) target.focus();
    };
  }, []);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== "Escape" || busy) return;
      event.preventDefault();
      onCancel();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [busy, onCancel]);

  return (
    <div
      className="fixed inset-0 z-[100] grid place-items-center bg-black/65 p-4 backdrop-blur-[1px]"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget && !busy) onCancel();
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="delete-confirmation-title"
        aria-describedby="delete-confirmation-description"
        className="w-full max-w-sm rounded-md border border-white/10 bg-[#141414] p-4 shadow-2xl shadow-black/70"
      >
        <div className="flex items-start gap-3">
          <div className="mt-0.5 rounded-md bg-rose-500/10 p-2 text-rose-300">
            <Trash2 size={16} />
          </div>
          <div className="min-w-0">
            <h2
              id="delete-confirmation-title"
              className="text-sm font-medium text-neutral-200"
            >
              Delete {entry.type === "directory" ? "folder" : "file"}?
            </h2>
            <p
              id="delete-confirmation-description"
              className="mt-1 break-words text-xs leading-5 text-neutral-500"
            >
              {entry.type === "directory"
                ? `${entry.name} and everything inside it will be permanently deleted.`
                : `${entry.name} will be permanently deleted.`}
            </p>
          </div>
        </div>
        <div className="mt-5 flex justify-end gap-2">
          <button
            ref={cancelButton}
            type="button"
            disabled={busy}
            onClick={onCancel}
            className="rounded border border-white/10 px-3 py-1.5 text-xs text-neutral-400 hover:bg-white/5 hover:text-neutral-200 disabled:opacity-50"
          >
            Cancel
          </button>
          <button
            type="button"
            disabled={busy}
            onClick={onConfirm}
            className="flex items-center gap-1.5 rounded bg-rose-500/15 px-3 py-1.5 text-xs text-rose-200 hover:bg-rose-500/25 disabled:opacity-50"
          >
            {busy && <RefreshCw size={11} className="animate-spin" />}
            {busy ? "Deleting…" : "Delete"}
          </button>
        </div>
      </div>
    </div>
  );
}

function MenuSeparator() {
  return <div className="my-1 h-px bg-white/5" />;
}

/**
 * The explorer context menu. Right-clicking an entry offers the actions that
 * apply to it; right-clicking empty space offers only the ones that make sense
 * with nothing selected. Positioning is clamped so a menu opened near the
 * bottom or right edge stays on screen.
 */
function ExplorerContextMenu({
  menu,
  folder,
  projectRootPath,
  canPaste,
  onClose,
  onOpen,
  onFolder,
  onCreate,
  onRename,
  onDelete,
  onRefresh,
  onClipboard,
  onPaste,
  onDuplicate,
  onCopyText,
}: {
  menu: { entry?: FileEntry; x: number; y: number };
  folder: string;
  projectRootPath: string;
  canPaste: boolean;
  onClose: () => void;
  onOpen: (path: string) => void;
  onFolder: (path: string) => void;
  onCreate: (type: "file" | "directory") => void;
  onRename: (entry: FileEntry) => void;
  onDelete: (entry: FileEntry) => void;
  onRefresh: () => void;
  onClipboard: (path: string, mode: "copy" | "cut") => void;
  onPaste: (folder: string) => void;
  onDuplicate: (entry: FileEntry) => void;
  onCopyText: (value: string, label: string) => void;
}) {
  const { entry } = menu;
  const width = 216;
  const height = entry ? 300 : 150;
  const left = Math.min(menu.x, Math.max(8, window.innerWidth - width - 8));
  const top = Math.min(menu.y, Math.max(8, window.innerHeight - height - 8));
  const run = (action: () => void) => () => {
    onClose();
    action();
  };
  const separator = projectRootPath.includes("\\") ? "\\" : "/";
  const absolutePath = entry
    ? `${projectRootPath.replace(/[/\\]$/u, "")}/${entry.path}`
        .split("/")
        .join(separator)
    : projectRootPath;

  return (
    <div
      className="fixed z-50 rounded-md border border-white/10 bg-panel py-1 shadow-2xl shadow-black/60"
      style={{ left, top, width }}
      onClick={(event) => event.stopPropagation()}
      onContextMenu={(event) => event.preventDefault()}
    >
      {entry ? (
        <>
          <div className="truncate px-3 pb-1 font-mono text-[9px] text-neutral-600">
            {entry.path}
          </div>
          <MenuItem
            label={entry.type === "directory" ? "Open Folder" : "Open"}
            onSelect={run(() =>
              entry.type === "directory"
                ? onFolder(entry.path)
                : onOpen(entry.path),
            )}
          />
          <MenuSeparator />
          <MenuItem
            label="Cut"
            shortcut="Ctrl X"
            onSelect={run(() => onClipboard(entry.path, "cut"))}
          />
          <MenuItem
            label="Copy"
            shortcut="Ctrl C"
            onSelect={run(() => onClipboard(entry.path, "copy"))}
          />
          <MenuItem
            label="Paste"
            shortcut="Ctrl V"
            disabled={!canPaste}
            onSelect={run(() =>
              onPaste(entry.type === "directory" ? entry.path : folder),
            )}
          />
          <MenuSeparator />
          <MenuItem
            label="Copy Path"
            onSelect={run(() => onCopyText(absolutePath, "path"))}
          />
          <MenuItem
            label="Copy Relative Path"
            onSelect={run(() => onCopyText(entry.path, "relative path"))}
          />
          <MenuSeparator />
          <MenuItem
            label="Duplicate"
            onSelect={run(() => onDuplicate(entry))}
          />
          <MenuItem
            label="Rename…"
            shortcut="F2"
            onSelect={run(() => onRename(entry))}
          />
          <MenuItem
            label="Delete"
            shortcut="Del"
            danger
            onSelect={run(() => onDelete(entry))}
          />
        </>
      ) : (
        <>
          <div className="truncate px-3 pb-1 font-mono text-[9px] text-neutral-600">
            {folder}
          </div>
          <MenuItem label="New File…" onSelect={run(() => onCreate("file"))} />
          <MenuItem
            label="New Folder…"
            onSelect={run(() => onCreate("directory"))}
          />
          <MenuSeparator />
          <MenuItem
            label="Paste"
            shortcut="Ctrl V"
            disabled={!canPaste}
            onSelect={run(() => onPaste(folder))}
          />
          <MenuItem
            label="Copy Path"
            onSelect={run(() => onCopyText(absolutePath, "path"))}
          />
          <MenuSeparator />
          <MenuItem label="Refresh Explorer" onSelect={run(onRefresh)} />
        </>
      )}
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

/**
 * Previous conversations in this project, newest first.
 *
 * Sessions were always persisted and project-scoped; what was missing was a way
 * to see them. A dropdown of identically titled entries is not history, so
 * conversations are named from their first prompt and listed with when they
 * were last touched and how much was said.
 */
function HistoryPanel({
  sessions,
  selectedSessionId,
  onOpen,
  onRename,
  onDelete,
  onCreate,
}: {
  sessions: SessionView[];
  selectedSessionId?: string;
  onOpen: (sessionId: string) => void;
  onRename: (session: SessionView) => void;
  onDelete: (session: SessionView) => void;
  onCreate: () => void;
}) {
  if (sessions.length === 0) {
    return (
      <div className="min-h-0 flex-1 overflow-y-auto px-2">
        <Empty label="No conversations in this project yet" />
      </div>
    );
  }
  return (
    <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-2">
      <button
        type="button"
        onClick={onCreate}
        className="mb-2 mt-1 flex w-full items-center gap-2 border border-white/5 px-2 py-1.5 text-[11px] text-neutral-400 hover:bg-white/[0.03] hover:text-neutral-200"
      >
        <Plus size={12} /> New conversation
      </button>
      {sessions.map((session) => {
        const turns = (session.messages ?? []).filter(
          (message) => message.role === "user",
        ).length;
        const active = session.id === selectedSessionId;
        return (
          <div
            key={session.id}
            className={`group mb-1 border px-2 py-1.5 ${
              active
                ? "border-indigo-400/40 bg-indigo-500/10"
                : "border-transparent hover:bg-white/[0.03]"
            }`}
          >
            <button
              type="button"
              onClick={() => onOpen(session.id)}
              className="block w-full text-left"
              title={session.title}
            >
              <span className="line-clamp-2 text-[11px] leading-4 text-neutral-300">
                {session.title}
              </span>
              <span className="mt-1 block text-[9px] uppercase tracking-wide text-neutral-600">
                {relativeTime(session.updatedAt)} ·{" "}
                {turns === 1 ? "1 message" : `${turns} messages`}
              </span>
            </button>
            <div className="mt-1 flex gap-2 opacity-0 transition group-hover:opacity-100">
              <button
                type="button"
                onClick={() => onRename(session)}
                className="text-[9px] uppercase tracking-wide text-neutral-600 hover:text-neutral-300"
              >
                Rename
              </button>
              <button
                type="button"
                onClick={() => onDelete(session)}
                className="text-[9px] uppercase tracking-wide text-neutral-600 hover:text-red-300"
              >
                Delete
              </button>
            </div>
          </div>
        );
      })}
    </div>
  );
}

/** Compact "2 hours ago" style stamp for history rows. */
function relativeTime(timestamp: number): string {
  const seconds = Math.max(0, Math.round((Date.now() - timestamp) / 1000));
  if (seconds < 60) return "just now";
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  if (days < 30) return `${days}d ago`;
  return new Date(timestamp).toLocaleDateString();
}

function AgentsPanel({ agents }: { agents: AgentView[] }) {
  return (
    <div className="min-h-0 flex-1 overflow-y-auto px-2">
      <p className="px-1 py-2 text-[10px] leading-4 text-neutral-600">
        The composer runs Auto by default: it reads each prompt and picks the
        route itself. Choosing a specific agent overrides that for the next
        message. Stage agents are driven by the pipeline and cannot be picked.
      </p>
      {agents.map((agent) => (
        <div
          key={agent.id}
          className="mb-2 border border-white/5 bg-black/10 p-2"
        >
          <div className="flex items-center gap-2 text-xs text-neutral-300">
            <Bot size={13} className="text-indigo-400" />
            {agent.name}
            <StatusDot status={agent.enabled ? "completed" : "idle"} />
            <span className="ml-auto text-[9px] uppercase tracking-wide text-neutral-600">
              {agent.automatic
                ? "auto"
                : agent.selectable === false
                  ? "stage"
                  : "manual"}
            </span>
          </div>
          <p className="mt-1.5 text-[10px] leading-4 text-neutral-600">
            {agent.description}
          </p>
        </div>
      ))}
    </div>
  );
}

/**
 * Persisted tasks, with a resume action on the ones that were interrupted.
 *
 * A long task can outlive the window that started it. Its stage checkpoints are
 * durable, so resuming continues from the last completed stage rather than
 * repeating finished work; without an affordance here that capability was
 * unreachable from the IDE.
 */
function TaskList({
  tasks,
  onResume,
}: {
  tasks: TaskView[];
  onResume: (task: TaskView) => void;
}) {
  const resumable = (status: string): boolean =>
    status === "paused" || status === "failed" || status === "pending";
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
            <div className="mt-1 flex items-center justify-between text-[9px] uppercase tracking-wide text-neutral-700">
              <span>{task.currentStage}</span>
              <div className="flex items-center gap-2">
                <span>{shortDate(task.updatedAt)}</span>
                {resumable(task.status) && (
                  <button
                    type="button"
                    onClick={() => onResume(task)}
                    className="rounded-sm bg-indigo-500/15 px-1.5 py-0.5 uppercase tracking-wide text-indigo-300 hover:bg-indigo-500/25"
                    title="Continue this task from its last saved stage"
                  >
                    Resume
                  </button>
                )}
              </div>
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
        <img
          src="/logo.jpeg"
          alt="Agent Zero"
          className="mb-5 size-12 rounded-md object-cover"
        />
        <h1 className="text-xl font-medium tracking-tight text-neutral-200">
          Agent Zero
        </h1>
        <p className="mt-1 text-sm text-neutral-500">
          Build with a coordinated agent team.
        </p>
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
  selection,
  isolated,
  onAddContext,
  onRemoveContext,
  onOpenReference,
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
  onApprove: (
    decision:
      boolean | { acceptedHunkIds: string[]; rejectedHunkIds: string[] },
  ) => void;
  context: ContextItem[];
  activePath?: string;
  selection?: LineRange;
  isolated: IsolatedExchange[];
  onAddContext: (path: string, range?: LineRange) => void;
  onRemoveContext: (id: string) => void;
  onOpenReference: (path: string, range?: LineRange) => void;
}) {
  const composerRef = useRef<HTMLTextAreaElement>(null);
  const [mentionQuery, setMentionQuery] = useState<string>();
  const [mentionPaths, setMentionPaths] = useState<string[]>([]);
  const [mentionIndex, setMentionIndex] = useState(0);

  // Load @-mention candidates for the token currently under the caret.
  useEffect(() => {
    if (mentionQuery === undefined) {
      setMentionPaths([]);
      return;
    }
    let cancelled = false;
    void requestJson<{ paths: string[] }>(
      `/api/files/lookup?q=${encodeURIComponent(mentionQuery)}`,
    )
      .then((body) => {
        if (!cancelled) setMentionPaths(body.paths);
      })
      .catch(() => {
        if (!cancelled) setMentionPaths([]);
      });
    return () => {
      cancelled = true;
    };
  }, [mentionQuery]);

  /** Updates the draft and opens the picker for an `@path` token at the caret. */
  const handleComposerChange = (
    event: React.ChangeEvent<HTMLTextAreaElement>,
  ): void => {
    const { value, selectionStart } = event.target;
    onComposerText(value);
    const match = /@([\w./-]*)$/u.exec(value.slice(0, selectionStart));
    setMentionQuery(match ? (match[1] ?? "") : undefined);
    setMentionIndex(0);
  };

  /** Completes the caret's `@` token and pins the chosen file to context. */
  const applyMention = (path: string): void => {
    const element = composerRef.current;
    const caret = element?.selectionStart ?? composerText.length;
    const before = composerText.slice(0, caret).replace(/@[\w./-]*$/u, "");
    const next = `${before}@${path} ${composerText.slice(caret)}`;
    onComposerText(next);
    setMentionQuery(undefined);
    onAddContext(path);
    requestAnimationFrame(() => {
      const position = before.length + path.length + 2;
      element?.focus();
      element?.setSelectionRange(position, position);
    });
  };

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
            title="Auto reads the prompt and routes it. Pick a specific agent to override that."
          >
            {agents
              .filter((agent) => agent.enabled && agent.selectable !== false)
              .map((agent) => (
                <option key={agent.id} value={agent.id}>
                  {agent.automatic ? `Auto (${agent.name})` : agent.name}
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
              <MessageBody
                text={message.content}
                onOpenReference={onOpenReference}
              />
            </div>
          ))}
          {liveTurns.map((turn) => (
            <div key={turn.taskId} className="space-y-3">
              <div className="ml-6 rounded-md bg-indigo-500/10 px-3 py-2 text-xs leading-5 text-indigo-100/80">
                <MessageBody
                  text={turn.prompt}
                  onOpenReference={onOpenReference}
                />
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
                {turn.response ? (
                  <MessageBody
                    text={turn.response}
                    onOpenReference={onOpenReference}
                  />
                ) : (
                  <span className="flex items-center gap-2 text-indigo-300/70">
                    <RefreshCw size={11} className="animate-spin" /> Agent is
                    working…
                  </span>
                )}
              </div>
            </div>
          ))}
          {isolated.map((exchange) => (
            <div
              key={exchange.id}
              className="border border-dashed border-amber-400/20 bg-amber-500/[0.03] p-2"
            >
              <div className="text-[9px] uppercase tracking-[0.12em] text-amber-300/60">
                /bytheway · isolated, not added to this task's context
              </div>
              <div className="mt-1 text-xs leading-5 text-amber-100/70">
                {exchange.question}
              </div>
              <div className="mt-2 border-t border-amber-400/10 pt-2 text-xs leading-5 text-neutral-400">
                {exchange.error ? (
                  <span className="text-rose-300/80">{exchange.error}</span>
                ) : exchange.answer ? (
                  <MessageBody
                    text={exchange.answer}
                    onOpenReference={onOpenReference}
                  />
                ) : (
                  <span className="flex items-center gap-2 text-amber-300/70">
                    <RefreshCw size={11} className="animate-spin" /> Answering…
                  </span>
                )}
              </div>
            </div>
          ))}
        </div>

        {pendingApproval && (
          <ApprovalReview
            approval={pendingApproval}
            fallbackPreview={
              approvalPreview ??
              JSON.stringify(pendingApproval.call.arguments, null, 2)
            }
            onApprove={onApprove}
          />
        )}

        <div className="my-4 h-px bg-white/5" />
        <div className="mb-2 flex items-center justify-between text-[9px] font-medium uppercase tracking-[0.12em] text-neutral-600">
          <span>
            Active context ·{" "}
            {context.reduce((sum, item) => sum + item.tokenEstimate, 0)} tokens
          </span>
          {activePath && (
            <button
              type="button"
              onClick={() => onAddContext(activePath)}
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
                <button
                  type="button"
                  className="truncate text-left hover:text-indigo-300"
                  title={`Open ${item.filePath}`}
                  onClick={() =>
                    item.filePath &&
                    onOpenReference(
                      item.filePath,
                      item.startLine && item.endLine
                        ? { startLine: item.startLine, endLine: item.endLine }
                        : undefined,
                    )
                  }
                >
                  {item.filePath}
                  {item.startLine ? `:${item.startLine}-${item.endLine}` : ""}
                </button>
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
        <div className="relative rounded-md border border-white/5 bg-black/25 p-2 shadow-2xl shadow-black/30 transition focus-within:border-indigo-400/20">
          {mentionQuery !== undefined && mentionPaths.length > 0 && (
            <div className="absolute bottom-full left-0 z-20 mb-1 max-h-56 w-full overflow-y-auto rounded-md border border-white/10 bg-panel p-1 shadow-2xl shadow-black/50">
              {mentionPaths.map((path, index) => (
                <button
                  key={path}
                  type="button"
                  onMouseDown={(event) => {
                    event.preventDefault();
                    applyMention(path);
                  }}
                  className={`flex w-full items-center gap-1.5 truncate px-2 py-1 text-left font-mono text-[10px] ${
                    index === mentionIndex
                      ? "bg-indigo-500/15 text-indigo-200"
                      : "text-neutral-500 hover:text-neutral-300"
                  }`}
                >
                  <File size={10} className="shrink-0" /> {path}
                </button>
              ))}
            </div>
          )}
          <textarea
            ref={composerRef}
            rows={3}
            value={composerText}
            onChange={handleComposerChange}
            onBlur={() => setMentionQuery(undefined)}
            onKeyDown={(event) => {
              const menuOpen =
                mentionQuery !== undefined && mentionPaths.length > 0;
              if (menuOpen) {
                if (event.key === "ArrowDown") {
                  event.preventDefault();
                  setMentionIndex((current) =>
                    Math.min(current + 1, mentionPaths.length - 1),
                  );
                  return;
                }
                if (event.key === "ArrowUp") {
                  event.preventDefault();
                  setMentionIndex((current) => Math.max(current - 1, 0));
                  return;
                }
                if (event.key === "Enter" || event.key === "Tab") {
                  event.preventDefault();
                  applyMention(mentionPaths[mentionIndex] ?? mentionPaths[0]!);
                  return;
                }
                if (event.key === "Escape") {
                  event.preventDefault();
                  setMentionQuery(undefined);
                  return;
                }
              }
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
              onClick={() => activePath && onAddContext(activePath)}
              className="flex items-center gap-1 text-[10px] text-neutral-500 hover:text-indigo-300 disabled:text-neutral-700"
              title={
                activePath
                  ? "Add the active file to agent context"
                  : "Open a file before adding context"
              }
            >
              <Plus size={12} /> File
            </button>
            <button
              type="button"
              disabled={!activePath || !selection}
              onClick={() =>
                activePath && selection && onAddContext(activePath, selection)
              }
              className="ml-3 flex items-center gap-1 text-[10px] text-neutral-500 hover:text-indigo-300 disabled:text-neutral-700"
              title={
                selection
                  ? `Add lines ${selection.startLine}-${selection.endLine} to agent context`
                  : "Select lines in the editor to add a code block"
              }
            >
              <Code2 size={12} />{" "}
              {selection
                ? `Lines ${selection.startLine}-${selection.endLine}`
                : "Selection"}
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
            : "Enter to send · @ to tag a file · /bytheway for an isolated question"}
        </div>
      </div>
    </aside>
  );
}

function Dashboard({
  tasks,
  liveTaskId,
}: {
  tasks: TaskView[];
  liveTaskId?: string;
}) {
  const [selectedTaskId, setSelectedTaskId] = useState<string>();
  const [spans, setSpans] = useState<TraceSpan[]>([]);
  const [spend, setSpend] = useState<TaskSpendView>();
  const [selectedSpanId, setSelectedSpanId] = useState<string>();
  useEffect(() => {
    setSelectedTaskId((current) => current ?? liveTaskId ?? tasks[0]?.id);
  }, [liveTaskId, tasks]);

  // Follow a task that starts while the dashboard is open, so the running and
  // finished views are the same view rather than two separate modes.
  useEffect(() => {
    if (liveTaskId) setSelectedTaskId(liveTaskId);
  }, [liveTaskId]);

  const refresh = useCallback(async (taskId: string) => {
    try {
      const [traces, cost] = await Promise.all([
        requestJson<{ spans: TraceSpan[] }>(
          `/api/tasks/${encodeURIComponent(taskId)}/traces`,
        ),
        requestJson<{ spend: TaskSpendView }>(
          `/api/tasks/${encodeURIComponent(taskId)}/spend`,
        ).catch(() => undefined),
      ]);
      setSpans(traces.spans);
      setSpend(cost?.spend);
      setSelectedSpanId((current) =>
        current && traces.spans.some((span) => span.spanId === current)
          ? current
          : traces.spans[0]?.spanId,
      );
    } catch {
      setSpans([]);
    }
  }, []);

  useEffect(() => {
    if (!selectedTaskId) {
      setSpans([]);
      setSpend(undefined);
      return;
    }
    void refresh(selectedTaskId);
    // While the selected task is running, keep polling so the hierarchy, token
    // counts, and spend grow in place instead of appearing only at the end.
    if (selectedTaskId !== liveTaskId) return;
    const timer = window.setInterval(() => {
      void refresh(selectedTaskId);
    }, 1500);
    return () => window.clearInterval(timer);
  }, [liveTaskId, refresh, selectedTaskId]);
  const selected = spans.find((span) => span.spanId === selectedSpanId);
  // Spans are hierarchical: task includes stages, stages include agents, and
  // agents include model/tool calls. Summing them counts the same wall-clock
  // interval three or four times. The task span is the authoritative elapsed
  // duration; the range fallback keeps live/legacy traces useful.
  const taskSpan = spans.find((span) => span.kind === "task");
  const earliestStart = spans.reduce(
    (earliest, span) => Math.min(earliest, span.startedAt),
    Number.POSITIVE_INFINITY,
  );
  const latestEnd = spans.reduce(
    (latest, span) =>
      Math.max(
        latest,
        span.durationMs === undefined
          ? span.status === "running"
            ? Date.now()
            : span.startedAt
          : span.startedAt + span.durationMs,
      ),
    0,
  );
  const totalDuration =
    taskSpan?.durationMs ??
    (Number.isFinite(earliestStart)
      ? Math.max(0, latestEnd - earliestStart)
      : 0);
  const totalCost =
    spend?.costUsd ??
    spans.reduce((total, span) => total + (span.cost ?? 0), 0);
  const tracedModelCalls = spans.filter(
    (span) => span.kind === "model_call",
  ).length;
  const modelCalls = Math.max(spend?.modelCalls ?? 0, tracedModelCalls);
  const toolCalls = spans.filter((span) => span.kind === "tool").length;
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex h-14 shrink-0 items-center border-b border-white/5 px-4">
        <div>
          <h2 className="text-sm font-medium text-neutral-200">
            Observability
          </h2>
          <p className="mt-0.5 text-[10px] text-neutral-600">
            {selectedTaskId && selectedTaskId === liveTaskId ? (
              <span className="flex items-center gap-1.5 text-emerald-400/80">
                <RefreshCw size={9} className="animate-spin" /> Live · updating
                while the task runs
              </span>
            ) : (
              "Persisted task hierarchy and exact recorded payloads"
            )}
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

// The runtime emits `pipeline_step`, `model_call`, `provider_attempt`,
// `plan_expansion`, and `compaction`, so these match on prefix rather than on
// exact equality — equality silently gave almost every node the fallback icon.
function TraceIcon({ kind }: { kind: string }) {
  if (kind.startsWith("agent"))
    return <Bot size={13} className="shrink-0 text-indigo-400" />;
  if (kind.startsWith("tool"))
    return <TerminalSquare size={13} className="shrink-0 text-amber-400/80" />;
  if (kind.startsWith("provider") || kind.startsWith("model"))
    return <Zap size={13} className="shrink-0 text-cyan-400/80" />;
  if (kind.startsWith("pipeline") || kind.startsWith("plan"))
    return <Boxes size={13} className="shrink-0 text-violet-400/80" />;
  if (kind.startsWith("compaction"))
    return <Layers size={13} className="shrink-0 text-emerald-400/80" />;
  return <Activity size={13} className="shrink-0 text-neutral-500" />;
}

/** A context slice as the runtime records it on a trace span. */
interface ContextArtifactView {
  source?: string;
  path?: string;
  startLine?: number;
  endLine?: number;
  content?: string;
  tokenEstimate?: number;
  reasons?: string[];
  extractor?: string;
}

function isArtifactList(value: unknown): value is ContextArtifactView[] {
  return (
    Array.isArray(value) &&
    value.length > 0 &&
    value.every(
      (item) => typeof item === "object" && item !== null && "content" in item,
    )
  );
}

/**
 * The files and slices an agent had, and why each one is there.
 *
 * Rendered rather than dumped as JSON: "which code was in this agent's context"
 * is a question a person asks while debugging a bad answer, and a wall of
 * escaped source is not an answer.
 */
function ContextArtifacts({ items }: { items: ContextArtifactView[] }) {
  const [openPath, setOpenPath] = useState<string>();
  const total = items.reduce((sum, item) => sum + (item.tokenEstimate ?? 0), 0);
  return (
    <div className="min-h-0 flex-1 overflow-auto p-3">
      <p className="mb-2 text-[10px] uppercase tracking-wide text-neutral-600">
        {items.length} slice{items.length === 1 ? "" : "s"} · ~{total} tokens
      </p>
      {items.map((item, index) => {
        const label = item.path
          ? item.startLine
            ? `${item.path}:${item.startLine}-${item.endLine ?? item.startLine}`
            : item.path
          : (item.source ?? "context");
        const key = `${label}:${index}`;
        const open = openPath === key;
        return (
          <div key={key} className="mb-1.5 border border-white/5 bg-black/20">
            <button
              type="button"
              onClick={() => setOpenPath(open ? undefined : key)}
              className="flex w-full items-center gap-2 px-2 py-1.5 text-left"
            >
              <FileCode2 size={12} className="shrink-0 text-indigo-400/80" />
              <span className="truncate font-mono text-[10px] text-neutral-300">
                {label}
              </span>
              <span className="ml-auto shrink-0 text-[9px] uppercase tracking-wide text-neutral-600">
                {item.extractor ?? item.source}
              </span>
            </button>
            {(item.reasons ?? []).length > 0 && (
              <div className="flex flex-wrap gap-1 px-2 pb-1.5">
                {(item.reasons ?? []).map((reason) => (
                  <span
                    key={reason}
                    className={`rounded-sm px-1.5 py-0.5 text-[9px] ${
                      /call-graph/.test(reason)
                        ? "bg-violet-500/15 text-violet-300"
                        : /exact|symbol/.test(reason)
                          ? "bg-indigo-500/15 text-indigo-300"
                          : "bg-white/5 text-neutral-500"
                    }`}
                  >
                    {reason}
                  </span>
                ))}
              </div>
            )}
            {open && (
              <pre className="max-h-64 overflow-auto border-t border-white/5 px-2 py-1.5 font-mono text-[10px] leading-4 text-neutral-500">
                {item.content}
              </pre>
            )}
          </div>
        );
      })}
    </div>
  );
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
      {tab === "context" && isArtifactList(value) ? (
        <ContextArtifacts items={value} />
      ) : (
        <pre className="min-h-0 flex-1 overflow-auto whitespace-pre-wrap break-words p-4 font-mono text-[10px] leading-5 text-neutral-500">
          {value === undefined
            ? "No data was recorded for this field."
            : JSON.stringify(value, null, 2)}
        </pre>
      )}
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
