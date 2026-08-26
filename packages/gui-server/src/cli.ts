import { startSettingsServer } from "./index.js";

const projectRoot = process.env.AGENTIC_PROJECT_ROOT ?? process.cwd();
const port = process.env.AGENTIC_GUI_PORT
  ? Number(process.env.AGENTIC_GUI_PORT)
  : undefined;

const server = startSettingsServer({ projectRoot, port });
console.log(`Settings/GUI server listening on ${server.url}`);

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    void server.close().then(() => process.exit(0));
  });
}
