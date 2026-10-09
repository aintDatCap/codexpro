import fsp from "node:fs/promises";
import path from "node:path";

import { CodexProError } from "./guard.js";
import { ManualBrowserCheckError } from "./manualBrowserCheck.js";

export const DEFAULT_SUBAGENT_PROJECT_NAME = "CodexPro - Subagenti";
const CHATGPT_HOME = "https://chatgpt.com/";
const CACHE_FILE = "codexpro-subagent-project.json";

export function validatedChatGPTProjectUrl(raw: string): string | undefined {
  try {
    const url = new URL(raw, CHATGPT_HOME);
    if (url.origin !== "https://chatgpt.com" || url.username || url.password) return undefined;
    if (!/^\/g\/g-p-[^/]+\/project\/?$/.test(url.pathname)) return undefined;
    if (url.search || url.hash) return undefined;
    url.pathname = url.pathname.replace(/\/$/, "");
    return url.toString();
  } catch {
    return undefined;
  }
}

function projectError(detail: string): CodexProError {
  return new CodexProError(
    `Could not prepare ChatGPT project for subagents: ${detail}. No subagent message was sent outside the project. Inspect the dedicated Chrome tab, or set CODEXPRO_CHATGPT_PROJECT_AUTO_CREATE=0 to restore legacy non-project chats.`
  );
}

async function sidebarProject(page: any, name: string): Promise<string | undefined> {
  // Only reuse a project with the exact configured name. Avoid confusing a chat
  // mentioning the name with a project navigation entry.
  for (const candidate of [
    page.getByRole?.("link", { name, exact: true }),
    page.locator?.('a[href*="/g/g-p-"]').filter?.({ hasText: name })
  ]) {
    if (!candidate) continue;
    let count = 0;
    try { count = Number(await candidate.count?.() ?? 0); } catch {}
    for (let index = 0; index < Math.min(count, 15); index++) {
      try {
        const link = candidate.nth(index);
        if (!(await link.isVisible?.())) continue;
        const actual = String(await link.innerText?.() ?? "").trim();
        if (actual !== name) continue;
        const url = validatedChatGPTProjectUrl(String(await link.getAttribute("href") ?? ""));
        if (url) return url;
      } catch {}
    }
  }
  return undefined;
}

export class ChatGPTSubagentProject {
  private url?: string;
  private readonly cachePath: string;

  constructor(readonly profilePath: string, readonly name = DEFAULT_SUBAGENT_PROJECT_NAME) {
    this.cachePath = path.join(profilePath, CACHE_FILE);
  }

  private async cached(): Promise<string | undefined> {
    if (this.url) return this.url;
    try {
      const contents = await fsp.readFile(this.cachePath, "utf8");
      if (contents.length > 4096) return undefined;
      const parsed = JSON.parse(contents);
      if (parsed.version !== 1 || parsed.name !== this.name) return undefined;
      return validatedChatGPTProjectUrl(parsed.url);
    } catch { return undefined; }
  }

  private async save(url: string): Promise<void> {
    await fsp.mkdir(this.profilePath, { recursive: true, mode: 0o700 });
    const target = `${this.cachePath}.tmp`;
    await fsp.writeFile(target, JSON.stringify({ version: 1, name: this.name, url }), { encoding: "utf8", mode: 0o600 });
    await fsp.rename(target, this.cachePath);
    this.url = url;
  }

  private async validatePage(page: any, expectedUrl: string): Promise<boolean> {
    const current = validatedChatGPTProjectUrl(String(page.url?.() ?? ""));
    if (!current || current !== expectedUrl) return false;
    const heading = page.getByRole?.("heading", { name: this.name, exact: true });
    try { if (await heading?.first()?.isVisible?.()) return true; } catch {}
    // A private project's sidebar link is another strong ownership signal.
    return (await sidebarProject(page, this.name)) === current;
  }

  async ensure(page: any): Promise<string> {
    // This method is invoked from CodexPro's existing serial worker-start queue.
    // Reuse the cached URL if the project is still accessible.
    const cached = await this.cached();
    if (cached) {
      await page.goto(cached, { waitUntil: "domcontentloaded", timeout: 30_000 });
      if (await this.validatePage(page, cached)) {
        this.url = cached;
        return cached;
      }
      this.url = undefined;
    }

    await page.goto(CHATGPT_HOME, { waitUntil: "domcontentloaded", timeout: 30_000 });
    // Wait for sidebar hydration; never create duplicates just because links
    // have not rendered at the first DOMContentLoaded event.
    const controls = [
      page.getByRole?.("button", { name: /^(?:new project|nuovo progetto)$/i }),
      page.getByRole?.("link", { name: /^(?:new project|nuovo progetto)$/i })
    ].filter(Boolean);
    let start: any;
    for (const candidate of controls) {
      try {
        await candidate.first().waitFor({ state: "visible", timeout: 5_000 });
        start = candidate;
        break;
      } catch {}
    }
    if (!start) {
      const body = page.locator?.("body");
      let text = "";
      try { text = String(await body?.innerText?.() ?? "").slice(0, 4000); } catch {}
      if (/captcha|verify you are human|checking your browser|unusual activity|account restriction|cloudflare|just a moment/i.test(text)) {
        throw new ManualBrowserCheckError("verification");
      }
      const login = page.getByRole?.("button", { name: /log in|sign in|accedi/i });
      try { if (await login?.first()?.isVisible?.()) throw new ManualBrowserCheckError("authentication"); }
      catch (error) { if (error instanceof ManualBrowserCheckError) throw error; }
      throw projectError("the New project control is unavailable (login, permissions or UI change)");
    }
    const existing = await sidebarProject(page, this.name);
    if (existing) {
      await page.goto(existing, { waitUntil: "domcontentloaded", timeout: 30_000 });
      if (!(await this.validatePage(page, existing))) throw projectError("the existing project could not be verified");
      await this.save(existing);
      return existing;
    }

    // If ChatGPT changed its sidebar or project dialog, stop rather than
    // silently writing conversations outside the intended project.
    await start.first().click();

    const dialog = page.getByRole?.("dialog");
    if (!dialog || !(await dialog.first().isVisible().catch(() => false))) {
      throw projectError("the project creation dialog is unavailable");
    }
    const input = dialog.getByRole?.("textbox") ?? dialog.locator?.('input[type="text"]');
    if (!input || !(await input.first().isVisible().catch(() => false))) {
      throw projectError("the project name field is unavailable");
    }
    await input.first().fill(this.name);
    const create = dialog.getByRole?.("button", { name: /^(?:create|create project|crea|crea progetto)$/i });
    if (!create || !(await create.first().isVisible().catch(() => false))) {
      throw projectError("the Create project button is unavailable");
    }
    await create.first().click();
    try {
      await page.waitForURL((url: URL) => Boolean(validatedChatGPTProjectUrl(url.toString())), { timeout: 15_000 });
    } catch {
      throw projectError("project creation was not confirmed");
    }
    const created = validatedChatGPTProjectUrl(String(page.url?.() ?? ""));
    if (!created || !(await this.validatePage(page, created))) {
      throw projectError("the newly created project could not be verified");
    }
    await this.save(created);
    return created;
  }
}
