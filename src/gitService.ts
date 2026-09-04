import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import type { CodexProConfig } from "./config.js";
import type { Workspace } from "./guard.js";
import { CodexProError, PathGuard, isSubpath } from "./guard.js";
import { redactSensitiveText } from "./redact.js";

export interface GitCommandResult { args: string[]; exitCode: number | null; stdout: string; stderr: string; }

function run(workspace: Workspace, args: string[], maxOutputBytes: number): GitCommandResult {
  const result = spawnSync("git", args, { cwd: workspace.root, encoding: "utf8", maxBuffer: maxOutputBytes, env: { ...process.env, NO_COLOR: "1" } });
  if (result.error) throw new CodexProError(`git failed: ${result.error.message}`);
  return { args, exitCode: result.status, stdout: redactSensitiveText(result.stdout ?? ""), stderr: redactSensitiveText(result.stderr ?? "") };
}

function ok(result: GitCommandResult): GitCommandResult {
  if (result.exitCode !== 0) throw new CodexProError(result.stderr.trim() || result.stdout.trim() || `git exited ${result.exitCode}`);
  return result;
}

export class GitService {
  constructor(private readonly config: CodexProConfig, private readonly guard: PathGuard) {}
  status(workspace: Workspace) { return ok(run(workspace, ["status", "--short", "--branch"], this.config.maxOutputBytes)); }
  currentBranch(workspace: Workspace) { return ok(run(workspace, ["branch", "--show-current"], this.config.maxOutputBytes)); }
  branches(workspace: Workspace) { return ok(run(workspace, ["branch", "--format=%(refname:short)"], this.config.maxOutputBytes)); }
  log(workspace: Workspace, count = 10) { return ok(run(workspace, ["log", `--max-count=${Math.max(1, Math.min(count, 100))}`, "--oneline", "--decorate"], this.config.maxOutputBytes)); }
  show(workspace: Workspace, ref = "HEAD") { return ok(run(workspace, ["show", "--no-color", "--no-ext-diff", ref], this.config.maxOutputBytes)); }
  blame(workspace: Workspace, file: string) { const rel = this.guard.resolve(workspace, file).relPath; return ok(run(workspace, ["blame", "--", rel], this.config.maxOutputBytes)); }
  root(workspace: Workspace) { return ok(run(workspace, ["rev-parse", "--show-toplevel"], this.config.maxOutputBytes)); }
  changedFiles(workspace: Workspace) { return ok(run(workspace, ["status", "--porcelain=v1"], this.config.maxOutputBytes)); }
  createBranch(workspace: Workspace, name: string, startPoint?: string) { return ok(run(workspace, ["branch", name, ...(startPoint ? [startPoint] : [])], this.config.maxOutputBytes)); }
  switchBranch(workspace: Workspace, name: string, create = false) { return ok(run(workspace, ["switch", ...(create ? ["-c"] : []), name], this.config.maxOutputBytes)); }
  stage(workspace: Workspace, files: string[]) { const rel = files.map((f) => this.guard.resolve(workspace, f).relPath); return ok(run(workspace, ["add", "--", ...rel], this.config.maxOutputBytes)); }
  unstage(workspace: Workspace, files: string[]) { const rel = files.map((f) => this.guard.resolve(workspace, f).relPath); return ok(run(workspace, ["restore", "--staged", "--", ...rel], this.config.maxOutputBytes)); }
  restore(workspace: Workspace, files: string[]) { const rel = files.map((f) => this.guard.resolve(workspace, f).relPath); return ok(run(workspace, ["restore", "--", ...rel], this.config.maxOutputBytes)); }
  commit(workspace: Workspace, message: string) { if (!message.trim()) throw new CodexProError("commit message is required"); return ok(run(workspace, ["commit", "-m", message], this.config.maxOutputBytes)); }
}

export interface WorktreeRecord { id: string; path: string; branch: string; createdAt: string; }

export class WorktreeManager {
  private readonly records = new Map<string, WorktreeRecord>();
  constructor(private readonly config: CodexProConfig) {}
  create(workspace: Workspace, id: string, branch?: string): WorktreeRecord {
    const safeId = id.replace(/[^A-Za-z0-9._-]/g, "-").slice(0, 80);
    const root = this.config.worktreeRoot ? path.resolve(this.config.worktreeRoot) : path.join(workspace.root, ".codexpro-worktrees");
    if (!isSubpath(root, workspace.root) && !this.config.worktreeRoot) throw new CodexProError("invalid worktree root");
    fs.mkdirSync(root, { recursive: true });
    const target = path.join(root, safeId);
    if (fs.existsSync(target)) throw new CodexProError(`worktree path already exists: ${target}`);
    const branchName = branch || `codexpro/${safeId}`;
    ok(run(workspace, ["worktree", "add", "-b", branchName, target, "HEAD"], this.config.maxOutputBytes));
    const record = { id: safeId, path: target, branch: branchName, createdAt: new Date().toISOString() };
    this.records.set(safeId, record);
    return record;
  }
  remove(workspace: Workspace, id: string, options: { discardChanges?: boolean } = {}): void {
    const record = this.records.get(id);
    if (!record) throw new CodexProError("refusing to remove an unowned worktree");
    const result = run(workspace, ["worktree", "remove", ...(options.discardChanges ? ["--force"] : []), record.path], this.config.maxOutputBytes);
    ok(result);
    this.records.delete(id);
  }
  list(): WorktreeRecord[] { return [...this.records.values()]; }
}
