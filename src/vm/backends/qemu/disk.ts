import { checkQcow2, convertImageToQcow2, inspectImage } from "../../qemu.js";
import type { CommandExecutor } from "../../command.js";
import type { DiskImporter } from "../backend.js";

export function qemuDiskImporter(executor: CommandExecutor, binary: string): DiskImporter {
  return {
    backend: "qemu", format: "qcow2",
    async prepare(source, destination) {
      const info = await inspectImage(executor, binary, source);
      if (info["backing-filename"]) throw new Error("The source VM image uses an external backing file. Flatten it outside CodexPro before importing.");
      const size = Number(info["virtual-size"]);
      if (!Number.isSafeInteger(size) || size <= 0) throw new Error("qemu-img did not report a valid virtual size.");
      await convertImageToQcow2(executor, binary, source, destination);
      const imported = await inspectImage(executor, binary, destination);
      if (imported.format !== "qcow2" || imported["backing-filename"]) throw new Error("Imported VM base is not standalone qcow2.");
      await checkQcow2(executor, binary, destination);
      return size;
    }
  };
}
