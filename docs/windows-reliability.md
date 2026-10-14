# CodexPro reliability on Windows

A minimized terminal does **not** normally suspend Node.js or the local MCP server. A real Windows sleep state (for example S3) **does** pause the entire machine, including CodexPro and its tunnel. No local desktop application can continue serving MCP requests while the computer is truly asleep.

## Keep CodexPro available during automatic idle sleep

On Windows, start CodexPro with:

```powershell
codexpro start --keep-awake
```

Alternatively, set `CODEXPRO_KEEP_AWAKE=1` in the launcher's environment. The `--no-keep-awake` argument overrides a saved setting or environment value. The option is disabled by default to respect battery and power preferences. It requests `ES_SYSTEM_REQUIRED | ES_CONTINUOUS` using a dedicated PowerShell process, following Microsoft's documented Windows execution-state API. It does **not** force the screen to stay on, change system power-plan settings, require elevation, or block explicit sleep/lid-close actions. The request ends when the launcher exits (also if its input pipe closes after a parent crash).

Leave the terminal running, or start with `--headless --keep-awake` in a separately managed terminal or supervisor. Neither `--headless` nor minimizing the window installs a Windows service or survives logout/reboot. For unattended operation, arrange a normal startup/supervisor with your Windows account, and prefer a stable tunnel hostname over Cloudflare quick tunnels.

## Recovery after sleep or unexpected process exit

The HTTP and logical-client session timers now tolerate long event-loop pauses; normally elapsed idle time still expires unused sessions. The launcher also watches its HTTP server and tunnel processes while in interactive mode, closes sibling processes and clears the runtime record if one exits unexpectedly, and reports why CodexPro stopped instead of leaving an inert control panel.

A network outage, external tunnel-provider failure, forced logout/reboot, or a manually initiated sleep can still interrupt active requests. Once connectivity returns, retry or reconnect the MCP client. Quick Cloudflare tunnel URLs change when restarted; named tunnels and reserved ngrok domains retain their hostname.

## Diagnosis

Use `powercfg /a` to see available sleep states, and run `powercfg /requests` from an elevated terminal to inspect power requests while `--keep-awake` is enabled. Use `codexpro doctor` and inspect persistent logs under `~/.codexpro/logs/` for runtime exit and transport lifecycle events. The `runtime_pause_recovered` and `http_transport_pause_recovered` events indicate that CodexPro detected a long event-loop pause.

The automated tests exercise Windows power-request startup/release, session timer pause recovery, and the interactive launcher's child-exit handling. They do not physically suspend or resume the machine.
