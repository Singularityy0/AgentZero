import { execa } from "execa";
import { rgPath } from "@vscode/ripgrep";

export interface SearchOptions {
  root: string;
  pattern: string;
  glob?: string;
  maxResults?: number;
}

export interface SearchMatch {
  path: string;
  line: number;
  column: number;
  text: string;
}

export async function searchText(
  options: SearchOptions,
): Promise<SearchMatch[]> {
  const args = ["--json", "--color", "never", "--", options.pattern, "."];
  if (options.glob) {
    args.splice(1, 0, "--glob", options.glob);
  }
  const result = await execa(rgPath, args, {
    cwd: options.root,
    reject: false,
    maxBuffer: 2_000_000,
  });
  if (result.exitCode === 2) {
    throw new Error(result.stderr || "ripgrep failed.");
  }

  const matches: SearchMatch[] = [];
  for (const line of result.stdout.split(/\r?\n/)) {
    if (matches.length >= (options.maxResults ?? 100)) {
      break;
    }
    try {
      const event = JSON.parse(line) as RipgrepEvent;
      if (event.type !== "match" || !event.data?.path?.text) {
        continue;
      }
      matches.push({
        path: normalizePath(event.data.path.text),
        line: event.data.line_number ?? 0,
        column: (event.data.submatches?.[0]?.start ?? 0) + 1,
        text: event.data.lines?.text?.replace(/\r?\n$/, "") ?? "",
      });
    } catch {
      // Ignore non-JSON diagnostic lines from ripgrep.
    }
  }
  return matches;
}

export async function findFiles(
  root: string,
  pattern = "*",
  maxResults = 500,
): Promise<string[]> {
  const result = await execa(rgPath, ["--files", "--glob", pattern], {
    cwd: root,
    reject: false,
    maxBuffer: 2_000_000,
  });
  if (result.exitCode !== 0 && result.exitCode !== 1) {
    throw new Error(result.stderr || "ripgrep failed.");
  }
  return result.stdout
    .split(/\r?\n/)
    .filter(Boolean)
    .map(normalizePath)
    .slice(0, maxResults);
}

interface RipgrepEvent {
  type?: string;
  data?: {
    path?: { text?: string };
    line_number?: number;
    lines?: { text?: string };
    submatches?: Array<{ start?: number }>;
  };
}

function normalizePath(path: string): string {
  return path.replaceAll("\\", "/").replace(/^\.\//, "");
}
