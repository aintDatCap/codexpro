import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { execFile, spawn, type ChildProcess } from "node:child_process";
import type { LocalChannelEndpoint, VmAccelerator, VmArchitecture } from "./types.js";

export interface CommandResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

export interface CommandExecutor {
  run(command: string, args: readonly string[], options?: { timeoutMs?: number; cwd?: string }): Promise<CommandResult>;
}

export const nodeCommandExecutor: CommandExecutor = {
  run(command, args, options = {}) {
    return new Promise((resolve, reject) => {
      execFile(
        command,
        [...args],
        {
          cwd: options.cwd,
          timeout: options.timeoutMs ?? 10_000,
          windowsHide: true,
          encoding: "utf8",
          maxBuffer: 4 * 1024 * 1024
        },
        (error, stdout, stderr) => {
          const errorCode = error?.code;
          const exitCode = typeof errorCode === "number" ? errorCode : error ? 1 : 0;
          if (errorCode === "ENOENT") {
            reject(new Error(`Executable not found: ${command}`));
            return;
          }
          resolve({ stdout: String(stdout ?? ""), stderr: String(stderr ?? ""), exitCode });
        }
      );
    });
  }
};

function executableExtensions(): string[] {
  if (process.platform !== "win32") return [""];
  const raw = process.env.PATHEXT || ".EXE;.CMD;.BAT;.COM";
  return raw.split(";").filter(Boolean);
}

function isExecutable(filePath: string): boolean {
  try {
    const stat = fs.statSync(filePath);
    if (!stat.isFile()) return false;
    if (process.platform === "win32") return true;
    fs.accessSync(filePath, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function isPathLike(command: string): boolean {
  return path.isAbsolute(command) || command.includes("/") || command.includes("\\");
}

export function discoverExecutable(command: string | undefined, fallbackName: string, envPath = process.env.PATH ?? ""): string | undefined {
  const requested = command?.trim() || fallbackName;
  if (isPathLike(requested)) {
    const resolved = path.resolve(requested);
    return isExecutable(resolved) ? resolved : undefined;
  }
  const directories = envPath.split(path.delimiter).filter(Boolean);
  const extensions = executableExtensions();
  for (const directory of directories) {
    for (const extension of extensions) {
      const candidate = path.join(directory, process.platform === "win32" && path.extname(requested) ? requested : `${requested}${extension}`);
      if (isExecutable(candidate)) return candidate;
    }
  }
  return undefined;
}

export function systemBinaryName(architecture: VmArchitecture): string {
  return architecture === "aarch64" ? "qemu-system-aarch64" : "qemu-system-x86_64";
}

export function qemuMachineForArchitecture(architecture: VmArchitecture): string {
  return architecture === "aarch64" ? "virt" : "q35";
}

export async function binaryVersion(executor: CommandExecutor, binary: string): Promise<string> {
  const result = await executor.run(binary, ["--version"], { timeoutMs: 5_000 });
  if (result.exitCode !== 0) throw new Error(result.stderr.trim() || `${binary} --version failed.`);
  return result.stdout.split(/\r?\n/, 1)[0]?.trim() || "unknown";
}

export interface QemuImageInfo {
  format?: string;
  filename?: string;
  "virtual-size"?: number;
  "actual-size"?: number;
  "backing-filename"?: string;
  [key: string]: unknown;
}

export async function inspectImage(executor: CommandExecutor, qemuImg: string, imagePath: string): Promise<QemuImageInfo> {
  const result = await executor.run(qemuImg, ["info", "--output=json", imagePath], { timeoutMs: 30_000 });
  if (result.exitCode !== 0) throw new Error(`qemu-img could not inspect the source image: ${result.stderr.trim() || "unknown error"}`);
  try {
    return JSON.parse(result.stdout) as QemuImageInfo;
  } catch {
    throw new Error("qemu-img returned invalid JSON while inspecting the image.");
  }
}

export async function convertImageToQcow2(
  executor: CommandExecutor,
  qemuImg: string,
  sourcePath: string,
  destinationPath: string
): Promise<void> {
  const result = await executor.run(qemuImg, ["convert", "-O", "qcow2", sourcePath, destinationPath], { timeoutMs: 10 * 60_000 });
  if (result.exitCode !== 0) throw new Error(`qemu-img convert failed: ${result.stderr.trim() || "unknown error"}`);
}

export async function checkQcow2(executor: CommandExecutor, qemuImg: string, imagePath: string): Promise<void> {
  const result = await executor.run(qemuImg, ["check", "--output=json", imagePath], { timeoutMs: 2 * 60_000 });
  if (result.exitCode !== 0) throw new Error(`qemu-img check failed: ${result.stderr.trim() || result.stdout.trim() || "unknown error"}`);
  try {
    JSON.parse(result.stdout || "{}");
  } catch {
    throw new Error("qemu-img check returned invalid JSON.");
  }
}

export function overlayCreateArgs(basePath: string, overlayPath: string): string[] {
  return ["create", "-f", "qcow2", "-F", "qcow2", "-b", basePath, overlayPath];
}

export async function createOverlay(
  executor: CommandExecutor,
  qemuImg: string,
  basePath: string,
  overlayPath: string
): Promise<void> {
  const result = await executor.run(qemuImg, overlayCreateArgs(basePath, overlayPath), { timeoutMs: 30_000 });
  if (result.exitCode !== 0) throw new Error(`qemu-img overlay creation failed: ${result.stderr.trim() || "unknown error"}`);
}

function keyval(value: string): string {
  return value.replace(/,/g, ",,");
}

export function qmpArgument(endpoint: LocalChannelEndpoint): string {
  return endpoint.transport === "unix"
    ? `unix:${keyval(endpoint.path)},server=on,wait=off`
    : `pipe:${keyval(endpoint.name)}`;
}

export function qgaArguments(endpoint: LocalChannelEndpoint): string[] {
  const backend = endpoint.transport === "unix"
    ? `socket,id=qga0,path=${keyval(endpoint.path)},server=on,wait=off`
    : `pipe,id=qga0,path=${keyval(endpoint.name)}`;
  return [
    "-chardev",
    backend,
    "-device",
    "virtio-serial-pci,id=codexpro-virtio-serial",
    "-device",
    "virtserialport,chardev=qga0,name=org.qemu.guest_agent.0"
  ];
}

export interface QemuLaunchOptions {
  id: string;
  architecture: VmArchitecture;
  accelerator: VmAccelerator;
  cpus: number;
  memoryMb: number;
  overlayPath: string;
  pidFilePath: string;
  qmp: LocalChannelEndpoint;
  qga: LocalChannelEndpoint;
}

export function buildQemuLaunchArgs(options: QemuLaunchOptions): string[] {
  const block = JSON.stringify({
    driver: "qcow2",
    "node-name": "codexpro-disk",
    file: { driver: "file", filename: options.overlayPath }
  });
  return [
    "-name",
    `codexpro-${options.id}`,
    "-machine",
    qemuMachineForArchitecture(options.architecture),
    "-accel",
    options.accelerator,
    ...(options.architecture === "aarch64" ? ["-cpu", "host"] : []),
    "-smp",
    String(options.cpus),
    "-m",
    String(options.memoryMb),
    "-pidfile",
    options.pidFilePath,
    "-blockdev",
    block,
    "-device",
    "virtio-blk-pci,drive=codexpro-disk",
    "-nic",
    "user,model=virtio-net-pci",
    "-display",
    "none",
    "-serial",
    "none",
    "-monitor",
    "none",
    "-qmp",
    qmpArgument(options.qmp),
    ...qgaArguments(options.qga)
  ];
}

export function startQemuProcess(binary: string, args: readonly string[], logPath: string): ChildProcess {
  const fd = fs.openSync(logPath, "a", 0o600);
  try {
    return spawn(binary, [...args], {
      stdio: ["ignore", "ignore", fd],
      windowsHide: true,
      detached: false
    });
  } finally {
    fs.closeSync(fd);
  }
}

export async function readLogTail(logPath: string, maxBytes = 16_384): Promise<string> {
  try {
    const stat = await fsp.stat(logPath);
    const start = Math.max(0, stat.size - maxBytes);
    const handle = await fsp.open(logPath, "r");
    try {
      const buffer = Buffer.alloc(Math.min(maxBytes, stat.size));
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, start);
      return buffer.subarray(0, bytesRead).toString("utf8").trim();
    } finally {
      await handle.close();
    }
  } catch {
    return "";
  }
}
