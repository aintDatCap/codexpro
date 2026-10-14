import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';

async function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      server.close(() => address && typeof address !== 'string' ? resolve(address.port) : reject(new Error('no port')));
    });
  });
}

async function waitUntil(read, timeoutMs = 15_000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const result = await read().catch(() => null);
    if (result) return result;
    await new Promise((resolve) => setTimeout(resolve, 75));
  }
  throw new Error('Timed out waiting for launcher startup/exit');
}

const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'codexpro-launcher-liveness-'));
const root = path.join(tmp, 'root');
const home = path.join(tmp, 'home');
await fs.mkdir(root);
const port = await freePort();
const launcher = spawn(process.execPath, [
  'scripts/codexpro.mjs', 'start', '--root', root,
  '--port', String(port), '--tunnel', 'none', '--no-auth', '--no-profile',
  '--no-chatgpt-browser-auto-start'
], {
  cwd: path.resolve('.'),
  env: { ...process.env, CODEXPRO_HOME: home, CODEXPRO_SUBAGENT_PROVIDER: 'off' },
  stdio: ['pipe', 'pipe', 'pipe'],
  windowsHide: true
});
let output = '';
launcher.stdout.on('data', (chunk) => { output += String(chunk); });
launcher.stderr.on('data', (chunk) => { output += String(chunk); });

try {
  const status = await waitUntil(async () => {
    const files = await fs.readdir(path.join(home, 'runtime'));
    if (!files.length) return null;
    const record = JSON.parse(await fs.readFile(path.join(home, 'runtime', files[0]), 'utf8'));
    return record.runtimePid ? record : null;
  });
  assert.ok(status.runtimePid > 0);
  await waitUntil(async () => {
    const response = await fetch(`http://127.0.0.1:${port}/healthz`);
    return response.ok;
  });
  process.kill(status.runtimePid, 'SIGTERM');
  const exit = await waitUntil(() => launcher.exitCode !== null || launcher.signalCode !== null
    ? Promise.resolve({ code: launcher.exitCode ?? -1 })
    : Promise.resolve(null), 20_000);
  assert.notEqual(exit.code, 0, 'launcher must fail, not stay silently alive');
  assert.match(output, /HTTP runtime exited unexpectedly/, 'must report why the service died');
  const entries = await fs.readdir(path.join(home, 'runtime')).catch(() => []);
  assert.equal(entries.length, 0, 'launcher must clean up stale runtime record');
  console.log('launcher liveness smoke passed');
} finally {
  if (launcher.exitCode === null && launcher.signalCode === null) {
    launcher.stdin.write('q\n');
    launcher.kill('SIGTERM');
  }
  await fs.rm(tmp, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
}
