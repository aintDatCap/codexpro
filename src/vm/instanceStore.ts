import { randomBytes } from "node:crypto";
import fsp from "node:fs/promises";
import path from "node:path";
import {
  parseInstanceRecord,
  validateImageName,
  validateInstanceId,
  validateResources,
  type LocalChannelEndpoint,
  type VmAccelerator,
  type VmInstanceRecord,
  type VmInstanceState
} from "./types.js";
import { ensureVmHome, vmHomeLayout, type VmHomeLayout } from "./vmHome.js";

export interface InstanceAllocation {
  record: VmInstanceRecord;
  instanceDir: string;
  overlayPath: string;
  runtimePath: string;
  logPath: string;
  pidPath: string;
}

export interface InstanceStoreOptions {
  home?: string;
}

async function writeJsonAtomic(filePath: string, value: unknown): Promise<void> {
  const temporary = path.join(
    path.dirname(filePath),
    `.${path.basename(filePath)}.${process.pid}-${randomBytes(6).toString("hex")}.tmp`
  );
  try {
    await fsp.writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" });
    await fsp.rename(temporary, filePath);
  } catch (error) {
    await fsp.rm(temporary, { force: true }).catch(() => {});
    throw error;
  }
}

function processAlive(pid: number | undefined): boolean {
  if (!pid || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    return code === "EPERM";
  }
}

export class InstanceStore {
  private readonly layout: VmHomeLayout;

  constructor(options: InstanceStoreOptions = {}) {
    this.layout = vmHomeLayout(options.home);
  }

  instanceDir(id: string): string {
    return path.join(this.layout.instances, validateInstanceId(id));
  }

  overlayPath(id: string): string {
    return path.join(this.instanceDir(id), "overlay.qcow2");
  }

  runtimePath(id: string): string {
    return path.join(this.instanceDir(id), "runtime.json");
  }

  logPath(id: string): string {
    return path.join(this.instanceDir(id), "qemu.log");
  }

  pidPath(id: string): string {
    return path.join(this.instanceDir(id), "qemu.pid");
  }

  qmpSocketPath(id: string): string {
    return path.join(this.instanceDir(id), "qmp.sock");
  }

  qgaSocketPath(id: string): string {
    return path.join(this.instanceDir(id), "qga.sock");
  }

  async allocate(
    image: string,
    cpus: number,
    memoryMb: number,
    accelerator: VmAccelerator,
    desktop: boolean,
    qmp?: LocalChannelEndpoint,
    qga?: LocalChannelEndpoint
  ): Promise<InstanceAllocation> {
    validateImageName(image);
    validateResources(cpus, memoryMb);
    await ensureVmHome(path.dirname(this.layout.root));

    for (let attempt = 0; attempt < 10; attempt += 1) {
      const id = `vm-${randomBytes(8).toString("hex")}`;
      const instanceDir = this.instanceDir(id);
      try {
        await fsp.mkdir(instanceDir, { recursive: false, mode: 0o700 });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "EEXIST") continue;
        throw error;
      }
      const now = new Date().toISOString();
      const record: VmInstanceRecord = {
        schemaVersion: 1,
        id,
        image,
        createdAt: now,
        updatedAt: now,
        state: "created",
        cpus,
        memoryMb,
        accelerator,
        desktop,
        instanceDir,
        ...(qmp ? { qmp } : {}),
        ...(qga ? { qga } : {})
      };
      await this.write(record);
      return {
        record,
        instanceDir,
        overlayPath: this.overlayPath(id),
        runtimePath: this.runtimePath(id),
        logPath: this.logPath(id),
        pidPath: this.pidPath(id)
      };
    }
    throw new Error("Unable to allocate a unique VM instance id.");
  }

  private assertRecordOwnership(record: VmInstanceRecord): void {
    const expected = path.resolve(this.instanceDir(record.id));
    if (path.resolve(record.instanceDir) !== expected) {
      throw new Error(`VM instance "${record.id}" contains an invalid instance directory.`);
    }
    if (path.dirname(expected) !== path.resolve(this.layout.instances)) {
      throw new Error(`VM instance "${record.id}" resolved outside the CodexPro instance store.`);
    }
  }

  async write(record: VmInstanceRecord): Promise<void> {
    const parsed = parseInstanceRecord(record);
    this.assertRecordOwnership(parsed);
    const dirStat = await fsp.lstat(parsed.instanceDir).catch(() => undefined);
    if (!dirStat?.isDirectory() || dirStat.isSymbolicLink()) {
      throw new Error(`VM instance "${parsed.id}" is not a valid CodexPro-owned directory.`);
    }
    await writeJsonAtomic(this.runtimePath(parsed.id), parsed);
  }

  async update(
    id: string,
    patch: Partial<Pick<VmInstanceRecord, "state" | "processId" | "qmp" | "qga" | "lastError">>
  ): Promise<VmInstanceRecord> {
    const current = await this.read(id);
    const next: VmInstanceRecord = {
      ...current,
      ...patch,
      updatedAt: new Date().toISOString()
    };
    if (patch.processId === undefined && Object.prototype.hasOwnProperty.call(patch, "processId")) {
      delete next.processId;
    }
    if (patch.lastError === undefined && Object.prototype.hasOwnProperty.call(patch, "lastError")) {
      delete next.lastError;
    }
    await this.write(next);
    return next;
  }

  async read(id: string): Promise<VmInstanceRecord> {
    validateInstanceId(id);
    const dir = this.instanceDir(id);
    const dirStat = await fsp.lstat(dir).catch(() => undefined);
    if (!dirStat?.isDirectory() || dirStat.isSymbolicLink()) {
      throw new Error(`VM instance "${id}" is not a valid CodexPro-owned directory.`);
    }
    const raw = await fsp.readFile(this.runtimePath(id), "utf8").catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") throw new Error(`VM instance "${id}" has no runtime record.`);
      throw error;
    });
    let value: unknown;
    try {
      value = JSON.parse(raw);
    } catch {
      throw new Error(`VM instance "${id}" has an invalid runtime record.`);
    }
    const record = parseInstanceRecord(value);
    if (record.id !== id) throw new Error(`VM instance id mismatch for "${id}".`);
    this.assertRecordOwnership(record);
    if ((record.state === "starting" || record.state === "running") && !record.processId) {
      const pidText = await fsp.readFile(this.pidPath(id), "utf8").catch(() => "");
      const recoveredPid = Number(pidText.trim());
      if (Number.isSafeInteger(recoveredPid) && recoveredPid > 0 && processAlive(recoveredPid)) {
        record.processId = recoveredPid;
        record.updatedAt = new Date().toISOString();
        await this.write(record);
      }
    }
    if (
      (record.state === "starting" || record.state === "running") &&
      record.processId &&
      !processAlive(record.processId)
    ) {
      const stopped: VmInstanceRecord = {
        ...record,
        state: record.state === "starting" ? "failed" : "stopped",
        updatedAt: new Date().toISOString()
      };
      delete stopped.processId;
      await this.write(stopped);
      return stopped;
    }
    return record;
  }

  async list(): Promise<VmInstanceRecord[]> {
    await ensureVmHome(path.dirname(this.layout.root));
    const entries = await fsp.readdir(this.layout.instances, { withFileTypes: true });
    const records: VmInstanceRecord[] = [];
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      try {
        validateInstanceId(entry.name);
        records.push(await this.read(entry.name));
      } catch {
        // Invalid directories are not treated as registered instances.
      }
    }
    return records.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  async remove(id: string): Promise<void> {
    validateInstanceId(id);
    const dir = this.instanceDir(id);
    const resolvedRoot = path.resolve(this.layout.instances);
    const resolvedDir = path.resolve(dir);
    if (path.dirname(resolvedDir) !== resolvedRoot) {
      throw new Error("Refusing to delete a VM path outside the CodexPro instance store.");
    }
    const stat = await fsp.lstat(resolvedDir).catch(() => undefined);
    if (!stat) return;
    if (!stat.isDirectory() || stat.isSymbolicLink()) {
      throw new Error("Refusing to recursively delete a non-directory or symlinked VM instance path.");
    }
    await fsp.rm(resolvedDir, { recursive: true, force: false });
  }

  async countActive(): Promise<number> {
    const records = await this.list();
    return records.filter(
      (record) => (record.state === "starting" || record.state === "running") && processAlive(record.processId)
    ).length;
  }

  isProcessAlive(pid: number | undefined): boolean {
    return processAlive(pid);
  }
}

export function withState(record: VmInstanceRecord, state: VmInstanceState): VmInstanceRecord {
  return { ...record, state, updatedAt: new Date().toISOString() };
}
