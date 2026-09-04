import os from "node:os";
import path from "node:path";
import type { Workspace } from "./guard.js";

export interface CommandSafetyDecision {
  allowed: boolean;
  risk: "normal" | "blocked";
  reason?: string;
}

const CATASTROPHIC_PROGRAMS = new Set([
  "mkfs", "mkfs.ext2", "mkfs.ext3", "mkfs.ext4", "mkfs.xfs", "mkfs.btrfs",
  "fdisk", "sfdisk", "parted", "diskpart", "shutdown", "reboot", "halt", "poweroff"
]);

function compact(value: string): string {
  return value.trim().replace(/\s+/g, " ");
}

function unquote(value: string): string {
  return value.replace(/^(['"])(.*)\1$/, "$2");
}

function tokenize(command: string): string[] {
  const out: string[] = [];
  let current = "";
  let quote = "";
  let escaped = false;
  for (const char of command.trim()) {
    if (escaped) { current += char; escaped = false; continue; }
    if (char === "\\" && quote !== "'") { escaped = true; continue; }
    if (quote) {
      if (char === quote) quote = "";
      else current += char;
      continue;
    }
    if (char === "'" || char === '"') { quote = char; continue; }
    if (/\s/.test(char)) { if (current) { out.push(current); current = ""; } continue; }
    current += char;
  }
  if (current) out.push(current);
  return out;
}

function commandSegments(command: string): string[] {
  return command.split(/(?:&&|\|\||;|\r?\n)/).map((part) => part.trim()).filter(Boolean);
}

function dangerousDeleteTarget(raw: string, workspace: Workspace): boolean {
  const target = unquote(raw.trim());
  if (!target) return false;
  const home = os.homedir();
  const obvious = new Set(["/", "/*", "~", "~/", "$HOME", "${HOME}", ".", "..", "*", "./*", "../*"]);
  if (obvious.has(target)) return true;
  if (/^[A-Za-z]:[\\/]?$/.test(target) || /^[A-Za-z]:[\\/]\*$/.test(target)) return true;
  const expanded = target === "~" || target.startsWith("~/") ? path.join(home, target.slice(2)) : target;
  if (path.isAbsolute(expanded)) {
    const resolved = path.resolve(expanded);
    if (resolved === path.parse(resolved).root || resolved === path.resolve(home) || resolved === path.resolve(workspace.root)) return true;
    const rel = path.relative(workspace.root, resolved);
    if (rel.startsWith("..") || path.isAbsolute(rel)) return true;
  }
  return false;
}

function inspectSegment(segment: string, workspace: Workspace): string | undefined {
  const tokens = tokenize(segment);
  if (!tokens.length) return undefined;
  const sensitiveToken = tokens.find((token) => /(?:^|[/:])(?:\.env(?:[./:]|$)|\.ssh(?:[/:]|$)|\.npmrc(?:$|[/:])|id_(?:rsa|ed25519)(?:$|[.:/])|[^/:]+\.(?:pem|key)(?:$|[/:]))/i.test(token));
  if (sensitiveToken) return `direct shell access to sensitive path is blocked: ${sensitiveToken}`;
  if (tokens.some((token) => token === "$HOME" || token === "${HOME}" || token === "~" || token.startsWith("~/"))) return "home-directory expansion is blocked in safe mode";
  let index = 0;
  while (tokens[index] && /^(?:env|command|builtin|nohup)$/i.test(tokens[index])) index += 1;
  if (/^sudo$/i.test(tokens[index] ?? "")) return "sudo execution is blocked by the default command policy";
  const exe = path.basename(tokens[index] ?? "").toLowerCase();
  const args = tokens.slice(index + 1);

  if (CATASTROPHIC_PROGRAMS.has(exe)) return `${exe} is a system/disk destructive command`;
  if (exe === "dd" && args.some((arg) => /^of=(?:\/dev\/|\\\\\.\\PhysicalDrive)/i.test(arg))) return "raw block-device writes are blocked";
  if (exe === "git") {
    const joined = args.join(" ");
    if (/\breset\s+--hard\b/i.test(joined)) return "git reset --hard is blocked";
    if (/\bclean\b.*(?:-[A-Za-z]*f|--force)/i.test(joined)) return "git clean with force is blocked";
    if (/\bpush\b.*(?:--force|-f)(?:\s|$)/i.test(joined)) return "force push is blocked";
    if (/\bbranch\b.*\s-D(?:\s|$)/i.test(joined)) return "force branch deletion is blocked";
    if (/\b(?:checkout|switch)\b.*\s-f(?:\s|$)/i.test(joined)) return "force checkout/switch is blocked";
  }
  if (exe === "rm") {
    const recursive = args.some((arg) => /^-[^-]*r/i.test(arg) || arg === "--recursive");
    const force = args.some((arg) => /^-[^-]*f/i.test(arg) || arg === "--force");
    const targets = args.filter((arg) => !arg.startsWith("-"));
    if ((recursive || force) && targets.some((target) => dangerousDeleteTarget(target, workspace))) return "broad or out-of-workspace recursive deletion is blocked";
  }
  if (exe === "find") {
    const root = args.find((arg) => !arg.startsWith("-"));
    const mutatingPrimary = args.find((arg) => /^(?:-delete|-fprint|-fprintf|-exec|-execdir|-ok|-okdir)$/i.test(arg));
    if (mutatingPrimary) return `mutating find primary is blocked in safe mode: ${mutatingPrimary}`;
    if (root && path.isAbsolute(root)) {
      const resolved = path.resolve(root);
      const relative = path.relative(workspace.root, resolved);
      if (relative.startsWith("..") || path.isAbsolute(relative)) return "find root is outside the active workspace";
    }
  }
  if ((exe === "powershell" || exe === "pwsh") && /Remove-Item\b.*(?:-Recurse|-Force)/i.test(segment)) {
    if (/['"]?(?:[A-Za-z]:\\|\\|\/|~|\$HOME|\.)['"]?/i.test(segment)) return "broad PowerShell recursive deletion is blocked";
  }
  if (/:\(\)\s*\{\s*:\|:&\s*\};:/ .test(compact(segment))) return "shell fork bomb is blocked";
  return undefined;
}

export function assessCommandSafety(command: string, workspace: Workspace): CommandSafetyDecision {
  for (const segment of commandSegments(command)) {
    const reason = inspectSegment(segment, workspace);
    if (reason) return { allowed: false, risk: "blocked", reason };
  }
  return { allowed: true, risk: "normal" };
}
