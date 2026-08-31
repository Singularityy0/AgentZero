import { startSettingsServer } from "./index.js";

const projectRoot = process.env.AGENTIC_PROJECT_ROOT ?? process.cwd();
const port = process.env.AGENTIC_GUI_PORT
  ? Number(process.env.AGENTIC_GUI_PORT)
  : undefined;

const server = startSettingsServer({ projectRoot, port });
try {
  await server.ready;
  console.log(`Settings/GUI server listening on ${server.url}`);
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`Could not start the GUI server: ${message}`);
  process.exitCode = 1;
}

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    void server.close().then(() => process.exit(0));
  });
}
