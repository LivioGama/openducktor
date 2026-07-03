import type { AcpAgent, AcpRegistry } from "../acp-registry.js";
import {
  type CreateHostCommandRouterInput,
  createEffectHostCommandRouter,
  toPromiseHostCommandRouter,
} from "../interface/router/host-command-router";
import { type AcpCommandHandlerDeps, createAcpCommandHandlers } from "./command-handlers";

const createHostCommandRouter = (input: CreateHostCommandRouterInput) =>
  toPromiseHostCommandRouter(createEffectHostCommandRouter(input));

const fakeAgent: AcpAgent = {
  id: "fake-agent",
  name: "Fake Agent",
  version: "1.0.0",
  distribution: {},
};

const fakeRegistry: AcpRegistry = {
  version: "1",
  agents: [
    fakeAgent,
    {
      id: "other-agent",
      name: "Other Agent",
      version: "2.0.0",
      description: "another agent",
      distribution: {},
    },
  ],
  extensions: [],
};

const createDeps = (overrides: Partial<AcpCommandHandlerDeps> = {}): AcpCommandHandlerDeps => ({
  getAgentModels: async () => [{ modelId: "model-a", name: "Model A" }],
  startAgentSession: async (_agentId, _workingDirectory, _taskId, role) => ({
    externalSessionId: "session-1",
    role,
    startedAt: "2026-01-01T00:00:00.000Z",
    status: "running",
  }),
  fetchRegistry: async () => fakeRegistry,
  findAgent: (registry, agentId) => registry.agents.find((agent) => agent.id === agentId),
  acpAgentManager: {
    getOrCreateClient: async () => ({
      authenticate: async () => ({}),
      initialize: async () => ({}),
      getAuthMethods: () => [{ id: "oauth", name: "Sign in" }],
    }),
    stopAgent: async () => {},
  },
  ...overrides,
});

describe("createAcpCommandHandlers", () => {
  test("acp_get_models returns the model catalog from the injected client", async () => {
    const calls: Array<{ agentId: string; cwd?: string }> = [];
    const deps = createDeps({
      getAgentModels: async (agentId, cwd) => {
        calls.push(cwd !== undefined ? { agentId, cwd } : { agentId });
        return [{ modelId: "model-a", name: "Model A", description: "first" }];
      },
    });
    const router = createHostCommandRouter({ handlers: createAcpCommandHandlers(deps) });

    await expect(
      router.invoke("acp_get_models", { agentId: "fake-agent", cwd: "/repo" }),
    ).resolves.toEqual({
      models: [{ modelId: "model-a", name: "Model A", description: "first" }],
    });
    expect(calls).toEqual([{ agentId: "fake-agent", cwd: "/repo" }]);
  });

  test("acp_get_models fails with a HostOperationError when the client rejects", async () => {
    const deps = createDeps({
      getAgentModels: async () => {
        throw new Error("agent not found in registry");
      },
    });
    const router = createHostCommandRouter({ handlers: createAcpCommandHandlers(deps) });

    await expect(router.invoke("acp_get_models", { agentId: "missing" })).rejects.toThrow(
      "agent not found in registry",
    );
  });

  test("acp_start_session starts a session through the injected client", async () => {
    const deps = createDeps();
    const router = createHostCommandRouter({ handlers: createAcpCommandHandlers(deps) });

    await expect(
      router.invoke("acp_start_session", {
        agentId: "fake-agent",
        workingDirectory: "/repo",
        taskId: "task-1",
        role: "planner",
      }),
    ).resolves.toEqual({
      externalSessionId: "session-1",
      role: "planner",
      startedAt: "2026-01-01T00:00:00.000Z",
      status: "running",
    });
  });

  test("acp_authenticate re-initializes the client and returns auth methods", async () => {
    const deps = createDeps();
    const router = createHostCommandRouter({ handlers: createAcpCommandHandlers(deps) });

    await expect(
      router.invoke("acp_authenticate", { agentId: "fake-agent", methodId: "oauth" }),
    ).resolves.toEqual({
      success: true,
      authMethods: [{ id: "oauth", name: "Sign in" }],
    });
  });

  test("acp_stop_agent stops the agent through the manager", async () => {
    const stopped: string[] = [];
    const deps = createDeps({
      acpAgentManager: {
        getOrCreateClient: async () => {
          throw new Error("not used");
        },
        stopAgent: async (agentId) => {
          stopped.push(agentId);
        },
      },
    });
    const router = createHostCommandRouter({ handlers: createAcpCommandHandlers(deps) });

    await expect(router.invoke("acp_stop_agent", { agentId: "fake-agent" })).resolves.toEqual({
      success: true,
    });
    expect(stopped).toEqual(["fake-agent"]);
  });

  test("acp_list_agents lists agents from the registry", async () => {
    const deps = createDeps();
    const router = createHostCommandRouter({ handlers: createAcpCommandHandlers(deps) });

    await expect(router.invoke("acp_list_agents", {})).resolves.toEqual({
      agents: [
        { id: "fake-agent", name: "Fake Agent", version: "1.0.0" },
        { id: "other-agent", name: "Other Agent", version: "2.0.0", description: "another agent" },
      ],
    });
  });

  test("acp_get_models rejects missing agentId as a validation error", async () => {
    const deps = createDeps();
    const router = createHostCommandRouter({ handlers: createAcpCommandHandlers(deps) });

    await expect(router.invoke("acp_get_models", {})).rejects.toThrow("agentId is required.");
  });
});
