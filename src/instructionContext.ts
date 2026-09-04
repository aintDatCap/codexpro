import { createHash } from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import type { CodexProConfig } from "./config.js";
import type { Workspace } from "./guard.js";
import { PathGuard } from "./guard.js";
import { readTextFile } from "./fsOps.js";

export interface InstructionContext {
  files: string[];
  combinedText: string;
  fingerprint: string;
  changed: boolean;
}

interface CachedInstructionContext {
  signature: string;
  files: string[];
  combinedText: string;
  fingerprint: string;
}

const INSTRUCTION_NAMES = ["AGENTS.override.md", "AGENTS.md", "agents.md", ".agents.md"] as const;
const cache = new Map<string, CachedInstructionContext>();

function targetDirectories(targetPath: string): string[] {
  const normalized = targetPath.split(path.sep).join("/").replace(/^\.\//, "");
  const rawParts = normalized && normalized !== "." ? normalized.split("/").filter(Boolean) : [];
  const leafLooksLikeFile = rawParts.length > 0 && path.posix.extname(rawParts.at(-1) ?? "") !== "";
  const parts = leafLooksLikeFile ? rawParts.slice(0, -1) : rawParts;
  const dirs = ["."];
  for (let index = 0; index < parts.length; index += 1) {
    dirs.push(parts.slice(0, index + 1).join("/"));
  }
  return dirs;
}

async function safeFiles(dir: string): Promise<fs.Dirent[]> {
  try {
    return (await fsp.readdir(dir, { withFileTypes: true })).filter((entry) => entry.isFile());
  } catch {
    return [];
  }
}

async function effectiveInstructionFile(workspace: Workspace, dir: string): Promise<string | undefined> {
  const absDir = path.join(workspace.root, dir === "." ? "" : dir);
  const entries = await safeFiles(absDir);
  for (const candidate of INSTRUCTION_NAMES) {
    const exact = entries.find((entry) => entry.name === candidate);
    const insensitive = exact ?? entries.find((entry) => entry.name.toLowerCase() === candidate.toLowerCase());
    if (!insensitive) continue;
    return dir === "." ? insensitive.name : `${dir}/${insensitive.name}`;
  }
  return undefined;
}

async function fileSignature(workspace: Workspace, files: string[]): Promise<string> {
  const parts: string[] = [];
  for (const rel of files) {
    try {
      const stat = await fsp.stat(path.join(workspace.root, rel));
      parts.push(`${rel}\0${stat.size}\0${stat.mtimeMs}`);
    } catch {
      parts.push(`${rel}\0missing`);
    }
  }
  return createHash("sha256").update(parts.join("\n")).digest("hex");
}

export class InstructionResolver {
  async resolve(
    config: CodexProConfig,
    guard: PathGuard,
    workspace: Workspace,
    targetPath: string,
    options: { maxBytes?: number; previousFingerprint?: string } = {}
  ): Promise<InstructionContext> {
    guard.resolve(workspace, targetPath);
    const candidates = await Promise.all(targetDirectories(targetPath).map((dir) => effectiveInstructionFile(workspace, dir)));
    const files = candidates.filter((value): value is string => Boolean(value));
    const signature = await fileSignature(workspace, files);
    const key = `${workspace.root}\0${targetDirectories(targetPath).join("|")}\0${Math.min(options.maxBytes ?? 60_000, config.maxReadBytes)}`;
    let cached = cache.get(key);

    if (!cached || cached.signature !== signature || cached.files.join("\0") !== files.join("\0")) {
      const chunks: string[] = [];
      const fingerprintHash = createHash("sha256");
      for (const rel of files) {
        try {
          const read = await readTextFile(config, guard, workspace, rel, {
            maxBytes: Math.min(options.maxBytes ?? 60_000, config.maxReadBytes)
          });
          chunks.push(`--- ${rel} ---\n${read.text}`);
          fingerprintHash.update(rel).update("\0").update(read.text).update("\0");
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          chunks.push(`--- ${rel} ---\n[unreadable: ${message}]`);
          fingerprintHash.update(rel).update("\0unreadable\0").update(message).update("\0");
        }
      }
      const combinedText = chunks.length
        ? chunks.join("\n\n")
        : "No AGENTS.md-style instruction files found for this target path.";
      cached = {
        signature,
        files,
        combinedText,
        fingerprint: fingerprintHash.update(files.length ? "instructions" : "none").digest("hex")
      };
      cache.set(key, cached);
    }

    const changed = options.previousFingerprint !== cached.fingerprint;
    return {
      files: cached.files,
      combinedText: changed ? cached.combinedText : "Instruction context unchanged; reuse the previously supplied instruction text.",
      fingerprint: cached.fingerprint,
      changed
    };
  }

  invalidateWorkspace(workspace: Workspace): void {
    for (const key of cache.keys()) {
      if (key.startsWith(`${workspace.root}\0`)) cache.delete(key);
    }
  }
}

export const instructionResolver = new InstructionResolver();
