import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  SemanticRetrievalIndex,
  createProjectIdentity,
} from "../packages/retrieval/dist/index.js";

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
