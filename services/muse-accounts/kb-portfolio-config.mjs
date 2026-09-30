/** Administrator-maintained permissions for reading account project portfolios. */
import {lstat, readFile, realpath} from 'node:fs/promises';
import {isAbsolute, relative, sep} from 'node:path';

const ACCOUNT_ID = /^[a-f0-9]{16}$/;
const MAX_FILE_BYTES = 256 * 1024;

/** Load explicit portfolio-reader account permissions from outside account storage.
 * @param {string} file Absolute administrator-maintained configuration file.
 * @param {object} options Shared and personal directories excluded from configuration storage.
 * @param {string} [options.vaultRoot] Shared vault whose descendants cannot hold this file.
 * @param {string} [options.personalRoot] Personal storage whose descendants cannot hold this file.
 * @returns {Promise<Set<string>>} Account IDs allowed to read the project portfolio.
 * @throws {Error} Invalid JSON or account IDs, writable or redirected configuration, or inaccessible files.
 */
export async function loadPortfolioReaders(file, {vaultRoot, personalRoot} = {}) {
  if (typeof file !== 'string' || !isAbsolute(file)) throw new Error('Portfolio readers file requires an absolute path');
  const info = await lstat(file);
  if (!info.isFile() || info.isSymbolicLink() || info.size > MAX_FILE_BYTES
    || process.platform !== 'win32' && (info.mode & 0o022) !== 0) {
    throw new Error('Portfolio readers file must be an administrator-maintained regular file');
  }
  const filePath = await realpath(file);
  for (const [label, root] of [['shared vault', vaultRoot], ['personal root', personalRoot]]) {
    if (root === undefined) continue;
    const part = relative(await realpath(root), filePath);
    if (part === '' || part !== '..' && !part.startsWith('..' + sep) && !isAbsolute(part)) {
      throw new Error(`Portfolio readers file must be outside the ${label}`);
    }
  }
  const body = await readFile(file);
  if (body.length > MAX_FILE_BYTES) throw new Error('Portfolio readers file must be an administrator-maintained regular file');
  const data = JSON.parse(body.toString('utf8'));
  if (data?.version !== 1 || !Array.isArray(data.accountIds) || data.accountIds.length > 1000
    || Object.keys(data).some(key => key !== 'version' && key !== 'accountIds')
    || data.accountIds.some(id => typeof id !== 'string' || !ACCOUNT_ID.test(id))) {
    throw new Error('Invalid portfolio readers file');
  }
  const readers = new Set(data.accountIds);
  if (readers.size !== data.accountIds.length) throw new Error('Invalid portfolio readers file');
  return readers;
}
