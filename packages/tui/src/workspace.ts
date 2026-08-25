import { realpathSync, statSync } from "node:fs";
import { resolve } from "node:path";

export function resolveWorkspaceRoot(
  arguments_: readonly string[],
  cwd = process.cwd(),
): string {
  if (arguments_.length > 1) {
    throw new Error("Usage: agentic-tui [workspace-path]");
  }
  const path = resolve(cwd, arguments_[0] ?? ".");
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
