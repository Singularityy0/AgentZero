# Agent Zero Workbench

React, Tailwind, and Monaco browser client for the agentic runtime workspace.
The UI is served by `@agentic-runtime/gui-server` on loopback and never imports
Node-only runtime packages.

Implemented browser surfaces:

- workspace explorer and ripgrep-backed search;
- read-only Monaco tabs;
- provider credential configuration and validation;
- durable project sessions and bounded manual file context;
- persisted task and trace discovery with node-level payload inspection;
- live agent chat over SSE with task cancellation and approval decisions.

The standalone terminal panel is not implemented. Shell-backed agent tools are
available through the runtime and remain explicitly approval-gated.

Run the complete browser app from the repository root with `pnpm settings`.
