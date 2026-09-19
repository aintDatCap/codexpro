import { execFile } from "node:child_process";
export interface CommandResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

export interface CommandExecutor {
  run(command: string, args: readonly string[], options?: { timeoutMs?: number; cwd?: string }): Promise<CommandResult>;
}

export const nodeCommandExecutor: CommandExecutor = {
  run(command, args, options = {}) {
    return new Promise((resolve, reject) => {
      execFile(
        command,
        [...args],
        {
          cwd: options.cwd,
          timeout: options.timeoutMs ?? 10_000,
          windowsHide: true,
          encoding: "utf8",
          maxBuffer: 4 * 1024 * 1024
        },
        (error, stdout, stderr) => {
          const errorCode = error?.code;
          const exitCode = typeof errorCode === "number" ? errorCode : error ? 1 : 0;
          if (errorCode === "ENOENT") {
            reject(new Error(`Executable not found: ${command}`));
            return;
          }
          resolve({ stdout: String(stdout ?? ""), stderr: String(stderr ?? ""), exitCode });
        }
      );
    });
  }
};

