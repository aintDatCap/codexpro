import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { ChatGPTSubagentProject, DEFAULT_SUBAGENT_PROJECT_NAME, validatedChatGPTProjectUrl } from "../dist/chatgptSubagentProject.js";
import { ChatGPTBrowserManager, ChatGPTWebPageAdapter } from "../dist/chatgptBrowserManager.js";
import { loadConfig } from "../dist/config.js";

const root = await fs.mkdtemp(path.join(os.tmpdir(), "codexpro-project-smoke-"));
const HOME = "https://chatgpt.com/";
const PROJECT = "https://chatgpt.com/g/g-p-test-codexpro-subagenti/project";
const NEW_PROJECT = "https://chatgpt.com/g/g-p-test2-codexpro-subagenti/project";

function locator({ visible = false, count = 1, text = "", href = null, onClick, onHover, onFill, onWait, dialog } = {}) {
  const value = {
    first() { return this; }, nth() { return this; },
    async isVisible() { return typeof visible === "function" ? visible() : visible; },
    async count() { return typeof count === "function" ? count() : count; },
    async innerText() { return typeof text === "function" ? text() : text; },
    async getAttribute() { return typeof href === "function" ? href() : href; },
    async click() { await onClick?.(); },
    async hover() { await onHover?.(); },
    async fill(value) { await onFill?.(value); },
    async waitFor() { await onWait?.(); if (!(await this.isVisible())) throw new Error("not visible"); },
    getByRole(type, options) { return dialog?.(type, options); }
  };
  return value;
}

function fakeUi(state) {
  const page = {
    _url: HOME,
    closed: false,
    url() { return this._url; },
    isClosed() { return this.closed; },
    async close() { this.closed = true; },
    async goto(url) {
      state.nav.push(url);
      if (validatedChatGPTProjectUrl(url) && (!state.exists || url !== state.projectUrl)) this._url = HOME;
      else this._url = url;
    },
    async waitForURL(predicate) {
      if (!predicate(new URL(this._url))) throw new Error("navigation did not reach project");
    },
    on() {},
    getByRole(type, options = {}) {
      if (type === "link") {
        return locator({ visible: () => state.exists && !state.buttonSidebar,
          count: () => state.exists && !state.buttonSidebar && options.name === DEFAULT_SUBAGENT_PROJECT_NAME ? 1 : 0,
          text: DEFAULT_SUBAGENT_PROJECT_NAME, href: () => state.projectUrl });
      }
      if (type === "heading") {
        return locator({ visible: () => state.exists && !state.buttonSidebar && page.url() === state.projectUrl && options.name === DEFAULT_SUBAGENT_PROJECT_NAME });
      }
      if (type === "button" && options.name === DEFAULT_SUBAGENT_PROJECT_NAME && state.buttonSidebar) {
        return locator({ visible: () => state.exists, count: () => state.exists ? 1 : 0,
          onHover() { state.hovered = true; }, onClick() { state.expanded = true; } });
      }
      if (type === "button" && options.name === `Nuova chat in ${DEFAULT_SUBAGENT_PROJECT_NAME}` && state.buttonSidebar) {
        return locator({ visible: () => state.exists && state.hovered, count: () => state.exists ? 1 : 0,
          onClick() { page._url = state.projectUrl; } });
      }
      if (type === "button" && /new project|nuovo progetto|aggiungi nuovo progetto/i.test(options.name?.source ?? "")) {
        return state.noControls || state.challenge ? undefined : locator({ visible: true, onClick() { state.dialog = true; } });
      }
      if (type === "dialog") {
        return locator({
          visible: () => state.dialog,
          dialog(subtype, opts = {}) {
            if (subtype === "textbox") return locator({ visible: true, onFill(value) { state.draft = value; } });
            if (subtype === "button" && /create|crea/i.test(opts.name?.source ?? "")) {
              return locator({ visible: true, onClick() {
                if (state.draft !== DEFAULT_SUBAGENT_PROJECT_NAME) throw new Error("wrong project name");
                state.creations++;
                state.exists = true;
                state.projectUrl = state.newUrl ?? PROJECT;
                page._url = state.projectUrl;
                state.dialog = false;
              } });
            }
            return undefined;
          }
        });
      }
      return undefined;
    },
    locator(selector) {
      if (selector === "body") return locator({ text: () => state.challenge ? "Verify you are human" : "" });
      if (selector === 'a[href*="/g/g-p-"]') {
        return { filter({ hasText }) {
          return locator({ visible: () => state.exists && !state.buttonSidebar, count: () => state.exists && !state.buttonSidebar && hasText === DEFAULT_SUBAGENT_PROJECT_NAME ? 1 : 0,
            text: DEFAULT_SUBAGENT_PROJECT_NAME, href: () => state.projectUrl });
        } };
      }
      return locator({ visible: false, count: 0 });
    }
  };
  return page;
}

try {
  assert.equal(validatedChatGPTProjectUrl(PROJECT), PROJECT);
  assert.equal(validatedChatGPTProjectUrl(PROJECT + "/"), PROJECT);
  for (const url of ["https://evil.invalid/g/g-p-xx/project", "file:///etc/passwd", "https://chatgpt.com/c/chat", "https://chatgpt.com/g/g-p-123/project?token=secret", "https://chatgpt.com/g/g-p-123/project/../else"]) {
    assert.equal(validatedChatGPTProjectUrl(url), undefined, `invalid project URL accepted: ${url}`);
  }

  const state = { nav: [], exists: false, creations: 0, dialog: false, projectUrl: PROJECT };
  const profile = path.join(root, "chrome-profile");
  const project = new ChatGPTSubagentProject(profile);
  const firstPage = fakeUi(state);
  assert.equal(await project.ensure(firstPage), PROJECT);
  assert.equal(state.creations, 1, "must create the project only once");
  const cache = JSON.parse(await fs.readFile(path.join(profile, "codexpro-subagent-project.json"), "utf8"));
  assert.deepEqual(cache, { version: 1, name: DEFAULT_SUBAGENT_PROJECT_NAME, url: PROJECT });

  // Reuse the cached project in a new session.
  const secondPage = fakeUi(state);
  assert.equal(await new ChatGPTSubagentProject(profile).ensure(secondPage), PROJECT);
  assert.equal(state.creations, 1);

  // Reuse a project already in the sidebar when no cache file exists.
  const existing = new ChatGPTSubagentProject(path.join(root, "other-profile"));
  assert.equal(await existing.ensure(fakeUi(state)), PROJECT);
  assert.equal(state.creations, 1);

  // The current ChatGPT sidebar has project buttons, without project links.
  // Reuse must not depend on the availability of the New project control.
  const buttonState = { nav: [], exists: true, buttonSidebar: true, noControls: true, creations: 0, dialog: false, projectUrl: PROJECT };
  const buttonProject = new ChatGPTSubagentProject(path.join(root, "button-profile"));
  assert.equal(await buttonProject.ensure(fakeUi(buttonState)), PROJECT);
  assert.equal(buttonState.creations, 0);
  assert.equal(await new ChatGPTSubagentProject(path.join(root, "button-profile")).ensure(fakeUi(buttonState)), PROJECT);
  assert.equal(buttonState.creations, 0);

  // If the user deletes the project, a later spawn recreates it once.
  state.exists = false;
  state.newUrl = NEW_PROJECT;
  assert.equal(await new ChatGPTSubagentProject(profile).ensure(fakeUi(state)), NEW_PROJECT);
  assert.equal(state.creations, 2);
  const savedAgain = JSON.parse(await fs.readFile(path.join(profile, "codexpro-subagent-project.json"), "utf8"));
  assert.equal(savedAgain.url, NEW_PROJECT);

  // A missing sidebar control fails CLOSED rather than sending a chat outside a project.
  const broken = { nav: [], exists: false, creations: 0, dialog: false, noControls: true, projectUrl: PROJECT };
  await assert.rejects(() => new ChatGPTSubagentProject(path.join(root, "broken-profile")).ensure(fakeUi(broken)),
    /No subagent message was sent outside the project/);
  assert.equal(broken.creations, 0);

  // Integration: real manager startup calls project ensure once and passes project URL
  // to the page adapter, while separate workers keep independent tabs.
  const contextState = { nav: [], exists: false, creations: 0, dialog: false, projectUrl: PROJECT };
  const pages = [];
  const startedAt = [];
  const context = {
    async newPage() { const page = fakeUi(contextState); pages.push(page); return page; },
    pages: () => pages,
    async close() {},
    on() {}
  };
  const conf = {
    ...loadConfig(["--root", root, "--allow-root", root]),
    chatgptProjectAutoCreate: true,
    chatgptBrowserAutoStart: false,
    chatgptBrowserStartIntervalMs: 0,
    chatgptBrowserProfilePath: path.join(root, "integration-profile")
  };
  const manager = new ChatGPTBrowserManager(conf,
    async () => ({ chromium: { async launchPersistentContext() { return context; } } }),
    (page, _timeout, startUrl) => {
      startedAt.push(startUrl);
      return { currentUrl: () => page.url(),
        async prepareFreshConversation() { await page.goto(startUrl); },
        async send() { return { content: "completed" }; },
        async cancel() {} };
    },
    { discoverChrome: () => "fake-chrome" });
  try {
    const [a, b] = await Promise.all([manager.createAgentPage("agent-a"), manager.createAgentPage("agent-b")]);
    assert.equal(a.pageId, "agent-a");
    assert.equal(b.pageId, "agent-b");
    assert.equal(contextState.creations, 1, "concurrent agent startup must share one project");
    assert.deepEqual(startedAt, [PROJECT, PROJECT]);
    assert.notEqual(pages[0], pages[1], "subagents must get independent tabs");
    assert.equal((await manager.send("agent-a", "Task A")).content, "completed");
    assert.equal((await manager.send("agent-b", "Task B")).content, "completed");
    assert.equal(manager.diagnostics("agent-a").subagent_project_enabled, true);
  } finally { await manager.closeAll(); }

  // First-time project creation interrupted by a manual challenge should keep
  // the worker alive and finish setup after the human verifies the page.
  const verification = { nav: [], exists: false, creations: 0, dialog: false, challenge: true, projectUrl: PROJECT };
  const verificationPage = fakeUi(verification);
  const verificationManager = new ChatGPTBrowserManager({
    ...conf, chatgptBrowserProfilePath: path.join(root, "challenge-profile")
  }, async () => ({ chromium: { async launchPersistentContext() {
    return { async newPage() { return verificationPage; }, async close() {}, on() {} };
  } } }), (page, _timeout, startUrl) => ({
    currentUrl: () => page.url(),
    async prepareFreshConversation() { await page.goto(startUrl ?? HOME); },
    async send() { return { content: "recovered after challenge" }; },
    async cancel() {}
  }), { discoverChrome: () => "fake-chrome" });
  try {
    await verificationManager.createAgentPage("verify-me");
    assert.equal(verificationManager.diagnostics("verify-me").manual_check.kind, "verification");
    assert.equal(verification.creations, 0);
    await assert.rejects(verificationManager.send("verify-me", "task"), /manual browser verification/i);
    verification.challenge = false; // Verified manually in the browser.
    assert.equal((await verificationManager.send("verify-me", "task")).content, "recovered after challenge");
    assert.equal(verification.creations, 1);
    assert.equal(verificationManager.diagnostics("verify-me").manual_check, null);
  } finally { await verificationManager.closeAll(); }

  // Faulty UI must reject worker creation instead of silently using the home page.
  const brokenPage = fakeUi({ nav: [], exists: false, creations: 0, dialog: false, noControls: true, projectUrl: PROJECT });
  const brokenManager = new ChatGPTBrowserManager(conf,
    async () => ({ chromium: { async launchPersistentContext() {
      return { async newPage() { return brokenPage; }, async close() {}, on() {} };
    } } }),
    () => ({ currentUrl: () => brokenPage.url(), async prepareFreshConversation() {}, async send() { throw new Error("must not send"); }, async cancel() {} }),
    { discoverChrome: () => "fake-chrome" });
  try {
    await assert.rejects(() => brokenManager.createAgentPage("broken"), /No subagent message was sent outside the project/);
    assert.equal(brokenPage.closed, true);
  } finally { await brokenManager.closeAll(); }

  // The real adapter must never send from ChatGPT's general home if a
  // configured project URL redirects or is no longer accessible.
  const redirected = {
    url: () => HOME,
    async goto() {},
    async bringToFront() {},
    getByRole(role) {
      return role === "textbox" ? locator({ visible: true }) : locator({ visible: false });
    },
    locator() { return locator({ visible: false }); }
  };
  await assert.rejects(() => new ChatGPTWebPageAdapter(redirected, 1000, PROJECT).prepareFreshConversation(),
    /No message was sent outside the project/);

  const navigatedAway = {
    url: () => HOME,
    getByRole() { return locator({ visible: true }); },
    locator() { return locator({ visible: false, count: 0 }); }
  };
  await assert.rejects(() => new ChatGPTWebPageAdapter(navigatedAway, 1000, PROJECT).send("must stay private"),
    /Refusing to send outside it/);

  console.log("ChatGPT automatic subagent project smoke passed");
} finally {
  await fs.rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}
