/** Kernel-held arbitration for dead registry owners; the stable lock file is never unlinked. */
import { open, lstat } from 'node:fs/promises';
import { join, toNamespacedPath } from 'node:path';

let windows;
async function win32() {
  if (windows) return windows;
  const koffi = (await import('koffi')).default, kernel = koffi.load('kernel32.dll');
  windows = {
    open: kernel.func('__stdcall', 'CreateFileW', 'intptr', ['str16', 'uint', 'uint', 'void*', 'uint', 'uint', 'intptr']),
    close: kernel.func('__stdcall', 'CloseHandle', 'int', ['intptr']),
    error: kernel.func('__stdcall', 'GetLastError', 'uint', []),
  };
  return windows;
}

/** @param directory Canonical private registry directory. @returns Exclusive release function, or null while another reclaimer holds it. */
export async function tryReclaimLock(directory) {
  const file = join(directory, '.registry.kernel-lock');
  try {
    const info = await lstat(file);
    if (!info.isFile() || info.isSymbolicLink()) throw new Error('Registry kernel lock must be a regular file');
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
  if (process.platform === 'win32') {
    const api = await win32();
    // OPEN_ALWAYS retains the file; shareMode zero excludes holders and deletion across login sessions.
    const handle = api.open(toNamespacedPath(file), 0xc0000000, 0, null, 4, 0x80, 0);
    if (handle === -1) {
      const code = api.error();
      if (code === 32) return null;
      throw new Error(`Registry kernel lock failed (Win32 ${code})`);
    }
    return async () => { if (api.close(handle) === 0) throw new Error(`Registry kernel unlock failed (Win32 ${api.error()})`); };
  }
  const { tryLockExclusive } = await import('@deepseek-ai/node-addon-system/flock');
  const handle = await open(file, 'a+', 0o600);
  try {
    await tryLockExclusive(handle.fd);
    const held = await handle.stat({ bigint: true }), current = await lstat(file, { bigint: true });
    if (!current.isFile() || current.isSymbolicLink() || held.ino !== current.ino || held.dev !== current.dev)
      throw new Error('Registry kernel lock file changed during acquisition');
    return () => handle.close();
  } catch (error) {
    await handle.close();
    if (error.code === 'EAGAIN' || error.code === 'EWOULDBLOCK') return null;
    throw error;
  }
}
