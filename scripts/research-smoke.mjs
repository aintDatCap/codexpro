import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createCodexProServer } from '../dist/server.js';
import { loadConfig } from '../dist/config.js';
import { OutputStore } from '../dist/outputStore.js';

const root = await fs.mkdtemp(path.join(os.tmpdir(), 'codexpro-research-'));
const connections = [];
try {
  const nested = path.join(root, 'nested');
  await fs.mkdir(nested);
  await fs.writeFile(path.join(nested, 'sample.txt'), 'before\nNeedle\nafter\n' + 'Needle\n'.repeat(60));
  await fs.writeFile(path.join(nested, 'output.cjs'), 'console.log("日本語😀".repeat(12000)); console.log("FINAL-MARKER");');
  const config = { ...loadConfig(['--root', root, '--allow-root', root]), maxOutputBytes: 4000, toolCards: false };
  const roots = new Map();
  async function connect(known = roots) {
    const server = createCodexProServer(config, known);
    const client = new Client({ name: 'research-smoke', version: '1' });
    const [a, b] = InMemoryTransport.createLinkedPair();
    connections.push({ client, server });
    await server.connect(a);
    await client.connect(b);
    return async (name, args = {}) => client.callTool({ name, arguments: args });
  }
  const first = await connect();
  const opened = await first('open_workspace', { root: nested, include_tree: false });
  const workspace_id = opened.structuredContent.workspace_id;
  const second = await connect();
  assert.equal((await second('read', { path: 'sample.txt' })).isError, true, 'selection must not leak');
  assert.notEqual((await second('read', { workspace_id, path: 'sample.txt' })).isError, true, 'nested ID must survive reconnect');
  assert.notEqual((await second('reconnect_workspace', { workspace_id })).isError, true);
  assert.notEqual((await second('read', { path: 'sample.txt' })).isError, true);
  const restarted = await connect(new Map());
  assert.equal((await restarted('reconnect_workspace', { workspace_id, root })).isError, true);
  assert.notEqual((await restarted('reconnect_workspace', { workspace_id, root: nested })).isError, true);
  assert.equal((await second('bash', { command: 'echo outside', cwd: '..' })).isError, true);
  const result = await second('bash', { command: 'node output.cjs' });
  assert.notEqual(result.isError, true);
  const data = result.structuredContent;
  assert.equal(data.exitCode, 0, JSON.stringify(data));
  assert.equal(data.effective_cwd, await fs.realpath(nested));
  assert.equal(data.termination_reason, 'exit');
  assert.equal(data.truncated, true);
  let offset = 0, output = '';
  do {
    const page = await second('read_output', { workspace_id, output_resource_id: data.output_resource_id, offset, max_chars: 1999 });
    assert.notEqual(page.isError, true);
    assert.notEqual(page.structuredContent.output_limited, true);
    assert.equal(page.structuredContent.incomplete, false);
    output += page.structuredContent.text;
    offset = page.structuredContent.next_offset;
  } while (offset !== null);
  assert.equal(output.trimEnd(), '日本語😀'.repeat(12000) + '\nFINAL-MARKER');
  assert.equal((await first('read_output', { workspace_id, output_resource_id: data.output_resource_id })).isError, true, 'outputs are session-local');
  const search = await second('search', { query: 'needle', case_sensitive: false, context_before: 1, context_after: 1 });
  assert.notEqual(search.isError, true);
  assert.match(search.structuredContent.matches[0].context, /before/);
  // Use a larger wire budget to prove the old per-file 50-match cap is gone.
  const { searchWorkspace } = await import('../dist/searchOps.js');
  const { PathGuard } = await import('../dist/guard.js');
  const scanConfig = { ...config, maxOutputBytes: 100000 };
  const scan = await searchWorkspace(scanConfig, new PathGuard(scanConfig), { id: workspace_id, root: nested }, { query: 'Needle', maxResults: 100 });
  assert.equal(scan.matches.length, 61);
  if (process.platform === 'win32') {
    const progress = await second('bash', { command: "Write-Progress -Activity 'noise' -Status 'working'; Write-Output 'clean'" });
    assert.equal(progress.structuredContent.stderr, '');
    assert.match(progress.structuredContent.stdout, /clean/);
  }
  const store = new OutputStore();
  const expired = store.save('a', 'one', '', false);
  assert.throws(() => store.read('b', expired, 'stdout'), /unavailable/);
  for (let i = 0; i < 4; i++) store.save('a', 'next', '', false);
  assert.throws(() => store.read('a', expired, 'stdout'), /unavailable/);
  console.log('Research smoke passed');
} finally {
  for (const { client, server } of connections) { await client.close(); await server.close(); }
  await fs.rm(root, { recursive: true, force: true, maxRetries: 5 });
}
