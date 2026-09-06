<p align="center">
  <img src="docs/favicon.svg" width="72" height="72" alt="CodexPro logo">
</p>

<h1 align="center">CodexPro</h1>

<p align="center">
  Give ChatGPT local coding tools for repos you explicitly allow.
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/codexpro"><img alt="npm" src="https://img.shields.io/npm/v/codexpro?style=flat-square"></a>
  <a href="https://github.com/rebel0789/codexpro/actions"><img alt="CI" src="https://img.shields.io/github/actions/workflow/status/rebel0789/codexpro/ci.yml?branch=main&style=flat-square"></a>
  <a href="https://github.com/rebel0789/codexpro/blob/main/LICENSE"><img alt="License" src="https://img.shields.io/github/license/rebel0789/codexpro?style=flat-square"></a>
  <a href="https://rebel0789.github.io/codexpro/"><img alt="Website" src="https://img.shields.io/badge/site-GitHub%20Pages-67e8f9?style=flat-square"></a>
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
npm install -g codexpro
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

- Public tunnels require a CodexPro HTTP token (min 24 bytes)
- Writes stay hidden unless write mode is `workspace`
- Safe bash is the default
- Blocked paths cover `.env`, keys, `.git`, build caches, and similar
- Attachment import only accepts ChatGPT Apps SDK file objects from approved HTTPS hosts

Read [SECURITY.md](SECURITY.md) before exposing a tunnel.

## Update

```bash
npm install -g codexpro@latest
codexpro --version
```

Restart `codexpro start` after updating. Saved profiles under `~/.codexpro` stay in place.

## Agent harness features

CodexPro now resolves Codex-style repository instructions hierarchically from the repository root toward the target path. In each directory, `AGENTS.override.md` takes precedence over `AGENTS.md`, `agents.md`, and `.agents.md`. Context responses include an instruction fingerprint; send the previous fingerprint back to `codex_context` to avoid re-sending unchanged instruction bodies.

The `git` tool provides structured status, branch, log, show, blame, staging, commit, restore, branch switching, and CodexPro-owned worktree operations. It deliberately does not expose arbitrary Git arguments, force pushes, hard resets, force-cleaning, or forced branch deletion.

`CODEXPRO_BASH_MODE=safe` is a productive local command mode rather than a small command allowlist. Normal package managers, compilers, test runners, scripts, and command chains can run, while obviously catastrophic filesystem, disk, system, and destructive Git operations are rejected. `full` remains an explicit trusted-repository override. Commands run with bounded output, timeout handling, a controlled environment by default, and separate stdout/stderr results.

Browser automation is opt-in with `CODEXPRO_BROWSER_ENABLED=1`. It uses Playwright Chromium with one isolated browser context per CodexPro browser session, supports navigation, semantic snapshots, interaction, tabs, waits, and screenshots, and does not inherit credentials/cookies across sessions. Install the optional runtime before enabling it:

```bash
npm install playwright
npx playwright install chromium
```

DeepSeek subagents are also opt-in. Set the DeepSeek API credential environment variable named `DEEPSEEK_API_KEY`, optionally set `DEEPSEEK_MODEL`, and use full tool mode. If the key is absent, CodexPro does not register usable `subagent_*` tools and never falls back to another provider. Other controls are `CODEXPRO_SUBAGENTS_ENABLED`, `CODEXPRO_MAX_SUBAGENTS`, `CODEXPRO_MAX_AGENT_DEPTH`, and `CODEXPRO_WORKTREE_ROOT`.

Roles are `explorer`, `reviewer`, `tester`, and `implementer`. Only implementers receive an isolated Git worktree. Their returned unified diff is treated as untrusted, checked for disallowed/sensitive paths, validated with `git apply --check`, and applied only to that worktree; it is never automatically merged into the primary workspace. Repository content sent to DeepSeek is explicitly path-scoped and redacted, and obvious secret paths such as environment files, private keys, credential stores, and SSH/cloud credentials are excluded.

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

- [Website](https://rebel0789.github.io/codexpro/)
- [FAQ](FAQ.md)
- [Security](SECURITY.md)
- [Stable URL guide](DOMAIN_SETUP.md)
- [Changelog](CHANGELOG.md)
- [Contributors](CONTRIBUTORS.md)
