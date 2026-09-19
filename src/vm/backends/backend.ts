import type { CreateVmOptions, SetupVmImageOptions, VmDoctorReport } from "../api.js";
import type { VmArchitecture, VmImageManifest, VmInstanceRecord } from "../types.js";

/** Lifecycle boundary. Guest execution/transfer are not capabilities of either backend yet. */
export interface VmBackend {
  doctor(architecture?: VmArchitecture): Promise<VmDoctorReport>;
  setupImage(options: SetupVmImageOptions): Promise<VmImageManifest>;
  createInstance(image: string, options?: CreateVmOptions): Promise<VmInstanceRecord>;
  status(id: string): Promise<VmInstanceRecord>;
  listInstances(): Promise<VmInstanceRecord[]>;
  destroyInstance(id: string): Promise<void>;
  validateImage(name: string): Promise<VmImageManifest>;
}

export interface DiskImporter {
  backend: "qemu" | "hyperv";
  format: "qcow2" | "vhdx";
  prepare(source: string, destination: string): Promise<number>;
}
