export interface ContextReference {
  path: string;
  startLine?: number;
  endLine?: number;
}

export type ContextCommand =
  | {
      type: "context";
      action: "list";
    }
  | ({
      type: "context";
      action: "add" | "remove";
    } & ContextReference);

export interface ByTheWayCommand {
  type: "bytheway";
  prompt: string;
}

export type ParsedCommand = ContextCommand | ByTheWayCommand;

export interface InvalidCommand {
  type: "invalid";
  command: "context" | "bytheway";
  message: string;
}

export type CommandParseResult = ParsedCommand | InvalidCommand | undefined;

export type FileContextLike =
  | {
      filePath: string;
      startLine?: number | null;
      endLine?: number | null;
    }
  | {
      path: string;
      startLine?: number | null;
      endLine?: number | null;
    };

const CONTEXT_USAGE =
  "Usage: /context [list|add <path>[:line|start-end]|remove <path>[:line|start-end]]";

export function parseCommand(input: string): CommandParseResult {
  return parseContextCommand(input) ?? parseByTheWayCommand(input);
}

export function parseContextCommand(input: string): CommandParseResult {
  const value = input.trim();
  if (!/^\/context(?:\s|$)/u.test(value)) return undefined;

  const argumentsText = value.slice("/context".length).trim();
  if (!argumentsText || argumentsText === "list") {
    return { type: "context", action: "list" };
  }

  const mutation = /^(add|remove)(?:\s+([\s\S]*))?$/u.exec(argumentsText);
  if (!mutation) return invalid("context", CONTEXT_USAGE);

  const action = mutation[1] as "add" | "remove";
  const reference = parseContextReference(mutation[2] ?? "");
  if ("message" in reference) return reference;

  return { type: "context", action, ...reference };
}

export function parseByTheWayCommand(input: string): CommandParseResult {
  const value = input.trim();
  if (!/^\/bytheway(?:\s|$)/u.test(value)) return undefined;

  const prompt = value.slice("/bytheway".length).trim();
  if (!prompt) {
    return invalid("bytheway", "Usage: /bytheway <message>");
  }

  return { type: "bytheway", prompt };
}

export function parseContextReference(
  input: string,
): ContextReference | InvalidCommand {
  let value = input.trim();
  if (!value) return invalid("context", CONTEXT_USAGE);

  const outerQuote = quoteAtStart(value);
  if (outerQuote && value.endsWith(outerQuote)) {
    value = value.slice(1, -1);
  }

  const range = /:(\d+)(?:-(\d+))?$/u.exec(value);
  let path = range ? value.slice(0, range.index).trim() : value.trim();

  const pathQuote = quoteAtStart(path);
  if (pathQuote) {
    if (!path.endsWith(pathQuote)) {
      return invalid("context", "Path has an unmatched quote.");
    }
    path = path.slice(1, -1);
  }

  if (!path) return invalid("context", "A context path is required.");

  if (!range) {
    if (hasMalformedNumericRange(value)) {
      return invalid(
        "context",
        "Invalid line range. Expected :line or :start-end.",
      );
    }
    return { path };
  }

  const startLine = Number(range[1]);
  const endLine = range[2] === undefined ? startLine : Number(range[2]);
  if (
    !Number.isSafeInteger(startLine) ||
    !Number.isSafeInteger(endLine) ||
    startLine < 1 ||
    endLine < 1
  ) {
    return invalid("context", "Line numbers must be positive integers.");
  }
  if (startLine > endLine) {
    return invalid("context", "Line range start must not exceed its end.");
  }

  return { path, startLine, endLine };
}

export function formatFileContext(context: FileContextLike): string {
  const path = "filePath" in context ? context.filePath : context.path;
  const startLine = context.startLine;
  const endLine = context.endLine;
  if (startLine == null) return path;
  if (endLine == null || endLine === startLine) return `${path}:${startLine}`;
  return `${path}:${startLine}-${endLine}`;
}

export function formatFileContexts(
  contexts: readonly FileContextLike[],
): string {
  return contexts.map(formatFileContext).join("\n");
}

function quoteAtStart(value: string): '"' | "'" | undefined {
  const first = value[0];
  return first === '"' || first === "'" ? first : undefined;
}

function hasMalformedNumericRange(value: string): boolean {
  const suffix = value.slice(value.lastIndexOf(":") + 1);
  return /^(?:\d[\d-]*|-\d[\d-]*)$/u.test(suffix) || /^\d+\s*-/u.test(suffix);
}

function invalid(
  command: InvalidCommand["command"],
  message: string,
): InvalidCommand {
  return { type: "invalid", command, message };
}
