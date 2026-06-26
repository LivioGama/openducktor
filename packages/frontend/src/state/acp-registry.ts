import { knownRuntimeKindValues, type RuntimeKind } from "@openducktor/contracts";
import { useEffect, useState } from "react";

export interface ACPAgent {
  id: string;
  name: string;
  icon?: string;
  version?: string;
  description?: string;
}

export interface ACPRegistry {
  agents: ACPAgent[];
}

const ACP_REGISTRY_URL = "https://cdn.agentclientprotocol.com/registry/v1/latest/registry.json";
const ACP_REGISTRY_CACHE_KEY = "acp-registry-cache";
const ACP_REGISTRY_CACHE_TTL = 60 * 60 * 1000; // 1 hour for Electron reload scenarios

let cachedRegistry: ACPRegistry | null = null;
let cacheTimestamp: number = 0;

function loadRegistryFromCache(): ACPRegistry | null {
  try {
    const cached = localStorage.getItem(ACP_REGISTRY_CACHE_KEY);
    if (!cached) return null;
    
    const { registry, timestamp } = JSON.parse(cached);
    const now = Date.now();
    
    // Check if cache is still valid
    if (now - timestamp > ACP_REGISTRY_CACHE_TTL) {
      localStorage.removeItem(ACP_REGISTRY_CACHE_KEY);
      return null;
    }
    
    return registry;
  } catch (error) {
    console.error("Failed to load ACP registry from cache:", error);
    return null;
  }
}

function saveRegistryToCache(registry: ACPRegistry): void {
  try {
    const data = {
      registry,
      timestamp: Date.now(),
    };
    localStorage.setItem(ACP_REGISTRY_CACHE_KEY, JSON.stringify(data));
  } catch (error) {
    console.error("Failed to save ACP registry to cache:", error);
  }
}

// Most ACP runtime kinds use the agent's registry id verbatim. The three
// deeply integrated runtimes keep their established OpenDucktor names, so they
// need an explicit mapping to the ACP registry agent id.
const RUNTIME_TO_AGENT_ID_OVERRIDES: Partial<Record<RuntimeKind, string>> = {
  "claude-code": "claude-acp",
  codex: "codex-acp",
};

const RUNTIME_TO_AGENT_MAP: Record<RuntimeKind, string> = Object.fromEntries(
  knownRuntimeKindValues.map((runtimeKind) => [
    runtimeKind,
    RUNTIME_TO_AGENT_ID_OVERRIDES[runtimeKind] ?? runtimeKind,
  ]),
) as Record<RuntimeKind, string>;

export { RUNTIME_TO_AGENT_MAP };

function preloadIcon(url: string): void {
  const img = new Image();
  img.src = url;
}

function preloadRuntimeIcons(registry: ACPRegistry): void {
  Object.values(RUNTIME_TO_AGENT_MAP).forEach((agentId) => {
    const agent = registry.agents.find((a) => a.id === agentId);
    if (agent?.icon) {
      preloadIcon(agent.icon);
    }
  });
}

export async function fetchACPRegistry(): Promise<ACPRegistry> {
  // Check cache first
  if (cachedRegistry && Date.now() - cacheTimestamp < ACP_REGISTRY_CACHE_TTL) {
    return cachedRegistry;
  }
  
  // Try to load from localStorage cache
  const cached = loadRegistryFromCache();
  if (cached) {
    cachedRegistry = cached;
    cacheTimestamp = Date.now();
    // Preload icons when loading from cache
    preloadRuntimeIcons(cached);
    return cached;
  }
  
  // Fetch from network
  const response = await fetch(ACP_REGISTRY_URL);
  if (!response.ok) {
    throw new Error(`Failed to fetch ACP registry: ${response.statusText}`);
  }
  
  const registry = await response.json();
  cachedRegistry = registry;
  cacheTimestamp = Date.now();
  saveRegistryToCache(registry);
  
  // Preload runtime icons after fetching
  preloadRuntimeIcons(registry);
  
  return registry;
}

export function useACPRegistry() {
  const [registry, setRegistry] = useState<ACPRegistry | null>(cachedRegistry);
  const [isLoading, setIsLoading] = useState(!cachedRegistry);
  const [error, setError] = useState<Error | null>(null);

  useEffect(() => {
    let isMounted = true;

    async function loadRegistry() {
      try {
        const data = await fetchACPRegistry();
        if (isMounted) {
          setRegistry(data);
          setIsLoading(false);
        }
      } catch (err) {
        const error = err instanceof Error ? err : new Error("Failed to fetch ACP registry");
        if (isMounted) {
          setError(error);
          setIsLoading(false);
        }
      }
    }

    if (!cachedRegistry) {
      loadRegistry();
    } else {
      setIsLoading(false);
    }

    return () => {
      isMounted = false;
    };
  }, []);

  return { registry, isLoading, error };
}

export function getAgentIcon(agentId: string): string | undefined {
  if (!cachedRegistry) return undefined;
  const agent = cachedRegistry.agents.find((a) => a.id === agentId);
  return agent?.icon;
}

export function getAgentById(agentId: string): ACPAgent | undefined {
  if (!cachedRegistry) return undefined;
  return cachedRegistry.agents.find((a) => a.id === agentId);
}
