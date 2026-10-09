import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { BrowserManager } from '../dist/browserManager.js';
import { PathGuard } from '../dist/guard.js';
import { loadConfig } from '../dist/config.js';

// End-to-end Playwright check against an ephemeral local site.
// Requires: npx playwright install chromium
const root = await fs.mkdtemp(path.join(os.tmpdir(), 'codexpro-browser-preview-'));
const site = http.createServer((_request, response) => {
  response.setHeader('Content-Type', 'text/html; charset=utf-8');
  response.end('<!doctype html><html><head><title>Local preview fixture</title></head><body><main id="app" style="background:#ffeedd"><h1>Local Playwright screenshot</h1><p id="pointer">Pointer idle</p></main><script>document.addEventListener("pointermove", e => { document.getElementById("pointer").textContent = "Pointer " + Math.round(e.clientX) + "," + Math.round(e.clientY); });</script></body></html>');
});
const config = { ...loadConfig(['--root', root, '--allow-root', root]), browserEnabled: true };
const manager = new BrowserManager(config, new PathGuard(config));

try {
  await new Promise((resolve, reject) => {
    site.once('error', reject);
    site.listen(0, '127.0.0.1', resolve);
  });
  const address = site.address();
  assert.ok(address && typeof address !== 'string');
  const url = `http://127.0.0.1:${address.port}/home`;
  const workspace = { id: 'local-preview-smoke', root, openedAt: new Date().toISOString() };
  const screenshot = await manager.preview(url, workspace, {
    viewportWidth: 1024,
    viewportHeight: 768,
    waitForSelector: '#app',
    waitMs: 50,
    fullPage: false,
    outputPath: '.ai-bridge/screens/local.png'
  }, 'smoke');

  assert.equal(screenshot.title, 'Local preview fixture');
  assert.equal(screenshot.url, url);
  assert.equal(screenshot.mimeType, 'image/png');
  assert.equal(screenshot.path, '.ai-bridge/screens/local.png');
  assert.equal(manager.count('smoke'), 0, 'browser should be closed after preview');
  const bytes = await fs.readFile(path.join(root, '.ai-bridge/screens/local.png'));
  assert.equal(bytes.subarray(0, 8).toString('hex'), '89504e470d0a1a0a');
  assert.equal(bytes.readUInt32BE(16), 1024);
  assert.equal(bytes.readUInt32BE(20), 768);
  assert.equal(screenshot.data, bytes.toString('base64'));

  // Exercise smooth pointer movement against REAL Chromium and check browser DOM events.
  await manager.open('interactive-pointer', url, 'smoke');
  const result = await manager.moveMouse('interactive-pointer', 160, 90, 16, 'smoke');
  assert.deepEqual(result.pointer, { x: 160, y: 90 });
  const snapshot = await manager.snapshot('interactive-pointer', 'smoke');
  assert.match(snapshot.snapshot, /Pointer 160,90/);
  await assert.rejects(manager.moveMouse('interactive-pointer', 160, 90, 1, 'smoke'), /steps/);
  await assert.rejects(manager.moveMouse('interactive-pointer', 160, 90, 16, 'other-owner'), /unknown|owner|session/i);
  await manager.close('interactive-pointer', 'smoke');
  assert.equal(manager.count('smoke'), 0);
  console.log('Local browser preview and Chromium mouse smoke passed');
} finally {
  await manager.closeAll();
  await new Promise((resolve) => site.close(resolve));
  await fs.rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}
