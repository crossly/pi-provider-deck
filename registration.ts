import type { Api, Model, Provider, RefreshModelsContext } from '@earendil-works/pi-ai';
import type { ProviderConfig } from '@earendil-works/pi-coding-agent';
import type { Channel } from './contracts.ts';
import { buildChannelModel } from './discovery.ts';

/**
 * Stable custom API keeps pi's models.json composer from bypassing managed
 * dispatch when its native catalog is empty or the physical API changes.
 * Actual request conversion stays in the provider's current OpenAI transport.
 */
export function createChannelRegistration(channel: Channel, provider: Provider<Api>, staticModels: readonly Model<Api>[] = []): ProviderConfig {
  const api = `pi-provider-deck:${channel.id}`;
  const project = () => {
    const models = new Map<string, Model<Api>>();
    for (const model of staticModels) models.set(model.id, buildChannelModel(channel, model.id, [model]).model);
    for (const model of provider.getModels()) models.set(model.id, model);
    return [...models.values()].map(model => ({ ...model, api, baseUrl: channel.baseUrl, headers: undefined }));
  };
  return {
    name: channel.name ?? channel.id,
    api,
    baseUrl: channel.baseUrl,
    authHeader: channel.authHeader !== false,
    models: project(),
    apiKey: channel.apiKey.startsWith('!') ? 'pi-provider-deck-managed-command' : channel.apiKey || 'unused',
    streamSimple: (model, context, options) => provider.streamSimple(model, context, options),
    refreshModels: async (context: RefreshModelsContext) => {
      await provider.refreshModels?.(context);
      return project();
    },
  };
}
