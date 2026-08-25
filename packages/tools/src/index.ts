import type {
  Tool,
  ToolExecutionContext,
  ToolPreviewContext,
} from "@agentic-runtime/core";
import {
  executePowerShellCommand,
  type PowerShellToolOptions,
} from "@agentic-runtime/powershell";
import { findFiles, searchText } from "@agentic-runtime/search";
import { WorkspaceFileService } from "@agentic-runtime/workspace";

export function createIdeTools(
  powershellOptions: PowerShellToolOptions = {},
): Tool[] {
  return [
    createListDirectoryTool(),
    createReadFileTool(),
    createWriteFileTool(),
    createCreateFileTool(),
    createDeleteFileTool(),
    createApplyPatchTool(),
    createFindFilesTool(),
    createSearchTextTool(),
    createCommandTool(
      "run_powershell_command",
      "Run an arbitrary PowerShell command. Use specialized tools when possible.",
      powershellOptions,
    ),
    createCommandTool(
      "compile_code",
      "Compile the project.",
      powershellOptions,
    ),
    createCommandTool(
      "run_code",
      "Run the requested project command.",
      powershellOptions,
    ),
    createCommandTool(
      "format_code",
      "Format the project code.",
      powershellOptions,
    ),
    createCommandTool(
      "syntax_check",
      "Run the project's syntax checks.",
      powershellOptions,
    ),
  ];
}

function createListDirectoryTool(): Tool {
  return {
    name: "list_directory",
    description: "List files and directories inside the workspace.",
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
    parameters: objectSchema({
      path: { type: "string", description: "Workspace-relative file path." },
    }),
    execute: async (arguments_, context) => {
      const file = await workspace(context).readText(
        requireString(arguments_, "path"),
      );
      return { output: JSON.stringify(file) };
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
    parameters: objectSchema({
      path: { type: "string", description: "Workspace-relative file path." },
    }),
    preview: async (arguments_, context) => {
      const service = workspace(context);
      const file = await service.readText(requireString(arguments_, "path"));
      return service.previewChange({ path: file.path, newContent: "" });
    },
    execute: async (arguments_, context) => {
      const path = requireString(arguments_, "path");
      const result = await workspace(context).deleteFile(path);
      return { output: result.diff, truncated: false, changed: result.changed };
    },
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
    parameters,
    preview: async (arguments_, context) =>
      workspace(context).previewChange(change(arguments_)),
    execute: async (arguments_, context) => {
      const result = await workspace(context).applyChange(change(arguments_));
      return {
        output: result.diff || "No changes were necessary.",
        changed: result.changed,
      };
    },
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
    parameters: objectSchema(properties),
    preview: async (arguments_, context) =>
      workspace(context).previewChange(getChange(arguments_)),
    execute: async (arguments_, context) => {
      const result = await workspace(context).applyChange(
        getChange(arguments_),
      );
      return {
        output: result.diff || "No changes were necessary.",
        changed: result.changed,
      };
    },
  };
}

function createFindFilesTool(): Tool {
  return {
    name: "find_files",
    description: "Find files in the workspace using a glob pattern.",
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
    parameters: objectSchema({
      pattern: {
        type: "string",
        description: "Regular expression to search for.",
      },
      glob: { type: "string", description: "Optional file glob filter." },
    }),
    execute: async (arguments_, context) => ({
      output: JSON.stringify(
        await searchText({
          root: context.cwd,
          pattern: requireString(arguments_, "pattern"),
          glob: requireString(arguments_, "glob"),
        }),
      ),
    }),
  };
}

function createCommandTool(
  name: string,
  description: string,
  options: PowerShellToolOptions,
): Tool {
  return {
    name,
    description,
    parameters: objectSchema({
      command: { type: "string", description: "The command to execute." },
    }),
    execute: async (arguments_, context) =>
      executePowerShellCommand(
        requireString(arguments_, "command"),
        context,
        options,
      ),
  };
}

function workspace(
  context: ToolPreviewContext | ToolExecutionContext,
): WorkspaceFileService {
  return new WorkspaceFileService(context.cwd);
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
