import type { ConversationMessage, ToolCall, ToolMessage } from "./messages.js";
import type { LanguageModel } from "./model.js";
import { ToolRegistry } from "./tool-registry.js";
import type {
  ToolExecutionContext,
  ToolPreviewContext,
  ToolResult,
} from "./tools.js";

export interface AgentRunnerOptions {
  cwd: string;
  maxSteps?: number;
  requestApproval: (call: ToolCall, preview?: string) => Promise<boolean>;
  signal?: AbortSignal;
}

export interface AgentRunResult {
  text: string;
  messages: ConversationMessage[];
}

export class AgentRunner {
  private readonly maxSteps: number;

  constructor(
    private readonly model: LanguageModel,
    private readonly tools: ToolRegistry,
    private readonly options: AgentRunnerOptions,
  ) {
    this.maxSteps = options.maxSteps ?? 12;
  }

  async run(messages: ConversationMessage[]): Promise<AgentRunResult> {
    let previousSignature: string | undefined;
    let previousResult: ToolResult | undefined;
    const executedToolNames: string[] = [];
    let hadNoOpMutation = false;
    let lastResponseText = "";
    const workflow = createWorkflowState(messages);

    for (let step = 0; step < this.maxSteps; step += 1) {
      const response = await this.model.respond({
        messages,
        tools: this.tools.list(),
      });
      messages.push(response.message);
      lastResponseText = response.text;

      if (response.toolCalls.length === 0) {
        const followUp = workflow.followUp(executedToolNames, hadNoOpMutation);
        if (followUp) {
          messages.push({ role: "user", content: followUp });
          continue;
        }
        return { text: response.text, messages };
      }

      for (const call of response.toolCalls) {
        executedToolNames.push(call.name);
        const signature = JSON.stringify([call.name, call.arguments]);
        if (signature === previousSignature && previousResult) {
          const text =
            "The model requested the same tool call again. The previous result was:\n" +
            previousResult.output;
          messages.push({ role: "assistant", content: text });
          return { text, messages };
        }

        const result = await this.executeTool(call);
        if (
          result.changed === false &&
          ["apply_patch", "write_file", "create_file", "delete_file"].includes(
            call.name,
          )
        ) {
          hadNoOpMutation = true;
        }
        previousSignature = signature;
        previousResult = result;
        messages.push(this.toToolMessage(call, result));
      }
    }

    const text = lastResponseText
      ? `${lastResponseText}\n\n[Agent stopped after reaching the ${this.maxSteps}-step safety limit.]`
      : `[Agent stopped after reaching the ${this.maxSteps}-step safety limit. Tools executed: ${executedToolNames.join(", ") || "none"}]`;
    return { text, messages };
  }

  private async executeTool(call: ToolCall): Promise<ToolResult> {
    const tool = this.tools.get(call.name);

    if (!tool) {
      return { output: `Unknown tool: ${call.name}`, isError: true };
    }

    const validationErrors = this.tools.validateArguments(
      call.name,
      call.arguments,
    );
    if (validationErrors.length > 0) {
      return {
        output: `Invalid tool arguments: ${validationErrors.join("; ")}`,
        isError: true,
      };
    }

    const previewContext: ToolPreviewContext = { cwd: this.options.cwd };
    let preview: string | undefined;
    try {
      preview = tool.preview
        ? await tool.preview(call.arguments, previewContext)
        : undefined;
    } catch (error) {
      return {
        output: `Unable to prepare tool preview: ${error instanceof Error ? error.message : String(error)}`,
        isError: true,
      };
    }

    const approved = await this.options.requestApproval(call, preview);
    if (!approved) {
      return { output: "Tool execution denied by the user.", isError: true };
    }

    const context: ToolExecutionContext = {
      cwd: this.options.cwd,
      signal: this.options.signal ?? new AbortController().signal,
      requestApproval: async () => true,
    };

    try {
      return await tool.execute(call.arguments, context);
    } catch (error) {
      return {
        output: error instanceof Error ? error.message : String(error),
        isError: true,
      };
    }
  }

  private toToolMessage(call: ToolCall, result: ToolResult): ToolMessage {
    const metadata = [
      result.isError ? "error" : undefined,
      result.exitCode === undefined
        ? undefined
        : `exit code: ${result.exitCode}`,
      result.timedOut ? "timed out" : undefined,
      result.truncated ? "output truncated" : undefined,
    ].filter(Boolean);
    const suffix = metadata.length > 0 ? `\n[${metadata.join(", ")}]` : "";

    return {
      role: "tool",
      toolCallId: call.id,
      toolName: call.name,
      content: `${result.output}${suffix}`,
    };
  }
}

interface WorkflowState {
  followUp: (
    executedTools: readonly string[],
    hadNoOpMutation: boolean,
  ) => string | undefined;
}

function createWorkflowState(
  messages: readonly ConversationMessage[],
): WorkflowState {
  const request = [...messages]
    .reverse()
    .find((message) => message.role === "user")?.content;
  if (
    !request ||
    /\b(do not|don't|dont)\s+(modify|change|write|edit)/i.test(request)
  ) {
    return { followUp: () => undefined };
  }

  const requestsPatch = /apply_patch|patch/i.test(request);
  const requestsMutation =
    requestsPatch ||
    /\b(add|create|delete|remove|modify|change|edit|write|overwrite)\b/i.test(
      request,
    );
  const requestsReadAfterMutation =
    /read (the )?file again|verify (the )?(file|change)|re-?read/i.test(
      request,
    );
  const requestsVerification =
    /\b(build|compile|format|syntax|typecheck|test|verify)\b/i.test(request);

  if (!requestsMutation && !requestsVerification) {
    return { followUp: () => undefined };
  }

  return {
    followUp: (executedTools, hadNoOpMutation) => {
      const mutationIndex = executedTools.findIndex((tool) =>
        ["apply_patch", "write_file", "create_file", "delete_file"].includes(
          tool,
        ),
      );
      const hasPatch = executedTools.includes("apply_patch");
      const hasReadAfterMutation =
        mutationIndex >= 0 &&
        executedTools.slice(mutationIndex + 1).includes("read_file");
      const hasVerification = executedTools.some((tool) =>
        ["compile_code", "syntax_check", "format_code", "run_code"].includes(
          tool,
        ),
      );

      if (requestsPatch && !hasPatch) {
        return `The original user request is: ${request}\n\nYou have only read the file. The required next action is to call apply_patch, not to describe a command and not to ask for details. Respond with exactly one apply_patch tool call using the previous file content and the requested change. Do not call compile_code until apply_patch has been approved and executed.`;
      }
      if (requestsMutation && mutationIndex < 0) {
        return `The original user request is: ${request}\n\nThe requested file mutation has not happened. Do not answer with prose or ask for details. Call the appropriate file mutation tool now, then continue with the remaining requested steps.`;
      }
      if (
        requestsReadAfterMutation &&
        !hasReadAfterMutation &&
        !hadNoOpMutation
      ) {
        return `The patch has already been approved and applied. Do not ask for approval again and do not answer with a diff. Call read_file now for the changed file to verify the edit, then continue with the remaining requested steps from the original request: ${request}`;
      }
      if (requestsVerification && !hasVerification) {
        return `The requested edit and verification are not complete. Do not answer with prose or ask the user to run a command. Call the appropriate verification tool now, then report its actual result: ${request}`;
      }
      return undefined;
    },
  };
}
