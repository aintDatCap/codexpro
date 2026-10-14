import { randomUUID } from "node:crypto";
import { EventLoopPauseTracker } from "./clockPause.js";
import type { AgentBackend, AgentRole } from "./agentBackend.js";
import { AgentManager, type ManagedAgent } from "./agentManager.js";
import { createAgentBackend } from "./agentBackendFactory.js";
import { BrowserManager } from "./browserManager.js";
import { ChatGPTBrowserManager } from "./chatgptBrowserManager.js";
import type { CodexProConfig } from "./config.js";
import { GitService, WorktreeManager } from "./gitService.js";
import { CodexProError, PathGuard, WorkspaceManager, type Workspace } from "./guard.js";
import type { CodexProLogger } from "./logging.js";
import { noopLogger } from "./logging.js";
import { OutputStore } from "./outputStore.js";
import { VmManager } from "./vm/index.js";

export type RuntimeAdapterKind = "mcp-http" | "mcp-stdio" | "cli" | "internal" | string;

export interface RuntimeClientBinding {
  clientId: string;
  leaseId: string;
  adapter: RuntimeAdapterKind;
  synthetic: boolean;
}

export interface RegisterClientOptions {
  adapter: RuntimeAdapterKind;
  synthetic?: boolean;
}

export interface RuntimeCoordinatorDependencies {
  logger?: CodexProLogger;
  browserManager?: BrowserManager;
  chatgptBrowserManager?: ChatGPTBrowserManager;
  agentBackend?: AgentBackend;
  now?: () => number;
  leaseTtlMs?: number;
  sweepIntervalMs?: number;
  disableSweep?: boolean;
}

interface RuntimeClientState {
  clientId: string;
  leaseId: string;
  adapter: RuntimeAdapterKind;
  synthetic: boolean;
  createdAt: number;
  lastSeenAt: number;
  expiresAt: number;
  status: "active" | "releasing";
  workspaces: WorkspaceManager;
  outputs: OutputStore;
  reviewCheckpoints: Map<string, string>;
  transportIds: Set<string>;
}

interface TransportAttachment {
  transportSessionId: string;
  clientId: string;
  leaseId: string;
  attachedAt: number;
  lastSeenAt: number;
  adapter: RuntimeAdapterKind;
}

export interface RuntimeSnapshot {
  logicalClientCount: number;
  activeLeaseCount: number;
  logicalAgentCount: number;
  runningAgentCount: number;
  browserSessionCount: number;
  attachedTransportCount: number;
}

const CLIENT_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:@-]{0,127}$/;

export function normalizeClientId(value: unknown): string {
  const clientId = String(value ?? "").trim();
  if (!CLIENT_ID_PATTERN.test(clientId)) {
    throw new CodexProError(
      "client_id must be 1-128 characters using letters, numbers, dot, underscore, colon, at-sign, or dash, and must start with a letter or number."
    );
  }
  return clientId;
}

export class RuntimeClientHandle {
  constructor(
    private readonly coordinator: RuntimeCoordinator,
    readonly binding: RuntimeClientBinding
  ) {}

  get clientId(): string { return this.binding.clientId; }
  get leaseId(): string { return this.binding.leaseId; }

  renew(operationId?: string): void {
    this.coordinator.renewLease(this.binding, operationId);
  }

  get workspaceManager(): WorkspaceManager {
    return this.coordinator.clientState(this.binding).workspaces;
  }

  workspace(id?: string): Workspace {
    return this.workspaceManager.getWorkspace(id);
  }

  openWorkspace(root?: string, options: { select?: boolean } = {}): Workspace {
    return this.coordinator.clientState(this.binding).workspaces.openWorkspace(root, options);
  }

  defaultWorkspace(select = false): Workspace {
    const workspaces = this.coordinator.clientState(this.binding).workspaces;
    return select ? workspaces.selectDefaultWorkspace() : workspaces.defaultWorkspace();
  }

  listWorkspaces(): Workspace[] {
    return this.coordinator.clientState(this.binding).workspaces.listWorkspaces();
  }

  currentWorkspaceId(): string {
    return this.coordinator.clientState(this.binding).workspaces.currentWorkspaceId();
  }

  get outputStore(): OutputStore {
    return this.coordinator.clientState(this.binding).outputs;
  }

  get reviewCheckpoints(): Map<string, string> {
    return this.coordinator.clientState(this.binding).reviewCheckpoints;
  }

  async spawnAgent(
    workspace: Workspace,
    options: { task: string; role: AgentRole; paths?: string[]; context?: string; parentId?: string }
  ): Promise<ManagedAgent> {
    const manager = this.coordinator.agentManager;
    if (!manager) throw new CodexProError("Subagents are unavailable for the selected provider.");
    return manager.spawn(workspace, { ...options, clientId: this.clientId, leaseId: this.leaseId });
  }

  listAgents(): ManagedAgent[] {
    const manager = this.coordinator.agentManager;
    if (!manager) throw new CodexProError("Subagents are unavailable for the selected provider.");
    return manager.list(this.clientId);
  }

  getAgent(id: string): ManagedAgent {
    const manager = this.coordinator.agentManager;
    if (!manager) throw new CodexProError("Subagents are unavailable for the selected provider.");
    return manager.get(id, this.clientId);
  }

  async messageAgent(id: string, message: string): Promise<ManagedAgent> {
    const manager = this.coordinator.agentManager;
    if (!manager) throw new CodexProError("Subagents are unavailable for the selected provider.");
    return manager.message(id, message, this.clientId);
  }

  async cancelAgent(id: string): Promise<ManagedAgent> {
    const manager = this.coordinator.agentManager;
    if (!manager) throw new CodexProError("Subagents are unavailable for the selected provider.");
    return manager.cancel(id, this.clientId);
  }

  cleanupAgent(workspace: Workspace, id: string): void {
    const manager = this.coordinator.agentManager;
    if (!manager) throw new CodexProError("Subagents are unavailable for the selected provider.");
    manager.cleanup(workspace, id, this.clientId);
  }

  browserOwnerId(): string {
    return `client:${this.clientId}`;
  }

  snapshot(): RuntimeSnapshot {
    return this.coordinator.snapshot();
  }

  async shutdown(): Promise<void> {
    await this.coordinator.releaseClient(this.binding, "explicit_shutdown");
  }
}

export class RuntimeCoordinator {
  readonly guard: PathGuard;
  readonly gitService: GitService;
  readonly worktreeManager: WorktreeManager;
  readonly browserManager: BrowserManager;
  readonly vmManager: VmManager;
  readonly chatgptBrowserManager: ChatGPTBrowserManager;
  readonly agentManager?: AgentManager;

  private readonly logger: CodexProLogger;
  private readonly now: () => number;
  private readonly pauseTracker: EventLoopPauseTracker;
  private readonly leaseTtlMs: number;
  private readonly clients = new Map<string, RuntimeClientState>();
  private readonly leases = new Map<string, string>();
  private readonly transports = new Map<string, TransportAttachment>();
  private readonly knownWorkspaceRoots = new Map<string, string>();
  private readonly sweepTimer?: NodeJS.Timeout;
  private shuttingDown = false;

  constructor(
    readonly config: CodexProConfig,
    dependencies: RuntimeCoordinatorDependencies = {}
  ) {
    this.logger = dependencies.logger ?? noopLogger;
    this.now = dependencies.now ?? Date.now;
    this.leaseTtlMs = Math.max(100, dependencies.leaseTtlMs ?? config.clientLeaseTtlMs);
    this.pauseTracker = new EventLoopPauseTracker(this.now, Math.max(100, dependencies.sweepIntervalMs ?? Math.min(this.leaseTtlMs, 60_000)));
    this.guard = new PathGuard(config);
    this.gitService = new GitService(config, this.guard);
    this.worktreeManager = new WorktreeManager(config);
    this.browserManager = dependencies.browserManager ?? new BrowserManager(config, this.guard);
    this.vmManager = new VmManager();
    this.chatgptBrowserManager =
      dependencies.chatgptBrowserManager ??
      new ChatGPTBrowserManager(config, undefined, undefined, {
        logger: this.logger.child({ subsystem: "chatgpt_browser" })
      });

    const backendSelection = dependencies.agentBackend
      ? { backend: dependencies.agentBackend, chatgptBrowserManager: this.chatgptBrowserManager }
      : createAgentBackend(config, {
          chatgptBrowserManager: this.chatgptBrowserManager,
          logger: this.logger.child({ subsystem: "chatgpt_browser" })
        });
    this.agentManager = backendSelection
      ? new AgentManager(config, this.guard, backendSelection.backend, this.logger.child({ subsystem: "subagent" }))
      : undefined;

    if (config.chatgptBrowserAutoStart) {
      void this.chatgptBrowserManager.openOrFocus().catch((error) => {
        this.logger.error("chatgpt_browser_auto_start_failed", error);
      });
    }

    if (!dependencies.disableSweep) {
      const interval = Math.max(100, dependencies.sweepIntervalMs ?? Math.min(this.leaseTtlMs, 60_000));
      this.sweepTimer = setInterval(() => {
        void this.sweepExpiredLeases().catch((error) => this.logger.error("lease_sweep_failed", error));
      }, interval);
      this.sweepTimer.unref();
    }
  }

  private recoverAfterEventLoopPause(): void {
    const pausedMs = this.pauseTracker.check();
    if (!pausedMs) return;
    for (const client of this.clients.values()) {
      if (client.status === "active") client.expiresAt += pausedMs;
    }
    this.logger.warn("runtime_pause_recovered", { paused_ms: pausedMs, logical_client_count: this.clients.size });
  }

  async registerClient(rawClientId: unknown, options: RegisterClientOptions): Promise<RuntimeClientHandle> {
    const clientId = normalizeClientId(rawClientId);
    await this.sweepExpiredLeases();
    const now = this.now();
    const existing = this.clients.get(clientId);
    if (existing && existing.status === "active") {
      existing.lastSeenAt = now;
      existing.expiresAt = now + this.leaseTtlMs;
      this.logger.info("client_reconnected", {
        client_id: clientId,
        lease_id: existing.leaseId,
        adapter: options.adapter,
        synthetic_client_id: existing.synthetic,
        logical_client_count: this.clients.size
      });
      this.logger.debug("lease_renewed", {
        client_id: clientId,
        lease_id: existing.leaseId,
        expires_at: new Date(existing.expiresAt).toISOString(),
        reason: "client_reconnect"
      });
      return new RuntimeClientHandle(this, {
        clientId,
        leaseId: existing.leaseId,
        adapter: options.adapter,
        synthetic: existing.synthetic
      });
    }

    const leaseId = `lease-${randomUUID()}`;
    const state: RuntimeClientState = {
      clientId,
      leaseId,
      adapter: options.adapter,
      synthetic: Boolean(options.synthetic),
      createdAt: now,
      lastSeenAt: now,
      expiresAt: now + this.leaseTtlMs,
      status: "active",
      workspaces: new WorkspaceManager(this.config, this.knownWorkspaceRoots),
      outputs: new OutputStore(),
      reviewCheckpoints: new Map<string, string>(),
      transportIds: new Set<string>()
    };
    this.clients.set(clientId, state);
    this.leases.set(leaseId, clientId);
    this.logger.info("client_registered", {
      client_id: clientId,
      lease_id: leaseId,
      adapter: options.adapter,
      synthetic_client_id: state.synthetic,
      logical_client_count: this.clients.size
    });
    this.logger.info("lease_created", {
      client_id: clientId,
      lease_id: leaseId,
      expires_at: new Date(state.expiresAt).toISOString(),
      lease_ttl_ms: this.leaseTtlMs
    });
    return new RuntimeClientHandle(this, {
      clientId,
      leaseId,
      adapter: options.adapter,
      synthetic: state.synthetic
    });
  }

  renewLease(binding: RuntimeClientBinding, operationId?: string): void {
    this.recoverAfterEventLoopPause();
    const state = this.clientState(binding, false);
    const now = this.now();
    if (state.expiresAt <= now) {
      void this.releaseClient(binding, "lease_expired").catch((error) => this.logger.error("lease_expiry_cleanup_failed", error, {
        client_id: binding.clientId,
        lease_id: binding.leaseId
      }));
      throw new CodexProError("Logical client lease has expired. Reconnect and register the client again.");
    }
    state.lastSeenAt = now;
    state.expiresAt = now + this.leaseTtlMs;
    this.logger.debug("lease_renewed", {
      client_id: binding.clientId,
      lease_id: binding.leaseId,
      ...(operationId ? { operation_id: operationId } : {}),
      expires_at: new Date(state.expiresAt).toISOString()
    });
  }

  clientState(binding: RuntimeClientBinding, renew = true): RuntimeClientState {
    const state = this.clients.get(binding.clientId);
    if (!state || state.status !== "active" || state.leaseId !== binding.leaseId || this.leases.get(binding.leaseId) !== binding.clientId) {
      throw new CodexProError("Logical client is no longer active. Reconnect and register the client again.");
    }
    if (renew) this.renewLease(binding);
    return state;
  }

  attachTransport(binding: RuntimeClientBinding, transportSessionId: string): void {
    this.renewLease(binding);
    const now = this.now();
    const state = this.clientState(binding, false);
    const previous = this.transports.get(transportSessionId);
    if (previous && previous.clientId !== binding.clientId) {
      this.logger.warn("transport_ownership_replaced", {
        mcp_session_id: transportSessionId,
        previous_client_id: previous.clientId,
        client_id: binding.clientId
      });
      this.clients.get(previous.clientId)?.transportIds.delete(transportSessionId);
    }
    this.transports.set(transportSessionId, {
      transportSessionId,
      clientId: binding.clientId,
      leaseId: binding.leaseId,
      attachedAt: now,
      lastSeenAt: now,
      adapter: binding.adapter
    });
    state.transportIds.add(transportSessionId);
    this.logger.info("transport_attached", {
      client_id: binding.clientId,
      lease_id: binding.leaseId,
      mcp_session_id: transportSessionId,
      adapter: binding.adapter,
      attached_transport_count: this.transports.size
    });
  }

  noteTransportActivity(transportSessionId: string): RuntimeClientBinding | undefined {
    const attachment = this.transports.get(transportSessionId);
    if (!attachment) return undefined;
    attachment.lastSeenAt = this.now();
    const binding: RuntimeClientBinding = {
      clientId: attachment.clientId,
      leaseId: attachment.leaseId,
      adapter: attachment.adapter,
      synthetic: this.clients.get(attachment.clientId)?.synthetic ?? false
    };
    this.renewLease(binding);
    return binding;
  }

  detachTransport(transportSessionId: string, reason: string): void {
    const attachment = this.transports.get(transportSessionId);
    if (!attachment) return;
    this.transports.delete(transportSessionId);
    this.clients.get(attachment.clientId)?.transportIds.delete(transportSessionId);
    this.logger.info("transport_detached", {
      client_id: attachment.clientId,
      lease_id: attachment.leaseId,
      mcp_session_id: transportSessionId,
      reason,
      attached_transport_count: this.transports.size
    });
  }

  async sweepExpiredLeases(): Promise<number> {
    this.recoverAfterEventLoopPause();
    const now = this.now();
    const expired = [...this.clients.values()]
      .filter((state) => state.status === "active" && state.expiresAt <= now)
      .map((state) => ({ clientId: state.clientId, leaseId: state.leaseId }));
    for (const item of expired) {
      this.logger.warn("lease_expired", {
        client_id: item.clientId,
        lease_id: item.leaseId
      });
      await this.releaseClient(
        { clientId: item.clientId, leaseId: item.leaseId },
        "lease_expired"
      );
    }
    return expired.length;
  }

  async releaseClient(binding: Pick<RuntimeClientBinding, "clientId" | "leaseId">, reason: "explicit_shutdown" | "lease_expired" | "runtime_shutdown"): Promise<void> {
    const state = this.clients.get(binding.clientId);
    if (!state || state.leaseId !== binding.leaseId || state.status === "releasing") return;
    state.status = "releasing";
    this.logger.info(reason === "lease_expired" ? "lease_expiry_cleanup_started" : "client_cleanup_started", {
      client_id: state.clientId,
      lease_id: state.leaseId,
      reason,
      transport_count: state.transportIds.size
    });

    try {
      if (this.agentManager) {
        await this.agentManager.releaseOwner(state.clientId, (workspaceRoot) => {
          const match = state.workspaces.listWorkspaces().find((workspace) => workspace.root === workspaceRoot);
          return match ?? state.workspaces.openWorkspace(workspaceRoot, { select: false });
        });
      }
      await this.browserManager.closeOwner(`client:${state.clientId}`);
      for (const transportId of [...state.transportIds]) this.detachTransport(transportId, reason);
    } finally {
      this.clients.delete(state.clientId);
      this.leases.delete(state.leaseId);
      this.logger.info(reason === "lease_expired" ? "cleanup_caused_by_lease_expiry" : "client_cleanup_completed", {
        client_id: state.clientId,
        lease_id: state.leaseId,
        reason,
        logical_client_count: this.clients.size
      });
      this.logger.info("lease_released", {
        client_id: state.clientId,
        lease_id: state.leaseId,
        reason
      });
    }
  }

  snapshot(): RuntimeSnapshot {
    const agentSnapshot = this.agentManager?.snapshot() ?? { agentCount: 0, runningCount: 0 };
    return {
      logicalClientCount: this.clients.size,
      activeLeaseCount: this.leases.size,
      logicalAgentCount: agentSnapshot.agentCount,
      runningAgentCount: agentSnapshot.runningCount,
      browserSessionCount: this.browserManager.count(),
      attachedTransportCount: this.transports.size
    };
  }

  async shutdown(): Promise<void> {
    if (this.shuttingDown) return;
    this.shuttingDown = true;
    if (this.sweepTimer) clearInterval(this.sweepTimer);
    const clients = [...this.clients.values()].map((state) => ({
      clientId: state.clientId,
      leaseId: state.leaseId
    }));
    for (const client of clients) {
      await this.releaseClient(
        { clientId: client.clientId, leaseId: client.leaseId },
        "runtime_shutdown"
      ).catch((error) => this.logger.error("runtime_client_cleanup_failed", error, {
        client_id: client.clientId,
        lease_id: client.leaseId
      }));
    }
    await this.browserManager.closeAll().catch((error) => this.logger.error("browser_shutdown_failed", error));
    await this.chatgptBrowserManager.closeAll().catch((error) => this.logger.error("chatgpt_browser_shutdown_failed", error));
  }
}
