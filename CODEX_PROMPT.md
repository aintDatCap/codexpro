This prompt is for an **optional external executor**, not the normal CodexPro workflow. In the primary workflow several ordinary ChatGPT conversations directly use one CodexPro MCP server to work in the same repository (see [docs/PRODUCT_USE_CASE.md](docs/PRODUCT_USE_CASE.md)).

When explicitly handed a plan, read .ai-bridge/current-plan.md and execute it in small, reviewable steps. Preserve concurrent edits by other coding chats; inspect shared Git status first, and never stage/restore/commit unrelated work.

After each meaningful change, update .ai-bridge/agent-status.md with:

- what changed
- files touched
- tests, lint, or typecheck commands run
- results
- blockers or questions
- what ChatGPT or another reviewer should review next

Keep .ai-bridge/decisions.md aligned with implementation choices. Do not overwrite .ai-bridge/current-plan.md unless explicitly asked. Re-read changed files when optimistic write checks fail.
