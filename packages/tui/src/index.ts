#!/usr/bin/env node

import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { config } from "dotenv";
import {
  AgentRunner,
  ToolRegistry,
  type AgentEvent,
  type ConversationMessage,
  type LanguageModel,
  type ToolCall,
} from "@agentic-runtime/core";
import { DEFAULT_OLLAMA_ENDPOINT, OllamaModel } from "@agentic-runtime/ollama";
import { DEFAULT_OPENAI_MODEL, OpenAIModel } from "@agentic-runtime/openai";
import {
  loadProjectInstructions,
  SessionStore,
  type SessionRecord,
} from "@agentic-runtime/session";
import { createIdeTools } from "@agentic-runtime/tools";

config({ path: process.env.ENV_FILE ?? ".env" });

const provider = (process.env.MODEL_PROVIDER ?? "openai").toLowerCase();
const modelName =
  provider === "ollama"
    ? (process.env.OLLAMA_MODEL ?? "")
    : (process.env.OPENAI_MODEL ?? DEFAULT_OPENAI_MODEL);

const useColor = Boolean(output.isTTY) && !process.env.NO_COLOR;
const ansi = {
  reset: "\x1b[0m",
  bold: "\x1b[1m",
  dim: "\x1b[2m",
  cyan: "\x1b[36m",
  blue: "\x1b[34m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  red: "\x1b[31m",
  magenta: "\x1b[35m",
  white: "\x1b[37m",
};

function paint(code: string, text: string): string {
  return useColor ? `${code}${text}${ansi.reset}` : text;
}

function createSystemMessage(rootPath: string): ConversationMessage {
  const instructions = loadProjectInstructions(rootPath);
  const instructionText = instructions.length
    ? `\n\nProject instructions:\n${instructions.join("\n\n")}`
    : "";
  return {
    role: "system",
    content:
      "You are an IDE assistant. Use the provided tools for workspace operations. For multi-step requests, continue calling tools until every requested step is complete. Use apply_patch for existing-file edits. The runtime handles approval; never ask the user to approve again after a tool has executed. Perform requested verification commands before answering. Do not fabricate tool results or output tool-call JSON as normal text." +
      instructionText,
  };
}

function line(char = "-", width = 72): string {
  return char.repeat(Math.max(20, Math.min(width, 100)));
}

function printBanner(): void {
  console.log();
  console.log(
    paint(
      ansi.cyan + ansi.bold,
      "+--------------------------------------------------------------+",
    ),
  );
  console.log(
    paint(
      ansi.cyan + ansi.bold,
      "|                    AGENTIC RUNTIME                           |",
    ),
  );
  console.log(
    paint(
      ansi.cyan + ansi.bold,
      "+--------------------------------------------------------------+",
    ),
  );
  console.log(
    `${paint(ansi.green, "READY")}  ${paint(ansi.bold, modelName || "model not configured")} ${paint(ansi.dim, `via ${provider}`)} ${paint(ansi.dim, "| SQLite session storage")}`,
  );
  console.log(
    `${paint(ansi.dim, "Workspace")} ${process.cwd()} ${paint(ansi.dim, "| type /help for commands")}`,
  );
  console.log();
}

function printHelp(): void {
  console.log(`\n${paint(ansi.cyan + ansi.bold, "COMMANDS")}`);
  console.log(
    `  ${paint(ansi.yellow, "/help")}                 Show this help`,
  );
  console.log(
    `  ${paint(ansi.yellow, "/clear")}                Clear current session messages`,
  );
  console.log(
    `  ${paint(ansi.yellow, "/new")}                  Start a new session`,
  );
  console.log(
    `  ${paint(ansi.yellow, "/sessions")}             List saved sessions`,
  );
  console.log(
    `  ${paint(ansi.yellow, "/resume <session-id>")}  Resume a saved session`,
  );
  console.log(
    `  ${paint(ansi.yellow, "/model")}                Show the active model`,
  );
  console.log(
    `  ${paint(ansi.yellow, "/exit")}                 Leave the TUI\n`,
  );
}

function formatArguments(call: ToolCall): string {
  const json = JSON.stringify(call.arguments, null, 2);
  return json.length > 2400 ? `${json.slice(0, 2397)}...` : json;
}

function printSessions(sessions: SessionRecord[], activeId: string): void {
  console.log(`\n${paint(ansi.cyan + ansi.bold, "SAVED SESSIONS")}`);
  if (sessions.length === 0) {
    console.log(`  ${paint(ansi.dim, "No saved sessions.")}\n`);
    return;
  }
  for (const session of sessions) {
    const active =
      session.id === activeId ? paint(ansi.green, "  < active") : "";
    console.log(`  ${paint(ansi.dim, session.id)}  ${session.title}${active}`);
  }
  console.log();
}

function startActivity(label: string): () => void {
  const frames = [".", "..", "..."];
  let index = 0;
  process.stdout.write(
    `\r${paint(ansi.magenta, ">>")} ${label}${frames[index]}`,
  );
  const timer = setInterval(() => {
    index = (index + 1) % frames.length;
    process.stdout.write(
      `\r${paint(ansi.magenta, ">>")} ${label}${frames[index]}   `,
    );
  }, 350);
  return () => {
    clearInterval(timer);
    process.stdout.write("\r\x1b[2K");
  };
}

function printToolCard(call: ToolCall, preview?: string): void {
  console.log(
    `\n${paint(ansi.yellow + ansi.bold, "+ ACTION ")} ${paint(ansi.white + ansi.bold, call.name)}`,
  );
  console.log(paint(ansi.dim, line()));
  console.log(paint(ansi.dim, formatArguments(call)));
  if (preview) {
    console.log(`\n${paint(ansi.blue + ansi.bold, "PREVIEW")}`);
    console.log(preview);
  }
}

function printEvent(event: AgentEvent): void {
  if (event.type === "tool_completed") {
    const status = event.result.isError
      ? paint(ansi.red, "ERROR")
      : paint(ansi.green, "DONE");
    console.log(
      `${status} ${paint(ansi.bold, event.call.name)} ${paint(ansi.dim, summarizeResult(event.result.output))}`,
    );
  } else if (event.type === "agent_completed") {
    console.log(
      `${paint(ansi.green + ansi.bold, "OK")} ${paint(ansi.dim, "agent completed")}`,
    );
  } else if (event.type === "agent_safety_limit") {
    console.log(`${paint(ansi.red + ansi.bold, "STOP")} ${event.text}`);
  }
}

function summarizeResult(value: string): string {
  const singleLine = value.replace(/\s+/g, " ").trim();
  return singleLine.length > 120
    ? `${singleLine.slice(0, 117)}...`
    : singleLine;
}

async function main(): Promise<void> {
  const sessionStore = new SessionStore({ projectRoot: process.cwd() });
  const systemMessage = createSystemMessage(sessionStore.project.rootPath);
  let activeSession =
    sessionStore.latestSession() ?? sessionStore.createSession();
  let messages: ConversationMessage[] = activeSession.messages.length
    ? activeSession.messages
    : [systemMessage];
  let activeTaskId: string | undefined;
  let stopActivity: (() => void) | undefined;
  const readline = createInterface({ input, output });
  const model = createModel();
  const registry = new ToolRegistry();
  for (const tool of createIdeTools()) {
    registry.register(tool);
  }
  const runner = new AgentRunner(model, registry, {
    cwd: sessionStore.project.rootPath,
    onEvent: async (event) => {
      sessionStore.appendEvent({
        sessionId: activeSession.id,
        taskId: activeTaskId,
        type: event.type,
        payload: event as unknown as Record<string, unknown>,
      });
      if (event.type === "model_request") {
        stopActivity?.();
        stopActivity = startActivity(
          `Model ${paint(ansi.white, modelName)} is thinking`,
        );
      } else if (event.type === "tool_requested") {
        stopActivity?.();
        stopActivity = undefined;
        console.log(
          `${paint(ansi.cyan, "PLAN")} model requested ${paint(ansi.bold, event.call.name)}`,
        );
      } else if (event.type === "tool_auto_approved") {
        console.log(
          `${paint(ansi.blue, "AUTO")} ${paint(ansi.bold, event.call.name)} ${paint(ansi.dim, "is safe to run without approval")}`,
        );
      } else if (
        event.type === "tool_completed" ||
        event.type === "agent_completed" ||
        event.type === "agent_safety_limit"
      ) {
        stopActivity?.();
        stopActivity = undefined;
        printEvent(event);
      }
    },
    requestApproval: async (call, preview) => {
      stopActivity?.();
      stopActivity = undefined;
      printToolCard(call, preview);
      console.log(
        `\n${paint(ansi.yellow + ansi.bold, "ALLOW THIS ACTION?")} ${paint(ansi.dim, "[y] yes  [n] no")}`,
      );
      let answer: string;
      try {
        answer = await readline.question(
          `${paint(ansi.green, "permission>")} `,
        );
      } catch (error) {
        if (isReadlineClosed(error)) return false;
        throw error;
      }
      const approved = answer.trim().toLowerCase() === "y";
      console.log(
        approved
          ? paint(ansi.green, "Approved. Continuing...\n")
          : paint(ansi.red, "Denied. The model will see the denial.\n"),
      );
      return approved;
    },
  });

  printBanner();
  console.log(`${paint(ansi.dim, "Session")} ${activeSession.id}\n`);

  try {
    while (true) {
      let inputMessage: string;
      try {
        inputMessage = (
          await readline.question(`${paint(ansi.cyan + ansi.bold, "you>")} `)
        ).trim();
      } catch (error) {
        if (isReadlineClosed(error)) break;
        throw error;
      }
      if (!inputMessage) continue;
      if (inputMessage === "/exit" || inputMessage === "/quit") break;
      if (inputMessage === "/help") {
        printHelp();
        continue;
      }
      if (inputMessage === "/model") {
        console.log(
          `\n${paint(ansi.green, "ACTIVE MODEL")} ${modelName} ${paint(ansi.dim, `via ${provider}`)}\n`,
        );
        continue;
      }
      if (inputMessage === "/sessions") {
        printSessions(sessionStore.listSessions(), activeSession.id);
        continue;
      }
      if (inputMessage === "/new") {
        activeSession = sessionStore.createSession();
        messages = [systemMessage];
        activeTaskId = undefined;
        console.log(
          `\n${paint(ansi.green, "Started session")} ${activeSession.id}.\n`,
        );
        continue;
      }
      if (inputMessage.startsWith("/resume ")) {
        const requestedId = inputMessage.slice("/resume ".length).trim();
        const match = sessionStore
          .listSessions()
          .find(
            (session) =>
              session.id === requestedId || session.id.startsWith(requestedId),
          );
        if (!match) {
          console.log(
            `${paint(ansi.red, "Session not found:")} ${requestedId}\n`,
          );
          continue;
        }
        activeSession = match;
        messages = match.messages.length ? match.messages : [systemMessage];
        activeTaskId = undefined;
        console.log(
          `\n${paint(ansi.green, "Resumed session")} ${activeSession.id}.\n`,
        );
        continue;
      }
      if (inputMessage === "/clear") {
        messages = [systemMessage];
        activeTaskId = undefined;
        sessionStore.saveMessages(activeSession.id, messages);
        console.log(`${paint(ansi.green, "Current session cleared.")}\n`);
        continue;
      }

      const task = sessionStore.createTask(activeSession.id, inputMessage);
      activeTaskId = task.id;
      sessionStore.updateTask(task.id, {
        status: "running",
        currentStage: "agent",
      });
      sessionStore.updateSession(activeSession.id, { status: "running" });
      sessionStore.appendEvent({
        sessionId: activeSession.id,
        taskId: task.id,
        type: "user_message",
        payload: { content: inputMessage },
      });
      messages.push({ role: "user", content: inputMessage });
      console.log(
        `\n${paint(ansi.blue, "TASK")} ${paint(ansi.dim, task.id)} ${paint(ansi.dim, "started")}`,
      );

      try {
        const result = await runner.run(messages);
        stopActivity?.();
        stopActivity = undefined;
        sessionStore.saveMessages(activeSession.id, messages);
        sessionStore.updateTask(task.id, {
          status: "completed",
          currentStage: "completed",
          state: { ...task.state, completedSteps: ["agent run"] },
        });
        sessionStore.updateSession(activeSession.id, { status: "idle" });
        console.log(
          `\n${paint(ansi.magenta + ansi.bold, "assistant>")}\n${result.text}\n`,
        );
      } catch (error) {
        stopActivity?.();
        stopActivity = undefined;
        sessionStore.saveMessages(activeSession.id, messages);
        sessionStore.updateTask(task.id, {
          status: "failed",
          currentStage: "failed",
          state: { ...task.state, errors: [String(error)] },
        });
        sessionStore.updateSession(activeSession.id, { status: "failed" });
        console.error(
          `${paint(ansi.red + ansi.bold, "REQUEST FAILED")} ${error instanceof Error ? error.message : String(error)}\n`,
        );
      } finally {
        activeTaskId = undefined;
      }
    }
  } finally {
    stopActivity?.();
    readline.close();
    sessionStore.close();
  }
}

function isReadlineClosed(error: unknown): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    error.code === "ERR_USE_AFTER_CLOSE"
  );
}

function createModel(): LanguageModel {
  if (provider === "ollama") {
    if (!modelName)
      throw new Error("Set OLLAMA_MODEL in .env before starting the TUI.");
    return new OllamaModel({
      model: modelName,
      endpoint: process.env.OLLAMA_ENDPOINT ?? DEFAULT_OLLAMA_ENDPOINT,
      apiKey: process.env.OLLAMA_API_KEY,
    });
  }
  if (provider === "openai") {
    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey)
      throw new Error("Set OPENAI_API_KEY in .env before starting the TUI.");
    return new OpenAIModel({ apiKey, model: modelName });
  }
  throw new Error(`Unsupported MODEL_PROVIDER: ${provider}`);
}

void main();
