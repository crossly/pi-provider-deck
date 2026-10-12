import {
  createProvider,
  lazyStream,
  type Api,
  type ApiKeyAuth,
  type AuthCheck,
  type Credential,
  type Model,
  type Provider,
  type ProviderHeaders,
  type ProviderStreams,
  type RefreshModelsContext,
  type AssistantMessageEvent,
  type AssistantMessageEventStream,
  type ApiStreamOptions,
  type SimpleStreamOptions,
  type TranscriptContext,
  type DeferredFetchOptions,
  type DeferredCancelOptions,
  type DeferredHandle,
} from '@earendil-works/pi-ai';
import { openAICompletionsApi, openAIResponsesApi } from '@earendil-works/pi-ai/compat';
import { spawn, type ChildProcess } from 'node:child_process';
import type { Channel, ModelSpec } from './contracts.ts';

export const FALLBACK_MODEL_METADATA = Object.freeze({ contextWindow: 128_000, maxTokens: 16_384 });
export const DEFAULT_DISCOVERY_TIMEOUT_MS = 10_000;
export const MAX_DISCOVERY_BODY_BYTES = 4 * 1024 * 1024;
export const MAX_DISCOVERED_MODELS = 10_000;
const MAX_COMMAND_OUTPUT_BYTES = 128 * 1024;
const MAX_HEADER_VALUE_BYTES = 256 * 1024;
const COMMAND_TERMINATION_GRACE_MS = 750;
const ENV_REF = /^\$\{?([A-Za-z_][A-Za-z0-9_]*)\}?$/;
const ENV_INTERPOLATION = /\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g;
const UNSAFE_REMOTE_TEXT = /[\u0000-\u001f\u007f-\u009f]/u;
const MODEL_TRANSPORT_FINGERPRINT = 'modelHubTransportFingerprint';

type DiscoveryType = NonNullable<Channel['discovery']>['type'];

type HubModel = Model<Api> & { readonly modelHubTransportFingerprint?: string };

export interface DiscoveryOptions {
  signal?: AbortSignal;
  apiKey?: string;
  priorModels?: readonly Model<Api>[];
  env?: Record<string, string | undefined>;
  fetchImpl?: typeof globalThis.fetch;
}

export interface DiscoveryResult {
  models: Model<Api>[];
  endpoint: string;
  usedFallbackMetadata: boolean;
}

export interface ResolvedCredential {
  key?: string;
  source: 'stored credential' | 'configured API key' | 'environment' | 'keyless';
}

export interface ChannelProviderOptions {
  priorModels?: () => readonly Model<Api>[];
  isCurrent?: () => boolean;
  onDiscovery?: (result: DiscoveryResult) => void;
}

export class DiscoveryError extends Error {
  readonly code: 'cancelled' | 'timeout' | 'http' | 'malformed' | 'auth' | 'command';

  constructor(
    message: string,
    code: 'cancelled' | 'timeout' | 'http' | 'malformed' | 'auth' | 'command',
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = 'DiscoveryError';
    this.code = code;
  }
}

function abortError(signal?: AbortSignal): Error {
  if (signal?.reason instanceof Error) return signal.reason;
  return new DOMException('The operation was aborted.', 'AbortError');
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw abortError(signal);
}

function hasHeader(headers: Record<string, unknown> | undefined, expected: string): boolean {
  if (!headers) return false;
  const lower = expected.toLowerCase();
  return Object.keys(headers).some(name => name.toLowerCase() === lower);
}


function safeEndpoint(raw: string): string {
  try {
    const url = new URL(raw);
    url.username = '';
    url.password = '';
    url.search = '';
    url.hash = '';
    return url.toString().replace(/\/$/, '');
  } catch {
    return '<invalid endpoint>';
  }
}

function commandTimeout(timeoutMs: number): number {
  return Math.max(250, Math.min(timeoutMs, 5_000));
}

async function waitForChildClose(child: ChildProcess, timeoutMs: number): Promise<boolean> {
  if (child.exitCode !== null || child.signalCode !== null) return true;
  return await new Promise<boolean>(resolve => {
    let timer: NodeJS.Timeout;
    const onClose = () => {
      clearTimeout(timer);
      resolve(true);
    };
    child.once('close', onClose);
    timer = setTimeout(() => {
      child.removeListener('close', onClose);
      resolve(false);
    }, timeoutMs);
  });
}

function processGroupExists(pid: number): boolean {
  try {
    process.kill(-pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

async function waitForProcessGroupExit(pid: number, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (processGroupExists(pid)) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) return false;
    await new Promise<void>(resolve => setTimeout(resolve, Math.min(remaining, 25)));
  }
  return true;
}

async function terminateCommandProcess(child: ChildProcess): Promise<boolean> {
  const pid = child.pid;
  if (pid === undefined) {
    try { child.kill('SIGTERM'); } catch { /* already closed */ }
    return await waitForChildClose(child, COMMAND_TERMINATION_GRACE_MS);
  }
  if (process.platform === 'win32') {
    let taskkillFailed = false;
    const killer = spawn('taskkill', ['/PID', String(pid), '/T', '/F'], {
      stdio: 'ignore',
      windowsHide: true,
    });
    killer.once('error', () => { taskkillFailed = true; });
    // Windows taskkill can take seconds under runner/system load. Do not kill
    // its target shell before /T has enumerated and terminated descendants.
    const taskkillClosed = await waitForChildClose(killer, 10_000);
    if (!taskkillClosed || taskkillFailed) {
      try { killer.kill(); } catch { /* already closed */ }
      try { child.kill(); } catch { /* best-effort fallback after tree failure */ }
      await waitForChildClose(child, 5_000);
      return false;
    }
    const childClosed = await waitForChildClose(child, 5_000);
    return killer.exitCode === 0 && childClosed;
  }
  try { process.kill(-pid, 'SIGTERM'); } catch { /* group may have exited */ }
  try { child.kill('SIGTERM'); } catch { /* already closed */ }
  const childClosedAfterTerm = await waitForChildClose(child, COMMAND_TERMINATION_GRACE_MS);
  if (await waitForProcessGroupExit(pid, 0)) return childClosedAfterTerm;
  try { process.kill(-pid, 'SIGKILL'); } catch { /* group may have exited */ }
  try { child.kill('SIGKILL'); } catch { /* already closed */ }
  const childClosedAfterKill = await waitForChildClose(child, COMMAND_TERMINATION_GRACE_MS);
  const groupClosedAfterKill = await waitForProcessGroupExit(pid, COMMAND_TERMINATION_GRACE_MS);
  return childClosedAfterKill && groupClosedAfterKill;
}

/** Execute a configured !command without blocking the event loop or exposing output in errors. */
export async function resolveCommandValue(
  raw: string,
  options: { signal?: AbortSignal; timeoutMs?: number } = {},
): Promise<string | undefined> {
  const command = raw.slice(1).trim();
  if (!command) throw new DiscoveryError('Configured command is empty.', 'command');
  const signal = options.signal;
  throwIfAborted(signal);
  const timeoutMs = commandTimeout(options.timeoutMs ?? 5_000);
  const windows = process.platform === 'win32';
  const shell = windows ? (process.env.ComSpec ?? process.env.COMSPEC ?? 'cmd.exe') : (process.env.SHELL || '/bin/sh');
  // cmd /s strips this outer pair; preserve the user's inner quotes verbatim.
  const shellArgs = windows ? ['/d', '/s', '/c', `"${command}"`] : ['-c', command];

  return await new Promise<string | undefined>((resolve, reject) => {
    let child: ChildProcess;
    try {
      child = spawn(shell, shellArgs, {
        stdio: ['ignore', 'pipe', 'ignore'],
        env: process.env,
        detached: !windows,
        windowsHide: windows,
        windowsVerbatimArguments: windows,
      });
    } catch (error) {
      reject(new DiscoveryError('Configured command could not be started.', 'command', { cause: error }));
      return;
    }

    let settled = false;
    let terminating = false;
    let output = '';
    let timer: NodeJS.Timeout;
    const settle = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      fn();
    };
    const fail = (error: Error) => {
      if (settled || terminating) return;
      terminating = true;
      void terminateCommandProcess(child).then(cleaned => {
        settle(() => reject(cleaned ? error : new DiscoveryError('Configured command cleanup failed.', 'command')));
      }, () => {
        settle(() => reject(new DiscoveryError('Configured command cleanup failed.', 'command')));
      });
    };
    const onAbort = () => fail(abortError(signal));

    timer = setTimeout(() => fail(new DiscoveryError('Configured command timed out.', 'timeout')), timeoutMs);
    signal?.addEventListener('abort', onAbort, { once: true });

    const outputStream = child.stdout;
    if (!outputStream) {
      fail(new DiscoveryError('Configured command produced no output.', 'command'));
      return;
    }
    outputStream.setEncoding('utf8');
    outputStream.on('data', (chunk: string) => {
      if (settled || terminating) return;
      output += chunk;
      if (Buffer.byteLength(output, 'utf8') > MAX_COMMAND_OUTPUT_BYTES) {
        fail(new DiscoveryError('Configured command output is too large.', 'command'));
      }
    });
    child.once('error', error => fail(new DiscoveryError('Configured command failed.', 'command', { cause: error })));
    child.once('close', code => {
      if (settled || terminating) return;
      const value = output.trim();
      const complete = () => {
        if (code !== 0) {
          settle(() => reject(new DiscoveryError(`Configured command exited with code ${code ?? 'unknown'}.`, 'command')));
        } else if (!value) {
          settle(() => reject(new DiscoveryError('Configured command returned no credential.', 'command')));
        } else {
          settle(() => resolve(value));
        }
      };
      if (process.platform === 'win32' || child.pid === undefined || !processGroupExists(child.pid)) {
        complete();
        return;
      }
      terminating = true;
      void terminateCommandProcess(child).then(cleaned => {
        if (!cleaned) {
          settle(() => reject(new DiscoveryError('Configured command cleanup failed.', 'command')));
          return;
        }
        complete();
      }, () => settle(() => reject(new DiscoveryError('Configured command cleanup failed.', 'command'))));
    });
  });
}

interface ReferenceResolutionOptions {
  env?: Record<string, string | undefined>;
  envReader?: (name: string) => Promise<string | undefined>;
  signal?: AbortSignal;
  timeoutMs?: number;
}

async function envValue(name: string, options: ReferenceResolutionOptions): Promise<string | undefined> {
  throwIfAborted(options.signal);
  if (options.env && Object.hasOwn(options.env, name)) return options.env[name];
  const envReader = options.envReader;
  if (!envReader) return process.env[name];
  if (!options.signal) return await envReader(name);
  return await new Promise<string | undefined>((resolve, reject) => {
    const onAbort = () => reject(abortError(options.signal));
    options.signal?.addEventListener('abort', onAbort, { once: true });
    const read = envReader(name);
    read.then(value => {
      options.signal?.removeEventListener('abort', onAbort);
      if (options.signal?.aborted) reject(abortError(options.signal));
      else resolve(value);
    }, _error => {
      options.signal?.removeEventListener('abort', onAbort);
      if (options.signal?.aborted) reject(abortError(options.signal));
      else reject(new DiscoveryError('Environment lookup failed.', 'auth'));
    });
  });
}

async function resolveReference(
  raw: string,
  options: ReferenceResolutionOptions,
): Promise<string | undefined> {
  const value = raw.trim();
  if (!value) return undefined;
  if (value.startsWith('!')) return await resolveCommandValue(value, options);
  const match = ENV_REF.exec(value);
  if (!match) return value;
  return await envValue(match[1], options);
}

export async function resolveChannelCredential(
  channel: Channel,
  options: {
    credential?: Credential;
    env?: Record<string, string | undefined>;
    envReader?: (name: string) => Promise<string | undefined>;
    signal?: AbortSignal;
    timeoutMs?: number;
  } = {},
): Promise<ResolvedCredential> {
  throwIfAborted(options.signal);
  const configuredSource = channel.apiKey.trim().length > 0 || (channel.envVars?.length ?? 0) > 0;
  if (!configuredSource) {
    const stored = options.credential?.type === 'api_key' ? options.credential.key : undefined;
    if (stored) return { key: stored, source: 'stored credential' };
  }
  const configured = await resolveReference(channel.apiKey, options);
  if (configured) return { key: configured, source: ENV_REF.test(channel.apiKey) ? 'environment' : 'configured API key' };

  for (const name of channel.envVars ?? []) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) continue;
    const value = await envValue(name, options);
    throwIfAborted(options.signal);
    if (value) return { key: value, source: 'environment' };
  }

  return { source: channel.authHeader === false ? 'keyless' : 'configured API key' };
}

async function resolveHeaderEntries(
  entries: Record<string, string>,
  options: ReferenceResolutionOptions,
): Promise<ProviderHeaders | undefined> {
  const pairs = Object.entries(entries);
  if (pairs.length === 0) return undefined;
  const resolved: ProviderHeaders = {};
  for (const [name, raw] of pairs) {
    throwIfAborted(options.signal);
    let value: string | undefined;
    if (raw.startsWith('!')) {
      value = await resolveCommandValue(raw, options);
    } else {
      const exact = ENV_REF.exec(raw.trim());
      if (exact) {
        value = await envValue(exact[1], options);
      } else {
        const names = [...raw.matchAll(ENV_INTERPOLATION)].map(match => match[1]);
        if (names.length > 0) {
          const values: Record<string, string> = {};
          for (const envName of names) {
            const candidate = await envValue(envName, options);
            if (candidate === undefined) {
              throw new DiscoveryError(`Header "${name}" references a missing environment variable.`, 'auth');
            }
            values[envName] = candidate;
          }
          value = raw.replace(ENV_INTERPOLATION, (_match, envName: string) => values[envName] ?? '');
        } else {
          value = raw;
        }
      }
    }
    if (value === undefined) {
      throw new DiscoveryError(`Header "${name}" could not be resolved.`, 'auth');
    }
    if (Buffer.byteLength(value, 'utf8') > MAX_HEADER_VALUE_BYTES) {
      throw new DiscoveryError(`Header "${name}" is too large.`, 'auth');
    }
    resolved[name] = value;
  }
  return resolved;
}

export async function resolveChannelHeaders(
  channel: Channel,
  options: ReferenceResolutionOptions = {},
): Promise<ProviderHeaders | undefined> {
  return await resolveHeaderEntries(channel.headers ?? {}, options);
}

function authHeadersForTransport(
  headers: ProviderHeaders | undefined,
  authHeader: boolean,
): ProviderHeaders | undefined {
  if (authHeader) return headers;
  const merged: ProviderHeaders = { ...(headers ?? {}) };
  if (!hasHeader(merged, 'authorization')) merged.authorization = null;
  return merged;
}

function authCheckConfigured(channel: Channel, credential?: Credential): AuthCheck | undefined {
  if (credential?.type === 'api_key' && credential.key) return { type: 'api_key', source: 'stored credential' };
  if (channel.authHeader === false && !channel.apiKey && !(channel.envVars?.length ?? 0)) {
    return { type: 'api_key', source: 'keyless' };
  }
  if (channel.apiKey.startsWith('!')) return { type: 'api_key', source: 'configured API key' };
  if (!channel.apiKey) {
    return channel.envVars?.length ? undefined : { type: 'api_key', source: 'keyless' };
  }
  const match = ENV_REF.exec(channel.apiKey.trim());
  if (match) {
    const configured = process.env[match[1]] !== undefined || (channel.envVars ?? []).some(name => process.env[name] !== undefined);
    return configured ? { type: 'api_key', source: 'environment' } : undefined;
  }
  return { type: 'api_key', source: 'configured API key' };
}

function makeChannelAuth(channel: Channel): { apiKey: ApiKeyAuth } {
  const label = `${channel.name ?? channel.id} API key`;
  return {
    apiKey: {
      name: label,
      login: async interaction => ({
        type: 'api_key',
        key: await interaction.prompt({ type: 'secret', message: `Enter ${label}` }),
      }),
      check: async ({ credential, signal }) => {
        throwIfAborted(signal);
        return authCheckConfigured(channel, credential);
      },
      resolve: async ({ ctx, credential, signal }) => {
        throwIfAborted(signal);
        const env = credential?.type === 'api_key' ? credential.env : undefined;
        const resolved = await resolveChannelCredential(channel, {
          credential,
          env,
          envReader: async name => env?.[name] ?? await ctx.env(name),
          signal,
        });
        const headers = await resolveChannelHeaders(channel, {
          env,
          envReader: async name => env?.[name] ?? await ctx.env(name),
          signal,
        });
        if (!resolved.key && channel.authHeader !== false) return undefined;
        const transportKey = resolved.key ?? 'unused';
        return {
          auth: {
            apiKey: transportKey,
            headers: authHeadersForTransport(headers, channel.authHeader !== false),
          },
          source: resolved.source,
        };
      },
    },
  };
}

function streamFor(api: Channel['api']): ProviderStreams {
  return api === 'openai-completions' ? openAICompletionsApi() : openAIResponsesApi();
}

function appendPath(url: URL, suffix: string): URL {
  const base = url.pathname.replace(/\/+$/, '');
  const path = suffix.replace(/^\/+/, '');
  url.pathname = `${base}/${path}`.replace(/\/\/+/g, '/');
  return url;
}

function stripV1(pathname: string): string {
  return pathname.replace(/\/v1\/?$/i, '').replace(/\/+$/, '');
}

function normalizeExplicitDiscoveryUrl(url: string): string {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') throw new Error('unsupported protocol');
    return parsed.toString();
  } catch {
    throw new DiscoveryError('Configured discovery URL is invalid.', 'malformed');
  }
}

/** Return the canonical endpoint for one configured channel. */
export function discoveryUrl(channel: Channel): string {
  if (channel.discovery?.url) return normalizeExplicitDiscoveryUrl(channel.discovery.url);
  let parsed: URL;
  try {
    parsed = new URL(channel.baseUrl);
  } catch {
    throw new DiscoveryError('Configured base URL is invalid.', 'malformed');
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new DiscoveryError('Configured base URL must use HTTP or HTTPS.', 'malformed');
  }
  parsed.hash = '';
  const type: DiscoveryType = channel.discovery?.type ?? 'openai';
  if (type === 'openai') {
    if (channel.injectV1 === false) parsed.pathname = stripV1(parsed.pathname);
    else if (!/\/v1\/?$/i.test(parsed.pathname)) parsed.pathname = `${parsed.pathname.replace(/\/+$/, '')}/v1`;
    return appendPath(parsed, 'models').toString();
  }
  if (type === 'ollama') {
    parsed.pathname = stripV1(parsed.pathname);
    if (!/\/api\/?$/i.test(parsed.pathname)) parsed.pathname = `${parsed.pathname}/api`;
    return appendPath(parsed, 'tags').toString();
  }
  return appendPath(parsed, 'models').toString();
}

function normalizeModelId(value: string, type: DiscoveryType): string | undefined {
  const trimmed = value.trim();
  const normalized = type === 'gemini' ? trimmed.replace(/^models\//i, '') : trimmed;
  if (!normalized || normalized.length > 1024 || UNSAFE_REMOTE_TEXT.test(normalized)) return undefined;
  return normalized;
}

function malformed(endpoint: string, detail: string): DiscoveryError {
  return new DiscoveryError(`${detail} (${safeEndpoint(endpoint)}).`, 'malformed');
}

function extractIds(payload: unknown, type: DiscoveryType, endpoint: string): string[] {
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) {
    throw malformed(endpoint, 'Model catalog response must be a JSON object');
  }
  const record = payload as Record<string, unknown>;
  const key = type === 'openai' ? (Array.isArray(record.data) ? 'data' : 'models') : 'models';
  const listed = record[key];
  if (!Array.isArray(listed)) throw malformed(endpoint, 'Model catalog response has no model array');
  if (listed.length > MAX_DISCOVERED_MODELS) throw malformed(endpoint, 'Model catalog contains too many models');
  if (listed.length === 0) return [];

  const ids: string[] = [];
  for (const entry of listed) {
    let raw: unknown;
    if (typeof entry === 'string') raw = entry;
    else if (typeof entry === 'object' && entry !== null && !Array.isArray(entry)) {
      const item = entry as Record<string, unknown>;
      raw = type === 'openai' ? item.id : item.name ?? item.id;
    }
    if (typeof raw !== 'string') continue;
    if (UNSAFE_REMOTE_TEXT.test(raw)) throw malformed(endpoint, 'Model catalog contains an unsafe model identifier');
    const id = normalizeModelId(raw, type);
    if (id) ids.push(id);
  }
  if (ids.length === 0) throw malformed(endpoint, 'Model catalog contains no valid model identifiers');
  return [...new Set(ids)].sort((a, b) => a.localeCompare(b));
}

async function readBoundedBody(response: Response, signal: AbortSignal): Promise<string> {
  const contentLength = response.headers.get('content-length');
  if (contentLength && Number.isFinite(Number(contentLength)) && Number(contentLength) > MAX_DISCOVERY_BODY_BYTES) {
    throw new DiscoveryError('Model catalog response is too large.', 'malformed');
  }
  if (!response.body) {
    const text = await response.text();
    if (Buffer.byteLength(text, 'utf8') > MAX_DISCOVERY_BODY_BYTES) {
      throw new DiscoveryError('Model catalog response is too large.', 'malformed');
    }
    return text;
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      throwIfAborted(signal);
      const next = await reader.read();
      if (next.done) break;
      total += next.value.byteLength;
      if (total > MAX_DISCOVERY_BODY_BYTES) {
        await reader.cancel();
        throw new DiscoveryError('Model catalog response is too large.', 'malformed');
      }
      chunks.push(next.value);
    }
  } finally {
    reader.releaseLock();
  }
  const body = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(body);
}

async function fetchCatalog(
  endpoint: string,
  channel: Channel,
  options: DiscoveryOptions,
): Promise<unknown> {
  const signal = options.signal ?? new AbortController().signal;
  throwIfAborted(signal);
  const timeoutMs = Math.max(100, Math.min(channel.discovery?.timeoutMs ?? DEFAULT_DISCOVERY_TIMEOUT_MS, 120_000));
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort(new DiscoveryError('Model catalog request timed out.', 'timeout'));
  }, timeoutMs);
  const onAbort = () => controller.abort(signal.reason ?? abortError(signal));
  signal.addEventListener('abort', onAbort, { once: true });
  try {
    const headers = await resolveChannelHeaders(channel, {
      env: options.env,
      signal: controller.signal,
      timeoutMs,
    });
    const requestHeaders: Record<string, string> = {
      accept: 'application/json',
    };
    for (const [name, value] of Object.entries(headers ?? {})) {
      if (value !== null) requestHeaders[name] = value;
    }
    if (options.apiKey && channel.authHeader !== false && !hasHeader(requestHeaders, 'authorization')) {
      if (channel.discovery?.type === 'gemini') {
        if (!hasHeader(requestHeaders, 'x-goog-api-key')) requestHeaders['x-goog-api-key'] = options.apiKey;
      } else {
        requestHeaders.authorization = `Bearer ${options.apiKey}`;
      }
    }
    const fetchImpl = options.fetchImpl ?? globalThis.fetch;
    const response = await fetchImpl(endpoint, { headers: requestHeaders, signal: controller.signal, redirect: 'error' });
    if (!response.ok) {
      throw new DiscoveryError(`Model catalog request failed with HTTP ${response.status}.`, 'http');
    }
    const text = await readBoundedBody(response, controller.signal);
    try {
      return JSON.parse(text) as unknown;
    } catch {
      throw new DiscoveryError(`Model catalog returned invalid JSON (${safeEndpoint(endpoint)}).`, 'malformed');
    }
  } catch (error) {
    if (signal.aborted) throw abortError(signal);
    if (timedOut || controller.signal.reason instanceof DiscoveryError && (controller.signal.reason as DiscoveryError).code === 'timeout') {
      throw new DiscoveryError(`Model catalog request timed out (${safeEndpoint(endpoint)}).`, 'timeout');
    }
    if (error instanceof DiscoveryError) throw error;
    throw new DiscoveryError(`Model catalog request failed (${safeEndpoint(endpoint)}).`, 'http');
  } finally {
    clearTimeout(timer);
    signal.removeEventListener('abort', onAbort);
  }
}

function mergeRecord<T extends Record<string, unknown> | undefined>(...values: T[]): T | undefined {
  const present = values.filter((value): value is T => value !== undefined && typeof value === 'object' && value !== null && !Array.isArray(value));
  if (present.length === 0) return undefined;
  return Object.assign({}, ...present) as T;
}

function mergeInputLimits(...values: Array<ModelSpec['inputLimits'] | undefined>): ModelSpec['inputLimits'] | undefined {
  const merged = mergeRecord(...values.map(value => value as Record<string, unknown> | undefined));
  const images = mergeRecord(...values.map(value => value?.images as Record<string, unknown> | undefined));
  const resize = mergeRecord(...values.map(value => value?.images?.resize as Record<string, unknown> | undefined));
  if (!merged) return undefined;
  if (images) merged.images = { ...images, ...(resize ? { resize } : {}) };
  return merged as ModelSpec['inputLimits'];
}

function mergeSamplingParamsByThinkingLevel(...values: Array<ModelSpec['samplingParamsByThinkingLevel'] | undefined>): ModelSpec['samplingParamsByThinkingLevel'] | undefined {
  const levels = new Set<string>();
  for (const value of values) for (const level of Object.keys(value ?? {})) levels.add(level);
  if (levels.size === 0) return undefined;
  const merged: Record<string, Record<string, unknown>> = {};
  for (const level of levels) {
    const params = mergeRecord(...values.map(value => value?.[level as keyof NonNullable<ModelSpec['samplingParamsByThinkingLevel']>] as Record<string, unknown> | undefined));
    if (params) merged[level] = params;
  }
  return merged as ModelSpec['samplingParamsByThinkingLevel'];
}

function modelMetadata(value: ModelSpec | undefined): Record<string, unknown> {
  const metadata: Record<string, unknown> = {};
  for (const [name, entry] of Object.entries(value ?? {})) {
    if (/^(?:apiKey|api_key|accessToken|access_token|refreshToken|refresh_token|token|secret|password|credential|authorization)$/i.test(name)) continue;
    metadata[name] = entry;
  }
  return metadata;
}

function mergeSpec(defaults: ModelSpec | undefined, override: ModelSpec | undefined): ModelSpec {
  return {
    ...modelMetadata(defaults),
    ...modelMetadata(override),
    cost: mergeRecord(defaults?.cost as Record<string, unknown> | undefined, override?.cost as Record<string, unknown> | undefined) as ModelSpec['cost'],
    promptCache: mergeRecord(defaults?.promptCache as Record<string, unknown> | undefined, override?.promptCache as Record<string, unknown> | undefined) as ModelSpec['promptCache'],
    compat: mergeRecord(defaults?.compat, override?.compat),
    samplingParams: mergeRecord(defaults?.samplingParams, override?.samplingParams),
    samplingParamsByThinkingLevel: mergeSamplingParamsByThinkingLevel(defaults?.samplingParamsByThinkingLevel, override?.samplingParamsByThinkingLevel),
    inputLimits: mergeInputLimits(defaults?.inputLimits, override?.inputLimits),
    headers: mergeRecord(defaults?.headers, override?.headers) as ModelSpec['headers'],
    thinkingLevelMap: mergeRecord(defaults?.thinkingLevelMap, override?.thinkingLevelMap) as ModelSpec['thinkingLevelMap'],
  };
}

function headerReferenceShape(headers: Record<string, string> | undefined): string[] {
  return Object.entries(headers ?? {})
    .map(([name, value]) => {
      const trimmed = value.trim();
      const exact = ENV_REF.exec(trimmed);
      if (exact) return `${name.toLowerCase()}=env:${exact[1]}`;
      const names = [...trimmed.matchAll(ENV_INTERPOLATION)].map(match => match[1]);
      if (names.length > 0) return `${name.toLowerCase()}=envs:${names.join(',')}`;
      return `${name.toLowerCase()}=${trimmed.startsWith('!') ? 'command' : 'literal'}`;
    })
    .sort((a, b) => a.localeCompare(b));
}

function channelTransportFingerprint(channel: Channel): string {
  const modelHeaders = Object.entries(channel.modelOverrides ?? {})
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([id, spec]) => `${id}:${headerReferenceShape(spec.headers).join('|')}`);
  return JSON.stringify({
    api: channel.api,
    baseUrl: safeEndpoint(channel.baseUrl),
    authHeader: channel.authHeader !== false,
    headers: headerReferenceShape(channel.headers),
    defaults: headerReferenceShape(channel.defaults?.headers),
    modelHeaders,
  });
}

function priorModelFor(priorModels: readonly Model<Api>[], id: string): Model<Api> | undefined {
  return priorModels.find(model => model.id === id);
}

function modelTransportFingerprint(model: Model<Api>): string | undefined {
  const value = (model as HubModel)[MODEL_TRANSPORT_FINGERPRINT];
  return typeof value === 'string' ? value : undefined;
}

export interface BuiltModelResult {
  model: Model<Api>;
  usedFallbackMetadata: boolean;
}

/** Merge a discovered identifier with prior catalog metadata and channel overrides. */
export function buildChannelModel(
  channel: Channel,
  id: string,
  priorModels: readonly Model<Api>[] = [],
  overrideId = id,
): BuiltModelResult {
  const prior = priorModelFor(priorModels, id) ?? priorModelFor(priorModels, overrideId);
  const override = channel.modelOverrides?.[id] ?? channel.modelOverrides?.[overrideId];
  const spec = mergeSpec(channel.defaults, override);
  const contextWindow = spec.contextWindow ?? prior?.contextWindow ?? FALLBACK_MODEL_METADATA.contextWindow;
  const maxTokens = spec.maxTokens ?? prior?.maxTokens ?? FALLBACK_MODEL_METADATA.maxTokens;
  const usedFallbackMetadata = (spec.contextWindow === undefined && prior?.contextWindow === undefined) || (spec.maxTokens === undefined && prior?.maxTokens === undefined);
  const priorCost = prior?.cost;
  const tiers = spec.cost?.tiers ?? priorCost?.tiers;
  const thinkingParams = mergeSamplingParamsByThinkingLevel(prior?.samplingParamsByThinkingLevel, spec.samplingParamsByThinkingLevel);
  const model: HubModel = {
    ...modelMetadata(spec),
    id,
    name: spec.name ?? prior?.name ?? id,
    api: channel.api,
    provider: channel.id,
    baseUrl: channel.baseUrl,
    reasoning: spec.reasoning ?? prior?.reasoning ?? false,
    input: [...(spec.input ?? prior?.input ?? ['text'])],
    cost: {
      input: spec.cost?.input ?? priorCost?.input ?? 0,
      output: spec.cost?.output ?? priorCost?.output ?? 0,
      cacheRead: spec.cost?.cacheRead ?? priorCost?.cacheRead ?? 0,
      cacheWrite: spec.cost?.cacheWrite ?? priorCost?.cacheWrite ?? 0,
      ...(tiers ? { tiers } : {}),
    },
    contextWindow,
    maxTokens,
    inputLimits: spec.inputLimits ?? prior?.inputLimits,
    headers: spec.headers ? { ...spec.headers } : undefined,
    ...(mergeRecord(prior?.thinkingLevelMap, spec.thinkingLevelMap) ? { thinkingLevelMap: mergeRecord(prior?.thinkingLevelMap, spec.thinkingLevelMap) } : {}),
    ...(mergeRecord(prior?.promptCache, spec.promptCache) ? { promptCache: mergeRecord(prior?.promptCache, spec.promptCache) } : {}),
    ...(prior?.compat || spec.compat ? { compat: { ...prior?.compat, ...spec.compat } } : {}),
    ...(mergeRecord(prior?.samplingParams, spec.samplingParams) ? { samplingParams: mergeRecord(prior?.samplingParams, spec.samplingParams) } : {}),
    ...(thinkingParams ? { samplingParamsByThinkingLevel: thinkingParams } : {}),
    [MODEL_TRANSPORT_FINGERPRINT]: channelTransportFingerprint(channel),
  };
  return { model, usedFallbackMetadata };
}

export async function discoverChannelModels(
  channel: Channel,
  options: DiscoveryOptions = {},
): Promise<DiscoveryResult> {
  const signal = options.signal ?? new AbortController().signal;
  throwIfAborted(signal);
  const endpoint = discoveryUrl(channel);
  const credential = options.apiKey;
  if (!credential && channel.authHeader !== false) {
    throw new DiscoveryError('No API key is configured for this channel.', 'auth');
  }
  const type: DiscoveryType = channel.discovery?.type ?? 'openai';
  const discovered = new Set<string>();
  const pageTokens = new Set<string>();
  let pageEndpoint = endpoint;
  for (let page = 0; ; page++) {
    if (page >= 100) throw new DiscoveryError('Model catalog has too many pages.', 'malformed');
    const payload = await fetchCatalog(pageEndpoint, channel, { ...options, signal, apiKey: credential });
    for (const id of extractIds(payload, type, pageEndpoint)) discovered.add(id);
    if (discovered.size > MAX_DISCOVERED_MODELS) throw new DiscoveryError('Model catalog contains too many models.', 'malformed');
    if (typeof payload !== 'object' || payload === null || !('nextPageToken' in payload) || !payload.nextPageToken) break;
    if (typeof payload.nextPageToken !== 'string' || payload.nextPageToken.length > 1024 || UNSAFE_REMOTE_TEXT.test(payload.nextPageToken) || pageTokens.has(payload.nextPageToken)) {
      throw new DiscoveryError('Model catalog returned an invalid pagination token.', 'malformed');
    }
    pageTokens.add(payload.nextPageToken);
    const next = new URL(endpoint);
    next.searchParams.set('pageToken', payload.nextPageToken);
    pageEndpoint = next.toString();
  }
  const ids = [...discovered].sort();
  const priorModels = options.priorModels ?? [];
  const models: Model<Api>[] = [];
  let usedFallbackMetadata = false;
  for (const id of ids) {
    const built = buildChannelModel(channel, id, priorModels);
    models.push(built.model);
    usedFallbackMetadata ||= built.usedFallbackMetadata;
  }
  return { models, endpoint, usedFallbackMetadata };
}

function channelHasExplicitCredential(channel: Channel): boolean {
  return channel.authHeader === false || channel.apiKey.trim().length > 0 || (channel.envVars?.length ?? 0) > 0;
}

type RequestOptionsLike = {
  apiKey?: string;
  headers?: ProviderHeaders;
  signal?: AbortSignal;
  env?: Record<string, string>;
  timeoutMs?: number;
};

function modelForCurrentTransport<T extends Api>(channel: Channel, model: Model<T>): Model<T> {
  return buildChannelModel(channel, model.id, [model]).model as Model<T>;
}

async function prepareRequestModel<T extends Api, TOptions extends RequestOptionsLike>(
  channel: Channel,
  model: Model<T>,
  options: TOptions | undefined,
): Promise<{ model: Model<T>; options: TOptions | undefined }> {
  const rebound = modelForCurrentTransport(channel, model);
  const explicitCredential = channelHasExplicitCredential(channel);
  const staleNames = new Set<string>();
  for (const name of Object.keys(model.headers ?? {})) staleNames.add(name.toLowerCase());
  for (const name of Object.keys(rebound.headers ?? {})) staleNames.add(name.toLowerCase());
  const headers: ProviderHeaders = explicitCredential ? {} : { ...(options?.headers ?? {}) };
  for (const name of Object.keys(headers)) {
    if (staleNames.has(name.toLowerCase())) delete headers[name];
  }
  const channelHeaders = await resolveChannelHeaders(channel, {
    env: options?.env,
    signal: options?.signal,
    timeoutMs: options?.timeoutMs,
  });
  for (const [name, value] of Object.entries(channelHeaders ?? {})) headers[name] = value;
  if (channel.authHeader === false && !hasHeader(channelHeaders, 'authorization')) headers.authorization = null;
  const resolved = await resolveHeaderEntries(rebound.headers ?? {}, {
    env: options?.env,
    signal: options?.signal,
    timeoutMs: options?.timeoutMs,
  });
  for (const [name, value] of Object.entries(resolved ?? {})) headers[name] = value;
  let apiKey = options?.apiKey;
  if (explicitCredential) {
    const current = await resolveChannelCredential(channel, {
      env: options?.env,
      signal: options?.signal,
      timeoutMs: options?.timeoutMs,
    });
    if (!current.key && channel.authHeader !== false) {
      throw new DiscoveryError('No API key is configured for this channel.', 'auth');
    }
    apiKey = current.key;
  }
  const requestModel = { ...rebound, headers: undefined } as Model<T>;
  if (!options && Object.keys(headers).length === 0 && apiKey === undefined) return { model: requestModel, options: undefined };
  return { model: requestModel, options: { ...(options ?? {}), apiKey, headers } as TOptions };
}

function lazyTransportOperation<T extends Api, TOptions extends RequestOptionsLike>(
  channel: Channel,
  model: Model<T>,
  options: TOptions | undefined,
  invoke: (model: Model<T>, options: TOptions | undefined) => AssistantMessageEventStream,
): AssistantMessageEventStream {
  const rebound = modelForCurrentTransport(channel, model);
  return lazyStream(rebound as Model<Api>, async (): Promise<AsyncIterable<AssistantMessageEvent>> => {
    const prepared = await prepareRequestModel(channel, model, options);
    return invoke(prepared.model, prepared.options);
  });
}

function restoredModelsForChannel(
  channel: Channel,
  stored: RefreshModelsContext['stored'],
): { models: Model<Api>[]; invalidated: boolean } {
  const expected = channelTransportFingerprint(channel);
  const restored: Model<Api>[] = [];
  let invalidated = false;
  for (const entry of stored?.models ?? []) {
    if (entry.provider !== channel.id) continue;
    if (('type' in entry && entry.type !== undefined && entry.type !== 'chat') || !entry.id || entry.id.length > 1024 || UNSAFE_REMOTE_TEXT.test(entry.id)) {
      invalidated = true;
      continue;
    }
    const model = entry as Model<Api>;
    const fingerprint = modelTransportFingerprint(model);
    if (fingerprint !== undefined && fingerprint !== expected) {
      invalidated = true;
      continue;
    }
    restored.push(buildChannelModel(channel, model.id, [model]).model);
  }
  return { models: restored, invalidated };
}

/** Build a native pi-ai provider for one channel. */
export function createChannelProvider(channel: Channel, options: ChannelProviderOptions = {}): Provider<Api> {
  const streams = streamFor(channel.api);
  const auth = makeChannelAuth(channel);
  const isCurrent = options.isCurrent ?? (() => true);
  let dynamicModels: Model<Api>[] = [];
  const currentModels = () => dynamicModels.map(model => buildChannelModel(channel, model.id, [model]).model);
  const inner = createProvider<Api>({
    id: channel.id,
    name: channel.name ?? channel.id,
    baseUrl: channel.baseUrl,
    api: streams,
    auth,
    models: [],
  });
  const refreshModels = async (context: RefreshModelsContext): Promise<void> => {
    throwIfAborted(context.signal);
    if (!isCurrent()) throw new DOMException('Provider was superseded.', 'AbortError');
    if (context.stored) {
      const restored = restoredModelsForChannel(channel, context.stored);
      if (!isCurrent()) throw new DOMException('Provider was superseded.', 'AbortError');
      const published = await context.publish(restored.invalidated
        ? { persist: null, update: () => { if (isCurrent()) dynamicModels = []; } }
        : { update: () => { if (isCurrent()) dynamicModels = restored.models; } });
      if (!published) return;
    }
    if (!context.allowNetwork || context.signal.aborted) return;
    if (!isCurrent()) throw new DOMException('Provider was superseded.', 'AbortError');
    const credential = await resolveChannelCredential(channel, {
      credential: context.credential,
      env: process.env,
      signal: context.signal,
      timeoutMs: channel.discovery?.timeoutMs,
    });
    const priorModels = dynamicModels.length > 0 ? dynamicModels : options.priorModels?.() ?? [];
    const result = await discoverChannelModels(channel, {
      apiKey: credential.key,
      env: process.env,
      priorModels,
      signal: context.signal,
    });
    throwIfAborted(context.signal);
    if (!isCurrent()) throw new DOMException('Provider was superseded.', 'AbortError');
    const published = await context.publish({
      persist: { models: result.models, checkedAt: Date.now() },
      update: () => { if (isCurrent()) dynamicModels = result.models; },
    });
    if (published && isCurrent()) options.onDiscovery?.(result);
  };
  const provider: Provider<Api> = {
    ...inner,
    getModels: currentModels,
    getAllModels: currentModels,
    refreshModels,
    stream: <T extends Api>(model: Model<T>, context: TranscriptContext, requestOptions?: ApiStreamOptions<T>) =>
      lazyTransportOperation(channel, model, requestOptions, (requestModel, requestOptions) => inner.stream(requestModel, context, requestOptions)),
    streamSimple: (model: Model<Api>, context: TranscriptContext, requestOptions?: SimpleStreamOptions) =>
      lazyTransportOperation(channel, model, requestOptions, (requestModel, requestOptions) => inner.streamSimple(requestModel, context, requestOptions)),
  };
  if (inner.fetchDeferred) {
    const fetchDeferred = inner.fetchDeferred;
    provider.fetchDeferred = (model: Model<Api>, handle: DeferredHandle, requestOptions?: DeferredFetchOptions) =>
      lazyTransportOperation(channel, model, requestOptions, (requestModel, requestOptions) => fetchDeferred(requestModel, handle, requestOptions));
  }
  if (inner.cancelDeferred) {
    const cancelDeferred = inner.cancelDeferred;
    provider.cancelDeferred = async (model: Model<Api>, handle: DeferredHandle, requestOptions?: DeferredCancelOptions): Promise<void> => {
      const prepared = await prepareRequestModel(channel, model, requestOptions);
      await cancelDeferred(prepared.model, handle, prepared.options);
    };
  }
  return provider;
}


