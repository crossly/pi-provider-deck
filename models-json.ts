// models-json.ts — read/write pi's native ~/.pi/agent/models.json.
//
// models.json is the single source of truth. Extension-owned providers carry a
// `piProviderDeck` metadata block ({ managed, group, discovery, defaults,
// modelOverrides, hidden }); native/other-extension entries are never modified.

import { join } from 'node:path';
import type { Channel } from './contracts.ts';

export const MANAGED_METADATA_KEY = 'piProviderDeck';

export interface ManagedMetadata {
  managed: true;
  group?: string;
  discovery?: Channel['discovery'];
  envVars?: string[];
  injectV1?: boolean;
  defaults?: Channel['defaults'];
  modelOverrides?: Channel['modelOverrides'];
  hidden?: boolean;
}

export interface ModelsJsonProviderEntry {
  name?: string;
  baseUrl?: string;
  api?: string;
  apiKey?: string;
  authHeader?: boolean;
  headers?: Record<string, string>;
  models?: Array<Record<string, unknown>>;
  modelOverrides?: Record<string, unknown>;
  compat?: Record<string, unknown>;
  [key: string]: unknown;
}

export interface ModelsJsonDocument {
  providers: Record<string, ModelsJsonProviderEntry>;
  [key: string]: unknown;
}

function isObjectRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function parseModelsJson(source: string | undefined): ModelsJsonDocument {
  if (source === undefined || !source.trim()) return { providers: {} };
  const value: unknown = JSON.parse(source);
  if (!isObjectRecord(value) || !isObjectRecord(value.providers)) {
    throw new Error('models.json must be an object with a "providers" object.');
  }
  return value as unknown as ModelsJsonDocument;
}

function cloneJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

export function isManagedEntry(entry: ModelsJsonProviderEntry | undefined): boolean {
  return managedMetadata(entry)?.managed === true;
}

export function managedMetadata(entry: ModelsJsonProviderEntry | undefined): ManagedMetadata | undefined {
  const value = entry?.[MANAGED_METADATA_KEY];
  if (!isObjectRecord(value) || (value as { managed?: unknown }).managed !== true) return undefined;
  return value as unknown as ManagedMetadata;
}

function deckMetadata(entry: ModelsJsonProviderEntry | undefined): (ManagedMetadata & { managed?: boolean }) | undefined {
  const value = entry?.[MANAGED_METADATA_KEY];
  return isObjectRecord(value) ? value as unknown as (ManagedMetadata & { managed?: boolean }) : undefined;
}

export function isHiddenEntry(entry: ModelsJsonProviderEntry | undefined): boolean {
  return deckMetadata(entry)?.hidden === true;
}


/** Convert a models.json provider entry into the internal Channel shape. */
export function entryToChannel(id: string, entry: ModelsJsonProviderEntry): Channel | undefined {
  const meta = managedMetadata(entry);
  if (!meta) return undefined;
  const { [MANAGED_METADATA_KEY]: _meta, models: _models, ...native } = entry;
  return {
    ...(cloneJson(native) as unknown as Channel),
    id,
    ...(entry.name !== undefined ? { name: entry.name } : {}),
    ...(meta.group !== undefined ? { group: meta.group } : {}),
    ...(meta.envVars !== undefined ? { envVars: meta.envVars } : {}),
    ...(meta.injectV1 !== undefined ? { injectV1: meta.injectV1 } : {}),
    ...(meta.defaults !== undefined ? { defaults: meta.defaults } : {}),
    ...(meta.modelOverrides !== undefined ? { modelOverrides: meta.modelOverrides } : {}),
    ...(meta.discovery !== undefined ? { discovery: meta.discovery } : {}),
  };
}

/** Upsert a managed channel into the document, preserving unknown fields. */
export function setManagedEntry(doc: ModelsJsonDocument, channel: Channel): ModelsJsonDocument {
  const entry: ModelsJsonProviderEntry = cloneJson(doc.providers[channel.id] ?? {});
  const previous = managedMetadata(entry);
  const meta: ManagedMetadata = {
    managed: true,
    ...(channel.group !== undefined ? { group: channel.group } : previous?.group !== undefined ? { group: previous.group } : {}),
    ...(channel.discovery !== undefined ? { discovery: channel.discovery } : previous?.discovery !== undefined ? { discovery: previous.discovery } : {}),
    ...(channel.envVars !== undefined ? { envVars: channel.envVars } : previous?.envVars !== undefined ? { envVars: previous.envVars } : {}),
    ...(channel.injectV1 !== undefined ? { injectV1: channel.injectV1 } : previous?.injectV1 !== undefined ? { injectV1: previous.injectV1 } : {}),
    ...(channel.defaults !== undefined ? { defaults: channel.defaults } : previous?.defaults !== undefined ? { defaults: previous.defaults } : {}),
    ...(channel.modelOverrides !== undefined ? { modelOverrides: channel.modelOverrides } : previous?.modelOverrides !== undefined ? { modelOverrides: previous.modelOverrides } : {}),
    hidden: false,
  };
  entry.name = channel.name ?? entry.name ?? channel.id;
  entry.baseUrl = channel.baseUrl;
  entry.api = channel.api;
  entry.apiKey = channel.apiKey;
  if (channel.authHeader !== undefined) entry.authHeader = channel.authHeader;
  else if (channel.authHeader === undefined && entry.authHeader === undefined) entry.authHeader = true;
  if (channel.headers !== undefined) entry.headers = channel.headers;
  entry[MANAGED_METADATA_KEY] = meta;
  return { ...doc, providers: { ...doc.providers, [channel.id]: entry } };
}

/** Mark a provider hidden (native) or remove it entirely (managed). */
export function removeOrHideEntry(doc: ModelsJsonDocument, id: string): ModelsJsonDocument {
  const entry = doc.providers[id];
  if (!entry) {
    const marker: ModelsJsonProviderEntry = { [MANAGED_METADATA_KEY]: { managed: false, hidden: true } };
    return { ...doc, providers: { ...doc.providers, [id]: marker } };
  }
  if (!isManagedEntry(entry)) {
    const meta = deckMetadata(entry);
    const next = cloneJson(entry);
    next[MANAGED_METADATA_KEY] = { ...(meta ?? {}), hidden: true };
    return { ...doc, providers: { ...doc.providers, [id]: next } };
  }
  const providers = { ...doc.providers };
  delete providers[id];
  return { ...doc, providers };
}

/** Un-hide a previously hidden native provider. */
export function unhideEntry(doc: ModelsJsonDocument, id: string): ModelsJsonDocument {
  const entry = doc.providers[id];
  if (!entry) return doc;
  const meta = deckMetadata(entry);
  if (!meta?.hidden) return doc;
  const next = cloneJson(entry);
  next[MANAGED_METADATA_KEY] = { ...meta, hidden: false };
  return { ...doc, providers: { ...doc.providers, [id]: next } };
}

/** Convert an omp-channels.json channel into a native models.json entry. */
export function channelToEntry(channel: Channel, existing: ModelsJsonProviderEntry | undefined): ModelsJsonProviderEntry {
  const entry: ModelsJsonProviderEntry = cloneJson(existing ?? {});
  entry.name = channel.name ?? entry.name ?? channel.id;
  entry.baseUrl = channel.baseUrl;
  entry.api = channel.api;
  entry.apiKey = channel.apiKey;
  if (channel.authHeader !== undefined) entry.authHeader = channel.authHeader;
  if (channel.headers !== undefined) entry.headers = channel.headers;
  const meta: ManagedMetadata = {
    managed: true,
    ...(channel.group !== undefined ? { group: channel.group } : {}),
    ...(channel.discovery !== undefined ? { discovery: channel.discovery } : {}),
    ...(channel.envVars !== undefined ? { envVars: channel.envVars } : {}),
    ...(channel.injectV1 !== undefined ? { injectV1: channel.injectV1 } : {}),
    ...(channel.defaults !== undefined ? { defaults: channel.defaults } : {}),
    ...(channel.modelOverrides !== undefined ? { modelOverrides: channel.modelOverrides } : {}),
  };
  entry[MANAGED_METADATA_KEY] = meta;
  return entry;
}

export function defaultModelsJsonPath(agentDir: string): string {
  return join(agentDir, 'models.json');
}
