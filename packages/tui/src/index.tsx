#!/usr/bin/env node

import { render } from "ink";
import React from "react";
import { config } from "dotenv";
import { join } from "node:path";
import { App } from "./app.js";
import { resolveWorkspaceRoot } from "./workspace.js";

const workspaceRoot = resolveWorkspaceRoot(process.argv.slice(2));
config({ path: process.env.ENV_FILE ?? join(workspaceRoot, ".env") });
render(<App workspaceRoot={workspaceRoot} />, {
  isScreenReaderEnabled: !process.stdin.isTTY,
});
