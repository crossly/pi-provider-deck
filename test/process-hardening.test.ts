import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer, createConnection, type Socket } from 'node:net';
import { resolveCommandValue } from '../discovery.ts';

// This exercises actual OS process-group/tree termination, including its real
// grace deadline. The child reports readiness over a socket; no guessed sleeps.
test('aborting a credential command also terminates a descendant ignoring SIGTERM', { timeout: 30_000 }, async () => {
  const ready = Promise.withResolvers<{ port: number }>();
  const sockets = new Set<Socket>();
  const control = createServer(socket => {
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
    let message = '';
    socket.on('data', data => { message += data; });
    socket.on('end', () => ready.resolve(JSON.parse(message)));
  });
  await new Promise<void>(resolve => control.listen(0, '127.0.0.1', resolve));
  const address = control.address(); assert.ok(address && typeof address !== 'string');
  const descendant = `process.on('SIGTERM',()=>{});const net=require('node:net');const server=net.createServer(socket=>socket.end('alive'));server.listen(0,'127.0.0.1',()=>{const s=net.connect(${address.port},'127.0.0.1',()=>s.end(JSON.stringify({port:server.address().port})));});`;
  const parent = `require('node:child_process').spawn(process.execPath,['-e',${JSON.stringify(descendant)}],{stdio:'ignore'});require('node:net').createServer().listen(0);`;
  const encoded = Buffer.from(parent).toString('base64');
  const command = `!"${process.execPath}" -e "eval(Buffer.from('${encoded}','base64').toString())"`;
  const abort = new AbortController();
  const operation = resolveCommandValue(command, { signal: abort.signal, timeoutMs: 5000 });
  try {
    const { port } = await Promise.race([ready.promise, operation.then(() => { throw new Error('Credential fixture exited before readiness.'); })]);
    await new Promise<void>((resolve, reject) => {
      const socket = createConnection({ port, host: '127.0.0.1', signal: AbortSignal.timeout(2000) });
      socket.once('connect', () => { socket.destroy(); resolve(); });
      socket.once('error', reject);
    });
    abort.abort(new DOMException('Probe cancellation', 'AbortError'));
    await assert.rejects(operation, /cancel|abort/i);
    await assert.rejects(new Promise<void>((resolve, reject) => {
      const socket = createConnection({ port, host: '127.0.0.1', signal: AbortSignal.timeout(2000) });
      socket.once('connect', () => { socket.destroy(); resolve(); });
      socket.once('error', reject);
    }), { code: 'ECONNREFUSED' });
  } finally {
    abort.abort();
    await operation.catch(() => undefined);
    for (const socket of sockets) socket.destroy();
    await new Promise<void>(resolve => control.close(() => resolve()));
  }
});
