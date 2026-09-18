import fs from "node:fs/promises";
import path from "node:path";
import { codexProHome } from "../profileStore.js";

export interface VmHomeLayout {
  root: string;
  images: string;
  instances: string;
}

export function vmHomeLayout(home = codexProHome()): VmHomeLayout {
  const root = path.join(home, "vm");
  return {
    root,
    images: path.join(root, "images"),
    instances: path.join(root, "instances")
  };
}

export async function ensureVmHome(home?: string): Promise<VmHomeLayout> {
  const layout = vmHomeLayout(home);
  await fs.mkdir(layout.images, { recursive: true, mode: 0o700 });
  await fs.mkdir(layout.instances, { recursive: true, mode: 0o700 });
  return layout;
}

export function isPathInside(child: string, parent: string): boolean {
  const relative = path.relative(path.resolve(parent), path.resolve(child));
  return relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative);
}
