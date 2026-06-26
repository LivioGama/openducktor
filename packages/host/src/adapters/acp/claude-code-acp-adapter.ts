import { CLAUDE_CODE_RUNTIME_DESCRIPTOR, type RuntimeDescriptor } from "@openducktor/contracts";
import type {
  AgentCatalogPort,
  AgentEvent,
  AgentModelCatalog,
  AgentRole,
  AgentSessionHistoryMessage,
  AgentSessionPort,
  AgentSessionPresenceSnapshot,
  AgentSessionSummary,
  AgentSessionTodoItem,
  AgentWorkspaceInspectionPort,
  AttachAgentSessionInput,
  EventUnsubscribe,
  ForkAgentSessionInput,
  ListAgentModelsInput,
  ListLiveAgentSessionsInput,
  ListSessionPresenceInput,
  LiveAgentSessionSummary,
  LoadAgentFileStatusInput,
  LoadAgentSessionDiffInput,
  LoadAgentSessionHistoryInput,
  LoadAgentSessionTodosInput,
  ReadSessionPresenceInput,
  ReplyApprovalInput,
  ReplyQuestionInput,
  ResumeAgentSessionInput,
  SendAgentUserMessageInput,
  StartAgentSessionInput,
  UpdateAgentSessionModelInput,
} from "@openducktor/core";
import { acpAgentManager, type AcpAgent, findAgent, fetchRegistry } from "../../acp-client.js";

type ClaudeCodeAcpAdapterOptions = {
  now?: () => string;
};

interface SessionState {
  summary: AgentSessionSummary;
  agentId: string;
  workingDirectory: string;
  eventListeners: Set<(event: AgentEvent) => void>;
}

const CLAUDE_CODE_AGENT_ID = "claude-code";

export class ClaudeCodeAcpAdapter
  implements AgentCatalogPort, AgentSessionPort, AgentWorkspaceInspectionPort
{
  private readonly now: () => string;
  private readonly sessions = new Map<string, SessionState>();

  constructor(options: ClaudeCodeAcpAdapterOptions = {}) {
    this.now = options.now ?? (() => new Date().toISOString());
  }

  getRuntimeDefinition(): RuntimeDescriptor {
    return CLAUDE_CODE_RUNTIME_DESCRIPTOR;
  }

  listRuntimeDefinitions(): RuntimeDescriptor[] {
    return [this.getRuntimeDefinition()];
  }

  async startSession(input: StartAgentSessionInput): Promise<AgentSessionSummary> {
    const registry = await fetchRegistry();
    const agent = findAgent(registry, CLAUDE_CODE_AGENT_ID);

    if (!agent) {
      throw new Error(`Claude Code agent not found in registry`);
    }

    const client = await acpAgentManager.getOrCreateClient(agent);
    const sessionResponse = await client.createSession(
      input.workingDirectory,
      []
    );

    const externalSessionId = sessionResponse.sessionId;
    const summary: AgentSessionSummary = {
      externalSessionId,
      runtimeKind: "claude-code",
      role: input.role ?? 'planner',
      startedAt: this.now(),
      status: "running",
    };

    this.sessions.set(externalSessionId, {
      summary,
      agentId: CLAUDE_CODE_AGENT_ID,
      workingDirectory: input.workingDirectory,
      eventListeners: new Set(),
    });

    return summary;
  }

  async resumeSession(input: ResumeAgentSessionInput): Promise<AgentSessionSummary> {
    const registry = await fetchRegistry();
    const agent = findAgent(registry, CLAUDE_CODE_AGENT_ID);

    if (!agent) {
      throw new Error(`Claude Code agent not found in registry`);
    }

    const client = await acpAgentManager.getOrCreateClient(agent);
    
    const sessionResponse = await client.createSession(
      input.workingDirectory,
      []
    );

    const externalSessionId = sessionResponse.sessionId;
    const summary: AgentSessionSummary = {
      externalSessionId,
      runtimeKind: input.runtimeKind || "claude-code",
      role: input.role ?? 'planner',
      startedAt: this.now(),
      status: "running",
    };

    this.sessions.set(externalSessionId, {
      summary,
      agentId: CLAUDE_CODE_AGENT_ID,
      workingDirectory: input.workingDirectory,
      eventListeners: new Set(),
    });

    return summary;
  }

  async stopSession(externalSessionId: string): Promise<void> {
    const session = this.sessions.get(externalSessionId);
    if (session) {
      const registry = await fetchRegistry();
      const agent = findAgent(registry, session.agentId);
      if (agent) {
        // Note: ACP doesn't have explicit session close in basic protocol
        // The session ends when the agent process is stopped
        await acpAgentManager.stopAgent(session.agentId);
      }
      this.sessions.delete(externalSessionId);
    }
  }

  async forkSession(input: ForkAgentSessionInput): Promise<AgentSessionSummary> {
    const registry = await fetchRegistry();
    const agent = findAgent(registry, CLAUDE_CODE_AGENT_ID);

    if (!agent) {
      throw new Error(`Claude Code agent not found in registry`);
    }

    const client = await acpAgentManager.getOrCreateClient(agent);
    
    try {
      const sessionResponse = await client.createSession(
        input.workingDirectory,
        []
      );

      const externalSessionId = sessionResponse.sessionId;
      const summary: AgentSessionSummary = {
        externalSessionId,
        runtimeKind: "claude-code",
        role: input.role ?? 'planner',
        startedAt: this.now(),
        status: "running",
      };

      this.sessions.set(externalSessionId, {
        summary,
        agentId: CLAUDE_CODE_AGENT_ID,
        workingDirectory: input.workingDirectory,
        eventListeners: new Set(),
      });

      return summary;
    } catch (error) {
      throw new Error(`Failed to fork session: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  async sendUserMessage(input: SendAgentUserMessageInput): Promise<void> {
    const session = this.sessions.get(input.externalSessionId);
    if (!session) {
      throw new Error(`Session not found: ${input.externalSessionId}`);
    }

    const registry = await fetchRegistry();
    const agent = findAgent(registry, session.agentId);
    if (!agent) {
      throw new Error(`Agent not found: ${session.agentId}`);
    }

    const client = await acpAgentManager.getOrCreateClient(agent);
    
    // Use session/prompt to send user message
    try {
      const textContent = input.parts.find(p => p.kind === 'text')?.text || '';
      await client.sendRequest("session/prompt", {
        sessionId: input.externalSessionId,
        prompt: textContent,
      });
    } catch (error) {
      throw new Error(`Failed to send user message: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  async replyQuestion(input: ReplyQuestionInput): Promise<void> {
    const session = this.sessions.get(input.externalSessionId);
    if (!session) {
      throw new Error(`Session not found: ${input.externalSessionId}`);
    }

    const registry = await fetchRegistry();
    const agent = findAgent(registry, session.agentId);
    if (!agent) {
      throw new Error(`Agent not found: ${session.agentId}`);
    }

    const client = await acpAgentManager.getOrCreateClient(agent);
    
    // Send elicitation response
    try {
      await client.sendRequest("session/elicitation", {
        sessionId: input.externalSessionId,
        elicitationId: input.requestId,
        response: input.answers[0]?.[0] || '',
      });
    } catch (error) {
      throw new Error(`Failed to reply to question: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  async replyApproval(input: ReplyApprovalInput): Promise<void> {
    const session = this.sessions.get(input.externalSessionId);
    if (!session) {
      throw new Error(`Session not found: ${input.externalSessionId}`);
    }

    const registry = await fetchRegistry();
    const agent = findAgent(registry, session.agentId);
    if (!agent) {
      throw new Error(`Agent not found: ${session.agentId}`);
    }

    const client = await acpAgentManager.getOrCreateClient(agent);
    
    // Send permission response
    try {
      await client.sendRequest("session/request_permission", {
        sessionId: input.externalSessionId,
        permissionId: input.requestId,
        outcome: input.outcome,
      });
    } catch (error) {
      throw new Error(`Failed to reply to approval: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  async updateSessionModel(input: UpdateAgentSessionModelInput): Promise<void> {
    const session = this.sessions.get(input.externalSessionId);
    if (!session) {
      throw new Error(`Session not found: ${input.externalSessionId}`);
    }

    const registry = await fetchRegistry();
    const agent = findAgent(registry, session.agentId);
    if (!agent) {
      throw new Error(`Agent not found: ${session.agentId}`);
    }

    const client = await acpAgentManager.getOrCreateClient(agent);
    
    try {
      await client.sendRequest("session/set_model", {
        sessionId: input.externalSessionId,
        model: input.model,
      });
    } catch (error) {
      throw new Error(`Failed to update session model: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  hasSession(externalSessionId: string): boolean {
    return this.sessions.has(externalSessionId);
  }

  // Catalog operations
  async listAvailableModels(input?: ListAgentModelsInput): Promise<AgentModelCatalog> {
    const registry = await fetchRegistry();
    const agent = findAgent(registry, CLAUDE_CODE_AGENT_ID);

    if (!agent) {
      throw new Error(`Claude Code agent not found in registry`);
    }

    const client = await acpAgentManager.getOrCreateClient(agent);
    const cwd = input?.workingDirectory || process.cwd();
    const models = await client.getModels(cwd);

    return {
      models: models.map((m) => ({
        id: m.modelId,
        providerId: "claude",
        providerName: "Anthropic",
        modelId: m.modelId,
        modelName: m.name,
        variants: [],
      })),
      defaultModelsByProvider: {},
    };
  }

  async listAvailableSlashCommands(): Promise<{ commands: any[] }> {
    return { commands: [] };
  }

  async searchFiles(input: { query: string }): Promise<any[]> {
    return [];
  }

  async listLiveAgentSessions(input?: ListLiveAgentSessionsInput): Promise<LiveAgentSessionSummary[]> {
    return [];
  }

  async listSessionPresence(input?: ListSessionPresenceInput): Promise<AgentSessionPresenceSnapshot[]> {
    return [];
  }

  async readSessionPresence(input: ReadSessionPresenceInput): Promise<AgentSessionPresenceSnapshot> {
    return {
      presence: "persisted_only",
      classification: "persisted_only",
      ref: input,
      runtimeId: null,
      reason: "Stub",
      pendingApprovals: [],
      pendingQuestions: [],
    };
  }

  // Workspace inspection operations
  async loadSessionHistory(input: LoadAgentSessionHistoryInput): Promise<AgentSessionHistoryMessage[]> {
    return [];
  }

  async loadSessionTodos(input: LoadAgentSessionTodosInput): Promise<AgentSessionTodoItem[]> {
    return [];
  }

  async loadSessionDiff(input: LoadAgentSessionDiffInput): Promise<{ file: string; type: string; additions: number; deletions: number; diff: string; }[]> {
    return [];
  }

  async loadFileStatus(input: LoadAgentFileStatusInput): Promise<{ path: string; status: string; staged: boolean; }[]> {
    return [];
  }

  async attachSession(input: AttachAgentSessionInput): Promise<AgentSessionSummary> {
    if ('purpose' in input && input.purpose === 'transcript') {
      // Handle transcript attachment case
      const summary: AgentSessionSummary = {
        externalSessionId: input.externalSessionId,
        runtimeKind: input.runtimeKind,
        role: input.role,
        startedAt: this.now(),
        status: "running",
      };
      return summary;
    }
    return this.resumeSession({
      externalSessionId: input.externalSessionId,
      repoPath: input.repoPath,
      runtimeKind: input.runtimeKind,
      workingDirectory: input.workingDirectory,
      taskId: input.taskId || '',
      role: input.role ?? 'planner',
      systemPrompt: input.systemPrompt || '',
    });
  }

  async detachSession(externalSessionId: string): Promise<void> {
    // Detaching doesn't stop the session, just removes local tracking
    const session = this.sessions.get(externalSessionId);
    if (session) {
      session.eventListeners.clear();
    }
  }

  subscribeEvents(externalSessionId: string, listener: (event: AgentEvent) => void): EventUnsubscribe {
    const session = this.sessions.get(externalSessionId);
    if (!session) {
      return () => {};
    }

    session.eventListeners.add(listener);

    return () => {
      session.eventListeners.delete(listener);
    };
  }
}
