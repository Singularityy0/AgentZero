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

/**
 * Directories that are never worth walking. These are passed as ripgrep
 * exclusions rather than filtered afterwards, so the cost of enumerating them
 * is never paid at all — and so a positive `--glob` cannot drag them back in.
 */
const ALWAYS_EXCLUDED_GLOBS: readonly string[] = [
  "!**/node_modules/**",
  "!**/.git/**",
  "!**/target/**",
  "!**/dist/**",
  "!**/build/**",
  "!**/.next/**",
  "!**/coverage/**",
  "!**/.venv/**",
  "!**/__pycache__/**",
];

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
  const args = [
    "--json",
    "--color",
    "never",
    ...(options.glob ? ["--glob", options.glob] : []),
    // Same override rule as findFiles: these also guard a workspace that has
    // no .gitignore at all, where dependency sources would otherwise be
    // searched and ranked as if they were project code.
    ...ALWAYS_EXCLUDED_GLOBS.flatMap((glob) => ["--glob", glob]),
    "--",
    options.pattern,
    ".",
  ];
  const result = await execa(resolveRipgrepPath(), args, {
    cwd: options.root,
    reject: false,
    maxBuffer: 64_000_000,
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

/**
 * A positive `--glob` in ripgrep is an *override*, and overrides take
 * precedence over `.gitignore`. Passing the default `--glob "*"` therefore
 * silently disabled every ignore file: on this repository it turned a 116-file
 * listing into a 40,000-file one, mostly `node_modules`. That inflated every
 * retrieval pass, leaked dependency paths into agent context, and could trip
 * the index's own file ceiling on a normal project.
 *
 * So the wildcard case passes no positive glob at all, which keeps ignore
 * handling intact, and a real caller-supplied pattern is always paired with
 * explicit exclusions to cancel the override it introduces.
 */
export async function findFiles(
  root: string,
  pattern = "*",
  maxResults = 500,
): Promise<string[]> {
  const wildcard = pattern.trim() === "" || pattern.trim() === "*";
  const args = [
    "--files",
    ...(wildcard ? [] : ["--glob", pattern]),
    ...ALWAYS_EXCLUDED_GLOBS.flatMap((glob) => ["--glob", glob]),
  ];
  const result = await execa(resolveRipgrepPath(), args, {
    cwd: root,
    reject: false,
    // Path listings are cheap per entry but numerous; a truncated listing would
    // silently hide files from the index rather than fail loudly.
    maxBuffer: 64_000_000,
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
