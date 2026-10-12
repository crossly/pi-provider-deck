import { promises as fs, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { randomBytes } from 'node:crypto';

/**
 * A small cross-process lock for one JSON registry file.
 *
 * The lock is a directory created with mkdir, so acquisition is atomic on
 * POSIX and Windows filesystems. The owner record lets us remove a lock left
 * by a process that died; a live owner is never evicted based only on age.
 */
const LOCK_STALE_MS = 30_000;
const LOCK_TIMEOUT_MS = 15_000;
const LOCK_RETRY_MS = 25;

type LockOwner = { pid: number; token: string; createdAt: number };
interface ConfigLockOptions { timeoutMs?: number; signal?: AbortSignal }

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (!signal?.aborted) return;
  if (signal.reason instanceof Error) throw signal.reason;
  throw new DOMException('The operation was aborted.', 'AbortError');
}

async function waitForRetry(signal: AbortSignal | undefined): Promise<void> {
  throwIfAborted(signal);
  const { promise, resolve } = Promise.withResolvers<void>();
  const timer = setTimeout(resolve, LOCK_RETRY_MS);
  const onAbort = () => {
    clearTimeout(timer);
    resolve();
  };
  signal?.addEventListener('abort', onAbort, { once: true });
  await promise;
  signal?.removeEventListener('abort', onAbort);
  throwIfAborted(signal);
}

function isNodeError(value: unknown, code: string): boolean {
  return typeof value === 'object' && value !== null && 'code' in value && value.code === code;
}

async function readOwner(lockPath: string): Promise<{ owner?: LockOwner; mtimeMs: number }> {
  let mtimeMs = 0;
  try {
    const stat = await fs.stat(lockPath);
    mtimeMs = stat.mtimeMs;
  } catch {
    return { mtimeMs: 0 };
  }
  try {
    const text = await fs.readFile(join(lockPath, 'owner.json'), 'utf8');
    const value = JSON.parse(text) as Partial<LockOwner>;
    if (typeof value.pid !== 'number' || !Number.isInteger(value.pid) || value.pid <= 0 || typeof value.token !== 'string' || typeof value.createdAt !== 'number') {
      return { mtimeMs };
    }
    return { owner: value as LockOwner, mtimeMs };
  } catch {
    return { mtimeMs };
  }
}

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM means the process exists but this process is not allowed to signal it.
    return !isNodeError(error, 'ESRCH');
  }
}

async function removeStaleLock(lockPath: string, observedToken?: string): Promise<boolean> {
  const recoveryPath = `${lockPath}.recovery`;
  try {
    await fs.mkdir(recoveryPath);
  } catch {
    return false;
  }
  try {
    const current = await readOwner(lockPath);
    if (observedToken && current.owner?.token && current.owner.token !== observedToken) return false;
    if (current.owner && processAlive(current.owner.pid)) return false;
    const age = Date.now() - Math.max(current.owner?.createdAt ?? 0, current.mtimeMs);
    if (!current.owner && age < LOCK_STALE_MS) return false;
    await fs.rm(lockPath, { recursive: true, force: true });
    return true;
  } finally {
    await fs.rm(recoveryPath, { recursive: true, force: true }).catch(() => undefined);
  }
}

async function acquireLock(filePath: string, options: ConfigLockOptions = {}): Promise<() => Promise<void>> {
  const lockPath = `${filePath}.lock`;
  const recoveryPath = `${lockPath}.recovery`;
  const timeoutMs = options.timeoutMs ?? LOCK_TIMEOUT_MS;
  await fs.mkdir(dirname(filePath), { recursive: true, mode: 0o700 });
  throwIfAborted(options.signal);
  const owner: LockOwner = { pid: process.pid, token: randomBytes(12).toString('hex'), createdAt: Date.now() };
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      await fs.mkdir(lockPath);
      let recoveryActive = false;
      try {
        await fs.stat(recoveryPath);
        recoveryActive = true;
      } catch (error) {
        if (!isNodeError(error, 'ENOENT')) throw error;
      }
      if (recoveryActive) {
        await fs.rm(lockPath, { recursive: true, force: true });
        if (Date.now() >= deadline) throw new Error('Timed out waiting for model hub configuration lock.');
        await waitForRetry(options.signal);
        continue;
      }
      try {
        await fs.writeFile(join(lockPath, 'owner.json'), JSON.stringify(owner), { encoding: 'utf8', mode: 0o600, flag: 'wx' });
      } catch (error) {
        await fs.rm(lockPath, { recursive: true, force: true }).catch(() => undefined);
        throw error;
      }
      let released = false;
      return async () => {
        if (released) return;
        released = true;
        const current = await readOwner(lockPath);
        if (current.owner?.token !== owner.token) return;
        await fs.rm(lockPath, { recursive: true, force: true });
      };
    } catch (error) {
      if (options.signal?.aborted) throwIfAborted(options.signal);
      if (!isNodeError(error, 'EEXIST')) throw new Error('Unable to lock model hub configuration.', { cause: error });
      const current = await readOwner(lockPath);
      const ownerAlive = current.owner ? processAlive(current.owner.pid) : false;
      const age = Date.now() - Math.max(current.owner?.createdAt ?? 0, current.mtimeMs);
      if (!ownerAlive && (current.owner || age >= LOCK_STALE_MS)) {
        if (await removeStaleLock(lockPath, current.owner?.token)) continue;
      }
      if (Date.now() >= deadline) throw new Error('Timed out waiting for model hub configuration lock.');
      await waitForRetry(options.signal);
    }
  }
}

/** Run a local registry operation while holding the per-file cross-process lock. */
export async function withConfigLock<T>(filePath: string, operation: () => Promise<T> | T, options: ConfigLockOptions | number = {}): Promise<T> {
  const lockOptions = typeof options === 'number' ? { timeoutMs: options } : options;
  const release = await acquireLock(filePath, lockOptions);
  try {
    return await operation();
  } finally {
    await release();
  }
}

export async function readOptionalText(filePath: string): Promise<string | undefined> {
  try {
    return await fs.readFile(filePath, 'utf8');
  } catch (error) {
    if (isNodeError(error, 'ENOENT')) return undefined;
    throw new Error('Unable to read model hub configuration.', { cause: error });
  }
}

export function readOptionalTextSync(filePath: string): string | undefined {
  try {
    return readFileSync(filePath, 'utf8');
  } catch (error) {
    if (isNodeError(error, 'ENOENT')) return undefined;
    throw new Error('Unable to read model hub configuration.', { cause: error });
  }
}

/** Write a complete registry snapshot without exposing a partially-written JSON file. */
export async function writeAtomic(filePath: string, text: string): Promise<void> {
  const directory = dirname(filePath);
  const temporary = `${filePath}.${process.pid}.${randomBytes(8).toString('hex')}.tmp`;
  try {
    await fs.mkdir(directory, { recursive: true, mode: 0o700 });
    await fs.writeFile(temporary, text, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
    await fs.rename(temporary, filePath);
  } catch (error) {
    await fs.rm(temporary, { force: true }).catch(() => undefined);
    throw new Error('Unable to write model hub configuration.', { cause: error });
  }
}

/** Restore a previous snapshot only if no other process has changed our write. */
export async function compareAndRestore(filePath: string, expectedText: string, previousText: string | undefined): Promise<boolean> {
  return await withConfigLock(filePath, async () => {
    const current = await readOptionalText(filePath);
    if (current !== expectedText) return false;
    if (previousText === undefined) {
      try {
        await fs.rm(filePath, { force: true });
      } catch (error) {
        throw new Error('Unable to restore model hub configuration.', { cause: error });
      }
    } else {
      await writeAtomic(filePath, previousText);
    }
    return true;
  });
}
