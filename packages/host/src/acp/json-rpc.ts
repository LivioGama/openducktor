import {
  AcpRpcError,
  type AgentRequestHandler,
  JSON_RPC_INTERNAL_ERROR,
  JSON_RPC_METHOD_NOT_FOUND,
  type JsonRpcId,
} from "./types.js";

export class JsonRpcHandler {
  private agentRequestHandlers: Record<string, AgentRequestHandler>;

  constructor(handlers: Record<string, AgentRequestHandler>) {
    this.agentRequestHandlers = handlers;
  }

  dispatchMessage(
    message: unknown,
    handleIncomingRequest: (id: JsonRpcId, method: string, params: unknown) => void,
    handleIncomingNotification: (method: string, params: unknown) => void,
    pendingRequests: Map<
      JsonRpcId,
      { resolve: (value: unknown) => void; reject: (error: Error) => void }
    >,
  ): void {
    if (typeof message !== "object" || message === null) {
      return;
    }
    const msg = message as Record<string, unknown>;
    const hasMethod = typeof msg.method === "string";
    const hasId = msg.id !== undefined && msg.id !== null;

    if (hasMethod && hasId) {
      handleIncomingRequest(msg.id, msg.method, msg.params);
      return;
    }

    if (hasMethod && !hasId) {
      handleIncomingNotification(msg.method, msg.params);
      return;
    }

    if (hasId && pendingRequests.has(msg.id)) {
      const pending = pendingRequests.get(msg.id);
      if (!pending) {
        return;
      }
      pendingRequests.delete(msg.id);
      if (msg.error) {
        pending.reject(
          new AcpRpcError(
            typeof msg.error.code === "number" ? msg.error.code : 0,
            typeof msg.error.message === "string" ? msg.error.message : "Unknown error",
            msg.error.data,
          ),
        );
      } else {
        pending.resolve(msg.result);
      }
    }
  }

  async handleRequest(
    id: JsonRpcId,
    method: string,
    params: unknown,
    sendSuccessResponse: (id: JsonRpcId, result: unknown) => void,
    sendErrorResponse: (id: JsonRpcId, code: number, message: string, data?: unknown) => void,
  ): Promise<void> {
    const handler = this.agentRequestHandlers[method];
    if (!handler) {
      sendErrorResponse(id, JSON_RPC_METHOD_NOT_FOUND, `Method not found: ${method}`);
      return;
    }
    try {
      const result = await handler(params);
      sendSuccessResponse(id, result);
    } catch (error) {
      if (error instanceof AcpRpcError) {
        sendErrorResponse(id, error.code, error.message, error.data);
        return;
      }
      const message = error instanceof Error ? error.message : String(error);
      sendErrorResponse(id, JSON_RPC_INTERNAL_ERROR, message);
    }
  }
}
