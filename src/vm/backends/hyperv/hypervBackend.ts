import { randomBytes } from "node:crypto";
import { constants } from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { ImageStore } from "../../imageStore.js";
import { InstanceStore } from "../../instanceStore.js";
import { hostArchitecture, validateImageName, validateResources, validateVmGuid, type VmArchitecture, type VmImageManifest, type VmInstanceRecord, type VmInstanceState } from "../../types.js";
import type { CreateVmOptions, SetupVmImageOptions, VmDoctorReport, VmManagerOptions } from "../../api.js";
import { configuredVmRoot, vmHomeLayout } from "../../vmHome.js";
import { codexProHome } from "../../../profileStore.js";
import type { VmBackend, DiskImporter } from "../backend.js";
import { HypervPowerShell } from "./powershell.js";

export function hypervState(state: string): VmInstanceState {
  if (state === "Running") return "running";
  if (["Off", "Saved", "Paused"].includes(state)) return "stopped";
  if (["Starting", "Resuming", "Stopping", "Saving", "Pausing", "Reset"].includes(state)) return "starting";
  return "failed";
}

export function hypervName(id: string, ownershipId: string): string {
  if (!/^vm-[a-f0-9]{16}$/.test(id) || !/^[a-f0-9]{64}$/.test(ownershipId)) throw new Error("Invalid Hyper-V ownership identity.");
  return `CodexPro-${id}-${ownershipId.slice(0, 16)}`;
}

export class HypervBackend implements VmBackend {
  readonly images: ImageStore;
  readonly instances: InstanceStore;
  private readonly ps: HypervPowerShell;
  private readonly root: string;
  private readonly platform: NodeJS.Platform;

  constructor(options: VmManagerOptions = {}) {
    const home = options.home ?? codexProHome();
    this.root = path.resolve(options.vmRoot ?? configuredVmRoot(home) ?? vmHomeLayout(home).root);
    this.images = new ImageStore({ ...options, vmRoot: this.root });
    this.instances = new InstanceStore({ ...options, vmRoot: this.root });
    this.ps = new HypervPowerShell(options.executor);
    this.platform = options.platform ?? process.platform;
  }

  private checkArchitecture(architecture: VmArchitecture) {
    if (architecture !== "x86_64" || hostArchitecture() !== "x86_64") throw new Error("Hyper-V currently supports native x86_64 Generation 2 UEFI guests only.");
  }

  async doctor(architecture = hostArchitecture()): Promise<VmDoctorReport> {
    let checks: Record<string, boolean> = {};
    const issues: string[] = [];
    if (this.platform !== "win32") issues.push("Hyper-V requires a Windows host.");
    try { this.checkArchitecture(architecture); } catch (e) { issues.push(String(e)); }
    if (this.platform === "win32") {
      try { checks = await this.ps.run<Record<string, boolean>>("doctor"); }
      catch (e) { issues.push(String(e)); }
    }
    if (!checks.module || !checks.commands) issues.push("Enable the Hyper-V role and Hyper-V PowerShell management tools on a supported Windows edition, then restart. CodexPro does not enable features.");
    if (!checks.hypervisor || !checks.service) issues.push("Hypervisor readiness could not be confirmed (permissions may prevent detection). Check firmware virtualization, the Hyper-V hypervisor and Virtual Machine Management service (vmms).");
    if (!checks.permission) issues.push("Run with an elevated administrator token or an active Hyper-V Administrators membership (sign out/in after joining).");
    if (!checks.console) issues.push("Install Hyper-V GUI management tools (VMConnect) for interactive ISO setup.");
    // Read-only: never create the configured storage root from doctor.
    const readCount = async (directory: string) => {
      const entries = await fsp.readdir(directory, { withFileTypes: true }).catch((e: NodeJS.ErrnoException) => {
        if (e.code === "ENOENT") return [];
        issues.push(`Cannot read VM storage: ${e.message}`); return [];
      });
      return entries.filter(e => e.isDirectory() && !e.name.startsWith("."));
    };
    const images = await readCount(path.join(this.root, "images"));
    const instances = await readCount(path.join(this.root, "instances"));
    let storageParent = this.root;
    while (!(await fsp.stat(storageParent).catch(() => undefined)) && path.dirname(storageParent) !== storageParent) storageParent = path.dirname(storageParent);
    try {
      if (!(await fsp.stat(storageParent)).isDirectory()) throw new Error("storage parent is not a directory");
      await fsp.access(storageParent, constants.R_OK | constants.W_OK);
      checks.storage = true;
    } catch (e) { checks.storage = false; issues.push(`VM storage is not accessible: ${String(e)}`); }
    let imageCount = 0;
    for (const entry of images) {
      try { await this.images.readManifest(entry.name); imageCount++; }
      catch (e) { issues.push(`Image ${entry.name}: ${String(e)}`); }
    }
    let active = 0;
    for (const entry of instances) {
      try {
        const record = await this.instances.read(entry.name);
        if (record.backend !== "hyperv") continue;
        const identity = await this.identity(record);
        const status = await this.ps.run<{ state: string }>("status", identity);
        if (["running", "starting"].includes(hypervState(status.state))) active++;
      } catch (e) { issues.push(`Instance ${entry.name}: ${String(e)}`); }
    }
    return { backend: "hyperv", ready: issues.length === 0, checks, issues, hostArchitecture: hostArchitecture(), vmHome: this.root, imageCount, activeInstanceCount: active };
  }

  private importer(): DiskImporter {
    return {
      backend: "hyperv", format: "vhdx",
      prepare: async (source, destination) => {
        if (![".vhd", ".vhdx"].includes(path.extname(source).toLowerCase())) throw new Error("Windows Hyper-V imports VHD/VHDX or interactive installer ISO only. Convert qcow2/raw manually to a standalone VHDX outside CodexPro.");
        const result = await this.ps.run<{ size: number }>("import", { source, destination }, 10 * 60_000);
        if (!Number.isSafeInteger(result.size) || result.size <= 0) throw new Error("Hyper-V reported an invalid disk size.");
        return result.size;
      }
    };
  }

  async setupImage(options: SetupVmImageOptions): Promise<VmImageManifest> {
    validateImageName(options.name);
    validateResources(options.cpus, options.memoryMb);
    this.checkArchitecture(options.architecture);
    const source = path.resolve(options.sourcePath);
    if (await fsp.lstat(this.images.imageDir(options.name)).catch(() => undefined)) throw new Error(`VM image "${options.name}" is already installed. Choose a different name.`);
    let manifest: VmImageManifest;
    if (path.extname(source).toLowerCase() === ".iso") manifest = await this.installIso(options, source);
    else manifest = await this.importDisk(options, source);
    if (options.validate) {
      try { manifest = await this.validateImage(options.name); }
      catch (e) { throw new Error(`Image ${options.name} was imported, but validation failed: ${String(e)}`); }
    }
    return manifest;
  }

  private importDisk(options: SetupVmImageOptions, sourcePath: string, sourceFileName?: string) {
    return this.images.importImage({ name: options.name, sourcePath, sourceFileName, architecture: options.architecture, defaultCpus: options.cpus, defaultMemoryMb: options.memoryMb, desktop: options.desktop, importer: this.importer() });
  }

  private async allocate(image: string, cpus: number, memory: number, desktop: boolean) {
    return this.instances.allocate(image, cpus, memory, undefined, desktop, undefined, undefined, { ownershipId: randomBytes(32).toString("hex") });
  }

  /** Locks cover entire starts/installations. Stale locks deliberately require human recovery. */
  private async lock<T>(record: VmInstanceRecord, action: () => Promise<T>): Promise<T> {
    const filename = path.join(record.instanceDir, "operation.lock");
    const handle = await fsp.open(filename, "wx").catch(() => { throw new Error(`Instance ${record.id} is busy or has a stale operation.lock. Verify no setup/lifecycle process is active before removing that lock.`); });
    try { await handle.writeFile(String(process.pid)); return await action(); }
    finally { await handle.close(); await fsp.rm(filename, { force: true }); }
  }

  private async identity(record: VmInstanceRecord): Promise<{ vmId: string; ownershipId: string }> {
    if (record.backend !== "hyperv" || !record.hyperv) throw new Error("This instance belongs to QEMU; use its original backend/platform for cleanup.");
    if (record.hyperv.vmId) return { ...record.hyperv, vmId: validateVmGuid(record.hyperv.vmId) };
    const journalPath = path.join(record.instanceDir, "hyperv-identity.json");
    const stat = await fsp.lstat(journalPath).catch(() => undefined);
    if (!stat?.isFile() || stat.isSymbolicLink()) throw new Error("Hyper-V identity journal is missing; ownership cannot be verified. Instance files preserved.");
    const journal = JSON.parse((await fsp.readFile(journalPath, "utf8")).replace(/^\uFEFF/, ""));
    if (journal.ownershipId !== record.hyperv.ownershipId) throw new Error("Hyper-V identity journal ownership mismatch.");
    return { vmId: validateVmGuid(journal.vmId), ownershipId: record.hyperv.ownershipId };
  }

  private async createVm(record: VmInstanceRecord, disk: string, iso?: string): Promise<void> {
    const ownershipId = record.hyperv!.ownershipId;
    const result = await this.ps.run<{ vmId: string }>("create", {
      name: hypervName(record.id, ownershipId), ownershipId, cpus: record.cpus, memory: record.memoryMb * 1024 * 1024,
      disk, iso, directory: record.instanceDir, journal: path.join(record.instanceDir, "hyperv-identity.json")
    }, 60_000);
    const vmId = validateVmGuid(result.vmId);
    await this.instances.update(record.id, { hyperv: { ownershipId, vmId }, state: iso ? "created" : "starting" });
    // Windows installer media gives only a short window to press a boot key.
    // Let the human start ISO installs from the already-open VMConnect console.
    if (iso) return;
    await this.ps.run("start", { vmId, ownershipId }, 60_000);
    await this.instances.update(record.id, { state: "running" });
  }

  private async stopVm(record: VmInstanceRecord): Promise<void> {
    const result = await this.ps.run<{ removed: boolean }>("destroy", await this.identity(record), 60_000);
    if (result.removed !== true) throw new Error("Hyper-V did not confirm removal; preserving instance files.");
  }

  private async failed(record: VmInstanceRecord, error: unknown): Promise<never> {
    let cleanup = "VM removed; diagnostic disk/state preserved.";
    try { await this.stopVm(await this.instances.read(record.id)); }
    catch (e) { cleanup = `VM may still exist or be running; cleanup could not be verified: ${String(e)}`; }
    const message = `${String(error)}. ${cleanup} Instance: ${record.id}; diagnostics: ${record.instanceDir}`;
    await this.instances.update(record.id, { state: "failed", lastError: message });
    throw new Error(message);
  }

  private async installIso(options: SetupVmImageOptions, iso: string): Promise<VmImageManifest> {
    if (options.headless) throw new Error("Installer ISO setup requires an interactive Hyper-V console. Use a preinstalled VHD/VHDX with --headless.");
    if (!(await fsp.stat(iso)).isFile()) throw new Error("Installer ISO must be a regular file.");
    const size = options.diskSizeGb ?? 64;
    if (!Number.isSafeInteger(size) || size < 4 || size > 2048) throw new Error("ISO installation disk size must be an integer from 4 to 2048 GiB.");
    const { record } = await this.allocate(options.name, options.cpus, options.memoryMb, options.desktop);
    const disk = path.join(record.instanceDir, "installed.vhdx");
    let interrupted = false;
    const interrupt = () => { interrupted = true; };
    process.on("SIGINT", interrupt); process.on("SIGTERM", interrupt);
    try {
      const manifest = await this.lock(record, async () => {
        try {
          await this.ps.run("disk", { disk, size: size * 1024 ** 3 });
          await this.createVm(record, disk, iso);
          const identity = await this.identity(await this.instances.read(record.id));
          options.onProgress?.(`Installer ${record.id} (${identity.vmId}). In VMConnect, click Start (Avvia), focus the guest display and immediately press Space when prompted to boot from CD/DVD. If the UEFI boot summary appears, click Restart now and press Space immediately. Complete installation, then shut down the guest. Network is disconnected. Setup expires after 4 hours; failed disks are retained.`);
          await this.ps.run("console", identity);
          const deadline = Date.now() + 4 * 60 * 60_000;
          let started = false;
          for (;;) {
            if (interrupted) throw new Error("ISO installation interrupted");
            if (Date.now() >= deadline) throw new Error("ISO installation timed out after 4 hours");
            const status = await this.ps.run<{ state: string }>("status", identity);
            if (status.state === "Running" && !started) {
              started = true;
              await this.instances.update(record.id, { state: "running" });
            }
            if (status.state === "Off" && started) break;
            if (hypervState(status.state) === "failed") throw new Error(`Installer entered unexpected state ${status.state}`);
            await new Promise(resolve => setTimeout(resolve, 2000));
          }
          await this.stopVm(await this.instances.read(record.id));
          return await this.importDisk(options, disk, `${path.basename(iso)}.installed.vhdx`);
        } catch (e) { return this.failed(record, e); }
      });
      await this.instances.remove(record.id);
      return manifest;
    } finally { process.off("SIGINT", interrupt); process.off("SIGTERM", interrupt); }
  }

  async createInstance(image: string, options: CreateVmOptions = {}): Promise<VmInstanceRecord> {
    const manifest = await this.images.readManifest(image, true);
    if (manifest.backend !== "hyperv") throw new Error("This is a QEMU image. Windows requires a human-approved VHD/VHDX or ISO installation; existing qcow2 images are preserved.");
    this.checkArchitecture(manifest.architecture);
    const cpus = options.cpus ?? manifest.defaultCpus;
    const memory = options.memoryMb ?? manifest.defaultMemoryMb;
    validateResources(cpus, memory);
    const { record } = await this.allocate(image, cpus, memory, manifest.desktop);
    return this.lock(record, async () => {
      try {
        const disk = path.join(record.instanceDir, "overlay.vhdx");
        await this.ps.run("disk", { disk, parent: this.images.basePath(image, "vhdx") });
        await this.createVm(record, disk);
        return await this.instances.read(record.id);
      } catch (e) { return this.failed(record, e); }
    });
  }

  async status(id: string): Promise<VmInstanceRecord> {
    const record = await this.instances.read(id);
    if (record.backend !== "hyperv") return record;
    const result = await this.ps.run<{ state: string }>("status", await this.identity(record));
    return { ...record, state: hypervState(result.state), updatedAt: new Date().toISOString() };
  }

  async listInstances(): Promise<VmInstanceRecord[]> {
    const records = await this.instances.list();
    return Promise.all(records.map(async record => {
      try { return await this.status(record.id); }
      catch (e) { return { ...record, state: "failed" as const, lastError: String(e) }; }
    }));
  }

  async destroyInstance(id: string): Promise<void> {
    const record = await this.instances.read(id);
    await this.lock(record, () => this.stopVm(record));
    await this.instances.remove(id);
  }

  async validateImage(name: string): Promise<VmImageManifest> {
    const instance = await this.createInstance(name);
    let bootTested = false;
    try {
      await new Promise(resolve => setTimeout(resolve, 3000));
      bootTested = (await this.status(instance.id)).state === "running";
      if (!bootTested) throw new Error("Hyper-V validation VM is not running.");
    } finally { await this.destroyInstance(instance.id); }
    return this.images.updateValidation(name, { bootTested, guestAgentAvailable: false });
  }
}
