import React, { useEffect, useReducer, useRef, useState } from "react";
import { Box, Text, useApp, useInput, useStdout } from "ink";
import Spinner from "ink-spinner";
import TextInput from "ink-text-input";
import {
  MultiAgentOrchestrator,
  ToolRegistry,
  analyzeCodeStructureTool,
  computeAstDiffTool,
  type AgentDefinition,
  type ConversationMessage,
  type LanguageModel,
  type MultiAgentEvent,
  type ToolCall,
} from "@agentic-runtime/core";
import {
  createDefaultProviderGateway,
  DEFAULT_CREDENTIAL_ENV_FALLBACK,
  PROVIDER_FIELD_SPECS,
  StoredCredentialResolver,
  validateStoredProvider,
} from "@agentic-runtime/gateway";
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
const REVIEWER_AGENT_ID = "reviewer";
const TUI_MAX_MODEL_STEPS = 32;
const RESERVED_AGENT_IDS = new Set([
  DEFAULT_AGENT_ID,
  CODING_AGENT_ID,
  REVIEWER_AGENT_ID,
]);

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
  const activeTaskId = useRef<string | undefined>(undefined);
  const running =
    state.status === "thinking" ||
    state.status === "tool" ||
    state.status === "approval";
  const width = Math.max(60, Math.min(stdout.columns ?? 100, 140));

  useEffect(() => () => runtimeContext.store.close(), [runtimeContext]);

  approvalHandler.current = (call, preview) =>
    new Promise((resolve) => {
      approvalResolver.current = resolve;
      runtimeContext.store.appendEvent({
        sessionId: runtimeContext.session.id,
        taskId: activeTaskId.current,
        type: "approval_requested",
        payload: { call, preview },
      });
      dispatch({ type: "approval_requested", call, preview });
    });
  eventHandler.current = (event) => {
    if (event.type === "agent_event" && event.agentEvent) {
      if (event.agentEvent.type === "context_compacted") {
        runtimeContext.store.addContextItem({
          taskId: activeTaskId.current,
          source: "summary",
          content: event.agentEvent.summary,
          priority: "critical",
          pinned: false,
          tokenEstimate: Math.ceil(event.agentEvent.summary.length / 4),
        });
      }
      runtimeContext.store.appendEvent({
        sessionId: runtimeContext.session.id,
        taskId: activeTaskId.current,
        type: event.agentEvent.type,
        payload: { agentId: event.agentId, event: event.agentEvent },
      });
      dispatch({
        type: "agent_event",
        agentId: event.agentId,
        event: event.agentEvent,
      });
    } else {
      runtimeContext.store.appendEvent({
        sessionId: runtimeContext.session.id,
        taskId: activeTaskId.current,
        type: event.type,
        payload: { event },
      });
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
        runtimeContext.store.appendEvent({
          sessionId: runtimeContext.session.id,
          taskId: activeTaskId.current,
          type: "approval_resolved",
          payload: { approved },
        });
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
    if (prompt === "/settings" || prompt.startsWith("/settings ")) {
      const reply = await handleSettingsCommand(
        runtimeContext.store,
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
    const task = runtimeContext.store.createTask(
      runtimeContext.session.id,
      prompt,
    );
    activeTaskId.current = task.id;
    runtimeContext.store.updateSession(runtimeContext.session.id, {
      status: "running",
    });
    runtimeContext.store.updateTask(task.id, {
      status: "running",
      currentStage: "agent",
    });
    runtimeContext.store.appendEvent({
      sessionId: runtimeContext.session.id,
      taskId: task.id,
      type: "task_started",
      payload: { prompt, agentId: activeAgentId },
    });
    dispatch({
      type: "task_started",
      taskId: task.id,
      sessionId: runtimeContext.session.id,
      agentId: activeAgentId,
      maxSteps: TUI_MAX_MODEL_STEPS,
    });
    const history = messages.filter((message) => message.role !== "system");
    try {
      const contextString = runtimeContext.store.buildContext(task.id, 20000);
      const result = await runtimeContext.runtime.run(
        activeAgentId,
        prompt,
        contextString,
        history,
      );
      const nextMessages = result.messages ?? [
        ...history,
        { role: "user" as const, content: prompt },
        { role: "assistant" as const, content: result.text },
      ];
      setMessages(nextMessages);
      runtimeContext.store.saveMessages(
        runtimeContext.session.id,
        nextMessages,
      );
      if (result.status === "completed") {
        runtimeContext.store.updateTask(task.id, {
          status: "completed",
          currentStage: "completed",
          state: { ...task.state, result: result.text },
        });
        runtimeContext.store.appendEvent({
          sessionId: runtimeContext.session.id,
          taskId: task.id,
          type: "task_completed",
          payload: { text: result.text },
        });
        dispatch({ type: "task_completed", text: result.text });
      } else {
        runtimeContext.store.updateTask(task.id, {
          status: "failed",
          currentStage: "failed",
          state: { ...task.state, errors: [result.text] },
        });
        runtimeContext.store.appendEvent({
          sessionId: runtimeContext.session.id,
          taskId: task.id,
          type: "task_failed",
          payload: { error: result.text },
        });
        dispatch({ type: "task_failed", error: result.text });
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      runtimeContext.store.updateTask(task.id, {
        status: "failed",
        currentStage: "failed",
        state: { ...task.state, errors: [message] },
      });
      runtimeContext.store.updateSession(runtimeContext.session.id, {
        status: "idle",
      });
      runtimeContext.store.appendEvent({
        sessionId: runtimeContext.session.id,
        taskId: task.id,
        type: "task_failed",
        payload: { error: message },
      });
      dispatch({ type: "task_failed", error: message });
    } finally {
      runtimeContext.store.updateSession(runtimeContext.session.id, {
        status: "idle",
      });
      activeTaskId.current = undefined;
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
        ? (process.env.GROQ_MODEL ??
          process.env.OPENAI_COMPATIBLE_MODEL ??
          "qwen/qwen3.6-27b")
        : (process.env.OPENROUTER_MODEL ??
          process.env.OPENAI_COMPATIBLE_MODEL ??
          process.env.OPENAI_MODEL ??
          "");
  const store = new SessionStore({ projectRoot: workspaceRoot });
  store.registerAgent({
    id: DEFAULT_AGENT_ID,
    name: "Architect",
    description:
      "Strictly-planning lead coordinator that turns requests into focused, atomic steps for the coding specialist.",
    systemPrompt: `You are ARCHITECT, the lead planner for an agentic coding IDE.

Persona
- You are calm, precise, and operationally disciplined.
- You act like a strong technical lead: clarify the objective internally, gather only the evidence needed to plan, and keep the user informed without noise.
- You do not pretend to have performed work that was not verified by a tool or specialist.

STRICTLY A PLANNER
- You NEVER write code and NEVER modify files yourself.
- You must NEVER call apply_patch, write_file, create_file, delete_file, run_command, compile_code, run_code, format_code, syntax_check, or any other mutating or execution tool. Those tools are not part of your toolset; if a task seems to require them, that is a signal to delegate, not to improvise around the restriction.
- Your only allowed tools are list_directory, read_file, find_files, and browse_url, used strictly to gather evidence for planning.

Primary responsibility
1. Classify each request as conversation, investigation, research, or implementation work.
2. Answer simple conversation directly. Never delegate greetings, acknowledgements, or questions that need no tools.
3. For read-only questions, use list_directory, read_file, find_files, and browse_url only when evidence is needed.
4. For anything requiring an edit, a shell command, a build, a test, a package change, a Git mutation, or any other implementation work, produce a plan and delegate it to coding-agent. Never attempt it yourself.
5. Your output for implementation work must be a numbered, atomic list of steps, for example:
   1. Step 1...
   2. Step 2...
   Followed by a call to handoff_agent(targetAgentId='coding-agent', task='<focused task>', context='<evidence/file paths>', reason='<why>').
6. When a specialist returns, evaluate whether it answered the requested objective. If evidence is incomplete, request one focused follow-up instead of repeating the entire task.
7. Summarize verified results, affected files, checks run, failures, and remaining decisions.

Tool and safety policy
- Respect your tool boundary. Do not emulate unavailable tools with shell snippets, invented Python, or prose instructions for the user to run commands.
- Never bypass approval. Mutation and side-effect permissions belong exclusively to the coding specialist.
- Avoid duplicate tool calls and stop when the objective is complete or blocked.

Communication
- Keep updates concise, factual, and action-oriented.
- State assumptions only when they materially affect the result.
- Do not reveal private chain-of-thought. Show safe progress: what is being investigated, planned, delegated, or blocked.
- Do not ask the user to execute a tool that a specialist can execute.

Project instructions may be supplied separately. Follow them whenever they apply.`,
    capabilities: ["classification", "planning", "delegation"],
    allowedTools: ["list_directory", "read_file", "find_files", "browse_url"],
    delegatesTo: CODING_AGENT_ID,
    maxSteps: 24,
    enabled: true,
  });
  store.registerAgent({
    id: CODING_AGENT_ID,
    name: "Coder",
    description:
      "Surgical implementer that turns a focused plan from Architect into an exact patch, then hands off for verification.",
    systemPrompt: `You are SURGICAL CODER, the implementation specialist for an agentic coding IDE.

Persona
- You are token-efficient and direct. No pleasantries, no broad explanations of what the code does.
- You receive a focused plan and evidence from Architect (or a direct task from the user) and implement exactly what was asked, nothing more.

Workflow
1. Use analyze_code_structure {code, symbols} to slice large files down to only the relevant semantic blocks before reasoning about them, saving context tokens.
2. Use compute_ast_diff {original, proposal} to get the structural DiffChunk(s) describing the exact change before writing it.
3. Apply the change with apply_patch, write_file, create_file, or delete_file using exact oldContent/newContent taken from what you actually read or sliced. Never guess at file contents.
4. Use run_command only when a command is required to implement or validate the change (installing a dependency, generating a file, etc.).
5. Immediately after the mutation succeeds, call handoff_agent(targetAgentId='reviewer', task='Verify <what>', context='<diff/files changed>', reason='Implementation complete') so the change gets independently verified. Do not declare the task complete yourself.

Constraints
- Do not explain broadly or narrate obvious steps; report only what changed and why a decision was non-obvious.
- Never stage or commit node_modules, dist, build, target, caches, logs, credentials, or other generated output.
- Before a requested commit, inspect git_status and git_diff, verify .gitignore excludes generated dependency output, and stage only explicit source, configuration, documentation, and lockfile paths.
- If a dependency install is required, explain why, request runtime approval for the command, and commit only manifest/lockfile changes; never commit the installed dependency directory.

${loadProjectInstructions(store.project.rootPath).join("\n\n")}`,
    capabilities: ["coding", "implementation", "delegation"],
    allowedTools: [
      "read_file",
      "find_files",
      "list_directory",
      "apply_patch",
      "write_file",
      "create_file",
      "delete_file",
      "run_command",
      "analyze_code_structure",
      "compute_ast_diff",
      "git_status",
      "git_diff",
      "git_log",
      "git_branches",
    ],
    delegatesTo: REVIEWER_AGENT_ID,
    maxSteps: 24,
    enabled: true,
  });
  store.registerAgent({
    id: REVIEWER_AGENT_ID,
    name: "Reviewer",
    description: "Dual-blind verification agent that verifies Coder work.",
    systemPrompt: `You are DUAL-BLIND VERIFIER, the verification specialist for an agentic coding IDE.

Sole job: verify Coder's work. You do not implement features and you do not mutate files except to fix a failure you have personally verified.

Workflow
1. Run syntax checks via compile_code or syntax_check (for example tsc --noEmit) on the affected files.
2. Run the relevant test suite via run_command.
3. Check git_diff to confirm the change matches what was reported and nothing unintended (node_modules, dist, build, credentials) is staged.
4. If any check fails, call handoff_agent(targetAgentId='coding-agent', task='Fix the following failure', context='<full error trace and affected files>', reason='Verification failed') with the complete error trace so Coder can fix it without re-discovering the failure.
5. If every check passes, return a final success summary listing the verified files, the diff, and each check that passed.

Constraints
- Never mutate files directly unless you are fixing a failure you just verified yourself, and even then keep the fix minimal and re-verify it.
- Be precise about what was checked; do not claim a check passed unless a tool actually ran it.`,
    capabilities: ["verification", "review"],
    allowedTools: [
      "read_file",
      "find_files",
      "list_directory",
      "run_command",
      "compile_code",
      "git_diff",
      "syntax_check",
    ],
    delegatesTo: CODING_AGENT_ID,
    maxSteps: 24,
    enabled: true,
  });
  for (const agent of loadProjectAgents(store.project.rootPath))
    if (!RESERVED_AGENT_IDS.has(agent.id)) store.registerAgent(agent);
  const model = createModel(provider, modelName, store);
  const runtime = new MultiAgentOrchestrator(
    store,
    () => model,
    () => {
      const registry = new ToolRegistry();
      for (const tool of createIdeTools()) registry.register(tool);
      registry.register(analyzeCodeStructureTool);
      registry.register(computeAstDiffTool);
      return registry;
    },
    {
      cwd: store.project.rootPath,
      requestApproval: approval,
      maxDepth: 4,
      maxHandoffs: 8,
      maxHandoffsPerPair: 2,
      maxModelSteps: TUI_MAX_MODEL_STEPS,
      maxDurationMs: 10 * 60_000,
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

function createModel(
  provider: string,
  modelName: string,
  store: SessionStore,
): LanguageModel {
  // Settings saved through /settings or the GUI always win; a matching
  // OLLAMA_ENDPOINT/OPENROUTER_API_KEY/etc. in .env is only used the first
  // time, before anything has been saved to the settings store.
  const credentials = new StoredCredentialResolver(
    store,
    DEFAULT_CREDENTIAL_ENV_FALLBACK,
  );
  const gateway = createDefaultProviderGateway({ credentials });
  const storedBaseUrl = (fallback: string): string | undefined =>
    store.getProviderSetting(provider, "baseUrl") ?? fallback;
  if (provider === "ollama") {
    gateway.configure({
      providerId: "ollama",
      baseUrl: storedBaseUrl(
        process.env.OLLAMA_ENDPOINT ?? "http://localhost:11434",
      ),
    });
  } else if (provider === "openrouter") {
    gateway.configure({
      providerId: "openrouter",
      credentialRef: "openrouter",
    });
  } else if (provider === "groq") {
    gateway.configure({
      providerId: "groq",
      credentialRef: "groq",
    });
  } else if (provider === "openai-compatible") {
    gateway.configure({
      providerId: "openai-compatible",
      baseUrl: storedBaseUrl(process.env.OPENAI_COMPATIBLE_BASE_URL ?? ""),
      credentialRef: "openai-compatible",
      manualModelId:
        store.getProviderSetting("openai-compatible", "manualModelId") ??
        modelName,
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
  return "/help  /new  /clear  /sessions  /agents  /agent [id]  /settings  /details  /thinking  /exit\nTab switches agents. Ctrl+C cancels the active task or exits.";
}

async function handleSettingsCommand(
  store: SessionStore,
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

function formatProviderSettings(store: SessionStore): string {
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

function formatProviderDetail(store: SessionStore, providerId: string): string {
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
