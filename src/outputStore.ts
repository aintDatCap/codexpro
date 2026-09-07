import { randomUUID } from "node:crypto";
import { CodexProError } from "./guard.js";

// Session-local, bounded retention; no command output is persisted on disk.
export class OutputStore {
  readonly captureBytes = 2_000_000;
  private readonly entries = new Map<string, { workspaceId: string; stdout: string; stderr: string; incomplete: boolean }>();

  save(workspaceId: string, stdout: string, stderr: string, incomplete: boolean): string {
    const id = `output_${randomUUID()}`;
    this.entries.set(id, { workspaceId, stdout, stderr, incomplete });
    while (this.entries.size > 4) this.entries.delete(this.entries.keys().next().value!);
    return id;
  }

  read(workspaceId: string, id: string, stream: "stdout" | "stderr", offset = 0, maxChars = 8000) {
    const entry = this.entries.get(id);
    if (!entry || entry.workspaceId !== workspaceId) throw new CodexProError("Output unavailable for this workspace. Outputs expire after four commands or a session reconnect.");
    if (!Number.isInteger(offset) || offset < 0 || !Number.isInteger(maxChars) || maxChars < 2 || maxChars > 8000) throw new CodexProError("Invalid output page bounds.");
    const value = entry[stream];
    let end = Math.min(value.length, offset + maxChars);
    // Do not split a UTF-16 surrogate pair at a page boundary.
    if (end < value.length && /[\uD800-\uDBFF]/.test(value[end - 1])) end--;
    const text = value.slice(offset, end);
    return { text, output_resource_id: id, stream, offset, next_offset: end < value.length ? end : null, total_chars: value.length, incomplete: entry.incomplete };
  }
}
