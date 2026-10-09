<p align="center">
  <img src="docs/favicon.svg" width="72" height="72" alt="CodexPro logo">
</p>

<h1 align="center">CodexPro</h1>

<p align="center">
  Give ChatGPT local coding tools for repos you explicitly allow.
</p>

<p align="center">
  <a href="https://github.com/aintDatCap/codexpro/actions"><img alt="CI" src="https://img.shields.io/github/actions/workflow/status/aintDatCap/codexpro/ci.yml?branch=main&style=flat-square"></a>
  <a href="https://github.com/aintDatCap/codexpro/blob/main/LICENSE"><img alt="License" src="https://img.shields.io/github/license/aintDatCap/codexpro?style=flat-square"></a>
  <a href="https://github.com/aintDatCap/codexpro"><img alt="Source" src="https://img.shields.io/badge/source-GitHub-67e8f9?style=flat-square"></a>
</p>

## What it is

CodexPro is a local MCP server. It connects **your ChatGPT session** to **your machine** and **repos you allow**.

ChatGPT can read, search, edit, review, verify, import attachments, and write handoff plans. It stays inside those roots.

It is not a hosted SaaS product, model proxy, quota bypass, account pool, or remote shell service.

## Install

Needs:

- Node.js 20+
- A ChatGPT account that can create custom MCP plugins
- An HTTPS URL to your machine for ChatGPT web (tunnel or Tailscale Funnel)

```bash
git clone https://github.com/aintDatCap/codexpro.git
cd codexpro
npm install
npm run build
npm link

cd /path/to/your/repo
codexpro setup
```

## Connect in ChatGPT

1. `Settings -> Security and login` → turn **Developer mode** on (keep CSP enforcement on).
2. `Settings -> Plugins` → Plugins tab → **+** beside Search plugins.
3. Create a plugin named `CodexPro`.
4. Connection: **Server URL** → paste the URL CodexPro copied.
5. Authentication: **No Authentication / None** (change this if the form defaults to OAuth).

CodexPro auth is the token already in that URL. Do not share the URL.

| Open Plugins and click `+` | Complete the New Plugin form |
| --- | --- |
| ![Open Plugins and click the plus button](docs/images/chatgpt-plugins-add.png) | ![Complete the New Plugin form](docs/images/chatgpt-plugin-details.png) |

Daily use from the same repo:

```bash
codexpro start
```

If plugin creation fails, run `codexpro connection-test` and check whether ChatGPT requests reach the local server.

## What ChatGPT can do

With workspace write mode (the normal agent setup):

- read, search, and inspect the repo
- edit with `write`, `edit`, or guarded `apply_patch`
- import ChatGPT attachments with `import_file`
- run allowlisted checks with `bash`
- review diffs with `show_changes`
- write plans under `.ai-bridge`
- export a context bundle for chats that cannot call tools

## Added in this fork

- Disposable VMs: Hyper-V on Windows, QEMU/KVM on Linux, QEMU/HVF on macOS.
- Windows ISO detection, Secure Boot + vTPM, and optional unattended Windows setup with a local account and reduced OOBE/privacy prompts.
- Backend-neutral guest tools: `vm_guest_status`, `vm_exec`, `vm_upload`, and `vm_download`.
- Experimental ChatGPT-browser subagents using a dedicated visible Chrome profile attached over CDP.
- Logical client IDs, renewable leases, reconnect-safe runtime ownership, and correlated runtime/tool logging.

See [VM runtimes](docs/vm.md) and [VM usage for AI agents](docs/vm-ai-usage.md) for the guest workflow.

## Windows and WSL

CodexPro runs with Node.js 20+ on native Windows or inside a WSL Linux distribution. Native Windows commands use Windows PowerShell by default; Linux, macOS, and servers launched inside WSL use Bash. The MCP tool keeps its `bash` name and accepts `shell` and `cwd`:

```json
{"command":"npm run build","cwd":"packages/web","shell":"powershell"}
```

Use `shell: "cmd"` for cmd syntax (including `&&`), `shell: "bash"` for an installed Bash, or `shell: "wsl"` to execute Linux commands from a Windows server. PowerShell runs without profiles and uses a process-scoped execution-policy override so npm's PowerShell shims can run. No machine policy is changed.

```powershell
codexpro start --shell powershell
codexpro start --shell wsl --wsl-distribution Ubuntu
codexpro settings set --shell wsl --wsl-distribution Ubuntu
```

The equivalent environment variables are `CODEXPRO_SHELL` and `CODEXPRO_WSL_DISTRIBUTION`. WSL execution needs a distribution with Bash installed; choose it explicitly if your default is Docker Desktop. Working directories are passed to `wsl.exe --cd` without shell interpolation. For Linux projects, you can also install Node.js and CodexPro inside WSL and run `codexpro start` there using Linux paths. Windows and WSL installations keep their own home-directory settings.

CLI commands launched from a subdirectory discover the Git repository root and reuse its saved settings. A nearer saved project takes precedence. Explicit `--root` or `CODEXPRO_ROOT` keeps that directory as the workspace. MCP command `cwd` is relative to the selected workspace, must exist, and cannot escape through traversal or symlinks.

## Multiple projects

One CodexPro process can allow more than one repo:

```bash
codexpro settings set --project ~/code/web --project ~/code/api
codexpro settings show
codexpro start
```

Ask ChatGPT to `open_workspace` on an allowed project. `open_current_workspace` returns to the launch repo.

For two ChatGPT accounts or hard isolation, run two CodexPro processes on different ports and Server URLs.

## Logical clients, reconnects, and leases

MCP transport sessions are not application identity. A logical caller should use one stable `client_id` across reconnects so workspace selection, output retention, browser ownership, subagents, cancellation, and scheduler state remain attached to that caller instead of to an HTTP/SSE connection.

HTTP clients should send `CodexPro-Client-Id: <stable-id>` (the compatibility query parameter `client_id=<stable-id>` is also accepted). CodexPro returns `CodexPro-Client-Id` and `CodexPro-Lease-Id` response headers. Stdio callers can set `CODEXPRO_CLIENT_ID`. The MCP `Mcp-Session-Id` is used only for protocol routing, diagnostics, and tracing.

Clients that do not yet provide an HTTP client ID receive a deterministic legacy fingerprint derived from MCP client metadata, User-Agent, and remote address. That fallback is migration-only: two callers with identical metadata/network identity can collide, and the fingerprint can change when that metadata or network path changes. Explicit stable IDs are the supported way to distinguish logical callers.

Logical clients hold renewable leases. Activity renews the lease; an MCP/network disconnect does not release it. `shutdown_client` performs explicit cleanup, while lease expiry deterministically cleans owned agents, browser sessions/pages, worktrees, and cancellation state. `CODEXPRO_CLIENT_LEASE_TTL_MS` controls logical-client lease lifetime (default one hour). This is separate from `CODEXPRO_HTTP_SESSION_TTL_MS`, which only bounds stale transport retention.

## Commands

```bash
codexpro setup
codexpro start
codexpro start --root /path/to/repo
codexpro doctor
codexpro connection-test
codexpro settings
codexpro inspect
codexpro review
codexpro vm doctor
codexpro vm setup
codexpro vm images
codexpro vm list
```

Useful modes:

```bash
codexpro start --no-bash
codexpro start --tool-mode minimal
codexpro start --tool-mode full
codexpro start --mode handoff
codexpro start --mode pro
codexpro start --headless
```

Opt-in tool cards:

```bash
CODEXPRO_TOOL_CARDS=1 codexpro start
```

## Public HTTPS options

ChatGPT web needs HTTPS:

```bash
codexpro start --tunnel cloudflare          # quick demo URL (changes)
codexpro ngrok --hostname your.ngrok-free.dev
codexpro stable --hostname codexpro.example.com --tunnel-name codexpro
codexpro tailscale --hostname your-device.your-tailnet.ts.net
codexpro start --tunnel none                # local only
```

Keep a stable token for stable hostnames:

```bash
mkdir -p ~/.codexpro
openssl rand -hex 32 > ~/.codexpro/http-token
chmod 600 ~/.codexpro/http-token
```

Prefer `Authorization: Bearer <token>` when the client supports headers. The `?codexpro_token=` query form is a personal compatibility fallback.

## Safety defaults

Tool results are bounded before reaching ChatGPT's subcall inspector, whether tool cards are enabled or disabled. Structured previews allow at most 200 items per array, 2,000 nodes, eight nesting levels, and a 64 KiB budget; text output has a 120,000-byte budget. Limited responses include `output_limited` and a retrieval hint. Use narrower paths, fewer results, or `read` line ranges to retrieve omitted data. These display limits do not change files or stop an operation that has already completed.

- Public tunnels require a CodexPro HTTP token (min 24 bytes)
- Writes stay hidden unless write mode is `workspace`
- Safe bash is the default
- Blocked paths cover `.env`, keys, `.git`, build caches, and similar
- Attachment import only accepts ChatGPT Apps SDK file objects from approved HTTPS hosts
- Host file/bash tools remain a local developer bridge, not an OS sandbox.
- Optional VM runtimes (Windows Hyper-V, Linux QEMU/KVM, macOS QEMU/HVF) provide separate disposable guest environments with immutable bases and per-instance overlays.
- Backend-neutral guest tools provide bounded exec/upload/download/status operations through ownership-verified PowerShell Direct on Hyper-V or QEMU Guest Agent on QEMU; agents do not select raw backend commands.
- VM isolation improves the testing boundary but does not make arbitrary code universally safe.

Read [SECURITY.md](SECURITY.md) before exposing a tunnel.

## Update

```bash
cd /path/to/codexpro
git pull --ff-only
npm install
npm run build
```

`npm link` only needs to be repeated if the link was removed. Restart `codexpro start` after updating; saved profiles under `~/.codexpro` stay in place.

## Agent harness features

CodexPro now resolves Codex-style repository instructions hierarchically from the repository root toward the target path. In each directory, `AGENTS.override.md` takes precedence over `AGENTS.md`, `agents.md`, and `.agents.md`. Context responses include an instruction fingerprint; send the previous fingerprint back to `codex_context` to avoid re-sending unchanged instruction bodies.

The `git` tool provides structured status, branch, log, show, blame, staging, commit, restore, branch switching, and CodexPro-owned worktree operations. It deliberately does not expose arbitrary Git arguments, force pushes, hard resets, force-cleaning, or forced branch deletion.

`CODEXPRO_BASH_MODE=safe` is a productive local command mode rather than a small command allowlist. Normal package managers, compilers, test runners, scripts, and command chains can run, while obviously catastrophic filesystem, disk, system, and destructive Git operations are rejected. `full` remains an explicit trusted-repository override. Commands run with bounded output, timeout handling, a controlled environment by default, and separate stdout/stderr results.

Browser automation is opt-in with `CODEXPRO_BROWSER_ENABLED=1`. When enabled it is available in standard tool mode. It uses Playwright Chromium with one isolated browser context per CodexPro browser session, supports navigation, semantic snapshots, interaction, tabs, waits, and screenshots, and does not inherit credentials/cookies across sessions. Screenshot actions both save the image inside the allowed workspace and return native MCP image content so the AI can inspect the rendered page directly. Install the optional runtime before enabling it:

```bash
npm install playwright
npx playwright install chromium
```

When enabled, ChatGPT can call `browser_preview` with `url: "http://localhost:5174/home"` to open a local development page in CodexPro's Playwright Chromium and receive its rendered screenshot as a native MCP image in one call. This also works with public HTTP(S) sites reachable from the CodexPro host. The tool defaults to a 1280x800 viewport, waits 500 ms after DOM loading, captures the full page, saves the image under `.ai-bridge/`, and closes its temporary browser session afterward. Options include `viewport_width`, `viewport_height`, `wait_for_selector`, `wait_ms`, `full_page`, and `output_path`. For click/scroll/navigation before another screenshot, use the persistent `browser` tool. No public tunnel is required for your Vite/localhost site; only the authenticated CodexPro MCP endpoint needs to be reachable by ChatGPT. Restart CodexPro after enabling the feature so ChatGPT can discover the tools.

Example MCP arguments:

```json
{ "url": "http://localhost:5174/home", "viewport_width": 390, "viewport_height": 844, "full_page": true }
```

Subagents are provider-independent and are available in standard and full tool modes. The default provider is `chatgpt-browser`; set `CODEXPRO_SUBAGENT_PROVIDER=off` or `CODEXPRO_SUBAGENTS_ENABLED=0` to opt out. Select `CODEXPRO_SUBAGENT_PROVIDER=chatgpt-browser`, `deepseek`, or `off`. The experimental `chatgpt-browser` provider launches the user's installed Google Chrome (or Chromium fallback) as a normal visible process with a dedicated CodexPro profile, then attaches Playwright to that already-running browser over a loopback-only Chrome DevTools Protocol endpoint. It does not use `chromium.launch()` or `launchPersistentContext()` for this provider. Each worker gets its own ChatGPT tab inside the shared attached Chrome context. The user signs into that profile manually; CodexPro does not ask for, read, copy, or store ChatGPT passwords, cookies, session tokens, or API keys. This provider does not use OpenAI API inference or Codex inference and does not require `OPENAI_API_KEY` or `DEEPSEEK_API_KEY`. The dedicated ChatGPT browser auto-starts by default; set `CODEXPRO_CHATGPT_BROWSER_AUTO_START=0` to opt out, and the interactive terminal key `b` opens or focuses the dedicated ChatGPT browser manually.

The dedicated Chrome profile persists under CodexPro's data directory (by default `~/.codexpro/chatgpt-browser`) so the user's normal manual sign-in can survive restarts, and that profile path is blocked from CodexPro workspace file tools. Chrome discovery prefers Google Chrome in normal platform locations and falls back to Chromium names on Linux; set `CODEXPRO_CHROME_PATH` when automatic discovery is unsuitable (`CODEXPRO_CHATGPT_BROWSER_EXECUTABLE` remains accepted for compatibility). Chrome selects an ephemeral debugging port and CodexPro attaches only through `127.0.0.1`. Login challenges, CAPTCHA/bot checks, account restrictions, or other manual-interaction states are surfaced to the user and are never bypassed. Because this adapter depends on the ChatGPT web UI, selectors may require maintenance when that UI changes. Normal ChatGPT account limits still apply; CodexPro does not claim or create unlimited usage.

ChatGPT browser subagent startup is coordinated: new worker tabs are initialized one at a time (existing workers still run concurrently), with a fixed minimum interval of 400 ms between starts by default. Adjust with `CODEXPRO_CHATGPT_BROWSER_START_INTERVAL_MS=0..5000` (0 disables spacing; no randomized or fingerprint-changing behavior is introduced).

If the visible ChatGPT tab requires Cloudflare Turnstile, another browser verification, or sign-in, CodexPro **does not solve or bypass it**. Instead, the subagent enters `waiting` and preserves the interrupted task. Open the dedicated Chrome window (press `b` in the CodexPro terminal), complete the verification manually, then call `subagent_resume` with `{"id":"agent-...","manual_check_completed":true}` after confirming completion. `subagent_status` exposes the waiting state; `subagent_browser_diagnostics` (with the same agent ID) exposes bounded queue/check counters and the check type without passwords, tokens, cookies, page contents, or other clients' agent IDs. Prompts interrupted **after submission** are resumed without automatically submitting them a second time. If the check is still pending, the worker returns to `waiting`.

For UI testing, the generic Playwright `browser` tool also supports `action: "move_mouse"`, `session_id`, `x`, `y`, and `steps` (2–40). This uses a deterministic smoothstep trajectory for testing hover states, not anti-bot disguise, and it does not manipulate the ChatGPT worker tabs.

DeepSeek remains available as an optional provider. Select `CODEXPRO_SUBAGENT_PROVIDER=deepseek` and configure the DeepSeek API credential plus optional `DEEPSEEK_MODEL`; lack of a DeepSeek key does not disable `chatgpt-browser`. Other controls include `CODEXPRO_SUBAGENTS_ENABLED`, `CODEXPRO_MAX_SUBAGENTS`, `CODEXPRO_MAX_AGENT_DEPTH`, and `CODEXPRO_WORKTREE_ROOT`. Browser-backed workers run asynchronously: `subagent_spawn` returns a running agent promptly, while `subagent_status`, `subagent_result`, `subagent_message`, and `subagent_cancel` operate on the same persistent worker session/conversation.

Roles are `explorer`, `reviewer`, `tester`, and `implementer`. Only implementers receive an isolated Git worktree. Their returned unified diff is treated as untrusted, checked for disallowed/sensitive paths, validated with `git apply --check`, and applied only to that worktree; it is never automatically merged into the primary workspace. Repository content delegated to any subagent provider is explicitly path-scoped and redacted, and obvious secret paths such as environment files, private keys, credential stores, and SSH/cloud credentials are excluded.

Example delegated investigations:

```text
subagent_spawn({
  role: "explorer",
  task: "Investigate why HTTP/2 upstream negotiation is failing.",
  paths: ["src/upstream.rs"]
})

subagent_spawn({
  role: "implementer",
  task: "Fix the parser regression and return a unified diff plus tests to verify.",
  paths: ["src/parser.ts", "test/parser.test.ts"]
})
```

Subagent output is evidence-oriented working material, not authority. The parent agent should independently inspect source, Git state/diffs, test output, and browser evidence before accepting a result.

## Development

```bash
npm install
npm test
npm run build
npm run smoke
npm run stress
npm run release:check
```

Publish only from the CodexPro root:

```bash
cd /path/to/codexpro
npm run release:publish
```

## Docs

- [Repository](https://github.com/aintDatCap/codexpro)
- [FAQ](FAQ.md)
- [Research workflow feedback, fixes, and output paging](docs/research-feedback.md)
- [VM runtimes](docs/vm.md)
- [VM usage for AI agents](docs/vm-ai-usage.md)
- [Security](SECURITY.md)
- [Stable URL guide](DOMAIN_SETUP.md)
- [Changelog](CHANGELOG.md)
- [Contributors](CONTRIBUTORS.md)
