import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  AcpAuthenticationError,
  AcpClient,
  acpAgentManager,
  getAgentModels,
  isAcpAuthenticationError,
} from "./acp/client.js";
import type { AcpAgent } from "./acp-registry.js";
import { getPlatformKey } from "./acp-registry.js";

// A fake ACP agent. Behaviour is selected per-test through the FAKE_ACP_MODE
// environment variable (the client inherits process.env when it spawns the
// agent), letting one script exercise every parsing/auth branch as well as
// the agent->client request handlers.
const FAKE_AGENT_SCRIPT = `#!/usr/bin/env node
const mode = process.env.FAKE_ACP_MODE || "models";
const echoPath = process.env.FAKE_ACP_ECHO_PATH;
let buffer = "";
let initParams = null;
let nextServerId = 1;
const pendingByMethod = new Map();

const send = (frame) => process.stdout.write(JSON.stringify(frame) + "\\n");
const reply = (id, result) =>
  send({ jsonrpc: "2.0", id, result });
const fail = (id, code, errMessage) =>
  send({ jsonrpc: "2.0", id, error: { code, message: errMessage } });

const callClient = (method, params) => {
  const id = "srv-" + nextServerId++;
  return new Promise((resolve, reject) => {
    pendingByMethod.set(id, { resolve, reject, method });
    send({ jsonrpc: "2.0", id, method, params });
  });
};

process.stdin.on("data", async (chunk) => {
  buffer += chunk.toString("utf-8");
  let newlineIndex = buffer.indexOf("\\n");
  while (newlineIndex !== -1) {
    const line = buffer.slice(0, newlineIndex).trim();
    buffer = buffer.slice(newlineIndex + 1);
    newlineIndex = buffer.indexOf("\\n");
    if (!line) continue;
    const message = JSON.parse(line);

    // Response to a server->client request we issued.
    if (message.method === undefined && pendingByMethod.has(message.id)) {
      const pending = pendingByMethod.get(message.id);
      pendingByMethod.delete(message.id);
      if (message.error) {
        pending.reject(message.error);
      } else {
        pending.resolve(message.result);
      }
      continue;
    }

    if (message.method === "initialize") {
      initParams = message.params;
      if (mode === "auth-on-initialize") {
        fail(message.id, -32000, "Authentication required");
      } else if (mode === "auth-methods-on-initialize") {
        reply(message.id, {
          protocolVersion: 1,
          authMethods: [
            { id: "oauth", name: "Sign in with OAuth", description: "browser flow" },
            { id: "api-key" },
          ],
        });
      } else {
        reply(message.id, { protocolVersion: 1 });
      }
      continue;
    }
    if (message.method === "session/new") {
      if (mode === "echo-initialize") {
        // Bounce the captured initialize params back as a synthetic
        // "configOptions" entry so the test can inspect what the client sent.
        reply(message.id, {
          sessionId: "session-1",
          configOptions: [{ id: "init-echo", initParams }],
        });
        continue;
      }
      if (mode === "agent-read-file") {
        // Ask the client to read a file, then echo the contents back as the
        // model description so the test can assert success.
        try {
          const res = await callClient("fs/read_text_file", { path: echoPath });
          reply(message.id, {
            sessionId: "session-1",
            models: {
              availableModels: [
                { modelId: "read-ok", name: "READ", description: res.content },
              ],
              currentModelId: "read-ok",
            },
          });
        } catch (err) {
          fail(message.id, -32000, "fs/read failed: " + JSON.stringify(err));
        }
        continue;
      }
      if (mode === "agent-request-permission") {
        // Ask the client to grant permission and report the outcome string
        // back as the only available model name so the test can assert it
        // received the auto-cancel.
        try {
          const res = await callClient("session/request_permission", {
            sessionId: "session-1",
            toolCall: { toolCallId: "tc-1" },
            options: [{ optionId: "allow", name: "Allow", kind: "allow_once" }],
          });
          reply(message.id, {
            sessionId: "session-1",
            models: {
              availableModels: [
                { modelId: "perm", name: "perm", description: JSON.stringify(res) },
              ],
              currentModelId: "perm",
            },
          });
        } catch (err) {
          fail(message.id, -32000, "permission failed: " + JSON.stringify(err));
        }
        continue;
      }
      if (mode === "agent-unknown-method") {
        // Confirm that an unknown method receives a JSON-RPC error rather
        // than hanging the agent. Surface the error code as the model name.
        try {
          await callClient("totally/made_up", {});
          reply(message.id, { sessionId: "session-1" });
        } catch (err) {
          reply(message.id, {
            sessionId: "session-1",
            models: {
              availableModels: [
                { modelId: "err", name: "code:" + err.code, description: err.message },
              ],
              currentModelId: "err",
            },
          });
        }
        continue;
      }
      if (mode === "auth") {
        fail(message.id, -32000, "Authentication required");
      } else if (mode === "models") {
        reply(message.id, {
          sessionId: "session-1",
          models: {
            availableModels: [
              { modelId: "model-a", name: "Model A", description: "first" },
              { modelId: "model-b", name: "Model B" },
            ],
            currentModelId: "model-a",
          },
        });
      } else if (mode === "configOptions") {
        reply(message.id, {
          sessionId: "session-1",
          configOptions: [
            {
              id: "agent-defined-id",
              category: "model",
              type: "select",
              options: [
                { value: "cfg-a", name: "Cfg A" },
                { value: "cfg-b", name: "Cfg B", description: "second" },
              ],
            },
          ],
        });
      } else if (mode === "configGroups") {
        reply(message.id, {
          sessionId: "session-1",
          configOptions: [
            {
              id: "agent-defined-id",
              category: "model",
              type: "select",
              options: [
                { group: "g1", name: "Group 1", options: [{ value: "grouped-a", name: "Grouped A" }] },
                { group: "g2", name: "Group 2", options: [{ value: "grouped-b", name: "Grouped B" }] },
              ],
            },
          ],
        });
      } else {
        reply(message.id, { sessionId: "session-1" });
      }
      continue;
    }
  }
});
`;

let tempDir: string;
let fakeAgentPath: string;
let agentCounter = 0;

const makeFakeAgent = (): AcpAgent => {
  agentCounter += 1;
  return {
    id: `fake-acp-agent-${agentCounter}`,
    name: "Fake ACP Agent",
    version: "0.0.0",
    distribution: {
      binary: {
        [getPlatformKey()]: { archive: "", cmd: fakeAgentPath },
      },
    },
  };
};

beforeAll(() => {
  tempDir = mkdtempSync(join(tmpdir(), "acp-client-test-"));
  fakeAgentPath = join(tempDir, "fake-acp-agent.js");
  writeFileSync(fakeAgentPath, FAKE_AGENT_SCRIPT);
  chmodSync(fakeAgentPath, 0o755);
});

afterAll(() => {
  rmSync(tempDir, { recursive: true, force: true });
});

afterEach(() => {
  delete process.env.FAKE_ACP_MODE;
  delete process.env.FAKE_ACP_ECHO_PATH;
});

const startClient = async (): Promise<AcpClient> => {
  const client = new AcpClient(makeFakeAgent());
  await client.start();
  await client.initialize();
  return client;
};

describe("AcpClient.getModels", () => {
  test("reads models from the experimental SessionModelState", async () => {
    process.env.FAKE_ACP_MODE = "models";
    const client = await startClient();
    const models = await client.getModels(process.cwd());
    await client.stop();

    expect(models).toEqual([
      { modelId: "model-a", name: "Model A", description: "first" },
      { modelId: "model-b", name: "Model B" },
    ]);
  }, 15000);

  test("falls back to a configOptions select matched by the model category", async () => {
    process.env.FAKE_ACP_MODE = "configOptions";
    const client = await startClient();
    const models = await client.getModels(process.cwd());
    await client.stop();

    expect(models).toEqual([
      { modelId: "cfg-a", name: "Cfg A" },
      { modelId: "cfg-b", name: "Cfg B", description: "second" },
    ]);
  }, 15000);

  test("flattens grouped configOptions select options", async () => {
    process.env.FAKE_ACP_MODE = "configGroups";
    const client = await startClient();
    const models = await client.getModels(process.cwd());
    await client.stop();

    expect(models).toEqual([
      { modelId: "grouped-a", name: "Grouped A" },
      { modelId: "grouped-b", name: "Grouped B" },
    ]);
  }, 15000);

  test("returns an empty list when the session exposes no model state", async () => {
    process.env.FAKE_ACP_MODE = "empty";
    const client = await startClient();
    const models = await client.getModels(process.cwd());
    await client.stop();

    expect(models).toEqual([]);
  }, 15000);
});

describe("AcpClient.initialize", () => {
  test("sends clientCapabilities + clientInfo so agents can rely on fs read/write", async () => {
    // The fake agent stores the initialize params and echoes them back on
    // session/new. We assert the wire shape rather than re-implementing it.
    process.env.FAKE_ACP_MODE = "echo-initialize";
    const client = await startClient();
    const session = await client.createSession(process.cwd(), []);
    await client.stop();

    const echoed = (session.configOptions as Array<{ initParams: unknown }>)[0]?.initParams;
    expect(echoed).toMatchObject({
      protocolVersion: 1,
      clientCapabilities: {
        fs: { readTextFile: true, writeTextFile: true },
        terminal: false,
      },
      clientInfo: { name: "openducktor" },
    });
  }, 15000);

  test("captures authMethods returned by initialize and exposes them", async () => {
    process.env.FAKE_ACP_MODE = "auth-methods-on-initialize";
    const client = new AcpClient(makeFakeAgent());
    await client.start();
    const result = await client.initialize();
    await client.stop();

    expect(result.authMethods).toEqual([
      { id: "oauth", name: "Sign in with OAuth", description: "browser flow" },
      { id: "api-key" },
    ]);
    // Methods without an `id` are filtered out (we sent a clean fixture, but
    // the getter copy is what callers actually consume).
    expect(client.getAuthMethods()).toEqual(result.authMethods);
  }, 15000);
});

describe("AcpClient agent->client requests", () => {
  test("answers fs/read_text_file so the agent receives file contents", async () => {
    process.env.FAKE_ACP_MODE = "agent-read-file";
    const target = join(tempDir, "fs-read-fixture.txt");
    writeFileSync(target, "hello from disk");
    process.env.FAKE_ACP_ECHO_PATH = target;

    const client = await startClient();
    const models = await client.getModels(process.cwd());
    await client.stop();

    // The agent echoes file contents back as the model description.
    expect(models[0]?.description).toBe("hello from disk");
  }, 15000);

  test("auto-cancels session/request_permission instead of silently allowing", async () => {
    process.env.FAKE_ACP_MODE = "agent-request-permission";
    const client = await startClient();
    const models = await client.getModels(process.cwd());
    await client.stop();

    // The agent echoes the permission response into the model description.
    const parsed = JSON.parse(models[0]?.description ?? "{}");
    expect(parsed).toEqual({ outcome: { outcome: "cancelled" } });
  }, 15000);

  test("responds with JSON-RPC -32601 for unknown agent->client methods", async () => {
    process.env.FAKE_ACP_MODE = "agent-unknown-method";
    const client = await startClient();
    const models = await client.getModels(process.cwd());
    await client.stop();

    expect(models[0]?.name).toBe("code:-32601");
    expect(models[0]?.description).toContain("totally/made_up");
  }, 15000);
});

describe("AcpClient authentication handling", () => {
  test("throws AcpAuthenticationError and stops the process when session/new requires auth", async () => {
    process.env.FAKE_ACP_MODE = "auth";
    const client = await startClient();

    let caught: unknown;
    try {
      await client.getModels(process.cwd());
    } catch (error) {
      caught = error;
    }

    expect(isAcpAuthenticationError(caught)).toBe(true);
    expect(caught).toBeInstanceOf(AcpAuthenticationError);
    expect((caught as AcpAuthenticationError).message).toContain("Authentication required");
    // The spawned process must not outlive the failed request.
    expect(client.isRunning()).toBe(false);
  }, 15000);

  test("getOrCreateClient kills the process when the initialize handshake requires auth", async () => {
    process.env.FAKE_ACP_MODE = "auth-on-initialize";
    const agent = makeFakeAgent();

    let caught: unknown;
    try {
      await acpAgentManager.getOrCreateClient(agent);
    } catch (error) {
      caught = error;
    }

    expect(isAcpAuthenticationError(caught)).toBe(true);
    // A failed handshake must not leave a cached client behind.
    await acpAgentManager.stopAgent(agent.id);
  }, 15000);
});

describe("AcpClient process lifecycle", () => {
  test("isRunning() reports false after the agent process exits", async () => {
    process.env.FAKE_ACP_MODE = "models";
    const client = await startClient();
    expect(client.isRunning()).toBe(true);

    await client.stop();
    expect(client.isRunning()).toBe(false);
  }, 15000);

  test("getOrCreateClient coalesces concurrent startup calls onto one process", async () => {
    process.env.FAKE_ACP_MODE = "models";
    const agent = makeFakeAgent();

    const [a, b, c] = await Promise.all([
      acpAgentManager.getOrCreateClient(agent),
      acpAgentManager.getOrCreateClient(agent),
      acpAgentManager.getOrCreateClient(agent),
    ]);

    // Same client instance for every concurrent caller (no double-spawn).
    expect(a).toBe(b);
    expect(b).toBe(c);

    await acpAgentManager.stopAgent(agent.id);
  }, 15000);
});

// Opt-in integration coverage against the real ACP registry + agents.
// Enable with ACP_INTEGRATION=1 (requires network access and the codex-acp /
// opencode agents installed locally).
const runIntegration = process.env.ACP_INTEGRATION === "1";

describe("getAgentModels integration", () => {
  afterEach(async () => {
    await acpAgentManager.stopAll();
  });

  for (const agentId of ["codex-acp", "opencode"]) {
    test.skipIf(!runIntegration)(
      `loads a non-empty model catalog for '${agentId}'`,
      async () => {
        const models = await getAgentModels(agentId, process.cwd());
        expect(Array.isArray(models)).toBe(true);
        expect(models.length).toBeGreaterThan(0);
        for (const model of models) {
          expect(typeof model.modelId).toBe("string");
          expect(model.modelId.length).toBeGreaterThan(0);
          expect(typeof model.name).toBe("string");
        }
      },
      120000,
    );
  }
});
