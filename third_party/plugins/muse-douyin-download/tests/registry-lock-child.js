/** Real process ownership and crash points for the private registry lock. */
import { mkdir } from 'node:fs/promises';
import fs from 'node:fs/promises';
import assert from 'node:assert/strict';
import { syncBuiltinESMExports } from 'node:module';
import { join, basename } from 'node:path';
import { TaskStore } from '../src/task-store.js';
import { resolveConfig } from '../src/runner.js';

// A killed test parent must not leave a staged child holding a kernel handle.
process.once('disconnect', () => process.exit(0));

const [home, mode] = process.argv.slice(2);
const store = new TaskStore(resolveConfig({ settingsHome: home, taskLockTimeoutMs: 5000, taskLockPollMs: 5 }));
store.directory = join(home, 'plugin-data/muse-douyin-download/tasks/v1');
store.file = join(store.directory, 'registry.json');
await mkdir(store.directory, { recursive: true, mode: 0o700 });
const announce = stage => new Promise((resolve, reject) => process.send({ stage }, error => error ? reject(error) : resolve()));
if (mode.startsWith('cleanup-')) {
  const unlink = fs.unlink, target = mode === 'cleanup-primary' ? '.registry.lock-' : '.registry.reclaim-';
  let rejected = false;
  try {
    fs.unlink = async file => {
      if (!rejected && basename(file).startsWith(target) && file.endsWith('.tmp')) {
        rejected = true;
        throw Object.assign(new Error('Controlled private temporary alias cleanup refusal'), { code: 'EPERM' });
      }
      return unlink(file);
    };
    syncBuiltinESMExports();
    const release = await store.lock();
    fs.unlink = unlink; syncBuiltinESMExports();
    await release();
    assert.equal(rejected, true);
    await store.ready();
  } finally { fs.unlink = unlink; syncBuiltinESMExports(); }
  process.disconnect();
  process.exit(0);
}
if (mode === 'crash-primary') {
  await store.lock();
  await announce('primary-held');
  process.exit(0);
}
if (mode === 'crash-reclaimer' || mode === 'hold-reclaimer') {
  const read = store.readBounded.bind(store);
  let reads = 0;
  store.readBounded = async (...args) => {
    if (basename(args[0]) === '.registry.lock' && ++reads === 2) {
      await announce('reclaim-held');
      if (mode === 'crash-reclaimer') process.exit(0);
      await new Promise(resolve => process.once('message', resolve));
    }
    return read(...args);
  };
}
if (mode === 'increment') {
  await store.ready();
  for (let index = 0; index < 4; index++) await store.transaction(async registry => {
    const before = registry.revision;
    await new Promise(resolve => setImmediate(resolve));
    registry.revision = before + 1;
  });
} else {
  const release = await store.lock();
  if (mode === 'hold-primary') {
    await announce('primary-held');
    await new Promise(resolve => process.once('message', resolve));
  }
  await release();
}
process.disconnect();
