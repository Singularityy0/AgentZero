import React, { useEffect, useReducer, useRef, useState } from "react";
import { Box, Text, useApp, useInput, useStdout } from "ink";
import Spinner from "ink-spinner";
import TextInput from "ink-text-input";
import type {
  ConversationMessage,
  MultiAgentEvent,
  ToolApprovalResponse,
  ToolCall,
  ToolPreview,
} from "@agentic-runtime/core";
import {
  DEFAULT_CREDENTIAL_ENV_FALLBACK,
  PROVIDER_FIELD_SPECS,
  validateStoredProvider,
} from "@agentic-runtime/gateway";
import {
  createHeadlessRuntime,
  DEFAULT_AGENT_ID,
  DEFAULT_RUNTIME_LIMITS,
  type AgentDefinition,
  type HeadlessRuntimeService,
  type RuntimeEvent,
  type RuntimeModelRouteSelection,
  type RuntimeModelSelection,
  type RuntimeSettingsStore,
  type RuntimeTaskHandle,
  type SessionRecord,
} from "@agentic-runtime/runtime";
import { formatFileContexts, parseCommand } from "./commands.js";
import { initialTuiState, reduceTuiState, type TuiState } from "./ui-state.js";

const TUI_MAX_MODEL_STEPS = DEFAULT_RUNTIME_LIMITS.maxModelSteps;

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
  runtime: HeadlessRuntimeService;
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
    | ((call: ToolCall, preview?: ToolPreview) => Promise<ToolApprovalResponse>)
    | undefined
  >(undefined);
  const eventHandler = useRef<((event: RuntimeEvent) => void) | undefined>(
    undefined,
  );
  const [runtimeContext] = useState(() =>
    createRuntimeContext(
      workspaceRoot,
      (call, preview) =>
        approvalHandler.current?.(call, preview) ?? Promise.resolve(false),
    ),
  );
  const [state, dispatch] = useReducer(reduceTuiState, {
    ...initialTuiState,
    activeAgentId: getInitialAgent(runtimeContext.runtime),
    model: runtimeContext.model,
    provider: runtimeContext.provider,
    sessionId: runtimeContext.session.id,
  });
  const [messages, setMessages] = useState<ConversationMessage[]>([]);
  const [isolatedMessages, setIsolatedMessages] = useState<
    ConversationMessage[]
  >([]);
  const [activeAgentId, setActiveAgentId] = useState(state.activeAgentId);
  const [input, setInput] = useState("");
  const approvalResolver = useRef<
    ((decision: ToolApprovalResponse) => void) | undefined
  >(undefined);
  const activeTask = useRef<Pick<RuntimeTaskHandle, "cancel"> | undefined>(
    undefined,
  );
  const running =
    state.status === "thinking" ||
    state.status === "tool" ||
    state.status === "approval";
  const width = Math.max(60, Math.min(stdout.columns ?? 100, 140));

  useEffect(() => {
    const unsubscribe = runtimeContext.runtime.subscribe((event) =>
      eventHandler.current?.(event),
    );
    return () => {
      unsubscribe();
      void runtimeContext.runtime.close();
    };
  }, [runtimeContext]);

  approvalHandler.current = (call, preview) =>
    new Promise((resolve) => {
      approvalResolver.current = resolve;
      dispatch({ type: "approval_requested", call, preview });
    });
  eventHandler.current = (runtimeEvent) => {
    if (runtimeEvent.type === "routing_event") {
      dispatch({ type: "gateway_event", event: runtimeEvent.event });
      return;
    }
    if (runtimeEvent.type === "pipeline_event") {
      dispatch({ type: "pipeline_event", event: runtimeEvent.event });
      return;
    }
    if (runtimeEvent.type !== "orchestration_event") return;
    const event: MultiAgentEvent = runtimeEvent.event;
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
          activeTask.current?.cancel();
          dispatch({ type: "approval_resolved", approved: false });
          return;
        } else if (activeTask.current) {
          activeTask.current.cancel();
        } else {
          exit();
        }
      }
      if (!state.approval) return;
      const preview = state.approval.preview;
      if (typeof preview === "object") {
        if (key.upArrow || key.downArrow) {
          dispatch({
            type: "approval_focus_changed",
            offset: key.upArrow ? -1 : 1,
          });
          return;
        }
        if (value === " ") {
          dispatch({ type: "approval_hunk_toggled" });
          return;
        }
        if (value.toLowerCase() === "a") {
          approvalResolver.current?.(true);
          approvalResolver.current = undefined;
          dispatch({ type: "approval_resolved", approved: true });
          return;
        }
        if (value.toLowerCase() === "r" || value.toLowerCase() === "n") {
          approvalResolver.current?.(false);
          approvalResolver.current = undefined;
          dispatch({ type: "approval_resolved", approved: false });
          return;
        }
        if (value.toLowerCase() === "y" || key.return) {
          const acceptedHunkIds = state.approval.selectedHunkIds;
          const accepted = new Set(acceptedHunkIds);
          const decision = {
            acceptedHunkIds,
            rejectedHunkIds: preview.hunks
              .map((hunk) => hunk.id)
              .filter((id) => !accepted.has(id)),
          };
          approvalResolver.current?.(decision);
          approvalResolver.current = undefined;
          dispatch({
            type: "approval_resolved",
            approved: acceptedHunkIds.length > 0,
          });
        }
        return;
      }
      if (value.toLowerCase() === "y" || value.toLowerCase() === "n") {
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
    const parsedCommand = parseCommand(prompt);
    if (parsedCommand?.type === "invalid") {
      setMessages((current) => [
        ...current,
        { role: "assistant", content: parsedCommand.message },
      ]);
      return;
    }
    if (parsedCommand?.type === "context") {
      try {
        if (parsedCommand.action === "list") {
          const contexts = runtimeContext.runtime.listFileContext(
            runtimeContext.session.id,
          );
          setMessages((current) => [
            ...current,
            {
              role: "assistant",
              content:
                contexts.length > 0
                  ? `Manual context snapshots:\n${formatFileContexts(contexts)}`
                  : "No manual file context is selected.",
            },
          ]);
        } else if (parsedCommand.action === "add") {
          const added = await runtimeContext.runtime.addFileContext({
            sessionId: runtimeContext.session.id,
            path: parsedCommand.path,
            range:
              parsedCommand.startLine === undefined
                ? undefined
                : {
                    startLine: parsedCommand.startLine,
                    endLine: parsedCommand.endLine ?? parsedCommand.startLine,
                  },
          });
          setMessages((current) => [
            ...current,
            {
              role: "assistant",
              content: `Added context snapshot: ${formatFileContexts([added])}`,
            },
          ]);
        } else {
          const removed = runtimeContext.runtime.removeFileContext({
            sessionId: runtimeContext.session.id,
            path: parsedCommand.path,
            range:
              parsedCommand.startLine === undefined
                ? undefined
                : {
                    startLine: parsedCommand.startLine,
                    endLine: parsedCommand.endLine ?? parsedCommand.startLine,
                  },
          });
          setMessages((current) => [
            ...current,
            {
              role: "assistant",
              content: `Removed ${removed} manual context selection${removed === 1 ? "" : "s"}.`,
            },
          ]);
        }
      } catch (error) {
        setMessages((current) => [
          ...current,
          {
            role: "assistant",
            content: error instanceof Error ? error.message : String(error),
          },
        ]);
      }
      return;
    }
    if (parsedCommand?.type === "bytheway") {
      setIsolatedMessages((current) => [
        ...current,
        { role: "user", content: `[BY THE WAY]\n${parsedCommand.prompt}` },
      ]);
      dispatch({ type: "isolated_started" });
      try {
        const handle = runtimeContext.runtime.startIsolatedQuestion({
          sessionId: runtimeContext.session.id,
          agentId: activeAgentId,
          prompt: parsedCommand.prompt,
        });
        activeTask.current = handle;
        const result = await handle.completion;
        setIsolatedMessages((current) => [
          ...current,
          { role: "assistant", content: `[BY THE WAY]\n${result.text}` },
        ]);
        dispatch({ type: "isolated_completed", text: result.text });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        dispatch({ type: "isolated_failed", error: message });
      } finally {
        activeTask.current = undefined;
      }
      return;
    }
    if (prompt === "/agents") {
      setMessages((current) => [
        ...current,
        {
          role: "assistant",
          content: formatAgents(
            runtimeContext.runtime.listAgents(),
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
          content: `Active agent: ${activeAgentId}\n\n${formatAgents(runtimeContext.runtime.listAgents(), activeAgentId)}`,
        },
      ]);
      return;
    }
    if (prompt.startsWith("/agent ")) {
      const id = prompt.slice(7).trim();
      const agent = runtimeContext.runtime.getAgent(id);
      if (!agent?.enabled) {
        setMessages((current) => [
          ...current,
          { role: "assistant", content: `Enabled agent not found: ${id}` },
        ]);
      } else {
        setActiveAgentId(id);
        dispatch({ type: "agent_changed", agentId: id });
        dispatch({ type: "task_completed", text: `Active agent: ${id}` });
      }
      return;
    }
    if (prompt === "/new") {
      const session = runtimeContext.runtime.createSession();
      runtimeContext.session = session;
      setMessages([]);
      setIsolatedMessages([]);
      dispatch({ type: "session_changed", sessionId: session.id });
      dispatch({
        type: "task_completed",
        text: `Started session ${session.id}`,
      });
      return;
    }
    if (prompt === "/clear") {
      setMessages([]);
      setIsolatedMessages([]);
      runtimeContext.runtime.clearSession(runtimeContext.session.id);
      dispatch({ type: "task_completed", text: "Current transcript cleared" });
      return;
    }
    if (prompt === "/sessions") {
      setMessages((current) => [
        ...current,
        {
          role: "assistant",
          content: formatSessions(
            runtimeContext.runtime.listSessions(),
            runtimeContext.session.id,
          ),
        },
      ]);
      return;
    }
    if (prompt === "/settings" || prompt.startsWith("/settings ")) {
      const reply = await handleSettingsCommand(
        runtimeContext.runtime.settings,
        prompt.slice("/settings".length).trim(),
      );
      setMessages((current) => [
        ...current,
        { role: "assistant", content: reply },
      ]);
      return;
    }
    await runTask(prompt);
  };

  const runTask = async (prompt: string): Promise<void> => {
    try {
      const handle = runtimeContext.runtime.startTask({
        sessionId: runtimeContext.session.id,
        agentId: activeAgentId,
        prompt,
      });
      activeTask.current = handle;
      dispatch({
        type: "task_started",
        taskId: handle.taskId,
        sessionId: handle.sessionId,
        agentId: activeAgentId,
        maxSteps: TUI_MAX_MODEL_STEPS,
      });
      const result = await handle.completion;
      setMessages(result.messages);
      if (result.status === "completed") {
        dispatch({ type: "task_completed", text: result.text });
      } else if (result.status === "paused") {
        dispatch({
          type: "task_completed",
          text: `Task paused: ${result.text}`,
        });
      } else {
        dispatch({ type: "task_failed", error: result.text });
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      dispatch({ type: "task_failed", error: message });
    } finally {
      activeTask.current = undefined;
    }
  };

  return (
    <Box flexDirection="column" width={width} minHeight={20}>
      <Header state={state} width={width} />
      <Box flexDirection="column" paddingX={1} flexGrow={1}>
        {[...messages, ...isolatedMessages]
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
      {state.routeActivities.slice(-3).map((route, index) => (
        <Text
          key={`${route.providerId}-${route.modelId}-${route.attempt}-${index}`}
          color={route.status === "failed" ? colors.red : colors.magenta}
        >
          {route.status === "failed" ? " FAILOVER " : " ROUTE "}
          {route.providerId}/{route.modelId ?? "unknown"}
          {route.reason ? ` - ${summarize(route.reason)}` : ""}
        </Text>
      ))}
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
      {typeof approval.preview === "string" ? (
        <Text color={colors.gray}>{approval.preview}</Text>
      ) : approval.preview ? (
        <Box flexDirection="column">
          <Text color={colors.gray}>{approval.preview.text}</Text>
          {approval.preview.hunks.map((hunk, index) => {
            const selected = approval.selectedHunkIds.includes(hunk.id);
            const focused = index === approval.focusedHunk;
            return (
              <Text
                key={hunk.id}
                color={selected ? colors.green : colors.red}
                bold={focused}
              >
                {focused ? ">" : " "} [{selected ? "accept" : "reject"}]{" "}
                {hunk.id} {hunk.path}:{hunk.startLine}-{hunk.endLine}
              </Text>
            );
          })}
        </Box>
      ) : null}
      <Text color={colors.yellow}>
        {typeof approval.preview === "object"
          ? "[Up/Down] hunk [Space] toggle [y/Enter] apply selected [a] accept all [r] reject all"
          : "[y] allow once [n] deny [Ctrl+C] cancel"}
      </Text>
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
  approval: (
    call: ToolCall,
    preview?: ToolPreview,
  ) => Promise<ToolApprovalResponse>,
): RuntimeContext {
  const model = modelSelectionFromEnvironment(process.env);
  const runtime = createHeadlessRuntime({
    workspaceRoot,
    model,
    credentialEnvironmentFallback: DEFAULT_CREDENTIAL_ENV_FALLBACK,
    requestApproval: (request) => approval(request.call, request.preview),
  });
  return {
    runtime,
    model: model.modelId,
    provider: model.providerId,
    session: runtime.createSession(),
  };
}

function modelSelectionFromEnvironment(
  environment: NodeJS.ProcessEnv,
): RuntimeModelSelection {
  const providerId = (environment.MODEL_PROVIDER ?? "ollama").toLowerCase();
  if (
    providerId !== "ollama" &&
    providerId !== "groq" &&
    providerId !== "openrouter" &&
    providerId !== "openai-compatible"
  ) {
    throw new Error(
      "Unsupported MODEL_PROVIDER: " +
        providerId +
        ". Use ollama, groq, openrouter, or openai-compatible.",
    );
  }

  const modelId =
    providerId === "ollama"
      ? (environment.OLLAMA_MODEL ?? "")
      : providerId === "groq"
        ? (environment.GROQ_MODEL ??
          environment.OPENAI_COMPATIBLE_MODEL ??
          "qwen/qwen3.6-27b")
        : (environment.OPENROUTER_MODEL ??
          environment.OPENAI_COMPATIBLE_MODEL ??
          environment.OPENAI_MODEL ??
          "");
  const baseUrl =
    providerId === "ollama"
      ? (environment.OLLAMA_ENDPOINT ?? "http://localhost:11434")
      : providerId === "openai-compatible"
        ? environment.OPENAI_COMPATIBLE_BASE_URL
        : undefined;

  const fallbacks: RuntimeModelRouteSelection[] = [];
  if (environment.OLLAMA_MODEL) {
    fallbacks.push({
      providerId: "ollama",
      modelId: environment.OLLAMA_MODEL,
      baseUrl: environment.OLLAMA_ENDPOINT ?? "http://localhost:11434",
      credentialRef: null,
    });
  }
  if (environment.GROQ_MODEL) {
    fallbacks.push({
      providerId: "groq",
      modelId: environment.GROQ_MODEL,
      credentialRef: "groq",
    });
  }
  if (environment.OPENROUTER_MODEL) {
    fallbacks.push({
      providerId: "openrouter",
      modelId: environment.OPENROUTER_MODEL,
      credentialRef: "openrouter",
    });
  }
  if (
    environment.OPENAI_COMPATIBLE_MODEL &&
    environment.OPENAI_COMPATIBLE_BASE_URL
  ) {
    fallbacks.push({
      providerId: "openai-compatible",
      modelId: environment.OPENAI_COMPATIBLE_MODEL,
      baseUrl: environment.OPENAI_COMPATIBLE_BASE_URL,
      credentialRef: "openai-compatible",
    });
  }

  return {
    providerId,
    modelId,
    baseUrl,
    credentialRef: providerId === "ollama" ? null : providerId,
    fallbacks,
  };
}

function getInitialAgent(runtime: HeadlessRuntimeService): string {
  return runtime.getAgent(DEFAULT_AGENT_ID)?.enabled
    ? DEFAULT_AGENT_ID
    : (runtime.listAgents().find((agent) => agent.enabled)?.id ??
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
  return [
    "/help  /new  /clear  /sessions  /agents  /agent [id]  /settings  /exit",
    "/context [list]",
    "/context add <file>[:line|start-end]",
    "/context remove <file>[:line|start-end]",
    "/bytheway <isolated question>",
    "Ctrl+C cancels the active operation or exits.",
  ].join("\n");
}

async function handleSettingsCommand(
  store: RuntimeSettingsStore,
  rest: string,
): Promise<string> {
  if (!rest) return formatProviderSettings(store);
  const [providerId, ...tokens] = rest.split(/\s+/).filter(Boolean);
  const spec = PROVIDER_FIELD_SPECS.find((entry) => entry.id === providerId);
  if (!spec) {
    return `Unknown provider: ${providerId}\n\n${formatProviderSettings(store)}`;
  }
  if (tokens.length === 0) return formatProviderDetail(store, spec.id);
  if (tokens[0] === "clear") {
    store.clearCredential(spec.id);
    store.clearProviderSetting(spec.id, "baseUrl");
    store.clearProviderSetting(spec.id, "manualModelId");
    store.clearProviderSetting(spec.id, "lastValidation");
    return `Cleared settings for ${spec.id}.`;
  }
  if (tokens[0] === "validate") {
    const result = await validateStoredProvider(store, spec);
    store.setProviderSetting(
      spec.id,
      "lastValidation",
      JSON.stringify({ ...result, at: Date.now() }),
    );
    return result.ok
      ? `${spec.id} credentials are valid.`
      : `${spec.id} validation failed: ${result.message ?? "unknown error"}`;
  }
  let applied = 0;
  for (const token of tokens) {
    const eq = token.indexOf("=");
    if (eq === -1) continue;
    const key = token.slice(0, eq);
    const value = token.slice(eq + 1);
    if (key === "key" && spec.fields.includes("apiKey")) {
      store.setCredential(spec.id, value);
      applied += 1;
    } else if (key === "baseUrl" && spec.fields.includes("baseUrl")) {
      store.setProviderSetting(spec.id, "baseUrl", value);
      applied += 1;
    } else if (key === "model" && spec.fields.includes("manualModelId")) {
      store.setProviderSetting(spec.id, "manualModelId", value);
      applied += 1;
    }
  }
  return applied > 0
    ? `Updated ${applied} field(s) for ${spec.id}.\n\n${formatProviderDetail(store, spec.id)}`
    : `No recognized field=value pairs for ${spec.id}. Fields: ${spec.fields.join(", ")}. ` +
        `Use key=/baseUrl=/model=, "validate", or "clear".`;
}

function formatProviderSettings(store: RuntimeSettingsStore): string {
  const lines = PROVIDER_FIELD_SPECS.map((spec) => {
    const hasCredential = Boolean(store.getCredential(spec.id));
    const configured = spec.credentialRequired
      ? hasCredential
      : hasCredential || Boolean(store.getProviderSetting(spec.id, "baseUrl"));
    return `${spec.id}${" ".repeat(Math.max(1, 18 - spec.id.length))}${configured ? "configured" : "not configured"}`;
  });
  return [
    "Providers (use /settings <id> to see details, /settings <id> key=<value> to set):",
    ...lines,
  ].join("\n");
}

function formatProviderDetail(
  store: RuntimeSettingsStore,
  providerId: string,
): string {
  const spec = PROVIDER_FIELD_SPECS.find((entry) => entry.id === providerId);
  if (!spec) return `Unknown provider: ${providerId}`;
  const credential = store.getCredential(spec.id);
  const lastValidationRaw = store.getProviderSetting(spec.id, "lastValidation");
  const lastValidation = lastValidationRaw
    ? (JSON.parse(lastValidationRaw) as { ok: boolean; message?: string })
    : undefined;
  const lines = [
    `${spec.label} (${spec.id})`,
    spec.fields.includes("apiKey")
      ? `  key: ${credential ? maskSecret(credential) : "not set"}`
      : undefined,
    spec.fields.includes("baseUrl")
      ? `  baseUrl: ${store.getProviderSetting(spec.id, "baseUrl") ?? "not set"}`
      : undefined,
    spec.fields.includes("manualModelId")
      ? `  model: ${store.getProviderSetting(spec.id, "manualModelId") ?? "not set"}`
      : undefined,
    lastValidation
      ? `  last validation: ${lastValidation.ok ? "ok" : `failed - ${lastValidation.message ?? ""}`}`
      : "  last validation: never",
  ].filter((line): line is string => Boolean(line));
  return lines.join("\n");
}

function maskSecret(value: string): string {
  if (value.length <= 4) return "*".repeat(value.length);
  return `${"*".repeat(Math.max(0, value.length - 4))}${value.slice(-4)}`;
}

function summarize(value: string): string {
  const text = value.replace(/\s+/g, " ").trim();
  return text.length > 180 ? `${text.slice(0, 177)}...` : text;
}
