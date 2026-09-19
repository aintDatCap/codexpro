import { VmManager, publicVmImage, publicVmInstance, redactVmHostPaths } from "./vmManager.js";

export type VmToolAction = "images" | "create" | "status" | "destroy";

export interface VmToolArgs {
  action: VmToolAction;
  image?: string;
  id?: string;
  cpus?: number;
  memoryMb?: number;
}

export async function runVmToolAction(
  args: VmToolArgs,
  manager = new VmManager()
): Promise<Record<string, unknown>> {
  try {
    if (args.action === "images") {
      const images = (await manager.listImages()).map(publicVmImage);
      return { action: "images", images, imageCount: images.length };
    }
    if (args.action === "create") {
      if (!args.image) throw new Error("image is required for vm action=create.");
      const instance = await manager.createInstance(args.image, {
        cpus: args.cpus,
        memoryMb: args.memoryMb
      });
      return { action: "create", instance: publicVmInstance(instance) };
    }
    if (args.action === "status") {
      if (!args.id) throw new Error("id is required for vm action=status.");
      return { action: "status", instance: publicVmInstance(await manager.status(args.id)) };
    }
    if (args.action === "destroy") {
      if (!args.id) throw new Error("id is required for vm action=destroy.");
      await manager.destroyInstance(args.id);
      return { action: "destroy", id: args.id, state: "destroyed" };
    }
    throw new Error("Unsupported VM action.");
  } catch (error) {
    throw new Error(redactVmHostPaths(error, undefined, manager.vmHome()));
  }
}
