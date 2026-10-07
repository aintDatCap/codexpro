import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { loadConfig } from '../dist/config.js';
import { createAgentBackend } from '../dist/agentBackendFactory.js';
import { ChatGPTBrowserBackend } from '../dist/chatgptBrowserBackend.js';
import { ChatGPTBrowserManager, ChatGPTWebPageAdapter, discoverChromeExecutable } from '../dist/chatgptBrowserManager.js';
import { BrowserManager } from '../dist/browserManager.js';
import { AgentManager } from '../dist/agentManager.js';
import { PathGuard } from '../dist/guard.js';
import { readWorkspaceProfile, saveWorkspaceProfile } from '../dist/profileStore.js';
import { toolNamesForMode } from '../dist/server.js';
import { requestChatgptBrowserOpen } from './chatgpt-browser-control.mjs';

const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'codexpro-chatgpt-browser-'));
const oldCwd = process.cwd();
const oldEnv = { ...process.env };

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

async function waitFor(predicate, message, timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail(message);
}

function locator({ visible = false, count = 0, text = '', click, fill, children = {} } = {}) {
  return {
    first() { return this; },
    last() { return this; },
    locator(selector) { return children[selector]; },
    async isVisible() { return typeof visible === 'function' ? visible() : visible; },
    async count() { return typeof count === 'function' ? count() : count; },
    async innerText() { return typeof text === 'function' ? text() : text; },
    async allInnerTexts() {
      const value = typeof text === 'function' ? text() : text;
      return value ? [value] : [];
    },
    async click() { if (click) return click(); },
    async fill(value) { if (fill) return fill(value); },
    async press() {}
  };
}

try {
  process.chdir(tmp);
  process.env.CODEXPRO_HOME = path.join(tmp, '.codexpro-home');
  process.env.CODEXPRO_ROOT = tmp;
  process.env.CODEXPRO_ALLOWED_ROOTS = tmp;
  delete process.env.DEEPSEEK_API_KEY;
  delete process.env.OPENAI_API_KEY;

  const discoveredWindowsChrome = String.raw`C:\Program Files\Google\Chrome\Application\chrome.exe`;
  assert.equal(
    discoverChromeExecutable(undefined, {
      platform: 'win32',
      env: { ProgramFiles: String.raw`C:\Program Files`, PATH: '' },
      isExecutable: (candidate) => candidate === discoveredWindowsChrome
    }),
    discoveredWindowsChrome
  );
  assert.equal(
    discoverChromeExecutable('/opt/codexpro/chrome', {
      platform: 'linux',
      env: { PATH: '' },
      isExecutable: (candidate) => candidate === '/opt/codexpro/chrome'
    }),
    '/opt/codexpro/chrome'
  );
  assert.throws(
    () => discoverChromeExecutable(undefined, { platform: 'linux', env: { PATH: '' }, isExecutable: () => false }),
    /CODEXPRO_CHROME_PATH/i
  );

  const browserConfig = loadConfig([]);
  const browserConfigAgain = loadConfig([]);
  assert.equal(browserConfig.subagentsEnabled, true);
  assert.equal(browserConfig.subagentProvider, 'chatgpt-browser');
  assert.equal(browserConfig.chatgptBrowserAutoStart, true);
  assert.equal(browserConfig.chatgptBrowserProfilePath, path.join(process.env.CODEXPRO_HOME, 'chatgpt-browser'));
  assert.equal(browserConfigAgain.chatgptBrowserProfilePath, browserConfig.chatgptBrowserProfilePath);
  assert.equal(toolNamesForMode({ ...browserConfig, toolMode: 'standard' }).some((name) => name.startsWith('subagent_')), true);
  assert.equal(toolNamesForMode({ ...browserConfig, toolMode: 'full' }).some((name) => name.startsWith('subagent_')), true);
  assert.equal(createAgentBackend(browserConfig)?.backend.name, 'chatgpt-browser');

  process.env.CODEXPRO_CHROME_PATH = '/configured/chrome';
  assert.equal(loadConfig([]).chatgptBrowserExecutable, '/configured/chrome');
  delete process.env.CODEXPRO_CHROME_PATH;

  const offConfig = { ...browserConfig, subagentProvider: 'off', subagentsEnabled: false };
  assert.equal(toolNamesForMode({ ...offConfig, toolMode: 'full' }).some((name) => name.startsWith('subagent_')), false);
  assert.equal(createAgentBackend(offConfig), undefined);

  const deepseekConfig = { ...browserConfig, subagentProvider: 'deepseek', subagentsEnabled: true };
  Object.defineProperty(deepseekConfig, ['deepseek', 'Api', 'Key'].join(''), { value: 'placeholder', enumerable: true });
  assert.equal(createAgentBackend(deepseekConfig)?.backend.name, 'deepseek');

  const profileRoot = path.join(tmp, 'profile-root');
  await fs.mkdir(profileRoot, { recursive: true });
  saveWorkspaceProfile(profileRoot, { subagentProvider: 'chatgpt-browser', chatgptBrowserAutoStart: true });
  const stored = readWorkspaceProfile(profileRoot);
  assert.equal(stored.subagentProvider, 'chatgpt-browser');
  assert.equal(stored.chatgptBrowserAutoStart, true);

  let controlRequest;
  await requestChatgptBrowserOpen(
    { localStatusUrl: 'http://127.0.0.1:8787/' },
    {
      fetchImpl: async (url, options) => {
        controlRequest = { url: String(url), options };
        return { ok: true, status: 200, async json() { return { ok: true, url: 'https://chatgpt.com/' }; } };
      }
    }
  );
  assert.match(controlRequest.url, /\/admin\/chatgpt-browser\/open$/);
  assert.equal(controlRequest.options.method, 'POST');

  const workspace = { id: 'test', root: tmp, openedAt: new Date().toISOString() };
  const guard = new PathGuard(browserConfig);
  const profileRel = path.relative(tmp, browserConfig.chatgptBrowserProfilePath);
  assert.equal(guard.isBlockedRelativePath(profileRel), true, 'the dedicated Chrome profile must not be exposed through workspace file tools');

  let genericLaunchOptions;
  let genericBrowserClosed = false;
  const genericPage = { async title() { return ''; }, url() { return 'about:blank'; } };
  const genericContext = { async newPage() { return genericPage; }, async close() {} };
  const genericBrowser = { async newContext() { return genericContext; }, async close() { genericBrowserClosed = true; } };
  const genericManager = new BrowserManager(
    { ...browserConfig, browserEnabled: true },
    guard,
    async () => ({
      chromium: {
        async launch(options) {
          genericLaunchOptions = options;
          return genericBrowser;
        }
      }
    })
  );
  await genericManager.open('generic-browser');
  assert.deepEqual(genericLaunchOptions, { headless: true });
  await genericManager.closeAll();
  assert.equal(genericBrowserClosed, true, 'generic BrowserManager behavior must remain unchanged');

  const sends = [];
  let createCount = 0;
  let cancelCount = 0;
  const asyncBackend = {
    name: 'fake',
    model: 'mock-model',
    async create(options) {
      createCount += 1;
      return { id: options.id, backend: 'fake', model: 'mock-model', messages: [{ role: 'system', content: options.systemPrompt }] };
    },
    async send(session, message, signal) {
      const pending = deferred();
      sends.push({ session, message, pending });
      const abort = () => pending.reject(new DOMException('cancelled', 'AbortError'));
      signal?.addEventListener('abort', abort, { once: true });
      try {
        const content = await pending.promise;
        session.externalConversation = { provider: 'chatgpt', url: 'https://chatgpt.com/c/fake-agent' };
        session.messages.push({ role: 'user', content: message }, { role: 'assistant', content });
        return { role: 'assistant', content };
      } finally {
        signal?.removeEventListener('abort', abort);
      }
    },
    async cancel() { cancelCount += 1; }
  };
  const agents = new AgentManager({ ...browserConfig, maxSubagents: 1 }, guard, asyncBackend);
  const worker = await agents.spawn(workspace, { role: 'explorer', task: 'async task' });
  assert.equal(worker.state, 'running');
  assert.equal(sends.length, 1);
  await assert.rejects(
    () => agents.spawn(workspace, { role: 'reviewer', task: 'too many' }),
    /maximum concurrent subagents/i
  );
  sends[0].pending.resolve('first answer');
  await waitFor(() => agents.get(worker.id).state === 'completed', 'async worker did not finish');
  assert.equal(agents.get(worker.id).session.externalConversation?.url, 'https://chatgpt.com/c/fake-agent');

  const sameSession = agents.get(worker.id).session;
  const followup = await agents.message(worker.id, 'follow-up');
  assert.equal(followup.state, 'running');
  assert.equal(createCount, 1);
  assert.equal(agents.get(worker.id).session, sameSession);
  sends[1].pending.resolve('second answer');
  await waitFor(() => agents.get(worker.id).state === 'completed', 'follow-up did not finish');

  const cancellable = await agents.spawn(workspace, { role: 'tester', task: 'cancel me' });
  const cancelled = await agents.cancel(cancellable.id);
  assert.equal(cancelled.state, 'cancelled');
  assert.equal(cancelCount, 1);

  const createGate = deferred();
  let raceCreates = 0;
  const raceBackend = {
    name: 'fake',
    model: 'mock-model',
    async create(options) {
      raceCreates += 1;
      await createGate.promise;
      return { id: options.id, backend: 'fake', model: 'mock-model', messages: [{ role: 'system', content: options.systemPrompt }] };
    },
    async send(session, message) {
      const content = 'race answer';
      session.messages.push({ role: 'user', content: message }, { role: 'assistant', content });
      return { role: 'assistant', content };
    },
    async cancel() {}
  };
  const raceAgents = new AgentManager({ ...browserConfig, maxSubagents: 1 }, guard, raceBackend);
  const firstConcurrentSpawn = raceAgents.spawn(workspace, { role: 'explorer', task: 'reserve slot' });
  await waitFor(() => raceCreates === 1, 'first concurrent spawn did not reach backend creation');
  await assert.rejects(
    () => raceAgents.spawn(workspace, { role: 'reviewer', task: 'must be rejected while first spawn is pending' }),
    /maximum concurrent subagents/i
  );
  assert.equal(raceCreates, 1, 'a pending spawn must reserve the concurrency slot');
  createGate.resolve();
  await firstConcurrentSpawn;

  function fakePage() {
    const page = new EventEmitter();
    page._url = 'about:blank';
    page._closed = false;
    page._focusCount = 0;
    page.url = function url() { return this._url; };
    page.isClosed = function isClosed() { return this._closed; };
    page.goto = async function goto(url) { this._url = url; };
    page.bringToFront = async function bringToFront() { this._focusCount += 1; };
    page.close = async function close() {
      if (this._closed) return;
      this._closed = true;
      this.emit('close');
    };
    return page;
  }

  function fakeContext(pages, onClose = () => {}) {
    const context = new EventEmitter();
    context.pages = () => pages;
    context.newPage = async () => {
      const page = fakePage();
      pages.push(page);
      return page;
    };
    context.close = async () => {
      onClose();
      context.emit('close');
    };
    return context;
  }

  const pages = [fakePage()];
  const adapters = [];
  const launchCalls = [];
  let contextCloseCount = 0;
  const context = fakeContext(pages, () => { contextCloseCount += 1; });
  const manager = new ChatGPTBrowserManager(
    { ...browserConfig, chatgptBrowserProfilePath: path.join(tmp, 'chatgpt-profile'), chatgptBrowserResponseTimeoutMs: 5000 },
    async () => ({
      chromium: {
        async launchPersistentContext(userDataDir, options) {
          launchCalls.push({ userDataDir, options });
          return context;
        }
      }
    }),
    (page) => {
      let turns = 0;
      const adapterNumber = adapters.length + 1;
      const adapter = {
        cancelled: false,
        currentUrl() { return page._url; },
        async prepareFreshConversation() { page._url = 'https://chatgpt.com/'; },
        async send() {
          turns += 1;
          await Promise.resolve();
          page._url = `https://chatgpt.com/c/fake-browser-agent-${adapterNumber}`;
          return { content: turns === 1 ? 'streamed answer' : 'follow-up answer', conversationUrl: page._url };
        },
        async cancel() { this.cancelled = true; }
      };
      adapters.push(adapter);
      return adapter;
    },
    {
      discoverChrome(override) {
        assert.equal(override, undefined);
        return '/installed/google-chrome';
      }
    }
  );

  await Promise.all([manager.ensureReady(), manager.ensureReady()]);
  assert.equal(launchCalls.length, 1, 'Patchright must launch the persistent Chrome context only once');
  assert.equal(manager.getState(), 'attached');
  assert.equal(launchCalls[0].userDataDir, path.join(tmp, 'chatgpt-profile'));
  assert.deepEqual(launchCalls[0].options, {
    executablePath: '/installed/google-chrome',
    headless: false,
    viewport: null
  });
  assert.equal('args' in launchCalls[0].options, false, 'do not add automation-hiding command line flags');
  assert.equal('userAgent' in launchCalls[0].options, false, 'do not inject a custom user agent');
  assert.equal('extraHTTPHeaders' in launchCalls[0].options, false, 'do not inject fingerprinting headers');

  await manager.openOrFocus();
  assert.equal(launchCalls.length, 1);
  assert.equal(pages[0]._url, 'https://chatgpt.com/');

  const backend = new ChatGPTBrowserBackend(manager);
  const session = await backend.create({ id: 'browser-agent', role: 'explorer', task: '', systemPrompt: 'provider-neutral', model: 'ignored' });
  const secondSession = await backend.create({ id: 'browser-agent-2', role: 'reviewer', task: '', systemPrompt: 'second', model: 'ignored' });
  assert.equal(pages.length, 3, 'main page plus one separate worker tab per agent');
  assert.notEqual(session.pageId, secondSession.pageId);
  const workerFocusBeforeOpen = pages.slice(1).map((page) => page._focusCount);
  await manager.openOrFocus();
  assert.deepEqual(
    pages.slice(1).map((page) => page._focusCount),
    workerFocusBeforeOpen,
    'manual browser open/focus must never steal focus from a worker tab'
  );
  assert.ok(pages[0]._focusCount > 0, 'manual browser open/focus should use the non-worker control tab');
  assert.equal((await backend.send(session, 'first')).content, 'streamed answer');
  assert.equal(session.externalConversation?.url, 'https://chatgpt.com/c/fake-browser-agent-1');
  assert.equal((await backend.send(secondSession, 'review')).content, 'streamed answer');
  assert.equal(secondSession.externalConversation?.url, 'https://chatgpt.com/c/fake-browser-agent-2');
  assert.notEqual(session.externalConversation?.url, secondSession.externalConversation?.url);
  await backend.send(session, 'second');
  assert.equal(pages.length, 3, 'subagent_message must reuse the same worker page');
  assert.equal(adapters.length, 2);
  await backend.cancel(session.id);
  assert.equal(adapters[0].cancelled, true);

  await pages[1].close();
  await assert.rejects(() => backend.send(session, 'after manual close'), /closed manually/i);

  await manager.closeAll();
  assert.equal(contextCloseCount, 1, 'owned Patchright persistent context should close on shutdown');

  let restartLaunchCount = 0;
  let restartContext;
  const restartManager = new ChatGPTBrowserManager(
    { ...browserConfig, chatgptBrowserProfilePath: path.join(tmp, 'restart-profile') },
    async () => ({
      chromium: {
        async launchPersistentContext() {
          restartLaunchCount += 1;
          restartContext = fakeContext([]);
          return restartContext;
        }
      }
    }),
    undefined,
    { discoverChrome: () => '/installed/google-chrome' }
  );
  await restartManager.ensureReady();
  assert.equal(restartLaunchCount, 1);
  restartContext.emit('close');
  assert.equal(restartManager.getState(), 'stopped');
  await restartManager.ensureReady();
  assert.equal(restartLaunchCount, 2, 'Patchright context must be restartable after a browser close');
  await restartManager.closeAll();

  const stream = { sent: false, generating: false, reads: 0 };
  const hidden = locator({ visible: false });
  const composer = locator({ visible: true });
  const send = locator({ visible: true, click() { stream.sent = true; stream.generating = true; } });
  const stop = locator({ visible: () => stream.generating });
  const copyAction = locator({ count: () => stream.sent && !stream.generating ? 1 : 0 });
  const assistantMarkdown = locator({
    count: () => stream.sent ? 1 : 0,
    text: () => {
      stream.reads += 1;
      if (stream.reads === 1) return 'hel';
      if (stream.reads >= 3) stream.generating = false;
      return 'hello';
    }
  });
  const assistant = locator({
    count: () => stream.sent ? 1 : 0,
    text: () => stream.sent ? 'ChatGPT ha detto:\nhello' : '',
    children: {
      '.markdown': assistantMarkdown,
      '[data-testid="copy-turn-action-button"]': copyAction
    }
  });
  const streamingPage = {
    _url: 'https://chatgpt.com/',
    url() { return this._url; },
    async goto(url) { this._url = url; },
    async bringToFront() {},
    getByRole(role, options) {
      if (role === 'textbox') return composer;
      const source = options?.name?.source ?? '';
      if (/send|submit/i.test(source)) return send;
      if (/stop/i.test(source)) return stop;
      if (/log in|sign in/i.test(source)) return locator({ visible: true });
      return hidden;
    },
    locator(selector) {
      if (selector === 'section[data-turn="assistant"]') return assistant;
      if (selector === 'body') return locator({ text: 'Log in' });
      return hidden;
    }
  };
  const webAdapter = new ChatGPTWebPageAdapter(streamingPage, 5000);
  await webAdapter.prepareFreshConversation();
  assert.equal((await webAdapter.send('stream')).content, 'hello');

  const workStream = { sent: false, reads: 0 };
  const workComposer = locator({ visible: true });
  const workSend = locator({ visible: true, click() { workStream.sent = true; } });
  const workAssistant = locator({
    count: () => workStream.sent ? 1 : 0,
    text: () => {
      workStream.reads += 1;
      return workStream.reads === 1 ? 'PACKAGE=codexpro' : 'PACKAGE=codexpro VERSION=0.30.2';
    }
  });
  const workLayoutPage = {
    _url: 'https://chatgpt.com/',
    url() { return this._url; },
    async goto(url) { this._url = url; },
    async bringToFront() {},
    getByRole(role, options) {
      if (role === 'textbox') return workComposer;
      const source = options?.name?.source ?? '';
      if (/send|submit/i.test(source)) return workSend;
      return hidden;
    },
    locator(selector) {
      if (selector === '[data-markdown-text-style="assistant-message"]:not([data-markdown-text-tone="tertiary"])') return workAssistant;
      if (selector === 'body') return locator({ text: '' });
      return hidden;
    }
  };
  const workAdapter = new ChatGPTWebPageAdapter(workLayoutPage, 5000);
  await workAdapter.prepareFreshConversation();
  assert.equal(
    (await workAdapter.send('work layout')).content,
    'PACKAGE=codexpro VERSION=0.30.2',
    'ChatGPT Work layout must be detected without legacy assistant wrappers'
  );

  const closingState = { closed: false };
  const closingComposer = locator({ visible: true });
  const closingSend = locator({ visible: true });
  const closingPage = {
    _url: 'https://chatgpt.com/',
    url() { return this._url; },
    isClosed() { return closingState.closed; },
    async goto(url) { this._url = url; },
    async bringToFront() {},
    getByRole(role, options) {
      if (role === 'textbox') return closingComposer;
      const source = options?.name?.source ?? '';
      if (/send|submit/i.test(source)) return closingSend;
      return hidden;
    },
    locator(selector) {
      if (selector === 'body') return locator({ text: '' });
      return hidden;
    }
  };
  const closingAdapter = new ChatGPTWebPageAdapter(closingPage, 5000);
  await closingAdapter.prepareFreshConversation();
  const closingSendPromise = closingAdapter.send('close during send');
  setTimeout(() => { closingState.closed = true; }, 20);
  await assert.rejects(closingSendPromise, /tab was closed while the subagent was running/i);

  const loginPage = {
    url() { return 'https://chatgpt.com/'; },
    async goto() {},
    async bringToFront() {},
    getByRole(role, options) {
      if (role === 'button' && /log in|sign in/i.test(options?.name?.source ?? '')) return locator({ visible: true });
      return hidden;
    },
    locator(selector) { return selector === 'body' ? locator({ text: 'Log in' }) : hidden; }
  };
  await assert.rejects(
    () => new ChatGPTWebPageAdapter(loginPage, 1000).prepareFreshConversation(),
    /authentication is required|sign in manually/i
  );

  const failed = new ChatGPTBrowserManager(
    { ...browserConfig, chatgptBrowserProfilePath: path.join(tmp, 'failed-profile') },
    async () => ({
      chromium: {
        async launchPersistentContext() { throw new Error('browser boom'); }
      }
    }),
    undefined,
    { discoverChrome: () => '/installed/google-chrome' }
  );
  await assert.rejects(() => failed.openOrFocus(), /Could not launch.*Patchright.*browser boom/i);

  const cliSource = await fs.readFile(path.resolve(oldCwd, 'scripts', 'codexpro.mjs'), 'utf8');
  const httpSource = await fs.readFile(path.resolve(oldCwd, 'src', 'http.ts'), 'utf8');
  const runtimeSource = await fs.readFile(path.resolve(oldCwd, 'src', 'runtimeCoordinator.ts'), 'utf8');
  const managerSource = await fs.readFile(path.resolve(oldCwd, 'src', 'chatgptBrowserManager.ts'), 'utf8');
  assert.match(cliSource, /normalized === 'b'/);
  assert.match(cliSource, /requestChatgptBrowserOpen\(details\)/);
  assert.match(cliSource, /Start the CodexPro ChatGPT browser automatically when CodexPro starts\?/);
  assert.match(httpSource, /runtime\.shutdown\(\)/);
  assert.match(runtimeSource, /chatgptBrowserManager\.closeAll\(\)/);
  assert.match(managerSource, /import\("patchright-core"\)/);
  assert.match(managerSource, /chromium\.launchPersistentContext\(/);
  assert.doesNotMatch(managerSource, /connectOverCDP|remote-debugging-port|AutomationControlled|storageState|\.cookies\s*\(/);

  console.log('chatgpt browser smoke: ok');
} finally {
  process.chdir(oldCwd);
  process.env = oldEnv;
  await fs.rm(tmp, { recursive: true, force: true }).catch(() => {});
}
