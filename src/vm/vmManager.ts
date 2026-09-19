import path from "node:path";
import { codexProHome } from "../profileStore.js";
import { ImageStore } from "./imageStore.js";
import { InstanceStore } from "./instanceStore.js";
import { configuredVmRoot, vmHomeLayout } from "./vmHome.js";
import { QemuBackend } from "./backends/qemu/qemuBackend.js";
import { HypervBackend } from "./backends/hyperv/hypervBackend.js";
import type { VmBackend } from "./backends/backend.js";
import type { VmArchitecture, VmBackendKind } from "./types.js";
import type { VmManagerOptions, SetupVmImageOptions, CreateVmOptions } from "./api.js";
export * from "./api.js";
export { allocateLoopbackPort } from "./backends/qemu/qemuBackend.js";

export function backendForPlatform(platform: NodeJS.Platform = process.platform): VmBackendKind {
  if (platform === "win32") return "hyperv";
  if (platform === "linux" || platform === "darwin") return "qemu";
  throw new Error(`Unsupported VM host platform: ${platform}`);
}

export class VmManager {
  readonly images: ImageStore;
  readonly instances: InstanceStore;
  readonly backend: VmBackendKind;
  private readonly runtime: VmBackend;
  private readonly root: string;

  constructor(options: VmManagerOptions = {}) {
    const home = path.resolve(options.home ?? codexProHome());
    this.root = path.resolve(options.vmRoot ?? configuredVmRoot(home) ?? vmHomeLayout(home).root);
    this.backend = backendForPlatform(options.platform);
    if (this.backend === "hyperv" && (options.qemu || options.qemuImg)) {
      throw new Error("--qemu and --qemu-img are supported only on Linux/macOS. Windows uses native Hyper-V.");
    }
    const resolved = { ...options, home, vmRoot: this.root };
    this.images = new ImageStore(resolved);
    this.instances = new InstanceStore(resolved);
    this.runtime = this.backend === "hyperv" ? new HypervBackend(resolved) : new QemuBackend(resolved);
  }

  doctor(architecture?: VmArchitecture) { return this.runtime.doctor(architecture); }
  setupImage(options: SetupVmImageOptions) { return this.runtime.setupImage(options); }
  createInstance(image: string, options?: CreateVmOptions) { return this.runtime.createInstance(image, options); }
  status(id: string) { return this.runtime.status(id); }
  listInstances() { return this.runtime.listInstances(); }
  destroyInstance(id: string) { return this.runtime.destroyInstance(id); }
  validateImage(name: string) { return this.runtime.validateImage(name); }
  listImages() { return this.images.listImages(); }
  inspectImage(name: string) { return this.images.readManifest(name, true); }
  vmHome() { return this.root; }
}
