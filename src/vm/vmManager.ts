import fsp from "node:fs/promises";
import path from "node:path";
import type { ChildProcess } from "node:child_process";
import { codexProHome } from "../profileStore.js";
import { waitForGuestAgent } from "./guestAgent.js";
import { ImageStore } from "./imageStore.js";
import { InstanceStore } from "./instanceStore.js";
import {
  binaryVersion,
  buildQemuLaunchArgs,
  createOverlay,
  discoverExecutable,
  nodeCommandExecutor,
  readLogTail,
  startQemuProcess,
  systemBinaryName,
  type CommandExecutor
} from "./qemu.js";
import { acceleratorForPlatform, probeAccelerator, type AcceleratorProbeResult } from "./qemuProbe.js";
import { connectQmpWithRetry } from "./qmp.js";
import {
  hostArchitecture,
  normalizeArchitecture,
  validateImageName,
  validateInstanceId,
  validateResources,
  type LocalChannelEndpoint,
  type VmArchitecture,
  type VmImageManifest,
  type VmInstanceRecord
} from "./types.js";
import { ensureVmHome, vmHomeLayout } from "./vmHome.js";

export interface VmManagerOptions {
  home?: string;
  executor?: CommandExecutor;
  qemu?: string;
  qemuImg?: string;
}

export interface SetupVmImageOptions {
  name: string;
  sourcePath: string;
  architecture: VmArchitecture;
  cpus: number;
  memoryMb: number;
  desktop: boolean;
  validate?: boolean;
}

export interface CreateVmOptions {
  cpus?: number;
  memoryMb?: number;
}

export interface VmDoctorReport {
  qemuSystem?: string;
  qemuSystemVersion?: string;
  qemuImg?: string;
  qemuImgVersion?: string;
  hostArchitecture: VmArchitecture;
  accelerator?: string;
  acceleratorUsable: boolean;
  acceleratorReason?: string;
  vmHome: string;
  imageCount: number;
  activeInstanceCount: number;
}

export interface PublicVmImage {
  name: string;
  architecture: VmArchitecture;
  format: "qcow2";
  virtualSize: number;
  defaultCpus: number;
  defaultMemoryMb: number;
  desktop: boolean;
  createdAt: string;
  validation: {
    bootTested: boolean;
    guestAgentAvailable: boolean;
  };
}

export interface PublicVmInstance {
  id: string;
  image: string;
  createdAt: string;
  updatedAt: string;
  state: VmInstanceRecord["state"];
  cpus: number;
  memoryMb: number;
  accelerator: VmInstanceRecord["accelerator"];
  desktop: boolean;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForProcessExit(pid: number, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      process.kill(pid, 0);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EPERM") return true;
    }
    await sleep(100);
  }
  return false;
}

export function publicVmImage(manifest: VmImageManifest): PublicVmImage {
  return {
    name: manifest.name,
    architecture: manifest.architecture,
    format: manifest.format,
    virtualSize: manifest.virtualSize,
    defaultCpus: manifest.defaultCpus,
    defaultMemoryMb: manifest.defaultMemoryMb,
    desktop: manifest.desktop,
    createdAt: manifest.createdAt,
    validation: { ...manifest.validation }
  };
}

export function publicVmInstance(record: VmInstanceRecord): PublicVmInstance {
  return {
    id: record.id,
    image: record.image,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    state: record.state,
    cpus: record.cpus,
    memoryMb: record.memoryMb,
    accelerator: record.accelerator,
    desktop: record.desktop
  };
}

export function redactVmHostPaths(error: unknown, home = codexProHome()): string {
  const message = error instanceof Error ? error.message : String(error);
  const variants = [path.resolve(home), path.resolve(home).replace(/\\/g, "/")].filter(Boolean);
  let redacted = message;
  for (const value of variants) {
    redacted = redacted.split(value).join("<CODEXPRO_HOME>");
  }
  return redacted;
}

export class VmManager {
  private readonly home: string;
  private readonly executor: CommandExecutor;
  private readonly qemuOverride?: string;
  private readonly qemuImgOverride?: string;
  readonly images: ImageStore;
  readonly instances: InstanceStore;
  private readonly acceleratorCache = new Map<VmArchitecture, Promise<AcceleratorProbeResult>>();

  constructor(options: VmManagerOptions = {}) {
    this.home = path.resolve(options.home ?? codexProHome());
    this.executor = options.executor ?? nodeCommandExecutor;
    this.qemuOverride = options.qemu ?? process.env.CODEXPRO_QEMU;
    this.qemuImgOverride = options.qemuImg ?? process.env.CODEXPRO_QEMU_IMG;
    this.images = new ImageStore({ home: this.home, executor: this.executor });
    this.instances = new InstanceStore({ home: this.home });
  }

  private resolveQemuImg(): string | undefined {
    return discoverExecutable(this.qemuImgOverride, "qemu-img");
  }

  private resolveQemuSystem(architecture: VmArchitecture): string | undefined {
    return discoverExecutable(this.qemuOverride, systemBinaryName(architecture));
  }

  private requireQemuImg(): string {
    const binary = this.resolveQemuImg();
    if (binary) return binary;
    throw new Error(
      "qemu-img was not found. Install QEMU separately and make qemu-img available on PATH, or pass --qemu-img /path/to/qemu-img. CodexPro does not install QEMU automatically."
    );
  }

  private requireQemuSystem(architecture: VmArchitecture): string {
    const binary = this.resolveQemuSystem(architecture);
    if (binary) return binary;
    throw new Error(
      systemBinaryName(architecture) +
        " was not found. Install QEMU separately and make it available on PATH, or pass --qemu /path/to/" +
        systemBinaryName(architecture) +
        ". CodexPro does not install QEMU automatically."
    );
  }

  private async accelerator(architecture: VmArchitecture, qemuSystem: string): Promise<AcceleratorProbeResult> {
    const host = hostArchitecture();
    if (architecture !== host) {
      return {
        accelerator: acceleratorForPlatform(),
        usable: false,
        reason:
          "Hardware-accelerated VM execution requires the guest architecture (" +
          architecture +
          ") to match the host architecture (" +
          host +
          "). Software emulation is intentionally not enabled in this release."
      };
    }
    let cached = this.acceleratorCache.get(architecture);
    if (!cached) {
      cached = probeAccelerator(qemuSystem, architecture);
      this.acceleratorCache.set(architecture, cached);
    }
    return cached;
  }

  async doctor(architecture: VmArchitecture = hostArchitecture()): Promise<VmDoctorReport> {
    const layout = await ensureVmHome(this.home);
    const qemuSystem = this.resolveQemuSystem(architecture);
    const qemuImg = this.resolveQemuImg();
    let qemuSystemVersion: string | undefined;
    let qemuImgVersion: string | undefined;
    if (qemuSystem) qemuSystemVersion = await binaryVersion(this.executor, qemuSystem).catch(() => undefined);
    if (qemuImg) qemuImgVersion = await binaryVersion(this.executor, qemuImg).catch(() => undefined);

    const accelerator = acceleratorForPlatform();
    let probe: AcceleratorProbeResult = {
      accelerator,
      usable: false,
      reason: accelerator
        ? "QEMU system binary is unavailable, so the accelerator could not be probed."
        : "Unsupported host platform."
    };
    if (qemuSystem) probe = await this.accelerator(architecture, qemuSystem);

    const results = await Promise.all([this.images.listImages(), this.instances.countActive()]);
    return {
      qemuSystem,
      qemuSystemVersion,
      qemuImg,
      qemuImgVersion,
      hostArchitecture: hostArchitecture(),
      accelerator,
      acceleratorUsable: probe.usable,
      acceleratorReason: probe.reason,
      vmHome: layout.root,
      imageCount: results[0].length,
      activeInstanceCount: results[1]
    };
  }

  async setupImage(options: SetupVmImageOptions): Promise<VmImageManifest> {
    const name = validateImageName(options.name);
    const architecture = normalizeArchitecture(options.architecture);
    validateResources(options.cpus, options.memoryMb);
    const qemuImg = this.requireQemuImg();
    this.requireQemuSystem(architecture);

    let manifest = await this.images.importImage({
      name,
      sourcePath: options.sourcePath,
      architecture,
      defaultCpus: options.cpus,
      defaultMemoryMb: options.memoryMb,
      desktop: Boolean(options.desktop),
      qemuImg
    });

    if (options.validate) {
      try {
        manifest = await this.validateImage(name);
      } catch (error) {
        throw new Error(
          'VM image "' +
            name +
            '" was imported successfully, but its validation boot failed: ' +
            redactVmHostPaths(error, this.home)
        );
      }
    }
    return manifest;
  }

  private async endpoint(id: string, kind: "qmp" | "qga"): Promise<LocalChannelEndpoint> {
    if (process.platform === "win32") {
      return { transport: "pipe", name: `codexpro-${id}-${kind}` };
    }
    const socketPath = kind === "qmp" ? this.instances.qmpSocketPath(id) : this.instances.qgaSocketPath(id);
    await fsp.rm(socketPath, { force: true }).catch(() => {});
    return { transport: "unix", path: socketPath };
  }

  async createInstance(image: string, options: CreateVmOptions = {}): Promise<VmInstanceRecord> {
    validateImageName(image);
    const manifest = await this.images.readManifest(image, true);
    const cpus = options.cpus ?? manifest.defaultCpus;
    const memoryMb = options.memoryMb ?? manifest.defaultMemoryMb;
    validateResources(cpus, memoryMb);

    const qemuImg = this.requireQemuImg();
    const qemuSystem = this.requireQemuSystem(manifest.architecture);
    const probe = await this.accelerator(manifest.architecture, qemuSystem);
    if (!probe.accelerator || !probe.usable) {
      throw new Error(
        "Hardware acceleration is unavailable for this VM: " +
          (probe.reason ?? "probe failed") +
          ". CodexPro does not silently fall back to TCG software emulation."
      );
    }

    const allocation = await this.instances.allocate(
      image,
      cpus,
      memoryMb,
      probe.accelerator,
      manifest.desktop
    );

    let child: ChildProcess | undefined;
    try {
      await createOverlay(this.executor, qemuImg, this.images.basePath(image), allocation.overlayPath);
      const qmp = await this.endpoint(allocation.record.id, "qmp");
      const qga = await this.endpoint(allocation.record.id, "qga");
      await this.instances.update(allocation.record.id, { state: "starting", qmp, qga });

      const args = buildQemuLaunchArgs({
        id: allocation.record.id,
        architecture: manifest.architecture,
        accelerator: probe.accelerator,
        cpus,
        memoryMb,
        overlayPath: allocation.overlayPath,
        pidFilePath: allocation.pidPath,
        qmp,
        qga
      });
      child = startQemuProcess(qemuSystem, args, allocation.logPath);
      if (child.pid) {
        await this.instances.update(allocation.record.id, { state: "starting", processId: child.pid });
      }
      let spawnError: Error | undefined;
      child.once("error", (error) => {
        spawnError = error;
      });

      const qmpClient = await connectQmpWithRetry(qmp, 7_000).catch(async (error) => {
        if (spawnError) throw spawnError;
        const log = await readLogTail(allocation.logPath);
        const detail = error instanceof Error ? error.message : String(error);
        throw new Error("QEMU failed to open its management channel: " + detail + (log ? "\nQEMU: " + log : ""));
      });
      try {
        const status = await qmpClient.queryStatus();
        if (status.status === "shutdown" || status.status === "internal-error") {
          throw new Error("QEMU entered unexpected state: " + status.status);
        }
      } finally {
        qmpClient.close();
      }

      if (!child.pid) throw new Error("QEMU started without a process id.");
      const running = await this.instances.update(allocation.record.id, {
        state: "running",
        processId: child.pid,
        lastError: undefined
      });
      child.unref();
      return running;
    } catch (error) {
      if (child && child.exitCode === null) {
        child.kill();
        if (child.pid && !(await waitForProcessExit(child.pid, 2_500))) {
          throw new Error(
            "QEMU failed to stop during startup cleanup; the instance files were left intact. Original startup error: " +
              (error instanceof Error ? error.message : String(error))
          );
        }
      }
      try {
        await this.instances.remove(allocation.record.id);
      } catch (cleanupError) {
        throw new Error(
          "QEMU startup failed and CodexPro could not fully remove the failed instance: " +
            (cleanupError instanceof Error ? cleanupError.message : String(cleanupError))
        );
      }
      throw error;
    }
  }

  async status(id: string): Promise<VmInstanceRecord> {
    return this.instances.read(validateInstanceId(id));
  }

  async listInstances(): Promise<VmInstanceRecord[]> {
    return this.instances.list();
  }

  async destroyInstance(id: string): Promise<void> {
    id = validateInstanceId(id);
    const record = await this.instances.read(id);
    const pid = record.processId;
    let qmpVerified = false;

    if ((record.state === "starting" || record.state === "running") && pid && this.instances.isProcessAlive(pid)) {
      if (record.qmp) {
        let client: Awaited<ReturnType<typeof connectQmpWithRetry>> | undefined;
        try {
          client = await connectQmpWithRetry(record.qmp, 2_000, 500);
          await client.queryStatus(1_000);
          qmpVerified = true;
          await client.quit(1_500).catch(() => {});
        } catch {
          qmpVerified = false;
        } finally {
          client?.close();
        }
      }

      if (qmpVerified) {
        if (!(await waitForProcessExit(pid, 2_500))) {
          try {
            process.kill(pid, "SIGTERM");
          } catch {
          }
          if (!(await waitForProcessExit(pid, 2_500))) {
            throw new Error(
              'VM instance "' +
                id +
                '" did not stop after a verified QMP shutdown and SIGTERM. Its files were left intact.'
            );
          }
        }
      } else if (this.instances.isProcessAlive(pid)) {
        throw new Error(
          'VM instance "' +
            id +
            '" is still running but its private QMP channel could not be verified. CodexPro is refusing to kill an unverified host process; the instance files were left intact.'
        );
      }
    }

    await this.instances.remove(id);
  }

  async validateImage(name: string): Promise<VmImageManifest> {
    name = validateImageName(name);
    let instance: VmInstanceRecord | undefined;
    let bootTested = false;
    let guestAgentAvailable = false;
    try {
      instance = await this.createInstance(name);
      await sleep(3_000);
      const refreshed = await this.instances.read(instance.id);
      if (!refreshed.qmp) throw new Error("Validation VM has no QMP endpoint.");
      const qmp = await connectQmpWithRetry(refreshed.qmp, 2_000);
      try {
        const status = await qmp.queryStatus();
        bootTested = status.status === "running" || status.running === true;
      } finally {
        qmp.close();
      }
      if (refreshed.qga) {
        guestAgentAvailable = await waitForGuestAgent(refreshed.qga, 12_000);
      }
    } finally {
      if (instance) await this.destroyInstance(instance.id);
    }
    return this.images.updateValidation(name, { bootTested, guestAgentAvailable });
  }

  async listImages(): Promise<VmImageManifest[]> {
    return this.images.listImages();
  }

  async inspectImage(name: string): Promise<VmImageManifest> {
    return this.images.readManifest(validateImageName(name), true);
  }

  vmHome(): string {
    return vmHomeLayout(this.home).root;
  }
}
