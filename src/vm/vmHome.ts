import fsSync from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { expandHome } from "../config.js";
import { codexProHome } from "../profileStore.js";

export interface VmHomeLayout {
  root: string;
  images: string;
  instances: string;
}

const VM_ROOT_CONFIG_FILE = "vm-root";

export function configuredVmRoot(home = codexProHome()): string | undefined {
  const fromEnvironment = process.env.CODEXPRO_VM_HOME?.trim();
  if (fromEnvironment) return path.resolve(expandHome(fromEnvironment));
  try {
    const saved = fsSync.readFileSync(path.join(home, VM_ROOT_CONFIG_FILE), "utf8").trim();
    return saved ? path.resolve(saved) : undefined;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

export async function saveConfiguredVmRoot(vmRoot: string, home = codexProHome()): Promise<string> {
  const resolved = path.resolve(vmRoot);
  await fs.mkdir(home, { recursive: true, mode: 0o700 });
  await fs.writeFile(path.join(home, VM_ROOT_CONFIG_FILE), `${resolved}\n`, { encoding: "utf8", mode: 0o600 });
  return resolved;
}

export function vmHomeLayout(home = codexProHome(), vmRoot?: string): VmHomeLayout {
  const root = vmRoot ? path.resolve(vmRoot) : path.join(home, "vm");
  return {
    root,
    images: path.join(root, "images"),
    instances: path.join(root, "instances")
  };
}

export async function ensureVmLayout(layout: VmHomeLayout): Promise<VmHomeLayout> {
  await fs.mkdir(layout.images, { recursive: true, mode: 0o700 });
  await fs.mkdir(layout.instances, { recursive: true, mode: 0o700 });
  return layout;
}

export async function ensureVmHome(home?: string, vmRoot?: string): Promise<VmHomeLayout> {
  return ensureVmLayout(vmHomeLayout(home, vmRoot));
}

export function isPathInside(child: string, parent: string): boolean {
  const relative = path.relative(path.resolve(parent), path.resolve(child));
  return relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative);
}
