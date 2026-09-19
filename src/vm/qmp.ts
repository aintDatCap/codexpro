import net from "node:net";
import type { LocalChannelEndpoint } from "./types.js";

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
}

export class QmpCommandTimeoutError extends Error {
  constructor(command: string, timeoutMs: number) {
    super(`QMP command ${command} timed out after ${timeoutMs} ms.`);
    this.name = "QmpCommandTimeoutError";
  }
}

export class QmpConnectionError extends Error {}

export interface QmpStatus {
  status: string;
  running?: boolean;
  singlestep?: boolean;
  [key: string]: unknown;
}

export interface QmpInputEvent {
  type: "key" | "btn" | "rel" | "abs";
  data: Record<string, unknown>;
}

function windowsPipePath(name: string): string {
  return `\\\\.\\pipe\\${name}`;
}

function socketForEndpoint(endpoint: LocalChannelEndpoint): net.Socket {
  if (endpoint.transport === "unix") return net.createConnection({ path: endpoint.path });
  if (endpoint.transport === "pipe") return net.createConnection({ path: windowsPipePath(endpoint.name) });
  return net.createConnection({ host: endpoint.host, port: endpoint.port });
}

async function waitForConnect(socket: net.Socket, timeoutMs: number): Promise<void> {
  if (!socket.connecting && !socket.destroyed) return;
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
      reject(new Error(`Timed out connecting to QMP after ${timeoutMs} ms.`));
    }, timeoutMs);
    socket.once("connect", onConnect);
    socket.once("error", onError);
  });
}

export class QmpClient {
  private buffer = "";
  private nextId = 1;
  private readonly pending = new Map<number, PendingRequest>();
  private greetingResolve!: () => void;
  private greetingReject!: (error: Error) => void;
  private readonly greeting: Promise<void>;
  private failure?: Error;

  private constructor(private readonly socket: net.Socket) {
    this.greeting = new Promise<void>((resolve, reject) => {
      this.greetingResolve = resolve;
      this.greetingReject = reject;
    });
    socket.setEncoding("utf8");
    socket.on("data", (chunk) => this.onData(String(chunk)));
    socket.on("error", (error) => this.fail(new QmpConnectionError(error.message)));
    socket.on("close", () => this.fail(new QmpConnectionError("QMP connection closed.")));
  }

  static async connect(endpoint: LocalChannelEndpoint, timeoutMs = 3_000): Promise<QmpClient> {
    const socket = socketForEndpoint(endpoint);
    try {
      await waitForConnect(socket, timeoutMs);
      const client = new QmpClient(socket);
      await client.waitForGreeting(timeoutMs);
      await client.request("qmp_capabilities", undefined, timeoutMs);
      return client;
    } catch (error) {
      socket.destroy();
      throw error;
    }
  }

  private onData(chunk: string): void {
    this.buffer += chunk;
    for (;;) {
      const newline = this.buffer.indexOf("\n");
      if (newline < 0) break;
      const line = this.buffer.slice(0, newline).trim();
      this.buffer = this.buffer.slice(newline + 1);
      if (!line) continue;
      let message: any;
      try {
        message = JSON.parse(line);
      } catch {
        this.fail(new Error("QMP returned invalid JSON."));
        continue;
      }
      if (message?.QMP) {
        this.greetingResolve();
        continue;
      }
      if (typeof message?.id === "number") {
        const pending = this.pending.get(message.id);
        if (!pending) continue;
        this.pending.delete(message.id);
        clearTimeout(pending.timer);
        if (message.error) {
          pending.reject(new Error(`QMP command failed: ${String(message.error.desc ?? message.error.class ?? "unknown error")}`));
        } else {
          pending.resolve(message.return);
        }
      }
    }
  }

  private fail(error: Error): void {
    this.failure ??= error;
    this.greetingReject(error);
    for (const request of this.pending.values()) {
      clearTimeout(request.timer);
      request.reject(error);
    }
    this.pending.clear();
  }

  private async waitForGreeting(timeoutMs: number): Promise<void> {
    let timer: NodeJS.Timeout | undefined;
    try {
      await Promise.race([
        this.greeting,
        new Promise<void>((_, reject) => {
          timer = setTimeout(() => reject(new Error(`Timed out waiting for QMP greeting after ${timeoutMs} ms.`)), timeoutMs);
        })
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  private request(command: string, args?: Record<string, unknown>, timeoutMs = 3_000): Promise<unknown> {
    if (this.failure) return Promise.reject(this.failure);
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        // IDs are never reused; onData ignores any later reply to this request.
        reject(new QmpCommandTimeoutError(command, timeoutMs));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      const payload = args === undefined ? { execute: command, id } : { execute: command, arguments: args, id };
      this.socket.write(`${JSON.stringify(payload)}\r\n`, (error) => {
        if (!error) return;
        const pending = this.pending.get(id);
        if (!pending) return;
        this.pending.delete(id);
        clearTimeout(pending.timer);
        pending.reject(new QmpConnectionError(error.message));
      });
    });
  }

  async queryStatus(timeoutMs = 3_000): Promise<QmpStatus> {
    return (await this.request("query-status", undefined, timeoutMs)) as QmpStatus;
  }

  async continueRun(timeoutMs = 3_000): Promise<void> {
    await this.request("cont", undefined, timeoutMs);
  }

  async quit(timeoutMs = 3_000): Promise<void> {
    await this.request("quit", undefined, timeoutMs);
  }

  async systemPowerdown(timeoutMs = 3_000): Promise<void> {
    await this.request("system_powerdown", undefined, timeoutMs);
  }

  async systemReset(timeoutMs = 3_000): Promise<void> {
    await this.request("system_reset", undefined, timeoutMs);
  }

  async screendump(filename: string, timeoutMs = 5_000): Promise<void> {
    await this.request("screendump", { filename }, timeoutMs);
  }

  async inputSendEvent(events: readonly QmpInputEvent[], timeoutMs = 3_000): Promise<void> {
    await this.request("input-send-event", { events }, timeoutMs);
  }

  close(): void {
    this.socket.destroy();
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function connectQmpWithRetry(
  endpoint: LocalChannelEndpoint,
  timeoutMs = 5_000,
  perAttemptMs = 750
): Promise<QmpClient> {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      return await QmpClient.connect(endpoint, Math.min(perAttemptMs, Math.max(100, deadline - Date.now())));
    } catch (error) {
      lastError = error;
      await sleep(100);
    }
  }
  throw new Error(`Unable to connect to QMP: ${lastError instanceof Error ? lastError.message : String(lastError ?? "timeout")}`);
}
