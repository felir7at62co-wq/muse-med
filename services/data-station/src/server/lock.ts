import { open, unlink } from 'node:fs/promises';

/** Claims one database for this preview process; stale locks require explicit inspection. */
export async function acquireDatabaseLock(dataDirectory: string): Promise<() => Promise<void>> {
  const path = `${dataDirectory}.lock`;
  let handle;
  try {
    handle = await open(path, 'wx', 0o600);
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'EEXIST') throw new Error('该预览数据库已有启动锁，请确认没有其他数据站进程使用后再处理锁文件');
    throw error;
  }
  await handle.writeFile(JSON.stringify({ pid: process.pid, createdAt: new Date().toISOString(), app: 'muse-data-web' }) + '\n');
  const identity = await handle.stat();
  let released = false;
  return async () => {
    if (released) return;
    released = true;
    await handle.close();
    try {
      const current = await open(path, 'r');
      const observed = await current.stat();
      await current.close();
      if (observed.ino === identity.ino && observed.dev === identity.dev) await unlink(path);
    } catch (error) {
      if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error;
    }
  };
}
