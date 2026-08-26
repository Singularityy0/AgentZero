import {
  createDefaultProviderGateway,
  EnvironmentCredentialResolver,
} from "@agentic-runtime/gateway";

/**
 * Groq's free-tier catalog rotates without notice - models used in this
 * project's docs/config have already been pulled mid-competition once.
 * Run this before relying on a specific GROQ_MODEL id.
 */
async function main(): Promise<void> {
  const apiKey = process.env.GROQ_API_KEY;
  if (!apiKey) {
    console.error("Set GROQ_API_KEY before running this example.");
    process.exitCode = 1;
    return;
  }

  const gateway = createDefaultProviderGateway({
    credentials: new EnvironmentCredentialResolver(),
  });
  gateway.configure({ providerId: "groq", credentialRef: "GROQ_API_KEY" });
  const models = await gateway.discover("groq", true);

  console.log("Live Groq models for this API key:\n");
  for (const model of models.sort((a, b) => a.id.localeCompare(b.id))) {
    console.log(
      `${model.id.padEnd(36)} context=${model.contextWindow ?? "?"} tools=${model.capabilities.tools}`,
    );
  }
  console.log(
    "\nReminder: verify total parameter count separately (not exposed by " +
      "this API) - the PS caps every model at <=80B total parameters.",
  );
}

void main();
