import { knownRuntimeKindValues, type RuntimeKind } from "@openducktor/contracts";
import type { AgentModelDescriptor } from "@openducktor/core";

const MODEL_CACHE_KEY_PREFIX = "openducktor:provider-models:";
const PREFERRED_RUNTIME_KIND_KEY = "openducktor:preferred-runtime-kind";

type ElectronApi = {
  invoke: (command: string, args: Record<string, unknown>) => Promise<unknown>;
};

type ProviderModelConfig = {
  agentId: string;
  providerId: RuntimeKind;
  providerName: string;
};

const memoryCache = new Map<RuntimeKind, AgentModelDescriptor[]>();

const getSessionStorage = (): Storage | null => {
  if (typeof window === "undefined") {
    return null;
  }
  return window.sessionStorage ?? null;
};

const readElectronApi = (): ElectronApi | null => {
  if (typeof window === "undefined") {
    return null;
  }
  const api = (window as Window & { openducktorElectron?: ElectronApi }).openducktorElectron;
  return api ?? null;
};

const cacheKeyFor = (providerId: RuntimeKind): string => `${MODEL_CACHE_KEY_PREFIX}${providerId}`;

const readCachedModels = (providerId: RuntimeKind): AgentModelDescriptor[] => {
  const memoryModels = memoryCache.get(providerId);
  if (memoryModels) {
    return memoryModels;
  }

  try {
    const cached = getSessionStorage()?.getItem(cacheKeyFor(providerId));
    if (!cached) {
      return [];
    }
    const parsed = JSON.parse(cached);
    if (!Array.isArray(parsed)) {
      return [];
    }
    memoryCache.set(providerId, parsed as AgentModelDescriptor[]);
    return parsed as AgentModelDescriptor[];
  } catch (error) {
    console.error(`[provider-model-cache] Failed to read ${providerId} model cache:`, error);
    return [];
  }
};

export const writeCachedProviderModels = (
  providerId: RuntimeKind,
  models: AgentModelDescriptor[],
): void => {
  memoryCache.set(providerId, models);
  try {
    getSessionStorage()?.setItem(cacheKeyFor(providerId), JSON.stringify(models));
  } catch (error) {
    console.error(`[provider-model-cache] Failed to persist ${providerId} model cache:`, error);
  }
};

const modelValue = (model: Record<string, unknown>): string | null => {
  const value = model.value ?? model.modelId ?? model.id;
  return typeof value === "string" && value.trim().length > 0 ? value : null;
};

const modelName = (model: Record<string, unknown>, fallback: string): string => {
  const value = model.name ?? model.displayName;
  return typeof value === "string" && value.trim().length > 0 ? value : fallback;
};

const normalizeAcpModels = (
  rawModels: unknown,
  { providerId, providerName }: ProviderModelConfig,
): AgentModelDescriptor[] => {
  if (!Array.isArray(rawModels)) {
    return [];
  }

  return rawModels.flatMap((rawModel) => {
    if (!rawModel || typeof rawModel !== "object") {
      return [];
    }
    const record = rawModel as Record<string, unknown>;
    const value = modelValue(record);
    if (!value) {
      return [];
    }
    return [
      {
        id: value,
        modelName: modelName(record, value),
        modelId: value,
        providerId,
        providerName,
        ...(typeof record.description === "string" ? { description: record.description } : {}),
        variants: Array.isArray(record.variants) ? (record.variants as string[]) : [],
        contextWindow: typeof record.contextWindow === "number" ? record.contextWindow : 200_000,
      },
    ];
  });
};

export const loadProviderModels = async (
  config: ProviderModelConfig,
): Promise<AgentModelDescriptor[]> => {
  const cachedModels = readCachedModels(config.providerId);
  if (cachedModels.length > 0) {
    return cachedModels;
  }

  const electronApi = readElectronApi();
  if (!electronApi) {
    return [];
  }

  const result = await electronApi.invoke("acp_get_models", { agentId: config.agentId });
  const models = normalizeAcpModels((result as { models?: unknown } | null)?.models, config);
  writeCachedProviderModels(config.providerId, models);
  return models;
};

export const savePreferredRuntimeKind = (runtimeKind: RuntimeKind): void => {
  if (typeof window !== "undefined") {
    (
      window as Window & { __openducktor_selected_runtime_kind?: RuntimeKind }
    ).__openducktor_selected_runtime_kind = runtimeKind;
  }
  try {
    getSessionStorage()?.setItem(PREFERRED_RUNTIME_KIND_KEY, runtimeKind);
  } catch (error) {
    console.error("[provider-model-cache] Failed to persist preferred runtime kind:", error);
  }
};

export const readPreferredRuntimeKind = (fallback: RuntimeKind): RuntimeKind => {
  if (typeof window === "undefined") {
    return fallback;
  }
  const runtimeKind =
    (window as Window & { __openducktor_selected_runtime_kind?: RuntimeKind })
      .__openducktor_selected_runtime_kind ??
    getSessionStorage()?.getItem(PREFERRED_RUNTIME_KIND_KEY);
  return knownRuntimeKindValues.includes(runtimeKind as RuntimeKind)
    ? (runtimeKind as RuntimeKind)
    : fallback;
};
