import { realpathSync, statSync } from "node:fs";
import { resolve } from "node:path";

export function resolveWorkspaceRoot(
  arguments_: readonly string[],
  cwd = process.cwd(),
): string {
  const workspaceArguments =
    arguments_[0] === "--" ? arguments_.slice(1) : arguments_;
  if (workspaceArguments.length > 1) {
    throw new Error("Usage: agentic-tui [workspace-path]");
  }
  const path = resolve(cwd, workspaceArguments[0] ?? ".");
  let stats: ReturnType<typeof statSync>;
  try {
    stats = statSync(path);
  } catch {
    throw new Error(`Workspace does not exist: ${path}`);
  }
  if (!stats.isDirectory()) {
    throw new Error(`Workspace must be a directory: ${path}`);
  }
  return realpathSync(path);
}
