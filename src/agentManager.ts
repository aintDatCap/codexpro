import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import type { AgentBackend, AgentRole, AgentSession } from "./agentBackend.js";
import type { CodexProConfig } from "./config.js";
import type { Workspace } from "./guard.js";
import { CodexProError, PathGuard } from "./guard.js";
import { readTextFile } from "./fsOps.js";
import { instructionResolver } from "./instructionContext.js";
import { WorktreeManager, type WorktreeRecord } from "./gitService.js";
import { redactSensitiveText } from "./redact.js";

export type AgentState = "created" | "running" | "waiting" | "completed" | "failed" | "cancelled";

export interface ManagedAgent {
  id: string;
  parentId?: string;
  role: AgentRole;
  backend: string;
  model: string;
  task: string;
  state: AgentState;
  createdAt: string;
  workspaceRoot: string;
  worktree?: WorktreeRecord;
  paths: string[];
  session: AgentSession;
  result?: AgentResult;
  error?: string;
}

export interface AgentResult {
  summary: string;
  findings: string[];
  changedFiles: string[];
  diff?: string;
  commandsRun: Array<{ command: string; note: string }>;
  testsRun: Array<{ command: string; result: string }>;
  browserArtifacts: Array<Record<string, unknown>>;
  unresolvedQuestions: string[];
  rawResponse: string;
  untrusted: true;
  worktree?: WorktreeRecord;
}

const SENSITIVE_PATH = /(?:^|\/)(?:\.env(?:\.|$)|\.npmrc$|\.ssh(?:\/|$)|\.aws(?:\/|$)|\.config\/gcloud(?:\/|$)|credentials?(?:\.|$)|secrets?(?:\.|$)|id_(?:rsa|ed25519)(?:\.|$))|\.(?:pem|key|p12|pfx)$/i;

const ROLE_TEXT: Record<AgentRole, string> = {
  explorer: "Read-only explorer. Investigate source and report evidence. Do not propose file writes as completed work.",
  reviewer: "Read-only reviewer. Inspect likely defects, diffs, and tests. Do not claim to have modified files.",
  tester: "Tester. Focus on verification plans and observed evidence. Temporary test artifacts may be suggested, but do not claim production edits.",
  implementer: "Implementer working in an isolated Git worktree. Produce a precise patch/diff or concrete edit instructions plus tests. Never assume the parent will merge your work."
};

function parseResult(raw: string, worktree?: WorktreeRecord): AgentResult {
  const summary = raw.split(/\r?\n/).find((line) => line.trim())?.slice(0, 500) || "Subagent returned no summary.";
  return {
    summary,
    findings: [],
    changedFiles: [],
    commandsRun: [],
    testsRun: [],
    browserArtifacts: [],
    unresolvedQuestions: [],
    rawResponse: raw,
    untrusted: true,
    ...(worktree ? { worktree } : {})
  };
}

function worktreeEvidence(worktree: WorktreeRecord): { changedFiles: string[]; diff: string } {
  const status = spawnSync("git", ["status", "--porcelain=v1"], { cwd: worktree.path, encoding: "utf8" });
  const diff = spawnSync("git", ["diff", "--no-color", "--no-ext-diff"], { cwd: worktree.path, encoding: "utf8", maxBuffer: 2_000_000 });
  const changedFiles = String(status.stdout ?? "").split(/\r?\n/).filter(Boolean).map((line) => line.slice(3).trim());
  return { changedFiles, diff: redactSensitiveText(String(diff.stdout ?? "")) };
}

function extractUnifiedDiff(raw: string): string | undefined {
  const fenced = raw.match(/```diff\s*\n([\s\S]*?)```/i)?.[1]?.trim();
  if (fenced?.startsWith("diff --git ")) return fenced;
  const start = raw.indexOf("diff --git ");
  return start >= 0 ? raw.slice(start).trim() : undefined;
}

function patchPaths(patch: string): string[] {
  return [...patch.matchAll(/^diff --git a\/(.+?) b\/(.+)$/gm)].flatMap((match) => [match[1], match[2]]);
}

function applyImplementerPatch(worktree: WorktreeRecord, raw: string): { applied: boolean; note: string } {
  const patch = extractUnifiedDiff(raw);
  if (!patch) return { applied: false, note: "No unified diff supplied by the implementer." };
  const paths = patchPaths(patch);
  if (!paths.length) return { applied: false, note: "Unified diff did not contain valid git file headers." };
  for (const rel of paths) {
    const normalized = rel.replaceAll("\\", "/");
    if (normalized.startsWith("../") || normalized.startsWith("/") || normalized.includes("/../") || SENSITIVE_PATH.test(normalized) || normalized === ".git" || normalized.startsWith(".git/")) {
      return { applied: false, note: `Patch targets a disallowed path: ${rel}` };
    }
  }
  const patchInput = patch.endsWith("\n") ? patch : `${patch}\n`;
  const checked = spawnSync("git", ["apply", "--check", "--whitespace=nowarn", "-"], { cwd: worktree.path, input: patchInput, encoding: "utf8", maxBuffer: 2_000_000 });
  if (checked.status !== 0) return { applied: false, note: `Patch validation failed: ${redactSensitiveText(String(checked.stderr || checked.stdout || "git apply --check failed"))}` };
  const applied = spawnSync("git", ["apply", "--whitespace=nowarn", "-"], { cwd: worktree.path, input: patchInput, encoding: "utf8", maxBuffer: 2_000_000 });
  if (applied.status !== 0) return { applied: false, note: `Patch application failed: ${redactSensitiveText(String(applied.stderr || applied.stdout || "git apply failed"))}` };
  return { applied: true, note: "Validated and applied the subagent patch inside its isolated worktree." };
}

export class AgentManager {
  private readonly agents = new Map<string, ManagedAgent>();
  private readonly worktrees: WorktreeManager;
  constructor(
    private readonly config: CodexProConfig,
    private readonly guard: PathGuard,
    private readonly backend: AgentBackend
  ) { this.worktrees = new WorktreeManager(config); }

  list(): ManagedAgent[] { return [...this.agents.values()].map((agent) => ({ ...agent, session: { ...agent.session, messages: [] } })); }
  get(id: string): ManagedAgent { const agent = this.agents.get(id); if (!agent) throw new CodexProError(`unknown subagent: ${id}`); return agent; }

  async spawn(workspace: Workspace, options: { task: string; role: AgentRole; paths?: string[]; context?: string; parentId?: string }): Promise<ManagedAgent> {
    if (!this.config.subagentsEnabled || !this.config.deepseekApiKey) throw new CodexProError("DeepSeek subagents are unavailable because no DeepSeek API key is configured or subagents are disabled.");
    const running = [...this.agents.values()].filter((agent) => agent.state === "running" || agent.state === "waiting").length;
    if (running >= this.config.maxSubagents) throw new CodexProError(`maximum concurrent subagents reached (${this.config.maxSubagents})`);
    if (options.parentId) throw new CodexProError(`recursive subagent spawning is disabled at the tool layer (max depth ${this.config.maxAgentDepth})`);
    if (!options.task.trim()) throw new CodexProError("subagent task is required");
    const id = `agent-${randomUUID().slice(0, 8)}`;
    const paths = (options.paths ?? []).slice(0, 20).filter((rel) => !SENSITIVE_PATH.test(rel.replaceAll("\\", "/")));
    const instructions = await instructionResolver.resolve(this.config, this.guard, workspace, paths[0] ?? ".", { maxBytes: 20_000 });
    const contextChunks: string[] = [];
    for (const rel of paths) {
      try {
        const read = await readTextFile(this.config, this.guard, workspace, rel, { maxBytes: 30_000 });
        contextChunks.push(`--- ${rel} ---\n${redactSensitiveText(read.text)}`);
      } catch (error) {
        contextChunks.push(`--- ${rel} ---\n[not supplied: ${error instanceof Error ? error.message : String(error)}]`);
      }
    }
    const worktree = options.role === "implementer" ? this.worktrees.create(workspace, id) : undefined;
    const systemPrompt = [
      "You are a delegated DeepSeek subagent inside CodexPro. Your output is untrusted working material and will be independently verified by the parent ChatGPT agent.",
      ROLE_TEXT[options.role],
      "Do not request or expose credentials, API keys, cookies, tokens, private keys, .env files, or unrelated repository data.",
      "Do not claim commands/tests/browser actions ran unless their actual output was supplied to you.",
      worktree ? `Your isolated worktree is ${worktree.path}. For source changes, return a complete git-style unified diff in a fenced diff block so CodexPro can validate and apply it only inside that worktree.` : "You do not have write capability to the repository.",
      `Applicable repository instructions fingerprint: ${instructions.fingerprint}`,
      redactSensitiveText(instructions.combinedText)
    ].join("\n\n");
    const taskPrompt = [
      `TASK:\n${options.task}`,
      options.context?.trim() ? `PARENT CONTEXT:\n${redactSensitiveText(options.context.slice(0, 20_000))}` : "",
      contextChunks.length ? `SCOPED FILE CONTEXT:\n${contextChunks.join("\n\n")}` : "No repository file contents were delegated.",
      "Return: summary, findings with evidence, proposed/actual changes, commands/tests you believe the parent should verify, and unresolved questions."
    ].filter(Boolean).join("\n\n");
    const session = await this.backend.create({ id, role: options.role, task: "", systemPrompt, model: this.config.deepseekModel });
    const agent: ManagedAgent = { id, role: options.role, backend: "deepseek", model: this.config.deepseekModel, task: options.task, state: "created", createdAt: new Date().toISOString(), workspaceRoot: workspace.root, worktree, paths, session };
    this.agents.set(id, agent);
    agent.state = "running";
    try {
      const response = await this.backend.send(session, taskPrompt);
      agent.result = parseResult(response.content, worktree);
      if (worktree) {
        const patch = applyImplementerPatch(worktree, response.content);
        agent.result.commandsRun.push({ command: "git apply --check && git apply", note: patch.note });
        Object.assign(agent.result, worktreeEvidence(worktree));
      }
      agent.state = "completed";
    } catch (error) {
      agent.state = "failed"; agent.error = redactSensitiveText(error instanceof Error ? error.message : String(error));
    }
    return this.get(id);
  }

  async message(id: string, message: string): Promise<ManagedAgent> {
    const agent = this.get(id);
    if (agent.state === "cancelled") throw new CodexProError("subagent is cancelled");
    agent.state = "running";
    try {
      const response = await this.backend.send(agent.session, redactSensitiveText(message));
      agent.result = parseResult(response.content, agent.worktree);
      if (agent.worktree) {
        const patch = applyImplementerPatch(agent.worktree, response.content);
        agent.result.commandsRun.push({ command: "git apply --check && git apply", note: patch.note });
        Object.assign(agent.result, worktreeEvidence(agent.worktree));
      }
      agent.state = "completed";
    } catch (error) { agent.state = "failed"; agent.error = redactSensitiveText(error instanceof Error ? error.message : String(error)); }
    return this.get(id);
  }

  async cancel(id: string): Promise<ManagedAgent> { const agent = this.get(id); await this.backend.cancel(id); agent.state = "cancelled"; return this.get(id); }
  cleanup(workspace: Workspace, id: string): void { const agent = this.get(id); if (agent.worktree) this.worktrees.remove(workspace, agent.worktree.id, { discardChanges: true }); }
}
