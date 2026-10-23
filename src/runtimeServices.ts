import type { AgentBackend } from "./agentBackend.js";
import { AgentManager } from "./agentManager.js";
import { createAgentBackend } from "./agentBackendFactory.js";
import { BrowserManager } from "./browserManager.js";
import { ChatGPTBrowserManager } from "./chatgptBrowserManager.js";
import type { CodexProConfig } from "./config.js";
import { GitService, WorktreeManager } from "./gitService.js";
import { PathGuard, WorkspaceManager } from "./guard.js";
import type { CodexProLogger } from "./logging.js";
import { noopLogger } from "./logging.js";
import { OutputStore } from "./outputStore.js";
import { VmManager } from "./vm/index.js";

/**
 * One process owns MCP-accessible resources. Browser and subagent tasks are
 * independent of transport reconnects; workspace IDs identify stable roots.
 */
export class RuntimeServices {
  readonly guard: PathGuard;
  readonly workspaces: WorkspaceManager;
  readonly outputs = new OutputStore();
  readonly gitService: GitService;
  readonly worktreeManager: WorktreeManager;
  readonly vmManager = new VmManager();
  readonly browserManager: BrowserManager;
  readonly chatgptBrowserManager: ChatGPTBrowserManager;
  readonly agentManager?: AgentManager;
  private closed = false;

  constructor(
    readonly config: CodexProConfig,
    dependencies: {
      logger?: CodexProLogger;
      browserManager?: BrowserManager;
      chatgptBrowserManager?: ChatGPTBrowserManager;
      agentBackend?: AgentBackend;
    } = {}
  ) {
    const logger = dependencies.logger ?? noopLogger;
    this.guard = new PathGuard(config);
    this.workspaces = new WorkspaceManager(config);
    this.gitService = new GitService(config, this.guard);
    this.worktreeManager = new WorktreeManager(config);
    this.browserManager = dependencies.browserManager ?? new BrowserManager(config, this.guard);
    this.chatgptBrowserManager = dependencies.chatgptBrowserManager ??
      new ChatGPTBrowserManager(config, undefined, undefined, { logger: logger.child({ subsystem: "chatgpt_browser" }) });
    const backend = dependencies.agentBackend ?? createAgentBackend(config, {
      chatgptBrowserManager: this.chatgptBrowserManager,
      logger: logger.child({ subsystem: "chatgpt_browser" })
    })?.backend;
    this.agentManager = backend
      ? new AgentManager(config, this.guard, backend, logger.child({ subsystem: "subagent" }))
      : undefined;
    if (config.chatgptBrowserAutoStart && config.subagentProvider === "chatgpt-browser" && config.subagentsEnabled) {
      void this.chatgptBrowserManager.openOrFocus().catch(error =>
        logger.error("chatgpt_browser_auto_start_failed", error)
      );
    }
  }

  snapshot(): Record<string, number> {
    const agents = this.agentManager?.snapshot() ?? { agentCount: 0, runningCount: 0 };
    return {
      workspaceCount: this.workspaces.listWorkspaces().length,
      logicalAgentCount: agents.agentCount,
      runningAgentCount: agents.runningCount,
      browserSessionCount: this.browserManager.count()
    };
  }

  async shutdown(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    await this.agentManager?.releaseOwner("legacy", root =>
      this.workspaces.openWorkspace(root, { select: false })
    );
    await this.browserManager.closeAll();
    await this.chatgptBrowserManager.closeAll();
  }
}
