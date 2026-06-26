import { getAgentModels, startAgentSession, acpAgentManager, fetchRegistry, findAgent, type AcpModel, type AcpAuthMethod } from '../acp-client.js';

export type AcpGetModelsInput = {
  agentId: string;
  cwd?: string;
};

export type AcpGetModelsOutput = {
  models: AcpModel[];
};

export type AcpAuthenticateInput = {
  agentId: string;
  methodId: string;
};

export type AcpAuthenticateOutput = {
  success: boolean;
  authMethods?: AcpAuthMethod[];
};

export type AcpStopAgentInput = {
  agentId: string;
};

export type AcpStopAgentOutput = {
  success: boolean;
};

export type AcpListAgentsInput = {
  
};

export type AcpListAgentsOutput = {
  agents: Array<{
    id: string;
    name: string;
    version: string;
    description?: string;
  }>;
};

export function createAcpCommandHandlers() {
  return {
    acp_get_models: async (args: Record<string, unknown> | undefined) => {
      console.log('[acp_get_models] Called with args:', args);
      if (!args) throw new Error('Input is required');
      const input = args as AcpGetModelsInput;
      
      try {
        const models = await getAgentModels(input.agentId, input.cwd);
        console.log('[acp_get_models] Returning models for agentId:', input.agentId, models);
        return { models };
      } catch (error) {
        console.error('[acp_get_models] Error:', error);
        throw error;
      }
    },
    acp_start_session: async (args: Record<string, unknown> | undefined) => {
      console.log('[acp_start_session] Called with args:', args);
      if (!args) throw new Error('Input is required');
      const input = args as {
        agentId: string;
        workingDirectory: string;
        taskId: string;
        role: string;
        model?: string;
      };
      
      try {
        const response = await startAgentSession(
          input.agentId,
          input.workingDirectory,
          input.taskId,
          input.role,
          input.model
        );
        console.log('[acp_start_session] Returning response:', response);
        return response;
      } catch (error) {
        console.error('[acp_start_session] Error:', error);
        throw error;
      }
    },
    acp_authenticate: async (args: Record<string, unknown> | undefined) => {
      console.log('[acp_authenticate] Called with args:', args);
      if (!args) throw new Error('Input is required');
      const input = args as AcpAuthenticateInput;
      
      try {
        const registry = await fetchRegistry();
        const agent = findAgent(registry, input.agentId);
        
        if (!agent) {
          throw new Error(`Agent ${input.agentId} not found in registry`);
        }
        
        const client = await acpAgentManager.getOrCreateClient(agent);
        await client.authenticate(input.methodId);
        
        // Re-initialize to get updated auth methods
        await client.initialize();
        const authMethods = client.getAuthMethods();
        
        return { success: true, authMethods };
      } catch (error) {
        console.error('[acp_authenticate] Error:', error);
        throw error;
      }
    },
    acp_stop_agent: async (args: Record<string, unknown> | undefined) => {
      console.log('[acp_stop_agent] Called with args:', args);
      if (!args) throw new Error('Input is required');
      const input = args as AcpStopAgentInput;
      
      try {
        await acpAgentManager.stopAgent(input.agentId);
        return { success: true };
      } catch (error) {
        console.error('[acp_stop_agent] Error:', error);
        throw error;
      }
    },
    acp_list_agents: async (args: Record<string, unknown> | undefined) => {
      console.log('[acp_list_agents] Called');
      
      try {
        const registry = await fetchRegistry();
        const agents = registry.agents.map((agent: any) => ({
          id: agent.id,
          name: agent.name,
          version: agent.version,
          description: agent.description,
        }));
        
        return { agents };
      } catch (error) {
        console.error('[acp_list_agents] Error:', error);
        throw error;
      }
    },
  };
}
