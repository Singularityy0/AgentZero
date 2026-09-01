import { watch, type FSWatcher } from "node:fs";

/** Directories that churn constantly and are never worth reporting to the IDE. */
const IGNORED_SEGMENTS: ReadonlySet<string> = new Set([
  ".git",
  ".runtime-data",
  ".pnpm-store",
  "node_modules",
  "dist",
  "dist-tests",
  "build",
  "out",
  "target",
  ".next",
  ".turbo",
  ".cache",
  "coverage",
]);

/** Atomic writes land as a temporary file first; only the final name matters. */
const IGNORED_FILE_PATTERN = /(?:^~|\.tmp$|\.swp$|~$|^\.DS_Store$|\.crswap$)/u;

export interface WorkspaceChange {
  type: "workspace_changed";
  /** Workspace-relative paths, POSIX separators, that changed in this batch. */
  paths: string[];
  occurredAt: number;
}

export interface WorkspaceWatcher {
  subscribe(listener: (change: WorkspaceChange) => void): () => void;
  close(): void;
}

export function isIgnoredWorkspacePath(relativePath: string): boolean {
  const segments = relativePath.split("/").filter(Boolean);
  if (segments.length === 0) return true;
  if (segments.some((segment) => IGNORED_SEGMENTS.has(segment))) return true;
  return IGNORED_FILE_PATTERN.test(segments.at(-1)!);
}

/**
 * Watches the workspace root and reports batches of changed paths.
 *
 * Recursive watching is not available on every platform and filesystem (network
 * shares and some Linux setups refuse it), so a failure to start degrades to a
 * silent no-op watcher rather than taking the server down with it. Events are
 * coalesced over a short window because a single save commonly produces several
 * raw notifications, and one editor action should be one refresh.
 */
export function createWorkspaceWatcher(
  root: string,
  { debounceMs = 120 }: { debounceMs?: number } = {},
): WorkspaceWatcher {
  const listeners = new Set<(change: WorkspaceChange) => void>();
  const pending = new Set<string>();
  let timer: NodeJS.Timeout | undefined;
  let watcher: FSWatcher | undefined;

  const flush = (): void => {
    timer = undefined;
    if (pending.size === 0) return;
    const change: WorkspaceChange = {
      type: "workspace_changed",
      paths: [...pending],
      occurredAt: Date.now(),
    };
    pending.clear();
    for (const listener of listeners) listener(change);
  };

  try {
    watcher = watch(root, { recursive: true, persistent: false });
    watcher.on("change", (_event, filename) => {
      if (!filename) return;
      const relativePath = filename.toString().replaceAll("\\", "/");
      if (isIgnoredWorkspacePath(relativePath)) return;
      pending.add(relativePath);
      if (timer) return;
      timer = setTimeout(flush, debounceMs);
      timer.unref?.();
    });
    // A watch that dies (the folder was renamed or unmounted) must not crash the
    // server; the IDE simply stops receiving live updates until it reopens.
    watcher.on("error", () => undefined);
  } catch {
    watcher = undefined;
  }

  return {
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    close() {
      if (timer) clearTimeout(timer);
      timer = undefined;
      listeners.clear();
      pending.clear();
      watcher?.close();
      watcher = undefined;
    },
  };
}
