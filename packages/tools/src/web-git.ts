import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { Readability } from "@mozilla/readability";
import type { Tool } from "@agentic-runtime/core";
import { CheerioCrawler } from "crawlee";
import { JSDOM } from "jsdom";
import { simpleGit, type SimpleGit } from "simple-git";

const MAX_WEB_RESPONSE_BYTES = 2_000_000;

export function createWebTools(): Tool[] {
  return [createWebSearchTool(), createBrowseUrlTool(), createCrawlSiteTool()];
}

export function createGitTools(): Tool[] {
  return [
    createGitReadTool(
      "git_status",
      "Show the working tree and branch status.",
      (git) => git.status(),
    ),
    createGitReadTool("git_diff", "Show unstaged changes.", (git) =>
      git.diff(),
    ),
    createGitReadTool("git_log", "Show recent commits.", (git) =>
      git.log({ maxCount: 20 }),
    ),
    createGitReadTool(
      "git_branches",
      "List local and remote branches.",
      (git) => git.branch(["--all"]),
    ),
    createGitMutationTool(
      "git_add",
      "Stage specified files for commit.",
      objectSchema({
        paths: {
          type: "array",
          items: { type: "string", minLength: 1 },
          minItems: 1,
        },
      }),
      async (git, arguments_) => {
        const paths = requireStringArray(arguments_, "paths");
        assertSafeGitPaths(paths);
        await git.add(paths);
        return git.status();
      },
    ),
    createGitMutationTool(
      "git_commit",
      "Create a commit from staged changes.",
      objectSchema({ message: { type: "string", minLength: 1 } }),
      async (git, arguments_) => {
        const staged = await git.diff(["--cached", "--name-only"]);
        assertSafeGitPaths(staged.split(/\r?\n/).filter(Boolean));
        return git.commit(requireString(arguments_, "message"));
      },
    ),
    createGitMutationTool(
      "git_checkout",
      "Switch to an existing branch or create a new branch.",
      objectSchema(
        {
          branch: { type: "string", minLength: 1 },
          create: { type: "boolean" },
        },
        ["branch"],
      ),
      async (git, arguments_) => {
        const branch = requireString(arguments_, "branch");
        if (arguments_.create === true) await git.checkoutLocalBranch(branch);
        else await git.checkout(branch);
        return git.status();
      },
    ),
    createGitMutationTool(
      "git_merge",
      "Merge a branch into the current branch.",
      objectSchema(
        {
          branch: { type: "string", minLength: 1 },
          noFastForward: { type: "boolean" },
          message: { type: "string", minLength: 1 },
        },
        ["branch"],
      ),
      async (git, arguments_) => {
        const branch = requireString(arguments_, "branch");
        const options = [
          branch,
          ...(arguments_.noFastForward === true ? ["--no-ff"] : []),
          ...(typeof arguments_.message === "string" && arguments_.message
            ? ["-m", arguments_.message]
            : []),
        ];
        try {
          const result = await git.merge(options);
          return { merge: result, status: await git.status() };
        } catch (error) {
          // A conflicted merge is a real outcome the agent must be able to act
          // on, not a crash: report the conflicted paths so it can resolve them.
          const status = await git.status();
          return {
            merged: false,
            conflicted: status.conflicted,
            status,
            error: error instanceof Error ? error.message : String(error),
          };
        }
      },
    ),
    createGitMutationTool(
      "git_push",
      "Push a branch to a remote.",
      objectSchema({
        remote: { type: "string", minLength: 1 },
        branch: { type: "string", minLength: 1 },
      }),
      (git, arguments_) =>
        git.push(
          requireString(arguments_, "remote"),
          requireString(arguments_, "branch"),
        ),
    ),
  ];
}

/**
 * Keyless web search over DuckDuckGo's HTML endpoint.
 *
 * Every general search API (Brave, Serper, Google CSE) needs its own key and
 * account, which would add a provider the evaluator has to configure before the
 * agent can search at all. The HTML endpoint needs none, returns ranked organic
 * results, and its markup is stable enough to parse. Results are titles, URLs,
 * and snippets only: the agent follows up with browse_url when it wants the
 * page, which keeps a search cheap in tokens.
 */
function createWebSearchTool(): Tool {
  return {
    name: "web_search",
    description:
      "Search the web and return ranked result titles, URLs, and snippets.",
    approval: "ask",
    parameters: objectSchema(
      {
        query: { type: "string", minLength: 1 },
        maxResults: { type: "integer", minimum: 1, maximum: 20 },
      },
      ["query"],
    ),
    execute: async (arguments_, context) => {
      const query = requireString(arguments_, "query");
      const maxResults = optionalInteger(arguments_, "maxResults", 8, 20);
      const endpoint = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`;
      await assertPublicUrl(endpoint);
      const response = await fetchWebPage(endpoint, context.signal);
      const dom = new JSDOM(response.body);
      const results: Array<{
        title: string;
        url: string;
        snippet: string;
      }> = [];
      for (const node of dom.window.document.querySelectorAll(".result")) {
        const anchor = node.querySelector("a.result__a");
        const href = anchor?.getAttribute("href");
        if (!anchor || !href) continue;
        const url = unwrapRedirect(href);
        if (!url) continue;
        results.push({
          title: collapse(anchor.textContent ?? ""),
          url,
          snippet: collapse(
            node.querySelector(".result__snippet")?.textContent ?? "",
          ).slice(0, 400),
        });
        if (results.length >= maxResults) break;
      }
      return {
        output: JSON.stringify({ query, results }),
      };
    },
  };
}

function collapse(value: string): string {
  return value.replace(/\s+/gu, " ").trim();
}

/** DuckDuckGo wraps outbound links in `/l/?uddg=<encoded>`. */
function unwrapRedirect(href: string): string | undefined {
  try {
    const url = new URL(href, "https://duckduckgo.com");
    const target = url.searchParams.get("uddg");
    const resolved = target ? new URL(target) : url;
    return resolved.protocol === "http:" || resolved.protocol === "https:"
      ? resolved.toString()
      : undefined;
  } catch {
    return undefined;
  }
}

function createBrowseUrlTool(): Tool {
  return {
    name: "browse_url",
    description:
      "Fetch an HTTP(S) URL and extract readable article text without executing page scripts.",
    approval: "ask",
    parameters: objectSchema(
      {
        url: { type: "string", minLength: 1 },
        maxCharacters: { type: "integer", minimum: 500, maximum: 50_000 },
      },
      ["url"],
    ),
    execute: async (arguments_, context) => {
      const url = requireUrl(arguments_, "url");
      const maxCharacters = optionalInteger(
        arguments_,
        "maxCharacters",
        12_000,
        50_000,
      );
      await assertPublicUrl(url);
      const response = await fetchWebPage(url, context.signal);
      const dom = new JSDOM(response.body, { url });
      const article = new Readability(dom.window.document).parse();
      const text = (
        article?.textContent ??
        dom.window.document.body.textContent ??
        ""
      )
        .replace(/\s+/g, " ")
        .trim();
      return {
        output: JSON.stringify({
          url: response.url,
          title: article?.title ?? dom.window.document.title,
          excerpt: text.slice(0, maxCharacters),
          truncated: text.length > maxCharacters,
        }),
      };
    },
  };
}

function createCrawlSiteTool(): Tool {
  return {
    name: "crawl_site",
    description:
      "Crawl a bounded set of same-domain pages and return titles and text excerpts.",
    approval: "ask",
    parameters: objectSchema(
      {
        url: { type: "string", minLength: 1 },
        maxPages: { type: "integer", minimum: 1, maximum: 25 },
        maxCharactersPerPage: {
          type: "integer",
          minimum: 500,
          maximum: 10_000,
        },
      },
      ["url"],
    ),
    execute: async (arguments_, context) => {
      const startUrl = requireUrl(arguments_, "url");
      const maxPages = optionalInteger(arguments_, "maxPages", 10, 25);
      const maxCharacters = optionalInteger(
        arguments_,
        "maxCharactersPerPage",
        4_000,
        10_000,
      );
      await assertPublicUrl(startUrl);
      const pages: Array<{ url: string; title: string; excerpt: string }> = [];
      const crawler = new CheerioCrawler({
        maxRequestsPerCrawl: maxPages,
        maxConcurrency: 2,
        requestHandlerTimeoutSecs: 20,
        preNavigationHooks: [
          async ({ request }) => assertPublicUrl(request.url),
        ],
        requestHandler: async ({ request, $, enqueueLinks }) => {
          if (context.signal.aborted) return;
          await assertPublicUrl(request.loadedUrl ?? request.url);
          $("script, style, noscript").remove();
          const text = $.root().text().replace(/\s+/g, " ").trim();
          pages.push({
            url: request.loadedUrl ?? request.url,
            title: $("title").first().text().trim(),
            excerpt: text.slice(0, maxCharacters),
          });
          await enqueueLinks({ strategy: "same-domain" });
        },
      });
      await crawler.run([startUrl]);
      return { output: JSON.stringify({ startUrl, pages }) };
    },
  };
}

function createGitReadTool<T>(
  name: string,
  description: string,
  operation: (git: SimpleGit) => Promise<T>,
): Tool {
  return {
    name,
    description,
    approval: "auto",
    parameters: objectSchema({}),
    execute: async (_arguments_, context) => ({
      output: JSON.stringify(await operation(simpleGit(context.cwd))),
    }),
  };
}

function createGitMutationTool(
  name: string,
  description: string,
  parameters: Record<string, unknown>,
  operation: (
    git: SimpleGit,
    arguments_: Record<string, unknown>,
  ) => Promise<unknown>,
): Tool {
  return {
    name,
    description,
    approval: "ask",
    parameters,
    execute: async (arguments_, context) => ({
      output: JSON.stringify(
        await operation(simpleGit(context.cwd), arguments_),
      ),
    }),
  };
}

async function fetchWebPage(
  url: string,
  signal: AbortSignal,
): Promise<{ body: string; url: string }> {
  let target = url;
  for (let redirects = 0; redirects <= 5; redirects += 1) {
    await assertPublicUrl(target);
    const response = await fetch(target, {
      signal,
      redirect: "manual",
      headers: { "user-agent": "agentic-runtime/0.1" },
    });
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get("location");
      if (!location) {
        throw new Error("Web redirect did not provide a location.");
      }
      target = new URL(location, target).toString();
      continue;
    }
    if (!response.ok)
      throw new Error(`Web request failed with HTTP ${response.status}.`);
    return readWebResponse(response);
  }
  throw new Error("Web request exceeded the five-redirect limit.");
}

async function readWebResponse(
  response: Response,
): Promise<{ body: string; url: string }> {
  const contentType = response.headers.get("content-type") ?? "";
  if (
    !contentType.includes("text/html") &&
    !contentType.includes("text/plain")
  ) {
    throw new Error(
      `Unsupported web content type: ${contentType || "unknown"}.`,
    );
  }
  const body = await response.text();
  if (Buffer.byteLength(body, "utf8") > MAX_WEB_RESPONSE_BYTES) {
    throw new Error("Web response exceeds the 2 MB safety limit.");
  }
  return { body, url: response.url };
}

async function assertPublicUrl(value: string): Promise<void> {
  const url = new URL(value);
  const hostname = url.hostname.replace(/^\[|\]$/g, "");
  const addresses = isIP(hostname)
    ? [{ address: hostname }]
    : await lookup(hostname, { all: true, verbatim: true });
  if (
    addresses.length === 0 ||
    addresses.some(({ address }) => isPrivateIp(address))
  ) {
    throw new Error(
      "Web requests to private or reserved network addresses are not supported.",
    );
  }
}

function isPrivateIp(address: string): boolean {
  const version = isIP(address);
  if (version === 4) {
    const [first, second] = address.split(".").map(Number);
    return (
      first === 0 ||
      first === 10 ||
      first === 127 ||
      (first === 100 && second >= 64 && second <= 127) ||
      (first === 169 && second === 254) ||
      (first === 172 && second >= 16 && second <= 31) ||
      (first === 192 && (second === 0 || second === 168)) ||
      (first === 198 && (second === 18 || second === 19)) ||
      first >= 224
    );
  }
  if (version === 6) {
    const normalized = address.toLowerCase();
    return (
      normalized === "::" ||
      normalized === "::1" ||
      normalized.startsWith("fc") ||
      normalized.startsWith("fd") ||
      /^fe[89ab]/.test(normalized) ||
      (normalized.startsWith("::ffff:") &&
        isPrivateIp(normalized.slice("::ffff:".length)))
    );
  }
  return true;
}

function requireUrl(arguments_: Record<string, unknown>, name: string): string {
  const value = requireString(arguments_, name);
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`The ${name} argument must be a valid URL.`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error(`The ${name} argument must use HTTP or HTTPS.`);
  }
  return url.toString();
}

function optionalInteger(
  arguments_: Record<string, unknown>,
  name: string,
  fallback: number,
  maximum: number,
): number {
  const value = arguments_[name];
  if (value === undefined) return fallback;
  if (
    typeof value !== "number" ||
    !Number.isInteger(value) ||
    value < 1 ||
    value > maximum
  ) {
    throw new Error(
      `The ${name} argument must be an integer between 1 and ${maximum}.`,
    );
  }
  return value;
}

function requireStringArray(
  arguments_: Record<string, unknown>,
  name: string,
): string[] {
  const value = arguments_[name];
  if (
    !Array.isArray(value) ||
    value.some((item) => typeof item !== "string" || !item.trim())
  ) {
    throw new Error(`The ${name} argument must be a non-empty string array.`);
  }
  return value;
}

export function assertSafeGitPaths(paths: readonly string[]): void {
  const blocked = paths.find((path) =>
    /(^|[\\/])(node_modules|dist|build|target)([\\/]|$)/i.test(path),
  );
  if (blocked) {
    throw new Error(
      `Refusing to stage or commit generated dependency output: ${blocked}. Add source, lockfiles, and manifests instead.`,
    );
  }
}

function requireString(
  arguments_: Record<string, unknown>,
  name: string,
): string {
  const value = arguments_[name];
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`The ${name} argument must be a non-empty string.`);
  }
  return value;
}

function objectSchema(
  properties: Record<string, unknown>,
  required = Object.keys(properties),
): Record<string, unknown> {
  return {
    type: "object",
    properties,
    required,
    additionalProperties: false,
  };
}
