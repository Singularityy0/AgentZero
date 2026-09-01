import assert from "node:assert/strict";
import { test } from "node:test";
import {
  ModelError,
  classifyModelError,
  type ModelRequest,
  type ModelResponse,
} from "../packages/core/dist/index.js";
import {
  createDefaultProviderGateway,
  PROVIDER_FIELD_SPECS,
  ProviderGateway,
  ProviderRegistry,
  rankModelRoutes,
  type GatewayEvent,
  type ModelInfo,
  type ModelRoute,
  type ProviderAdapter,
} from "../packages/gateway/dist/index.js";
import {
  classifyTaskComplexity,
  routePolicyForStage,
} from "../packages/runtime/dist/index.js";

test("default provider catalog exposes only explicit competition-safe presets", () => {
  const gateway = createDefaultProviderGateway();
  assert.deepEqual(
    gateway.providers.list().map((provider) => provider.id),
    [
      "groq",
      "openrouter",
      "mistral",
      "cerebras",
      "huggingface",
      "openai-compatible",
      "ollama",
    ],
  );
  assert.equal(
    PROVIDER_FIELD_SPECS.find((provider) => provider.id === "openrouter")
      ?.defaultModelId,
    "nvidia/nemotron-3.5-lightning:free",
  );
  assert.equal(
    gateway.registerModel(
      model("openrouter", "nvidia/nemotron-3.5-lightning:free"),
    ).totalParameters,
    30_000_000_000,
  );
});

const response: ModelResponse = {
  message: { role: "assistant", content: "ok", toolCalls: [] },
  text: "ok",
  toolCalls: [],
};

function model(
  providerId: string,
  id: string,
  options: {
    tools?: boolean;
    contextWindow?: number;
    inputCost?: number;
    outputCost?: number;
    totalParameters?: number;
  } = {},
): ModelInfo {
  return {
    id,
    name: id,
    providerId,
    contextWindow: options.contextWindow,
    totalParameters: options.totalParameters,
    pricing:
      options.inputCost === undefined && options.outputCost === undefined
        ? undefined
        : {
            inputPerMillion: options.inputCost,
            outputPerMillion: options.outputCost,
          },
    capabilities: {
      tools: options.tools ?? true,
      vision: false,
      reasoning: false,
      streaming: false,
      structuredOutput: true,
    },
    metadata: {},
  };
}

class StubProvider implements ProviderAdapter {
  constructor(
    readonly id: string,
    private readonly models: readonly ModelInfo[],
    private readonly execute: (request: ModelRequest) => Promise<ModelResponse>,
  ) {}

  configure(): void {}

  async validateCredentials(): Promise<void> {}

  async discoverModels(): Promise<ModelInfo[]> {
    return [...this.models];
  }

  async createRoute(selected: ModelInfo): Promise<ModelRoute> {
    return {
      providerId: this.id,
      modelId: selected.id,
      baseUrl: "https://example.invalid",
      protocol: "openai-chat",
      execute: this.execute,
    };
  }
}

function request(content = "private prompt"): ModelRequest {
  return {
    messages: [{ role: "user", content }],
    tools: [],
  };
}

function registerModels(gateway: ProviderGateway, models: ModelInfo[]): void {
  for (const candidate of models) gateway.registerModel(candidate);
}

test("model errors classify retryable and terminal provider failures", () => {
  assert.deepEqual(classifyModelError({ status: 429 }), {
    code: "rate_limit",
    retryable: true,
    status: 429,
  });
  assert.equal(classifyModelError({ status: 413 }).code, "context_length");
  assert.equal(
    classifyModelError(new Error("request timed out")).code,
    "timeout",
  );
  assert.equal(classifyModelError({ code: "ECONNREFUSED" }).code, "connection");
  assert.equal(classifyModelError({ status: 503 }).code, "server");
  assert.deepEqual(classifyModelError({ status: 401 }), {
    code: "authentication",
    retryable: false,
    status: 401,
  });
  assert.deepEqual(classifyModelError({ status: 400 }), {
    code: "invalid_request",
    retryable: false,
    status: 400,
  });
});

test("route ranking is pure and accounts for tools, context, cost, and cooldown", () => {
  const candidates = [
    {
      model: model("groq", "no-tools", {
        tools: false,
        contextWindow: 10_000,
      }),
      preference: 0,
    },
    {
      model: model("openrouter", "small-context", { contextWindow: 100 }),
      preference: 0,
    },
    {
      model: model("groq", "cooling", {
        contextWindow: 10_000,
        inputCost: 0,
        outputCost: 0,
      }),
      preference: 0,
      cooldownUntil: 2_000,
    },
    {
      model: model("openrouter", "expensive", {
        contextWindow: 10_000,
        inputCost: 10,
        outputCost: 10,
      }),
      preference: 1,
    },
    {
      model: model("openrouter", "cheap", {
        contextWindow: 10_000,
        inputCost: 1,
        outputCost: 1,
      }),
      preference: 1,
    },
  ] as const;
  const snapshot = JSON.stringify(candidates);

  const ranked = rankModelRoutes(candidates, {
    requiresTools: true,
    contextTokens: 100,
    estimatedOutputTokens: 50,
    now: 1_000,
  });

  assert.equal(JSON.stringify(candidates), snapshot);
  assert.deepEqual(
    ranked.slice(0, 3).map((route) => route.model.id),
    ["cheap", "expensive", "cooling"],
  );
  assert.equal(ranked[0]?.estimatedCost, 0.00015);
  assert.equal(ranked[2]?.inCooldown, true);
  assert.equal(
    ranked.find((route) => route.model.id === "no-tools")?.eligible,
    false,
  );
  assert.match(
    ranked.find((route) => route.model.id === "small-context")?.reason ?? "",
    /exceeds window/,
  );
});

test("gateway fails over with the identical request and emits sanitized routing events", async () => {
  const events: GatewayEvent[] = [];
  const received: ModelRequest[] = [];
  const first = model("groq", "primary", { contextWindow: 10_000 });
  const second = model("ollama", "fallback", { contextWindow: 10_000 });
  const registry = new ProviderRegistry()
    .register(
      new StubProvider("groq", [first], async (modelRequest) => {
        received.push(modelRequest);
        throw new ModelError("rate limited: secret-key private prompt", {
          code: "rate_limit",
          retryable: true,
          status: 429,
        });
      }),
    )
    .register(
      new StubProvider("ollama", [second], async (modelRequest) => {
        received.push(modelRequest);
        return response;
      }),
    );
  const gateway = new ProviderGateway(registry, (event) => events.push(event), {
    maxAttempts: 2,
    cooldownMs: 5_000,
    now: () => 1_000,
  });
  registerModels(gateway, [first, second]);
  gateway.setRoutePreferences([
    { providerId: "groq", modelId: "primary" },
    { providerId: "ollama", modelId: "fallback" },
  ]);
  const original = request();

  assert.equal(await gateway.respond(original), response);
  assert.equal(received.length, 2);
  assert.equal(received[0], original);
  assert.equal(received[1], original);
  assert.equal(received[0]?.messages, original.messages);
  assert.equal(received[1]?.messages, original.messages);

  const failed = events.find(
    (event) => event.type === "routing_attempt_failed",
  );
  assert.deepEqual(failed?.failure, {
    code: "rate_limit",
    retryable: true,
    status: 429,
  });
  const decisions = events.filter((event) => event.type === "routing_decision");
  assert.deepEqual(
    decisions.map((event) => [event.providerId, event.modelId, event.attempt]),
    [
      ["groq", "primary", 1],
      ["ollama", "fallback", 2],
    ],
  );
  assert.match(decisions[1]?.reason ?? "", /failover after rate_limit/);
  for (const event of events.filter((item) =>
    item.type.startsWith("routing_"),
  )) {
    assert.equal(typeof event.reason, "string");
    assert.equal(typeof event.attempt, "number");
    assert.equal(typeof event.contextTokens, "number");
    assert.equal("estimatedCost" in event, true);
  }
  const serializedEvents = JSON.stringify(events);
  assert.equal(serializedEvents.includes("secret-key"), false);
  assert.equal(serializedEvents.includes("private prompt"), false);

  received.length = 0;
  events.length = 0;
  assert.equal(await gateway.respond(original), response);
  assert.equal(received.length, 1);
  assert.equal(
    events.find((event) => event.type === "routing_decision")?.providerId,
    "ollama",
  );
});

test("gateway tolerates throwing observers and normalizes raw transient failures", async () => {
  const primary = model("groq", "primary", { contextWindow: 10_000 });
  const fallback = model("ollama", "fallback", { contextWindow: 10_000 });
  const received: ModelRequest[] = [];
  const gateway = new ProviderGateway(
    new ProviderRegistry()
      .register(
        new StubProvider("groq", [primary], async (value) => {
          received.push(value);
          throw { status: 429, message: "raw rate limit" };
        }),
      )
      .register(
        new StubProvider("ollama", [fallback], async (value) => {
          received.push(value);
          return structuredClone(response);
        }),
      ),
    () => {
      throw new Error("observer failed");
    },
  );
  registerModels(gateway, [primary, fallback]);
  gateway.setRoutePreferences([
    { providerId: "groq", modelId: "primary" },
    { providerId: "ollama", modelId: "fallback" },
  ]);
  const original = request("observer-safe prompt");

  assert.equal((await gateway.respond(original)).text, "ok");
  assert.equal(received.length, 2);
  assert.equal(received[0], original);
  assert.equal(received[1], original);
});

test("gateway restores a primary route at cooldown expiry", async () => {
  let now = 1_000;
  let primaryCalls = 0;
  let fallbackCalls = 0;
  const primary = model("groq", "primary", { contextWindow: 10_000 });
  const fallback = model("ollama", "fallback", { contextWindow: 10_000 });
  const gateway = new ProviderGateway(
    new ProviderRegistry()
      .register(
        new StubProvider("groq", [primary], async () => {
          primaryCalls += 1;
          if (primaryCalls === 1) throw { status: 429 };
          return structuredClone(response);
        }),
      )
      .register(
        new StubProvider("ollama", [fallback], async () => {
          fallbackCalls += 1;
          return structuredClone(response);
        }),
      ),
    undefined,
    { cooldownMs: 5_000, now: () => now },
  );
  registerModels(gateway, [primary, fallback]);
  gateway.setRoutePreferences([
    { providerId: "groq", modelId: "primary" },
    { providerId: "ollama", modelId: "fallback" },
  ]);

  await gateway.respond(request());
  now = 5_999;
  await gateway.respond(request());
  assert.deepEqual(
    { primaryCalls, fallbackCalls },
    { primaryCalls: 1, fallbackCalls: 2 },
  );
  now = 6_000;
  await gateway.respond(request());
  assert.deepEqual(
    { primaryCalls, fallbackCalls },
    { primaryCalls: 2, fallbackCalls: 2 },
  );
});

test("gateway stops on terminal errors without trying a fallback", async () => {
  let fallbackAttempts = 0;
  const first = model("groq", "primary", { contextWindow: 10_000 });
  const second = model("ollama", "fallback", { contextWindow: 10_000 });
  const gateway = new ProviderGateway(
    new ProviderRegistry()
      .register(
        new StubProvider("groq", [first], async () => {
          throw new ModelError("invalid credentials", {
            code: "authentication",
            retryable: false,
            status: 401,
          });
        }),
      )
      .register(
        new StubProvider("ollama", [second], async () => {
          fallbackAttempts += 1;
          return response;
        }),
      ),
  );
  registerModels(gateway, [first, second]);
  gateway.setRoutePreferences([
    { providerId: "groq", modelId: "primary" },
    { providerId: "ollama", modelId: "fallback" },
  ]);

  await assert.rejects(
    gateway.respond(request()),
    (error: unknown) =>
      error instanceof ModelError && error.code === "authentication",
  );
  assert.equal(fallbackAttempts, 0);
});

test("gateway exposes context estimates and classifies oversized requests", async () => {
  const selected = model("ollama", "small", { contextWindow: 1500 });
  const gateway = new ProviderGateway(
    new ProviderRegistry().register(
      new StubProvider("ollama", [selected], async () => response),
    ),
  );
  registerModels(gateway, [selected]);
  gateway.select("ollama", "small");
  const oversized = request("x".repeat(8000));

  assert.equal(gateway.estimateContext(oversized).contextWindowTokens, 1500);
  await assert.rejects(
    gateway.respond(oversized),
    (error: unknown) =>
      error instanceof ModelError && error.code === "context_length",
  );
});

test("gateway bounds failover attempts and preserves select compatibility", async () => {
  const attempts = new Map<string, number>();
  const models = [
    model("groq", "one", { contextWindow: 10_000 }),
    model("openrouter", "two", { contextWindow: 10_000 }),
    model("ollama", "three", { contextWindow: 10_000 }),
  ];
  const failingProvider = (providerId: string, selected: ModelInfo) =>
    new StubProvider(providerId, [selected], async () => {
      attempts.set(providerId, (attempts.get(providerId) ?? 0) + 1);
      throw new ModelError("temporary failure", {
        code: "server",
        retryable: true,
        status: 503,
      });
    });
  const gateway = new ProviderGateway(
    new ProviderRegistry()
      .register(failingProvider("groq", models[0]!))
      .register(failingProvider("openrouter", models[1]!))
      .register(
        new StubProvider("ollama", [models[2]!], async () => {
          attempts.set("ollama", (attempts.get("ollama") ?? 0) + 1);
          return response;
        }),
      ),
    undefined,
    { maxAttempts: 2 },
  );
  registerModels(gateway, models);
  gateway.setRoutePreferences([
    { providerId: "groq", modelId: "one" },
    { providerId: "openrouter", modelId: "two" },
    { providerId: "ollama", modelId: "three" },
  ]);

  await assert.rejects(gateway.respond(request()), ModelError);
  assert.deepEqual(Object.fromEntries(attempts), { groq: 1, openrouter: 1 });

  gateway.select("ollama", "three");
  assert.equal(gateway.getSelected()?.id, "three");
  assert.equal((await gateway.respond(request())).text, "ok");
  assert.equal(attempts.get("ollama"), 1);
});

test("route bias reorders eligible routes without overriding eligibility", () => {
  const candidates = [
    {
      // Cheapest, smallest, and first in the operator's preference order.
      model: model("groq", "small", {
        contextWindow: 8_000,
        inputCost: 0,
        outputCost: 0,
        totalParameters: 8_000_000_000,
      }),
      preference: 0,
    },
    {
      model: model("openrouter", "large", {
        contextWindow: 64_000,
        inputCost: 5,
        outputCost: 5,
        totalParameters: 32_000_000_000,
      }),
      preference: 1,
    },
    {
      model: model("groq", "no-tools", {
        tools: false,
        contextWindow: 128_000,
        totalParameters: 70_000_000_000,
      }),
      preference: 2,
    },
  ] as const;
  const base = {
    requiresTools: true,
    contextTokens: 100,
    estimatedOutputTokens: 50,
    now: 1_000,
  };

  // Balanced keeps the configured order.
  assert.equal(rankModelRoutes(candidates, base)[0]?.model.id, "small");

  // Capacity promotes the biggest model past the operator's preference, but
  // the tool-incapable one stays ineligible however large it is.
  const capacity = rankModelRoutes(candidates, { ...base, bias: "capacity" });
  assert.equal(capacity[0]?.model.id, "large");
  assert.equal(capacity[0]?.eligible, true);
  assert.equal(
    capacity.find((route) => route.model.id === "no-tools")?.eligible,
    false,
  );
  assert.match(capacity[0]?.reason ?? "", /capacity bias/);

  // Economy puts the free route first and says so.
  const economy = rankModelRoutes(candidates, { ...base, bias: "economy" });
  assert.equal(economy[0]?.model.id, "small");
  assert.match(economy[0]?.reason ?? "", /economy bias/);

  // A window floor rejects routes below it and explains why.
  const floored = rankModelRoutes(candidates, {
    ...base,
    minContextWindow: 32_000,
  });
  assert.equal(
    floored.find((route) => route.model.id === "small")?.eligible,
    false,
  );
  assert.match(
    floored.find((route) => route.model.id === "small")?.reason ?? "",
    /below the 32000 required/,
  );
});

test("stage route policies follow task complexity", () => {
  assert.equal(classifyTaskComplexity("fix the typo"), "simple");
  assert.equal(
    classifyTaskComplexity(
      "Add a retry to src/client.ts when the request times out.",
    ),
    "standard",
  );
  assert.equal(
    classifyTaskComplexity(
      "Refactor the auth layer across src/auth.ts, src/session.ts and src/api.ts, " +
        "then migrate every caller and keep backward compatibility.",
    ),
    "complex",
  );

  // Retrieval is mechanical at every complexity, so it always routes down.
  assert.equal(routePolicyForStage("retriever", "complex")?.bias, "economy");
  // Judgement never runs locally, and asks for headroom on a hard task.
  const verifier = routePolicyForStage("verifier", "complex");
  assert.deepEqual(verifier?.excludeProviders, ["ollama"]);
  assert.equal(verifier?.bias, "capacity");
  assert.equal(verifier?.minContextWindow, 32_000);
  // Planning a complex objective asks for the strongest route.
  assert.equal(routePolicyForStage("general", "complex")?.bias, "capacity");
  // A simple task routes every stage down, including the coder.
  assert.equal(routePolicyForStage("coding-agent", "simple")?.bias, "economy");
  // A standard coding task keeps the operator's configured order.
  assert.equal(routePolicyForStage("coding-agent", "standard"), undefined);
});
