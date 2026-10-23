# Contributing

CodexPro is early. Good contributions make it safer, faster, and easier to explain. Start with the [product use case and architecture contract](docs/PRODUCT_USE_CASE.md). The goal is ordinary ChatGPT conversations acting as concurrent coding agents against the **same allowed working directory**, using **one** MCP server and browser session. ChatGPT owns the reasoning; CodexPro exposes tools.

## Local Setup

```bash
npm install
npm run build
npm run smoke
```

Run a local connector:

```bash
npm run connect:local -- --root /path/to/test/repo
```

Run through a Cloudflare quick tunnel:

```bash
npm run connect -- --root /path/to/test/repo --bash safe --write handoff
```

## Architecture and concurrency review

- Preserve concurrent read/write access by multiple ChatGPT chats to the same repository; do not force a distinct server, browser, worktree, or manually configured client ID per chat.
- Keep authentication, transport-session routing, workspace targeting, and operation ownership separate. Do not assume one MCP connection is one chat.
- Prefer explicit workspace and operation identifiers where needed rather than hidden per-client mutable selection.
- Handle stale edits with optimistic SHA-256 checks and useful conflict errors. Concurrent Git/index/branch and shell changes still need explicit coordination.
- Prefer deleting dead code and unnecessary wrappers to adding speculative managers, registries, or agent infrastructure. Treat optional browser, VM, subagent, and handoff features as independent from the core MCP file/Git/shell tools.
- Test the multi-chat acceptance scenarios in [docs/PRODUCT_USE_CASE.md](docs/PRODUCT_USE_CASE.md) when changing workspace, HTTP, runtime, or concurrency behavior.

## Useful Areas

- safer tool defaults
- better setup diagnostics
- stable tunnel setup helpers
- smaller/faster context bundles
- clearer ChatGPT tool prompts
- better Apps SDK widgets
- tests for path guards and auth boundaries
- docs that reduce user setup mistakes

## Pull Request Checklist

- Keep the change scoped.
- Do not include local tunnel URLs, auth tokens, `.env` values, or private paths.
- Run `npm run build`.
- Run `npm run smoke`.
- Update `README.md` or `CHANGELOG.md` when behavior changes.
- Explain security impact for changes touching auth, file access, shell execution, or tunnels.

## Docs Style

- Be concrete.
- Avoid hype.
- Name the exact command, mode, flag, and failure case.
- Make risk boundaries clear.
- Prefer examples that use `/path/to/repo` and `codexpro.example.com`, not local machine paths.
