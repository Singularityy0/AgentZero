#!/usr/bin/env node

import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { config } from "dotenv";
import {
  AgentRunner,
  ToolRegistry,
  type LanguageModel,
  type ConversationMessage,
  type ToolCall,
} from "@agentic-runtime/core";
import { OpenAIModel, DEFAULT_OPENAI_MODEL } from "@agentic-runtime/openai";
import { DEFAULT_OLLAMA_ENDPOINT, OllamaModel } from "@agentic-runtime/ollama";
import { createIdeTools } from "@agentic-runtime/tools";

config({ path: process.env.ENV_FILE ?? ".env" });

const provider = (process.env.MODEL_PROVIDER ?? "openai").toLowerCase();
const modelName =
  provider === "ollama"
    ? (process.env.OLLAMA_MODEL ?? "")
    : (process.env.OPENAI_MODEL ?? DEFAULT_OPENAI_MODEL);
const systemMessage: ConversationMessage = {
  role: "system",
  content:
    "You are an IDE assistant. Use the provided tools for workspace operations. For multi-step requests, continue calling tools until every requested step is complete; reading a file is not completion when the user also requested an edit, approval, verification, or build. Use apply_patch for existing-file edits. The runtime, not you, handles approval; never ask the user to review or approve again after a tool has executed. Perform the requested verification commands before answering. Do not fabricate tool results or output tool-call JSON as normal text.",
};

function printBanner(): void {
  console.log("\nAgentic Runtime TUI");
  console.log(`Provider: ${provider}`);
  console.log(`Model: ${modelName}`);
  console.log("PowerShell tool: approval required");
  console.log("Type a message, or /help for commands.\n");
}

function printHelp(): void {
  console.log("\nCommands:");
  console.log("  /help     Show this help");
  console.log("  /clear    Clear conversation history");
  console.log("  /model    Show the active model");
  console.log("  /exit     Leave the TUI\n");
}

function formatToolCall(call: ToolCall): string {
  return `${call.name} ${JSON.stringify(call.arguments, null, 2)}`;
}

async function main(): Promise<void> {
  const readline = createInterface({ input, output });
  const messages: ConversationMessage[] = [systemMessage];
  const model = createModel();
  const registry = new ToolRegistry();
  for (const tool of createIdeTools()) {
    registry.register(tool);
  }
  const runner = new AgentRunner(model, registry, {
    cwd: process.cwd(),
    requestApproval: async (call, preview) => {
      console.log(`\nTool requested:\n${formatToolCall(call)}`);
      if (preview) {
        console.log(`\n${preview}`);
      }
      let answer: string;
      try {
        answer = await readline.question("Execute? [y/N] ");
      } catch (error) {
        if (isReadlineClosed(error)) {
          return false;
        }
        throw error;
      }
      return answer.trim().toLowerCase() === "y";
    },
  });

  printBanner();

  try {
    while (true) {
      let message: string;
      try {
        message = (await readline.question("you> ")).trim();
      } catch (error) {
        if (isReadlineClosed(error)) {
          break;
        }
        throw error;
      }
      if (!message) {
        continue;
      }
      if (message === "/exit" || message === "/quit") {
        break;
      }
      if (message === "/help") {
        printHelp();
        continue;
      }
      if (message === "/clear") {
        messages.splice(0, messages.length, systemMessage);
        console.log("Conversation cleared.\n");
        continue;
      }
      if (message === "/model") {
        console.log(`Active model: ${modelName}\n`);
        continue;
      }

      messages.push({ role: "user", content: message });
      try {
        const result = await runner.run(messages);
        console.log(`ai> ${result.text}\n`);
      } catch (error) {
        console.error(
          `Request failed: ${error instanceof Error ? error.message : String(error)}\n`,
        );
      }
    }
  } finally {
    readline.close();
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
    if (!modelName) {
      throw new Error("Set OLLAMA_MODEL in .env before starting the TUI.");
    }
    return new OllamaModel({
      model: modelName,
      endpoint: process.env.OLLAMA_ENDPOINT ?? DEFAULT_OLLAMA_ENDPOINT,
      apiKey: process.env.OLLAMA_API_KEY,
    });
  }

  if (provider === "openai") {
    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) {
      throw new Error("Set OPENAI_API_KEY in .env before starting the TUI.");
    }
    return new OpenAIModel({ apiKey, model: modelName });
  }

  throw new Error(`Unsupported MODEL_PROVIDER: ${provider}`);
}

void main();
