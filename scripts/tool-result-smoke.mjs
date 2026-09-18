import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createCodexProServer } from '../dist/server.js';
import { loadConfig } from '../dist/config.js';

const root = await fs.mkdtemp(path.join(os.tmpdir(), 'codexpro-result-'));
try {
  execFileSync('git', ['init'], { cwd: root, stdio: 'ignore' });
  execFileSync('git', ['config', 'user.email', 'smoke@example.invalid'], { cwd: root });
  execFileSync('git', ['config', 'user.name', 'CodexPro Smoke'], { cwd: root });
  await fs.writeFile(path.join(root, 'package.json'), JSON.stringify({ name: 'fixture' }));
  await fs.mkdir(path.join(root, 'packages', 'web'), { recursive: true });
  await fs.writeFile(path.join(root, 'packages', 'web', 'package.json'), JSON.stringify({ name: '@fixture/web' }));
  await fs.writeFile(path.join(root, 'tracked.txt'), 'tracked\n');
  execFileSync('git', ['add', '.'], { cwd: root });
  execFileSync('git', ['commit', '-m', 'fixture'], { cwd: root, stdio: 'ignore' });
  await fs.writeFile(path.join(root, 'large.ts'), Array.from({ length: 1500 }, (_, i) => `export function value${i}() { return ${i}; }`).join('\n'));
  await fs.writeFile(path.join(root, 'draft.txt'), 'first line\nsecond line\n');
  const config = { ...loadConfig(['--root', root, '--allow-root', root]), toolCards: false };
  const server = createCodexProServer(config);
  const client = new Client({ name: 'result-smoke', version: '1' });
  const [a, b] = InMemoryTransport.createLinkedPair();
  try {
    await server.connect(a);
    await client.connect(b);
    const compact = await client.callTool({ name: 'inspect_workspace', arguments: {} });
    assert.deepEqual(compact.structuredContent.symbols, [], 'default inspection must omit symbols');
    assert.deepEqual(compact.structuredContent.relationships, [], 'default inspection must omit relationships');
    assert.ok(compact.structuredContent.project_summaries.some((item) => item.path === 'packages/web'));

    const review = await client.callTool({ name: 'show_changes', arguments: { since: 'workspace', mark_reviewed: false } });
    assert.notEqual(review.isError, true);
    assert.match(review.structuredContent.diff, /new file mode 100644/);
    assert.match(review.structuredContent.diff, /\+first line/);
    assert.ok(review.structuredContent.additions >= 2, 'untracked additions must contribute to diff stats');

    const args = { max_symbols: 100000, max_relationships: 250000 };
    for (const request of [{ name: 'inspect_workspace', arguments: args }, { name: 'codexpro', arguments: { action: 'inspect_workspace', args } }]) {
      const result = await client.callTool(request);
      assert.notEqual(result.isError, true);
      const bytes = Buffer.byteLength(JSON.stringify(result.structuredContent));
      console.log(`${request.name}: ${bytes} structured bytes`);
      assert.ok(bytes < 70000, 'tool inspector must not receive an unbounded structured tree');
      assert.equal(result.structuredContent.output_limited, true);
      assert.match(result.content.map((block) => block.text ?? '').join('\n'), /narrower/i);
    }
    const narrow = await client.callTool({ name: 'read', arguments: { path: 'large.ts', start_line: 1, end_line: 2 } });
    assert.notEqual(narrow.isError, true);
    assert.match(narrow.content[0].text, /value0/);
    assert.match(narrow.content[0].text, /value1/);
    assert.notEqual(narrow.structuredContent.output_limited, true, 'small reads must remain complete');
    await fs.writeFile(path.join(root, 'wide.txt'), 'λ'.repeat(70000));
    const largeRead = await client.callTool({ name: 'read', arguments: { path: 'wide.txt' } });
    assert.notEqual(largeRead.isError, true);
    assert.equal(largeRead.structuredContent.text_output_limited, true);
    assert.ok(Buffer.byteLength(largeRead.content.map((block) => block.text ?? '').join('')) < 121000);
    assert.ok(Buffer.byteLength(JSON.stringify(largeRead.structuredContent)) < 70000);
    assert.doesNotMatch(largeRead.content[0].text, /\uFFFD/, 'UTF-8 truncation must not split a character');
    const missing = await client.callTool({ name: 'read', arguments: { path: 'missing.txt' } });
    assert.equal(missing.isError, true, 'response limiting must preserve tool errors');
  } finally {
    await client.close();
    await server.close();
  }
} finally {
  await fs.rm(root, { recursive: true, force: true, maxRetries: 5 });
}
console.log('Tool result smoke passed');
