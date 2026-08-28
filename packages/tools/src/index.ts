import type {
  FileDiffPreview,
  Tool,
  ToolExecutionContext,
  ToolPreviewContext,
} from "@agentic-runtime/core";
import {
  executeCommand,
  type CommandToolOptions,
} from "@agentic-runtime/command";
import { findFiles, searchText } from "@agentic-runtime/search";
import {
  WorkspaceFileService,
  type FileChange,
  type PreparedFileChange,
} from "@agentic-runtime/workspace";
import {
  assertSafeGitPaths,
  createGitTools,
  createWebTools,
} from "./web-git.js";

export { assertSafeGitPaths, createGitTools, createWebTools };

export function createIdeTools(
  commandOptions: CommandToolOptions = {},
): Tool[] {
  return [
    ...createWebTools(),
    ...createGitTools(),
    createListDirectoryTool(),
    createReadFileTool(),
    createWriteFileTool(),
    createCreateFileTool(),
    createDeleteFileTool(),
    createApplyPatchTool(),
    createFindFilesTool(),
    createSearchTextTool(),
    createCommandTool(
      "run_command",
      "Run a command using the host operating system's native shell. Use specialized tools when possible.",
      commandOptions,
    ),
    createCommandTool("compile_code", "Compile the project.", commandOptions),
    createCommandTool(
      "run_code",
      "Run the requested project command.",
      commandOptions,
    ),
    createCommandTool(
      "format_code",
      "Format the project code.",
      commandOptions,
    ),
    createCommandTool(
      "syntax_check",
      "Run the project's syntax checks.",
      commandOptions,
    ),
  ];
}

function createListDirectoryTool(): Tool {
  return {
    name: "list_directory",
    description: "List files and directories inside the workspace.",
    approval: "auto",
    parameters: objectSchema({
      path: {
        type: "string",
        description: "Workspace-relative directory path.",
      },
    }),
    execute: async (arguments_, context) => {
      const service = workspace(context);
      const entries = await service.listDirectory(
        requireString(arguments_, "path"),
      );
      return { output: JSON.stringify(entries) };
    },
  };
}

function createReadFileTool(): Tool {
  return {
    name: "read_file",
    description: "Read a UTF-8 text file inside the workspace.",
    approval: "auto",
    parameters: objectSchema({
      path: { type: "string", description: "Workspace-relative file path." },
    }),
    execute: async (arguments_, context) => {
      const file = await workspace(context).readText(
        requireString(arguments_, "path"),
      );
      return {
        output: JSON.stringify(file),
        contextArtifacts: [
          {
            source: "file",
            path: file.path,
            hash: file.hash,
            content: file.content,
            tokenEstimate: Math.max(1, Math.ceil(file.content.length / 4)),
          },
        ],
      };
    },
  };
}

function createWriteFileTool(): Tool {
  return createMutationTool(
    "write_file",
    "Overwrite a UTF-8 text file inside the workspace.",
    (arguments_) => ({
      path: requireString(arguments_, "path"),
      newContent: requireText(arguments_, "content"),
    }),
  );
}

function createCreateFileTool(): Tool {
  return createMutationTool(
    "create_file",
    "Create a new UTF-8 text file inside the workspace.",
    (arguments_) => ({
      path: requireString(arguments_, "path"),
      newContent: requireText(arguments_, "content"),
      expectedHash: null,
    }),
  );
}

function createDeleteFileTool(): Tool {
  return {
    name: "delete_file",
    description: "Delete a file inside the workspace.",
    approval: "ask",
    parameters: objectSchema({
      path: { type: "string", description: "Workspace-relative file path." },
    }),
    preview: async (arguments_, context) => {
      const service = workspace(context);
      const file = await service.readText(requireString(arguments_, "path"));
      return toFileDiffPreview(
        await service.prepareChange({
          path: file.path,
          newContent: "",
          expectedHash: file.hash,
        }),
      );
    },
    execute: async (arguments_, context) =>
      applyReviewedChange(
        workspace(context),
        { path: requireString(arguments_, "path"), newContent: "" },
        context,
        true,
      ),
  };
}

function createApplyPatchTool(): Tool {
  const parameters = objectSchema({
    path: { type: "string", description: "Workspace-relative file path." },
    oldContent: {
      type: "string",
      description: "Exact content previously read.",
    },
    newContent: {
      type: "string",
      description: "Complete proposed replacement content.",
    },
  });
  const change = (arguments_: Record<string, unknown>) => ({
    path: requireString(arguments_, "path"),
    expectedContent: requireText(arguments_, "oldContent"),
    newContent: requireText(arguments_, "newContent"),
  });
  return {
    name: "apply_patch",
    description: "Apply an exact, conflict-checked file change.",
    approval: "ask",
    parameters,
    preview: async (arguments_, context) =>
      toFileDiffPreview(
        await workspace(context).prepareChange(change(arguments_)),
      ),
    execute: async (arguments_, context) =>
      applyReviewedChange(workspace(context), change(arguments_), context),
  };
}

function createMutationTool(
  name: string,
  description: string,
  getChange: (arguments_: Record<string, unknown>) => {
    path: string;
    newContent: string;
    expectedHash?: string | null;
  },
): Tool {
  const properties = {
    path: { type: "string", description: "Workspace-relative file path." },
    content: { type: "string", description: "Complete UTF-8 file content." },
  };
  return {
    name,
    description,
    approval: "ask",
    parameters: objectSchema(properties),
    preview: async (arguments_, context) =>
      toFileDiffPreview(
        await workspace(context).prepareChange(getChange(arguments_)),
      ),
    execute: async (arguments_, context) =>
      applyReviewedChange(workspace(context), getChange(arguments_), context),
  };
}

function createFindFilesTool(): Tool {
  return {
    name: "find_files",
    description: "Find files in the workspace using a glob pattern.",
    approval: "auto",
    parameters: objectSchema({
      pattern: {
        type: "string",
        description: "Glob pattern, for example **/*.ts.",
      },
    }),
    execute: async (arguments_, context) => ({
      output: JSON.stringify(
        await findFiles(context.cwd, requireString(arguments_, "pattern")),
      ),
    }),
  };
}

function createSearchTextTool(): Tool {
  return {
    name: "search_text",
    description: "Search workspace text using a regular expression.",
    approval: "auto",
    parameters: objectSchema(
      {
        pattern: {
          type: "string",
          description: "Regular expression to search for.",
        },
        glob: { type: "string", description: "Optional file glob filter." },
      },
      ["pattern"],
    ),
    execute: async (arguments_, context) => ({
      output: JSON.stringify(
        await searchText({
          root: context.cwd,
          pattern: requireString(arguments_, "pattern"),
          glob: optionalString(arguments_, "glob"),
        }),
      ),
    }),
  };
}

function createCommandTool(
  name: string,
  description: string,
  options: CommandToolOptions,
): Tool {
  return {
    name,
    description,
    approval: "ask",
    parameters: objectSchema({
      command: { type: "string", description: "The command to execute." },
    }),
    execute: async (arguments_, context) =>
      executeCommand(requireString(arguments_, "command"), context, options),
  };
}

function toFileDiffPreview(prepared: PreparedFileChange): FileDiffPreview {
  return {
    kind: "file_diff",
    path: prepared.path,
    baseHash: prepared.baseHash,
    proposedHash: prepared.proposedHash,
    text: prepared.diff,
    hunks: prepared.hunks,
  };
}

async function applyReviewedChange(
  service: WorkspaceFileService,
  change: FileChange,
  context: ToolExecutionContext,
  deleteWhenFullyAccepted = false,
): Promise<Awaited<ReturnType<Tool["execute"]>>> {
  const approvedPreview = context.approval?.preview;
  const prepared =
    typeof approvedPreview === "object" && approvedPreview.kind === "file_diff"
      ? {
          kind: approvedPreview.kind,
          path: approvedPreview.path,
          baseHash: approvedPreview.baseHash,
          proposedHash: approvedPreview.proposedHash,
          diff: approvedPreview.text,
          hunks: approvedPreview.hunks,
        }
      : await service.prepareChange(change);
  const acceptedHunkIds = context.approval
    ? context.approval.decision.acceptedHunkIds
    : prepared.hunks.map((hunk) => hunk.id);
  const rejectedHunks = prepared.hunks.filter(
    (hunk) => !acceptedHunkIds.includes(hunk.id),
  );
  if (
    deleteWhenFullyAccepted &&
    prepared.baseHash !== null &&
    rejectedHunks.length === 0
  ) {
    const result = await service.deleteFile(prepared.path, prepared.baseHash);
    return {
      output: result.diff || "No changes were necessary.",
      changed: result.changed,
      review: { acceptedHunkIds, rejectedHunks },
      changedFiles: [{ path: result.path, hash: result.hash }],
      workspaceMutation: result.mutation,
    };
  }
  const result = await service.applyPreparedChange(
    change,
    prepared,
    acceptedHunkIds,
  );
  return {
    output: result.diff || "No changes were necessary.",
    changed: result.changed,
    review: {
      acceptedHunkIds: result.appliedHunkIds,
      rejectedHunks: result.rejectedHunks,
    },
    changedFiles: [{ path: result.path, hash: result.hash }],
    workspaceMutation: result.mutation,
  };
}

function workspace(
  context: ToolPreviewContext | ToolExecutionContext,
): WorkspaceFileService {
  return new WorkspaceFileService(context.cwd);
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

function optionalString(
  arguments_: Record<string, unknown>,
  name: string,
): string | undefined {
  const value = arguments_[name];
  if (value === undefined) return undefined;
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`The ${name} argument must be a non-empty string.`);
  }
  return value;
}

function requireText(
  arguments_: Record<string, unknown>,
  name: string,
): string {
  const value = arguments_[name];
  if (typeof value !== "string") {
    throw new Error(`The ${name} argument must be a string.`);
  }
  return value;
}
