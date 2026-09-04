import type { AgentBackend, AgentMessage, AgentOptions, AgentSession } from "./agentBackend.js";
import { CodexProError } from "./guard.js";
import { redactSensitiveText } from "./redact.js";

export class DeepSeekBackend implements AgentBackend {
  private readonly controllers = new Map<string, AbortController>();
  constructor(private readonly apiKey: string) {
    if (!apiKey.trim()) throw new CodexProError("DeepSeek backend requires a configured API key");
  }

  async create(options: AgentOptions): Promise<AgentSession> {
    const messages: AgentMessage[] = [{ role: "system", content: options.systemPrompt }];
    if (options.task.trim()) messages.push({ role: "user", content: options.task });
    return { id: options.id, backend: "deepseek", model: options.model, messages };
  }

  async send(session: AgentSession, message: string, signal?: AbortSignal): Promise<AgentMessage> {
    const controller = new AbortController();
    this.controllers.set(session.id, controller);
    const abort = () => controller.abort();
    signal?.addEventListener("abort", abort, { once: true });
    const messages = [...session.messages, { role: "user" as const, content: message }];
    try {
      const response = await fetch("https://api.deepseek.com/chat/completions", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${this.apiKey}`
        },
        body: JSON.stringify({ model: session.model, messages, stream: false }),
        signal: controller.signal
      });
      const body = await response.json().catch(() => ({})) as any;
      if (!response.ok) {
        const messageText = body?.error?.message || `DeepSeek request failed with HTTP ${response.status}`;
        throw new CodexProError(redactSensitiveText(messageText));
      }
      const content = String(body?.choices?.[0]?.message?.content ?? "");
      const assistant: AgentMessage = { role: "assistant", content: redactSensitiveText(content) };
      session.messages.push({ role: "user", content: message }, assistant);
      return assistant;
    } finally {
      signal?.removeEventListener("abort", abort);
      this.controllers.delete(session.id);
    }
  }

  async cancel(sessionId: string): Promise<void> { this.controllers.get(sessionId)?.abort(); }
}
