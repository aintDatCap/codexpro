import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";

import type { CodexProConfig } from "./config.js";
import { CodexProError } from "./guard.js";
import type { CodexProLogger } from "./logging.js";
import { noopLogger } from "./logging.js";
import { redactSensitiveText } from "./redact.js";

const CHATGPT_HOME = "https://chatgpt.com/";
const CHATGPT_ASSISTANT_TURN_SELECTORS = [
  'section[data-turn="assistant"]',
  'article[data-turn="assistant"]',
  '[data-testid^="conversation-turn-"][data-turn="assistant"]',
  '[data-message-author-role="assistant"]',
  '[data-chatgpt-search-unit-key$=":assistant"]',
  '[data-turn-key]:has([data-markdown-text-style="assistant-message"])',
  '[data-markdown-text-style="assistant-message"]:not([data-markdown-text-tone="tertiary"])',
  '[data-role="assistant"]',
  '[data-message-author="assistant"]',
  '.agent-turn'
] as const;

const CHATGPT_ASSISTANT_CONTENT_SELECTORS = [
  '.markdown',
  '.prose',
  '[data-markdown-text-style="assistant-message"]:not([data-markdown-text-tone="tertiary"])',
  '[class*="markdown"]'
] as const;

type PatchrightLoader = () => Promise<any>;

export type ChatGPTBrowserState = "stopped" | "starting" | "running-unattached" | "attached" | "failed";

export interface ChromeDiscoveryOptions {
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  isExecutable?: (candidate: string) => boolean;
}

export interface ChatGPTBrowserManagerDependencies {
  discoverChrome?: (override?: string) => string;
  now?: () => number;
  logger?: CodexProLogger;
}

function envValue(env: NodeJS.ProcessEnv, key: string, platform: NodeJS.Platform): string | undefined {
  if (platform !== "win32") return env[key];
  const match = Object.keys(env).find((candidate) => candidate.toLowerCase() === key.toLowerCase());
  return match ? env[match] : undefined;
}

function defaultExecutableCheck(candidate: string, platform: NodeJS.Platform): boolean {
  try {
    const stat = fs.statSync(candidate);
    if (!stat.isFile()) return false;
    if (platform !== "win32") fs.accessSync(candidate, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function findOnPath(
  command: string,
  platform: NodeJS.Platform,
  env: NodeJS.ProcessEnv,
  isExecutable: (candidate: string) => boolean
): string | undefined {
  const pathApi = platform === "win32" ? path.win32 : path.posix;
  const rawPath = envValue(env, "PATH", platform) ?? "";
  const delimiter = platform === "win32" ? ";" : ":";
  const extensions = platform === "win32"
    ? (envValue(env, "PATHEXT", platform) ?? ".EXE;.CMD;.BAT").split(";").filter(Boolean)
    : [""];
  const commandHasExtension = platform === "win32" && Boolean(pathApi.extname(command));
  for (const directory of rawPath.split(delimiter).filter(Boolean)) {
    const suffixes = commandHasExtension ? [""] : extensions;
    for (const suffix of suffixes) {
      const candidate = pathApi.join(directory, `${command}${suffix}`);
      if (isExecutable(candidate)) return candidate;
    }
  }
  return undefined;
}

function resolveChromeCandidate(
  candidate: string,
  platform: NodeJS.Platform,
  env: NodeJS.ProcessEnv,
  isExecutable: (candidate: string) => boolean
): string | undefined {
  if (isExecutable(candidate)) return candidate;
  if (!candidate.includes("/") && !candidate.includes("\\")) {
    return findOnPath(candidate, platform, env, isExecutable);
  }
  return undefined;
}

export function discoverChromeExecutable(override?: string, options: ChromeDiscoveryOptions = {}): string {
  const platform = options.platform ?? process.platform;
  const env = options.env ?? process.env;
  const isExecutable = options.isExecutable ?? ((candidate) => defaultExecutableCheck(candidate, platform));
  const pathApi = platform === "win32" ? path.win32 : path.posix;

  if (override?.trim()) {
    const resolved = resolveChromeCandidate(override.trim(), platform, env, isExecutable);
    if (resolved) return resolved;
    throw new CodexProError(
      `Configured Chrome executable was not found: ${override.trim()}. Set CODEXPRO_CHROME_PATH to an installed Chrome executable.`
    );
  }

  const candidates: string[] = [];
  if (platform === "win32") {
    for (const base of [
      envValue(env, "ProgramFiles", platform),
      envValue(env, "ProgramFiles(x86)", platform),
      envValue(env, "LocalAppData", platform)
    ]) {
      if (base) candidates.push(pathApi.join(base, "Google", "Chrome", "Application", "chrome.exe"));
    }
  } else if (platform === "darwin") {
    candidates.push(
      "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
      pathApi.join(envValue(env, "HOME", platform) ?? "", "Applications", "Google Chrome.app", "Contents", "MacOS", "Google Chrome"),
      "/Applications/Chromium.app/Contents/MacOS/Chromium"
    );
  } else {
    candidates.push("google-chrome", "google-chrome-stable", "chromium", "chromium-browser");
  }

  for (const candidate of candidates) {
    const resolved = resolveChromeCandidate(candidate, platform, env, isExecutable);
    if (resolved) return resolved;
  }
  throw new CodexProError(
    "Could not find Google Chrome or Chromium. Install Chrome or set CODEXPRO_CHROME_PATH to the browser executable."
  );
}

function errorText(error: unknown): string {
  return redactSensitiveText(error instanceof Error ? error.message : String(error));
}

export interface ChatGPTPageAdapter {
  prepareFreshConversation(): Promise<void>;
  send(prompt: string, signal?: AbortSignal, onConversationUrl?: (url: string) => void): Promise<{ content: string; conversationUrl?: string }>;
  cancel(): Promise<void>;
  currentUrl(): string;
}

export type ChatGPTPageAdapterFactory = (page: any, timeoutMs: number) => ChatGPTPageAdapter;

async function visible(locator: any): Promise<boolean> {
  if (!locator) return false;
  try { return Boolean(await locator.first().isVisible()); } catch { return false; }
}

async function locatorText(locator: any): Promise<string> {
  if (!locator) return "";
  try { return String(await locator.last().innerText()); } catch { return ""; }
}

function conversationUrlFrom(raw: string): string | undefined {
  try {
    const url = new URL(raw);
    if (url.origin !== "https://chatgpt.com") return undefined;
    const path = url.pathname.replace(/\/+$/, "");
    if (!path || path === "/" || path.startsWith("/auth") || path.startsWith("/#settings")) return undefined;
    return url.toString();
  } catch {
    return undefined;
  }
}

export class ChatGPTWebPageAdapter implements ChatGPTPageAdapter {
  constructor(private readonly page: any, private readonly timeoutMs = 180_000) {}

  currentUrl(): string { return String(this.page.url?.() ?? ""); }

  private async composer(): Promise<any | undefined> {
    const candidates = [
      this.page.getByRole?.("textbox"),
      this.page.locator?.("#prompt-textarea"),
      this.page.locator?.('[data-testid="prompt-textarea"]'),
      this.page.locator?.('[contenteditable="true"][data-lexical-editor="true"]'),
      this.page.locator?.("textarea")
    ];
    for (const candidate of candidates) if (await visible(candidate)) return candidate.first();
    return undefined;
  }

  private async manualInteractionReason(): Promise<string | undefined> {
    let body = "";
    try { body = String(await this.page.locator?.("body")?.innerText?.()); } catch {}
    if (/captcha|verify you are human|checking your browser|unusual activity|account restriction/i.test(body)) {
      return "ChatGPT requires manual browser interaction.\n\nPress b to open the CodexPro browser and complete the check manually.";
    }

    // ChatGPT may render a Log in button even while an anonymous/authenticated
    // composer is usable. Treat authentication as blocking only when there is
    // no usable composer on the page.
    if (await this.composer()) return undefined;
    const login = this.page.getByRole?.("button", { name: /log in|sign in/i });
    if (await visible(login)) return "ChatGPT authentication is required.\n\nPress b to open the CodexPro browser and sign in manually.";
    return undefined;
  }

  private async waitForComposer(timeoutMs = 20_000): Promise<any> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (this.page.isClosed?.()) throw new CodexProError("The ChatGPT browser tab was closed while the subagent was running.");
      const composer = await this.composer();
      if (composer) return composer;
      const reason = await this.manualInteractionReason();
      if (reason) throw new CodexProError(reason);
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    throw new CodexProError("ChatGPT prompt box was not available. Open the visible browser and resolve any login or page issue manually.");
  }

  async prepareFreshConversation(): Promise<void> {
    try {
      await this.page.goto(CHATGPT_HOME, { waitUntil: "domcontentloaded", timeout: 30_000 });
      await this.page.bringToFront?.();
      await this.waitForComposer();
    } catch (error) {
      if (error instanceof CodexProError) throw error;
      throw new CodexProError(`Could not open ChatGPT in the dedicated browser: ${redactSensitiveText(error instanceof Error ? error.message : String(error))}`);
    }
  }

  private async assistantMessages(): Promise<any> {
    for (const selector of CHATGPT_ASSISTANT_TURN_SELECTORS) {
      const locator = this.page.locator?.(selector);
      if (!locator) continue;
      try {
        if (Number(await locator.count?.()) > 0) return locator;
      } catch {}
    }
    return this.page.locator?.(CHATGPT_ASSISTANT_TURN_SELECTORS[0]);
  }

  private async assistantText(assistants: any): Promise<string> {
    if (!assistants) return "";
    const turn = assistants.last?.() ?? assistants;
    for (const selector of CHATGPT_ASSISTANT_CONTENT_SELECTORS) {
      const content = turn.locator?.(selector);
      if (!content) continue;
      try {
        if (Number(await content.count?.()) <= 0) continue;
        if (typeof content.allInnerTexts === "function") {
          const chunks = (await content.allInnerTexts()).map((value: unknown) => String(value).trim()).filter(Boolean);
          if (chunks.length) return chunks.join("\n\n").trim();
        }
        const text = (await locatorText(content)).trim();
        if (text) return text;
      } catch {}
    }

    // Last-resort fallback for DOM variants without a markdown wrapper. Remove
    // the screen-reader heading that otherwise looks like the whole answer.
    const text = (await locatorText(assistants)).trim();
    return text.replace(/^(?:ChatGPT|Assistant)\s+(?:said|ha detto)\s*:?\s*/i, "").trim();
  }

  private async responseComplete(assistants: any): Promise<boolean> {
    const turn = assistants?.last?.() ?? assistants;
    const copyAction = turn?.locator?.('[data-testid="copy-turn-action-button"]');
    try {
      if (Number(await copyAction?.count?.()) > 0) return true;
    } catch {}
    return !(await this.stopButton());
  }

  private async stopButton(): Promise<any | undefined> {
    const candidates = [
      this.page.getByRole?.("button", { name: /stop generating|stop/i }),
      this.page.locator?.('[data-testid="stop-button"]')
    ];
    for (const candidate of candidates) if (await visible(candidate)) return candidate.first();
    return undefined;
  }

  private async submit(prompt: string): Promise<number> {
    const assistants = await this.assistantMessages();
    let before = 0;
    try { before = Number(await assistants?.count?.()) || 0; } catch {}
    const composer = await this.waitForComposer();
    if (typeof composer.fill === "function") await composer.fill(prompt);
    else if (typeof composer.pressSequentially === "function") await composer.pressSequentially(prompt);
    else throw new CodexProError("ChatGPT prompt box no longer supports the expected input interaction.");

    const sendCandidates = [
      this.page.getByRole?.("button", { name: /send|submit/i }),
      this.page.locator?.('[data-testid="send-button"]')
    ];
    for (const candidate of sendCandidates) {
      if (await visible(candidate)) {
        await candidate.first().click();
        return before;
      }
    }
    await composer.press?.("Enter");
    return before;
  }

  async send(prompt: string, signal?: AbortSignal, onConversationUrl?: (url: string) => void): Promise<{ content: string; conversationUrl?: string }> {
    if (!prompt.trim()) throw new CodexProError("ChatGPT browser prompt is empty.");
    const before = await this.submit(prompt);
    const deadline = Date.now() + this.timeoutMs;
    let lastText = "";
    let stableTicks = 0;
    let sawAssistant = false;

    while (Date.now() < deadline) {
      if (this.page.isClosed?.()) throw new CodexProError("The ChatGPT browser tab was closed while the subagent was running.");
      if (signal?.aborted) {
        await this.cancel();
        throw new DOMException("Subagent cancelled", "AbortError");
      }
      const reason = await this.manualInteractionReason();
      if (reason && !sawAssistant) throw new CodexProError(reason);
      const activeConversationUrl = conversationUrlFrom(this.currentUrl());
      if (activeConversationUrl) onConversationUrl?.(activeConversationUrl);

      const assistants = await this.assistantMessages();
      let count = 0;
      try { count = Number(await assistants?.count?.()) || 0; } catch {}
      if (count > before) {
        sawAssistant = true;
        const text = (await this.assistantText(assistants)).trim();
        const complete = await this.responseComplete(assistants);
        if (text && text === lastText && complete) stableTicks += 1;
        else stableTicks = 0;
        lastText = text;
        if (text && stableTicks >= 2) {
          return { content: redactSensitiveText(text), conversationUrl: conversationUrlFrom(this.currentUrl()) };
        }
      }
      await new Promise((resolve) => setTimeout(resolve, 250));
    }

    throw new CodexProError("Timed out waiting for ChatGPT to finish generating. Inspect the visible worker tab and retry or cancel the subagent.");
  }

  async cancel(): Promise<void> {
    const stop = await this.stopButton();
    if (stop) {
      try { await stop.click(); } catch {}
    }
  }
}

export class ChatGPTBrowserManager {
  private state: ChatGPTBrowserState = "stopped";
  private context?: any;
  private starting?: Promise<void>;
  private readonly pages = new Map<string, { page: any; adapter: ChatGPTPageAdapter }>();
  private readonly manuallyClosedPageIds = new Set<string>();
  private readonly discoverChrome: (override?: string) => string;
  private readonly now: () => number;
  private readonly logger: CodexProLogger;

  constructor(
    private readonly config: CodexProConfig,
    private readonly loadPatchright: PatchrightLoader = () => import("patchright-core"),
    private readonly adapterFactory: ChatGPTPageAdapterFactory = (page, timeoutMs) => new ChatGPTWebPageAdapter(page, timeoutMs),
    dependencies: ChatGPTBrowserManagerDependencies = {}
  ) {
    this.discoverChrome = dependencies.discoverChrome ?? ((override) => discoverChromeExecutable(override));
    this.now = dependencies.now ?? Date.now;
    this.logger = dependencies.logger ?? noopLogger;
  }

  isRunning(): boolean { return this.state === "attached"; }
  getState(): ChatGPTBrowserState { return this.state; }

  private browserState(): Record<string, unknown> {
    return {
      browser_state: this.state,
      chrome_running: Boolean(this.context),
      chrome_pid: null,
      owns_chrome_process: Boolean(this.context),
      cdp_port: null,
      browser_attached: Boolean(this.context),
      context_attached: Boolean(this.context),
      automation_driver: "patchright",
      page_count: this.pages.size,
      active_page_ids: [...this.pages.keys()],
      manually_closed_page_count: this.manuallyClosedPageIds.size,
      starting: Boolean(this.starting),
      attaching: false
    };
  }

  private setState(next: ChatGPTBrowserState, event: string, fields: Record<string, unknown> = {}): void {
    const previous = this.state;
    this.state = next;
    this.logger.info(event, { state_before: previous, state_after: next, ...this.browserState(), ...fields });
  }

  private clearContext(context?: any): void {
    if (context && this.context !== context) return;
    const before = this.browserState();
    this.context = undefined;
    this.pages.clear();
    this.manuallyClosedPageIds.clear();
    if (this.state !== "failed") this.state = "stopped";
    this.logger.warn("chatgpt_browser_context_closed", { state_before_snapshot: before, ...this.browserState() });
  }

  private async startInternal(): Promise<void> {
    await fsp.mkdir(this.config.chatgptBrowserProfilePath, { recursive: true, mode: 0o700 });

    if (this.context) {
      this.setState("attached", "chatgpt_browser_existing_context_reused");
      return;
    }

    const executable = this.discoverChrome(this.config.chatgptBrowserExecutable);
    this.logger.info("chatgpt_browser_patchright_launch_requested", {
      executable,
      profile_path: this.config.chatgptBrowserProfilePath,
      ...this.browserState()
    });

    let patchright: any;
    try {
      patchright = await this.loadPatchright();
    } catch (error) {
      this.logger.error("chatgpt_browser_patchright_load_failed", error, this.browserState());
      throw new CodexProError("ChatGPT browser subagents require the packaged Patchright dependency and an installed Chrome browser.");
    }

    let context: any;
    try {
      context = await patchright.chromium.launchPersistentContext(this.config.chatgptBrowserProfilePath, {
        executablePath: executable,
        headless: false,
        viewport: null
      });
    } catch (error) {
      this.logger.error("chatgpt_browser_patchright_launch_failed", error, this.browserState());
      throw new CodexProError(
        `Could not launch the dedicated ChatGPT Chrome profile with Patchright: ${errorText(error)}`
      );
    }

    if (!context) throw new CodexProError("Patchright launched Chrome without returning a usable browser context.");

    this.context = context;
    this.setState("attached", "chatgpt_browser_patchright_launch_succeeded");
    context.on?.("close", () => {
      this.logger.warn("chatgpt_browser_context_disconnected", this.browserState());
      this.clearContext(context);
    });
  }

  async start(): Promise<void> {
    this.logger.info("chatgpt_browser_start_requested", this.browserState());
    if (this.context) {
      this.setState("attached", "chatgpt_browser_start_reused_context");
      return;
    }
    if (this.starting) {
      this.logger.info("chatgpt_browser_start_joined_existing", this.browserState());
      return this.starting;
    }
    this.setState("starting", "chatgpt_browser_starting");
    this.starting = this.startInternal()
      .catch((error) => {
        this.logger.error("chatgpt_browser_start_failed", error, this.browserState());
        this.setState("failed", "chatgpt_browser_state_failed");
        if (error instanceof CodexProError) throw error;
        throw new CodexProError(`Could not start the dedicated ChatGPT Chrome profile: ${errorText(error)}`);
      })
      .finally(() => {
        this.starting = undefined;
      });
    return this.starting;
  }

  async attach(): Promise<any> {
    await this.start();
    if (!this.context) throw new CodexProError("Patchright launched Chrome without a usable browser context.");
    this.logger.info("chatgpt_browser_attach_reused", this.browserState());
    return this.context;
  }

  async ensureReady(): Promise<any> {
    return this.attach();
  }

  async openOrFocus(): Promise<{ running: true; url: string }> {
    const context = await this.ensureReady();
    const existingPages = context.pages?.() ?? [];
    const workerPages = new Set([...this.pages.values()].map((entry) => entry.page));
    let page = existingPages.find((candidate: any) =>
      !workerPages.has(candidate) && String(candidate.url?.() ?? "").startsWith("https://chatgpt.com/")
    );
    if (!page) page = existingPages.find((candidate: any) => !workerPages.has(candidate)) ?? await context.newPage();
    const current = String(page.url?.() ?? "");
    if (!current.startsWith("https://chatgpt.com/")) {
      await page.goto(CHATGPT_HOME, { waitUntil: "domcontentloaded", timeout: 30_000 });
    }
    await page.bringToFront?.();
    return { running: true, url: String(page.url?.() ?? CHATGPT_HOME) };
  }

  async createAgentPage(id: string): Promise<{ pageId: string; conversationUrl?: string }> {
    const pageLogger = this.logger.child({ agent_id: id, page_id: id });
    pageLogger.info("chatgpt_browser_agent_page_creation_started", this.browserState());
    const existing = this.pages.get(id);
    if (existing && !existing.page.isClosed?.()) {
      pageLogger.warn("chatgpt_browser_agent_page_creation_rejected_existing", this.browserState());
      throw new CodexProError(`ChatGPT browser page already exists for subagent ${id}`);
    }
    if (existing) this.pages.delete(id);
    this.manuallyClosedPageIds.delete(id);

    try {
      const context = await this.ensureReady();
      const page = await context.newPage();
      const adapter = this.adapterFactory(page, this.config.chatgptBrowserResponseTimeoutMs);
      try {
        await adapter.prepareFreshConversation();
        this.pages.set(id, { page, adapter });
        page.on?.("close", () => {
          if (this.pages.get(id)?.page === page) {
            this.pages.delete(id);
            this.manuallyClosedPageIds.add(id);
            pageLogger.warn("chatgpt_browser_agent_page_closed", { manual_or_external: true, ...this.browserState() });
          }
        });
        const conversationUrl = conversationUrlFrom(adapter.currentUrl());
        pageLogger.info("chatgpt_browser_agent_page_creation_completed", {
          has_conversation_url: Boolean(conversationUrl),
          ...this.browserState()
        });
        return { pageId: id, conversationUrl };
      } catch (error) {
        try { await page.close?.(); } catch {}
        throw error;
      }
    } catch (error) {
      pageLogger.error("chatgpt_browser_agent_page_creation_failed", error, this.browserState());
      throw error;
    }
  }

  async send(id: string, prompt: string, signal?: AbortSignal, onConversationUrl?: (url: string) => void): Promise<{ content: string; conversationUrl?: string }> {
    const pageLogger = this.logger.child({ agent_id: id, page_id: id });
    const startedAt = this.now();
    pageLogger.info("chatgpt_browser_agent_send_started", this.browserState());
    const entry = this.pages.get(id);
    if (!entry) {
      if (this.manuallyClosedPageIds.has(id)) {
        pageLogger.warn("chatgpt_browser_agent_send_rejected_page_closed", this.browserState());
        throw new CodexProError(`The ChatGPT browser tab for subagent ${id} was closed manually.`);
      }
      pageLogger.warn("chatgpt_browser_agent_send_rejected_page_missing", this.browserState());
      throw new CodexProError(`No ChatGPT browser tab exists for subagent ${id}`);
    }
    if (entry.page.isClosed?.()) {
      this.pages.delete(id);
      this.manuallyClosedPageIds.add(id);
      pageLogger.warn("chatgpt_browser_agent_send_rejected_page_closed", this.browserState());
      throw new CodexProError(`The ChatGPT browser tab for subagent ${id} was closed manually.`);
    }
    try {
      const result = await entry.adapter.send(prompt, signal, onConversationUrl);
      pageLogger.info("chatgpt_browser_agent_send_completed", {
        duration_ms: this.now() - startedAt,
        response_chars: result.content.length,
        has_conversation_url: Boolean(result.conversationUrl),
        ...this.browserState()
      });
      return result;
    } catch (error) {
      pageLogger.error("chatgpt_browser_agent_send_failed", error, {
        duration_ms: this.now() - startedAt,
        aborted: Boolean(signal?.aborted),
        ...this.browserState()
      });
      throw error;
    }
  }

  async cancel(id: string): Promise<void> {
    const pageLogger = this.logger.child({ agent_id: id, page_id: id });
    const entry = this.pages.get(id);
    pageLogger.info("chatgpt_browser_agent_cancel_requested", { page_present: Boolean(entry), ...this.browserState() });
    if (!entry || entry.page.isClosed?.()) {
      pageLogger.info("chatgpt_browser_agent_cancel_noop", this.browserState());
      return;
    }
    try {
      await entry.adapter.cancel();
      pageLogger.info("chatgpt_browser_agent_cancel_completed", this.browserState());
    } catch (error) {
      pageLogger.error("chatgpt_browser_agent_cancel_failed", error, this.browserState());
      throw error;
    }
  }

  async closeAgentPage(id: string): Promise<void> {
    const pageLogger = this.logger.child({ agent_id: id, page_id: id });
    const entry = this.pages.get(id);
    pageLogger.info("chatgpt_browser_agent_page_close_requested", { page_present: Boolean(entry), ...this.browserState() });
    if (!entry) return;
    this.pages.delete(id);
    this.manuallyClosedPageIds.delete(id);
    try {
      await entry.page.close?.();
      pageLogger.info("chatgpt_browser_agent_page_close_completed", this.browserState());
    } catch (error) {
      pageLogger.error("chatgpt_browser_agent_page_close_failed", error, this.browserState());
    }
  }

  async shutdown(): Promise<void> {
    const context = this.context;
    const entries = [...this.pages.values()];
    const before = this.browserState();
    this.logger.info("chatgpt_browser_shutdown_requested", before);

    this.state = "stopped";
    this.context = undefined;
    this.pages.clear();
    this.manuallyClosedPageIds.clear();

    for (const entry of entries) {
      if (!entry.page.isClosed?.()) {
        try { await entry.page.close?.(); } catch (error) {
          this.logger.warn("chatgpt_browser_shutdown_page_close_failed", { error: errorText(error) });
        }
      }
    }

    if (context) {
      try { await context.close?.(); } catch (error) {
        this.logger.warn("chatgpt_browser_shutdown_context_close_failed", { error: errorText(error) });
      }
    }
    this.logger.info("chatgpt_browser_shutdown_completed", { state_before_snapshot: before, ...this.browserState() });
  }

  async closeAll(): Promise<void> {
    await this.shutdown();
  }
}
