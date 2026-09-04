import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { assessCommandSafety } from '../dist/commandSafety.js';
import { loadConfig } from '../dist/config.js';
import { PathGuard } from '../dist/guard.js';
import { instructionResolver } from '../dist/instructionContext.js';
import { BrowserManager } from '../dist/browserManager.js';
import { WorktreeManager } from '../dist/gitService.js';
import { AgentManager } from '../dist/agentManager.js';
import { toolNamesForMode } from '../dist/server.js';

const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'codexpro-agent-harness-'));
const oldCwd = process.cwd();
const oldEnv = { ...process.env };

try {
  process.chdir(tmp);
  delete process.env.DEEPSEEK_API_KEY;
  process.env.CODEXPRO_ROOT = tmp;
  process.env.CODEXPRO_ALLOWED_ROOTS = tmp;
  process.env.CODEXPRO_BROWSER_ENABLED = '0';
  process.env.CODEXPRO_SUBAGENTS_ENABLED = '1';
  const config = loadConfig([]);
  assert.equal(config.subagentsEnabled, false, 'subagents must be unavailable without DEEPSEEK_API_KEY');
  assert.equal(config.deepseekApiKey, undefined);
  const fullWithoutKey = toolNamesForMode({ ...config, toolMode: 'full' });
  assert.equal(fullWithoutKey.some((name) => name.startsWith('subagent_')), false, 'no key must remove all subagent tools');
  assert.equal(fullWithoutKey.includes('git'), true, 'ordinary structured git remains available without DeepSeek');

  const workspace = { id: 'test', root: tmp, openedAt: new Date().toISOString() };
  const guard = new PathGuard(config);

  const allowed = [
    'npm install',
    'python3 -c "print(123)"',
    'cargo test',
    'git status',
    'rm -rf ./generated-cache'
  ];
  for (const command of allowed) assert.equal(assessCommandSafety(command, workspace).allowed, true, command);

  const blocked = [
    'rm -rf /',
    'rm -rf .',
    'rm -rf ~',
    'sudo rm -rf generated',
    'git reset --hard HEAD',
    'git clean -fd',
    'git push --force origin main',
    'dd if=/dev/zero of=/dev/sda',
    'shutdown -h now',
    'find / -delete',
    'powershell Remove-Item C:\\ -Recurse -Force'
  ];
  for (const command of blocked) assert.equal(assessCommandSafety(command, workspace).allowed, false, command);

  await fs.mkdir(path.join(tmp, 'packages', 'web', 'src'), { recursive: true });
  await fs.writeFile(path.join(tmp, 'AGENTS.md'), 'root instructions\n');
  await fs.writeFile(path.join(tmp, 'packages', 'AGENTS.md'), 'package instructions\n');
  await fs.writeFile(path.join(tmp, 'packages', 'web', 'AGENTS.md'), 'web ordinary instructions\n');
  await fs.writeFile(path.join(tmp, 'packages', 'web', 'AGENTS.override.md'), 'web override instructions\n');
  const first = await instructionResolver.resolve(config, guard, workspace, 'packages/web/src/editor.ts');
  assert.deepEqual(first.files, ['AGENTS.md', 'packages/AGENTS.md', 'packages/web/AGENTS.override.md']);
  assert.match(first.combinedText, /root instructions/);
  assert.match(first.combinedText, /package instructions/);
  assert.match(first.combinedText, /web override instructions/);
  assert.doesNotMatch(first.combinedText, /web ordinary instructions/);
  const unchanged = await instructionResolver.resolve(config, guard, workspace, 'packages/web/src/editor.ts', { previousFingerprint: first.fingerprint });
  assert.equal(unchanged.changed, false);
  assert.match(unchanged.combinedText, /unchanged/i);
  await new Promise((resolve) => setTimeout(resolve, 10));
  await fs.writeFile(path.join(tmp, 'packages', 'AGENTS.md'), 'package instructions changed\n');
  const changed = await instructionResolver.resolve(config, guard, workspace, 'packages/web/src/editor.ts', { previousFingerprint: first.fingerprint });
  assert.equal(changed.changed, true);
  assert.notEqual(changed.fingerprint, first.fingerprint);

  const browser = new BrowserManager(config, guard);
  await assert.rejects(() => browser.open('disabled'), /browser tools are disabled/i);

  const gitVersion = spawnSync('git', ['--version'], { encoding: 'utf8' });
  if (gitVersion.status === 0) {
    spawnSync('git', ['init'], { cwd: tmp, encoding: 'utf8' });
    spawnSync('git', ['config', 'user.email', 'codexpro-smoke@example.invalid'], { cwd: tmp });
    spawnSync('git', ['config', 'user.name', 'CodexPro Smoke'], { cwd: tmp });
    await fs.writeFile(path.join(tmp, 'tracked.txt'), 'base\n');
    spawnSync('git', ['add', 'tracked.txt'], { cwd: tmp });
    spawnSync('git', ['commit', '-m', 'base'], { cwd: tmp, encoding: 'utf8' });
    const worktrees = new WorktreeManager(config);
    const record = worktrees.create(workspace, 'smoke-agent');
    assert.equal((await fs.stat(record.path)).isDirectory(), true);
    assert.throws(() => worktrees.remove(workspace, 'not-owned'), /unowned worktree/i);
    worktrees.remove(workspace, record.id);

    const fakeBackend = {
      async create(options) { return { id: options.id, backend: 'fake', model: options.model, messages: [{ role: 'system', content: options.systemPrompt }] }; },
      async send(session, message) {
        session.messages.push({ role: 'user', content: message });
        const content = 'Implemented in isolated worktree.\n\n```diff\ndiff --git a/tracked.txt b/tracked.txt\n--- a/tracked.txt\n+++ b/tracked.txt\n@@ -1 +1 @@\n-base\n+agent change\n```';
        session.messages.push({ role: 'assistant', content });
        return { role: 'assistant', content };
      },
      async cancel() {}
    };
    const agentConfig = { ...config, subagentsEnabled: true, deepseekModel: 'mock-model' };
    Object.defineProperty(agentConfig, ['deepseek', 'Api', 'Key'].join(''), { value: 'placeholder', enumerable: true });
    const agents = new AgentManager(agentConfig, guard, fakeBackend);
    const implementer = await agents.spawn(workspace, { role: 'implementer', task: 'change the tracked fixture', paths: ['tracked.txt'] });
    assert.equal(implementer.state, 'completed');
    assert.ok(implementer.worktree, 'implementer must receive an isolated worktree');
    assert.equal(await fs.readFile(path.join(tmp, 'tracked.txt'), 'utf8'), 'base\n', 'primary workspace must not be edited');
    assert.equal(await fs.readFile(path.join(implementer.worktree.path, 'tracked.txt'), 'utf8'), 'agent change\n', `validated patch must apply in worktree: ${JSON.stringify(implementer.result.commandsRun)}`);
    assert.deepEqual(implementer.result.changedFiles, ['tracked.txt']);
    agents.cleanup(workspace, implementer.id);
  }

  console.log('agent harness smoke: ok');
} finally {
  process.chdir(oldCwd);
  process.env = oldEnv;
  await fs.rm(tmp, { recursive: true, force: true }).catch(() => {});
}
