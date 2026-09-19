import type { VmBackend } from "../backend.js";
import { redactVmHostPaths, type VmManagerOptions, type SetupVmImageOptions, type CreateVmOptions, type VmDoctorReport } from "../../api.js";
import { randomBytes } from "node:crypto";
import fsp from "node:fs/promises";
import net from "node:net";
import path from "node:path";
import type { ChildProcess } from "node:child_process";
import { codexProHome } from "../../../profileStore.js";
import { waitForGuestAgent } from "../../guestAgent.js";
import { ImageStore } from "../../imageStore.js";
import { InstanceStore } from "../../instanceStore.js";
import {
  binaryVersion,
  buildQemuInstallerArgs,
  buildQemuLaunchArgs,
  createOverlay,
  createQcow2Disk,
  discoverExecutable,
  nodeCommandExecutor,
  readLogTail,
  runQemuInstaller,
  startQemuProcess,
  systemBinaryName,
  type CommandExecutor
} from "../../qemu.js";
import { acceleratorForPlatform, probeAccelerator, type AcceleratorProbeResult } from "../../qemuProbe.js";
import { connectQmpWithRetry } from "../../qmp.js";
import {
  hostArchitecture,
  normalizeArchitecture,
  validateImageName,
  validateInstanceId,
  validateResources,
  type LocalChannelEndpoint,
  type VmAccelerator,
  type VmArchitecture,
  type VmImageManifest,
  type VmInstanceRecord
} from "../../types.js";
import { configuredVmRoot, ensureVmHome, vmHomeLayout } from "../../vmHome.js";

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function allocateLoopbackPort(): Promise<number> {
  const server = net.createServer();
  return new Promise<number>((resolve, reject) => {
    const onError = (error: Error) => reject(error);
    server.once("error", onError);
    server.listen({ host: "127.0.0.1", port: 0, exclusive: true }, () => {
      server.off("error", onError);
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close(() => reject(new Error("Unable to allocate a loopback port for the VM guest-agent channel.")));
        return;
      }
      const port = address.port;
      server.close((error) => {
        if (error) reject(error);
        else resolve(port);
      });
    });
  });
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

export class QemuBackend implements VmBackend {
  private readonly home: string;
  private readonly vmRoot: string;
  private readonly executor: CommandExecutor;
  private readonly qemuOverride?: string;
  private readonly qemuImgOverride?: string;
  readonly images: ImageStore;
  readonly instances: InstanceStore;
  private readonly acceleratorCache = new Map<VmArchitecture, Promise<AcceleratorProbeResult>>();

  constructor(options: VmManagerOptions = {}) {
    this.home = path.resolve(options.home ?? codexProHome());
    const selectedVmRoot = options.vmRoot ? path.resolve(options.vmRoot) : configuredVmRoot(this.home);
    this.vmRoot = selectedVmRoot ?? vmHomeLayout(this.home).root;
    this.executor = options.executor ?? nodeCommandExecutor;
    this.qemuOverride = options.qemu ?? process.env.CODEXPRO_QEMU;
    this.qemuImgOverride = options.qemuImg ?? process.env.CODEXPRO_QEMU_IMG;
    this.images = new ImageStore({ home: this.home, vmRoot: this.vmRoot, executor: this.executor });
    this.instances = new InstanceStore({ home: this.home, vmRoot: this.vmRoot });
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
    const layout = await ensureVmHome(this.home, this.vmRoot);
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
      backend: "qemu",
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

  private async installIsoImage(
    options: SetupVmImageOptions,
    name: string,
    architecture: VmArchitecture,
    qemuImg: string,
    qemuSystem: string
  ): Promise<VmImageManifest> {
    if (options.headless) {
      throw new Error(
        "Installer ISO setup requires an interactive QEMU display. Use a preinstalled VM disk for --headless setup."
      );
    }
    const diskSizeGb = options.diskSizeGb ?? 64;
    if (!Number.isSafeInteger(diskSizeGb) || diskSizeGb < 4 || diskSizeGb > 2_048) {
      throw new Error("ISO installation disk size must be an integer from 4 to 2048 GiB.");
    }
    const sourcePath = path.resolve(options.sourcePath);
    const sourceStat = await fsp.stat(sourcePath).catch(() => undefined);
    if (!sourceStat?.isFile()) throw new Error("The VM installer ISO must be an existing regular file.");
    const installedDir = this.images.imageDir(name);
    if (await fsp.stat(installedDir).catch(() => undefined)) {
      const existing = await this.images.readManifest(name, false).catch(() => undefined);
      if (existing && path.extname(existing.source.originalFileName).toLowerCase() === ".iso") {
        throw new Error(
          `VM image "${name}" is an older ISO import (${existing.source.originalFileName}), not an installed disk. Remove or rename that image, then run setup again to install the ISO into a qcow2 disk.`
        );
      }
      throw new Error(`VM image "${name}" is already installed. Choose a different name.`);
    }

    const probe = await this.accelerator(architecture, qemuSystem);
    if (!probe.accelerator || !probe.usable) {
      throw new Error(
        "Hardware acceleration is unavailable for ISO installation: " +
          (probe.reason ?? "probe failed") +
          ". CodexPro does not silently fall back to TCG software emulation."
      );
    }

    const layout = await ensureVmHome(this.home, this.vmRoot);
    const stagingDir = path.join(
      layout.root,
      `.install-${name}-${process.pid}-${randomBytes(6).toString("hex")}`
    );
    await fsp.mkdir(stagingDir, { recursive: false, mode: 0o700 });
    const diskPath = path.join(stagingDir, "installed.qcow2");
    const makeInstallerQmp = (label: string): LocalChannelEndpoint => process.platform === "win32"
      ? { transport: "pipe", name: `codexpro-vm-${randomBytes(8).toString("hex")}-${label}-qmp` }
      : { transport: "unix", path: path.join(stagingDir, `${label}-qmp.sock`) };
    const runInstallerAttempt = async (accelerator: VmAccelerator, logPath: string): Promise<void> => {
      const installerQmp = makeInstallerQmp(accelerator);
      const args = buildQemuInstallerArgs({
        name,
        architecture,
        accelerator,
        cpus: options.cpus,
        memoryMb: options.memoryMb,
        diskPath,
        isoPath: sourcePath,
        qmp: installerQmp,
        display: process.platform === "win32" ? "sdl" : undefined
      });
      await runQemuInstaller(qemuSystem, args, logPath, installerQmp, accelerator);
    };
    try {
      await createQcow2Disk(this.executor, qemuImg, diskPath, diskSizeGb);
      let preferredAccelerator: VmAccelerator | undefined;
      const primaryLogPath = path.join(stagingDir, "installer.log");
      try {
        await runInstallerAttempt(probe.accelerator, primaryLogPath);
      } catch (error) {
        const primaryLog = await readLogTail(primaryLogPath);
        const whpxVpFailure = probe.accelerator === "whpx" && /WHPX:\s+Unexpected VP exit code 4/i.test(primaryLog);
        if (!whpxVpFailure) {
          const detail = error instanceof Error ? error.message : String(error);
          throw new Error("QEMU installer failed: " + detail + (primaryLog ? "\nQEMU: " + primaryLog : ""));
        }

        const tcgProbe = await probeAccelerator(qemuSystem, architecture, "tcg", 10_000);
        if (!tcgProbe.usable || tcgProbe.accelerator !== "tcg") {
          throw new Error(
            "QEMU installer failed because WHPX hit Unexpected VP exit code 4, and the TCG compatibility fallback is unavailable: " +
              (tcgProbe.reason ?? "TCG probe failed") +
              (primaryLog ? "\nQEMU: " + primaryLog : "")
          );
        }

        options.onProgress?.(
          "WHPX failed with Unexpected VP exit code 4. Retrying the same installer disk with QEMU TCG software emulation; this will be slower."
        );
        const tcgLogPath = path.join(stagingDir, "installer-tcg.log");
        try {
          await runInstallerAttempt("tcg", tcgLogPath);
        } catch (fallbackError) {
          const tcgLog = await readLogTail(tcgLogPath);
          const detail = fallbackError instanceof Error ? fallbackError.message : String(fallbackError);
          throw new Error(
            "QEMU installer failed after falling back from WHPX to TCG: " +
              detail +
              (tcgLog ? "\nQEMU TCG: " + tcgLog : "") +
              (primaryLog ? "\nEarlier WHPX: " + primaryLog : "")
          );
        }
        preferredAccelerator = "tcg";
      }
      return await this.images.importImage({
        name,
        sourcePath: diskPath,
        sourceFileName: `${path.basename(sourcePath)}.installed.qcow2`,
        architecture,
        defaultCpus: options.cpus,
        defaultMemoryMb: options.memoryMb,
        desktop: Boolean(options.desktop),
        preferredAccelerator,
        qemuImg
      });
    } finally {
      await fsp.rm(stagingDir, { recursive: true, force: true }).catch(() => {});
    }
  }

  async setupImage(options: SetupVmImageOptions): Promise<VmImageManifest> {
    const name = validateImageName(options.name);
    const architecture = normalizeArchitecture(options.architecture);
    validateResources(options.cpus, options.memoryMb);
    const qemuImg = this.requireQemuImg();
    const qemuSystem = this.requireQemuSystem(architecture);
    const sourcePath = path.resolve(options.sourcePath);

    let manifest = path.extname(sourcePath).toLowerCase() === ".iso"
      ? await this.installIsoImage(options, name, architecture, qemuImg, qemuSystem)
      : await this.images.importImage({
          name,
          sourcePath,
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
            redactVmHostPaths(error, this.home, this.vmRoot)
        );
      }
    }
    return manifest;
  }

  private async endpoint(id: string, kind: "qmp" | "qga"): Promise<LocalChannelEndpoint> {
    if (process.platform === "win32") {
      if (kind === "qmp") return { transport: "pipe", name: `codexpro-${id}-${kind}` };
      return { transport: "tcp", host: "127.0.0.1", port: await allocateLoopbackPort() };
    }
    const socketPath = kind === "qmp" ? this.instances.qmpSocketPath(id) : this.instances.qgaSocketPath(id);
    await fsp.rm(socketPath, { force: true }).catch(() => {});
    return { transport: "unix", path: socketPath };
  }

  async createInstance(image: string, options: CreateVmOptions = {}): Promise<VmInstanceRecord> {
    validateImageName(image);
    const manifest = await this.images.readManifest(image, true);
    if (manifest.backend !== "qemu") throw new Error("This image requires the Hyper-V backend.");
    if (path.extname(manifest.source.originalFileName).toLowerCase() === ".iso") {
      throw new Error(
        `VM image "${image}" was imported from installer ISO media (${manifest.source.originalFileName}), not an installed VM disk. Recreate it from a qcow2/raw/VHD/VHDX disk image.`
      );
    }
    const cpus = options.cpus ?? manifest.defaultCpus;
    const memoryMb = options.memoryMb ?? manifest.defaultMemoryMb;
    validateResources(cpus, memoryMb);

    const qemuImg = this.requireQemuImg();
    const qemuSystem = this.requireQemuSystem(manifest.architecture);
    const probe = manifest.preferredAccelerator
      ? await probeAccelerator(qemuSystem, manifest.architecture, manifest.preferredAccelerator, 10_000)
      : await this.accelerator(manifest.architecture, qemuSystem);
    if (!probe.accelerator || !probe.usable) {
      const requirement = manifest.preferredAccelerator
        ? `Required accelerator ${manifest.preferredAccelerator} is unavailable for this VM: `
        : "Hardware acceleration is unavailable for this VM: ";
      throw new Error(
        requirement +
          (probe.reason ?? "probe failed") +
          (manifest.preferredAccelerator ? "" : ". CodexPro does not silently fall back to TCG software emulation.")
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
    if (record.backend !== "qemu") throw new Error("This instance requires the Hyper-V backend.");
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
    return this.vmRoot;
  }
}
