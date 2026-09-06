import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { loadConfig } from '../dist/config.js';
import { PathGuard } from '../dist/guard.js';
import { runBash } from '../dist/bashOps.js';
import { shellInvocation } from '../dist/commandShell.js';
import { assessCommandSafety } from '../dist/commandSafety.js';

const root = await fs.mkdtemp(path.join(os.tmpdir(), 'codexpro platform '));
const cli = path.resolve('scripts/codexpro.mjs');
try {
  const nested = path.join(root, 'packages', 'web app');
  await fs.mkdir(nested, { recursive: true });
  await fs.writeFile(path.join(nested, 'probe.cjs'), 'console.log(process.cwd()); console.error("stderr-ok"); process.exit(Number(process.argv[2] || 0));');
  await fs.writeFile(path.join(nested, 'package.json'), JSON.stringify({ scripts: { check: 'node probe.cjs' } }));
  const config = { ...loadConfig(['--root', root, '--allow-root', root]), bashMode: 'safe', commandShell: 'auto' };
  const guard = new PathGuard(config);
  const workspace = { id: 'platform', root, openedAt: new Date().toISOString() };
  const run = (command, options = {}) => runBash(config, guard, workspace, command, { cwd: 'packages/web app', ...options });
  const result = await run('node probe.cjs 7');
  console.log('Native command completed');
  assert.equal(result.exitCode, 7, JSON.stringify(result));
  assert.match(result.stdout, /web app/);
  assert.match(result.stderr, /stderr-ok/);
  assert.equal((await run('npm run check')).exitCode, 0);
  if (process.platform === 'win32') assert.match((await run("Write-Output 'caffè 日本語'")).stdout, /caffè 日本語/);
  console.log('Nested npm script completed');
  await assert.rejects(run('echo bad', { cwd: '..' }), /escapes/);
  await assert.rejects(run('echo bad', { cwd: 'missing' }), /not a directory/);
  await assert.rejects(run('echo bad', { cwd: 'packages/web app/probe.cjs' }), /not a directory/);
  await fs.writeFile(path.join(nested, 'wait.cjs'), 'setTimeout(() => {}, 15000);');
  assert.match((await run('node wait.cjs', { timeoutMs: 1000 })).stderr, /timed out/);
  await fs.writeFile(path.join(nested, 'output.cjs'), 'setInterval(() => process.stdout.write("x".repeat(4096)), 1);');
  const limited = await runBash({ ...config, maxOutputBytes: 4000 }, guard, workspace, 'node output.cjs', { cwd: 'packages/web app', timeoutMs: 15000 });
  assert.equal(limited.truncated, true);
  assert.ok(limited.durationMs < 8000, JSON.stringify(limited));
  for (const command of ['Remove-Item C:\\ -Recurse', 'rd /s /q C:\\', 'format.exe C:', 'git.exe reset --hard', 'r\\m -rf /', 'C:\\Windows\\System32\\format.exe C:', 'type C:\\repo\\.env']) {
    assert.equal(assessCommandSafety(command, workspace).allowed, false, command);
  }
  assert.equal(spawnSync('git', ['init', root], { windowsHide: true }).status, 0);
  const cliRun = (args) => spawnSync(process.execPath, [cli, ...args], {
    cwd: nested, encoding: 'utf8', windowsHide: true,
    env: { ...process.env, CODEXPRO_ROOT: '', CODEXPRO_HOME: path.join(root, 'profiles-home') }
  });
  const discovered = cliRun(['settings', 'show']);
  assert.equal(discovered.status, 0, discovered.stderr);
  assert.ok(discovered.stdout.includes(root), discovered.stdout);
  assert.ok(!discovered.stdout.includes(nested), discovered.stdout);
  const explicit = cliRun(['settings', 'show', '--root', nested]);
  assert.equal(explicit.status, 0, explicit.stderr);
  assert.match(explicit.stdout, /packages/, explicit.stdout);
  assert.equal(cliRun(['settings', 'set', '--tunnel', 'none', '--shell', 'wsl', '--wsl-distribution', 'Ubuntu']).status, 0);
  assert.match(cliRun(['settings', 'show']).stdout, /Ubuntu/);
  if (process.platform === 'win32') {
    assert.equal((await run('node "probe.cjs" 3', { shell: 'cmd' })).exitCode, 3);
    const invocation = shellInvocation('wsl', 'pwd', nested, 'Ubuntu');
    assert.deepEqual(invocation.args, ['--distribution', 'Ubuntu', '--cd', nested, '--exec', 'bash', '-c', 'pwd']);
    const distro = process.env.CODEXPRO_WSL_DISTRIBUTION;
    config.wslDistribution = distro;
    const available = spawnSync('wsl.exe', [...(distro ? ['--distribution', distro] : []), '--exec', 'bash', '-c', 'true'], { timeout: 10000, windowsHide: true });
    if (available.status === 0) {
      const wsl = await run('pwd', { shell: 'wsl' });
      assert.equal(wsl.exitCode, 0, JSON.stringify(wsl));
      assert.match(wsl.stdout, /packages\/web app/);
      const timeout = await run('sleep 15', { shell: 'wsl', timeoutMs: 1000 });
      assert.match(timeout.stderr, /timed out/);
      assert.ok(timeout.durationMs < 8000, JSON.stringify(timeout));
    } else console.log('WSL runtime unavailable; invocation checked, integration skipped.');
  }
  console.log('Platform smoke passed');
} finally {
  await fs.rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 });
}
