import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const helperPath = fileURLToPath(new URL('./windows-keep-awake.ps1', import.meta.url));

/**
 * Acquire an opt-in, process-scoped Windows system power request.
 * Power requests belong to the PowerShell thread, not the parent Node thread.
 * Keeping its stdin pipe open ensures a crashed launcher cannot leave a request behind.
 */
export async function startWindowsKeepAwake({ command = 'powershell.exe', timeoutMs = 10_000 } = {}) {
  if (process.platform !== 'win32') throw new Error('The Windows awake guard requires Windows.');
  const child = spawn(command, [
    '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', helperPath
  ], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });

  let errors = '';
  let stopping = false;
  child.stderr.on('data', (chunk) => { errors = (errors + String(chunk)).slice(-2048); });
  child.stdin.on('error', () => { /* The helper may have exited before the launcher closes stdin. */ });
  // Keep a permanent error listener: a late error after startup must not crash the launcher.
  child.on('error', (error) => {
    if (!stopping) console.error(`[codexpro] Windows awake helper error: ${error.message}`);
  });

  try {
    await new Promise((resolve, reject) => {
      let output = '';
      const timer = setTimeout(() => finish(new Error('Power request helper did not become ready.')), timeoutMs);
      const onData = (chunk) => {
        output = (output + String(chunk)).slice(-4096);
        if (output.includes('CODEXPRO_AWAKE_READY')) finish();
      };
      const onExit = (code) => finish(new Error(`Power request helper exited (code=${code}): ${errors.trim()}`));
      const onError = (error) => finish(error);
      function finish(error) {
        clearTimeout(timer);
        child.stdout.off('data', onData);
        child.off('exit', onExit);
        child.off('error', onError);
        if (error) reject(error);
        else resolve();
      }
      child.stdout.on('data', onData);
      child.once('exit', onExit);
      child.once('error', onError);
    });
  } catch (error) {
    child.stdin.destroy();
    child.kill();
    throw error;
  }

  child.once('exit', (code) => {
    if (!stopping) console.error(`[codexpro] Windows awake helper exited unexpectedly (code=${code}). Automatic sleep is no longer inhibited.`);
  });
  return {
    pid: child.pid,
    async stop() {
      if (stopping) return;
      stopping = true;
      if (child.exitCode !== null || child.signalCode !== null) return;
      await new Promise((resolve) => {
        const timer = setTimeout(() => { child.kill(); resolve(); }, 3_000);
        child.once('exit', () => { clearTimeout(timer); resolve(); });
        child.stdin.end();
      });
    }
  };
}
