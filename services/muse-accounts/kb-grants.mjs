import {lstat, readFile, realpath} from 'node:fs/promises';
import {isAbsolute, relative, sep} from 'node:path';
import {validDocumentId} from './kb-vault.mjs';

const ACCOUNT_ID = /^[a-f0-9]{16}$/;

/** Load explicit, administrator-maintained permissions for source and wiki IDs. */
export async function loadDocumentGrants(file, {vaultRoot} = {}) {
  if (typeof file !== 'string' || !file) throw new Error('Document grants file is required');
  const info = await lstat(file);
  if (!info.isFile() || info.isSymbolicLink() || info.size > 4 * 1024 * 1024
    || process.platform !== 'win32' && (info.mode & 0o022) !== 0) throw new Error('Document grants file must be an administrator-maintained regular file');
  if (vaultRoot) {
    const grantPath = await realpath(file), vaultPath = await realpath(vaultRoot);
    const part = relative(vaultPath, grantPath);
    if (part === '' || part !== '..' && !part.startsWith('..' + sep) && !isAbsolute(part)) {
      throw new Error('Document grants file must be outside the shared vault');
    }
  }
  const data = JSON.parse(await readFile(file, 'utf8'));
  if (data?.version !== 1 || !Array.isArray(data.grants) || data.grants.length > 10_000 || Object.keys(data).some(key => key !== 'version' && key !== 'grants')) throw new Error('Invalid document grants file');
  const grants = new Map();
  for (const grant of data.grants) {
    const keys = Object.keys(grant ?? {});
    const base = keys.every(key => ['id', 'kind', 'level', 'access', 'accountIds', 'sha256', 'title'].includes(key))
      && validDocumentId(grant?.id) && !grants.has(grant.id)
      && typeof grant.sha256 === 'string' && /^[a-f0-9]{64}$/.test(grant.sha256)
      && (!keys.includes('title') || (typeof grant.title === 'string' && grant.title.trim() === grant.title && grant.title.length > 0 && grant.title.length <= 200 && !/[\x00-\x1f]/.test(grant.title)))
      && ['viral-script', 'knowledge'].includes(grant.kind)
      && (grant.kind !== 'viral-script' || grant.id.startsWith('SRC-'))
      && ['opening', 'read'].includes(grant.level)
      && (grant.level !== 'opening' || grant.kind === 'viral-script')
      && ['all-authenticated', 'accounts'].includes(grant.access);
    const accountScope = grant?.access === 'accounts'
      && Array.isArray(grant.accountIds) && grant.accountIds.length > 0 && grant.accountIds.length <= 1000
      && grant.accountIds.every(id => typeof id === 'string' && ACCOUNT_ID.test(id))
      && new Set(grant.accountIds).size === grant.accountIds.length;
    if (!base || (grant.access === 'accounts' ? !accountScope : keys.includes('accountIds'))) throw new Error('Invalid document grant');
    grants.set(grant.id, {kind: grant.kind, level: grant.level, accounts: new Set(grant.access === 'accounts' ? grant.accountIds : ['*']), sha256: grant.sha256, ...keys.includes('title') ? {title: grant.title} : {}});
  }
  return grants;
}
