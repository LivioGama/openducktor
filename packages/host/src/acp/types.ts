// JSON-RPC error code the ACP spec reserves for "Authentication required".
export const ACP_AUTH_REQUIRED_CODE = -32000;
// JSON-RPC standard "Method not found" code (used when an agent calls a
// client method we have not implemented).
export const JSON_RPC_METHOD_NOT_FOUND = -32601;
// JSON-RPC standard "Internal error" code (used when our handler throws).
export const JSON_RPC_INTERNAL_ERROR = -32603;

const CLIENT_INFO = { name: "openducktor", version: "0.0.0" } as const;

// Capabilities we genuinely support. Many ACP agents short-circuit features
// (or refuse to create a session) when the client advertises none, so we
// always expose fs read/write — we run inside the host with disk access.
export const DEFAULT_CLIENT_CAPABILITIES = {
  fs: {
    readTextFile: true,
    writeTextFile: true,
  },
  terminal: false,
} as const;

export const CLIENT_INFO_CONST = CLIENT_INFO;

// A JSON-RPC error returned by an ACP agent, preserving the numeric `code` so
// callers can distinguish auth failures from generic protocol errors.
export class AcpRpcError extends Error {
  constructor(
    readonly code: number,
    message: string,
    readonly data?: unknown,
  ) {
    super(message);
    this.name = "AcpRpcError";
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
    this.name = "AcpAuthenticationError";
  }
}

export const isAcpAuthenticationError = (error: unknown): error is AcpAuthenticationError =>
  error instanceof AcpAuthenticationError;

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

type AgentRequestHandler = (params: unknown) => Promise<unknown> | unknown;

export type { AgentRequestHandler, JsonRpcId };
