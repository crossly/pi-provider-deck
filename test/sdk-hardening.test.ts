import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager, type ExtensionContext, type AgentSession } from '@earendil-works/pi-coding-agent';
import { createProviderDeck } from '../index.ts';
import { notify } from '../terminal.ts';

test('SDK factory uses explicitly supplied agentDir without changing the process config directory', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'pi-deck-sdk-'));
  const server = createServer((_request, response) => response.writeHead(200, { 'Content-Type': 'application/json' }).end('{"data":[{"id":"sdk-model"}]}'));
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  const configPath = join(dir, 'models.json');
  await writeFile(configPath, JSON.stringify({ providers: { 'sdk-private': { id: 'sdk-private', baseUrl: `http://127.0.0.1:${address.port}/v1`, api: 'openai-completions', apiKey: 'sdk-fixture-key', piProviderDeck: { managed: true } } } }));
  let session: AgentSession | undefined;
  let context: ExtensionContext | undefined;
  try {
    const settingsManager = SettingsManager.inMemory({});
    const resourceLoader = new DefaultResourceLoader({ cwd: dir, agentDir: dir, settingsManager, noExtensions: true, noSkills: true, noThemes: true, noPromptTemplates: true, noContextFiles: true,
      extensionFactories: [createProviderDeck({ agentDir: dir }), pi => { pi.on('session_start', (_event, ctx) => { context = ctx; }); }],
    });
    await resourceLoader.reload();
    const modelRuntime = await ModelRuntime.create({ authPath: join(dir, 'auth.json'), modelsPath: join(dir, 'models.json'), modelsStorePath: join(dir, 'store.json'), allowModelNetwork: false, refreshOnCreate: false });
    ({ session } = await createAgentSession({ cwd: dir, agentDir: dir, modelRuntime, resourceLoader, settingsManager, sessionManager: SessionManager.inMemory(dir) }));
    await session.bindExtensions({});
    await session.prompt('/models-refresh sdk-private');
    assert.equal(modelRuntime.getModel('sdk-private', 'sdk-model')?.id, 'sdk-model');
    assert.deepEqual(modelRuntime.getRegisteredProviderIds(), ['sdk-private']);
    assert.equal(Object.keys(JSON.parse(await readFile(configPath, 'utf8')).providers)[0], 'sdk-private');
    assert.ok(context);
    const messages: string[] = [];
    const dbgErrors: string[] = [];
    context.ui.notify = message => { messages.push(message); dbgErrors.push(String(message)); };
    notify(context, 'model-\u001b]52;c;cHJvYmU=\u0007\u009b31m\nsecond line');
    assert.equal(messages.length, 1);
    assert.ok(!/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/.test(messages[0]));
    assert.ok(messages[0].includes('\nsecond line'));
    await writeFile(configPath, '{"providers":{}}');
    await session.reload();
    await modelRuntime.refresh({ allowNetwork: false });
    assert.equal(modelRuntime.getProvider('sdk-private'), undefined);
    assert.deepEqual(modelRuntime.getRegisteredProviderIds(), []);
  } finally {
    session?.dispose(); server.closeAllConnections();
    await session?.modelRuntime.refresh({ allowNetwork: false });
    await new Promise<void>(resolve => server.close(() => resolve()));
    await rm(dir, { recursive: true, force: true });
  }
});
