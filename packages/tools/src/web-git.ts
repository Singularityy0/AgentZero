import { Readability } from "@mozilla/readability";
import type { Tool } from "@agentic-runtime/core";
import { CheerioCrawler } from "crawlee";
import { JSDOM } from "jsdom";
import { simpleGit, type SimpleGit } from "simple-git";

const MAX_WEB_RESPONSE_BYTES = 2_000_000;

export function createWebTools(): Tool[] {
  return [createBrowseUrlTool(), createCrawlSiteTool()];
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
        await git.add(requireStringArray(arguments_, "paths"));
        return git.status();
      },
    ),
    createGitMutationTool(
      "git_commit",
      "Create a commit from staged changes.",
      objectSchema({ message: { type: "string", minLength: 1 } }),
      (git, arguments_) => git.commit(requireString(arguments_, "message")),
    ),
    createGitMutationTool(
      "git_checkout",
      "Switch to an existing branch or create a new branch.",
      objectSchema({
        branch: { type: "string", minLength: 1 },
        create: { type: "boolean" },
      }),
      async (git, arguments_) => {
        const branch = requireString(arguments_, "branch");
        if (arguments_.create === true) await git.checkoutLocalBranch(branch);
        else await git.checkout(branch);
        return git.status();
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

function createBrowseUrlTool(): Tool {
  return {
    name: "browse_url",
    description:
      "Fetch an HTTP(S) URL and extract readable article text without executing page scripts.",
    approval: "auto",
    parameters: objectSchema({
      url: { type: "string", minLength: 1 },
      maxCharacters: { type: "integer", minimum: 500, maximum: 50_000 },
    }),
    execute: async (arguments_, context) => {
      const url = requireUrl(arguments_, "url");
      const maxCharacters = optionalInteger(
        arguments_,
        "maxCharacters",
        12_000,
        50_000,
      );
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
    approval: "auto",
    parameters: objectSchema({
      url: { type: "string", minLength: 1 },
      maxPages: { type: "integer", minimum: 1, maximum: 25 },
      maxCharactersPerPage: {
        type: "integer",
        minimum: 500,
        maximum: 10_000,
      },
    }),
    execute: async (arguments_, context) => {
      const startUrl = requireUrl(arguments_, "url");
      const maxPages = optionalInteger(arguments_, "maxPages", 10, 25);
      const maxCharacters = optionalInteger(
        arguments_,
        "maxCharactersPerPage",
        4_000,
        10_000,
      );
      const pages: Array<{ url: string; title: string; excerpt: string }> = [];
      const crawler = new CheerioCrawler({
        maxRequestsPerCrawl: maxPages,
        maxConcurrency: 2,
        requestHandlerTimeoutSecs: 20,
        requestHandler: async ({ request, $, enqueueLinks }) => {
          if (context.signal.aborted) return;
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
  const response = await fetch(url, {
    signal,
    headers: { "user-agent": "agentic-runtime/0.1" },
  });
  if (!response.ok)
    throw new Error(`Web request failed with HTTP ${response.status}.`);
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
): Record<string, unknown> {
  return {
    type: "object",
    properties,
    required: Object.keys(properties),
    additionalProperties: false,
  };
}
