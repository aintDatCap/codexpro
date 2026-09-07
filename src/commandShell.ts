import fs from "node:fs";
import path from "node:path";

export type CommandShell = "auto" | "bash" | "powershell" | "cmd" | "wsl";

export function commandShell(value = "auto"): CommandShell {
  if (!["auto", "bash", "powershell", "cmd", "wsl"].includes(value)) {
    throw new Error("Command shell must be auto, bash, powershell, cmd, or wsl.");
  }
  return value as CommandShell;
}

export function shellInvocation(shell: CommandShell, command: string, cwd: string, distribution?: string): { command: string; args: string[]; shell: string; windowsVerbatimArguments?: boolean } {
  const selected = shell === "auto" ? (process.platform === "win32" ? "powershell" : "bash") : shell;
  if (selected === "wsl") {
    if (process.platform !== "win32") throw new Error("Use shell=bash when running CodexPro inside WSL.");
    // Let WSL translate the Windows working directory; never interpolate it into shell code.
    return { command: "wsl.exe", args: [...(distribution ? ["--distribution", distribution] : []), "--cd", cwd, "--exec", "bash", "-c", command], shell: selected };
  }
  if (selected === "powershell") {
    const executable = process.platform === "win32"
      ? path.join(process.env.SystemRoot ?? "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe") : "pwsh";
    const script = `$ErrorActionPreference = 'Stop'; $ProgressPreference = 'SilentlyContinue'; [Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false); $OutputEncoding = [Console]::OutputEncoding; ${command}\nif ($LASTEXITCODE) { exit $LASTEXITCODE }`;
    return { command: executable, args: ["-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64")], shell: selected };
  }
  if (selected === "cmd") {
    if (process.platform !== "win32") throw new Error("shell=cmd requires Windows.");
    return { command: process.env.ComSpec ?? "cmd.exe", args: ["/d", "/v:off", "/s", "/c", `"${command}"`], shell: selected, windowsVerbatimArguments: true };
  }
  return { command: fs.existsSync("/bin/bash") ? "/bin/bash" : "bash", args: ["-c", command], shell: selected };
}
