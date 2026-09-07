# LMO research feedback: investigation and changes

The report is a workflow account, without transport traces or the server version used. The mechanisms below are verified in this checkout; they explain plausible failures but do not prove the cause of that particular session.

| Report items | Finding and disposition |
| --- | --- |
| 1–2: workspace drift and reconnect | Roots already have deterministic IDs and filesystem operations use PathGuard. HTTP sessions each create a new workspace manager; previously only configured allowed-root IDs could be recovered, losing nested project IDs. The HTTP server now remembers opened root mappings across MCP sessions. Selection remains session-local. `reconnect_workspace` validates and selects the original ID; supply `root` too after a process restart. |
| 2–3: availability and discovery | Tools are registered when the MCP server is created; opening a workspace does not unregister them. Host-side tool visibility cannot be repaired here without evidence of a transport fault. The existing `codexpro` action `list_actions` lists enabled operations. Reconnect returns available actions and workspace availability. Mutating commands are deliberately not retried automatically because an uncertain response may follow a successful write. |
| 4: large shell output | Previously reaching the response cap terminated the process. MCP shell calls now capture up to 2 MB independently of the response preview, retain four redacted results per session, and expose `read_output` pages. A capture-limit termination or timeout is explicit, so retained output is never described as complete in those cases. Outputs expire on session loss. |
| 5, 13: PowerShell noise and encoding | PowerShell already configures UTF-8 output and streams use incremental UTF-8 decoding. Progress is now suppressed before executing commands and Python receives `PYTHONUTF8=1`. Native tools choosing another encoding can still produce mojibake; arbitrary stderr/CLIXML errors are preserved rather than discarded. |
| 6, 9: source reading and search | `read` already supports line ranges, line counts and SHA-256. `search` already returns path/line records. Added `case_sensitive`, `context_before` and `context_after` for lexical results. Removed ripgrep's hidden 50-match-per-file limit, which could silently omit hits. Context is bounded to 30 lines either side for the first 20 results; failures and omissions are explicit. |
| 7: symbols and call graphs | Existing `inspect_workspace` and structured `search` provide heuristic definitions/references and relationships, including Java. They are not compiler/LSP-accurate; Kotlin and Android IPC resolution remain separate work. |
| 8, 14–18: Android, environment probes, binaries and archives | These are useful integrations, not demonstrated failures in current filesystem tools. No APK tools or extraction subsystem is added in this change. Python package compatibility and ZIP case collisions originate in the invoked tools/platform. A future archive tool needs traversal, collision, decompression-size and duplicate-entry tests. |
| 10, 20: excerpts and journal | Existing line reads and guarded writes can capture evidence and maintain a journal. Dedicated multi-range excerpt capture and journal schemas remain future workflow additions. |
| 11: persistent shells | `session_id` is a server targeting guard, not a persistent process. Shell calls remain independent. A persistent-shell lifecycle is not introduced as a side effect of reliability fixes. |
| 12: downloadable artifacts | `export_pro_context` already exports local context. A local path does not create a ChatGPT attachment; a supported host export bridge would be required. |
| 19: generated-file reviews | Analysis already classifies some generated paths and excludes them from symbol extraction. User-defined meaningful-review profiles and JADX-specific classification are not added here. |

## Usage

Keep the `workspace_id` returned by `open_workspace` on subsequent calls. After the MCP client reinitializes, call `reconnect_workspace` with that ID. If the server process restarted, also supply the original absolute `root`. This validates the root against the current allowed roots and rejects mismatched IDs. It cannot reconnect a host connector that cannot invoke tools at all.

Every MCP `bash` response now includes `effective_cwd`, `termination_reason`, and `output_resource_id`. The working directory is checked against the workspace before launch; this is not an OS sandbox preventing a command from changing directory internally.

Use `read_output` with the same workspace ID and output ID, select `stdout` or `stderr`, and follow `next_offset` until null. Pages use character offsets rather than lines, so even a single enormous source line can be retrieved. Capture is bounded at 2 MB per command; the last four command results are retained only in that MCP session. `incomplete=true` means a timeout or capture limit interrupted execution. A nonzero exit code is reported separately by `bash`.

Use `search(query="needle", case_sensitive=false, context_before=5, context_after=10)` to obtain numbered excerpts beside lexical matches. Structured analysis remains a separate heuristic search and does not inherit the lexical case option.

## Verification

`scripts/research-smoke.mjs` checks nested workspace recovery, process-restart recovery with root validation, selection isolation, cwd escape rejection, Unicode output pagination through a final marker, output expiry/session isolation, search context, more than 50 matches in one file, and Windows progress suppression. `scripts/http-smoke.mjs` also covers nested workspace recovery through real HTTP MCP sessions. Existing platform checks cover process-tree termination and timeouts.
