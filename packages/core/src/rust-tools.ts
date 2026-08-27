import { Tool } from './tools.js';
import { RustClient } from './rust-bridge.js';

// We share a single persistent instance of the Rust RPC client
export const rustClient = new RustClient();

export const analyzeCodeStructureTool: Tool = {
  name: "analyze_code_structure",
  description: "Leverages the Rust high-performance AST engine to perform structural slicing and extract only the relevant semantic blocks from a large file, saving context tokens.",
  parameters: {
    type: "object",
    properties: {
      code: { type: "string" },
      symbols: { type: "array", items: { type: "string" } }
    },
    required: ["code", "symbols"],
    additionalProperties: false
  },
  execute: async (args) => {
    rustClient.start();
    try {
      const { code, symbols } = args as { code: string; symbols: string[] };
      const slices = await rustClient.sliceAst(code, symbols);
      return { output: JSON.stringify(slices) };
    } catch (e: any) {
      return { output: `Error: ${e.message}`, isError: true };
    }
  }
};

export const computeAstDiffTool: Tool = {
  name: "compute_ast_diff",
  description: "Computes structural Zhang-Shasha AST tree edit distance to extract discrete semantic hunks between an original and proposed file content.",
  parameters: {
    type: "object",
    properties: {
      original: { type: "string" },
      proposal: { type: "string" }
    },
    required: ["original", "proposal"],
    additionalProperties: false
  },
  execute: async (args) => {
    rustClient.start();
    try {
      const { original, proposal } = args as { original: string; proposal: string };
      const diffs = await rustClient.computeDiff(original, proposal);
      return { output: JSON.stringify(diffs) };
    } catch (e: any) {
      return { output: `Error: ${e.message}`, isError: true };
    }
  }
};
