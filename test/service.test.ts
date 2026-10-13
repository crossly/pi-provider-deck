import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager, type ExtensionContext } from '@earendil-works/pi-coding-agent';
import type { Channel, HubService } from '../contracts.ts';
import { createHubService } from '../service.ts';

interface Catalog {
  ids: string[];
  status: number;
  gate?: PromiseWithResolvers<void>;
  received?: PromiseWithResolvers<void>;
  hits: number;
  auth?: string;
  malformed?: boolean;
}
async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), 'pi-hub-test-'));
  const catalogs: Record<string, Catalog> = {
    alpha: { ids: ['one', 'two'], status: 200, hits: 0 },
    beta: { ids: ['three'], status: 200, hits: 0 },
  };
  const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    const id = req.url?.split('/')[1];
    const catalog = id ? catalogs[id] : undefined;
    if (!catalog) { res.writeHead(404).end(); return; }
    catalog.hits++;
    catalog.auth = req.headers.authorization;
    catalog.received?.resolve();
    await catalog.gate?.promise;
    if (res.destroyed) return;
    res.writeHead(catalog.status, { 'Content-Type': 'application/json' });
    res.end(catalog.malformed ? JSON.stringify({ unexpected: 'payload' }) : JSON.stringify({ data: catalog.ids.map(id => ({ id })) }));
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const endpoint = `http://127.0.0.1:${address.port}`;
  const configPath = join(dir, 'models.json');
  const channels: Channel[] = ['alpha', 'beta'].map(id => ({
    id, baseUrl: `${endpoint}/${id}/v1`, api: 'openai-completions', apiKey: 'probe-key',
    defaults: { contextWindow: 32768, maxTokens: 4096 },
  }));
  await writeFile(configPath, JSON.stringify({ providers: Object.fromEntries(channels.map(c => [c.id, { ...c, piProviderDeck: { managed: true } }])) }), { mode: 0o600 });
  const settingsManager = SettingsManager.inMemory({});
  const holder: { service?: HubService; ctx?: ExtensionContext } = {};
  const loader = new DefaultResourceLoader({
    cwd: dir, agentDir: dir, settingsManager, noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
    extensionFactories: [pi => {
      holder.service = createHubService(pi, configPath);
      pi.on('session_start', async (_event, ctx) => {
        holder.ctx = ctx;
        await holder.service?.sync(ctx);
      });
    }],
  });
  await loader.reload();
  const runtime = await ModelRuntime.create({ authPath: join(dir, 'auth.json'), modelsPath: join(dir, 'models.json'), modelsStorePath: join(dir, 'store.json'), allowModelNetwork: false, refreshOnCreate: false });
  const { session } = await createAgentSession({ cwd: dir, agentDir: dir, modelRuntime: runtime, resourceLoader: loader, settingsManager, sessionManager: SessionManager.inMemory(dir) });
  await session.bindExtensions({});
  assert.ok(holder.service);
  assert.ok(holder.ctx);
  const service = holder.service;
  const ctx = holder.ctx;
  return {
    service, ctx, catalogs, channels, configPath, runtime, endpoint,
    ids(id: string) { return service.snapshot(ctx).find(row => row.id === id)?.models.map(model => model.id).sort(); },
    async close() {
      service.dispose(); session.dispose();
      await runtime.refresh({ allowNetwork: false });
      for (const catalog of Object.values(catalogs)) catalog.gate?.resolve();
      server.closeAllConnections();
      await new Promise<void>(resolve => server.close(() => resolve()));
      await rm(dir, { recursive: true, force: true });
    },
  };
}

test('batch catalogs isolate failures and replace authoritative lists including empty lists', async () => {
  const f = await fixture();
  try {
    await f.service.refresh(f.ctx, ['alpha', 'beta']);
    assert.deepEqual(f.ids('alpha'), ['one', 'two']);
    assert.deepEqual(f.ids('beta'), ['three']);
    const a = f.catalogs.alpha; const b = f.catalogs.beta;
    assert.ok(a && b);
    a.ids = ['new', 'new']; b.status = 503;
    const partial = await f.service.refresh(f.ctx, ['alpha', 'beta']);
    assert.deepEqual(f.ids('alpha'), ['new']);
    assert.deepEqual(f.ids('beta'), ['three']);
    assert.equal(partial.results.find(row => row.id === 'beta')?.status, 'error');
    a.ids = [];
    await f.service.refresh(f.ctx, ['alpha']);
    assert.deepEqual(f.ids('alpha'), []);
    assert.equal(a.auth, 'Bearer probe-key');
  } finally { await f.close(); }
});

test('malformed, timed out and cancelled refreshes retain the last usable catalog', async () => {
  const f = await fixture();
  try {
    await f.service.refresh(f.ctx, ['alpha']);
    const catalog = f.catalogs.alpha;
    catalog.malformed = true;
    await f.service.refresh(f.ctx, ['alpha']);
    assert.deepEqual(f.ids('alpha'), ['one', 'two']);
    catalog.malformed = false;
    catalog.gate = Promise.withResolvers<void>();
    // This integration deliberately exercises AbortSignal's real network deadline,
    // not a debounce delay; the server stays gated until the client times out.
    const channel = f.channels[0];
    await f.service.upsert({ ...channel, discovery: { type: 'openai', timeoutMs: 100 } }, f.ctx);
    const timeout = await f.service.refresh(f.ctx, ['alpha']);
    assert.ok(['error', 'cancelled'].includes(timeout.results[0].status));
    assert.deepEqual(f.ids('alpha'), ['one', 'two']);
    const abort = new AbortController(); abort.abort();
    await f.service.refresh(f.ctx, ['alpha'], abort.signal);
    assert.deepEqual(f.ids('alpha'), ['one', 'two']);
  } finally { await f.close(); }
});

test('overlapping refresh requests share one provider probe', async () => {
  const f = await fixture();
  try {
    const a = f.catalogs.alpha;
    a.gate = Promise.withResolvers<void>();
    a.received = Promise.withResolvers<void>();
    const before = a.hits;
    const first = f.service.refresh(f.ctx, ['alpha']);
    await a.received.promise;
    const second = f.service.refresh(f.ctx, ['alpha']);
    a.gate.resolve();
    await Promise.all([first, second]);
    assert.equal(a.hits - before, 1);
    assert.deepEqual(f.ids('alpha'), ['one', 'two']);
  } finally { await f.close(); }
});

test('config reload adds/removes owned providers and preserves independent registry models', async () => {
  const f = await fixture();
  try {
    const builtinBefore = f.runtime.getModel('openai', 'gpt-4o');
    await f.service.refresh(f.ctx, ['alpha', 'beta']);
    await f.service.remove('beta', f.ctx);
    assert.ok(!f.service.channels().some(row => row.id === 'beta'));
    assert.equal(f.runtime.getProvider('beta'), undefined);
    const config = JSON.parse(await readFile(f.configPath, 'utf8'));
    assert.equal(Object.keys(config.providers).length, 1);
    await f.service.upsert(f.channels[1], f.ctx);
    await f.service.refresh(f.ctx, ['beta']);
    assert.deepEqual(f.ids('beta'), ['three']);
    assert.equal(f.runtime.getModel('openai', 'gpt-4o')?.id, builtinBefore?.id);
    await writeFile(f.configPath, '{bad json');
    await assert.rejects(f.service.sync(f.ctx));
    assert.deepEqual(f.ids('beta'), ['three']);
  } finally { await f.close(); }
});

test('a superseded refresh cannot overwrite a new endpoint catalog or leave it busy', async () => {
  const f = await fixture();
  try {
    await f.service.refresh(f.ctx, ['alpha']);
    const oldCatalog = f.catalogs.alpha;
    oldCatalog.gate = Promise.withResolvers<void>();
    oldCatalog.received = Promise.withResolvers<void>();
    const stale = f.service.refresh(f.ctx, ['alpha']);
    await oldCatalog.received.promise;
    await f.service.upsert({ ...f.channels[0], baseUrl: `${f.endpoint}/beta/v1` }, f.ctx);
    await f.service.refresh(f.ctx, ['alpha']);
    oldCatalog.gate.resolve();
    await stale;
    assert.deepEqual(f.ids('alpha'), ['three']);
    const row = f.service.snapshot(f.ctx).find(row => row.id === 'alpha');
    assert.ok(row);
    assert.equal(row.status, 'success');
    assert.equal(row.models[0].baseUrl, `${f.endpoint}/beta/v1`);
  } finally { await f.close(); }
});

test('the hub lists configured channels, not the unconfigured builtin catalog', async () => {
  const f = await fixture();
  try {
    const builtin = f.runtime.getProvider('anthropic');
    assert.ok(builtin);
    f.runtime.registerProvider('inactive-extension', { baseUrl: 'http://127.0.0.1:1/v1', api: 'openai-completions', apiKey: '$PI_HUB_INTENTIONALLY_MISSING_KEY', models: [] });
    await f.runtime.refresh({ allowNetwork: false, providers: ['inactive-extension'] });
    const visible = f.service.snapshot(f.ctx);
    assert.ok(visible.some(row => row.id === 'alpha') && visible.some(row => row.id === 'beta'));
    assert.ok(visible.every(row => row.managed || row.configured));
    assert.ok(!visible.some(row => row.id === 'inactive-extension'));
    // A newly added channel with unresolved auth still needs a visible edit/delete path.
    await f.service.upsert({ ...f.channels[0], id: 'needs-auth', apiKey: '$PI_HUB_INTENTIONALLY_MISSING_KEY' }, f.ctx);
    assert.ok(f.service.snapshot(f.ctx).some(row => row.id === 'needs-auth' && row.managed));
  } finally { await f.close(); }
});

test('removing a configured native provider hides it persistently without deleting authentication', async () => {
  const f = await fixture();
  try {
    await f.runtime.setRuntimeApiKey('openai', 'native-probe-key');
    await f.runtime.refresh({ allowNetwork: false, providers: ['openai'] });
    assert.ok(f.service.snapshot(f.ctx).some(row => row.id === 'openai'));
    await f.service.remove('openai', f.ctx);
    await f.service.sync(f.ctx);
    assert.ok(!f.service.snapshot(f.ctx).some(row => row.id === 'openai'));
    const persisted = JSON.parse(await readFile(f.configPath, 'utf8'));
    assert.equal(persisted.providers.openai.piProviderDeck.hidden, true);
    assert.ok(f.runtime.getProvider('openai'));
    assert.equal((await f.runtime.getAuth('openai'))?.auth.apiKey, 'native-probe-key');
  } finally { await f.close(); }
});

test('removed channels do not reappear from models.json static fallback', async () => {
  const f = await fixture();
  try {
    const existing = JSON.parse(await readFile(f.configPath, 'utf8'));
    existing.providers.beta = { baseUrl: f.channels[1].baseUrl, api: 'openai-completions', apiKey: 'probe-key', models: [{ id: 'static-beta' }] };
    await writeFile(f.configPath, JSON.stringify(existing));
    await f.runtime.refresh({ allowNetwork: false });
    await f.service.remove('beta', f.ctx);
    await f.service.sync(f.ctx);
    assert.ok(!f.service.snapshot(f.ctx).some(row => row.id === 'beta'));
    // Deleting a hub entry must not delete independently owned config or credentials.
    const nativeConfig = JSON.parse(await readFile(f.configPath, 'utf8'));
    assert.equal(nativeConfig.providers.beta.models[0].id, 'static-beta');
    await f.service.upsert(f.channels[1], f.ctx);
    assert.ok(f.service.snapshot(f.ctx).some(row => row.id === 'beta'));
  } finally { await f.close(); }
});

test('a successful refresh persists discovered models into models.json', async () => {
  const f = await fixture();
  try {
    const summary = await f.service.refresh(f.ctx, ['alpha']);
    assert.equal(summary.results[0]?.status, 'success');
    const persisted = JSON.parse(await readFile(f.configPath, 'utf8'));
    const discovered = persisted.providers.alpha.models.map((model: { id: string }) => model.id).sort();
    assert.deepEqual(discovered, ['one', 'two']);
    assert.equal(persisted.providers.alpha.models[0].provider, undefined, 'transport fields must not be persisted');
    assert.equal(persisted.providers.alpha.piProviderDeck.managed, true);
  } finally { await f.close(); }
});
