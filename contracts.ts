import type { Api, Model, ModelCost, ModelInputLimits, SamplingParamsByThinkingLevel } from '@earendil-works/pi-ai';
import type { ExtensionContext } from '@earendil-works/pi-coding-agent';

export interface ModelSpec {
  name?: string;
  contextWindow?: number;
  maxTokens?: number;
  reasoning?: boolean;
  input?: ('text' | 'image')[];
  cost?: Partial<ModelCost>;
  thinkingLevelMap?: Record<string, string | null>;
  promptCache?: { short?: number; long?: number };
  compat?: Record<string, unknown>;
  samplingParams?: Record<string, unknown>;
  samplingParamsByThinkingLevel?: SamplingParamsByThinkingLevel;
  inputLimits?: ModelInputLimits;
  /** Raw per-model header references, resolved only at request time; never cache credentials. */
  headers?: Record<string, string>;
  [field: string]: unknown;
}
export interface Channel {
  id: string;
  name?: string;
  /** Optional UI grouping label shown in the provider panel. */
  group?: string;
  baseUrl: string;
  api: 'openai-responses' | 'openai-completions';
  apiKey: string;
  authHeader?: boolean;
  envVars?: string[];
  headers?: Record<string, string>;
  injectV1?: boolean;
  defaults?: ModelSpec;
  modelOverrides?: Record<string, ModelSpec>;
  discovery?: { type: 'openai' | 'ollama' | 'gemini'; url?: string; timeoutMs?: number; [field: string]: unknown };
}
export interface ProviderRow {
  id: string;
  name: string;
  group?: string;
  endpoint?: string;
  transportApi?: Channel['api'];
  managed: boolean;
  dynamic: boolean;
  configured: boolean;
  models: readonly Model<Api>[];
  status: 'idle' | 'refreshing' | 'success' | 'error' | 'cancelled' | 'static';
  message?: string;
  refreshedAt?: number;
}
export interface RefreshSummary { results: Array<{ id: string; status: ProviderRow['status']; count: number; message?: string }> }
export interface HubService {
  snapshot(ctx: ExtensionContext): ProviderRow[];
  sync(ctx: ExtensionContext): Promise<void>;
  refresh(ctx: ExtensionContext, ids: readonly string[], signal?: AbortSignal): Promise<RefreshSummary>;
  channels(): readonly Channel[];
  upsert(channel: Channel, ctx: ExtensionContext): Promise<void>;
  remove(id: string, ctx: ExtensionContext): Promise<void>;
  subscribe(listener: () => void): () => void;
  dispose(): void;
}
export type HubResult =
  | { model: Model<Api> }
  | { action: 'add' }
  | { action: 'edit' | 'remove'; providerId: string }
  | undefined;
export interface HubUIOptions {
  initialProvider?: string;
  refreshOnOpen?: boolean;
}
export interface ProviderDeckOptions {
  /** Required by SDK embeddings that use a non-default config directory. */
  agentDir?: string;
  /** Overrides the models.json path; defaults to <agentDir>/models.json. */
  configPath?: string;
}
