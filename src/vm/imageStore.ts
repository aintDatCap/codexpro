import { createHash, randomBytes } from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import {
  parseImageManifest,
  validateImageName,
  validateResources,
  type VmAccelerator,
  type VmArchitecture,
  type VmImageManifest,
  type VmImageValidation
} from "./types.js";
import { ensureVmLayout, vmHomeLayout, type VmHomeLayout } from "./vmHome.js";
import { nodeCommandExecutor, type CommandExecutor } from "./command.js";
import type { DiskImporter } from "./backends/backend.js";
export interface ImportImageOptions {
  name: string;
  sourcePath: string;
  sourceFileName?: string;
  architecture: VmArchitecture;
  defaultCpus: number;
  defaultMemoryMb: number;
  desktop: boolean;
  preferredAccelerator?: VmAccelerator;
  qemuImg?: string;
  importer?: DiskImporter;
}

export interface ImageStoreOptions {
  home?: string;
  vmRoot?: string;
  executor?: CommandExecutor;
}

async function exists(filePath: string): Promise<boolean> {
  try {
    await fsp.access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function sha256File(filePath: string): Promise<string> {
  const hash = createHash("sha256");
  await new Promise<void>((resolve, reject) => {
    const stream = fs.createReadStream(filePath);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("error", reject);
    stream.on("end", resolve);
  });
  return hash.digest("hex");
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

export class ImageStore {
  private readonly layout: VmHomeLayout;
  private readonly executor: CommandExecutor;

  constructor(options: ImageStoreOptions = {}) {
    this.layout = vmHomeLayout(options.home, options.vmRoot);
    this.executor = options.executor ?? nodeCommandExecutor;
  }

  imageDir(name: string): string {
    return path.join(this.layout.images, validateImageName(name));
  }

  basePath(name: string, format: "qcow2" | "vhdx" = "qcow2"): string {
    return path.join(this.imageDir(name), `base.${format}`);
  }

  manifestPath(name: string): string {
    return path.join(this.imageDir(name), "manifest.json");
  }

  async importImage(options: ImportImageOptions): Promise<VmImageManifest> {
    const name = validateImageName(options.name);
    validateResources(options.defaultCpus, options.defaultMemoryMb);
    const layout = await ensureVmLayout(this.layout);
    const finalDir = path.join(layout.images, name);
    if (await exists(finalDir)) {
      throw new Error(`VM image "${name}" is already installed. Choose a different name.`);
    }

    const sourcePath = path.resolve(options.sourcePath);
    const sourceStat = await fsp.stat(sourcePath).catch(() => undefined);
    if (!sourceStat?.isFile()) throw new Error("The VM source image must be an existing regular file.");
    if (path.extname(sourcePath).toLowerCase() === ".iso") {
      throw new Error("Installer ISO files must be handled through the CodexPro VM setup flow.");
    }

    const importer = options.importer ?? (await import("./backends/qemu/disk.js")).qemuDiskImporter(this.executor, options.qemuImg ?? "qemu-img");
    const stagingDir = path.join(
      layout.images,
      `.import-${name}-${process.pid}-${randomBytes(8).toString("hex")}`
    );
    await fsp.mkdir(stagingDir, { recursive: false, mode: 0o700 });
    const stagingBase = path.join(stagingDir, `base.${importer.format}`);

    try {
      const virtualSize = await importer.prepare(sourcePath, stagingBase);
      const stat = await fsp.stat(stagingBase);
      if (!stat.isFile() || stat.size <= 0) throw new Error("Imported VM base is empty or invalid.");
      const sha256 = await sha256File(stagingBase);

      try {
        await fsp.chmod(stagingBase, 0o444);
      } catch {
        // Some Windows/network filesystems do not expose POSIX-like modes. CodexPro
        // still never opens or boots the managed base writable.
      }

      const manifest: VmImageManifest = {
        schemaVersion: 2,
        backend: importer.backend,
        name,
        architecture: options.architecture,
        format: importer.format,
        sha256,
        virtualSize,
        fileSize: stat.size,
        defaultCpus: options.defaultCpus,
        defaultMemoryMb: options.defaultMemoryMb,
        desktop: options.desktop,
        ...(options.preferredAccelerator ? { preferredAccelerator: options.preferredAccelerator } : {}),
        createdAt: new Date().toISOString(),
        source: {
          originalFileName: path.basename(options.sourceFileName ?? sourcePath)
        },
        validation: {
          bootTested: false,
          guestAgentAvailable: false
        }
      };
      parseImageManifest(manifest);
      await writeJsonAtomic(path.join(stagingDir, "manifest.json"), manifest);
      await fsp.rename(stagingDir, finalDir);
      return manifest;
    } catch (error) {
      await fsp.chmod(stagingBase, 0o600).catch(() => {});
      await fsp.rm(stagingDir, { recursive: true, force: true }).catch(() => {});
      throw error;
    }
  }

  private async assertOwnedImageDir(name: string): Promise<void> {
    const dir = this.imageDir(name);
    const stat = await fsp.lstat(dir).catch(() => undefined);
    if (!stat?.isDirectory() || stat.isSymbolicLink()) {
      throw new Error(`VM image "${name}" is not a valid CodexPro-owned image directory.`);
    }
  }

  async readManifest(name: string, verifyHash = false): Promise<VmImageManifest> {
    validateImageName(name);
    await this.assertOwnedImageDir(name);
    const manifestRaw = await fsp.readFile(this.manifestPath(name), "utf8").catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") throw new Error(`VM image "${name}" has no manifest.`);
      throw error;
    });
    let parsed: unknown;
    try {
      parsed = JSON.parse(manifestRaw);
    } catch {
      throw new Error(`VM image "${name}" has an invalid manifest JSON file.`);
    }
    const manifest = parseImageManifest(parsed);
    if (manifest.name !== name) throw new Error(`VM image manifest name mismatch for "${name}".`);

    const base = this.basePath(name, manifest.format);
    const stat = await fsp.lstat(base).catch(() => undefined);
    if (!stat?.isFile() || stat.isSymbolicLink()) throw new Error(`VM image "${name}" has no valid managed base disk.`);
    if (stat.size !== manifest.fileSize) {
      throw new Error(`VM image "${name}" base file size no longer matches its manifest.`);
    }
    if (verifyHash) {
      const digest = await sha256File(base);
      if (digest !== manifest.sha256) {
        throw new Error(`VM image "${name}" base hash no longer matches its manifest. Refusing to use it.`);
      }
    }
    return manifest;
  }

  async listImages(): Promise<VmImageManifest[]> {
    await ensureVmLayout(this.layout);
    const entries = await fsp.readdir(this.layout.images, { withFileTypes: true });
    const images: VmImageManifest[] = [];
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.name.startsWith(".")) continue;
      try {
        validateImageName(entry.name);
        images.push(await this.readManifest(entry.name, false));
      } catch {
        // A half-written or corrupted directory is intentionally not registered.
      }
    }
    return images.sort((a, b) => a.name.localeCompare(b.name));
  }

  async updateValidation(name: string, validation: VmImageValidation): Promise<VmImageManifest> {
    const manifest = await this.readManifest(name, true);
    const next: VmImageManifest = {
      ...manifest,
      validation: {
        bootTested: Boolean(validation.bootTested),
        guestAgentAvailable: Boolean(validation.guestAgentAvailable)
      }
    };
    await writeJsonAtomic(this.manifestPath(name), next);
    return next;
  }
}
