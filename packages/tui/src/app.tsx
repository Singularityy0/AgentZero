import React, { useEffect, useReducer, useRef, useState } from "react";
import { Box, Text, useApp, useInput, useStdout } from "ink";
import Spinner from "ink-spinner";
import TextInput from "ink-text-input";
import {
  MultiAgentOrchestrator,
  ToolRegistry,
  type AgentDefinition,
  type ConversationMessage,
  type LanguageModel,
  type MultiAgentEvent,
  type ToolCall,
} from "@agentic-runtime/core";
import { createDefaultProviderGateway } from "@agentic-runtime/gateway";
import {
  loadProjectAgents,
  loadProjectInstructions,
  SessionStore,
  type SessionRecord,
} from "@agentic-runtime/session";
import { createIdeTools } from "@agentic-runtime/tools";
import { initialTuiState, reduceTuiState, type TuiState } from "./ui-state.js";

const DEFAULT_AGENT_ID = "general";
const CODING_AGENT_ID = "coding-agent";
const RESERVED_AGENT_IDS = new Set([DEFAULT_AGENT_ID, CODING_AGENT_ID]);

const colors = {
  cyan: "cyan",
  blue: "blue",
  green: "green",
  yellow: "yellow",
  red: "red",
  magenta: "magenta",
  gray: "gray",
  white: "white",
} as const;

interface RuntimeContext {
  store: SessionStore;
  runtime: MultiAgentOrchestrator;
  model: string;
  provider: string;
  session: SessionRecord;
}

export function App({
  workspaceRoot,
}: {
  workspaceRoot: string;
}): React.ReactElement {
  const { exit } = useApp();
  const { stdout } = useStdout();
  const approvalHandler = useRef<
    ((call: ToolCall, preview?: string) => Promise<boolean>) | undefined
  >(undefined);
  const eventHandler = useRef<((event: MultiAgentEvent) => void) | undefined>(
    undefined,
  );
  const [runtimeContext] = useState(() =>
    createRuntimeContext(
      workspaceRoot,
      (call, preview) =>
        approvalHandler.current?.(call, preview) ?? Promise.resolve(false),
      (event) => eventHandler.current?.(event),
    ),
  );
  const [state, dispatch] = useReducer(reduceTuiState, {
    ...initialTuiState,
    activeAgentId: getInitialAgent(runtimeContext.store),
    model: runtimeContext.model,
    provider: runtimeContext.provider,
    sessionId: runtimeContext.session.id,
  });
  const [messages, setMessages] = useState<ConversationMessage[]>([]);
  const [activeAgentId, setActiveAgentId] = useState(state.activeAgentId);
  const [input, setInput] = useState("");
  const approvalResolver = useRef<((approved: boolean) => void) | undefined>(
    undefined,
  );
  const running =
    state.status === "thinking" ||
    state.status === "tool" ||
    state.status === "approval";
  const width = Math.max(60, Math.min(stdout.columns ?? 100, 140));

  useEffect(() => () => runtimeContext.store.close(), [runtimeContext]);

  approvalHandler.current = (call, preview) =>
    new Promise((resolve) => {
      approvalResolver.current = resolve;
      dispatch({ type: "approval_requested", call, preview });
    });
  eventHandler.current = (event) => {
    if (event.type === "agent_event" && event.agentEvent) {
      dispatch({
        type: "agent_event",
        agentId: event.agentId,
        event: event.agentEvent,
      });
    } else {
      dispatch({ type: "multi_agent_event", event });
    }
  };

  useInput(
    (value, key) => {
      if (key.ctrl && value === "c") {
        if (approvalResolver.current) {
          approvalResolver.current(false);
          approvalResolver.current = undefined;
        } else {
          exit();
        }
      }
      if (
        state.approval &&
        (value.toLowerCase() === "y" || value.toLowerCase() === "n")
      ) {
        const approved = value.toLowerCase() === "y";
        approvalResolver.current?.(approved);
        approvalResolver.current = undefined;
        dispatch({ type: "approval_resolved", approved });
      }
    },
    { isActive: Boolean(state.approval) || running },
  );

  const submit = async (value: string): Promise<void> => {
    const prompt = value.trim();
    setInput("");
    if (!prompt) return;
    if (prompt === "/exit" || prompt === "/quit") {
      exit();
      return;
    }
    if (prompt === "/help") {
      setMessages((current) => [
        ...current,
        { role: "assistant", content: helpText() },
      ]);
      return;
    }
    if (prompt === "/agents") {
      setMessages((current) => [
        ...current,
        {
          role: "assistant",
          content: formatAgents(
            runtimeContext.store.listAgents(),
            activeAgentId,
          ),
        },
      ]);
      return;
    }
    if (prompt === "/agent") {
      setMessages((current) => [
        ...current,
        {
          role: "assistant",
          content: `Active agent: ${activeAgentId}\n\n${formatAgents(runtimeContext.store.listAgents(), activeAgentId)}`,
        },
      ]);
      return;
    }
    if (prompt.startsWith("/agent ")) {
      const id = prompt.slice(7).trim();
      const agent = runtimeContext.store.getAgent(id);
      if (!agent?.enabled) {
        setMessages((current) => [
          ...current,
          { role: "assistant", content: `Enabled agent not found: ${id}` },
        ]);
      } else {
        setActiveAgentId(id);
        dispatch({ type: "task_completed", text: `Active agent: ${id}` });
      }
      return;
    }
    if (prompt === "/new") {
      const session = runtimeContext.store.createSession();
      runtimeContext.session = session;
      setMessages([]);
      dispatch({
        type: "task_completed",
        text: `Started session ${session.id}`,
      });
      return;
    }
    if (prompt === "/clear") {
      setMessages([]);
      runtimeContext.store.saveMessages(runtimeContext.session.id, []);
      dispatch({ type: "task_completed", text: "Current transcript cleared" });
      return;
    }
    if (prompt === "/sessions") {
      setMessages((current) => [
        ...current,
        {
          role: "assistant",
          content: formatSessions(
            runtimeContext.store.listSessions(),
            runtimeContext.session.id,
          ),
        },
      ]);
      return;
    }
    await runTask(prompt);
  };

  const runTask = async (prompt: string): Promise<void> => {
    const task = runtimeContext.store.createTask(
      runtimeContext.session.id,
      prompt,
    );
    runtimeContext.store.updateTask(task.id, {
      status: "running",
      currentStage: "agent",
    });
    const agent = runtimeContext.store.getAgent(activeAgentId);
    dispatch({
      type: "task_started",
      taskId: task.id,
      sessionId: runtimeContext.session.id,
      agentId: activeAgentId,
      maxSteps: agent?.maxSteps ?? 24,
    });
    const history = messages.filter((message) => message.role !== "system");
    try {
      const result = await runtimeContext.runtime.run(
        activeAgentId,
        prompt,
        "",
        history,
      );
      setMessages(
        result.messages ?? [
          ...history,
          { role: "assistant", content: result.text },
        ],
      );
      runtimeContext.store.saveMessages(
        runtimeContext.session.id,
        result.messages ?? [],
      );
      if (result.status === "completed") {
        dispatch({ type: "task_completed", text: result.text });
      } else {
        dispatch({ type: "task_failed", error: result.text });
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      dispatch({ type: "task_failed", error: message });
    }
  };

  return (
    <Box flexDirection="column" width={width} minHeight={20}>
      <Header state={state} width={width} />
      <Box flexDirection="column" paddingX={1} flexGrow={1}>
        {messages
          .filter((message) => message.role !== "system")
          .slice(-8)
          .map((message, index) => (
            <MessageView key={`${index}-${message.role}`} message={message} />
          ))}
        <ActivityPanel state={state} />
      </Box>
      {state.approval ? <ApprovalPanel approval={state.approval} /> : null}
      <Footer state={state} />
      <Box
        borderStyle="round"
        borderColor={running ? colors.yellow : colors.cyan}
        paddingX={1}
      >
        <Text color={colors.cyan}>{running ? "  " : "> "}</Text>
        <TextInput
          value={input}
          onChange={setInput}
          onSubmit={submit}
          placeholder={running ? "Agent is working..." : "Ask the agent..."}
        />
      </Box>
    </Box>
  );
}

function Header({
  state,
  width,
}: {
  state: TuiState;
  width: number;
}): React.ReactElement {
  return (
    <Box
      flexDirection="column"
      borderStyle="double"
      borderColor={colors.cyan}
      paddingX={1}
    >
      <Box justifyContent="space-between">
        <Text color={colors.cyan} bold>
          RIGZA / AGENTIC RUNTIME
        </Text>
        <Text color={state.status === "failed" ? colors.red : colors.green}>
          {state.status.toUpperCase()}
        </Text>
      </Box>
      <Box justifyContent="space-between">
        <Text color={colors.white}>
          {state.model || "model unavailable"}{" "}
          <Text color={colors.gray}>via {state.provider}</Text>
        </Text>
        <Text color={colors.gray}>
          Agent: {state.activeAgentId} | {width} cols
        </Text>
      </Box>
    </Box>
  );
}

function MessageView({
  message,
}: {
  message: ConversationMessage;
}): React.ReactElement {
  const role =
    message.role === "user"
      ? "YOU"
      : message.role === "assistant"
        ? "ASSISTANT"
        : "TOOL";
  const color =
    message.role === "user"
      ? colors.green
      : message.role === "assistant"
        ? colors.blue
        : colors.gray;
  return (
    <Box flexDirection="column" marginTop={1}>
      <Text color={color} bold>
        {role}
      </Text>
      <Text wrap="wrap">{message.content}</Text>
    </Box>
  );
}

function ActivityPanel({
  state,
}: {
  state: TuiState;
}): React.ReactElement | null {
  if (state.status === "idle" && state.toolActivities.length === 0) return null;
  return (
    <Box
      flexDirection="column"
      marginTop={1}
      borderStyle="round"
      borderColor={state.status === "failed" ? colors.red : colors.magenta}
      paddingX={1}
    >
      <Text color={colors.magenta} bold>
        ACTIVITY
      </Text>
      <Text color={state.status === "failed" ? colors.red : colors.yellow}>
        {state.status === "thinking" ? (
          <Spinner type="dots" />
        ) : state.status === "tool" ? (
          <Spinner type="line" />
        ) : (
          "*"
        )}{" "}
        {state.lastProgress ?? "Waiting"}
      </Text>
      {state.handoffs.slice(-3).map((handoff, index) => (
        <Text
          key={`${handoff.parentAgentId}-${handoff.targetAgentId}-${index}`}
          color={colors.gray}
        >
          {" "}
          {handoff.parentAgentId} -&gt; {handoff.targetAgentId} [
          {handoff.status}]
        </Text>
      ))}
      {state.toolActivities.slice(-4).map((activity) => (
        <ToolCard key={activity.id} activity={activity} />
      ))}
      {state.error ? <Text color={colors.red}>{state.error}</Text> : null}
    </Box>
  );
}

function ToolCard({
  activity,
}: {
  activity: TuiState["toolActivities"][number];
}): React.ReactElement {
  const color =
    activity.status === "failed"
      ? colors.red
      : activity.status === "completed"
        ? colors.green
        : colors.yellow;
  return (
    <Box flexDirection="column" marginTop={1}>
      <Text color={color} bold>
        {" "}
        {activity.status === "running"
          ? "..."
          : activity.status === "completed"
            ? "OK"
            : "ERR"}{" "}
        {activity.call.name}
      </Text>
      <Text color={colors.gray}>
        {" "}
        {JSON.stringify(activity.call.arguments)}
      </Text>
      {activity.result ? (
        <Text color={activity.result.isError ? colors.red : colors.gray}>
          {" "}
          {summarize(activity.result.output)}
        </Text>
      ) : null}
    </Box>
  );
}

function ApprovalPanel({
  approval,
}: {
  approval: NonNullable<TuiState["approval"]>;
}): React.ReactElement {
  return (
    <Box
      flexDirection="column"
      borderStyle="round"
      borderColor={colors.yellow}
      paddingX={1}
    >
      <Text color={colors.yellow} bold>
        PERMISSION REQUIRED
      </Text>
      <Text>
        Tool: <Text color={colors.white}>{approval.call.name}</Text>
      </Text>
      <Text color={colors.gray}>{JSON.stringify(approval.call.arguments)}</Text>
      {approval.preview ? (
        <Text color={colors.gray}>{approval.preview}</Text>
      ) : null}
      <Text color={colors.yellow}>[y] allow once [n] deny [Ctrl+C] cancel</Text>
    </Box>
  );
}

function Footer({ state }: { state: TuiState }): React.ReactElement {
  const elapsed = state.startedAt
    ? Math.floor((Date.now() - state.startedAt) / 1000)
    : 0;
  return (
    <Box
      borderStyle="single"
      borderColor={colors.gray}
      paddingX={1}
      justifyContent="space-between"
    >
      <Text color={colors.gray}>
        session {state.sessionId?.slice(0, 12) ?? "-"} | task{" "}
        {state.taskId?.slice(0, 12) ?? "-"}
      </Text>
      <Text color={colors.gray}>
        step {state.step}/{state.maxSteps} | {elapsed}s | /help
      </Text>
    </Box>
  );
}

function createRuntimeContext(
  workspaceRoot: string,
  approval: (call: ToolCall, preview?: string) => Promise<boolean>,
  onEvent: (event: MultiAgentEvent) => void,
): RuntimeContext {
  const provider = (process.env.MODEL_PROVIDER ?? "ollama").toLowerCase();
  const modelName =
    provider === "ollama"
      ? (process.env.OLLAMA_MODEL ?? "")
      : provider === "groq"
        ? (process.env.GROQ_MODEL ?? "llama-3.3-70b-versatile")
        : (process.env.OPENROUTER_MODEL ?? process.env.OPENAI_MODEL ?? "");
  const store = new SessionStore({ projectRoot: workspaceRoot });
  const systemMessage = {
    role: "system" as const,
    content: `You are an IDE assistant. Use specialized tools, never invent tool results, and report concise progress.

Git and dependency hygiene
- Never stage or commit node_modules, dist, build, target, caches, logs, credentials, or other generated output.
- Before a requested commit, inspect git_status and git_diff, verify .gitignore excludes generated dependency output, and stage only explicit source, configuration, documentation, and lockfile paths.
- If a dependency install is required, explain why, request runtime approval for the command, and commit only manifest/lockfile changes; never commit the installed dependency directory.
- Before reporting a requested change complete, run the relevant build, test, lint, or format check when available and report the actual result.
${loadProjectInstructions(store.project.rootPath).join("\n\n")}`,
  };
  store.registerAgent({
    id: DEFAULT_AGENT_ID,
    name: "General Agent",
    description:
      "Lead coordinator that turns requests into focused, verified agent work.",
    systemPrompt: `You are Rigza General, the lead coordinator for an agentic coding IDE.

Persona
- You are calm, precise, and operationally disciplined.
- You act like a strong technical lead: clarify the objective internally, collect only useful evidence, choose the smallest capable specialist, and keep the user informed without noise.
- You do not pretend to have performed work that was not verified by a tool or specialist.

Primary responsibility
1. Classify each request as conversation, investigation, research, implementation, debugging, verification, or repository work.
2. Answer simple conversation directly. Never delegate greetings, acknowledgements, or questions that need no tools.
3. For read-only questions, use the permitted inspection, web, and Git tools only when evidence is needed.
4. For edits, shell commands, builds, tests, package changes, Git mutations, or any task requiring implementation, hand off one focused task to coding-agent.
5. Give every handoff a concrete objective, relevant evidence, constraints, and a clear completion condition.
6. When a specialist returns, evaluate whether it answered the requested objective. If evidence is incomplete, request one focused follow-up instead of repeating the entire task.
7. Summarize verified results, affected files, checks run, failures, and remaining decisions.

Tool and safety policy
- Respect your tool boundary. Do not emulate unavailable tools with shell snippets, invented Python, or prose instructions for the user to run commands.
- Use specialized tools by name when applicable: browse_url for a page, crawl_site for a bounded crawl, and git_* for repository operations.
- Never bypass approval. Mutation and side-effect permissions belong to the runtime and the coding specialist.
- Avoid duplicate tool calls and stop when the objective is complete or blocked.

Communication
- Keep updates concise, factual, and action-oriented.
- State assumptions only when they materially affect the result.
- Do not reveal private chain-of-thought. Show safe progress: what is being investigated, delegated, verified, or blocked.
- Do not ask the user to execute a tool that the runtime or a specialist can execute.

Project instructions may be supplied separately. Follow them whenever they apply.`,
    capabilities: ["classification", "delegation"],
    allowedTools: [
      "list_directory",
      "read_file",
      "find_files",
      "search_text",
      "browse_url",
      "crawl_site",
      "git_status",
      "git_diff",
      "git_log",
      "git_branches",
    ],
    delegatesTo: CODING_AGENT_ID,
    maxSteps: 24,
    enabled: true,
  });
  store.registerAgent({
    id: CODING_AGENT_ID,
    name: "Coding Agent",
    description: "Implements and verifies changes.",
    systemPrompt: systemMessage.content,
    capabilities: ["coding", "verification", "delegation"],
    maxSteps: 24,
    enabled: true,
  });
  for (const agent of loadProjectAgents(store.project.rootPath))
    if (!RESERVED_AGENT_IDS.has(agent.id)) store.registerAgent(agent);
  const model = createModel(provider, modelName);
  const runtime = new MultiAgentOrchestrator(
    store,
    () => model,
    () => {
      const registry = new ToolRegistry();
      for (const tool of createIdeTools()) registry.register(tool);
      return registry;
    },
    {
      cwd: store.project.rootPath,
      requestApproval: approval,
      onEvent,
    },
  );
  return {
    store,
    runtime,
    model: modelName,
    provider,
    // Resume is explicit: stale sessions must not silently become model context.
    session: store.createSession(),
  };
}

function createModel(provider: string, modelName: string): LanguageModel {
  const gateway = createDefaultProviderGateway();
  if (provider === "ollama") {
    gateway.configure({
      providerId: "ollama",
      baseUrl: process.env.OLLAMA_ENDPOINT ?? "http://localhost:11434",
    });
  } else if (provider === "openrouter") {
    gateway.configure({
      providerId: "openrouter",
      credentialRef: "OPENROUTER_API_KEY",
    });
  } else if (provider === "groq") {
    gateway.configure({
      providerId: "groq",
      credentialRef: "GROQ_API_KEY",
    });
  } else if (provider === "openai-compatible") {
    gateway.configure({
      providerId: "openai-compatible",
      baseUrl: process.env.OPENAI_COMPATIBLE_BASE_URL,
      credentialRef: process.env.OPENAI_COMPATIBLE_API_KEY
        ? "OPENAI_COMPATIBLE_API_KEY"
        : undefined,
      manualModelId: modelName,
    });
  } else {
    throw new Error(
      `Unsupported MODEL_PROVIDER: ${provider}. Use ollama, groq, openrouter, or openai-compatible.`,
    );
  }
  if (!modelName)
    throw new Error(`Set a model for ${provider} before starting the TUI.`);
  gateway.registerModel({
    id: modelName,
    name: modelName,
    providerId: provider,
    capabilities: {
      tools: true,
      vision: false,
      reasoning: false,
      streaming: true,
      structuredOutput: true,
    },
    metadata: {},
  });
  gateway.select(provider, modelName);
  return gateway;
}

function getInitialAgent(store: SessionStore): string {
  return store.getAgent(DEFAULT_AGENT_ID)?.enabled
    ? DEFAULT_AGENT_ID
    : (store.listAgents().find((agent) => agent.enabled)?.id ??
        DEFAULT_AGENT_ID);
}

function formatAgents(agents: AgentDefinition[], active: string): string {
  return agents
    .map(
      (agent) =>
        `${agent.id}${agent.id === active ? " (active)" : ""} - ${agent.description}`,
    )
    .join("\n");
}

function formatSessions(sessions: SessionRecord[], active: string): string {
  return (
    sessions
      .map(
        (session) =>
          `${session.id}${session.id === active ? " (active)" : ""} - ${session.title}`,
      )
      .join("\n") || "No saved sessions."
  );
}

function helpText(): string {
  return "/help  /new  /clear  /sessions  /agents  /agent [id]  /details  /thinking  /exit\nTab switches agents. Ctrl+C cancels the active task or exits.";
}

function summarize(value: string): string {
  const text = value.replace(/\s+/g, " ").trim();
  return text.length > 180 ? `${text.slice(0, 177)}...` : text;
}
