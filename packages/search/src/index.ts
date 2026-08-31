import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { execa } from "execa";

const require = createRequire(import.meta.url);

function resolveRipgrepPath(): string {
  const configuredPath = process.env.AGENTIC_RIPGREP_PATH?.trim();
  if (configuredPath) {
    if (existsSync(configuredPath)) return configuredPath;
    throw new Error(
      `Configured ripgrep binary was not found: ${configuredPath}`,
    );
  }

  const arch = process.env.npm_config_arch || process.arch;
  const binaryName = process.platform === "win32" ? "rg.exe" : "rg";
  const platformPackage = `@vscode/ripgrep-${process.platform}-${arch}`;
  try {
    const wrapperEntry = require.resolve("@vscode/ripgrep");
    const packageRequire = createRequire(wrapperEntry);
    return packageRequire.resolve(`${platformPackage}/bin/${binaryName}`);
  } catch {
    throw new Error(
      `Could not find ${platformPackage}. Ensure optional dependencies are installed for this platform (${process.platform}-${arch}).`,
    );
  }
}

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
  const result = await execa(resolveRipgrepPath(), args, {
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
  const result = await execa(
    resolveRipgrepPath(),
    ["--files", "--glob", pattern],
    {
      cwd: root,
      reject: false,
      maxBuffer: 2_000_000,
    },
  );
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
