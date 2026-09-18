import { spawn } from "node:child_process";
import type { VmAccelerator, VmArchitecture } from "./types.js";
import { qemuMachineForArchitecture } from "./qemu.js";

export interface AcceleratorProbeResult {
  accelerator?: VmAccelerator;
  usable: boolean;
  reason?: string;
}

export function acceleratorForPlatform(platform = process.platform): VmAccelerator | undefined {
  if (platform === "win32") return "whpx";
  if (platform === "linux") return "kvm";
  if (platform === "darwin") return "hvf";
  return undefined;
}

export async function probeAccelerator(
  qemuSystem: string,
  architecture: VmArchitecture,
  accelerator = acceleratorForPlatform(),
  timeoutMs = 5_000
): Promise<AcceleratorProbeResult> {
  if (!accelerator) {
    return { usable: false, reason: `Hardware acceleration is not supported on host platform ${process.platform}.` };
  }

  return new Promise((resolve) => {
    let settled = false;
    let output = "";
    let timer: NodeJS.Timeout;
    const child = spawn(
      qemuSystem,
      [
        "-machine",
        qemuMachineForArchitecture(architecture),
        "-accel",
        accelerator,
        ...(architecture === "aarch64" && accelerator !== "tcg" ? ["-cpu", "host"] : []),
        "-nodefaults",
        "-display",
        "none",
        "-monitor",
        "none",
        "-S",
        "-qmp",
        "stdio"
      ],
      { stdio: ["ignore", "pipe", "pipe"], windowsHide: true }
    );

    const finish = (result: AcceleratorProbeResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (child.exitCode === null) child.kill();
      resolve(result);
    };
    const onData = (chunk: Buffer | string) => {
      output += String(chunk);
      if (output.length > 64 * 1024) output = output.slice(-64 * 1024);
      if (/"QMP"\s*:/.test(output)) finish({ accelerator, usable: true });
    };
    child.stdout?.on("data", onData);
    child.stderr?.on("data", onData);
    child.once("error", (error) => finish({ accelerator, usable: false, reason: error.message }));
    child.once("exit", (code) => {
      if (!settled) {
        const detail = output.trim().split(/\r?\n/).slice(-4).join(" ");
        finish({
          accelerator,
          usable: false,
          reason: detail || `QEMU accelerator probe exited with code ${String(code)}.`
        });
      }
    });
    timer = setTimeout(() => {
      finish({
        accelerator,
        usable: false,
        reason: `Timed out probing ${accelerator} after ${timeoutMs} ms.`
      });
    }, timeoutMs);
  });
}
