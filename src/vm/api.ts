import path from "node:path";
import { codexProHome } from "../profileStore.js";
import type { CommandExecutor } from "./command.js";
import type { VmArchitecture, VmImageManifest, VmInstanceRecord, VmBackendKind } from "./types.js";
export interface VmManagerOptions {
  /** Platform injection for tests; the CLI always uses the actual host platform. */
  platform?: NodeJS.Platform;
  home?: string;
  vmRoot?: string;
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
  diskSizeGb?: number;
  headless?: boolean;
  onProgress?: (message: string) => void;
}

export interface CreateVmOptions {
  cpus?: number;
  memoryMb?: number;
}

export interface VmDoctorReport {
  backend: VmBackendKind;
  ready?: boolean;
  checks?: Record<string, boolean>;
  issues?: string[];
  qemuSystem?: string;
  qemuSystemVersion?: string;
  qemuImg?: string;
  qemuImgVersion?: string;
  hostArchitecture: VmArchitecture;
  accelerator?: string;
  acceleratorUsable?: boolean;
  acceleratorReason?: string;
  vmHome: string;
  imageCount: number;
  activeInstanceCount: number;
}

export interface PublicVmImage {
  name: string;
  architecture: VmArchitecture;
  backend: VmBackendKind;
  format: "qcow2" | "vhdx";
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
  backend: VmBackendKind;
  accelerator?: VmInstanceRecord["accelerator"];
  desktop: boolean;
}

export function publicVmImage(manifest: VmImageManifest): PublicVmImage {
  return {
    backend: manifest.backend ?? "qemu",
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
    backend: record.backend ?? "qemu",
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

export function redactVmHostPaths(
  error: unknown,
  home = codexProHome(),
  vmRoot = process.env.CODEXPRO_VM_HOME
): string {
  const message = error instanceof Error ? error.message : String(error);
  const roots = [home, vmRoot].filter((value): value is string => Boolean(value)).map((value) => path.resolve(value));
  const variants = [...new Set(roots.flatMap((value) => [value, value.replace(/\\/g, "/")]))];
  let redacted = message;
  for (const value of variants) {
    redacted = redacted.split(value).join("<CODEXPRO_HOME>");
  }
  return redacted;
}
