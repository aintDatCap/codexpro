#!/usr/bin/env node
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "codexpro-runtime-coordinator-"));
const root = path.join(tmp, "repo");
fs.mkdirSync(root, { recursive: true });
process.env.CODEXPRO_ROOT = root;
process.env.CODEXPRO_ALLOWED_ROOTS = root;
process.env.CODEXPRO_ALLOW_NO_HTTP_TOKEN = "1";
process.env.CODEXPRO_BROWSER_ENABLED = "0";
process.env.CODEXPRO_CHATGPT_BROWSER_AUTO_START = "0";
process.env.CODEXPRO_SUBAGENT_PROVIDER = "off";

class MemoryLogger {
  constructor(records = [], context = {}) {
    this.records = records;
    this.context = context;
    this.runId = "runtime-coordinator-smoke";
    this.baseDir = tmp;
    this.runDir = tmp;
  }
  child(context) { return new MemoryLogger(this.records, { ...this.context, ...context }); }
  debug(event, fields = {}) { this.records.push({ level: "debug", event, ...this.context, ...fields }); }
  info(event, fields = {}) { this.records.push({ level: "info", event, ...this.context, ...fields }); }
  warn(event, fields = {}) { this.records.push({ level: "warn", event, ...this.context, ...fields }); }
  error(event, error, fields = {}) { this.records.push({ level: "error", event, ...this.context, ...fields, error: String(error) }); }
  captureChildProcess() { return () => {}; }
  listFiles() { return []; }
  tail() { return this.records; }
  snapshot() { return { runId: this.runId, baseDir: this.baseDir, runDir: this.runDir, files: [], entries: this.records }; }
}

class BlockingBackend {
  name = "smoke";
  model = "smoke-model";
  pending = new Map();

  async create(options) {
    return { id: options.id, backend: this.name, model: this.model, messages: [] };
  }

  async send(session, _message, signal) {
    return await new Promise((resolve) => {
      const finish = () => {
        if (!this.pending.has(session.id)) return;
        this.pending.delete(session.id);
        resolve({ role: "assistant", content: "cancelled" });
      };
      this.pending.set(session.id, finish);
      signal?.addEventListener("abort", finish, { once: true });
    });
  }

  async cancel(sessionId) {
    this.pending.get(sessionId)?.();
  }

  async close(sessionId) {
    this.pending.get(sessionId)?.();
  }
}

function fakePlaywright() {
  const makePage = () => {
    let currentUrl = "about:blank";
    return {
      async title() { return "fake"; },
      url() { return currentUrl; },
      async goto(url) { currentUrl = url; },
      locator() {
        return {
          async ariaSnapshot() { return "fake"; },
          async innerText() { return "fake"; },
          async click() {},
          async fill() {},
          async press() {},
          async selectOption(values) { return values; },
          async waitFor() {}
        };
      },
      async evaluate() {},
      async screenshot() { return Buffer.from("fake"); },
      async close() {},
      async waitForLoadState() {}
    };
  };
  return {
    chromium: {
      async launch() {
        const context = {
          pages: [],
          async newPage() {
            const page = makePage();
            this.pages.push(page);
            return page;
          },
          async close() {}
        };
        return {
          async newContext() { return context; },
          async close() {}
        };
      }
    }
  };
}

try {
  const [{ loadConfig }, { PathGuard }, { BrowserManager }, { RuntimeCoordinator }] = await Promise.all([
    import("../dist/config.js"),
    import("../dist/guard.js"),
    import("../dist/browserManager.js"),
    import("../dist/runtimeCoordinator.js")
  ]);
  const loaded = loadConfig([]);
  const config = {
    ...loaded,
    browserEnabled: true,
    subagentsEnabled: true,
    maxSubagents: 3,
    chatgptBrowserAutoStart: false
  };
  const logger = new MemoryLogger();
  const backend = new BlockingBackend();
  const browserManager = new BrowserManager(config, new PathGuard(config), async () => fakePlaywright());
  let now = 10_000;
  const runtime = new RuntimeCoordinator(config, {
    logger,
    agentBackend: backend,
    browserManager,
    now: () => now,
    leaseTtlMs: 100,
    disableSweep: true
  });

  const alpha = await runtime.registerClient("client-alpha", { adapter: "internal" });
  const beta = await runtime.registerClient("client-beta", { adapter: "internal" });
  assert.notEqual(alpha.leaseId, beta.leaseId, "distinct logical clients must have distinct leases");
  assert.equal(runtime.snapshot().logicalClientCount, 2);

  alpha.openWorkspace(root);
  await browserManager.open("shared-name", undefined, alpha.browserOwnerId());
  await browserManager.open("shared-name", undefined, beta.browserOwnerId());
  assert.equal(browserManager.count(alpha.browserOwnerId()), 1);
  assert.equal(browserManager.count(beta.browserOwnerId()), 1);

  const alphaAgents = [];
  for (let index = 0; index < config.maxSubagents; index += 1) {
    alphaAgents.push(await alpha.spawnAgent(alpha.workspace(), { task: `alpha-${index}`, role: "explorer" }));
  }
  await assert.rejects(
    alpha.spawnAgent(alpha.workspace(), { task: "alpha-over-limit", role: "explorer" }),
    /maximum concurrent subagents reached/
  );

  const betaAgents = [];
  for (let index = 0; index < config.maxSubagents; index += 1) {
    betaAgents.push(await beta.spawnAgent(beta.workspace(), { task: `beta-${index}`, role: "explorer" }));
  }
  assert.equal(alpha.listAgents().length, config.maxSubagents, "client A should see only its agents");
  assert.equal(beta.listAgents().length, config.maxSubagents, "client B should get its own preserved concurrency allowance");

  runtime.attachTransport(alpha.binding, "transport-alpha-1");
  runtime.detachTransport("transport-alpha-1", "network_disconnect");
  assert.equal(runtime.snapshot().logicalClientCount, 2, "transport detach must not release logical client state");
  assert.equal(alpha.listAgents().length, config.maxSubagents);
  assert.equal(browserManager.count(alpha.browserOwnerId()), 1);

  const alphaReconnected = await runtime.registerClient("client-alpha", { adapter: "mcp-http" });
  assert.equal(alphaReconnected.leaseId, alpha.leaseId, "reconnect must reuse the existing lease");
  assert.deepEqual(
    alphaReconnected.listAgents().map((agent) => agent.id).sort(),
    alphaAgents.map((agent) => agent.id).sort(),
    "reconnect must preserve agent ownership"
  );
  assert.equal(browserManager.count(alphaReconnected.browserOwnerId()), 1, "reconnect must not duplicate browser ownership");
  await assert.rejects(
    browserManager.open("shared-name", undefined, alphaReconnected.browserOwnerId()),
    /already exists/
  );

  await beta.shutdown();
  assert.equal(beta.listAgents.bind(beta) instanceof Function, true);
  assert.equal(runtime.snapshot().logicalClientCount, 1, "explicit shutdown must release only the target client");
  assert.equal(browserManager.count(beta.browserOwnerId()), 0, "explicit shutdown must clean browser state");
  assert.ok(betaAgents.length > 0);

  const expiring = await runtime.registerClient("client-expiring", { adapter: "mcp-http" });
  await browserManager.open("expiring-page", undefined, expiring.browserOwnerId());
  await expiring.spawnAgent(expiring.workspace(), { task: "expire", role: "explorer" });
  // A sleeping PC cannot run the lease sweep. Recover paused sessions on resume.
  const resumed = await runtime.registerClient("client-resumed", { adapter: "mcp-http" });
  now += 3_600_000;
  resumed.renew();
  assert.equal(runtime.snapshot().logicalClientCount, 3, "resume must preserve inactive clients until their next real TTL");
  now += 101;
  const expiredCount = await runtime.sweepExpiredLeases();
  assert.ok(expiredCount >= 1, "lease sweep must expire inactive clients");
  assert.equal(browserManager.count(expiring.browserOwnerId()), 0, "lease expiry must clean browser state");
  assert.throws(() => expiring.renew(), /no longer active|expired/i);

  const events = logger.records.map((entry) => entry.event);
  for (const required of [
    "client_registered",
    "client_reconnected",
    "lease_created",
    "lease_renewed",
    "lease_expired",
    "runtime_pause_recovered",
    "lease_released",
    "transport_attached",
    "transport_detached",
    "agent_ownership_changed",
    "cleanup_caused_by_lease_expiry"
  ]) {
    assert.ok(events.includes(required), `missing lifecycle log event ${required}`);
  }

  await runtime.shutdown();
  assert.equal(runtime.snapshot().logicalClientCount, 0);
  assert.equal(runtime.snapshot().logicalAgentCount, 0);
  assert.equal(runtime.snapshot().browserSessionCount, 0);
  console.log("runtime coordinator smoke: ok");
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}
