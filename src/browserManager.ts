import { createHash } from "node:crypto";
import fsp from "node:fs/promises";
import path from "node:path";
import type { CodexProConfig } from "./config.js";
import type { Workspace } from "./guard.js";
import { CodexProError, PathGuard } from "./guard.js";

interface BrowserSession {
  id: string;
  ownerId: string;
  browser: any;
  context: any;
  pages: any[];
  activePage: number;
}

type PlaywrightLoader = () => Promise<any>;

export interface BrowserScreenshot {
  sessionId: string;
  activeTab: number;
  tabCount: number;
  title: string;
  url: string;
  path: string;
  mimeType: "image/png" | "image/jpeg";
  bytes: number;
  sha256: string;
  data: string;
}

export interface BrowserPreviewOptions {
  viewportWidth?: number;
  viewportHeight?: number;
  fullPage?: boolean;
  waitForSelector?: string;
  waitMs?: number;
  outputPath?: string;
}

function browserUrl(raw: string): string {
  let url: URL;
  try { url = new URL(raw); }
  catch { throw new CodexProError("browser URL must be an absolute http:// or https:// URL"); }
  if (!["http:", "https:"].includes(url.protocol) || !url.hostname || url.username || url.password) {
    throw new CodexProError("browser URL must be http(s) and must not contain credentials");
  }
  return url.toString();
}

async function loadPlaywright(): Promise<any> {
  try {
    const dynamicImport = new Function("specifier", "return import(specifier)") as (specifier: string) => Promise<any>;
    return await dynamicImport("playwright");
  } catch {
    throw new CodexProError(
      "Browser support requires the optional `playwright` package and Chromium. Install with `npm install playwright` and `npx playwright install chromium`, then enable CODEXPRO_BROWSER_ENABLED=1."
    );
  }
}
// Honestly an UUIDv7 would be much easier and smarter
function sessionId(value?: string): string {
  const id = value?.trim() || `browser-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  if (!/^[A-Za-z0-9._-]{1,80}$/.test(id)) throw new CodexProError("browser session id contains unsupported characters");
  return id;
}

function ownerId(value: string): string {
  const id = String(value || "legacy").trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9._:@-]{0,160}$/.test(id)) throw new CodexProError("browser owner id contains unsupported characters");
  return id;
}

function sessionKey(owner: string, id: string): string {
  return `${owner}\u0000${id}`;
}

function pageFor(session: BrowserSession): any {
  const page = session.pages[session.activePage];
  if (!page) throw new CodexProError("browser session has no active page");
  return page;
}

export class BrowserManager {
  private readonly sessions = new Map<string, BrowserSession>();
  constructor(
    private readonly config: CodexProConfig,
    private readonly guard: PathGuard,
    private readonly playwrightLoader: PlaywrightLoader = loadPlaywright
  ) {}

  private assertEnabled(): void {
    if (!this.config.browserEnabled) throw new CodexProError("browser tools are disabled; set CODEXPRO_BROWSER_ENABLED=1 to enable them");
  }

  async open(id?: string, url?: string, logicalOwnerId = "legacy", viewport?: { width: number; height: number }): Promise<Record<string, unknown>> {
    this.assertEnabled();
    const owner = ownerId(logicalOwnerId);
    const resolvedId = sessionId(id);
    const key = sessionKey(owner, resolvedId);
    if (this.sessions.has(key)) throw new CodexProError(`browser session already exists: ${resolvedId}`);
    const { chromium } = await this.playwrightLoader();
    const browser = await chromium.launch({ headless: true });
    let context: any;
    try {
      context = await browser.newContext(viewport ? { viewport } : {});
      const page = await context.newPage();
      const session: BrowserSession = { id: resolvedId, ownerId: owner, browser, context, pages: [page], activePage: 0 };
      this.sessions.set(key, session);
      if (url) await page.goto(browserUrl(url), { waitUntil: "domcontentloaded" });
      return this.describe(session);
    } catch (error) {
      this.sessions.delete(key);
      if (context) await context.close().catch(() => undefined);
      await browser.close().catch(() => undefined);
      throw error;
    }
  }

  private async describe(session: BrowserSession): Promise<Record<string, unknown>> {
    const page = pageFor(session);
    return { sessionId: session.id, activeTab: session.activePage, tabCount: session.pages.length, title: await page.title(), url: page.url() };
  }

  async navigate(id: string, url: string, logicalOwnerId = "legacy"): Promise<Record<string, unknown>> {
    const session = this.get(id, logicalOwnerId); const page = pageFor(session);
    await page.goto(browserUrl(url), { waitUntil: "domcontentloaded" });
    return this.describe(session);
  }

  async snapshot(id: string, logicalOwnerId = "legacy"): Promise<Record<string, unknown>> {
    const session = this.get(id, logicalOwnerId); const page = pageFor(session);
    const snapshot = await page.locator("body").ariaSnapshot({ timeout: 10_000 }).catch(async () => {
      return await page.locator("body").innerText({ timeout: 10_000 });
    });
    const text = String(snapshot).slice(0, this.config.maxOutputBytes);
    return { ...(await this.describe(session)), snapshot: text, truncated: String(snapshot).length > text.length };
  }

  async click(id: string, selector: string, logicalOwnerId = "legacy"): Promise<Record<string, unknown>> {
    const session = this.get(id, logicalOwnerId); const page = pageFor(session);
    await page.locator(selector).click({ timeout: 10_000 });
    return this.describe(session);
  }

  async type(id: string, selector: string, text: string, submit = false, logicalOwnerId = "legacy"): Promise<Record<string, unknown>> {
    const session = this.get(id, logicalOwnerId); const page = pageFor(session);
    await page.locator(selector).fill(text, { timeout: 10_000 });
    if (submit) await page.locator(selector).press("Enter");
    return this.describe(session);
  }

  async select(id: string, selector: string, values: string[], logicalOwnerId = "legacy"): Promise<Record<string, unknown>> {
    const session = this.get(id, logicalOwnerId); const page = pageFor(session);
    const selected = await page.locator(selector).selectOption(values, { timeout: 10_000 });
    return { ...(await this.describe(session)), selected };
  }

  async scroll(id: string, x = 0, y = 600, logicalOwnerId = "legacy"): Promise<Record<string, unknown>> {
    const session = this.get(id, logicalOwnerId); const page = pageFor(session);
    await page.evaluate(([dx, dy]: [number, number]) => window.scrollBy(dx, dy), [x, y]);
    return this.describe(session);
  }

  async wait(id: string, selector?: string, timeoutMs = 10_000, logicalOwnerId = "legacy"): Promise<Record<string, unknown>> {
    const session = this.get(id, logicalOwnerId); const page = pageFor(session);
    if (selector) await page.locator(selector).waitFor({ timeout: timeoutMs });
    else await page.waitForLoadState("domcontentloaded", { timeout: timeoutMs });
    return this.describe(session);
  }

  async tab(id: string, action: "new" | "list" | "switch" | "close", index?: number, logicalOwnerId = "legacy"): Promise<Record<string, unknown>> {
    const session = this.get(id, logicalOwnerId);
    if (action === "new") { session.pages.push(await session.context.newPage()); session.activePage = session.pages.length - 1; }
    if (action === "switch") {
      if (index === undefined || !session.pages[index]) throw new CodexProError("invalid tab index");
      session.activePage = index;
    }
    if (action === "close") {
      const target = index ?? session.activePage;
      if (!session.pages[target]) throw new CodexProError("invalid tab index");
      await session.pages[target].close(); session.pages.splice(target, 1); session.activePage = Math.max(0, Math.min(session.activePage, session.pages.length - 1));
      if (!session.pages.length) session.pages.push(await session.context.newPage());
    }
    return { ...(await this.describe(session)), tabs: await Promise.all(session.pages.map(async (page, i) => ({ index: i, title: await page.title(), url: page.url() }))) };
  }

  async screenshot(id: string, workspace: Workspace, outputPath: string, fullPage = true, logicalOwnerId = "legacy"): Promise<BrowserScreenshot> {
    const session = this.get(id, logicalOwnerId); const page = pageFor(session);
    const resolved = this.guard.resolve(workspace, outputPath, { forWrite: true });
    if (!/\.(?:png|jpe?g)$/i.test(resolved.relPath)) throw new CodexProError("screenshot output path must end in .png, .jpg, or .jpeg");
    const mimeType = /\.png$/i.test(resolved.relPath) ? "image/png" : "image/jpeg";
    await fsp.mkdir(path.dirname(resolved.absPath), { recursive: true });
    const buffer = Buffer.from(await page.screenshot({ path: resolved.absPath, fullPage }));
    const details = await this.describe(session);
    return {
      sessionId: String(details.sessionId),
      activeTab: Number(details.activeTab),
      tabCount: Number(details.tabCount),
      title: String(details.title),
      url: String(details.url),
      path: resolved.relPath,
      mimeType,
      bytes: buffer.byteLength,
      sha256: createHash("sha256").update(buffer).digest("hex"),
      data: buffer.toString("base64")
    };
  }

  async preview(url: string, workspace: Workspace, options: BrowserPreviewOptions = {}, logicalOwnerId = "legacy"): Promise<BrowserScreenshot> {
    this.assertEnabled();
    const targetUrl = browserUrl(url);
    const viewport = { width: options.viewportWidth ?? 1280, height: options.viewportHeight ?? 800 };
    const opened = await this.open(undefined, undefined, logicalOwnerId, viewport);
    const id = String(opened.sessionId);
    try {
      await this.navigate(id, targetUrl, logicalOwnerId);
      const page = pageFor(this.get(id, logicalOwnerId));
      if (options.waitForSelector) await page.locator(options.waitForSelector).waitFor({ timeout: 15_000 });
      await page.waitForTimeout(options.waitMs ?? 500);
      return await this.screenshot(
        id, workspace, options.outputPath ?? `.ai-bridge/browser-preview-${Date.now()}-${id}.png`,
        options.fullPage ?? true, logicalOwnerId
      );
    } finally {
      await this.close(id, logicalOwnerId);
    }
  }

  async close(id: string, logicalOwnerId = "legacy"): Promise<void> {
    const session = this.get(id, logicalOwnerId);
    await session.context.close().catch(() => undefined);
    await session.browser.close().catch(() => undefined);
    this.sessions.delete(sessionKey(session.ownerId, session.id));
  }

  async closeOwner(logicalOwnerId: string): Promise<void> {
    const owner = ownerId(logicalOwnerId);
    const owned = [...this.sessions.values()].filter((session) => session.ownerId === owner);
    for (const session of owned) await this.close(session.id, owner).catch(() => undefined);
  }

  async closeAll(): Promise<void> {
    for (const session of [...this.sessions.values()]) await this.close(session.id, session.ownerId).catch(() => undefined);
  }

  list(logicalOwnerId?: string): string[] {
    const owner = logicalOwnerId === undefined ? undefined : ownerId(logicalOwnerId);
    return [...this.sessions.values()].filter((session) => !owner || session.ownerId === owner).map((session) => session.id);
  }

  count(logicalOwnerId?: string): number {
    return this.list(logicalOwnerId).length;
  }

  private get(id: string, logicalOwnerId = "legacy"): BrowserSession {
    const owner = ownerId(logicalOwnerId);
    const session = this.sessions.get(sessionKey(owner, id));
    if (!session) throw new CodexProError(`unknown browser session: ${id}`);
    return session;
  }
}
