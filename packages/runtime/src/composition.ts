import { dirname, join } from "node:path";
import {
  ToolRegistry,
  analyzeCodeStructureTool,
  computeAstDiffTool,
  type LanguageModel,
  type Tool,
} from "@agentic-runtime/core";
import {
  createDefaultProviderGateway,
  StoredCredentialResolver,
  type GatewayEvent,
} from "@agentic-runtime/gateway";
import { SemanticRetrievalIndex } from "@agentic-runtime/retrieval";
import {
  loadProjectAgents,
  loadProjectInstructions,
  SessionStore,
  type SessionStoreOptions,
} from "@agentic-runtime/session";
import { createIdeTools } from "@agentic-runtime/tools";
import { createDefaultAgents, RESERVED_AGENT_IDS } from "./default-agents.js";
import {
  HeadlessRuntimeService,
  type HeadlessRuntimeServiceOptions,
} from "./runtime-service.js";
import type {
  RuntimeApprovalHandler,
  RuntimeLimits,
  RuntimeModelRouteSelection,
  RuntimeModelSelection,
} from "./types.js";

export interface CreateHeadlessRuntimeOptions {
  workspaceRoot: string;
  model: RuntimeModelSelection;
  requestApproval: RuntimeApprovalHandler;
  credentialEnvironmentFallback?: Readonly<Record<string, string>>;
  limits?: Partial<RuntimeLimits>;
  sessionStore?: Omit<SessionStoreOptions, "projectRoot">;
}

export function createHeadlessRuntime(
  options: CreateHeadlessRuntimeOptions,
): HeadlessRuntimeService {
  const store = new SessionStore({
    ...options.sessionStore,
    projectRoot: options.workspaceRoot,
  });
  let retrieval: SemanticRetrievalIndex | undefined;

  try {
    registerAgents(store);
    const createdRetrieval = new SemanticRetrievalIndex({
      root: store.project.rootPath,
      databasePath: join(dirname(store.projectDatabasePath), "retrieval.db"),
    });
    retrieval = createdRetrieval;
    const serviceReference: { current?: HeadlessRuntimeService } = {};
    const model = createModel(
      options.model,
      store,
      options.credentialEnvironmentFallback,
      (event) => serviceReference.current?.recordGatewayEvent(event),
    );
    const serviceOptions: HeadlessRuntimeServiceOptions = {
      store,
      model: options.model,
      resolveModel: () => model,
      resolveTools: () => createToolRegistry(createdRetrieval),
      requestApproval: options.requestApproval,
      retrieval: createdRetrieval,
      limits: options.limits,
    };
    const service = new HeadlessRuntimeService(serviceOptions);
    serviceReference.current = service;
    return service;
  } catch (error) {
    retrieval?.close();
    store.close();
    throw error;
  }
}

function registerAgents(store: SessionStore): void {
  const instructions = loadProjectInstructions(store.project.rootPath);
  for (const agent of createDefaultAgents(instructions)) {
    store.registerAgent(agent);
  }
  for (const agent of loadProjectAgents(store.project.rootPath)) {
    if (!RESERVED_AGENT_IDS.has(agent.id)) store.registerAgent(agent);
  }
}

function createModel(
  selection: RuntimeModelSelection,
  store: SessionStore,
  credentialEnvironmentFallback: Readonly<Record<string, string>> | undefined,
  onEvent: (event: GatewayEvent) => void,
): LanguageModel {
  const credentials = new StoredCredentialResolver(
    store,
    credentialEnvironmentFallback,
  );
  const gateway = createDefaultProviderGateway({ credentials, onEvent });
  const routes = uniqueRoutes([selection, ...(selection.fallbacks ?? [])]);
  if (routes.length === 0)
    throw new Error("At least one model route is required.");

  for (const route of routes) {
    const modelId =
      store.getProviderSetting(route.providerId, "manualModelId") ??
      route.modelId.trim();
    if (!modelId) continue;
    const baseUrl =
      store.getProviderSetting(route.providerId, "baseUrl") ?? route.baseUrl;
    const credentialRef =
      route.credentialRef === null
        ? undefined
        : (route.credentialRef ??
          (route.providerId === "ollama" ? undefined : route.providerId));
    gateway.configure({
      providerId: route.providerId,
      baseUrl,
      credentialRef,
      manualModelId: modelId,
    });
    gateway.registerModel({
      id: modelId,
      name: modelId,
      providerId: route.providerId,
      contextWindow: route.contextWindow,
      pricing: {
        inputPerMillion: route.inputCostPerMillion,
        outputPerMillion: route.outputCostPerMillion,
      },
      capabilities: {
        tools: true,
        vision: false,
        reasoning: false,
        streaming: true,
        structuredOutput: true,
      },
      metadata: {},
    });
  }

  const preferences = routes
    .map((route) => ({
      providerId: route.providerId,
      modelId:
        store.getProviderSetting(route.providerId, "manualModelId") ??
        route.modelId.trim(),
    }))
    .filter((route) => route.modelId);
  if (preferences.length === 0) {
    throw new Error("No configured model route has a model ID.");
  }
  gateway.setRoutePreferences(preferences);
  return gateway;
}

function uniqueRoutes(
  routes: readonly RuntimeModelRouteSelection[],
): RuntimeModelRouteSelection[] {
  const unique = new Map<string, RuntimeModelRouteSelection>();
  for (const route of routes) {
    const modelId = route.modelId.trim();
    if (!modelId) continue;
    const key = `${route.providerId}:${modelId}`;
    if (!unique.has(key)) unique.set(key, { ...route, modelId });
  }
  return [...unique.values()];
}

function createToolRegistry(retrieval: SemanticRetrievalIndex): ToolRegistry {
  const registry = new ToolRegistry();
  for (const tool of createIdeTools()) registry.register(tool);
  registry.register(createRetrievalTool(retrieval));
  registry.register(analyzeCodeStructureTool);
  registry.register(computeAstDiffTool);
  return registry;
}

function createRetrievalTool(retrieval: SemanticRetrievalIndex): Tool {
  return {
    name: "retrieve_context",
    description:
      "Query the persistent project semantic index and return ranked compact file slices with line ranges and relevance reasons.",
    approval: "auto",
    parameters: {
      type: "object",
      properties: {
        query: { type: "string", minLength: 1 },
        limit: { type: "integer", minimum: 1, maximum: 20 },
      },
      required: ["query"],
      additionalProperties: false,
    },
    execute: async (arguments_) => {
      const query = arguments_.query;
      if (typeof query !== "string" || !query.trim()) {
        throw new Error("The retrieval query must be a non-empty string.");
      }
      const limit =
        typeof arguments_.limit === "number" ? arguments_.limit : undefined;
      const result = await retrieval.query({ query, limit });
      return {
        output: JSON.stringify(result),
        contextArtifacts: result.results.map((slice) => ({
          source: "retrieval" as const,
          path: slice.path,
          startLine: slice.startLine,
          endLine: slice.endLine,
          content: slice.content,
          tokenEstimate: Math.max(1, Math.ceil(slice.content.length / 4)),
          reasons: slice.reasons,
          extractor: retrieval.getFileMetadata(slice.path)?.extractor,
        })),
      };
    },
  };
}
