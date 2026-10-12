import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, mkdir, readFile, writeFile, readdir, rm } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';

const exec = promisify(execFile);
const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const manifest = JSON.parse(await readFile(join(packageRoot, 'package.json'), 'utf8'));
const piRoot = resolve(dirname(fileURLToPath(import.meta.resolve('@earendil-works/pi-coding-agent'))), '..');
const piManifest = JSON.parse(await readFile(join(piRoot, 'package.json'), 'utf8'));
const piCli = join(piRoot, piManifest.bin.pi);
const npmCli = process.env.npm_execpath;
assert.ok(npmCli, 'Run this acceptance check with npm run test:install.');
const temporary = await mkdtemp(join(tmpdir(), 'pi-provider-deck-install-'));
let server;
let rpc;
let rpcClosed;
let catalogRequests = 0;

try {
  const packed = await exec(process.execPath, [npmCli, 'pack', '--json', '--ignore-scripts', '--dry-run=false', '--pack-destination', temporary], {
    cwd: packageRoot,
    env: { ...process.env, npm_config_dry_run: 'false', npm_config_ignore_scripts: 'true' },
  });
  const pack = JSON.parse(packed.stdout)[0];
  assert.ok(pack.files.some(file => file.path === 'LICENSE'));
  assert.ok(!pack.files.some(file => /(^|\/)(auth|omp-channels|models-store)\.json$|node_modules\//.test(file.path)));
  const tarball = await readFile(join(temporary, pack.filename));
  let origin;
  server = createServer((request, response) => {
    const path = request.url?.split('?')[0];
    if (path === '/catalog/v1/models') {
      catalogRequests++;
      assert.equal(request.headers.authorization, 'Bearer installation-probe-key');
      response.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ data: [{ id: 'installation-probe-model' }] }));
    } else if (path === `/${manifest.name}/-/${pack.filename}`) {
      response.writeHead(200, { 'Content-Type': 'application/octet-stream' }).end(tarball);
    } else if (path === `/${manifest.name}`) {
      const version = { ...manifest, dist: { tarball: `${origin}/${manifest.name}/-/${pack.filename}`, integrity: pack.integrity, shasum: pack.shasum } };
      response.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ name: manifest.name, 'dist-tags': { latest: manifest.version }, versions: { [manifest.version]: version } }));
    } else {
      response.writeHead(404, { 'Content-Type': 'application/json' }).end('{"error":"Not found in isolated installation registry"}');
    }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  origin = `http://127.0.0.1:${server.address().port}`;
  const agentDir = join(temporary, 'agent');
  await mkdir(agentDir);
  const npmrc = join(temporary, 'npmrc');
  await writeFile(npmrc, '');
  const globalNpmrc = join(temporary, 'global-npmrc');
  await writeFile(globalNpmrc, '');
  const env = {
    ...process.env,
    PI_CODING_AGENT_DIR: agentDir,
    PI_OFFLINE: '1',
    PI_SKIP_VERSION_CHECK: '1',
    npm_config_registry: origin,
    npm_config_userconfig: npmrc,
    npm_config_globalconfig: globalNpmrc,
    npm_config_cache: join(temporary, 'npm-cache'),
    npm_config_audit: 'false',
    npm_config_fund: 'false',
    npm_config_dry_run: 'false',
    npm_config_ignore_scripts: 'true',
  };
  const installed = await exec(process.execPath, [piCli, 'install', `npm:${manifest.name}@${manifest.version}`], { cwd: temporary, env, timeout: 60_000 });
  assert.match(installed.stdout, new RegExp(`Installed npm:${manifest.name}@`));
  const modules = await readdir(join(agentDir, 'npm', 'node_modules'));
  assert.ok(modules.includes(manifest.name));
  assert.ok(!modules.includes('@earendil-works'), 'Host packages must not be installed as physical package dependencies.');
  await writeFile(join(agentDir, 'omp-channels.json'), JSON.stringify({ channels: [{
    id: 'installation-probe', baseUrl: `${origin}/catalog/v1`, api: 'openai-completions', apiKey: 'installation-probe-key',
    defaults: { contextWindow: 8192, maxTokens: 1024 },
  }] }), { mode: 0o600 });

  rpc = spawn(process.execPath, [piCli, '--mode', 'rpc', '--no-session'], { cwd: temporary, env, stdio: ['pipe', 'pipe', 'pipe'] });
  rpcClosed = new Promise(resolve => rpc.once('close', resolve));
  let buffer = '';
  let diagnostics = '';
  let nextId = 0;
  const pending = new Map();
  rpc.stderr.on('data', data => { diagnostics += data; });
  rpc.stdout.on('data', data => {
    buffer += data;
    for (;;) {
      const newline = buffer.indexOf('\n');
      if (newline < 0) break;
      const line = buffer.slice(0, newline);
      buffer = buffer.slice(newline + 1);
      try {
        const event = JSON.parse(line);
        if (event.type === 'response' && pending.has(event.id)) {
          const callback = pending.get(event.id);
          pending.delete(event.id);
          callback(event);
        }
      } catch { /* Non-protocol startup diagnostics are ignored, not interpreted as success. */ }
    }
  });
  const request = async payload => {
    const id = `install-${++nextId}`;
    let timer;
    try {
      return await new Promise((resolve, reject) => {
        pending.set(id, resolve);
        timer = setTimeout(() => { pending.delete(id); reject(new Error(`RPC deadline for ${payload.type}: ${diagnostics.slice(0, 1000)}`)); }, 15_000);
        rpc.stdin.write(JSON.stringify({ ...payload, id }) + '\n');
      });
    } finally { clearTimeout(timer); }
  };
  const commands = await request({ type: 'get_commands' });
  assert.equal(commands.success, true);
  const names = commands.data.commands.map(command => command.name);
  for (const name of ['model-hub', 'channels', 'models', 'models-refresh']) assert.ok(names.includes(name), `Missing installed command ${name}`);
  const refreshed = await request({ type: 'prompt', message: '/models-refresh installation-probe' });
  assert.equal(refreshed.success, true);
  const available = await request({ type: 'get_available_models' });
  assert.equal(available.success, true);
  assert.deepEqual(available.data.models.filter(model => model.provider === 'installation-probe').map(model => model.id), ['installation-probe-model']);
  assert.equal(catalogRequests, 1);
  console.log(`${manifest.name}@${manifest.version}: packed npm installation, command loading and live catalog refresh PASS`);
} finally {
  if (rpc && rpc.exitCode === null) { rpc.stdin.end(); rpc.kill('SIGTERM'); }
  if (rpcClosed) await rpcClosed;
  if (server) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
  await rm(temporary, { recursive: true, force: true });
}
