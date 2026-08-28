import { Ajv, type ValidateFunction } from "ajv";
import type { Tool, ToolDefinition } from "./tools.js";

export class ToolRegistry {
  private readonly tools = new Map<string, Tool>();
  private readonly exposedToolNames = new Set<string>();
  private readonly validators = new Map<string, ValidateFunction>();
  private readonly validator = new Ajv({ allErrors: true, strict: false });

  register(tool: Tool): this {
    return this.registerTool(tool, true);
  }

  registerHidden(tool: Tool): this {
    return this.registerTool(tool, false);
  }

  private registerTool(tool: Tool, exposed: boolean): this {
    if (this.tools.has(tool.name)) {
      throw new Error(`A tool named "${tool.name}" is already registered.`);
    }

    this.tools.set(tool.name, tool);
    if (exposed) this.exposedToolNames.add(tool.name);
    this.validators.set(tool.name, this.validator.compile(tool.parameters));
    return this;
  }

  get(name: string): Tool | undefined {
    return this.tools.get(name);
  }

  has(name: string): boolean {
    return this.tools.has(name);
  }

  validateArguments(
    name: string,
    arguments_: Record<string, unknown>,
  ): string[] {
    const validate = this.validators.get(name);
    if (!validate || validate(arguments_)) {
      return [];
    }
    return (validate.errors ?? []).map(
      (error) =>
        `${error.instancePath || "arguments"} ${error.message ?? "is invalid"}`,
    );
  }

  list(): ToolDefinition[] {
    return [...this.exposedToolNames].flatMap((name) => {
      const tool = this.tools.get(name);
      if (!tool) return [];
      const { description, parameters, approval } = tool;
      return [{ name, description, parameters, approval }];
    });
  }
}
