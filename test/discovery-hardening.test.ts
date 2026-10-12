import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type IncomingMessage, type ServerResponse, type Server } from 'node:http';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { buildChannelModel, createChannelProvider, discoverChannelModels, DiscoveryError, resolveChannelCredential, resolveCommandValue } from '../discovery.ts';
import type { Channel } from '../contracts.ts';
import { createChannelRegistration } from '../registration.ts';
import { createModels, InMemoryModelsStore } from '@earendil-works/pi-ai';
import { ModelRuntime } from '@earendil-works/pi-coding-agent';

async function listen(handler: (request: IncomingMessage, response: ServerResponse) => void | Promise<void>) {
  const server = createServer(handler);
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  return { server, root: `http://127.0.0.1:${address.port}` };
}

async function close(server: Server): Promise<void> {
  server.closeAllConnections();
  await new Promise<void>(resolve => server.close(() => resolve()));
}


test('discovery rejects redirects before an authenticated receiver sees a key', async () => {
  let receivedKey: string | string[] | undefined;
  const receiver = await listen((request, response) => {
    receivedKey = request.headers.authorization;
    response.writeHead(200, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify({ data: [{ id: 'should-not-be-seen' }] }));
  });
  const origin = await listen((_request, response) => {
    response.writeHead(302, { Location: `${receiver.root}/capture` });
    response.end();
  });
  try {
    const channel: Channel = {
      id: 'redirected',
      baseUrl: `${origin.root}/v1`,
      api: 'openai-completions',
      apiKey: 'redirect-secret',
    };
    await assert.rejects(discoverChannelModels(channel, { apiKey: channel.apiKey }), error => {
      assert.ok(error instanceof Error);
      assert.ok(!error.message.includes('redirect-secret'));
      return true;
    });
    assert.equal(receivedKey, undefined);
  } finally {
    await close(origin.server);
    await close(receiver.server);
  }
});

test('discovery rejects C0, DEL, C1, and ESC model identifiers', async () => {
  const server = await listen((_request, response) => {
    response.writeHead(200, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify({ data: [{ id: `unsafe\u001b[31m` }] }));
  });
  try {
    const channel: Channel = {
      id: 'unsafe',
      baseUrl: `${server.root}/v1`,
      api: 'openai-completions',
      apiKey: 'key',
    };
    await assert.rejects(discoverChannelModels(channel, { apiKey: 'key' }), error => {
      assert.ok(error instanceof DiscoveryError);
      assert.equal(error.code, 'malformed');
      assert.ok(!error.message.includes('\u001b'));
      return true;
    });
  } finally {
    await close(server.server);
  }
});

test('configured command failures do not fall through to environment credentials', async () => {
  const channel: Channel = {
    id: 'command-failure',
    baseUrl: 'http://127.0.0.1:1/v1',
    api: 'openai-completions',
    apiKey: process.platform === 'win32' ? '!exit /b 7' : '!exit 7',
    envVars: ['PI_MODEL_HUB_FALLBACK'],
  };
  await assert.rejects(resolveChannelCredential(channel, { env: { PI_MODEL_HUB_FALLBACK: 'fallback' } }), error => {
    assert.ok(error instanceof DiscoveryError);
    assert.equal(error.code, 'command');
    assert.match(error.message, /code 7/);
    assert.ok(!error.message.includes('fallback'));
    return true;
  });
});

test('configured command deadline rejects and cleans up the process tree', async () => {
  const node = process.platform === 'win32' ? `"${process.execPath}"` : JSON.stringify(process.execPath);
  const script = JSON.stringify("process.stdout.write('READY'); require('node:net').createServer().listen(0)");
  await assert.rejects(resolveCommandValue(`!${node} -e ${script}`, { timeoutMs: 250 }), error => {
    assert.ok(error instanceof DiscoveryError);
    assert.equal(error.code, 'timeout', error.message);
    return true;
  });
});

test('model metadata and raw header references survive model construction', () => {
  const channel: Channel = {
    id: 'metadata',
    baseUrl: 'http://127.0.0.1:1/v1',
    api: 'openai-responses',
    apiKey: 'key',
    defaults: {
      name: 'Configured model',
      contextWindow: 32_000,
      maxTokens: 4_000,
      cost: {
        input: 1,
        output: 2,
        cacheRead: 3,
        cacheWrite: 4,
        tiers: [{ inputTokensAbove: 10_000, input: 0.5, output: 1, cacheRead: 1.5, cacheWrite: 2 }],
      },
      inputLimits: { maxRequestBytes: 9_000, images: { maxPerRequest: 2, resize: { maxWidth: 800 } } },
      samplingParamsByThinkingLevel: { low: { temperature: 0.2 }, high: { top_p: 0.8 } },
      headers: { 'x-model-token': '${MODEL_HEADER}' },
      maxbody: 12_345,
    },
  };
  const model = buildChannelModel(channel, 'configured').model;
  assert.equal(model.name, 'Configured model');
  assert.deepEqual(model.cost.tiers, channel.defaults?.cost?.tiers);
  assert.deepEqual(model.inputLimits, channel.defaults?.inputLimits);
  assert.deepEqual(model.samplingParamsByThinkingLevel, channel.defaults?.samplingParamsByThinkingLevel);
  assert.deepEqual(model.headers, channel.defaults?.headers);
  assert.equal((model as unknown as Record<string, unknown>).maxbody, 12_345);
  assert.ok(!JSON.stringify(model).includes('MODEL_HEADER_VALUE'));
});

test('managed transport overrides stale models.json URL, key, and headers for old model objects', async () => {
  const requests: Array<{ path: string; auth: string | undefined; oldHeader: string | undefined }> = [];
  const server = await listen((request, response) => {
    const path = request.url ?? '';
    requests.push({ path, auth: request.headers.authorization, oldHeader: request.headers['x-old-header'] as string | undefined });
    if (path === '/b/v1/chat/completions') {
      response.writeHead(200, { 'Content-Type': 'text/event-stream' });
      response.end('data: {"choices":[{"delta":{"content":"managed"},"finish_reason":null}]}\n\ndata: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n');
      return;
    }
    response.writeHead(404).end();
  });
  const directory = await mkdtemp(join(tmpdir(), 'pi-provider-deck-discovery-'));
  const modelsPath = join(directory, 'models.json');
  await writeFile(modelsPath, JSON.stringify({ providers: {
    switch: {
      baseUrl: `${server.root}/a/v1`,
      api: 'openai-completions',
      apiKey: 'keyOLD',
      headers: { 'x-old-header': 'old-secret' },
      models: [{ id: 'managed-model', name: 'stale model', contextWindow: 8_192, maxTokens: 1_024 }],
    },
  } }));
  const channel: Channel = { id: 'switch', baseUrl: `${server.root}/b/v1`, api: 'openai-completions', apiKey: 'keyNEW' };
  try {
    const runtime = await ModelRuntime.create({ modelsPath, refreshOnCreate: false, allowModelNetwork: false });
    const sourceModel = runtime.getModel('switch', 'managed-model');
    assert.ok(sourceModel);
    const oldChannel: Channel = { ...channel, baseUrl: `${server.root}/a/v1`, apiKey: 'keyOLD' };
    runtime.registerProvider('switch', createChannelRegistration(oldChannel, createChannelProvider(oldChannel), [sourceModel]));
    const staleModel = runtime.getModel('switch', 'managed-model');
    assert.ok(staleModel);
    runtime.unregisterProvider('switch');
    runtime.registerProvider('switch', createChannelRegistration(channel, createChannelProvider(channel), [sourceModel]));
    const completion = await runtime.completeSimple(staleModel, { messages: [{ role: 'user', content: 'probe', timestamp: Date.now() }] });
    const generation = requests.find(request => request.path === '/b/v1/chat/completions');
    assert.ok(generation, JSON.stringify({ requests, finishReason: completion.stopReason, error: completion.errorMessage }));
    assert.equal(generation.auth, 'Bearer keyNEW');
    assert.equal(generation.oldHeader, undefined);
    assert.equal(requests.some(request => request.path === '/a/v1/chat/completions'), false);
  } finally {
    await close(server.server);
    await rm(directory, { recursive: true, force: true });
  }
});

test('cache restoration invalidates changed transport and old sessions dispatch only through current transport', async () => {
  const requests: Array<{ path: string; auth: string | undefined }> = [];
  let bCatalogStatus = 200;
  const server = await listen((request, response) => {
    const path = request.url ?? '';
    requests.push({ path, auth: request.headers.authorization });
    if (path === '/a/v1/models') {
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({ data: [{ id: 'cached-model' }] }));
      return;
    }
    if (path === '/b/v1/models') {
      response.writeHead(bCatalogStatus, { 'Content-Type': 'application/json' });
      response.end(bCatalogStatus === 200 ? JSON.stringify({ data: [{ id: 'cached-model' }] }) : '{"error":"catalog unavailable"}');
      return;
    }
    if (path === '/b/v1/chat/completions') {
      response.writeHead(200, { 'Content-Type': 'text/event-stream' });
      response.end('data: {"choices":[{"delta":{"content":"ok"},"finish_reason":null}]}\n\ndata: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n');
      return;
    }
    response.writeHead(404).end();
  });
  const store = new InMemoryModelsStore();
  const root = server.root;
  const channelA: Channel = { id: 'switch', baseUrl: `${root}/a/v1`, api: 'openai-completions', apiKey: 'keyOLD' };
  const channelB: Channel = { id: 'switch', baseUrl: `${root}/b/v1`, api: 'openai-completions', apiKey: 'keyNEW' };
  try {
    
  const runtimeA = createModels({ modelsStore: store });
  const providerA = createChannelProvider(channelA);
  runtimeA.setProvider(providerA);
  const first = await runtimeA.refresh({ providers: ['switch'], allowNetwork: true, force: true });
  assert.equal(first.errors.size, 0);
  const oldModel = runtimeA.getModel('switch', 'cached-model');
  assert.ok(oldModel);
  assert.equal(oldModel.baseUrl, channelA.baseUrl);
  const cached = await store.read('switch');
  assert.ok(cached);
  assert.ok(!JSON.stringify(cached).includes('keyOLD'));

  const runtimeSame = createModels({ modelsStore: store });
  runtimeSame.setProvider(createChannelProvider(channelA));
  await runtimeSame.refresh({ providers: ['switch'], allowNetwork: false, force: true });
  assert.ok(runtimeSame.getModel('switch', 'cached-model'));

  const runtimeB = createModels({ modelsStore: store });
  runtimeB.setProvider(createChannelProvider(channelB));
  await runtimeB.refresh({ providers: ['switch'], allowNetwork: false, force: true });
  assert.equal(runtimeB.getModel('switch', 'cached-model'), undefined);
  assert.equal(await store.read('switch'), undefined);

  bCatalogStatus = 503;
  const failed = await runtimeB.refresh({ providers: ['switch'], allowNetwork: true, force: true });
  assert.ok(failed.errors.has('switch'));
  assert.equal(runtimeB.getModel('switch', 'cached-model'), undefined);
  assert.ok(oldModel);
  await runtimeB.completeSimple(oldModel, { messages: [{ role: 'user', content: 'probe', timestamp: Date.now() }] });
  const generation = requests.find(request => request.path === '/b/v1/chat/completions');
  assert.ok(generation);
  assert.equal(generation.auth, 'Bearer keyNEW');
  assert.equal(requests.some(request => request.path === '/a/v1/chat/completions'), false);
  } finally {
    await close(server.server);
  }
});
