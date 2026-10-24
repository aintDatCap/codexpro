import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

async function freePort() {
  const server = net.createServer();
  return await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      server.close(() => resolve(address.port));
    });
  });
}

const root = await fs.mkdtemp(path.join(os.tmpdir(), 'codexpro-multiconnection-smoke-'));
const port = await freePort();
const base = `http://127.0.0.1:${port}`;
const server = spawn(process.execPath, ['dist/http.js'], {
  cwd: path.resolve('.'),
  env: {
    ...process.env,
    CODEXPRO_HOME: path.join(root, 'home'),
    CODEXPRO_ROOT: root,
    CODEXPRO_ALLOWED_ROOTS: root,
    CODEXPRO_HOST: '127.0.0.1',
    CODEXPRO_PORT: String(port),
    CODEXPRO_ALLOW_NO_HTTP_TOKEN: '1',
    CODEXPRO_HTTP_TOKEN: '',
    CODEXPRO_MAX_HTTP_SESSIONS: '4',
    CODEXPRO_SUBAGENT_PROVIDER: 'off',
    CODEXPRO_CHATGPT_BROWSER_AUTO_START: '0'
  },
  stdio: ['ignore', 'ignore', 'pipe']
});
let stderr = '';
server.stderr.on('data', data => { stderr += String(data).slice(-10000); });
const connections = [];

async function connectClient() {
  const client = new Client({ name: 'multiconnection-smoke', version: '1.0.0' });
  const transport = new StreamableHTTPClientTransport(new URL(`${base}/mcp`));
  try {
    await client.connect(transport);
  } catch (error) {
    await client.close().catch(() => {});
    throw error;
  }
  connections.push(client);
  assert.ok(transport.sessionId);
  return { client, transport };
}

try {
  const start = Date.now();
  while (true) {
    if (server.exitCode !== null) throw new Error(`server exited: ${stderr}`);
    try {
      const response = await fetch(`${base}/healthz`);
      if (response.ok) break;
    } catch {}
    if (Date.now() - start > 15000) throw new Error(`server startup timed out: ${stderr}`);
    await new Promise(resolve => setTimeout(resolve, 100));
  }

  for (let index = 0; index < 4; index++) {
    const { client, transport } = await connectClient();
    await client.listTools();
    // The SDK already maintains a long-lived GET event stream for this session.
    // A second GET is rejected with 409 while that stream is connected.
    const duplicate = await fetch(`${base}/mcp`, {
      method: 'GET',
      headers: { accept: 'text/event-stream', 'mcp-session-id': transport.sessionId }
    });
    assert.equal(duplicate.status, 409, `client ${index} should retain its SSE subscription`);
    await duplicate.body?.cancel();
  }

  const fifth = await fetch(`${base}/mcp`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
    body: JSON.stringify({
      jsonrpc: '2.0', id: 7, method: 'initialize',
      params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'fifth', version: '1.0' } }
    })
  });
  assert.equal(fifth.status, 503, 'when all sessions have live SSE streams, a new connection must not evict one of them');
  await fifth.body?.cancel();
  for (const client of connections) {
    const tools = await client.listTools();
    assert.ok(tools.tools.length, 'all established clients must remain usable');
  }
  const health = await (await fetch(`${base}/healthz`)).json();
  assert.equal(health.transports.active, 4);

  // Release the first group, then race eight independent initializations.
  // Reservations must prevent more than four sessions being admitted.
  for (const client of connections.splice(0)) await client.close();
  const parallel = await Promise.allSettled(Array.from({ length: 8 }, () => connectClient()));
  const admitted = parallel.filter(result => result.status === 'fulfilled');
  const rejected = parallel.filter(result => result.status === 'rejected');
  assert.equal(admitted.length, 4, 'only the configured number of parallel sessions should initialize');
  assert.equal(rejected.length, 4, 'excess simultaneous sessions must fail without evicting peers');
  for (const { value: { client } } of admitted) {
    const tools = await client.listTools();
    assert.ok(tools.tools.length, 'admitted parallel clients must remain usable');
  }
  const parallelHealth = await (await fetch(`${base}/healthz`)).json();
  assert.equal(parallelHealth.transports.active, 4);
  console.log('HTTP multiconnection smoke passed');
} finally {
  for (const client of connections) await client.close().catch(() => {});
  server.kill('SIGTERM');
  await fs.rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
}
