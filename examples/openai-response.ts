import { generateOpenAIResponse } from "@agentic-runtime/openai";

const apiKey = process.env.OPENAI_API_KEY;
const prompt = process.argv.slice(2).join(" ") || "Say hello in one sentence.";

async function main(): Promise<void> {
  if (!apiKey) {
    console.error("Set OPENAI_API_KEY before running this example.");
    process.exitCode = 1;
    return;
  }

  try {
    const response = await generateOpenAIResponse(prompt, {
      apiKey,
      model: process.env.OPENAI_MODEL,
    });
    console.log(response);
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  }
}

void main();
