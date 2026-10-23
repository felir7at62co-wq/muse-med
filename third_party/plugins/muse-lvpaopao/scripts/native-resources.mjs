/** Ship only owned runtime inputs; private configuration, captured data and test files never enter a package. */
import { cpSync, lstatSync, mkdirSync, readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, join } from 'node:path';

/** Exact Python/JS imports used by boot.py and its prepared helper. */
export const nativeResources = Object.freeze([
  'boot.py', 'requirements-windows-25560.lock', 'requirements-macos-arm64-269602.lock',
  'passive-probe/run-observation.py', 'passive-probe/observe-launch.js',
  'passive-probe/next-stage/enable-target-debug.js', 'passive-probe/next-stage/enable-target-debug-25799.js',
  'passive-probe/next-stage/runtime_profiles.py', 'passive-probe/next-stage/remote_wire.py',
  'passive-probe/next-stage/native_rpc.py', 'passive-probe/next-stage/run-native-identity.py',
  'passive-probe/next-stage/run-persistent-host.py', 'passive-probe/next-stage/operations/__init__.py',
  'passive-probe/next-stage/operations/fixed_operations.py', 'passive-probe/next-stage/operations/fixed-operation.js',
  'passive-probe/next-stage/persistent_media.py', 'passive-probe/next-stage/download_media.py',
  'passive-probe/next-stage/secure_media_receipt.py', 'passive-probe/next-stage/post_upgrade_peer.py',
  'passive-probe/next-stage/mac_media_protector.py', 'passive-probe/next-stage/mac_runtime.py',
  'passive-probe/next-stage/enable-target-debug-mac-269602.js',
]);
/**
 * Copy fixed owned runtime files while generating per-file package hashes.
 * @param {string} root - Plugin source directory.
 * @param {string} destination - Private package staging directory.
 * @returns {Record<string, string>} Shipped resource SHA256 values.
 */
export function copyNativeResources(root, destination) {
  const files = {};
  for (const relative of nativeResources) {
    const path = join('native', relative), source = join(root, path), info = lstatSync(source);
    if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1) throw new Error('Invalid owned native resource');
    const target = join(destination, path);
    mkdirSync(dirname(target), { recursive: true }); cpSync(source, target);
    files[path] = createHash('sha256').update(readFileSync(target)).digest('hex');
  }
  return files;
}
