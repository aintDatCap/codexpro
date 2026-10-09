import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createCodexProServer, toolNamesForMode } from '../dist/server.js';
import { loadConfig } from '../dist/config.js';
import { BrowserManager } from '../dist/browserManager.js';
import { PathGuard } from '../dist/guard.js';

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

    const screenshotPayload = Buffer.from('native-browser-image');
    const screenshotData = screenshotPayload.toString('base64');
    const previewCalls = [];
    const fakeBrowserManager = {
      async preview(url, workspace, options, owner) {
        previewCalls.push({ url, workspace, options, owner });
        return {
          sessionId: 'preview-image', activeTab: 0, tabCount: 1, title: 'Screenshot fixture',
          url, path: '.ai-bridge/preview.png', mimeType: 'image/png',
          bytes: screenshotPayload.byteLength, sha256: '0'.repeat(64), data: screenshotData
        };
      },
      async screenshot() {
        return {
          sessionId: 'native-image', activeTab: 0, tabCount: 1, title: 'Screenshot fixture',
          url: 'https://example.invalid/', path: '.ai-bridge/native-browser.png', mimeType: 'image/png',
          bytes: screenshotPayload.byteLength, sha256: '0'.repeat(64), data: screenshotData
        };
      }
    };
    const browserConfig = { ...config, browserEnabled: true, toolMode: 'standard' };
    assert.ok(toolNamesForMode(browserConfig).includes('browser_preview'));
    assert.ok(!toolNamesForMode({ ...browserConfig, browserEnabled: false }).includes('browser_preview'));
    assert.ok(!toolNamesForMode({ ...browserConfig, toolMode: 'minimal' }).includes('browser_preview'));
    const browserServer = createCodexProServer(browserConfig, new Map(), { browserManager: fakeBrowserManager });
    const browserClient = new Client({ name: 'browser-result-smoke', version: '1' });
    const [browserTransport, browserClientTransport] = InMemoryTransport.createLinkedPair();
    try {
      await browserServer.connect(browserTransport);
      await browserClient.connect(browserClientTransport);
      const tools = await browserClient.listTools();
      assert.equal(tools.tools.some((tool) => tool.name === 'browser'), true, 'standard mode must expose enabled browser');
      assert.equal(tools.tools.some((tool) => tool.name === 'browser_preview'), true, 'standard mode must expose enabled browser_preview');
      const result = await browserClient.callTool({
        name: 'browser',
        arguments: { action: 'screenshot', session_id: 'native-image', output_path: '.ai-bridge/native-browser.png' }
      });
      assert.notEqual(result.isError, true);
      const image = result.content.find((block) => block.type === 'image');
      assert.ok(image, 'browser screenshot must return native MCP image content');
      assert.equal(image.mimeType, 'image/png');
      assert.equal(image.data, screenshotData);
      assert.equal(result.structuredContent.result.data, undefined, 'base64 image data must not be duplicated into structured content');
      assert.equal(result.structuredContent.result.path, '.ai-bridge/native-browser.png');
      const preview = await browserClient.callTool({
        name: 'browser_preview',
        arguments: { url: 'http://localhost:5174/home', viewport_width: 375, viewport_height: 812, wait_ms: 0 }
      });
      assert.notEqual(preview.isError, true);
      assert.equal(preview.content.find((block) => block.type === 'image')?.data, screenshotData);
      assert.match(preview.content.find((block) => block.type === 'text')?.text, /# Web page preview\n\n/);
      assert.equal(preview.structuredContent.result.path, '.ai-bridge/preview.png');
      assert.equal(preview.structuredContent.result.data, undefined);
      assert.equal(previewCalls[0].url, 'http://localhost:5174/home');
      assert.equal(previewCalls[0].options.viewportWidth, 375);
      assert.equal(previewCalls[0].options.viewportHeight, 812);
      const invalidViewport = await browserClient.callTool({
        name: 'browser_preview', arguments: { url: 'http://localhost:5174', viewport_width: 100 }
      });
      assert.equal(invalidViewport.isError, true);
    } finally {
      await browserClient.close();
      await browserServer.close();
      // Exercise the actual one-call preview with a fake local Chromium process.
      const observed = { closed: 0, contextClosed: 0, navigations: [], waits: [], screenshots: [] };
      let currentUrl = 'about:blank';
      const fakePage = {
        async goto(url) { currentUrl = url; observed.navigations.push(url); },
        async title() { return 'Vite development page'; },
        url() { return currentUrl; },
        locator(selector) { return { async waitFor() { observed.waits.push(selector); } }; },
        async waitForTimeout(ms) { observed.waits.push(ms); },
        async screenshot(options) {
          observed.screenshots.push(options);
          await fs.writeFile(options.path, screenshotPayload);
          return screenshotPayload;
        }
      };
      const fakeChromium = {
        async launch() {
          return {
            async newContext(options) {
              observed.viewport = options.viewport;
              return {
                async newPage() { return fakePage; },
                async close() { observed.contextClosed++; }
              };
            },
            async close() { observed.closed++; }
          };
        }
      };
      const manager = new BrowserManager(browserConfig, new PathGuard(browserConfig), async () => ({ chromium: fakeChromium }));
      const workspace = { id: 'browser-fixture', root, openedAt: new Date().toISOString() };
      await assert.rejects(manager.preview('file:///etc/passwd', workspace), /http/);
      await assert.rejects(manager.preview('https://user:secret@example.org/', workspace), /credentials/);
      const captured = await manager.preview('http://localhost:5174/home', workspace, {
        viewportWidth: 390, viewportHeight: 844, waitForSelector: '#app',
        waitMs: 0, fullPage: false, outputPath: '.ai-bridge/previews/home.png'
      }, 'browser-test');
      assert.equal(captured.url, 'http://localhost:5174/home');
      assert.equal(captured.path, '.ai-bridge/previews/home.png');
      assert.equal(captured.data, screenshotData);
      assert.deepEqual(observed.viewport, { width: 390, height: 844 });
      assert.deepEqual(observed.navigations, ['http://localhost:5174/home']);
      assert.deepEqual(observed.waits, ['#app', 0]);
      assert.equal(observed.screenshots[0].fullPage, false);
      assert.equal(observed.closed, 1, 'preview must close Chromium');
      assert.equal(observed.contextClosed, 1, 'preview must close its context');
      assert.equal(manager.count('browser-test'), 0, 'preview session must not be retained');
      assert.deepEqual(await fs.readFile(path.join(root, '.ai-bridge', 'previews', 'home.png')), screenshotPayload);
      fakePage.goto = async () => { throw new Error('navigation failed'); };
      await assert.rejects(manager.preview('http://localhost:5174/broken', workspace, { waitMs: 0 }, 'browser-test'), /navigation failed/);
      assert.equal(manager.count('browser-test'), 0, 'failed preview must not leak a session');
      assert.equal(observed.contextClosed, 2, 'failed preview must close the context');
      assert.equal(observed.closed, 2, 'failed preview must close Chromium');

    }
  } finally {
    await client.close();
    await server.close();
  }
} finally {
  await fs.rm(root, { recursive: true, force: true, maxRetries: 5 });
}
console.log('Tool result smoke passed');
