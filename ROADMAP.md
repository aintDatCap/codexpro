# CodexPro Roadmap

CodexPro aims to be a simple, reliable local MCP bridge through which **multiple ordinary ChatGPT conversations in one browser** can work concurrently in **the same allowed repository and working directory**. ChatGPT is the coding agent; CodexPro is the tool server. See [product use case and architecture contract](docs/PRODUCT_USE_CASE.md). The roadmap favors removing complexity over adding broad machine control.

## First priority: simplify the shared-workspace coding workflow

- Remove unnecessary coupling between HTTP/session/client identity, workspace targeting, and core file/Git/shell operations.
- Keep ordinary ChatGPT multi-chat access functional without mandatory custom `client_id` configuration or separate CodexPro processes.
- Establish concurrency tests for independent reads/writes, stale `expected_sha256` conflicts, explicit workspace targeting, and Git/index side effects.
- Audit and delete unnecessary managers, compatibility layers, and optional features with poor value-to-complexity ratios, without weakening security checks.
- Preserve the key distinction: shared repository files are intentional; hidden cross-chat state contamination is not.

## Next: release confidence

- Keep package metadata as the single source of truth for every runtime version report.
- Install each packed release into a clean temporary project and test all public command entrypoints.
- Run the full build, smoke, stress, package-install, and dependency-audit gates on Node.js 20 and 24 across Linux and Windows.
- Keep public package contents and release provenance easy to inspect.

## Next: deeper code navigation

- Add exact symbol lookup and context retrieval without expanding raw output volume.
- Improve references, call relationships, and change-impact confidence language by language.
- Publish repeatable accuracy, latency, memory, and token-volume benchmarks on representative repositories.
- Keep lexical fallback and explicit partial-coverage reporting for unsupported or oversized projects.

## Next: durable work sessions

- Add managed background commands with bounded, paginated output and explicit stop controls.
- Produce a redacted support report that users can attach to issues without exposing tokens, home paths, or repository contents.
- Improve reconnect and resume diagnostics for long-running ChatGPT sessions and tunnel changes.
- Keep command execution scoped to allowed workspaces and retain auditable receipts for handoffs.

## Later: optional user interface

- Explore a local dashboard for connection health, active workspaces, running jobs, diffs, and handoff status.
- Keep the command-line and MCP server fully usable without a desktop application.
- Treat computer control and broad operating-system automation as separate, opt-in capabilities with stronger foreground-app, executable-integrity, and permission checks.

## Non-goals

- Model or account proxying
- Quota or safety-system bypasses
- Unrestricted remote shell access
- Claims of compiler- or language-server-level certainty from heuristic analysis
- Silent access outside user-approved workspace roots

Roadmap items are priorities, not release-date promises. Open focused proposals through [GitHub Issues](https://github.com/aintDatCap/codexpro/issues).
