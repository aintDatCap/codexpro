export type VmArchitecture = "x86_64" | "aarch64";
export type VmAccelerator = "whpx" | "kvm" | "hvf";
export type VmInstanceState = "created" | "starting" | "running" | "stopped" | "failed";

export type LocalChannelEndpoint =
  | { transport: "unix"; path: string }
  | { transport: "pipe"; name: string };

export interface VmImageValidation {
  bootTested: boolean;
  guestAgentAvailable: boolean;
}

export interface VmImageManifest {
  schemaVersion: 1;
  name: string;
  architecture: VmArchitecture;
  format: "qcow2";
  sha256: string;
  virtualSize: number;
  fileSize: number;
  defaultCpus: number;
  defaultMemoryMb: number;
  desktop: boolean;
  createdAt: string;
  source: {
    originalFileName: string;
  };
  validation: VmImageValidation;
}

export interface VmInstanceRecord {
  schemaVersion: 1;
  id: string;
  image: string;
  createdAt: string;
  updatedAt: string;
  state: VmInstanceState;
  cpus: number;
  memoryMb: number;
  accelerator: VmAccelerator;
  desktop: boolean;
  processId?: number;
  instanceDir: string;
  qmp?: LocalChannelEndpoint;
  qga?: LocalChannelEndpoint;
  lastError?: string;
}

export const VM_MANIFEST_SCHEMA_VERSION = 1 as const;
export const VM_INSTANCE_SCHEMA_VERSION = 1 as const;
export const VM_MIN_CPUS = 1;
export const VM_MAX_CPUS = 64;
export const VM_MIN_MEMORY_MB = 256;
export const VM_MAX_MEMORY_MB = 262_144;
export const VM_IMAGE_NAME_MAX_LENGTH = 80;

const IMAGE_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/;
const INSTANCE_ID_RE = /^vm-[a-f0-9]{16}$/;
const SHA256_RE = /^[a-f0-9]{64}$/;

function record(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object.`);
  }
  return value as Record<string, unknown>;
}

function requiredString(value: unknown, label: string): string {
  if (typeof value !== "string" || !value) throw new Error(`${label} must be a non-empty string.`);
  return value;
}

function requiredInteger(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value)) throw new Error(`${label} must be an integer.`);
  return value;
}

function requiredBoolean(value: unknown, label: string): boolean {
  if (typeof value !== "boolean") throw new Error(`${label} must be a boolean.`);
  return value;
}

export function validateImageName(name: string): string {
  if (!IMAGE_NAME_RE.test(name) || name.length > VM_IMAGE_NAME_MAX_LENGTH) {
    throw new Error(
      `Invalid VM image name "${name}". Use 1-${VM_IMAGE_NAME_MAX_LENGTH} characters: letters, numbers, dot, underscore, or hyphen; start with a letter or number.`
    );
  }
  return name;
}

export function validateInstanceId(id: string): string {
  if (!INSTANCE_ID_RE.test(id)) throw new Error(`Invalid VM instance id: ${id}`);
  return id;
}

export function normalizeArchitecture(value: string): VmArchitecture {
  const normalized = value.trim().toLowerCase();
  if (["x86_64", "x64", "amd64"].includes(normalized)) return "x86_64";
  if (["aarch64", "arm64"].includes(normalized)) return "aarch64";
  throw new Error(`Unsupported VM architecture: ${value}. Supported values: x86_64, aarch64.`);
}

export function hostArchitecture(arch = process.arch): VmArchitecture {
  return normalizeArchitecture(arch);
}

export function validateResources(cpus: number, memoryMb: number): { cpus: number; memoryMb: number } {
  if (!Number.isSafeInteger(cpus) || cpus < VM_MIN_CPUS || cpus > VM_MAX_CPUS) {
    throw new Error(`VM CPU count must be an integer from ${VM_MIN_CPUS} to ${VM_MAX_CPUS}.`);
  }
  if (!Number.isSafeInteger(memoryMb) || memoryMb < VM_MIN_MEMORY_MB || memoryMb > VM_MAX_MEMORY_MB) {
    throw new Error(`VM memory must be an integer from ${VM_MIN_MEMORY_MB} to ${VM_MAX_MEMORY_MB} MiB.`);
  }
  return { cpus, memoryMb };
}

export function parseImageManifest(value: unknown): VmImageManifest {
  const input = record(value, "VM image manifest");
  if (input.schemaVersion !== VM_MANIFEST_SCHEMA_VERSION) {
    throw new Error(`Unsupported VM image manifest schemaVersion: ${String(input.schemaVersion)}`);
  }
  const name = validateImageName(requiredString(input.name, "manifest.name"));
  const architecture = normalizeArchitecture(requiredString(input.architecture, "manifest.architecture"));
  if (input.format !== "qcow2") throw new Error("manifest.format must be qcow2.");
  const sha256 = requiredString(input.sha256, "manifest.sha256");
  if (!SHA256_RE.test(sha256)) throw new Error("manifest.sha256 must be a lowercase SHA-256 digest.");
  const virtualSize = requiredInteger(input.virtualSize, "manifest.virtualSize");
  const fileSize = requiredInteger(input.fileSize, "manifest.fileSize");
  if (virtualSize <= 0 || fileSize <= 0) throw new Error("manifest virtual/file sizes must be positive.");
  const defaultCpus = requiredInteger(input.defaultCpus, "manifest.defaultCpus");
  const defaultMemoryMb = requiredInteger(input.defaultMemoryMb, "manifest.defaultMemoryMb");
  validateResources(defaultCpus, defaultMemoryMb);
  const desktop = requiredBoolean(input.desktop, "manifest.desktop");
  const createdAt = requiredString(input.createdAt, "manifest.createdAt");
  if (!Number.isFinite(Date.parse(createdAt))) throw new Error("manifest.createdAt must be an ISO date.");
  const source = record(input.source, "manifest.source");
  const originalFileName = requiredString(source.originalFileName, "manifest.source.originalFileName");
  if (originalFileName !== originalFileName.split(/[\\/]/).at(-1)) {
    throw new Error("manifest.source.originalFileName must not contain a path.");
  }
  const validation = record(input.validation, "manifest.validation");

  return {
    schemaVersion: 1,
    name,
    architecture,
    format: "qcow2",
    sha256,
    virtualSize,
    fileSize,
    defaultCpus,
    defaultMemoryMb,
    desktop,
    createdAt,
    source: { originalFileName },
    validation: {
      bootTested: requiredBoolean(validation.bootTested, "manifest.validation.bootTested"),
      guestAgentAvailable: requiredBoolean(validation.guestAgentAvailable, "manifest.validation.guestAgentAvailable")
    }
  };
}

function parseEndpoint(value: unknown, label: string): LocalChannelEndpoint {
  const input = record(value, label);
  if (input.transport === "unix") {
    return { transport: "unix", path: requiredString(input.path, `${label}.path`) };
  }
  if (input.transport === "pipe") {
    const name = requiredString(input.name, `${label}.name`);
    if (!/^codexpro-vm-[a-f0-9]{16}-(?:qmp|qga)$/.test(name)) {
      throw new Error(`${label}.name is not a valid CodexPro VM pipe name.`);
    }
    return { transport: "pipe", name };
  }
  throw new Error(`${label}.transport is invalid.`);
}

export function parseInstanceRecord(value: unknown): VmInstanceRecord {
  const input = record(value, "VM instance record");
  if (input.schemaVersion !== VM_INSTANCE_SCHEMA_VERSION) {
    throw new Error(`Unsupported VM instance schemaVersion: ${String(input.schemaVersion)}`);
  }
  const id = validateInstanceId(requiredString(input.id, "instance.id"));
  const image = validateImageName(requiredString(input.image, "instance.image"));
  const createdAt = requiredString(input.createdAt, "instance.createdAt");
  const updatedAt = requiredString(input.updatedAt, "instance.updatedAt");
  if (!Number.isFinite(Date.parse(createdAt)) || !Number.isFinite(Date.parse(updatedAt))) {
    throw new Error("instance timestamps must be ISO dates.");
  }
  const state = requiredString(input.state, "instance.state") as VmInstanceState;
  if (!["created", "starting", "running", "stopped", "failed"].includes(state)) {
    throw new Error(`Invalid VM instance state: ${state}`);
  }
  const cpus = requiredInteger(input.cpus, "instance.cpus");
  const memoryMb = requiredInteger(input.memoryMb, "instance.memoryMb");
  validateResources(cpus, memoryMb);
  const accelerator = requiredString(input.accelerator, "instance.accelerator") as VmAccelerator;
  if (!["whpx", "kvm", "hvf"].includes(accelerator)) throw new Error(`Invalid VM accelerator: ${accelerator}`);
  const desktop = requiredBoolean(input.desktop, "instance.desktop");
  const instanceDir = requiredString(input.instanceDir, "instance.instanceDir");

  const result: VmInstanceRecord = {
    schemaVersion: 1,
    id,
    image,
    createdAt,
    updatedAt,
    state,
    cpus,
    memoryMb,
    accelerator,
    desktop,
    instanceDir
  };
  if (input.processId !== undefined) {
    const processId = requiredInteger(input.processId, "instance.processId");
    if (processId <= 0) throw new Error("instance.processId must be positive.");
    result.processId = processId;
  }
  if (input.qmp !== undefined) result.qmp = parseEndpoint(input.qmp, "instance.qmp");
  if (input.qga !== undefined) result.qga = parseEndpoint(input.qga, "instance.qga");
  if (input.lastError !== undefined) result.lastError = requiredString(input.lastError, "instance.lastError");
  return result;
}
