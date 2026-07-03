import { Effect } from "effect";
import {
  type AcpAuthMethod,
  type AcpModel,
  acpAgentManager as defaultAcpAgentManager,
  fetchRegistry as defaultFetchRegistry,
  findAgent as defaultFindAgent,
  getAgentModels as defaultGetAgentModels,
  startAgentSession as defaultStartAgentSession,
} from "../../acp/client.js";
import type { AcpAgent, AcpRegistry } from "../../acp-registry.js";
import { toHostOperationError } from "../../effect/host-errors";
import {
  optionalString,
  requireRecord,
  requireString,
} from "../../interface/commands/command-inputs";
import type { HostCommandHandlers } from "../../interface/router/host-command-router";

export type AcpCommandHandlerDeps = {
  getAgentModels: (agentId: string, cwd?: string) => Promise<AcpModel[]>;
  startAgentSession: (
    agentId: string,
    workingDirectory: string,
    taskId: string,
    role: string,
    model?: string,
  ) => Promise<AcpStartSessionOutput>;
  fetchRegistry: () => Promise<AcpRegistry>;
  findAgent: (registry: AcpRegistry, agentId: string) => AcpAgent | undefined;
  acpAgentManager: {
    getOrCreateClient: (agent: AcpAgent) => Promise<{
      authenticate: (methodId: string) => Promise<unknown>;
      initialize: () => Promise<unknown>;
      getAuthMethods: () => ReadonlyArray<AcpAuthMethod>;
    }>;
    stopAgent: (agentId: string) => Promise<void>;
  };
};

const defaultDeps: AcpCommandHandlerDeps = {
  getAgentModels: defaultGetAgentModels,
  startAgentSession: defaultStartAgentSession,
  fetchRegistry: defaultFetchRegistry,
  findAgent: defaultFindAgent,
  acpAgentManager: defaultAcpAgentManager,
};

export type AcpGetModelsInput = {
  agentId: string;
  cwd?: string;
};

export type AcpGetModelsOutput = {
  models: AcpModel[];
};

export type AcpStartSessionInput = {
  agentId: string;
  workingDirectory: string;
  taskId: string;
  role: string;
  model?: string;
};

export type AcpStartSessionOutput = {
  externalSessionId: string;
  role: string;
  startedAt: string;
  status: string;
};

export type AcpAuthenticateInput = {
  agentId: string;
  methodId: string;
};

export type AcpAuthenticateOutput = {
  success: boolean;
  authMethods: AcpAuthMethod[];
};

export type AcpStopAgentInput = {
  agentId: string;
};

export type AcpStopAgentOutput = {
  success: boolean;
};

export type AcpListAgentsOutput = {
  agents: Array<{
    id: string;
    name: string;
    version: string;
    description?: string;
  }>;
};

const parseGetModelsInput = (args: Record<string, unknown> | undefined): AcpGetModelsInput => {
  const record = requireRecord(args, "acp_get_models input");
  const cwd = optionalString(record.cwd, "cwd");
  return {
    agentId: requireString(record.agentId, "agentId"),
    ...(cwd !== undefined ? { cwd } : {}),
  };
};

const parseStartSessionInput = (
  args: Record<string, unknown> | undefined,
): AcpStartSessionInput => {
  const record = requireRecord(args, "acp_start_session input");
  const model = optionalString(record.model, "model");
  return {
    agentId: requireString(record.agentId, "agentId"),
    workingDirectory: requireString(record.workingDirectory, "workingDirectory"),
    taskId: requireString(record.taskId, "taskId"),
    role: requireString(record.role, "role"),
    ...(model !== undefined ? { model } : {}),
  };
};

const parseAuthenticateInput = (
  args: Record<string, unknown> | undefined,
): AcpAuthenticateInput => {
  const record = requireRecord(args, "acp_authenticate input");
  return {
    agentId: requireString(record.agentId, "agentId"),
    methodId: requireString(record.methodId, "methodId"),
  };
};

const parseStopAgentInput = (args: Record<string, unknown> | undefined): AcpStopAgentInput => {
  const record = requireRecord(args, "acp_stop_agent input");
  return { agentId: requireString(record.agentId, "agentId") };
};

export const createAcpCommandHandlers = (
  deps: AcpCommandHandlerDeps = defaultDeps,
): HostCommandHandlers => ({
  acp_get_models: (args) =>
    Effect.gen(function* () {
      const input = parseGetModelsInput(args);
      const models = yield* Effect.tryPromise({
        try: () => deps.getAgentModels(input.agentId, input.cwd),
        catch: (cause) => toHostOperationError(cause, "acp.get_models", { agentId: input.agentId }),
      });
      const output: AcpGetModelsOutput = { models };
      return output;
    }),

  acp_start_session: (args) =>
    Effect.gen(function* () {
      const input = parseStartSessionInput(args);
      const session = yield* Effect.tryPromise({
        try: () =>
          deps.startAgentSession(
            input.agentId,
            input.workingDirectory,
            input.taskId,
            input.role,
            input.model,
          ),
        catch: (cause) =>
          toHostOperationError(cause, "acp.start_session", { agentId: input.agentId }),
      });
      return session;
    }),

  acp_authenticate: (args) =>
    Effect.gen(function* () {
      const input = parseAuthenticateInput(args);
      const authMethods = yield* Effect.tryPromise({
        try: async () => {
          const registry = await deps.fetchRegistry();
          const agent = deps.findAgent(registry, input.agentId);
          if (!agent) {
            throw new Error(`Agent ${input.agentId} not found in registry`);
          }
          const client = await deps.acpAgentManager.getOrCreateClient(agent);
          await client.authenticate(input.methodId);
          // Re-initialize to get updated auth methods.
          await client.initialize();
          return client.getAuthMethods();
        },
        catch: (cause) =>
          toHostOperationError(cause, "acp.authenticate", { agentId: input.agentId }),
      });
      const output: AcpAuthenticateOutput = { success: true, authMethods: [...authMethods] };
      return output;
    }),

  acp_stop_agent: (args) =>
    Effect.gen(function* () {
      const input = parseStopAgentInput(args);
      yield* Effect.tryPromise({
        try: () => deps.acpAgentManager.stopAgent(input.agentId),
        catch: (cause) => toHostOperationError(cause, "acp.stop_agent", { agentId: input.agentId }),
      });
      const output: AcpStopAgentOutput = { success: true };
      return output;
    }),

  acp_list_agents: () =>
    Effect.gen(function* () {
      const registry = yield* Effect.tryPromise({
        try: () => deps.fetchRegistry(),
        catch: (cause) => toHostOperationError(cause, "acp.list_agents"),
      });
      const output: AcpListAgentsOutput = {
        agents: registry.agents.map((agent) => ({
          id: agent.id,
          name: agent.name,
          version: agent.version,
          ...(agent.description !== undefined ? { description: agent.description } : {}),
        })),
      };
      return output;
    }),
});
