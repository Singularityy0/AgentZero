import { RustClient } from "./rust-bridge.js";
import type { Tool } from "./tools.js";

export const rustClient = new RustClient();

export const analyzeCodeStructureTool: Tool = {
  name: "analyze_code_structure",
  description:
    "Use the Rust tree-sitter engine to extract semantic blocks matching named symbols from source code.",
  approval: "auto",
  parameters: {
    type: "object",
    properties: {
      code: { type: "string" },
      symbols: { type: "array", items: { type: "string" } },
      extension: {
        type: "string",
        description:
          "Source extension without a leading dot, such as ts, py, or rs.",
      },
    },
    required: ["code", "symbols"],
    additionalProperties: false,
  },
  execute: async (arguments_) => {
    rustClient.start();
    try {
      const { code, symbols, extension } = arguments_ as {
        code: string;
        symbols: string[];
        extension?: string;
      };
      const slices = await rustClient.sliceAst(code, symbols, extension);
      return { output: JSON.stringify(slices) };
    } catch (error) {
      return { output: `Error: ${errorMessage(error)}`, isError: true };
    }
  },
};

export const computeAstDiffTool: Tool = {
  name: "compute_ast_diff",
  description:
    "Compute minimal line-based replacement hunks between original and proposed source content.",
  approval: "auto",
  parameters: {
    type: "object",
    properties: {
      original: { type: "string" },
      proposal: { type: "string" },
    },
    required: ["original", "proposal"],
    additionalProperties: false,
  },
  execute: async (arguments_) => {
    rustClient.start();
    try {
      const { original, proposal } = arguments_ as {
        original: string;
        proposal: string;
      };
      const diffs = await rustClient.computeDiff(original, proposal);
      return { output: JSON.stringify(diffs) };
    } catch (error) {
      return { output: `Error: ${errorMessage(error)}`, isError: true };
    }
  },
};

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
