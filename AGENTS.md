# Agent Instructions

Read `agent-context/WORKSPACE.md` and `agent-context/ARCHITECTURE.md` before
making changes. Use `agent-context/WORKLOG.md` for a concise history of setup
and important decisions.

## Working Rules

- Keep the workspace minimal and dependency-light.
- Preserve the package boundaries under `packages/`.
- Run `pnpm build`, `pnpm lint`, and `pnpm format:check` after configuration or
  code changes when practical.
- Update the context files when the architecture, commands, or project status
  materially changes.
- Do not commit secrets, generated `dist/` output, or `node_modules/`.

## Current Scope

The workspace now includes modular OpenAI and Ollama response providers,
interactive TUI, framework-neutral core tool contracts, an agent loop, separate
IDE tools, and SQLite-backed session persistence. Language-specific
intelligence, image analysis, additional providers, and Rust components have
not been implemented yet.
