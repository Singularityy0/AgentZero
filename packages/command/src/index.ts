import { execa } from "execa";
import type {
  Tool,
  ToolExecutionContext,
  ToolResult,
} from "@agentic-runtime/core";

export type CommandShell = "auto" | "cmd" | "posix";

export interface CommandToolOptions {
  shell?: CommandShell;
  executable?: string;
  timeoutMs?: number;
  maxOutputBytes?: number;
}

interface CommandArguments {
  command: string;
}

const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_OUTPUT_BYTES = 100_000;

export function createCommandTool(options: CommandToolOptions = {}): Tool {
  return {
    name: "command",
    description:
      "Execute a command in the workspace using the host operating system's native shell.",
    parameters: {
      type: "object",
      properties: {
        command: {
          type: "string",
          description:
            "A command supported by the current operating system shell.",
        },
      },
      required: ["command"],
      additionalProperties: false,
    },
    execute: async (arguments_, context) =>
      executeCommand(parseArguments(arguments_).command, context, options),
  };
}

export async function executeCommand(
  command: string,
  context: ToolExecutionContext,
  options: CommandToolOptions = {},
): Promise<ToolResult> {
  if (!command.trim()) {
    throw new Error("A command is required.");
  }

  const shell = resolveShell(options);
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxOutputBytes = options.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES;
  const result = await execa(shell.executable, shell.args(command), {
    cwd: context.cwd,
    env: sanitizedEnvironment(),
    extendEnv: false,
    windowsHide: process.platform === "win32",
    timeout: timeoutMs,
    maxBuffer: maxOutputBytes,
    reject: false,
    cancelSignal: context.signal,
  });
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

interface ResolvedShell {
  executable: string;
  args: (command: string) => string[];
}

function resolveShell(options: CommandToolOptions): ResolvedShell {
  const shell = options.shell ?? "auto";
  const resolvedShell =
    shell === "auto" ? (process.platform === "win32" ? "cmd" : "posix") : shell;

  if (resolvedShell === "cmd") {
    return {
      executable: options.executable ?? process.env.COMSPEC ?? "cmd.exe",
      args: (command) => ["/d", "/s", "/c", command],
    };
  }

  return {
    executable: options.executable ?? process.env.SHELL ?? "/bin/sh",
    args: (command) => ["-c", command],
  };
}

function parseArguments(arguments_: Record<string, unknown>): CommandArguments {
  const command = arguments_.command;
  if (typeof command !== "string" || !command.trim()) {
    throw new Error('The "command" argument must be a non-empty string.');
  }
  return { command };
}

function sanitizedEnvironment(): NodeJS.ProcessEnv {
  const allowed = new Set(
    process.platform === "win32"
      ? [
          "APPDATA",
          "COMSPEC",
          "HOMEDRIVE",
          "HOMEPATH",
          "LOCALAPPDATA",
          "PATH",
          "PATHEXT",
          "SYSTEMROOT",
          "TEMP",
          "TMP",
          "USERPROFILE",
          "WINDIR",
        ]
      : ["HOME", "LANG", "LC_ALL", "LC_CTYPE", "PATH", "TEMP", "TMP", "TMPDIR"],
  );
  return Object.fromEntries(
    Object.entries(process.env).filter(([name]) =>
      allowed.has(name.toUpperCase()),
    ),
  );
}
