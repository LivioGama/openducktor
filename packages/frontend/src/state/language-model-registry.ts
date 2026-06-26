import type { AgentModelDescriptor, AgentModelCatalog } from "@openducktor/core";

export type LanguageModelProvider = {
  id: string;
  name: string;
  recommendedModels(): Promise<AgentModelDescriptor[]> | AgentModelDescriptor[];
};

class LanguageModelRegistry {
  private providers: Map<string, LanguageModelProvider> = new Map();
  private cachedModelList: AgentModelDescriptor[] = [];
  private cachedProfiles: any[] = [];

  registerProvider(provider: LanguageModelProvider) {
    this.providers.set(provider.id, provider);
    // Don't refresh cache on registration - models will be fetched on demand
  }

  async refreshCache() {
    const modelPromises = Array.from(this.providers.values()).map(async (provider) => {
      try {
        const models = await provider.recommendedModels();
        return models;
      } catch (error) {
        // Silently handle provider errors - don't crash the app if a provider is unavailable
        return [];
      }
    });
    
    const modelLists = await Promise.all(modelPromises);
    this.cachedModelList = modelLists.flat();
  }

  async getModelList(): Promise<AgentModelDescriptor[]> {
    // Auto-fetch on first request if cache is empty
    if (this.cachedModelList.length === 0) {
      await this.refreshCache();
    }
    return this.cachedModelList;
  }

  async fetchModels(): Promise<void> {
    await this.refreshCache();
  }

  getProfiles(): any[] {
    return this.cachedProfiles;
  }

  setProfiles(profiles: any[]) {
    this.cachedProfiles = profiles;
  }

  async getModelCatalog(): Promise<AgentModelCatalog> {
    const models = await this.getModelList();
    return {
      models,
      defaultModelsByProvider: {},
      profiles: this.cachedProfiles,
    };
  }

  // Force refresh the cache (call when runtime changes)
  async forceRefresh() {
    this.cachedModelList = [];
    await this.refreshCache();
  }
}

export const languageModelRegistry = new LanguageModelRegistry();
