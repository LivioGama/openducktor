import {
  knownRuntimeKindValues,
  RUNTIME_DESCRIPTORS_BY_KIND,
  type RuntimeKind,
} from "@openducktor/contracts";
import type { AgentDescriptor, AgentModelDescriptor } from "@openducktor/core";
import { RUNTIME_TO_AGENT_MAP } from "../acp-registry";
import { type LanguageModelProvider, languageModelRegistry } from "../language-model-registry";
import { loadProviderModels, writeCachedProviderModels } from "./provider-model-cache";

// Every ACP runtime exposes the same OpenDucktor workflow profiles.
export const ACP_RUNTIME_PROFILES: AgentDescriptor[] = [
  { name: "planner", mode: "primary", hidden: false },
  { name: "spec", mode: "primary", hidden: false },
  { name: "build", mode: "primary", hidden: false },
  { name: "qa", mode: "primary", hidden: false },
  { name: "human-review", mode: "primary", hidden: false },
];

export type AcpRuntimeCatalogEntry = {
  runtimeKind: RuntimeKind;
  /** ACP registry agent id this runtime drives (see RUNTIME_TO_AGENT_MAP). */
  agentId: string;
  label: string;
  provider: LanguageModelProvider;
};

const createAcpLanguageModelProvider = (
  runtimeKind: RuntimeKind,
  agentId: string,
  label: string,
): LanguageModelProvider => ({
  id: runtimeKind,
  name: label,
  recommendedModels: async (): Promise<AgentModelDescriptor[]> => {
    try {
      return await loadProviderModels({
        agentId,
        providerId: runtimeKind,
        providerName: label,
      });
    } catch (error) {
      console.error(`[acpRuntimeCatalog] Failed to fetch ACP models for '${runtimeKind}':`, error);
      return [];
    }
  },
});

// One catalog entry per known runtime kind, generated from the contracts
// descriptors and the ACP registry agent-id map. Adding a runtime kind in
// @openducktor/contracts is enough to surface it here.
export const ACP_RUNTIME_CATALOG: AcpRuntimeCatalogEntry[] = knownRuntimeKindValues.map(
  (runtimeKind) => {
    const agentId = RUNTIME_TO_AGENT_MAP[runtimeKind];
    const label = RUNTIME_DESCRIPTORS_BY_KIND[runtimeKind].label;
    return {
      runtimeKind,
      agentId,
      label,
      provider: createAcpLanguageModelProvider(runtimeKind, agentId, label),
    };
  },
);

export const acpRuntimeCatalogByKind = Object.fromEntries(
  ACP_RUNTIME_CATALOG.map((entry) => [entry.runtimeKind, entry]),
) as Record<RuntimeKind, AcpRuntimeCatalogEntry>;

export const acpLanguageModelProvidersByRuntimeKind = Object.fromEntries(
  ACP_RUNTIME_CATALOG.map((entry) => [entry.runtimeKind, entry.provider]),
) as Record<RuntimeKind, LanguageModelProvider>;

let providersRegistered = false;

// Registers a language-model provider for every ACP runtime kind. Idempotent so
// it is safe to call from module load in more than one place.
export function registerAcpLanguageModelProviders(): void {
  if (providersRegistered) {
    return;
  }
  providersRegistered = true;
  for (const entry of ACP_RUNTIME_CATALOG) {
    languageModelRegistry.registerProvider(entry.provider);
  }
  languageModelRegistry.setProfiles(ACP_RUNTIME_PROFILES);
}

// Pre-populates the model cache for a runtime (used by startup preloading).
export function preloadAcpRuntimeModels(
  runtimeKind: RuntimeKind,
  models: AgentModelDescriptor[],
): void {
  writeCachedProviderModels(runtimeKind, models);
}
