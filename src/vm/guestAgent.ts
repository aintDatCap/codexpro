import net from "node:net";
import type { LocalChannelEndpoint } from "./types.js";

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
}

function windowsPipePath(name: string): string {
  return `\\\\.\\pipe\\${name}`;
}

function socketForEndpoint(endpoint: LocalChannelEndpoint): net.Socket {
  if (endpoint.transport === "unix") return net.createConnection({ path: endpoint.path });
  if (endpoint.transport === "pipe") return net.createConnection({ path: windowsPipePath(endpoint.name) });
  return net.createConnection({ host: endpoint.host, port: endpoint.port });
}

async function connectSocket(endpoint: LocalChannelEndpoint, timeoutMs: number): Promise<net.Socket> {
  const socket = socketForEndpoint(endpoint);
  await new Promise<void>((resolve, reject) => {
    const cleanup = () => {
      clearTimeout(timer);
      socket.off("connect", onConnect);
      socket.off("error", onError);
    };
    const onConnect = () => {
      cleanup();
      resolve();
    };
    const onError = (error: Error) => {
      cleanup();
      reject(error);
    };
    const timer = setTimeout(() => {
      cleanup();
      socket.destroy();
      reject(new Error(`Timed out connecting to QEMU Guest Agent after ${timeoutMs} ms.`));
    }, timeoutMs);
    socket.once("connect", onConnect);
    socket.once("error", onError);
  });
  return socket;
}

export class GuestAgentClient {
  private buffer = "";
  private nextId = 1;
  private readonly pending = new Map<number, PendingRequest>();

  private constructor(private readonly socket: net.Socket) {
    socket.setEncoding("utf8");
    socket.on("data", (chunk) => this.onData(String(chunk)));
    socket.on("error", (error) => this.fail(error));
    socket.on("close", () => this.fail(new Error("QEMU Guest Agent connection closed.")));
  }

  static async connect(endpoint: LocalChannelEndpoint, timeoutMs = 1_000): Promise<GuestAgentClient> {
    const socket = await connectSocket(endpoint, timeoutMs);
    return new GuestAgentClient(socket);
  }

  private onData(chunk: string): void {
    this.buffer += chunk;
    for (;;) {
      const newline = this.buffer.indexOf("\n");
      if (newline < 0) break;
      const line = this.buffer.slice(0, newline).replace(/^\xFF+/, "").trim();
      this.buffer = this.buffer.slice(newline + 1);
      if (!line) continue;
      let message: any;
      try {
        message = JSON.parse(line);
      } catch {
        continue;
      }
      if (typeof message?.id !== "number") continue;
      const pending = this.pending.get(message.id);
      if (!pending) continue;
      this.pending.delete(message.id);
      clearTimeout(pending.timer);
      if (message.error) {
        pending.reject(new Error(`QEMU Guest Agent command failed: ${String(message.error.desc ?? message.error.class ?? "unknown error")}`));
      } else {
        pending.resolve(message.return);
      }
    }
  }

  private fail(error: Error): void {
    for (const request of this.pending.values()) {
      clearTimeout(request.timer);
      request.reject(error);
    }
    this.pending.clear();
  }

  private request(command: string, args?: Record<string, unknown>, timeoutMs = 1_500): Promise<unknown> {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`QEMU Guest Agent command ${command} timed out after ${timeoutMs} ms.`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      const payload = args === undefined ? { execute: command, id } : { execute: command, arguments: args, id };
      this.socket.write(`${JSON.stringify(payload)}\n`, (error) => {
        if (!error) return;
        const pending = this.pending.get(id);
        if (!pending) return;
        this.pending.delete(id);
        clearTimeout(pending.timer);
        pending.reject(error);
      });
    });
  }

  async ping(timeoutMs = 1_500): Promise<void> {
    await this.request("guest-ping", undefined, timeoutMs);
  }

  close(): void {
    this.socket.destroy();
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function waitForGuestAgent(endpoint: LocalChannelEndpoint, timeoutMs = 12_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    let client: GuestAgentClient | undefined;
    try {
      client = await GuestAgentClient.connect(endpoint, Math.min(750, Math.max(100, deadline - Date.now())));
      await client.ping(Math.min(1_500, Math.max(100, deadline - Date.now())));
      client.close();
      return true;
    } catch {
      client?.close();
      await sleep(300);
    }
  }
  return false;
}
