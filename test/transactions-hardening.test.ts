import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager, type ExtensionContext } from '@earendil-works/pi-coding-agent';
import type { Channel, HubService } from '../contracts.ts';
import { createHubService } from '../service.ts';

interface RunningService {
  service: HubService;
  ctx: ExtensionContext;
  runtime: ModelRuntime;
  session: { dispose: () => void };
  close: () => Promise<void>;
}

async function startService(configPath: string, dir: string): Promise<RunningService> {
  const holder: { service?: HubService; ctx?: ExtensionContext } = {};
  const settingsManager = SettingsManager.inMemory({});
  const loader = new DefaultResourceLoader({
    cwd: dir,
    agentDir: dir,
    settingsManager,
    noExtensions: true,
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
    extensionFactories: [pi => {
      holder.service = createHubService(pi, configPath);
      pi.on('session_start', async (_event, ctx) => {
        holder.ctx = ctx;
        await holder.service?.sync(ctx);
      });
    }],
  });
  await loader.reload();
  const runtime = await ModelRuntime.create({
    authPath: join(dir, 'auth.json'),
    modelsPath: join(dir, 'models.json'),
    modelsStorePath: join(dir, 'store.json'),
    allowModelNetwork: false,
    refreshOnCreate: false,
  });
  const { session } = await createAgentSession({
    cwd: dir,
    agentDir: dir,
    modelRuntime: runtime,
    resourceLoader: loader,
    settingsManager,
    sessionManager: SessionManager.inMemory(dir),
  });
  await session.bindExtensions({});
  assert.ok(holder.service && holder.ctx);
  return {
    service: holder.service,
    ctx: holder.ctx,
    runtime,
    session,
    async close() {
      holder.service?.dispose();
      session.dispose();
      await runtime.refresh({ allowNetwork: false });
    },
  };
}

test('cross-process-style transactions merge latest channels and preserve unknown root and nested metadata', async () => {
  const rootDir = await mkdtemp(join(tmpdir(), 'pi-hub-transactions-'));
  const serviceOneDir = await mkdtemp(join(rootDir, 'one-'));
  const serviceTwoDir = await mkdtemp(join(rootDir, 'two-'));
  const configPath = join(rootDir, 'models.json');
  const serverReady = Promise.withResolvers<void>();
  const server = createServer((_req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ data: [] }));
  });
  server.listen(0, '127.0.0.1', () => serverReady.resolve());
  await serverReady.promise;
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const endpoint = `http://127.0.0.1:${address.port}`;
  const alpha: Channel = {
    id: 'alpha',
    baseUrl: `${endpoint}/alpha/v1`,
    api: 'openai-completions',
    apiKey: 'alpha-key',
    defaults: {
      contextWindow: 32768,
      maxTokens: 4096,
      futureModelMetadata: { owner: 'external', revision: 7 },
    },
    discovery: { type: 'openai', futureDiscoveryMetadata: { source: 'operator' } },
  };
  const beta: Channel = { id: 'beta', baseUrl: `${endpoint}/beta/v1`, api: 'openai-completions', apiKey: 'beta-key' };
  const gamma: Channel = { id: 'gamma', baseUrl: `${endpoint}/gamma/v1`, api: 'openai-completions', apiKey: 'gamma-key' };
  const delta: Channel = { id: 'delta', baseUrl: `${endpoint}/delta/v1`, api: 'openai-completions', apiKey: 'delta-key' };
  const epsilon: Channel = { id: 'epsilon', baseUrl: `${endpoint}/epsilon/v1`, api: 'openai-completions', apiKey: 'epsilon-key' };
  await writeFile(configPath, JSON.stringify({ rootMarker: { owner: 'initial' }, providers: { [alpha.id]: { ...alpha, piProviderDeck: { managed: true } } } }, null, 2), { mode: 0o600 });
  const first = await startService(configPath, serviceOneDir);
  const second = await startService(configPath, serviceTwoDir);
  try {
    await second.service.upsert(beta, second.ctx);
    await first.service.upsert(gamma, first.ctx);
    const merged = JSON.parse(await readFile(configPath, 'utf8')) as { rootMarker: { owner: string }; providers: Record<string, Channel & { futureChannelMetadata?: unknown }> };
    assert.equal(merged.rootMarker.owner, 'initial');
    assert.deepEqual(Object.keys(merged.providers).sort(), ['alpha', 'beta', 'gamma']);
    const mergedAlpha = merged.providers.alpha;
    assert.deepEqual(mergedAlpha?.defaults?.futureModelMetadata, { owner: 'external', revision: 7 });
    assert.deepEqual(mergedAlpha?.discovery?.futureDiscoveryMetadata, { source: 'operator' });

    await Promise.all([first.service.upsert(delta, first.ctx), second.service.upsert(epsilon, second.ctx)]);
    const afterConcurrent = JSON.parse(await readFile(configPath, 'utf8')) as { providers: Record<string, Channel> };
    assert.deepEqual(Object.keys(afterConcurrent.providers).sort(), ['alpha', 'beta', 'delta', 'epsilon', 'gamma']);

    const staleAlpha = first.service.channels().find(channel => channel.id === 'alpha');
    assert.ok(staleAlpha);
    const firstConflict = first.service.upsert({ ...staleAlpha, name: 'first edit' }, first.ctx);
    const secondConflict = second.service.upsert({ ...alpha, name: 'second edit' }, second.ctx);
    const conflictResults = await Promise.allSettled([firstConflict, secondConflict]);
    assert.equal(conflictResults.filter(result => result.status === 'rejected').length, 1);
    const afterConflict = JSON.parse(await readFile(configPath, 'utf8')) as { providers: Record<string, Channel & { defaults?: Record<string, unknown> }> };
    const conflictAlpha = afterConflict.providers.alpha;
    assert.ok(conflictAlpha?.name === 'first edit' || conflictAlpha?.name === 'second edit');
    assert.deepEqual(conflictAlpha?.defaults?.futureModelMetadata, { owner: 'external', revision: 7 });

    await Promise.all([first.service.sync(first.ctx), second.service.upsert({ id: 'zeta', baseUrl: `${endpoint}/zeta/v1`, api: 'openai-completions', apiKey: 'zeta-key' }, second.ctx)]);
    const afterSyncRace = JSON.parse(await readFile(configPath, 'utf8')) as { providers: Record<string, Channel> };
    assert.ok('zeta' in afterSyncRace.providers);
  } finally {
    await first.close();
    await second.close();
    server.closeAllConnections();
    const closed = Promise.withResolvers<void>();
    server.close(() => closed.resolve());
    await closed.promise;
    await rm(rootDir, { recursive: true, force: true });
    await rm(serviceOneDir, { recursive: true, force: true });
    await rm(serviceTwoDir, { recursive: true, force: true });
  }
});
