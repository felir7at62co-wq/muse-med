import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {after} from 'node:test';
import {once} from 'node:events';

const selected = process.env.MUSE_PURGE_PACKAGE_DIR;
if (!selected || !path.isAbsolute(selected)) {
  throw new Error('Set MUSE_PURGE_PACKAGE_DIR to the absolute directory of the built optional package');
}

export const packageDirectory = fs.realpathSync(selected);
const temporaryParent = path.resolve(os.tmpdir());
export const temporaryDirectory = fs.mkdtempSync(path.join(temporaryParent, 'muse-purge-tests-'));

/** Import a module from the package under test instead of a local installation. */
export function importPackage(relativePath) {
  const absolute = path.resolve(packageDirectory, relativePath);
  if (!absolute.startsWith(packageDirectory + path.sep)) throw new Error('Package module escapes its root');
  return import(pathToFileURL(absolute).href);
}

/** Resolve a package member for a fresh subprocess or an exact fixture read. */
export function packageFile(relativePath) {
  const absolute = path.resolve(packageDirectory, relativePath);
  if (!absolute.startsWith(packageDirectory + path.sep)) throw new Error('Package member escapes its root');
  return absolute;
}

/** Bound process-event waits so a failed fixture cannot keep a CI worker alive. */
export async function onceWithin(emitter, event, timeoutMs = 30000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error(`Timed out waiting for ${event}`)), timeoutMs);
  try { return await once(emitter, event, {signal: controller.signal}); }
  finally { clearTimeout(timer); }
}

/** Wait for a fixture's readiness line, rejecting startup errors and early exit. */
export function readyProcess(child, timeoutMs = 10000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => finish(new Error('Fixture did not report readiness')), timeoutMs);
    const onData = data => finish(null, [data]);
    const onError = error => finish(error);
    const onExit = (code, signal) => finish(new Error(`Fixture exited before readiness: ${code ?? signal}`));
    function finish(error, value) {
      clearTimeout(timer);
      child.stdout.removeListener('data', onData);
      child.removeListener('error', onError);
      child.removeListener('exit', onExit);
      if (error) reject(error);
      else resolve(value);
    }
    child.stdout.once('data', onData);
    child.once('error', onError);
    child.once('exit', onExit);
  });
}

after(() => {
  if (process.env.MUSE_PURGE_KEEP_TEST_FILES === '1') return;
  const resolved = path.resolve(temporaryDirectory);
  if (path.dirname(resolved) !== temporaryParent || !path.basename(resolved).startsWith('muse-purge-tests-')) {
    throw new Error('Refusing to clean an unexpected test directory');
  }
  fs.rmSync(resolved, {recursive: true, force: true, maxRetries: 5, retryDelay: 100});
});
