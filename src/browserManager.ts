import path from "node:path";
import type { CodexProConfig } from "./config.js";
import type { Workspace } from "./guard.js";
import { CodexProError, PathGuard } from "./guard.js";

interface BrowserSession {
  id: string;
  browser: any;
  context: any;
  pages: any[];
  activePage: number;
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

function pageFor(session: BrowserSession): any {
  const page = session.pages[session.activePage];
  if (!page) throw new CodexProError("browser session has no active page");
  return page;
}

export class BrowserManager {
  private readonly sessions = new Map<string, BrowserSession>();
  constructor(private readonly config: CodexProConfig, private readonly guard: PathGuard) {}

  private assertEnabled(): void {
    if (!this.config.browserEnabled) throw new CodexProError("browser tools are disabled; set CODEXPRO_BROWSER_ENABLED=1 to enable them");
  }

  async open(id?: string, url?: string): Promise<Record<string, unknown>> {
    this.assertEnabled();
    const resolvedId = sessionId(id);
    if (this.sessions.has(resolvedId)) throw new CodexProError(`browser session already exists: ${resolvedId}`);
    const { chromium } = await loadPlaywright();
    const browser = await chromium.launch({ headless: true });
    const context = await browser.newContext();
    const page = await context.newPage();
    const session: BrowserSession = { id: resolvedId, browser, context, pages: [page], activePage: 0 };
    this.sessions.set(resolvedId, session);
    if (url) await page.goto(url, { waitUntil: "domcontentloaded" });
    return this.describe(session);
  }

  private async describe(session: BrowserSession): Promise<Record<string, unknown>> {
    const page = pageFor(session);
    return { sessionId: session.id, activeTab: session.activePage, tabCount: session.pages.length, title: await page.title(), url: page.url() };
  }

  async navigate(id: string, url: string): Promise<Record<string, unknown>> {
    const session = this.get(id); const page = pageFor(session);
    await page.goto(url, { waitUntil: "domcontentloaded" });
    return this.describe(session);
  }

  async snapshot(id: string): Promise<Record<string, unknown>> {
    const session = this.get(id); const page = pageFor(session);
    const snapshot = await page.locator("body").ariaSnapshot({ timeout: 10_000 }).catch(async () => {
      return await page.locator("body").innerText({ timeout: 10_000 });
    });
    const text = String(snapshot).slice(0, this.config.maxOutputBytes);
    return { ...(await this.describe(session)), snapshot: text, truncated: String(snapshot).length > text.length };
  }

  async click(id: string, selector: string): Promise<Record<string, unknown>> {
    const session = this.get(id); const page = pageFor(session);
    await page.locator(selector).click({ timeout: 10_000 });
    return this.describe(session);
  }

  async type(id: string, selector: string, text: string, submit = false): Promise<Record<string, unknown>> {
    const session = this.get(id); const page = pageFor(session);
    await page.locator(selector).fill(text, { timeout: 10_000 });
    if (submit) await page.locator(selector).press("Enter");
    return this.describe(session);
  }

  async select(id: string, selector: string, values: string[]): Promise<Record<string, unknown>> {
    const session = this.get(id); const page = pageFor(session);
    const selected = await page.locator(selector).selectOption(values, { timeout: 10_000 });
    return { ...(await this.describe(session)), selected };
  }

  async scroll(id: string, x = 0, y = 600): Promise<Record<string, unknown>> {
    const session = this.get(id); const page = pageFor(session);
    await page.evaluate(([dx, dy]: [number, number]) => window.scrollBy(dx, dy), [x, y]);
    return this.describe(session);
  }

  async wait(id: string, selector?: string, timeoutMs = 10_000): Promise<Record<string, unknown>> {
    const session = this.get(id); const page = pageFor(session);
    if (selector) await page.locator(selector).waitFor({ timeout: timeoutMs });
    else await page.waitForLoadState("domcontentloaded", { timeout: timeoutMs });
    return this.describe(session);
  }

  async tab(id: string, action: "new" | "list" | "switch" | "close", index?: number): Promise<Record<string, unknown>> {
    const session = this.get(id);
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

  async screenshot(id: string, workspace: Workspace, outputPath: string, fullPage = true): Promise<Record<string, unknown>> {
    const session = this.get(id); const page = pageFor(session);
    const resolved = this.guard.resolve(workspace, outputPath, { forWrite: true });
    if (!/\.(?:png|jpe?g)$/i.test(resolved.relPath)) throw new CodexProError("screenshot output path must end in .png, .jpg, or .jpeg");
    await page.screenshot({ path: resolved.absPath, fullPage });
    return { ...(await this.describe(session)), path: resolved.relPath };
  }

  async close(id: string): Promise<void> {
    const session = this.get(id);
    await session.context.close().catch(() => undefined);
    await session.browser.close().catch(() => undefined);
    this.sessions.delete(id);
  }

  async closeAll(): Promise<void> { for (const id of [...this.sessions.keys()]) await this.close(id).catch(() => undefined); }
  list(): string[] { return [...this.sessions.keys()]; }
  private get(id: string): BrowserSession { const session = this.sessions.get(id); if (!session) throw new CodexProError(`unknown browser session: ${id}`); return session; }
}
