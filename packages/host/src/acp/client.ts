// ACP Client - spawns agents and communicates via stdin/stdout JSON-RPC.
//
// Inspired by t3code's effect-acp + AcpSessionRuntime: declares real
// clientCapabilities so agents will start sessions, answers the handful of
// agent->client requests (fs.read/write, permission) that would otherwise
// wedge the agent, and tracks authMethods so callers can drive a sign-in flow.
import type { ChildProcess } from "node:child_process";
import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import { dirname } from "node:path";
import type { AcpAgent } from "../acp-registry.js";
import { getAgentCommand } from "../acp-registry.js";
import { acpAgentManager } from "./agent-manager.js";
import { JsonRpcHandler } from "./json-rpc.js";
import {
  ACP_AUTH_REQUIRED_CODE,
  AcpAuthenticationError,
  type AcpAuthMethod,
  type AcpInitializeResult,
  type AcpModel,
  AcpRpcError,
  CLIENT_INFO_CONST,
  DEFAULT_CLIENT_CAPABILITIES,
  type JsonRpcId,
} from "./types.js";

export class AcpClient {
  private process: ChildProcess | null = null;
  private requestId = 1;
  private stdoutBuffer = "";
  private pendingRequests = new Map<
    JsonRpcId,
    {
      resolve: (value: unknown) => void;
      reject: (error: Error) => void;
    }
  >();
  private authMethods: AcpAuthMethod[] = [];
  private jsonRpcHandler: JsonRpcHandler;

  constructor(private agent: AcpAgent) {
    this.jsonRpcHandler = new JsonRpcHandler({
      "fs/read_text_file": async (params: unknown) => {
        if (typeof params !== "object" || params === null) {
          throw new AcpRpcError(-32602, "fs/read_text_file: invalid params");
        }
        const p = params as Record<string, unknown>;
        const path = typeof p.path === "string" ? p.path : null;
        if (!path) {
          throw new AcpRpcError(-32602, "fs/read_text_file: missing path");
        }
        const text = await fs.readFile(path, "utf-8");
        const line = typeof p.line === "number" ? p.line : undefined;
        const limit = typeof p.limit === "number" ? p.limit : undefined;
        if (line === undefined && limit === undefined) {
          return { content: text };
        }
        // 1-indexed line, ACP convention.
        const lines = text.split("\n");
        const start = Math.max(0, (line ?? 1) - 1);
        const end = limit !== undefined ? start + limit : undefined;
        return { content: lines.slice(start, end).join("\n") };
      },
      "fs/write_text_file": async (params: unknown) => {
        if (typeof params !== "object" || params === null) {
          throw new AcpRpcError(-32602, "fs/write_text_file: invalid params");
        }
        const p = params as Record<string, unknown>;
        const path = typeof p.path === "string" ? p.path : null;
        const content = typeof p.content === "string" ? p.content : null;
        if (!path || content === null) {
          throw new AcpRpcError(-32602, "fs/write_text_file: missing path or content");
        }
        await fs.mkdir(dirname(path), { recursive: true });
        await fs.writeFile(path, content, "utf-8");
        return {};
      },
      // Auto-cancel permission requests. Auto-allowing would silently grant
      // tool calls (file writes, shell commands) the user has not approved.
      // Until we wire a real UI prompt, refusing is the only safe default.
      "session/request_permission": async () => ({
        outcome: { outcome: "cancelled" },
      }),
    });
  }

  async start(): Promise<void> {
    const commandInfo = getAgentCommand(this.agent);
    if (!commandInfo) {
      throw new Error(`No suitable distribution found for agent ${this.agent.id}`);
    }

    console.log(`Starting ACP agent: ${commandInfo.command} ${commandInfo.args.join(" ")}`);

    this.process = spawn(commandInfo.command, commandInfo.args, {
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env },
    });

    if (!this.process.stdin || !this.process.stdout || !this.process.stderr) {
      throw new Error("Failed to spawn agent process");
    }

    this.process.stdout.on("data", (data) => {
      this.handleResponse(data.toString());
    });

    this.process.stderr.on("data", (data) => {
      console.error("Agent stderr:", data.toString());
    });

    this.process.on("error", (err) => {
      console.error("Agent process error:", err);
      this.process = null;
      this.rejectAllPending(err);
    });

    this.process.on("exit", (code, signal) => {
      console.log(`Agent process exited with code ${code}, signal ${signal}`);
      this.process = null;
      this.rejectAllPending(new Error(`Agent exited with code ${code}`));
    });

    // Wait for agent to start
    await new Promise((resolve) => setTimeout(resolve, 500));
  }

  private handleResponse(data: string): void {
    // Agents may stream stdout in arbitrary chunks (a JSON message can be split
    // across two chunks, or two messages may share a chunk). Buffer until we
    // see a newline, then drain whole lines. Lines that aren't JSON-RPC frames
    // (banners, progress text, etc.) are skipped silently.
    this.stdoutBuffer += data;
    let newlineIdx = this.stdoutBuffer.indexOf("\n");
    while (newlineIdx !== -1) {
      const line = this.stdoutBuffer.slice(0, newlineIdx).trim();
      this.stdoutBuffer = this.stdoutBuffer.slice(newlineIdx + 1);
      newlineIdx = this.stdoutBuffer.indexOf("\n");
      if (line?.charCodeAt(0) !== 0x7b /* '{' */) {
        continue;
      }
      let message: unknown;
      try {
        message = JSON.parse(line);
      } catch {
        continue;
      }
      this.dispatchMessage(message);
    }
  }

  // A JSON-RPC frame is one of: response (id present, no method), request
  // (id present, method present), notification (no id, method present).
  // We dispatch each shape to its own handler so an agent's incoming request
  // never sits unanswered (which is what currently makes agents hang).
  private dispatchMessage(message: unknown): void {
    this.jsonRpcHandler.dispatchMessage(
      message,
      (id, method, params) => this.handleIncomingRequest(id, method, params),
      (method, params) => this.handleIncomingNotification(method, params),
      this.pendingRequests,
    );
  }

  private rejectAllPending(error: Error): void {
    for (const [id, pending] of this.pendingRequests) {
      pending.reject(error);
      this.pendingRequests.delete(id);
    }
  }

  private async handleIncomingRequest(
    id: JsonRpcId,
    method: string,
    params: unknown,
  ): Promise<void> {
    await this.jsonRpcHandler.handleRequest(
      id,
      method,
      params,
      (id, result) => this.sendSuccessResponse(id, result),
      (id, code, message, data) => this.sendErrorResponse(id, code, message, data),
    );
  }

  private handleIncomingNotification(method: string, params: unknown): void {
    // The only notification we care about today is session/update — and only
    // for debug visibility, since `getModels` / `startAgentSession` are the
    // sole consumers right now. Anything else is logged and dropped.
    if (method === "session/update") {
      return;
    }
    console.log(`[ACP Client] Unhandled notification: ${method}`, params);
  }

  private sendSuccessResponse(id: JsonRpcId, result: unknown): void {
    this.writeFrame({ jsonrpc: "2.0", id, result });
  }

  private sendErrorResponse(id: JsonRpcId, code: number, message: string, data?: unknown): void {
    const error: Record<string, unknown> = { code, message };
    if (data !== undefined) {
      error.data = data;
    }
    this.writeFrame({ jsonrpc: "2.0", id, error });
  }

  private writeFrame(frame: unknown): void {
    if (!this.process?.stdin) {
      return;
    }
    this.process.stdin.write(`${JSON.stringify(frame)}\n`);
  }

  async sendRequest(method: string, params: Record<string, unknown> = {}): Promise<unknown> {
    if (!this.process?.stdin) {
      throw new Error("Agent not started");
    }

    const id = this.requestId++;

    console.log(`[ACP Client] Sending request: ${method}`, params);
    this.writeFrame({ jsonrpc: "2.0", id, method, params });

    return new Promise((resolve, reject) => {
      this.pendingRequests.set(id, { resolve, reject });
      const timeoutMs = 60000;
      setTimeout(() => {
        if (this.pendingRequests.has(id)) {
          this.pendingRequests.delete(id);
          console.error(`[ACP Client] Request timeout for ${method} after ${timeoutMs}ms`);
          reject(new Error("Request timeout"));
        }
      }, timeoutMs);
    });
  }

  // Translates a raw ACP `auth_required` RPC error into a typed
  // AcpAuthenticationError so callers can surface a clear "please sign in"
  // message and have the list of available authMethods. Other errors pass.
  private toClientError(error: unknown): unknown {
    if (error instanceof AcpRpcError && error.code === ACP_AUTH_REQUIRED_CODE) {
      return new AcpAuthenticationError(
        this.agent.id,
        `Authentication required for agent '${this.agent.id}'. Please sign in to this agent and try again.`,
        error,
        this.authMethods,
      );
    }
    return error;
  }

  async initialize(): Promise<AcpInitializeResult> {
    try {
      const result = await this.sendRequest("initialize", {
        protocolVersion: 1,
        clientCapabilities: DEFAULT_CLIENT_CAPABILITIES,
        clientInfo: CLIENT_INFO_CONST,
      });
      this.authMethods = normalizeAuthMethods(result?.authMethods);
      return {
        protocolVersion:
          typeof result?.protocolVersion === "number" ? result.protocolVersion : undefined,
        authMethods: [...this.authMethods],
        raw: result,
      };
    } catch (error) {
      // Never leave a half-initialized agent process running.
      await this.stop();
      throw this.toClientError(error);
    }
  }

  // Sends `authenticate` once the user picks an authMethod. Not currently
  // called from the host UI but kept here so wiring it up later is a one-liner.
  async authenticate(methodId: string): Promise<unknown> {
    try {
      return await this.sendRequest("authenticate", { methodId });
    } catch (error) {
      throw this.toClientError(error);
    }
  }

  getAuthMethods(): ReadonlyArray<AcpAuthMethod> {
    return this.authMethods;
  }

  async getModels(cwd: string): Promise<AcpModel[]> {
    const session = (await this.createSession(cwd, [])) as {
      models?: { availableModels?: Array<{ modelId: string; name: string; description?: string }> };
      configOptions?: Array<{ category?: string; type?: string; options?: unknown[] }>;
    };

    // Preferred: the experimental `models` state (SessionModelState).
    const availableModels = session.models?.availableModels;
    if (Array.isArray(availableModels) && availableModels.length > 0) {
      return availableModels.map(
        (model: { modelId: string; name: string; description?: string }) => ({
          modelId: model.modelId,
          name: model.name,
          description: model.description ?? undefined,
        }),
      );
    }

    // Fallback: a `configOptions` select carrying the `model` category. The
    // option `id` is agent-defined, so it must be matched on `category`, and
    // its `options` may be flat entries or grouped (SessionConfigSelectGroup).
    const modelConfig = session.configOptions?.find(
      (opt: { category?: string; type?: string }) =>
        opt.category === "model" && opt.type === "select",
    );
    if (modelConfig && Array.isArray(modelConfig.options)) {
      const flat = modelConfig.options.flatMap(
        (
          entry: { options?: unknown[] } | { value?: string; name?: string; description?: string },
        ) =>
          Array.isArray((entry as { options?: unknown[] }).options)
            ? (entry as { options?: unknown[] }).options
            : [entry],
      );
      return flat.map((opt: { value?: string; name?: string; description?: string }) => ({
        modelId: opt.value ?? "",
        name: opt.name ?? "",
        description: opt.description ?? undefined,
      }));
    }

    return [];
  }

  async createSession(cwd: string, mcpServers: unknown[] = []): Promise<unknown> {
    try {
      return await this.sendRequest("session/new", { cwd, mcpServers });
    } catch (error) {
      // Authentication failure or a wedged agent: stop the process here so it
      // can't outlive the failed request. The manager discards the client on
      // its next lookup once `isRunning()` reports false.
      await this.stop();
      throw this.toClientError(error);
    }
  }

  async stop(): Promise<void> {
    const proc = this.process;
    if (!proc) {
      this.pendingRequests.clear();
      return;
    }
    // SIGTERM first to let the agent flush + exit cleanly; SIGKILL only if it
    // is still alive after a short grace window.
    try {
      proc.kill("SIGTERM");
    } catch {
      // already exited
    }
    await waitForExitOrTimeout(proc, 500);
    if (proc.exitCode === null && proc.signalCode === null) {
      try {
        proc.kill("SIGKILL");
      } catch {
        // already exited
      }
    }
    this.process = null;
    this.pendingRequests.clear();
  }

  isRunning(): boolean {
    return this.process !== null;
  }
}

function waitForExitOrTimeout(proc: ChildProcess, timeoutMs: number): Promise<void> {
  return new Promise((resolve) => {
    if (proc.exitCode !== null || proc.signalCode !== null) {
      resolve();
      return;
    }
    const onExit = () => {
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(() => {
      proc.removeListener("exit", onExit);
      resolve();
    }, timeoutMs);
    proc.once("exit", onExit);
  });
}

function normalizeAuthMethods(raw: unknown): AcpAuthMethod[] {
  if (!Array.isArray(raw)) {
    return [];
  }
  return raw
    .map((entry: { id?: string; name?: string; description?: string }): AcpAuthMethod | null => {
      const id = typeof entry?.id === "string" ? entry.id : null;
      if (!id) {
        return null;
      }
      return {
        id,
        ...(typeof entry?.name === "string" ? { name: entry.name } : {}),
        ...(typeof entry?.description === "string" ? { description: entry.description } : {}),
      };
    })
    .filter((entry): entry is AcpAuthMethod => entry !== null);
}

export { type AcpAgent, fetchRegistry, findAgent } from "../acp-registry.js";

export async function getAgentModels(
  agentId: string,
  cwd: string = process.cwd(),
): Promise<AcpModel[]> {
  const { fetchRegistry, findAgent } = await import("../acp-registry.js");

  console.log("Fetching ACP registry...");
  const registry = await fetchRegistry();
  console.log("Registry fetched, finding agent:", agentId);

  const agent = findAgent(registry, agentId);

  if (!agent) {
    console.error("Agent not found in registry:", agentId);
    throw new Error(`Agent ${agentId} not found in registry`);
  }

  console.log("Agent found, getting cached client...");
  const client = await acpAgentManager.getOrCreateClient(agent);
  console.log("Client ready, getting models...");
  try {
    return await client.getModels(cwd);
  } catch (error) {
    // A client that failed here (auth required, broken process, timeout) must
    // not stay cached — stop it so the next call spawns a fresh agent instead
    // of reusing a wedged one.
    await acpAgentManager.stopAgent(agentId);
    throw error;
  }
}

export async function startAgentSession(
  agentId: string,
  workingDirectory: string,
  _taskId: string,
  role: string,
  _model?: string,
): Promise<{ externalSessionId: string; role: string; startedAt: string; status: string }> {
  const { fetchRegistry, findAgent } = await import("../acp-registry.js");

  const registry = await fetchRegistry();
  const agent = findAgent(registry, agentId);

  if (!agent) {
    throw new Error(`Agent ${agentId} not found in registry`);
  }

  const client = await acpAgentManager.getOrCreateClient(agent);
  let session: unknown;
  try {
    session = await client.createSession(workingDirectory, []);
  } catch (error) {
    // Stop the agent on failure so an unauthenticated or wedged process is
    // not left running and is not reused on the next attempt.
    await acpAgentManager.stopAgent(agentId);
    throw error;
  }

  const sessionObj = session as { sessionId: string };
  return {
    externalSessionId: sessionObj.sessionId,
    role,
    startedAt: new Date().toISOString(),
    status: "running",
  };
}
