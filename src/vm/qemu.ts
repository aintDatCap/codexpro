import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { spawn, type ChildProcess } from "node:child_process";
import { performance } from "node:perf_hooks";
import { connectQmpWithRetry, QmpCommandTimeoutError, QmpConnectionError } from "./qmp.js";
import type { LocalChannelEndpoint, VmAccelerator, VmArchitecture } from "./types.js";

export { nodeCommandExecutor, type CommandExecutor, type CommandResult } from "./command.js";
import type { CommandExecutor } from "./command.js";

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

export function qemuMachineForLaunch(
  architecture: VmArchitecture,
  accelerator: VmAccelerator,
  cpus: number
): string {
  const machine = qemuMachineForArchitecture(architecture);
  if (architecture === "x86_64" && accelerator === "whpx" && cpus > 1) {
    return `${machine},kernel-irqchip=off`;
  }
  return machine;
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

export async function createQcow2Disk(
  executor: CommandExecutor,
  qemuImg: string,
  destinationPath: string,
  sizeGiB: number
): Promise<void> {
  const result = await executor.run(qemuImg, ["create", "-f", "qcow2", destinationPath, `${sizeGiB}G`], { timeoutMs: 30_000 });
  if (result.exitCode !== 0) throw new Error(`qemu-img create failed: ${result.stderr.trim() || "unknown error"}`);
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
  if (endpoint.transport === "unix") return `unix:${keyval(endpoint.path)},server=on,wait=off`;
  if (endpoint.transport === "pipe") return `pipe:${keyval(endpoint.name)}`;
  return `tcp:${endpoint.host}:${endpoint.port},server=on,wait=off,nodelay=on`;
}

export function qgaArguments(endpoint: LocalChannelEndpoint): string[] {
  const backend = endpoint.transport === "unix"
    ? `socket,id=qga0,path=${keyval(endpoint.path)},server=on,wait=off`
    : endpoint.transport === "pipe"
      ? `pipe,id=qga0,path=${keyval(endpoint.name)}`
      : `socket,id=qga0,host=${endpoint.host},port=${endpoint.port},server=on,wait=off,nodelay=on,ipv4=on`;
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
  const diskArgs = options.architecture === "x86_64"
    ? ["-device", "ich9-ahci,id=codexpro-ahci", "-device", "ide-hd,drive=codexpro-disk,bus=codexpro-ahci.0"]
    : ["-device", "virtio-blk-pci,drive=codexpro-disk"];
  return [
    "-name",
    `codexpro-${options.id}`,
    "-machine",
    qemuMachineForLaunch(options.architecture, options.accelerator, options.cpus),
    "-accel",
    options.accelerator,
    ...(options.architecture === "aarch64" && options.accelerator !== "tcg" ? ["-cpu", "host"] : []),
    "-smp",
    String(options.cpus),
    "-m",
    String(options.memoryMb),
    "-pidfile",
    options.pidFilePath,
    "-blockdev",
    block,
    ...diskArgs,
    "-nic",
    options.architecture === "x86_64" ? "user,model=e1000e" : "user,model=virtio-net-pci",
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

export interface QemuInstallerOptions {
  name: string;
  architecture: VmArchitecture;
  accelerator: VmAccelerator;
  cpus: number;
  memoryMb: number;
  diskPath: string;
  isoPath: string;
  qmp: LocalChannelEndpoint;
  display?: string;
}

export function buildQemuInstallerArgs(options: QemuInstallerOptions): string[] {
  const diskDrive = `file=${keyval(options.diskPath)},if=none,format=qcow2,id=install-disk`;
  const isoDrive = `file=${keyval(options.isoPath)},if=none,media=cdrom,readonly=on,id=install-cd`;
  const storageArgs = options.architecture === "x86_64"
    ? [
        "-device", "ich9-ahci,id=codexpro-ahci",
        "-drive", diskDrive,
        "-device", "ide-hd,drive=install-disk,bus=codexpro-ahci.0",
        "-drive", isoDrive,
        "-device", "ide-cd,drive=install-cd,bus=codexpro-ahci.1"
      ]
    : [
        "-device", "virtio-scsi-pci,id=codexpro-scsi",
        "-drive", diskDrive,
        "-device", "scsi-hd,drive=install-disk,bus=codexpro-scsi.0",
        "-drive", isoDrive,
        "-device", "scsi-cd,drive=install-cd,bus=codexpro-scsi.0"
      ];
  return [
    "-name", `codexpro-install-${options.name}`,
    "-machine", qemuMachineForLaunch(options.architecture, options.accelerator, options.cpus),
    "-accel", options.accelerator,
    ...(options.architecture === "aarch64" && options.accelerator !== "tcg" ? ["-cpu", "host"] : []),
    "-smp", String(options.cpus),
    "-m", String(options.memoryMb),
    ...storageArgs,
    "-nic", options.architecture === "x86_64" ? "user,model=e1000e" : "user,model=virtio-net-pci",
    "-boot", "once=d",
    ...(options.display ? ["-display", options.display] : []),
    "-serial", "none",
    "-monitor", "none",
    "-qmp", qmpArgument(options.qmp)
  ];
}

export function startQemuProcess(
  binary: string,
  args: readonly string[],
  logPath: string,
  options: { windowsHide?: boolean } = {}
): ChildProcess {
  const fd = fs.openSync(logPath, "a", 0o600);
  try {
    return spawn(binary, [...args], {
      stdio: ["ignore", "ignore", fd],
      windowsHide: options.windowsHide ?? true,
      detached: false
    });
  } finally {
    fs.closeSync(fd);
  }
}

const INSTALLER_RESUMABLE_STATES = new Set(["paused", "prelaunch"]);
const INSTALLER_FATAL_STATES = new Set(["internal-error", "io-error", "guest-panicked", "watchdog"]);

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function runQemuInstaller(
  binary: string,
  args: readonly string[],
  logPath: string,
  qmpEndpoint: LocalChannelEndpoint,
  accelerator?: VmAccelerator
): Promise<void> {
  const child = startQemuProcess(binary, args, logPath, { windowsHide: false });
  let spawnError: Error | undefined;
  child.once("error", (error) => {
    spawnError = error;
  });

  const exitResult = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
    child.once("exit", (code, signal) => resolve({ code, signal }));
  });

  const hasExited = () => child.exitCode !== null || child.signalCode !== null;
  // Do not wait for a slow QMP command when the process has already exited.
  const untilExit = async <T>(operation: Promise<T>): Promise<T | undefined> => {
    let onExit!: () => void;
    const exited = new Promise<undefined>((resolve) => {
      onExit = () => resolve(undefined);
      child.once("exit", onExit);
      if (hasExited()) onExit();
    });
    try {
      return await Promise.race([operation, exited]);
    } finally {
      child.off("exit", onExit);
    }
  };
  const tcg = accelerator === "tcg";
  const commandTimeoutMs = tcg ? 5_000 : 1_500;
  const pollMs = tcg ? 2_000 : 500;
  const unresponsiveMs = 60_000;
  let unresponsiveSince: number | undefined;

  let qmp: Awaited<ReturnType<typeof connectQmpWithRetry>> | undefined;
  try {
    qmp = await connectQmpWithRetry(qmpEndpoint, 30_000, 5_000);
    for (;;) {
      if (spawnError) throw spawnError;
      if (child.exitCode !== null || child.signalCode !== null) break;

      const requestStarted = performance.now();
      try {
        if (accelerator === "whpx" || accelerator === undefined) {
          const logTail = await readLogTail(logPath, 8_192);
          if (/WHPX:\s+Unexpected VP exit code 4/i.test(logTail)) {
            throw new Error("QEMU installer hit a WHPX virtual-processor failure (Unexpected VP exit code 4).");
          }
        }
        const timeout = () => {
          const remaining = unresponsiveSince === undefined ? unresponsiveMs : unresponsiveMs - (performance.now() - unresponsiveSince);
          if (remaining <= 0) throw new Error(`QEMU installer QMP remained unresponsive for ${unresponsiveMs} ms while the process was still alive.`);
          return Math.min(commandTimeoutMs, remaining);
        };
        if (!qmp) {
          const reconnectMs = timeout();
          try {
            qmp = await connectQmpWithRetry(qmpEndpoint, reconnectMs, reconnectMs);
          } catch (error) {
            throw new QmpConnectionError(`QMP reconnect failed: ${error instanceof Error ? error.message : String(error)}`);
          }
        }
        const status = await untilExit(qmp.queryStatus(timeout()));
        if (!status) break;
        if (INSTALLER_FATAL_STATES.has(status.status)) {
          throw new Error(`QEMU installer entered non-resumable state: ${status.status}.`);
        }
        if (INSTALLER_RESUMABLE_STATES.has(status.status)) {
          await untilExit(qmp.continueRun(timeout()));
        }
        unresponsiveSince = undefined;
      } catch (error) {
        if (child.exitCode !== null || child.signalCode !== null) break;
        await sleep(250);
        if (child.exitCode !== null || child.signalCode !== null) break;
        if (!tcg || !(error instanceof QmpCommandTimeoutError || error instanceof QmpConnectionError)) throw error;
        unresponsiveSince ??= requestStarted;
        if (performance.now() - unresponsiveSince >= unresponsiveMs) {
          throw new Error(`QEMU installer QMP remained unresponsive for ${unresponsiveMs} ms while the process was still alive.`, { cause: error });
        }
        if (error instanceof QmpConnectionError) {
          qmp?.close();
          qmp = undefined;
        }
      }
      await untilExit(sleep(pollMs));
    }

    const { code, signal } = await exitResult;
    if (code === 0) return;
    throw new Error(`QEMU installer exited ${signal ? `with signal ${signal}` : `with code ${String(code)}`}.`);
  } catch (error) {
    if (child.exitCode === null && child.signalCode === null) {
      await qmp?.quit(1_000).catch(() => {});
      await Promise.race([exitResult, sleep(1_000)]);
      if (child.exitCode === null && child.signalCode === null) child.kill();
    }
    throw error;
  } finally {
    qmp?.close();
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
