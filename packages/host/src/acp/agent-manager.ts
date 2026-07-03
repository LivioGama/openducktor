import type { AcpAgent } from "../acp-registry.js";
import type { AcpClient } from "./client.js";

// ACP Agent Manager - singleton cache for running agents
class AcpAgentManager {
  private static instance: AcpAgentManager;
  private agentCache = new Map<string, AcpClient>();
  // Tracks in-flight startup promises so two parallel callers don't both
  // spawn the same agent. Resolved entries hand back the cached client.
  private startupInFlight = new Map<string, Promise<AcpClient>>();

  private constructor() {}

  static getInstance(): AcpAgentManager {
    if (!AcpAgentManager.instance) {
      AcpAgentManager.instance = new AcpAgentManager();
    }
    return AcpAgentManager.instance;
  }

  async getOrCreateClient(agent: AcpAgent): Promise<AcpClient> {
    const agentId = agent.id;

    // Return existing client if already running
    const existing = this.agentCache.get(agentId);
    if (existing) {
      if (existing.isRunning()) {
        return existing;
      }
      // Remove dead client
      this.agentCache.delete(agentId);
    }

    // Coalesce concurrent startup attempts: the first caller spawns the
    // agent, every parallel caller awaits the same promise.
    const inFlight = this.startupInFlight.get(agentId);
    if (inFlight) {
      return inFlight;
    }

    const startup = (async () => {
      const client = new AcpClient(agent);
      try {
        await client.start();
        await client.initialize();
      } catch (error) {
        await client.stop();
        throw error;
      }
      this.agentCache.set(agentId, client);
      return client;
    })();

    this.startupInFlight.set(agentId, startup);
    try {
      return await startup;
    } finally {
      this.startupInFlight.delete(agentId);
    }
  }

  async stopAgent(agentId: string): Promise<void> {
    const client = this.agentCache.get(agentId);
    if (client) {
      await client.stop();
      this.agentCache.delete(agentId);
    }
  }

  async stopAll(): Promise<void> {
    const promises = Array.from(this.agentCache.entries()).map(async ([agentId, client]) => {
      await client.stop();
      this.agentCache.delete(agentId);
    });
    await Promise.all(promises);
  }
}

export const acpAgentManager = AcpAgentManager.getInstance();
