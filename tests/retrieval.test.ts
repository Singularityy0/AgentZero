import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  SemanticRetrievalIndex,
  createProjectIdentity,
} from "../packages/retrieval/dist/index.js";
import { findFiles } from "../packages/search/dist/index.js";
import { stopRustEngine } from "../packages/core/dist/index.js";

const mainSource = `import { helper as importedHelper } from "./helper.js";

export interface User {
  id: string;
  name: string;
}

export function loadUser(id: string): User {
  const loaded = importedHelper(id);
  return { id, name: loaded };
}

export function renderUser(user: User): string {
  return user.name;
}

const current = loadUser("one");
renderUser(current);
`;

async function createProject(root: string): Promise<void> {
  await mkdir(join(root, "src"), { recursive: true });
  await writeFile(join(root, "src", "main.ts"), mainSource, "utf8");
  await writeFile(
    join(root, "src", "helper.ts"),
    `export function helper(id: string): string {\n  return \`user-\${id}\`;\n}\n`,
    "utf8",
  );
  await writeFile(
    join(root, "src", "panel.tsx"),
    `export function Panel(props: { name: string }) {\n  return <section>{props.name}</section>;\n}\n`,
    "utf8",
  );
  await writeFile(
    join(root, "worker.py"),
    `def parse_record(value):\n    return value.strip()\n\nresult = parse_record(" value ")\n`,
    "utf8",
  );
  await writeFile(
    join(root, "notes.txt"),
    Array.from(
      { length: 40 },
      (_, index) => `commonToken retrieval fixture line ${index + 1}`,
    ).join("\n"),
    "utf8",
  );
}

test("persistent semantic retrieval indexes, ranks, recovers, and isolates projects", async () => {
  const sandbox = await mkdtemp(join(tmpdir(), "agentic-retrieval-"));
  const firstRoot = join(sandbox, "first-project");
  const secondRoot = join(sandbox, "second-project");
  const databasePath = join(sandbox, "shared-retrieval.db");
  await createProject(firstRoot);
  await mkdir(secondRoot, { recursive: true });
  await writeFile(
    join(secondRoot, "independent.py"),
    `def isolated_symbol():\n    return "second"\n`,
    "utf8",
  );

  let first: SemanticRetrievalIndex | undefined;
  let reopened: SemanticRetrievalIndex | undefined;
  let second: SemanticRetrievalIndex | undefined;
  try {
    const directIdentity = createProjectIdentity(firstRoot);
    const dottedIdentity = createProjectIdentity(join(firstRoot, "."));
    assert.deepEqual(dottedIdentity, directIdentity);

    first = new SemanticRetrievalIndex({ root: firstRoot, databasePath });
    const initial = await first.indexProject();
    assert.equal(initial.indexed, 5);
    assert.equal(initial.reused, 0);
    assert.equal(initial.errors.length, 0);

    const metadata = first.getFileMetadata("src/main.ts");
    assert.equal(metadata?.extractor, "typescript");
    assert.ok(
      metadata?.symbols.some(
        (symbol) =>
          symbol.name === "loadUser" &&
          symbol.kind === "function" &&
          symbol.exported &&
          symbol.startLine === 8 &&
          symbol.endLine === 11,
      ),
    );
    assert.ok(
      metadata?.edges.some(
        (edge) =>
          edge.kind === "import" &&
          edge.targetName === "helper" &&
          edge.targetPath === "src/helper.ts",
      ),
    );
    assert.ok(
      metadata?.edges.some(
        (edge) => edge.kind === "call" && edge.targetName === "helper",
      ),
    );
    assert.ok(
      metadata?.edges.some(
        (edge) => edge.kind === "reference" && edge.targetName === "loadUser",
      ),
    );
    assert.ok(
      metadata?.edges.some(
        (edge) => edge.kind === "export" && edge.targetName === "loadUser",
      ),
    );
    assert.ok(
      first
        .getFileMetadata("src/panel.tsx")
        ?.symbols.some((symbol) => symbol.name === "Panel"),
    );

    const semantic = await first.query({
      query: "loadUser",
      refresh: false,
      maxSliceLines: 6,
    });
    assert.ok(semantic.results.length > 0);
    assert.equal(semantic.results[0]?.path, "src/main.ts");
    assert.ok((semantic.results[0]?.score ?? 0) > 100);
    assert.ok(
      semantic.results[0]?.reasons.some((reason) =>
        reason.includes("exact function symbol match"),
      ),
    );
    assert.ok((semantic.results[0]?.content.split("\n").length ?? 0) <= 6);
    assert.ok((semantic.results[0]?.content.split("\n").length ?? 0) < 18);

    const fallback = await first.query({
      query: "parse record",
      refresh: false,
    });
    assert.equal(fallback.recovery.strategy, "broadened");
    assert.equal(fallback.results[0]?.path, "worker.py");
    assert.ok(
      fallback.results[0]?.reasons.some(
        (reason) =>
          reason.includes("symbol match") ||
          reason.includes("ripgrep fallback"),
      ),
    );

    const excessive = await first.query({
      query: "commonToken",
      refresh: false,
      maxCandidates: 12,
      limit: 4,
      maxSliceLines: 3,
    });
    assert.equal(excessive.recovery.strategy, "narrowed");
    assert.ok(excessive.recovery.candidateCount > 12);
    assert.ok(
      excessive.results.every(
        (result) => result.endLine - result.startLine < 3,
      ),
    );

    const missing = await first.query({
      query: "symbolThatCannotExist anywhere",
      refresh: false,
    });
    assert.equal(missing.results.length, 0);
    assert.equal(missing.recovery.strategy, "empty");
    assert.equal(missing.recovery.attempted, true);

    first.close();
    first = undefined;
    reopened = new SemanticRetrievalIndex({ root: firstRoot, databasePath });
    const reuse = await reopened.indexProject();
    assert.equal(reuse.indexed, 0);
    assert.equal(reuse.reused, 5);
    assert.ok(
      (await reopened.query({ query: "renderUser", refresh: false })).results
        .length > 0,
    );

    await writeFile(
      join(firstRoot, "src", "helper.ts"),
      `export function helper(id: string): string {\n  return id.toUpperCase();\n}\n`,
      "utf8",
    );
    const incremental = await reopened.indexProject();
    assert.equal(incremental.indexed, 1);
    assert.equal(incremental.reused, 4);

    await rm(join(firstRoot, "worker.py"));
    const deletion = await reopened.indexProject();
    assert.equal(deletion.deleted, 1);
    assert.equal(reopened.getFileMetadata("worker.py"), undefined);

    second = new SemanticRetrievalIndex({ root: secondRoot, databasePath });
    const secondReport = await second.indexProject();
    assert.equal(secondReport.indexed, 1);
    assert.notEqual(second.project.id, reopened.project.id);
    assert.equal(
      (await second.query({ query: "loadUser", refresh: false })).results
        .length,
      0,
    );
    assert.equal(
      (await second.query({ query: "isolated symbol", refresh: false }))
        .results[0]?.path,
      "independent.py",
    );
  } finally {
    first?.close();
    reopened?.close();
    second?.close();
    await rm(sandbox, { recursive: true, force: true });
  }
});

test("JavaScript is indexed by the compiler, not the text fallback", async () => {
  const root = await mkdtemp(join(tmpdir(), "retrieval-js-"));
  try {
    await mkdir(join(root, "src"), { recursive: true });
    await writeFile(
      join(root, "src", "cart.js"),
      [
        'import { priceOf } from "./pricing.js";',
        "",
        "export function totalCart(items) {",
        "  return items.reduce((sum, item) => sum + priceOf(item), 0);",
        "}",
        "",
      ].join("\n"),
      "utf8",
    );
    await writeFile(
      join(root, "src", "pricing.js"),
      "export function priceOf(item) {\n  return item.price;\n}\n",
      "utf8",
    );
    const index = new SemanticRetrievalIndex({ root });
    try {
      await index.indexProject();
      // The text fallback would record `ripgrep-text` and no call edges.
      assert.equal(
        index.getFileMetadata("src/cart.js")?.extractor,
        "typescript",
      );

      const result = await index.query({ query: "totalCart" });
      const slice = result.results.find((item) => item.path === "src/cart.js");
      assert.ok(slice, "the defining file should be retrieved");
      assert.ok(
        slice.reasons.some((reason) => /symbol match/.test(reason)),
        `expected a symbol match, got ${JSON.stringify(slice.reasons)}`,
      );
      // The import edge should pull the callee in as a graph neighbor.
      assert.ok(
        result.results.some((item) => item.path === "src/pricing.js"),
        "the imported module should be reachable through the graph",
      );
    } finally {
      index.close();
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("re-indexing skips unchanged files and still sees real edits", async () => {
  const root = await mkdtemp(join(tmpdir(), "retrieval-incremental-"));
  try {
    await mkdir(join(root, "src"), { recursive: true });
    const target = join(root, "src", "widget.ts");
    await writeFile(
      target,
      "export function widget(): number {\n  return 1;\n}\n",
      "utf8",
    );
    for (let index = 0; index < 4; index += 1) {
      await writeFile(
        join(root, "src", `filler-${index}.ts`),
        `export const filler${index} = ${index};\n`,
        "utf8",
      );
    }
    const index = new SemanticRetrievalIndex({ root });
    try {
      const first = await index.indexProject();
      assert.equal(first.indexed, 5);
      assert.equal(first.reused, 0);

      // Nothing changed: every file takes the stat fast path, and no file is
      // read or re-extracted.
      const second = await index.indexProject();
      assert.equal(second.indexed, 0);
      assert.equal(second.reused, 5);

      // A real edit still moves mtime, so it is picked up.
      await writeFile(
        target,
        "export function widget(): number {\n  return 2;\n}\n\nexport function extraWidget(): number {\n  return 3;\n}\n",
        "utf8",
      );
      const third = await index.indexProject();
      assert.equal(third.indexed, 1);
      assert.equal(third.reused, 4);

      const result = await index.query({ query: "extraWidget" });
      assert.ok(
        result.results.some((slice) => slice.path === "src/widget.ts"),
        "the newly added symbol should be searchable",
      );
    } finally {
      index.close();
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("file discovery honours ignore rules instead of walking dependencies", async () => {
  const root = await mkdtemp(join(tmpdir(), "retrieval-ignore-"));
  try {
    await mkdir(join(root, "src"), { recursive: true });
    await mkdir(join(root, "node_modules", "left-pad"), { recursive: true });
    await mkdir(join(root, "dist"), { recursive: true });
    await writeFile(
      join(root, "src", "app.ts"),
      "export const app = 1;\n",
      "utf8",
    );
    await writeFile(
      join(root, "node_modules", "left-pad", "index.js"),
      "module.exports = function app() {};\n",
      "utf8",
    );
    await writeFile(
      join(root, "dist", "app.js"),
      "export const app = 1;\n",
      "utf8",
    );

    // Deliberately no .gitignore: the exclusions must hold on their own, since
    // a user can open any folder as a codebase.
    const found = await findFiles(root, "*", 500);
    assert.deepEqual(found, ["src/app.ts"]);

    // A caller-supplied pattern must not re-admit dependency files either.
    const scoped = await findFiles(root, "*.js", 500);
    assert.deepEqual(scoped, []);

    const index = new SemanticRetrievalIndex({ root });
    try {
      const report = await index.indexProject();
      assert.equal(report.discovered, 1);
      const matches = await index.query({ query: "app" });
      assert.deepEqual(
        [...new Set(matches.results.map((slice) => slice.path))],
        ["src/app.ts"],
      );
    } finally {
      index.close();
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Python, Go, Rust, C, and C++ are parsed, not regex-matched", async () => {
  const root = await mkdtemp(join(tmpdir(), "retrieval-polyglot-"));
  try {
    await mkdir(join(root, "src"), { recursive: true });
    const files: Record<string, string> = {
      "src/service.py": [
        "import os",
        "",
        "def load_config(path):",
        "    return os.path.join(path, 'cfg')",
        "",
        "class Service:",
        "    def start(self):",
        "        return load_config('/etc')",
        "",
      ].join("\n"),
      "src/server.go": [
        "package main",
        "",
        'import "fmt"',
        "",
        "type Server struct {",
        "\tAddr string",
        "}",
        "",
        "func Serve(s *Server) {",
        "\tfmt.Println(s.Addr)",
        "}",
        "",
        "func boot() {",
        "\tServe(nil)",
        "}",
        "",
      ].join("\n"),
      "src/engine.rs": [
        "pub struct Engine { size: usize }",
        "",
        "impl Engine {",
        "    pub fn start(&self) -> usize { self.compute() }",
        "    fn compute(&self) -> usize { self.size }",
        "}",
        "",
      ].join("\n"),
      "src/util.c": [
        "#include <stdio.h>",
        "",
        "static int helper(int x) { return x + 1; }",
        "",
        "int Run(int x) { return helper(x); }",
        "",
      ].join("\n"),
      "src/app.cpp": [
        "namespace app {",
        "class Engine {",
        "public:",
        "  int Start();",
        "};",
        "int Engine::Start() { return 1; }",
        "}",
        "",
      ].join("\n"),
    };
    for (const [path, content] of Object.entries(files)) {
      await writeFile(join(root, path), content, "utf8");
    }

    const index = new SemanticRetrievalIndex({
      root,
      databasePath: join(root, ".data", "retrieval.db"),
    });
    try {
      await index.indexProject();

      // Every one of these used to be a per-line regex producing single-line
      // anchors and no call graph.
      for (const path of Object.keys(files)) {
        assert.equal(
          index.getFileMetadata(path)?.extractor,
          "tree-sitter",
          `${path} should be parsed`,
        );
      }

      // Real spans, not one-line anchors.
      const server = index
        .getFileMetadata("src/server.go")
        ?.symbols.find((symbol) => symbol.name === "Server");
      assert.ok(server && server.endLine > server.startLine);

      // Per-language visibility rules, not a shared guess.
      const go = index.getFileMetadata("src/server.go")?.symbols ?? [];
      assert.equal(go.find((s) => s.name === "Serve")?.exported, true);
      assert.equal(go.find((s) => s.name === "boot")?.exported, false);
      const rust = index.getFileMetadata("src/engine.rs")?.symbols ?? [];
      assert.equal(rust.find((s) => s.name === "start")?.exported, true);

      // A call graph attributed to the enclosing function, in every language.
      const callEdge = (path: string, from: string, to: string): boolean =>
        (index.getFileMetadata(path)?.edges ?? []).some(
          (edge) =>
            edge.kind === "call" &&
            edge.sourceSymbol === from &&
            edge.targetName === to,
        );
      assert.ok(callEdge("src/service.py", "start", "load_config"));
      assert.ok(callEdge("src/server.go", "boot", "Serve"));
      assert.ok(callEdge("src/engine.rs", "start", "compute"));
      assert.ok(callEdge("src/util.c", "Run", "helper"));

      // And the index ranks across languages from one query.
      const found = await index.query({ query: "Engine", refresh: false });
      const paths = new Set(found.results.map((slice) => slice.path));
      assert.ok(paths.has("src/engine.rs"));
      assert.ok(paths.has("src/app.cpp"));
    } finally {
      index.close();
    }
  } finally {
    await rm(root, { recursive: true, force: true }).catch(() => undefined);
  }
});

test("the code graph reaches past one hop and persists across a restart", async () => {
  const root = await mkdtemp(join(tmpdir(), "retrieval-cpg-"));
  try {
    await mkdir(join(root, "src"), { recursive: true });
    // A four-deep call chain across four files, plus one disconnected file.
    // Only `handleRequest` is named by the query; the rest are reachable only
    // by following calls, and `unrelatedThing` is reachable not at all.
    const chain: Array<[string, string]> = [
      [
        "src/a.go",
        "package main\n\nfunc handleRequest() {\n\tserviceLayer()\n}\n",
      ],
      [
        "src/b.go",
        "package main\n\nfunc serviceLayer() {\n\trepositoryFetch()\n}\n",
      ],
      [
        "src/c.go",
        "package main\n\nfunc repositoryFetch() {\n\tdriverExecute()\n}\n",
      ],
      [
        "src/d.go",
        "package main\n\nfunc driverExecute() int {\n\treturn 7\n}\n",
      ],
      [
        "src/z.go",
        "package main\n\nfunc unrelatedThing() int {\n\treturn 0\n}\n",
      ],
    ];
    for (const [path, content] of chain) {
      await writeFile(join(root, path), content, "utf8");
    }

    const databasePath = join(root, ".data", "retrieval.db");
    const first = new SemanticRetrievalIndex({ root, databasePath });
    try {
      await first.indexProject();
      const found = await first.query({
        query: "handleRequest",
        refresh: false,
        limit: 20,
      });
      const paths = new Set(found.results.map((slice) => slice.path));

      assert.ok(paths.has("src/a.go"), "the direct match");
      assert.ok(paths.has("src/b.go"), "one hop");
      assert.ok(
        paths.has("src/d.go"),
        "three hops, which the per-file one-hop expansion cannot reach",
      );
      assert.ok(
        !paths.has("src/z.go"),
        "a disconnected file must not be pulled in",
      );

      // The reason names the mechanism, so a user can tell why a file they did
      // not ask for is in their context.
      assert.ok(
        found.results.some((slice) =>
          slice.reasons.some((reason) => /call-graph proximity/.test(reason)),
        ),
      );
    } finally {
      first.close();
    }

    // A new index over the same database uses the graph the sidecar persisted
    // through its write-ahead log, without rebuilding it.
    const second = new SemanticRetrievalIndex({ root, databasePath });
    try {
      const reopened = await second.query({
        query: "handleRequest",
        refresh: false,
        limit: 20,
      });
      assert.ok(
        reopened.results.some((slice) => slice.path === "src/d.go"),
        "the persisted graph should still reach three hops",
      );
    } finally {
      second.close();
    }
  } finally {
    stopRustEngine();
    await rm(root, { recursive: true, force: true }).catch(() => undefined);
  }
});
