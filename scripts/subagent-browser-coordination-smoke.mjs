import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { loadConfig } from '../dist/config.js';
import { PathGuard } from '../dist/guard.js';
import { BrowserManager } from '../dist/browserManager.js';
import { ChatGPTBrowserManager, ChatGPTWebPageAdapter, ManualBrowserCheckError } from '../dist/chatgptBrowserManager.js';
import { ChatGPTBrowserBackend } from '../dist/chatgptBrowserBackend.js';
import { createCodexProServer, toolNamesForMode } from '../dist/server.js';

const root = await fs.mkdtemp(path.join(os.tmpdir(), 'codexpro-browser-coordination-'));
const config = {
  ...loadConfig(['--root', root, '--allow-root', root]),
  subagentProvider: 'chatgpt-browser',
  subagentsEnabled: true,
  chatgptBrowserAutoStart: false,
  chatgptProjectAutoCreate: false,
  chatgptBrowserStartIntervalMs: 0,
  chatgptBrowserProfilePath: path.join(root, 'private-chrome-profile')
};

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}
async function waitFor(predicate, message) {
  const deadline = Date.now() + 4000;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((done) => setTimeout(done, 10));
  }
  assert.fail(message);
}
function makeBrowser(factory, overrides = {}) {
  const pages = [];
  const context = {
    pages: () => pages,
    async newPage() {
      const page = {
        _url: 'about:blank',
        url() { return this._url; },
        async goto(url) { this._url = url; },
        isClosed() { return this._closed ?? false; },
        async close() { this._closed = true; },
        on() {}
      };
      pages.push(page);
      return page;
    },
    async close() {}
  };
  return new ChatGPTBrowserManager(
    { ...config, ...overrides },
    async () => ({ chromium: { async launchPersistentContext() { return context; } } }),
    factory,
    { discoverChrome: () => '/fake/local-chrome' }
  );
}
function locator({ visible = false, count = 0, text = '', click, children = {} } = {}) {
  return {
    first() { return this; }, last() { return this; },
    locator(selector) { return children[selector]; },
    async isVisible() { return typeof visible === 'function' ? visible() : visible; },
    async count() { return typeof count === 'function' ? count() : count; },
    async innerText() { return typeof text === 'function' ? text() : text; },
    async allInnerTexts() { const value = typeof text === 'function' ? text() : text; return value ? [value] : []; },
    async fill() {}, async press() {},
    async click() { await click?.(); }
  };
}

try {
  assert.equal(toolNamesForMode(config).includes('subagent_resume'), true);
  assert.equal(toolNamesForMode(config).includes('subagent_browser_diagnostics'), true);
  assert.equal(toolNamesForMode({ ...config, subagentProvider: 'deepseek' }).includes('subagent_browser_diagnostics'), false);

  // Two simultaneous page spawns must never initialize the shared Chrome profile concurrently.
  const gate = deferred();
  let preparations = 0;
  let preparing = 0;
  let maxPreparing = 0;
  const serial = makeBrowser((page) => ({
    currentUrl: () => page.url(),
    async prepareFreshConversation() {
      preparing++;
      maxPreparing = Math.max(maxPreparing, preparing);
      preparations++;
      if (preparations === 1) await gate.promise;
      page._url = 'https://chatgpt.com/';
      preparing--;
    },
    async send() { return { content: 'ok' }; },
    async cancel() {}
  }));
  const first = serial.createAgentPage('first');
  await waitFor(() => preparations === 1, 'first page was not prepared');
  const second = serial.createAgentPage('second');
  await waitFor(() => serial.diagnostics('first').queued_page_creations === 1, 'second page did not queue');
  assert.equal(preparations, 1);
  gate.resolve();
  await Promise.all([first, second]);
  assert.equal(maxPreparing, 1, 'page initialization must be serialized');
  assert.equal(serial.diagnostics('first').queued_page_creations, 0);
  await serial.closeAll();

  // Fixed pacing between rapid tab initializations, without randomized behavior.
  const starts = [];
  const paced = makeBrowser((page) => ({
    currentUrl: () => page.url(),
    async prepareFreshConversation() {
      starts.push(Date.now());
      page._url = 'https://chatgpt.com/';
    },
    async send() { return { content: 'ok' }; },
    async cancel() {}
  }), { chatgptBrowserStartIntervalMs: 80 });
  await Promise.all([paced.createAgentPage('paced-1'), paced.createAgentPage('paced-2')]);
  assert.equal(starts.length, 2);
  assert.ok(starts[1] - starts[0] >= 65, 'rapid worker initialization should respect the configured interval');
  await paced.closeAll();

  // A failed initialization must release the queue so subsequent agents can start.
  let failedOnce = false;
  const recovering = makeBrowser((page) => ({
    currentUrl: () => page.url(),
    async prepareFreshConversation() {
      if (!failedOnce) {
        failedOnce = true;
        throw new Error('test navigation failed');
      }
      page._url = 'https://chatgpt.com/';
    },
    async send() { return { content: 'ok' }; },
    async cancel() {}
  }));
  const attempted = await Promise.allSettled([
    recovering.createAgentPage('failed-initialization'),
    recovering.createAgentPage('recovered-initialization')
  ]);
  assert.equal(attempted[0].status, 'rejected');
  assert.equal(attempted[1].status, 'fulfilled');
  assert.equal(recovering.diagnostics('recovered-initialization').queued_page_creations, 0);
  await recovering.closeAll();

  // Closing the browser rejects queued/unfinished page initialization safely.
  const closingGate = deferred();
  let enteredClosing = 0;
  const closingManager = makeBrowser((page) => ({
    currentUrl: () => page.url(),
    async prepareFreshConversation() { enteredClosing++; await closingGate.promise; },
    async send() { return { content: 'unused' }; },
    async cancel() {}
  }));
  const closingFirst = closingManager.createAgentPage('closing-first');
  await waitFor(() => enteredClosing === 1, 'first closing page did not enter preparation');
  const closingSecond = closingManager.createAgentPage('closing-second');
  await waitFor(() => closingManager.diagnostics('closing-first').queued_page_creations === 1, 'second closing page did not queue');
  await closingManager.closeAll();
  closingGate.resolve();
  await assert.rejects(closingFirst, /closed during page initialization/i);
  await assert.rejects(closingSecond, /restarted while this page creation was queued/i);

  // A Turnstile-like browser check blocks the worker, not the server. Resume exactly its task.
  let verificationRequired = true;
  let sends = 0;
  const manager = makeBrowser((page) => ({
    currentUrl: () => page.url(),
    async prepareFreshConversation() {
      page._url = 'https://chatgpt.com/';
      if (verificationRequired) throw new ManualBrowserCheckError('verification');
    },
    async send() {
      sends++;
      return { content: 'Recovered worker result', conversationUrl: 'https://chatgpt.com/c/recovered' };
    },
    async cancel() {}
  }));
  const server = createCodexProServer(config, new Map(), {
    agentBackend: new ChatGPTBrowserBackend(manager),
    chatgptBrowserManager: manager
  });
  const client = new Client({ name: 'coordination-smoke', version: '1' });
  const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
  try {
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    const tools = await client.listTools();
    assert.ok(tools.tools.some((tool) => tool.name === 'subagent_resume'));
    assert.ok(tools.tools.some((tool) => tool.name === 'subagent_browser_diagnostics'));
    const spawned = await client.callTool({
      name: 'subagent_spawn',
      arguments: { role: 'explorer', task: 'Check a local frontend without making changes.' }
    });
    assert.notEqual(spawned.isError, true);
    const id = spawned.structuredContent.id;
    await waitFor(async () => {
      const state = await client.callTool({ name: 'subagent_status', arguments: { id } });
      return state.structuredContent.agents[0].state === 'waiting';
    }, 'subagent did not enter waiting state');
    assert.equal(sends, 0, 'verification must block prompt submission');
    const diagnostic = await client.callTool({ name: 'subagent_browser_diagnostics', arguments: { id } });
    assert.equal(diagnostic.structuredContent.diagnostics.manual_check.kind, 'verification');
    assert.equal(diagnostic.structuredContent.diagnostics.verification_count, 1);
    assert.equal(diagnostic.structuredContent.diagnostics.page_ready, false);
    assert.equal(diagnostic.structuredContent.diagnostics.active_page_ids, undefined);
    const prematureFollowup = await client.callTool({ name: 'subagent_message', arguments: { id, message: 'different task' } });
    assert.equal(prematureFollowup.isError, true);
    const invalidResume = await client.callTool({ name: 'subagent_resume', arguments: { id, manual_check_completed: false } });
    assert.equal(invalidResume.isError, true);

    verificationRequired = false; // The user has completed the browser check manually.
    const resumed = await client.callTool({ name: 'subagent_resume', arguments: { id, manual_check_completed: true } });
    assert.notEqual(resumed.isError, true);
    await waitFor(async () => {
      const status = await client.callTool({ name: 'subagent_status', arguments: { id } });
      return status.structuredContent.agents[0].state === 'completed';
    }, 'resumed subagent did not complete');
    assert.equal(sends, 1);
    const after = await client.callTool({ name: 'subagent_browser_diagnostics', arguments: { id } });
    assert.equal(after.structuredContent.diagnostics.manual_check, null);
    assert.equal(after.structuredContent.diagnostics.resolved_check_count, 1);
  } finally {
    await client.close();
    await server.close();
    await manager.closeAll();
  }

  // When a check interrupts a sent prompt, resume observes the same response,
  // rather than submitting it a second time.
  let challenge = false;
  let submitted = 0;
  const hidden = locator();
  const composer = locator({ visible: true });
  const challengeMarker = locator({ visible: () => challenge });
  const markdown = locator({ count: () => submitted > 0 ? 1 : 0, text: 'Completed after manual check' });
  const assistant = locator({
    count: () => submitted > 0 ? 1 : 0,
    children: {
      '.markdown': markdown,
      '[data-testid="copy-turn-action-button"]': locator({ count: () => submitted })
    }
  });
  const page = {
    url: () => 'https://chatgpt.com/',
    async goto() {},
    getByRole(role, options) {
      if (role === 'textbox') return composer;
      if (role === 'button' && /send|submit/i.test(options?.name?.source ?? '')) {
        return locator({ visible: true, click: () => { submitted++; challenge = true; } });
      }
      return hidden;
    },
    locator(selector) {
      if (selector === 'iframe[src*="challenges.cloudflare.com"]') return challengeMarker;
      if (selector === 'section[data-turn="assistant"]') return assistant;
      if (selector === 'body') return locator({ text: '' });
      return hidden;
    }
  };
  const adapter = new ChatGPTWebPageAdapter(page, 4000);
  await adapter.prepareFreshConversation();
  await assert.rejects(adapter.send('send this exactly once'), (error) => error instanceof ManualBrowserCheckError);
  assert.equal(submitted, 1);
  challenge = false;
  assert.equal((await adapter.send('send this exactly once')).content, 'Completed after manual check');
  assert.equal(submitted, 1, 'resume must not resubmit a previously sent message');

  // Smooth pointer movement is deterministic UI-test functionality, not bot evasion.
  const moves = [];
  const mousePage = {
    mouse: { async move(x, y) { moves.push({ x, y }); } },
    async title() { return 'fixture'; }, url() { return 'about:blank'; }
  };
  const genericManager = new BrowserManager(
    { ...config, browserEnabled: true }, new PathGuard(config),
    async () => ({ chromium: {
      async launch() {
        return { async newContext() { return { async newPage() { return mousePage; }, async close() {} }; }, async close() {} };
      }
    } })
  );
  await genericManager.open('mouse');
  const moved = await genericManager.moveMouse('mouse', 120, 60, 8);
  assert.deepEqual(moved.pointer, { x: 120, y: 60 });
  assert.equal(moves.length, 8);
  assert.deepEqual(moves.at(-1), { x: 120, y: 60 });
  await genericManager.closeAll();

  console.log('Subagent browser coordination smoke passed');
} finally {
  await fs.rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}
