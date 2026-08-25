import { execa } from "execa";
import type {
  Tool,
  ToolExecutionContext,
  ToolResult,
} from "@agentic-runtime/core";

export interface PowerShellToolOptions {
  executable?: string;
  timeoutMs?: number;
  maxOutputBytes?: number;
}

interface PowerShellArguments {
  command: string;
}

const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_OUTPUT_BYTES = 100_000;

export function createPowerShellTool(
  options: PowerShellToolOptions = {},
): Tool {
  return {
    name: "powershell",
    description:
      "Execute a PowerShell command in the approved workspace directory.",
    parameters: {
      type: "object",
      properties: {
        command: {
          type: "string",
          description: "The PowerShell command to execute.",
        },
      },
      required: ["command"],
      additionalProperties: false,
    },
    execute: async (arguments_, context) =>
      executePowerShellCommand(
        parseArguments(arguments_).command,
        context,
        options,
      ),
  };
}

export async function executePowerShellCommand(
  command: string,
  context: ToolExecutionContext,
  options: PowerShellToolOptions = {},
): Promise<ToolResult> {
  if (!command.trim()) {
    throw new Error("A PowerShell command is required.");
  }

  const executable =
    options.executable ?? process.env.POWERSHELL_PATH ?? "pwsh";
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxOutputBytes = options.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES;
  const result = await execa(
    executable,
    ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", command],
    {
      cwd: context.cwd,
      env: sanitizedEnvironment(),
      extendEnv: false,
      windowsHide: true,
      timeout: timeoutMs,
      maxBuffer: maxOutputBytes,
      reject: false,
      cancelSignal: context.signal,
    },
  );
  const output = [result.stdout, result.stderr].filter(Boolean).join("\n");
  const outputBuffer = Buffer.from(output, "utf8");
  const truncated = outputBuffer.byteLength > maxOutputBytes;

  return {
    output: outputBuffer.subarray(0, maxOutputBytes).toString("utf8"),
    exitCode: result.exitCode ?? -1,
    isError: result.failed || result.exitCode !== 0,
    timedOut: result.timedOut,
    truncated,
  };
}

function parseArguments(
  arguments_: Record<string, unknown>,
): PowerShellArguments {
  const command = arguments_.command;
  if (typeof command !== "string" || !command.trim()) {
    throw new Error('The "command" argument must be a non-empty string.');
  }
  return { command };
}

function sanitizedEnvironment(): NodeJS.ProcessEnv {
  const environment = { ...process.env };
  delete environment.OPENAI_API_KEY;
  delete environment.ANTHROPIC_API_KEY;
  return environment;
}
