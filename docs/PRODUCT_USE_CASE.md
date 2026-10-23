# CodexPro product use case and architecture contract

> Status: product intent and acceptance criteria. This is a specification for future cleanup work, **not** a claim that every concurrency guarantee is already implemented. See [README](../README.md) for installation and [FAQ](../FAQ.md) for current behavior.

## What CodexPro is

CodexPro is a local Model Context Protocol (MCP) tool server. It lets a normal ChatGPT conversation act as a coding agent against directories that the user explicitly allows on their own computer. ChatGPT performs the reasoning, task planning, and tool selection; CodexPro supplies bounded local capabilities such as repository inspection, file edits, Git operations, and build/test commands.

The user should not need a separate Codex application, an API-backed agent runner, or a special ChatGPT browser profile to use the core coding workflow. Optional VM, browser, delegated-agent, and handoff features must not become prerequisites for ordinary MCP file and development tools.

This is an alternative *workflow* to a standalone coding agent, not a way to unlock models, obtain unlimited inference, or circumvent ChatGPT usage, plan, and tool-access limits. The user can only use MCP actions on ChatGPT surfaces that actually support them.

## Primary scenario: multiple chats, one repository

1. The user runs **one** CodexPro MCP server and connects it to ChatGPT as a plugin/connector.
2. In **one browser session**, the user opens several ordinary ChatGPT conversations.
3. Each conversation receives a different development task and independently calls CodexPro's MCP tools.
4. All conversations can intentionally access the **same allowed repository and working directory** at the same time, including reading and editing source files.
5. The user sees their changes in the same actual filesystem and Git working tree, not one hidden copy per conversation.

For example:

| Chat | Assignment | Shared root |
| --- | --- | --- |
| A | Refactor the HTTP transport | `/path/to/repo` |
| B | Improve the test suite | `/path/to/repo` |
| C | Review the current diff and run checks | `/path/to/repo` |

Concurrent work in a shared tree is an intentional capability. It does **not** imply automatic conflict-free collaboration: file changes, the Git index, branch state, and development commands are shared resources.

**Do not model a browser session, browser tab, MCP transport session, or network fingerprint as a reliable identity for one ChatGPT conversation.** ChatGPT may reuse an MCP connection across conversations or reconnect it without preserving a one-to-one relationship.

## Core behavior and design requirements

### Tool interface

- Keep the core local coding tools simple, discoverable, and callable directly from normal tool-capable ChatGPT chats.
- Do not require users to supply a custom per-chat `client_id`, manually register agents, launch a second server for each chat, or manage a lease just to read or edit a shared workspace.
- Authenticate the connection to CodexPro separately from task/conversation identity. A token proves access; it does not identify a chat.
- Keep allowed filesystem roots and sensitive-path/command restrictions enforced regardless of how many conversations connect.
- Prefer operations whose complete target and parameters are explicit in the call. An operation handle is appropriate only when an actual long-running resource needs one.

### Shared workspace and state

- All authorized conversations should be able to address the same canonical workspace root; do not lock a repo to one chat.
- Do not rely on an implicit "currently selected workspace" when different conversations might change it. Where several roots exist, callers should pass an explicit workspace identifier or root when the operation needs one.
- Avoid hidden mutable per-chat context in the server. The conversation itself owns its instructions and reasoning; the repository and Git hold the shared project state.
- Long-running commands, browser sessions, VMs, and other optional resources may need explicit resource handles and clean lifecycles, but these do not justify mandatory client identities for basic filesystem/Git tools.

### Concurrent changes

- Multiple readers should work concurrently. Independent edits should proceed without a server-wide serial lock.
- Every writer should read/review the target first and, when available, pass the previously read `expected_sha256` to `write` or `edit`. A stale expectation should fail rather than silently overwrite another chat's newer change.
- Agents should split work by file or area when practical, re-read on conflict, and inspect `show_changes`/Git status before concluding.
- `apply_patch`, shell commands, and Git operations also need coordination: optimistic checks on one file do **not** protect an entire multi-file patch, the Git index, working tree, or commands with side effects.
- Separate Git worktrees can be useful for highly overlapping tasks, but they are **optional** and must not be imposed on ordinary shared-directory work.
- Do not promise transactional merges, transparent conflict resolution, or full isolation between conversations. Those are not properties of a shared filesystem.

## What is not part of the core product

CodexPro is **not** an inference service, model router, quota bypass, ChatGPT session manager, account pool, or a second autonomous reasoning engine. Its internal subagent framework, dedicated Chrome profile automation, VM subsystem, context-handoff tooling, and optional UI integrations are separate capabilities, not the definition of the product.

The ChatGPT-browser subagent backend and the VM subsystem are intentionally retained as useful optional features. Whether other optional capabilities should remain is a separate maintenance decision. Their existence is not a reason to introduce cross-cutting client identity, ownership, or orchestration requirements into the core file, search, Git, and command tools.

## Current implementation

- One MCP server exposes approved local roots to all authorized chats. No manually supplied or inferred per-conversation `client_id`, logical-client lease, or browser/network fingerprint is required.
- `Mcp-Session-Id` remains an ordinary protocol transport session identifier. It does not prove which ChatGPT tab or conversation issued a call.
- `open_workspace` returns a root-derived `workspace_id`. All workspace operations accept an explicit ID; omission always chooses the configured default root, never another chat's previously opened root.
- Safe file edits use file-level serialization and `expected_sha256` conflict checking. Git state, Bash side effects, and files are deliberately shared rather than silently isolated.
- `show_changes` returns actual changes by default. Suppression using `since: "last_shown"` is explicitly requested and scoped to the MCP transport, not to a guaranteed conversation identity.
- Browser sessions and optional delegated subagents remain supported. The ChatGPT-browser subagent backend uses its own dedicated persistent Chrome profile; workers have explicit agent IDs, and browser tool sessions have explicit session IDs.
- VM tools (`vm`, `vm_exec`, `vm_guest_status`, `vm_upload`, `vm_download`) remain supported and use isolated guest lifecycle state, independent of chat identity.
- Tests exercise two concurrent MCP transports without client IDs, shared roots, checksum-protected concurrent writes, subagents, browser coordination and VM lifecycle.
- Authentication, path restrictions, binary/secret protections and server-controlled write permissions remain in force.

## Acceptance scenarios for future refactoring

1. One configured server and one ChatGPT browser login; two or more conversations can call read/search/build tools against one allowed root without user-created IDs.
2. Two conversations can concurrently edit **different** files in the same repository and both changes remain visible.
3. Two conversations read the same file, one edits it, and the other submits `expected_sha256` from the old read: the second operation fails clearly and preserves the newer content.
4. A conversation opening a different allowed project cannot silently redirect another conversation's tool call to the wrong root; explicit workspace targets resolve ambiguity.
5. Concurrent Git and shell operations do not claim isolation they lack. Document shared index/branch/process side effects and surface errors instead of hiding conflicts.
6. Core operations work with optional browser, VM, subagent, and handoff systems disabled or absent.
7. Reconnects, transport reuse, and multiple tabs do not require custom per-conversation identity configuration.

These are the product-level invariants against which architectural cleanup should be evaluated. Favor **less state, fewer special cases, and fewer dependencies** over reimplementing a full multi-agent runtime inside the MCP server.
