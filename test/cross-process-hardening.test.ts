import test from 'node:test';
import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

test('independent pi processes commit disjoint provider edits without losing either update', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'pi-deck-processes-'));
  const configPath = join(dir, 'models.json');
  await writeFile(configPath, JSON.stringify({ providers: { alpha: { id: 'alpha', baseUrl: 'http://127.0.0.1:1/v1', api: 'openai-completions', apiKey: 'fixture-only', piProviderDeck: { managed: true } } }, retained: { marker: 'preserve' } }));
  const workers = [];
  try {
    for (const id of ['beta', 'gamma']) {
      const agentDir = join(dir, id); await mkdir(agentDir);
      const child = fork(fileURLToPath(new URL('./fixtures/transaction-worker.mjs', import.meta.url)), [configPath, agentDir, id], { execArgv: ['--import', 'tsx'], stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
      const ready = Promise.withResolvers<void>();
      const done = Promise.withResolvers<void>();
      const exited = Promise.withResolvers<void>();
      let stderr = '';
      child.stderr?.on('data', data => { stderr += String(data); });
      child.on('message', value => {
        const message = value as { type: string; message?: string };
        if (message.type === 'ready') ready.resolve();
        else if (message.type === 'done') done.resolve();
        else if (message.type === 'error') { const error = new Error(message.message); ready.reject(error); done.reject(error); }
      });
      child.on('error', error => { ready.reject(error); done.reject(error); });
      child.on('exit', code => {
        if (code !== 0) { const error = new Error(`Worker exited ${code}: ${stderr}`); ready.reject(error); done.reject(error); }
        exited.resolve();
      });
      // Attach both rejection paths immediately while awaiting readiness.
      void done.promise.catch(() => undefined);
      workers.push({ child, ready: ready.promise, done: done.promise, exited: exited.promise });
    }
    await Promise.all(workers.map(worker => worker.ready));
    for (const worker of workers) worker.child.send('commit');
    await Promise.all(workers.map(worker => worker.done));
    await Promise.all(workers.map(worker => worker.exited));
    const document = JSON.parse(await readFile(configPath, 'utf8'));
    assert.deepEqual(Object.keys(document.providers).sort(), ['alpha', 'beta', 'gamma']);
    assert.deepEqual(document.retained, { marker: 'preserve' });
  } finally {
    for (const worker of workers) if (worker.child.exitCode === null) worker.child.kill();
    await Promise.all(workers.map(worker => worker.exited));
    await rm(dir, { recursive: true, force: true });
  }
});
