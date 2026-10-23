# AGENTS.md example for a repository connected through CodexPro

CodexPro is a local MCP tool server. Ordinary ChatGPT conversations act as coding agents using this same allowed repository; the server does not do their reasoning.

Several chats in one browser may work concurrently in **this exact working directory**. This is intentional. The filesystem, Git index, and branch are shared; a conversation is not guaranteed a private MCP session or server-side identity.

## Instructions for ChatGPT coding agents

- Inspect the relevant files and Git status before changing code. Respect the user's requested scope.
- Work directly with CodexPro `read`, `search`, `write`/`edit`, `bash`, `git`, and `show_changes` tools when allowed.
- When possible, pass the `sha256` returned by a file read as `expected_sha256` for edits/writes. If the file has changed, re-read and resolve the conflict before trying again.
- Treat another conversation's unstaged changes as intentional. Do not overwrite, restore, stage, or commit unrelated work.
- Coordinate overlapping modifications, Git operations, and shell commands; an optimistic file checksum does not protect an entire working tree.
- Do not assume a per-chat `client_id`, separate browser, private worktree, or separately launched CodexPro server is required.
- Use explicit workspace targeting if multiple repository roots are allowed.
- Run focused verification and report changed files, tests, and potential conflicts.

## Optional planning-only workflow

If the user explicitly requests a handoff to a separate executor, write a reviewable plan under `.ai-bridge/current-plan.md` instead of making direct changes. The executor should work in small steps, record status and tests, and preserve concurrent work by other agents.

See CodexPro's `docs/PRODUCT_USE_CASE.md` for the full product contract.
