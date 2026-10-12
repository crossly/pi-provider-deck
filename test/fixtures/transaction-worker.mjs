import { join } from 'node:path';
import { createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager } from '@earendil-works/pi-coding-agent';
import { createHubService } from '../../service.ts';
const [configPath, dir, id] = process.argv.slice(2);
let service;
let context;
let session;
try {
  const settingsManager = SettingsManager.inMemory({});
  const loader = new DefaultResourceLoader({ cwd: dir, agentDir: dir, settingsManager, noExtensions: true, noSkills: true, noThemes: true, noPromptTemplates: true, noContextFiles: true,
    extensionFactories: [pi => {
      service = createHubService(pi, configPath);
      pi.on('session_start', async (_event, ctx) => { context = ctx; await service.sync(ctx); });
    }],
  });
  await loader.reload();
  const runtime = await ModelRuntime.create({ authPath: join(dir, 'auth.json'), modelsPath: join(dir, 'models.json'), modelsStorePath: join(dir, 'store.json'), refreshOnCreate: false, allowModelNetwork: false });
  ({ session } = await createAgentSession({ cwd: dir, agentDir: dir, settingsManager, resourceLoader: loader, modelRuntime: runtime, sessionManager: SessionManager.inMemory(dir) }));
  await session.bindExtensions({});
  const start = new Promise(resolve => process.once('message', resolve));
  process.send({ type: 'ready', id });
  await start;
  await service.upsert({ id, baseUrl: 'http://127.0.0.1:1/v1', api: 'openai-completions', apiKey: 'fixture-only' }, context);
  service.dispose(); session.dispose();
  await runtime.refresh({ allowNetwork: false });
  process.send({ type: 'done', id });
} catch (error) {
  process.send?.({ type: 'error', id, message: error instanceof Error ? error.message : 'Worker failed' });
  process.exitCode = 1;
} finally {
  service?.dispose(); session?.dispose();
  process.disconnect();
}
