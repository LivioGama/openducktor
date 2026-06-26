// ACP Client - spawns agents and communicates via stdin/stdout JSON-RPC.
//
// Inspired by t3code's effect-acp + AcpSessionRuntime: declares real
// clientCapabilities so agents will start sessions, answers the handful of
// agent->client requests (fs.read/write, permission) that would otherwise
// wedge the agent, and tracks authMethods so callers can drive a sign-in flow.
import { ChildProcess, spawn } from 'child_process';
import { promises as fs } from 'node:fs';
import { dirname } from 'node:path';
import { AcpAgent, getAgentCommand } from './acp-registry.js';

// JSON-RPC error code the ACP spec reserves for "Authentication required".
const ACP_AUTH_REQUIRED_CODE = -32000;
// JSON-RPC standard "Method not found" code (used when an agent calls a
// client method we have not implemented).
const JSON_RPC_METHOD_NOT_FOUND = -32601;
// JSON-RPC standard "Internal error" code (used when our handler throws).
const JSON_RPC_INTERNAL_ERROR = -32603;

const CLIENT_INFO = { name: 'openducktor', version: '0.0.0' } as const;

// Capabilities we genuinely support. Many ACP agents short-circuit features
// (or refuse to create a session) when the client advertises none, so we
// always expose fs read/write — we run inside the host with disk access.
const DEFAULT_CLIENT_CAPABILITIES = {
  fs: {
    readTextFile: true,
    writeTextFile: true,
  },
  terminal: false,
} as const;

// A JSON-RPC error returned by an ACP agent, preserving the numeric `code` so
// callers can distinguish auth failures from generic protocol errors.
export class AcpRpcError extends Error {
  constructor(
    readonly code: number,
    message: string,
    readonly data?: unknown,
  ) {
    super(message);
    this.name = 'AcpRpcError';
  }
}

// Raised when an ACP agent reports that the user must authenticate before it
// can be used. The spawned process is always stopped before this is thrown.
export class AcpAuthenticationError extends Error {
  constructor(
    readonly agentId: string,
    message: string,
    readonly cause?: unknown,
    readonly authMethods: ReadonlyArray<AcpAuthMethod> = [],
  ) {
    super(message);
    this.name = 'AcpAuthenticationError';
  }
}

export const isAcpAuthenticationError = (
  error: unknown,
): error is AcpAuthenticationError => error instanceof AcpAuthenticationError;

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
    const promises = Array.from(this.agentCache.entries()).map(
      async ([agentId, client]) => {
        await client.stop();
        this.agentCache.delete(agentId);
      },
    );
    await Promise.all(promises);
  }
}

export const acpAgentManager = AcpAgentManager.getInstance();

export interface AcpModel {
  modelId: string;
  name: string;
  description?: string;
}

export interface AcpAuthMethod {
  id: string;
  name?: string;
  description?: string;
}

export interface AcpInitializeResult {
  protocolVersion?: number;
  authMethods: AcpAuthMethod[];
  raw: unknown;
}

export interface AcpSessionResponse {
  sessionId: string;
  models?: {
    availableModels: AcpModel[];
    currentModelId: string;
  };
  configOptions?: unknown[];
}

type JsonRpcId = number | string;

type AgentRequestHandler = (
  params: any,
) => Promise<unknown> | unknown;

export class AcpClient {
  private process: ChildProcess | null = null;
  private requestId = 1;
  private stdoutBuffer = '';
  private pendingRequests = new Map<JsonRpcId, {
    resolve: (value: any) => void;
    reject: (error: Error) => void;
  }>();
  private authMethods: AcpAuthMethod[] = [];

  constructor(private agent: AcpAgent) {}

  async start(): Promise<void> {
    const commandInfo = getAgentCommand(this.agent);
    if (!commandInfo) {
      throw new Error(`No suitable distribution found for agent ${this.agent.id}`);
    }

    console.log(`Starting ACP agent: ${commandInfo.command} ${commandInfo.args.join(' ')}`);

    this.process = spawn(commandInfo.command, commandInfo.args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env },
    });

    if (!this.process.stdin || !this.process.stdout || !this.process.stderr) {
      throw new Error('Failed to spawn agent process');
    }

    this.process.stdout.on('data', (data) => {
      this.handleResponse(data.toString());
    });

    this.process.stderr.on('data', (data) => {
      console.error('Agent stderr:', data.toString());
    });

    this.process.on('error', (err) => {
      console.error('Agent process error:', err);
      this.process = null;
      this.rejectAllPending(err);
    });

    this.process.on('exit', (code, signal) => {
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
    let newlineIdx = this.stdoutBuffer.indexOf('\n');
    while (newlineIdx !== -1) {
      const line = this.stdoutBuffer.slice(0, newlineIdx).trim();
      this.stdoutBuffer = this.stdoutBuffer.slice(newlineIdx + 1);
      newlineIdx = this.stdoutBuffer.indexOf('\n');
      if (!line || line.charCodeAt(0) !== 0x7b /* '{' */) {
        continue;
      }
      let message: any;
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
  private dispatchMessage(message: any): void {
    const hasMethod = typeof message.method === 'string';
    const hasId = message.id !== undefined && message.id !== null;

    if (hasMethod && hasId) {
      this.handleIncomingRequest(message.id, message.method, message.params);
      return;
    }

    if (hasMethod && !hasId) {
      this.handleIncomingNotification(message.method, message.params);
      return;
    }

    if (hasId && this.pendingRequests.has(message.id)) {
      const pending = this.pendingRequests.get(message.id)!;
      this.pendingRequests.delete(message.id);
      if (message.error) {
        pending.reject(
          new AcpRpcError(
            typeof message.error.code === 'number' ? message.error.code : 0,
            message.error.message || 'Unknown error',
            message.error.data,
          ),
        );
      } else {
        pending.resolve(message.result);
      }
    }
  }

  private rejectAllPending(error: Error): void {
    for (const [id, pending] of this.pendingRequests) {
      pending.reject(error);
      this.pendingRequests.delete(id);
    }
  }

  // Server -> client requests. The ACP spec lets the agent call back into the
  // client for filesystem work and permission prompts; if we don't answer,
  // the agent stalls waiting on the JSON-RPC promise. Each handler returns a
  // value (success) or throws (failure -> JSON-RPC error response).
  private agentRequestHandlers: Record<string, AgentRequestHandler> = {
    'fs/read_text_file': async (params) => {
      const path = typeof params?.path === 'string' ? params.path : null;
      if (!path) {
        throw new AcpRpcError(-32602, 'fs/read_text_file: missing path');
      }
      const text = await fs.readFile(path, 'utf-8');
      const line = typeof params?.line === 'number' ? params.line : undefined;
      const limit = typeof params?.limit === 'number' ? params.limit : undefined;
      if (line === undefined && limit === undefined) {
        return { content: text };
      }
      // 1-indexed line, ACP convention.
      const lines = text.split('\n');
      const start = Math.max(0, (line ?? 1) - 1);
      const end = limit !== undefined ? start + limit : undefined;
      return { content: lines.slice(start, end).join('\n') };
    },
    'fs/write_text_file': async (params) => {
      const path = typeof params?.path === 'string' ? params.path : null;
      const content = typeof params?.content === 'string' ? params.content : null;
      if (!path || content === null) {
        throw new AcpRpcError(-32602, 'fs/write_text_file: missing path or content');
      }
      await fs.mkdir(dirname(path), { recursive: true });
      await fs.writeFile(path, content, 'utf-8');
      return {};
    },
    // Auto-cancel permission requests. Auto-allowing would silently grant
    // tool calls (file writes, shell commands) the user has not approved.
    // Until we wire a real UI prompt, refusing is the only safe default.
    'session/request_permission': async () => ({
      outcome: { outcome: 'cancelled' },
    }),
  };

  private async handleIncomingRequest(
    id: JsonRpcId,
    method: string,
    params: unknown,
  ): Promise<void> {
    const handler = this.agentRequestHandlers[method];
    if (!handler) {
      this.sendErrorResponse(id, JSON_RPC_METHOD_NOT_FOUND, `Method not found: ${method}`);
      return;
    }
    try {
      const result = await handler(params);
      this.sendSuccessResponse(id, result);
    } catch (error) {
      if (error instanceof AcpRpcError) {
        this.sendErrorResponse(id, error.code, error.message, error.data);
        return;
      }
      const message = error instanceof Error ? error.message : String(error);
      this.sendErrorResponse(id, JSON_RPC_INTERNAL_ERROR, message);
    }
  }

  private handleIncomingNotification(method: string, params: unknown): void {
    // The only notification we care about today is session/update — and only
    // for debug visibility, since `getModels` / `startAgentSession` are the
    // sole consumers right now. Anything else is logged and dropped.
    if (method === 'session/update') {
      return;
    }
    console.log(`[ACP Client] Unhandled notification: ${method}`, params);
  }

  private sendSuccessResponse(id: JsonRpcId, result: unknown): void {
    this.writeFrame({ jsonrpc: '2.0', id, result });
  }

  private sendErrorResponse(
    id: JsonRpcId,
    code: number,
    message: string,
    data?: unknown,
  ): void {
    const error: Record<string, unknown> = { code, message };
    if (data !== undefined) {
      error.data = data;
    }
    this.writeFrame({ jsonrpc: '2.0', id, error });
  }

  private writeFrame(frame: unknown): void {
    if (!this.process?.stdin) {
      return;
    }
    this.process.stdin.write(`${JSON.stringify(frame)}\n`);
  }

  async sendRequest(method: string, params: any = {}): Promise<any> {
    if (!this.process || !this.process.stdin) {
      throw new Error('Agent not started');
    }

    const id = this.requestId++;

    console.log(`[ACP Client] Sending request: ${method}`, params);
    this.writeFrame({ jsonrpc: '2.0', id, method, params });

    return new Promise((resolve, reject) => {
      this.pendingRequests.set(id, { resolve, reject });
      const timeoutMs = 60000;
      setTimeout(() => {
        if (this.pendingRequests.has(id)) {
          this.pendingRequests.delete(id);
          console.error(`[ACP Client] Request timeout for ${method} after ${timeoutMs}ms`);
          reject(new Error('Request timeout'));
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
      const result = await this.sendRequest('initialize', {
        protocolVersion: 1,
        clientCapabilities: DEFAULT_CLIENT_CAPABILITIES,
        clientInfo: CLIENT_INFO,
      });
      this.authMethods = normalizeAuthMethods(result?.authMethods);
      return {
        protocolVersion: typeof result?.protocolVersion === 'number'
          ? result.protocolVersion
          : undefined,
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
      return await this.sendRequest('authenticate', { methodId });
    } catch (error) {
      throw this.toClientError(error);
    }
  }

  getAuthMethods(): ReadonlyArray<AcpAuthMethod> {
    return this.authMethods;
  }

  async getModels(cwd: string): Promise<AcpModel[]> {
    const session = await this.createSession(cwd, []);

    // Preferred: the experimental `models` state (SessionModelState).
    const availableModels = session.models?.availableModels;
    if (Array.isArray(availableModels) && availableModels.length > 0) {
      return availableModels.map((model: any) => ({
        modelId: model.modelId,
        name: model.name,
        description: model.description ?? undefined,
      }));
    }

    // Fallback: a `configOptions` select carrying the `model` category. The
    // option `id` is agent-defined, so it must be matched on `category`, and
    // its `options` may be flat entries or grouped (SessionConfigSelectGroup).
    const modelConfig = session.configOptions?.find(
      (opt: any) => opt.category === 'model' && opt.type === 'select',
    );
    if (modelConfig && Array.isArray(modelConfig.options)) {
      const flat = modelConfig.options.flatMap((entry: any) =>
        Array.isArray(entry?.options) ? entry.options : [entry],
      );
      return flat.map((opt: any) => ({
        modelId: opt.value,
        name: opt.name,
        description: opt.description ?? undefined,
      }));
    }

    return [];
  }

  async createSession(cwd: string, mcpServers: any[] = []): Promise<any> {
    try {
      return await this.sendRequest('session/new', { cwd, mcpServers });
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
      proc.kill('SIGTERM');
    } catch {
      // already exited
    }
    await waitForExitOrTimeout(proc, 500);
    if (proc.exitCode === null && proc.signalCode === null) {
      try {
        proc.kill('SIGKILL');
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
      proc.removeListener('exit', onExit);
      resolve();
    }, timeoutMs);
    proc.once('exit', onExit);
  });
}

function normalizeAuthMethods(raw: unknown): AcpAuthMethod[] {
  if (!Array.isArray(raw)) {
    return [];
  }
  return raw
    .map((entry: any): AcpAuthMethod | null => {
      const id = typeof entry?.id === 'string' ? entry.id : null;
      if (!id) {
        return null;
      }
      return {
        id,
        ...(typeof entry?.name === 'string' ? { name: entry.name } : {}),
        ...(typeof entry?.description === 'string' ? { description: entry.description } : {}),
      };
    })
    .filter((entry): entry is AcpAuthMethod => entry !== null);
}

export { fetchRegistry, findAgent, type AcpAgent } from './acp-registry.js';

export async function getAgentModels(agentId: string, cwd: string = process.cwd()): Promise<AcpModel[]> {
  const { fetchRegistry, findAgent } = await import('./acp-registry.js');

  console.log('Fetching ACP registry...');
  const registry = await fetchRegistry();
  console.log('Registry fetched, finding agent:', agentId);

  const agent = findAgent(registry, agentId);

  if (!agent) {
    console.error('Agent not found in registry:', agentId);
    throw new Error(`Agent ${agentId} not found in registry`);
  }

  console.log('Agent found, getting cached client...');
  const client = await acpAgentManager.getOrCreateClient(agent);
  console.log('Client ready, getting models...');
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
  taskId: string,
  role: string,
  model?: string,
): Promise<{ externalSessionId: string; role: string; startedAt: string; status: string }> {
  const { fetchRegistry, findAgent } = await import('./acp-registry.js');

  const registry = await fetchRegistry();
  const agent = findAgent(registry, agentId);

  if (!agent) {
    throw new Error(`Agent ${agentId} not found in registry`);
  }

  const client = await acpAgentManager.getOrCreateClient(agent);
  let session: any;
  try {
    session = await client.createSession(workingDirectory, []);
  } catch (error) {
    // Stop the agent on failure so an unauthenticated or wedged process is
    // not left running and is not reused on the next attempt.
    await acpAgentManager.stopAgent(agentId);
    throw error;
  }

  return {
    externalSessionId: session.sessionId,
    role,
    startedAt: new Date().toISOString(),
    status: 'running',
  };
}
