import type { ExtensionAPI, ExtensionContext, ProviderConfig } from '@earendil-works/pi-coding-agent';
import { getBuiltinProviders } from '@earendil-works/pi-ai/providers/all';
import type { Api, Model, Provider } from '@earendil-works/pi-ai';
import { resolve, dirname, join } from 'node:path';
import { rename } from 'node:fs/promises';
import type { Channel, HubService, ProviderRow, RefreshSummary, ModelSpec } from './contracts.ts';
import { compareAndRestore, readOptionalText, readOptionalTextSync, withConfigLock, writeAtomic } from './config-store.ts';
import { createChannelProvider, buildChannelModel, DiscoveryError, type DiscoveryResult } from './discovery.ts';
import { createChannelRegistration } from './registration.ts';
import { MANAGED_METADATA_KEY, channelToEntry, entryToChannel, isHiddenEntry, isManagedEntry, managedMetadata, parseModelsJson, removeOrHideEntry, setManagedEntry, type ModelsJsonDocument } from './models-json.ts';

const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
const MAX_ID_LENGTH = 256;
const MAX_NAME_LENGTH = 512;
const MAX_HEADER_COUNT = 256;
const MAX_MODEL_OVERRIDES = 20_000;
const MAX_REFRESH_CONCURRENCY = 4;
const MAX_REFRESH_QUEUE = 256;
const REFRESH_DEADLINE_MS = 20_000;
const CONTROL_CHARS = /[\u0000-\u001f\u007f-\u009f]/;

type JsonObject = Record<string, unknown>;
type StoredChannel = Channel;

type RawDocument = ModelsJsonDocument;

interface ProviderReplacement {
  provider?: Provider<Api>;
  config?: unknown;
}

interface ProviderEntry {
  channel: Channel;
  provider: Provider<Api>;
  registration: ProviderConfig;
  generation: number;
  fingerprint: string;
  replaced?: ProviderReplacement;
}

interface ProviderState {
  status: ProviderRow['status'];
  models: Model<Api>[];
  message?: string;
  refreshedAt?: number;
  usedFallbackMetadata: boolean;
}

interface RefreshOutcome {
  id: string;
  status: ProviderRow['status'];
  count: number;
  message?: string;
}

interface RefreshWaiter {
  resolve: (outcome: RefreshOutcome) => void;
  signal?: AbortSignal;
  onAbort?: () => void;
}

interface RefreshJob {
  id: string;
  generation: number | undefined;
  provider: Provider<Api>;
  ctx: ExtensionContext;
  controller: AbortController;
  waiters: Set<RefreshWaiter>;
  started: boolean;
  settled: boolean;
}

interface RegistryCompat {
  getProvider(id: string): Provider<Api> | undefined;
  getRegisteredProviderConfig?: (id: string) => unknown;
  getRegisteredNativeProvider?: (id: string) => Provider<Api> | undefined;
  getRegisteredProviderIds?: () => readonly string[];
  getProviderAuthStatus?: (id: string) => { configured?: boolean };
}

interface ConfigCommit {
  previousText: string | undefined;
  writtenText: string;
  document: RawDocument;
  skipped: boolean;
  registrationError?: unknown;
}

function validationError(message: string): Error {
  return new Error(`Invalid model hub configuration: ${message}`);
}

function cloneJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function assertString(value: unknown, label: string, required = true): string | undefined {
  if (value === undefined && !required) return undefined;
  if (typeof value !== 'string' || (required && value.trim().length === 0)) {
    throw validationError(`${label} must be a non-empty string.`);
  }
  if (CONTROL_CHARS.test(value as string)) throw validationError(`${label} contains control characters.`);
  return value as string;
}

function assertPositiveNumber(value: unknown, label: string): void {
  if (value !== undefined && (typeof value !== 'number' || !Number.isFinite(value) || value <= 0)) {
    throw validationError(`${label} must be a positive number.`);
  }
}

function assertNonNegativeNumber(value: unknown, label: string): void {
  if (value !== undefined && (typeof value !== 'number' || !Number.isFinite(value) || value < 0)) {
    throw validationError(`${label} must be a non-negative number.`);
  }
}

function assertPlainObject(value: unknown, label: string): asserts value is JsonObject {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw validationError(`${label} must be an object.`);
}

function validateCost(value: unknown, label: string): void {
  if (value === undefined) return;
  assertPlainObject(value, label);
  for (const [key, costValue] of Object.entries(value)) {
    if (['input', 'output', 'cacheRead', 'cacheWrite'].includes(key)) {
      assertNonNegativeNumber(costValue, `${label}.${key}`);
      continue;
    }
    if (key !== 'tiers') continue;
    if (!Array.isArray(costValue)) throw validationError(`${label}.tiers must be an array.`);
    for (const [index, tier] of costValue.entries()) {
      assertPlainObject(tier, `${label}.tiers[${index}]`);
      assertNonNegativeNumber(tier.inputTokensAbove, `${label}.tiers[${index}].inputTokensAbove`);
      for (const rate of ['input', 'output', 'cacheRead', 'cacheWrite']) assertNonNegativeNumber(tier[rate], `${label}.tiers[${index}].${rate}`);
    }
  }
}

function validateInputLimits(value: unknown, label: string): void {
  if (value === undefined) return;
  assertPlainObject(value, label);
  assertPositiveNumber(value.maxRequestBytes, `${label}.maxRequestBytes`);
  const images = value.images;
  if (images === undefined) return;
  assertPlainObject(images, `${label}.images`);
  assertPositiveNumber(images.maxPerMessage, `${label}.images.maxPerMessage`);
  assertPositiveNumber(images.maxPerRequest, `${label}.images.maxPerRequest`);
  const resize = images.resize;
  if (resize === undefined) return;
  assertPlainObject(resize, `${label}.images.resize`);
  assertPositiveNumber(resize.maxWidth, `${label}.images.resize.maxWidth`);
  assertPositiveNumber(resize.maxHeight, `${label}.images.resize.maxHeight`);
  assertPositiveNumber(resize.maxBytes, `${label}.images.resize.maxBytes`);
  if (resize.jpegQuality !== undefined && (typeof resize.jpegQuality !== 'number' || !Number.isFinite(resize.jpegQuality) || resize.jpegQuality < 0 || resize.jpegQuality > 100)) {
    throw validationError(`${label}.images.resize.jpegQuality is invalid.`);
  }
}

function validateModelSpec(value: unknown, label: string): ModelSpec | undefined {
  if (value === undefined) return undefined;
  assertPlainObject(value, label);
  const source = value;
  const name = assertString(source.name, `${label}.name`, false);
  if (name !== undefined && name.length > MAX_NAME_LENGTH) throw validationError(`${label}.name is too long.`);
  assertPositiveNumber(source.contextWindow, `${label}.contextWindow`);
  assertPositiveNumber(source.maxTokens, `${label}.maxTokens`);
  if (source.reasoning !== undefined && typeof source.reasoning !== 'boolean') throw validationError(`${label}.reasoning must be boolean.`);
  if (source.input !== undefined && (!Array.isArray(source.input) || source.input.some(item => item !== 'text' && item !== 'image'))) {
    throw validationError(`${label}.input contains an unsupported value.`);
  }
  validateCost(source.cost, `${label}.cost`);
  const promptCache = source.promptCache;
  if (promptCache !== undefined) {
    assertPlainObject(promptCache, `${label}.promptCache`);
    for (const promptValue of Object.values(promptCache)) assertNonNegativeNumber(promptValue, `${label}.promptCache`);
  }
  for (const field of ['compat', 'samplingParams', 'thinkingLevelMap', 'samplingParamsByThinkingLevel', 'samplingByThinking']) {
    const fieldValue = source[field];
    if (fieldValue !== undefined) assertPlainObject(fieldValue, `${label}.${field}`);
  }
  const thinkingLevelMap = source.thinkingLevelMap;
  if (thinkingLevelMap !== undefined) {
    assertPlainObject(thinkingLevelMap, `${label}.thinkingLevelMap`);
    for (const thinkingValue of Object.values(thinkingLevelMap)) {
      if (thinkingValue !== null && typeof thinkingValue !== 'string') throw validationError(`${label}.thinkingLevelMap is invalid.`);
    }
  }
  validateInputLimits(source.inputLimits, `${label}.inputLimits`);
  const headers = source.headers;
  if (headers !== undefined) {
    assertPlainObject(headers, `${label}.headers`);
    for (const [header, headerValue] of Object.entries(headers)) {
      if (!header || CONTROL_CHARS.test(header) || typeof headerValue !== 'string' || CONTROL_CHARS.test(headerValue)) throw validationError(`${label}.headers is invalid.`);
    }
  }
  return cloneJson(source) as ModelSpec;
}

function validateChannel(value: unknown, index = 0): Channel {
  assertPlainObject(value, `channels[${index}]`);
  const source = value;
  const id = assertString(source.id, `channels[${index}].id`) as string;
  if (id.length > MAX_ID_LENGTH || /[\u0000\r\n\t/]/.test(id)) throw validationError(`channels[${index}].id is invalid.`);
  const baseUrl = assertString(source.baseUrl, `channels[${index}].baseUrl`) as string;
  let parsedBase: URL;
  try {
    parsedBase = new URL(baseUrl);
  } catch {
    throw validationError(`channels[${index}].baseUrl is invalid.`);
  }
  if (parsedBase.protocol !== 'http:' && parsedBase.protocol !== 'https:') throw validationError(`channels[${index}].baseUrl must use HTTP or HTTPS.`);
  if (parsedBase.username || parsedBase.password) throw validationError(`channels[${index}].baseUrl must not contain credentials.`);
  if (source.api !== 'openai-responses' && source.api !== 'openai-completions') throw validationError(`channels[${index}].api is invalid.`);
  if (typeof source.apiKey !== 'string' || CONTROL_CHARS.test(source.apiKey)) throw validationError(`channels[${index}].apiKey must be a safe string.`);
  const apiKey = source.apiKey;
  const name = assertString(source.name, `channels[${index}].name`, false);
  if (name !== undefined && name.length > MAX_NAME_LENGTH) throw validationError(`channels[${index}].name is too long.`);
  const group = assertString(source.group, `channels[${index}].group`, false);
  if (group !== undefined && group.length > MAX_NAME_LENGTH) throw validationError(`channels[${index}].group is too long.`);
  if (source.authHeader !== undefined && typeof source.authHeader !== 'boolean') throw validationError(`channels[${index}].authHeader must be boolean.`);
  if (source.injectV1 !== undefined && typeof source.injectV1 !== 'boolean') throw validationError(`channels[${index}].injectV1 must be boolean.`);
  if (source.envVars !== undefined && (!Array.isArray(source.envVars) || source.envVars.some(item => typeof item !== 'string' || !ENV_NAME.test(item)))) {
    throw validationError(`channels[${index}].envVars is invalid.`);
  }
  const headers = source.headers;
  if (headers !== undefined) {
    assertPlainObject(headers, `channels[${index}].headers`);
    if (Object.keys(headers).length > MAX_HEADER_COUNT) throw validationError(`channels[${index}].headers has too many entries.`);
    for (const [key, headerValue] of Object.entries(headers)) {
      if (!key || CONTROL_CHARS.test(key) || typeof headerValue !== 'string' || CONTROL_CHARS.test(headerValue)) throw validationError(`channels[${index}].headers is invalid.`);
    }
  }
  const defaults = validateModelSpec(source.defaults, `channels[${index}].defaults`);
  const modelOverridesSource = source.modelOverrides;
  if (modelOverridesSource !== undefined) assertPlainObject(modelOverridesSource, `channels[${index}].modelOverrides`);
  const modelOverrides: Record<string, ModelSpec> = {};
  if (modelOverridesSource !== undefined) {
    if (Object.keys(modelOverridesSource).length > MAX_MODEL_OVERRIDES) throw validationError(`channels[${index}].modelOverrides has too many entries.`);
    for (const [modelId, spec] of Object.entries(modelOverridesSource)) {
      if (!modelId || modelId.length > MAX_ID_LENGTH || CONTROL_CHARS.test(modelId)) throw validationError(`channels[${index}].modelOverrides has an invalid model id.`);
      modelOverrides[modelId] = validateModelSpec(spec, `channels[${index}].modelOverrides.${modelId}`) ?? {};
    }
  }
  let discovery: Channel['discovery'];
  const discoverySource = source.discovery;
  if (discoverySource !== undefined) {
    assertPlainObject(discoverySource, `channels[${index}].discovery`);
    const type = discoverySource.type;
    if (type !== 'openai' && type !== 'ollama' && type !== 'gemini') throw validationError(`channels[${index}].discovery.type is invalid.`);
    const url = assertString(discoverySource.url, `channels[${index}].discovery.url`, false);
    if (url !== undefined) {
      try {
        const parsed = new URL(url);
        if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') throw new Error('unsupported');
        if (parsed.username || parsed.password) throw new Error('credentials');
      } catch {
        throw validationError(`channels[${index}].discovery.url is invalid.`);
      }
    }
    if (discoverySource.timeoutMs !== undefined && (typeof discoverySource.timeoutMs !== 'number' || !Number.isFinite(discoverySource.timeoutMs) || discoverySource.timeoutMs < 100 || discoverySource.timeoutMs > 120_000)) {
      throw validationError(`channels[${index}].discovery.timeoutMs is invalid.`);
    }
    discovery = {
      ...(cloneJson(discoverySource) as JsonObject),
      type,
      ...(url !== undefined ? { url } : {}),
      ...(discoverySource.timeoutMs !== undefined ? { timeoutMs: discoverySource.timeoutMs } : {}),
    } as Channel['discovery'];
  }
  return {
    ...(cloneJson(source) as JsonObject),
    id,
    ...(name !== undefined ? { name } : {}),
    ...(group !== undefined ? { group } : {}),
    baseUrl,
    api: source.api,
    apiKey,
    ...(source.authHeader !== undefined ? { authHeader: source.authHeader } : {}),
    ...(source.envVars !== undefined ? { envVars: [...source.envVars as string[]] } : {}),
    ...(headers !== undefined ? { headers: cloneJson(headers) as Record<string, string> } : {}),
    ...(source.injectV1 !== undefined ? { injectV1: source.injectV1 } : {}),
    ...(defaults !== undefined ? { defaults } : {}),
    ...(modelOverridesSource !== undefined ? { modelOverrides } : {}),
    ...(discovery !== undefined ? { discovery } : {}),
  } as Channel;
}

function parseDocument(value: unknown): RawDocument {
  assertPlainObject(value, 'models.json document');
  if (value.providers === undefined) return { providers: {} };
  return parseModelsJson(JSON.stringify(value));
}

function documentChannels(document: RawDocument): Channel[] {
  const channels: Channel[] = [];
  for (const [id, entry] of Object.entries(document.providers)) {
    const channel = entryToChannel(id, entry);
    if (channel) channels.push(validateChannel(channel));
  }
  return channels;
}

function parseText(text: string): RawDocument {
  let value: unknown;
  try {
    value = JSON.parse(text) as unknown;
  } catch {
    throw validationError('models.json is malformed.');
  }
  return parseDocument(value);
}

/**
 * One-time migration: convert a legacy omp-channels.json registry into
 * models.json provider entries, then rename the old file as backup.
 * Idempotent: skips when the legacy file is absent or already migrated.
 */
export async function migrateLegacyChannels(modelsPath: string): Promise<boolean> {
  const legacyPath = join(dirname(modelsPath), 'omp-channels.json');
  const legacyText = await readOptionalText(legacyPath);
  if (legacyText === undefined) return false;
  const migratedMarker = await readOptionalText(`${legacyPath}.migrated`);
  if (migratedMarker !== undefined) {
    await rename(legacyPath, `${legacyPath}.superseded`).catch(() => undefined);
    return false;
  }
  let legacy: { channels?: unknown; hiddenProviders?: unknown };
  try {
    legacy = JSON.parse(legacyText) as { channels?: unknown; hiddenProviders?: unknown };
  } catch {
    throw new Error(`Legacy omp-channels.json is malformed; move it aside manually to continue: ${legacyPath}`);
  }
  if (!Array.isArray(legacy.channels)) throw new Error(`Legacy omp-channels.json has no channels array: ${legacyPath}`);
  const modelsText = await readOptionalText(modelsPath);
  const document = parseModelsJson(modelsText);
  const hidden = new Set(Array.isArray(legacy.hiddenProviders) ? legacy.hiddenProviders.filter((id): id is string => typeof id === 'string') : []);
  for (const source of legacy.channels) {
    const channel = validateChannel(source);
    document.providers[channel.id] = channelToEntry(channel, document.providers[channel.id]);
    if (hidden.has(channel.id)) {
      const meta = managedMetadata(document.providers[channel.id]);
      document.providers[channel.id]![MANAGED_METADATA_KEY] = { ...(meta ?? { managed: true as const }), hidden: true };
    }
  }
  for (const id of hidden) {
    if (document.providers[id]) continue;
    document.providers[id] = { [MANAGED_METADATA_KEY]: { managed: false, hidden: true } };
  }
  await writeAtomic(modelsPath, documentText(document));
  await rename(legacyPath, `${legacyPath}.migrated`);
  return true;
}


async function readDocument(path: string): Promise<RawDocument> {
  const text = await readOptionalText(path);
  if (text === undefined) return { providers: {} };
  return parseText(text);
}

function readDocumentSync(path: string): RawDocument {
  const text = readOptionalTextSync(path);
  if (text === undefined) return { providers: {} };
  return parseText(text);
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(item => stableJson(item)).join(',')}]`;
  if (typeof value !== 'object' || value === null) return JSON.stringify(value) ?? 'null';
  return `{${Object.keys(value as JsonObject).sort().map(key => `${JSON.stringify(key)}:${stableJson((value as JsonObject)[key])}`).join(',')}}`;
}

function channelFingerprint(channel: Channel): string {
  return stableJson(channel);
}

function documentText(document: RawDocument): string {
  return `${JSON.stringify(document, null, 2)}\n`;
}

function mergeJson(base: unknown, update: unknown): unknown {
  if (typeof base !== 'object' || base === null || Array.isArray(base) || typeof update !== 'object' || update === null || Array.isArray(update)) {
    return cloneJson(update);
  }
  const merged: JsonObject = cloneJson(base as JsonObject);
  for (const [key, value] of Object.entries(update as JsonObject)) merged[key] = key in merged ? mergeJson(merged[key], value) : cloneJson(value);
  return merged;
}

function safeProviderMessage(error: unknown, fallback: string): string {
  if (error instanceof DiscoveryError) return error.message;
  if (error instanceof DOMException && error.name === 'AbortError') return 'Refresh cancelled.';
  return fallback;
}

function providerModels(provider: Provider<Api> | undefined): Model<Api>[] {
  if (!provider) return [];
  try {
    return [...provider.getModels()];
  } catch {
    return [];
  }
}

function safeEndpoint(value: string | undefined): string | undefined {
  if (!value) return undefined;
  try {
    const url = new URL(value);
    url.username = '';
    url.password = '';
    url.search = '';
    url.hash = '';
    return url.toString().replace(/\/$/, '');
  } catch {
    return undefined;
  }
}

function channelAuthConfigured(channel: Channel): boolean {
  if (channel.authHeader === false && !channel.apiKey && !(channel.envVars?.length ?? 0)) return true;
  if (channel.apiKey.startsWith('!')) return true;
  const match = /^\$\{?([A-Za-z_][A-Za-z0-9_]*)\}?$/.exec(channel.apiKey.trim());
  if (match) return process.env[match[1]] !== undefined || (channel.envVars ?? []).some(name => process.env[name] !== undefined);
  if (channel.apiKey) return true;
  return (channel.envVars ?? []).some(name => process.env[name] !== undefined);
}

export function validateChannelConfig(value: unknown): Channel {
  return validateChannel(value);
}

export class ModelHubService implements HubService {
  private readonly pi: ExtensionAPI;
  private readonly configPath: string;
  private readonly listeners = new Set<() => void>();
  private readonly entries = new Map<string, ProviderEntry>();
  private readonly channelsById = new Map<string, Channel>();
  private readonly states = new Map<string, ProviderState>();
  private readonly generationById = new Map<string, number>();
  private readonly refreshJobs = new Map<string, RefreshJob>();
  private readonly refreshQueue: RefreshJob[] = [];
  private readonly sessionController = new AbortController();
  private mutationTail: Promise<void> = Promise.resolve();
  private refreshActive = 0;
  private rawDocument: RawDocument;
  private activeContext: ExtensionContext | undefined;
  private disposed = false;
  private lifecycleGeneration = 0;
  private configError: string | undefined;

  constructor(pi: ExtensionAPI, configPath: string) {
    this.pi = pi;
    this.configPath = resolve(configPath);
    try {
      this.rawDocument = readDocumentSync(this.configPath);
      for (const channel of documentChannels(this.rawDocument)) {
        this.channelsById.set(channel.id, channel);
        this.states.set(channel.id, { status: 'idle', models: [], usedFallbackMetadata: false });
        try {
          this.installInitialChannel(channel);
        } catch {
          this.configError = `Provider ${channel.id} could not be registered.`;
        }
      }
    } catch (error) {
      this.rawDocument = { providers: {} };
      this.configError = error instanceof Error ? error.message : 'Invalid models.json configuration.';
    }
  }

  private notify(): void {
    for (const listener of [...this.listeners]) {
      try {
        listener();
      } catch {
        // A stale UI listener must not break provider state updates.
      }
    }
  }

  private setState(id: string, patch: Partial<ProviderState>): void {
    if (this.disposed) return;
    const previous = this.states.get(id) ?? { status: 'idle', models: [], usedFallbackMetadata: false };
    this.states.set(id, { ...previous, ...patch });
    this.notify();
  }

  private nextGeneration(id: string, previous?: ProviderEntry): number {
    const generation = Math.max(this.generationById.get(id) ?? 0, previous?.generation ?? 0) + 1;
    this.generationById.set(id, generation);
    return generation;
  }

  private registry(ctx: ExtensionContext | undefined): RegistryCompat | undefined {
    return ctx?.modelRegistry as unknown as RegistryCompat | undefined;
  }

  private registryProvider(ctx: ExtensionContext | undefined, id: string): Provider<Api> | undefined {
    try {
      return this.registry(ctx)?.getProvider(id);
    } catch {
      return undefined;
    }
  }
  private ownedProvider(ctx: ExtensionContext | undefined, id: string): Provider<Api> | undefined {
    try {
      const entry = this.entries.get(id);
      const registration = this.registry(ctx)?.getRegisteredProviderConfig?.(id) as ProviderConfig | undefined;
      if (entry && registration?.streamSimple === entry.registration.streamSimple) return entry.provider;
      return this.registry(ctx)?.getRegisteredNativeProvider?.(id) ?? this.registryProvider(ctx, id);
    } catch {
      return this.registryProvider(ctx, id);
    }
  }

  private priorModels(ctx: ExtensionContext | undefined, id: string): Model<Api>[] {
    const stateModels = this.states.get(id)?.models ?? [];
    if (stateModels.length > 0) return [...stateModels];
    return providerModels(this.registryProvider(ctx, id));
  }

  private captureReplacement(ctx: ExtensionContext | undefined, id: string, current: Provider<Api> | undefined): ProviderReplacement | undefined {
    if (!current) return undefined;
    const registry = this.registry(ctx);
    try {
      const config = registry?.getRegisteredProviderConfig?.(id);
      if (config !== undefined) return { config };
      const native = registry?.getRegisteredNativeProvider?.(id);
      if (native) return { provider: native };
    } catch {
      // Fall through to the provider object when an older registry lacks ownership details.
    }
    let builtin = false;
    try {
      builtin = getBuiltinProviders().some(providerId => providerId === id);
    } catch {
      builtin = false;
    }
    return builtin ? undefined : { provider: current };
  }

  private restoreReplacement(id: string, replacement: ProviderReplacement | undefined): void {
    if (!replacement) return;
    if (replacement.config !== undefined) {
      (this.pi.registerProvider as unknown as (providerId: string, config: unknown) => void)(id, replacement.config);
      return;
    }
    if (replacement.provider) this.pi.registerProvider(replacement.provider);
  }

  private isCurrentProvider(id: string, provider: Provider<Api>, generation: number): boolean {
    const entry = this.entries.get(id);
    return !this.disposed && entry?.provider === provider && entry.generation === generation;
  }

  private staticModels(channel: Channel): Model<Api>[] {
    const entry = this.rawDocument.providers[channel.id];
    if (!entry || !Array.isArray(entry.models)) return [];
    return entry.models.flatMap(row => {
      if (!row || typeof row !== 'object' || typeof row.id !== 'string' || CONTROL_CHARS.test(row.id)) return [];
      const { apiKey: _key, headers: _headers, api: _api, baseUrl: _url, ...metadata } = row;
      const configured: Channel = { ...channel, modelOverrides: { ...channel.modelOverrides, [row.id]: { ...metadata, ...channel.modelOverrides?.[row.id] } } };
      return [buildChannelModel(configured, row.id).model];
    });
  }
  private installInitialChannel(rawChannel: StoredChannel): void {
    const channel = validateChannel(rawChannel);
    const generation = this.nextGeneration(channel.id);
    let provider!: Provider<Api>;
    provider = createChannelProvider(channel, {
      priorModels: () => this.priorModels(this.activeContext, channel.id),
      isCurrent: () => this.isCurrentProvider(channel.id, provider, generation),
      onDiscovery: result => this.noteDiscovery(channel.id, provider, result),
    });
    const registration = createChannelRegistration(channel, provider, this.staticModels(channel));
    this.pi.registerProvider(channel.id, registration);
    this.entries.set(channel.id, { channel, provider, registration, generation, fingerprint: channelFingerprint(channel) });
  }

  private noteDiscovery(id: string, provider: Provider<Api>, result: DiscoveryResult): void {
    const entry = this.entries.get(id);
    if (!entry || entry.provider !== provider || this.disposed) return;
    this.setState(id, {
      message: result.usedFallbackMetadata ? 'Some models omit metadata; unverified fallback metadata (128K context / 16K output) is in use. Configure defaults or overrides.' : undefined,
      usedFallbackMetadata: result.usedFallbackMetadata,
    });
  }

  private installChannel(channel: Channel, ctx: ExtensionContext | undefined, previousEntry?: ProviderEntry): ProviderEntry {
    const prior = this.priorModels(ctx, channel.id);
    const generation = this.nextGeneration(channel.id, previousEntry);
    const current = this.ownedProvider(ctx, channel.id);
    const replacement = current && (!previousEntry || current !== previousEntry.provider) ? this.captureReplacement(ctx, channel.id, current) : undefined;
    const retainedReplacement = previousEntry?.replaced ?? replacement;
    let provider!: Provider<Api>;
    provider = createChannelProvider(channel, {
      priorModels: () => {
        const latest = this.priorModels(ctx, channel.id);
        return latest.length > 0 ? latest : prior;
      },
      isCurrent: () => this.isCurrentProvider(channel.id, provider, generation),
      onDiscovery: result => this.noteDiscovery(channel.id, provider, result),
    });
    const registration = createChannelRegistration(channel, provider, this.staticModels(channel));
    try {
      if (current) this.pi.unregisterProvider(channel.id);
      this.pi.registerProvider(channel.id, registration);
    } catch (error) {
      try {
        if (this.ownedProvider(ctx, channel.id) === provider) this.pi.unregisterProvider(channel.id);
        if (previousEntry) this.pi.registerProvider(channel.id, previousEntry.registration);
        else this.restoreReplacement(channel.id, replacement);
      } catch (rollbackError) {
        throw new Error(`Provider ${channel.id} could not be registered and rollback failed.`, { cause: rollbackError });
      }
      throw new Error(`Provider ${channel.id} could not be registered.`, { cause: error });
    }
    return { channel, provider, registration, generation, fingerprint: channelFingerprint(channel), replaced: retainedReplacement };
  }

  private removeEntry(entry: ProviderEntry, ctx: ExtensionContext | undefined = this.activeContext): void {
    const current = this.ownedProvider(ctx, entry.channel.id);
    if (current && current !== entry.provider) return;
    try {
      this.pi.unregisterProvider(entry.channel.id);
      this.restoreReplacement(entry.channel.id, entry.replaced);
    } catch (error) {
      throw new Error(`Provider ${entry.channel.id} could not be unregistered.`, { cause: error });
    }
  }

  private applyDocument(document: RawDocument, ctx: ExtensionContext): void {
    if (this.disposed) throw new Error('Model hub service is disposed.');
    const managed = documentChannels(document).filter(channel => isManagedEntry(document.providers[channel.id]));
    const incoming = new Map(managed.map(channel => [channel.id, channel]));
    const nextEntries = new Map(this.entries);
    const nextStates = new Map(this.states);
    const undo: Array<() => void> = [];
    const changedIds = new Set<string>();
    try {
      for (const channel of managed) {
        const previous = this.entries.get(channel.id);
        const fingerprint = channelFingerprint(channel);
        const current = this.ownedProvider(ctx, channel.id);
        if (previous && previous.fingerprint === fingerprint && current === previous.provider) continue;
        changedIds.add(channel.id);
        const entry = this.installChannel(channel, ctx, previous);
        nextEntries.set(channel.id, entry);
        nextStates.set(channel.id, { ...(this.states.get(channel.id) ?? { status: 'idle', models: [], usedFallbackMetadata: false }), status: 'idle', message: undefined });
        undo.push(() => {
          const now = this.ownedProvider(ctx, channel.id);
          if (now === entry.provider) this.pi.unregisterProvider(channel.id);
          if (previous) this.pi.registerProvider(channel.id, previous.registration);
          else this.restoreReplacement(channel.id, entry.replaced);
        });
      }
      for (const [id, entry] of this.entries) {
        if (incoming.has(id)) continue;
        changedIds.add(id);
        this.removeEntry(entry, ctx);
        nextEntries.delete(id);
        nextStates.delete(id);
        undo.push(() => {
          const now = this.ownedProvider(ctx, id);
          if (now) this.pi.unregisterProvider(id);
          this.pi.registerProvider(id, entry.registration);
        });
      }
    } catch (error) {
      let rollbackError: unknown;
      for (const operation of undo.reverse()) {
        try {
          operation();
        } catch (candidate) {
          rollbackError ??= candidate;
        }
      }
      if (rollbackError) throw new Error('Model hub provider update failed and rollback was incomplete.', { cause: rollbackError });
      throw error;
    }
    for (const id of changedIds) this.invalidateRefresh(id, 'Refresh superseded by a newer channel configuration.');
    this.entries.clear();
    for (const [id, entry] of nextEntries) this.entries.set(id, entry);
    this.channelsById.clear();
    for (const channel of managed) this.channelsById.set(channel.id, channel);
    this.states.clear();
    for (const [id, state] of nextStates) this.states.set(id, state);
    this.rawDocument = document;
    this.configError = undefined;
    this.notify();
  }

  private isLive(generation: number): boolean {
    return !this.disposed && this.lifecycleGeneration === generation;
  }

  private enqueueMutation(operation: (generation: number) => Promise<void>): Promise<void> {
    const next = this.mutationTail.then(() => operation(this.lifecycleGeneration));
    this.mutationTail = next.catch(() => undefined);
    return next;
  }

  async sync(ctx: ExtensionContext): Promise<void> {
    this.activeContext = ctx;
    await this.enqueueMutation(async generation => {
      if (!this.isLive(generation)) throw new Error('Model hub service is disposed.');
      try {
        await withConfigLock(this.configPath, async () => {
          await migrateLegacyChannels(this.configPath);
          const document = await readDocument(this.configPath);
          if (!this.isLive(generation)) throw new Error('Model hub service is disposed.');
          this.applyDocument(document, ctx);
        }, { signal: this.sessionController.signal });
      } catch (error) {
        if (!this.disposed) {
          this.configError = error instanceof Error ? error.message : 'Invalid model hub configuration.';
          this.notify();
        }
        throw error;
      }
    });
  }

  snapshot(ctx: ExtensionContext): ProviderRow[] {
    this.activeContext = ctx;
    const ids = new Set<string>();
    const hidden = new Set(Object.entries(this.rawDocument.providers).filter(([, entry]) => isHiddenEntry(entry)).map(([id]) => id));
    for (const id of this.channelsById.keys()) ids.add(id);
    for (const id of this.entries.keys()) ids.add(id);
    try {
      for (const id of getBuiltinProviders()) if (this.registryProvider(ctx, id)) ids.add(id);
    } catch {
      // A reduced test/runtime catalog may not expose generated built-ins.
    }
    try {
      for (const id of this.registry(ctx)?.getRegisteredProviderIds?.() ?? []) ids.add(id);
    } catch {
      // Older/test registries may not expose provider enumeration.
    }
    try {
      for (const model of ctx.modelRegistry.getAll()) ids.add(model.provider);
    } catch {
      // Continue with providers exposed by getRegisteredProviderIds.
    }
    const rows: ProviderRow[] = [];
    for (const id of [...ids].sort((a, b) => a.localeCompare(b))) {
      if (hidden.has(id)) continue;
      const entry = this.entries.get(id);
      const channel = this.channelsById.get(id);
      const provider = this.registryProvider(ctx, id) ?? entry?.provider;
      const models = providerModels(provider);
      const state = this.states.get(id);
      const effectiveModels = models.length > 0 || !state ? models : [...state.models];
      const dynamic = Boolean(provider?.refreshModels);
      let configured = true;
      try {
        const authStatus = this.registry(ctx)?.getProviderAuthStatus?.(id);
        configured = Boolean(authStatus?.configured || (channel && channelAuthConfigured(channel)));
      } catch {
        configured = channel ? channelAuthConfigured(channel) : true;
      }
      if (!channel && !configured) continue;
      let message = state?.message;
      if (this.configError && channel) message = this.configError;
      rows.push({
        id,
        name: provider?.name ?? channel?.name ?? id,
        ...(channel?.group !== undefined ? { group: channel.group } : {}),
        transportApi: channel?.api,
        managed: Boolean(channel),
        dynamic,
        configured,
        models: effectiveModels,
        status: state?.status ?? (dynamic ? 'idle' : 'static'),
        ...(message ? { message } : {}),
        ...(state?.refreshedAt !== undefined ? { refreshedAt: state.refreshedAt } : {}),
      });
    }
    return rows;
  }

  channels(): readonly Channel[] {
    return [...this.channelsById.values()].map(channel => cloneJson(channel));
  }

  private async commitConfigMutation(generation: number, ctx: ExtensionContext, mutate: (latest: RawDocument) => RawDocument): Promise<void> {
    const commit = await withConfigLock(this.configPath, async (): Promise<ConfigCommit> => {
      const previousText = await readOptionalText(this.configPath);
      const latest = previousText === undefined ? ({ providers: {} } as RawDocument) : parseText(previousText);
      if (!this.isLive(generation)) return { previousText, writtenText: previousText ?? '', document: latest, skipped: true };
      const next = mutate(latest);
      const writtenText = documentText(next);
      await writeAtomic(this.configPath, writtenText);
      if (!this.isLive(generation)) return { previousText, writtenText, document: next, skipped: true };
      let registrationError: unknown;
      try {
        this.applyDocument(next, ctx);
      } catch (error) {
        registrationError = error;
      }
      return { previousText, writtenText, document: next, skipped: false, registrationError };
    }, { signal: this.sessionController.signal });
    if (commit.skipped) throw new Error('Model hub service is disposed.');
    if (!commit.registrationError) return;
    let restored = false;
    try {
      restored = await compareAndRestore(this.configPath, commit.writtenText, commit.previousText);
    } catch (restoreError) {
      this.configError = restoreError instanceof Error ? restoreError.message : 'Unable to restore model hub configuration.';
    }
    if (!restored && this.isLive(generation)) {
      try {
        const latest = await readDocument(this.configPath);
        if (this.isLive(generation)) this.applyDocument(latest, ctx);
      } catch (reconcileError) {
        this.configError = reconcileError instanceof Error ? reconcileError.message : 'Unable to reconcile model hub configuration.';
        this.notify();
      }
    }
    throw commit.registrationError;
  }

  async upsert(channel: Channel, ctx: ExtensionContext): Promise<void> {
    const normalized = validateChannel(channel);
    this.activeContext = ctx;
    await this.enqueueMutation(async generation => {
      if (!this.isLive(generation)) throw new Error('Model hub service is disposed.');
      const base = documentChannels(this.rawDocument).find(item => item.id === normalized.id);
      const expected = base ? channelFingerprint(base) : undefined;
      await this.commitConfigMutation(generation, ctx, latest => {
        const current = documentChannels(latest).find(item => item.id === normalized.id);
        if ((expected !== undefined && (!current || channelFingerprint(current) !== expected)) || (expected === undefined && current)) {
          throw new Error(`Provider ${normalized.id} changed externally; retry the edit.`);
        }
        const merged: Channel = { ...current, ...normalized } as Channel;
        return setManagedEntry(latest, merged);
      });
    });
  }

  async remove(id: string, ctx: ExtensionContext): Promise<void> {
    if (!id || id.length > MAX_ID_LENGTH || CONTROL_CHARS.test(id)) throw new Error('Invalid provider id.');
    this.activeContext = ctx;
    await this.enqueueMutation(async generation => {
      if (!this.isLive(generation)) throw new Error('Model hub service is disposed.');
      const base = documentChannels(this.rawDocument).find(item => item.id === id);
      const expected = base ? channelFingerprint(base) : undefined;
      if (!base && !this.snapshot(ctx).some(row => row.id === id)) throw new Error(`No visible provider ${id}.`);
      await this.commitConfigMutation(generation, ctx, latest => {
        const current = documentChannels(latest).find(item => item.id === id);
        if (expected !== undefined && current && channelFingerprint(current) !== expected) throw new Error(`Provider ${id} changed externally; retry the edit.`);
        if (expected === undefined && current) throw new Error(`Provider ${id} changed externally; retry the edit.`);
        return removeOrHideEntry(latest, id);
      });
    });
  }

  private currentRefreshProvider(ctx: ExtensionContext, id: string): { provider?: Provider<Api>; generation?: number; entry?: ProviderEntry } {
    const entry = this.entries.get(id);
    return { provider: this.registryProvider(ctx, id) ?? entry?.provider, generation: entry?.generation, entry };
  }

  private currentRefreshModels(job: RefreshJob): Model<Api>[] {
    return providerModels(this.registryProvider(job.ctx, job.id) ?? job.provider);
  }

  private isRefreshCurrent(job: RefreshJob): boolean {
    if (this.disposed) return false;
    const current = this.registryProvider(job.ctx, job.id);
    const owner = this.ownedProvider(job.ctx, job.id);
    const entry = this.entries.get(job.id);
    if (entry) {
      return entry.generation === job.generation && (current === job.provider || owner === entry.provider) && (entry.provider === job.provider || owner === entry.provider);
    }
    return current === job.provider;
  }


  private cancelWaiters(job: RefreshJob, outcome: RefreshOutcome): void {
    for (const waiter of job.waiters) {
      if (waiter.signal && waiter.onAbort) waiter.signal.removeEventListener('abort', waiter.onAbort);
      waiter.resolve(outcome);
    }
    job.waiters.clear();
  }

  private finishJob(job: RefreshJob, outcome: RefreshOutcome): void {
    if (job.settled) return;
    job.settled = true;
    if (job.started) this.refreshActive = Math.max(0, this.refreshActive - 1);
    if (this.refreshJobs.get(job.id) === job) this.refreshJobs.delete(job.id);
    this.cancelWaiters(job, outcome);
    this.pumpRefreshQueue();
  }

  private cancelledOutcome(id: string, job?: RefreshJob, message = 'Refresh cancelled.'): RefreshOutcome {
    return { id, status: 'cancelled', count: job ? this.currentRefreshModels(job).length : 0, message };
  }

  private cancelJob(job: RefreshJob, message: string): void {
    job.controller.abort(new DOMException(message, 'AbortError'));
    const outcome = this.cancelledOutcome(job.id, job, message);
    this.cancelWaiters(job, outcome);
    if (this.refreshJobs.get(job.id) === job) this.refreshJobs.delete(job.id);
    if (!job.started) this.finishJob(job, outcome);
  }

  private invalidateRefresh(id: string, message: string): void {
    const job = this.refreshJobs.get(id);
    if (!job) return;
    this.refreshJobs.delete(id);
    this.cancelJob(job, message);
  }

  private pumpRefreshQueue(): void {
    while (!this.disposed && this.refreshActive < MAX_REFRESH_CONCURRENCY && this.refreshQueue.length > 0) {
      const job = this.refreshQueue.shift() as RefreshJob;
      if (job.settled) continue;
      if (job.waiters.size === 0) {
        this.finishJob(job, this.cancelledOutcome(job.id, job));
        continue;
      }
      job.started = true;
      this.refreshActive += 1;
      void this.runRefreshJob(job).then(outcome => this.finishJob(job, outcome), error => this.finishJob(job, { id: job.id, status: 'error', count: 0, message: safeProviderMessage(error, 'Provider refresh failed; previous models were kept.') }));
    }
  }

  private async runRefreshJob(job: RefreshJob): Promise<RefreshOutcome> {
    const entry = this.entries.get(job.id);
    const channel = entry?.channel ?? this.channelsById.get(job.id);
    const dynamic = Boolean(job.provider.refreshModels);
    if (!dynamic) {
      const models = this.currentRefreshModels(job);
      if (this.isRefreshCurrent(job)) this.setState(job.id, { status: 'static', models, message: undefined });
      return { id: job.id, status: 'static', count: models.length };
    }
    let configured = true;
    try {
      configured = Boolean(this.registry(job.ctx)?.getProviderAuthStatus?.(job.id)?.configured);
    } catch {
      configured = channel ? channelAuthConfigured(channel) : false;
    }
    if (!configured && channel && channelAuthConfigured(channel)) configured = true;
    if (!configured) {
      const models = this.currentRefreshModels(job);
      const message = 'Authentication is not configured; cached models were kept. Use /login or configure a channel key.';
      if (this.isRefreshCurrent(job)) this.setState(job.id, { status: 'error', models, message });
      return { id: job.id, status: 'error', count: models.length, message };
    }
    if (!this.isRefreshCurrent(job)) return this.cancelledOutcome(job.id, job, 'Refresh superseded by a newer channel configuration.');
    const requestSignal = AbortSignal.any([job.controller.signal, this.sessionController.signal, AbortSignal.timeout(REFRESH_DEADLINE_MS)]);
    this.setState(job.id, { status: 'refreshing', message: undefined });
    try {
      const result = await job.ctx.modelRegistry.refresh({ providers: [job.id], allowNetwork: true, force: true, signal: requestSignal });
      const models = this.currentRefreshModels(job);
      if (!this.isRefreshCurrent(job)) return { id: job.id, status: 'cancelled', count: models.length, message: 'Refresh superseded by a newer channel configuration.' };
      if (result.aborted || requestSignal.aborted) {
        const message = 'Refresh cancelled.';
        this.setState(job.id, { status: 'cancelled', models, message });
        return { id: job.id, status: 'cancelled', count: models.length, message };
      }
      const error = result.errors.get(job.id);
      if (error) {
        const message = safeProviderMessage(error, 'Provider refresh failed; previous models were kept.');
        this.setState(job.id, { status: 'error', models, message });
        return { id: job.id, status: 'error', count: models.length, message };
      }
      const refreshedAt = Date.now();
      this.setState(job.id, { status: 'success', models, refreshedAt, message: this.states.get(job.id)?.message });
      return { id: job.id, status: 'success', count: models.length, ...(this.states.get(job.id)?.message ? { message: this.states.get(job.id)?.message } : {}) };
    } catch (error) {
      const models = this.currentRefreshModels(job);
      if (!this.isRefreshCurrent(job)) return { id: job.id, status: 'cancelled', count: models.length, message: 'Refresh superseded by a newer channel configuration.' };
      const cancelled = requestSignal.aborted || error instanceof DOMException && error.name === 'AbortError';
      const status: ProviderRow['status'] = cancelled ? 'cancelled' : 'error';
      const message = cancelled ? 'Refresh cancelled.' : safeProviderMessage(error, 'Provider refresh failed; previous models were kept.');
      this.setState(job.id, { status, models, message });
      return { id: job.id, status, count: models.length, message };
    }
  }

  private attachRefreshWaiter(job: RefreshJob, signal: AbortSignal | undefined): Promise<RefreshOutcome> {
    const { promise, resolve } = Promise.withResolvers<RefreshOutcome>();
    if (signal?.aborted) {
      resolve(this.cancelledOutcome(job.id, job));
      return promise;
    }
    const waiter: RefreshWaiter = { resolve, signal };
    waiter.onAbort = () => {
      job.waiters.delete(waiter);
      resolve(this.cancelledOutcome(job.id, job));
      if (job.waiters.size === 0) this.cancelJob(job, 'Refresh cancelled.');
    };
    job.waiters.add(waiter);
    signal?.addEventListener('abort', waiter.onAbort, { once: true });
    return promise;
  }

  private getOrCreateRefreshJob(ctx: ExtensionContext, id: string): RefreshJob | RefreshOutcome | undefined {
    const current = this.currentRefreshProvider(ctx, id);
    if (!current.provider) return undefined;
    const existing = this.refreshJobs.get(id);
    if (existing && existing.generation === current.generation && !existing.settled && this.isRefreshCurrent(existing)) return existing;
    if (existing) this.invalidateRefresh(id, 'Refresh superseded by a newer channel configuration.');
    if (this.refreshQueue.length >= MAX_REFRESH_QUEUE) return { id, status: 'error', count: 0, message: 'Refresh queue is full.' };
    const job: RefreshJob = {
      id,
      generation: current.generation,
      provider: current.provider,
      ctx,
      controller: new AbortController(),
      waiters: new Set(),
      started: false,
      settled: false,
    };
    this.refreshJobs.set(id, job);
    this.refreshQueue.push(job);
    return job;
  }

  async refresh(ctx: ExtensionContext, ids: readonly string[], signal?: AbortSignal): Promise<RefreshSummary> {
    this.activeContext = ctx;
    const uniqueIds = [...new Set(ids)];
    if (this.disposed) return { results: uniqueIds.map(id => ({ id, status: 'cancelled', count: 0, message: 'Service disposed.' })) };
    const outcomes = new Map<string, Promise<RefreshOutcome>>();
    for (const id of uniqueIds) {
      if (signal?.aborted) {
        outcomes.set(id, Promise.resolve({ id, status: 'cancelled', count: 0, message: 'Refresh cancelled.' }));
        continue;
      }
      const job = this.getOrCreateRefreshJob(ctx, id);
      if (!job) {
        outcomes.set(id, Promise.resolve({ id, status: 'error', count: 0, message: 'Unknown provider.' }));
        continue;
      }
      if ('status' in job) {
        outcomes.set(id, Promise.resolve(job));
        continue;
      }
      outcomes.set(id, this.attachRefreshWaiter(job, signal));
    }
    this.pumpRefreshQueue();
    const resolved = new Map<string, RefreshOutcome>();
    for (const id of uniqueIds) resolved.set(id, await (outcomes.get(id) as Promise<RefreshOutcome>));
    return { results: uniqueIds.map(id => resolved.get(id) ?? { id, status: 'error', count: 0, message: 'Refresh did not complete.' }) };
  }

  subscribe(listener: () => void): () => void {
    if (this.disposed) return () => undefined;
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.lifecycleGeneration += 1;
    this.sessionController.abort(new DOMException('Model hub disposed.', 'AbortError'));
    for (const job of [...this.refreshJobs.values()]) {
      job.controller.abort(new DOMException('Model hub disposed.', 'AbortError'));
      this.finishJob(job, { id: job.id, status: 'cancelled', count: 0, message: 'Service disposed.' });
    }
    this.refreshJobs.clear();
    this.refreshQueue.length = 0;
    const errors: unknown[] = [];
    for (const entry of [...this.entries.values()]) {
      try {
        this.removeEntry(entry);
      } catch (error) {
        errors.push(error);
      }
    }
    this.entries.clear();
    this.channelsById.clear();
    this.states.clear();
    this.listeners.clear();
    if (errors.length > 0) this.configError = errors[0] instanceof Error ? errors[0].message : 'Unable to unregister a model hub provider.';
  }
}

export function createHubService(pi: ExtensionAPI, configPath: string): HubService {
  return new ModelHubService(pi, configPath);
}
