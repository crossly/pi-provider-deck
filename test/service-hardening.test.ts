import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager, type ExtensionContext } from '@earendil-works/pi-coding-agent';
import type { Channel, HubService } from '../contracts.ts';
import { withConfigLock } from '../config-store.ts';
import { createHubService } from '../service.ts';

interface Catalog {
  hits: number;
  gate?: Promise<void>;
  received?: PromiseWithResolvers<void>;
}

interface Fixture {
  dir: string;
  configPath: string;
  endpoint: string;
  catalogs: Record<string, Catalog>;
  active: number;
  maxActive: number;
  service: HubService;
  ctx: ExtensionContext;
  runtime: ModelRuntime;
  close: () => Promise<void>;
}

async function startFixture(ids: readonly string[]): Promise<Fixture> {
  const dir = await mkdtemp(join(tmpdir(), 'pi-hub-hardening-'));
  const catalogs: Record<string, Catalog> = Object.fromEntries(ids.map(id => [id, { hits: 0 }]));
  let active = 0;
  let maxActive = 0;
  const server = createServer(async (req, res) => {
    const id = req.url?.split('/')[1] ?? '';
    const catalog = catalogs[id];
    if (!catalog) {
      res.writeHead(404).end();
      return;
    }
    active += 1;
    maxActive = Math.max(maxActive, active);
    catalog.hits += 1;
    catalog.received?.resolve();
    try {
      if (catalog.gate) await catalog.gate;
      if (res.destroyed) return;
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ data: [{ id: `${id}-model` }] }));
    } finally {
      active -= 1;
    }
  });
  const listening = Promise.withResolvers<void>();
  server.listen(0, '127.0.0.1', () => listening.resolve());
  await listening.promise;
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const endpoint = `http://127.0.0.1:${address.port}`;
  const configPath = join(dir, 'models.json');
  const channels: Channel[] = ids.map(id => ({
    id,
    baseUrl: `${endpoint}/${id}/v1`,
    api: 'openai-completions',
    apiKey: 'hardening-key',
    defaults: { contextWindow: 32768, maxTokens: 4096 },
  }));
  await writeFile(configPath, JSON.stringify({ providers: Object.fromEntries(channels.map(c => [c.id, { ...c, piProviderDeck: { managed: true } }])) }, null, 2), { mode: 0o600 });
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
  const service = holder.service;
  const ctx = holder.ctx;
  return {
    dir,
    configPath,
    endpoint,
    catalogs,
    get active() { return active; },
    get maxActive() { return maxActive; },
    service,
    ctx,
    runtime,
    async close() {
      service.dispose();
      session.dispose();
      await runtime.refresh({ allowNetwork: false });
      for (const catalog of Object.values(catalogs)) catalog.received = undefined;
      server.closeAllConnections();
      const closed = Promise.withResolvers<void>();
      server.close(() => closed.resolve());
      await closed.promise;
      await rm(dir, { recursive: true, force: true });
    },
  };
}

test('refresh jobs share one global four-slot budget and queued cancellation does not dispatch', async () => {
  const fixture = await startFixture(['a', 'b', 'c', 'd', 'e', 'f']);
  try {
    const firstGate = Promise.withResolvers<void>();
    const firstReceived = ['a', 'b', 'c', 'd'].map(id => {
      fixture.catalogs[id].gate = firstGate.promise;
      fixture.catalogs[id].received = Promise.withResolvers<void>();
      return fixture.catalogs[id].received?.promise as Promise<void>;
    });
    const first = fixture.service.refresh(fixture.ctx, ['a', 'b', 'c', 'd']);
    await Promise.all(firstReceived);

    const secondAbort = new AbortController();
    const second = fixture.service.refresh(fixture.ctx, ['e', 'f'], secondAbort.signal);
    secondAbort.abort();
    const secondSummary = await second;
    assert.deepEqual(secondSummary.results.map(row => row.status), ['cancelled', 'cancelled']);
    assert.equal(fixture.catalogs.e.hits, 0);
    assert.equal(fixture.catalogs.f.hits, 0);

    firstGate.resolve();
    const firstSummary = await first;
    assert.ok(firstSummary.results.every(row => row.status === 'success'));
    assert.ok(fixture.maxActive <= 4);
  } finally {
    await fixture.close();
  }
});

test('one cancelled refresh waiter does not abort another waiter for the same generation', async () => {
  const fixture = await startFixture(['shared']);
  try {
    const catalog = fixture.catalogs.shared;
    const gate = Promise.withResolvers<void>();
    catalog.gate = gate.promise;
    catalog.received = Promise.withResolvers<void>();
    const firstAbort = new AbortController();
    const secondAbort = new AbortController();
    const first = fixture.service.refresh(fixture.ctx, ['shared'], firstAbort.signal);
    await catalog.received.promise;
    const second = fixture.service.refresh(fixture.ctx, ['shared'], secondAbort.signal);
    firstAbort.abort();
    const firstSummary = await first;
    assert.equal(firstSummary.results[0]?.status, 'cancelled');
    gate.resolve();
    const secondSummary = await second;
    assert.equal(secondSummary.results[0]?.status, 'success');
    assert.equal(catalog.hits, 1);
  } finally {
    await fixture.close();
  }
});

test('disposing while a transaction waits for the file lock never registers the pending channel', async () => {
  const fixture = await startFixture(['existing']);
  try {
    const lockEntered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const lock = withConfigLock(fixture.configPath, async () => {
      lockEntered.resolve();
      await release.promise;
    });
    await lockEntered.promise;
    const pending = fixture.service.upsert({
      id: 'pending',
      baseUrl: fixture.endpoint,
      api: 'openai-completions',
      apiKey: 'pending-key',
    }, fixture.ctx);
    fixture.service.dispose();
    release.resolve();
    await assert.rejects(pending, /disposed/i);
    await lock;
    assert.equal(fixture.runtime.getProvider('pending'), undefined);
    const stored = JSON.parse(await readFile(fixture.configPath, 'utf8')) as { providers: Record<string, unknown> };
    assert.ok(!('pending' in stored.providers));
  } finally {
    await fixture.close();
  }
});

test('channel removal followed by sync leaves no stale native provider registration', async () => {
  const fixture = await startFixture(['existing']);
  try {
    await fixture.service.upsert({
      id: 'removed',
      baseUrl: fixture.endpoint,
      api: 'openai-completions',
      apiKey: 'removed-key',
    }, fixture.ctx);
    assert.ok(fixture.runtime.getProvider('removed'));
    await fixture.service.remove('removed', fixture.ctx);
    await fixture.service.sync(fixture.ctx);
    assert.equal(fixture.runtime.getProvider('removed'), undefined);
    assert.ok(!fixture.service.snapshot(fixture.ctx).some(row => row.id === 'removed'));
  } finally {
    await fixture.close();
  }
});
