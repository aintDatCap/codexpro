export type AgentRole = "explorer" | "reviewer" | "tester" | "implementer";

export interface AgentOptions {
  id: string;
  role: AgentRole;
  task: string;
  systemPrompt: string;
  model: string;
}

export interface AgentMessage { role: "system" | "user" | "assistant"; content: string; }
export interface AgentSession { id: string; backend: string; model: string; messages: AgentMessage[]; }

export interface AgentBackend {
  create(options: AgentOptions): Promise<AgentSession>;
  send(session: AgentSession, message: string, signal?: AbortSignal): Promise<AgentMessage>;
  cancel(sessionId: string): Promise<void>;
}
