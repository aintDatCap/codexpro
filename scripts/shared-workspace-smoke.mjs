import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { loadConfig } from '../dist/config.js';
import { createCodexProServer } from '../dist/server.js';
import { RuntimeServices } from '../dist/runtimeServices.js';

const root = await fs.mkdtemp(path.join(os.tmpdir(), 'codexpro-shared-workspace-'));
const alt = path.join(root, 'alternative');
await fs.mkdir(alt);
await fs.writeFile(path.join(root, 'shared.txt'), 'initial');
await fs.writeFile(path.join(alt, 'alternate.txt'), 'alternate');
const config = { ...loadConfig(['--root', root, '--allow-root', root]), toolMode: 'full', writeMode: 'workspace', chatgptBrowserAutoStart: false };
const fakeBackend = {
  name: 'fixture',
  model: 'fixture-model',
  async create(options) {
    return { id: options.id, backend: 'fixture', model: options.model, messages: [] };
  },
  async send() { return { role: 'assistant', content: 'Fixture subagent completed.' }; },
  async cancel() {},
  async close() {}
};
const runtime = new RuntimeServices(config, { agentBackend: fakeBackend });
const connections = [];
async function connect() {
  // These distinct transports intentionally share the same process-owned services,
  // and do not send any custom client identifiers.
  const server = createCodexProServer(config, new Map(), { runtime });
  const client = new Client({ name: 'concurrent-chat-fixture', version: '1.0' });
  const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  connections.push({ server, client });
  return async (name, args = {}) => client.callTool({ name, arguments: args });
}
try {
  const [a, b] = await Promise.all([connect(), connect()]);
  const [wa, wb] = await Promise.all([
    a('open_workspace', { root: alt, include_tree: false }),
    b('open_workspace', { root: alt, include_tree: false })
  ]);
  assert.equal(wa.isError, undefined);
  assert.equal(wb.isError, undefined);
  const altId = wa.structuredContent.workspace_id;
  assert.equal(altId, wb.structuredContent.workspace_id, 'workspace identity must be path-based');
  const [readA, readB] = await Promise.all([
    a('read', { path: 'shared.txt' }),
    b('read', { path: 'shared.txt' })
  ]);
  assert.equal(readA.isError, undefined);
  assert.equal(readB.isError, undefined);
  assert.equal(readA.structuredContent.sha256, readB.structuredContent.sha256);
  const staleSha = readA.structuredContent.sha256;

  // Concurrent compare-and-swap writers: one can commit, the other must fail.
  const [writeA, writeB] = await Promise.all([
    a('write', { path: 'shared.txt', content: 'from-a', expected_sha256: staleSha }),
    b('write', { path: 'shared.txt', content: 'from-b', expected_sha256: staleSha })
  ]);
  assert.equal(Number(Boolean(writeA.isError)) + Number(Boolean(writeB.isError)), 1,
    'overlapping compare-and-swap writes must reject exactly one stale update');
  assert.ok(['from-a', 'from-b'].includes(await fs.readFile(path.join(root, 'shared.txt'), 'utf8')));

  // Do not serialize unrelated writes across the entire repository.
  const [first, second] = await Promise.all([
    a('write', { workspace_id: altId, path: 'a.txt', content: 'A' }),
    b('write', { workspace_id: altId, path: 'b.txt', content: 'B' })
  ]);
  assert.equal(first.isError, undefined);
  assert.equal(second.isError, undefined);
  assert.equal(await fs.readFile(path.join(alt, 'a.txt'), 'utf8'), 'A');
  assert.equal(await fs.readFile(path.join(alt, 'b.txt'), 'utf8'), 'B');

  // Independently invoked MCP tools can use the same process-owned subagent service.
  // A manual per-chat client_id must not be required to spawn or inspect a worker.
  const [agentA, agentB] = await Promise.all([
    a('subagent_spawn', { role: 'explorer', task: 'Inspect project A.' }),
    b('subagent_spawn', { role: 'tester', task: 'Inspect project B.' })
  ]);
  assert.notEqual(agentA.isError, true, 'first agent failed');
  assert.notEqual(agentB.isError, true, 'second agent failed');
  assert.notEqual(agentA.structuredContent.id, agentB.structuredContent.id);
  const viewedFromOtherTransport = await b('subagent_status', {
    id: agentA.structuredContent.id
  });
  assert.equal(viewedFromOtherTransport.isError, undefined);
  assert.equal(viewedFromOtherTransport.structuredContent.agents[0].id, agentA.structuredContent.id);
  const runtimeStatus = await a('runtime_status');
  assert.equal(runtimeStatus.structuredContent.runtime.logicalAgentCount, 2);

  // Explicit targeting must not mutate the implicit default for either conversation.
  const [altRead, defaultRead] = await Promise.all([
    a('read', { workspace_id: altId, path: 'alternate.txt' }),
    b('read', { path: 'shared.txt' })
  ]);
  assert.match(altRead.structuredContent.text, /alternate/);
  assert.ok(defaultRead.structuredContent.sha256);
  const accidentallySelected = await b('read', { path: 'alternate.txt' });
  assert.equal(accidentallySelected.isError, true, 'workspace selection may not leak');
  const outside = await a('write', { workspace_id: altId, path: '../../outside.txt', content: 'blocked' });
  assert.equal(outside.isError, true, 'path guard must remain enforced');
  const hidden = await b('read', { path: '.env' });
  assert.equal(hidden.isError, true, 'blocked file protection must remain enforced');
  console.log('Shared workspace concurrency smoke passed');
} finally {
  for (const { client, server } of connections) {
    await client.close().catch(() => {});
    await server.close().catch(() => {});
  }
  await runtime.shutdown();
  await fs.rm(root, { recursive: true, force: true, maxRetries: 5 });
}
