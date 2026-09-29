// Account-owned source packets are separate from administrator-granted documents.
import {access, lstat, mkdir, readFile, readdir, realpath} from 'node:fs/promises';
import {constants} from 'node:fs';
import {isAbsolute, join, relative, sep} from 'node:path';
import {validId} from './store.mjs';
import {ingestSession, readDocumentPage, readOpening, searchVault} from './kb-vault.mjs';

const SOURCE_ID = /^SRC-\d{4}-\d{2}-\d{2}-\d{3}$/;
const PRIVATE_ID = /^private\/(SRC-\d{4}-\d{2}-\d{2}-\d{3})$/;
const MAX_ITEMS = 12;
const MAX_TEXT = 400_000;
const MAX_TITLE = 200;
const SAFE_SOURCE = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,200}$/;

async function privateDirectory(path, create) {
  if (create) await mkdir(path, {recursive: true, mode: 0o700});
  const info = await lstat(path).catch(error => {
    if (!create && error.code === 'ENOENT') return null;
    throw error;
  });
  if (!info) return false;
  if (!info.isDirectory() || info.isSymbolicLink() || process.platform !== 'win32' && (info.mode & 0o077) !== 0) {
    throw new Error('Private knowledge-base directory must be owner-only');
  }
  return true;
}

async function accountVault(root, accountId, create = false) {
  if (!root || !validId(accountId)) throw new Error('Private knowledge base is unavailable');
  if (!await privateDirectory(root, create)) return null;
  const path = join(root, accountId);
  return await privateDirectory(path, create) ? path : null;
}

/** Require a preprovisioned, owner-only personal root outside the shared vault. */
export async function verifyPersonalRoot(root, sharedRoot) {
  if (!isAbsolute(root ?? '') || !isAbsolute(sharedRoot ?? '') || !await privateDirectory(root, false)) {
    throw new Error('Private knowledge-base root must be an existing owner-only absolute directory');
  }
  const personal = await realpath(root), shared = await realpath(sharedRoot);
  const info = await lstat(personal);
  if (process.platform !== 'win32' && info.uid !== process.getuid()) throw new Error('Private knowledge-base root must be owned by the gateway user');
  await access(personal, constants.R_OK | constants.W_OK | constants.X_OK);
  const inside = (base, target) => {
    const part = relative(base, target);
    return part === '' || part !== '..' && !part.startsWith('..' + sep) && !isAbsolute(part);
  };
  if (inside(shared, personal) || inside(personal, shared)) throw new Error('Private knowledge-base root must be separate from the shared vault');
}

async function grants(vault) {
  const sourceRoot = join(vault, 'raw', 'sources');
  let ids;
  try { ids = await readdir(sourceRoot); }
  catch (error) { if (error.code === 'ENOENT') return new Map(); throw error; }
  const records = new Map();
  for (const id of ids) {
    if (!SOURCE_ID.test(id)) continue;
    const packet = join(sourceRoot, id);
    const info = await lstat(packet).catch(() => null);
    if (!info?.isDirectory() || info.isSymbolicLink()) continue;
    let manifest;
    try {
      const body = await readFile(join(packet, 'manifest.json'), 'utf8');
      if (body.length > 4096) continue;
      manifest = JSON.parse(body);
    } catch { continue; }
    if (manifest?.id !== id || !/^[a-f0-9]{64}$/.test(manifest.content_sha256)
      || typeof manifest.title !== 'string' || !manifest.title.trim() || manifest.title.length > MAX_TITLE) continue;
    records.set(id, {sha256: manifest.content_sha256, title: manifest.title, kind: 'user-script', level: 'read'});
  }
  return records;
}

/** Save reviewed Markdown script sections as account-private, immutable packets. */
export async function ingestPersonalScripts(root, account, items) {
  if (!Array.isArray(items) || items.length < 1 || items.length > MAX_ITEMS) throw new Error(`items must contain 1–${MAX_ITEMS} script sections`);
  const vault = await accountVault(root, account.id, true);
  const outcomes = [];
  for (const [index, item] of items.entries()) {
    const valid = item && typeof item === 'object' && !Array.isArray(item)
      && Object.keys(item).every(key => ['title', 'text', 'source', 'reviewed'].includes(key))
      && item.reviewed === true
      && typeof item.title === 'string' && item.title.trim() && item.title.length <= MAX_TITLE
      && typeof item.text === 'string' && item.text.trim() && item.text.length <= MAX_TEXT
      && typeof item.source === 'string' && SAFE_SOURCE.test(item.source) && !item.source.includes('..');
    if (!valid) {
      outcomes.push({index, state: 'failed', reason: '需要已复核的剧本 Markdown、标题和安全的来源标识；单段正文最多 400000 字。'});
      continue;
    }
    try {
      const saved = await ingestSession(vault, {title: item.title.trim(), text: item.text, source: item.source, author: account.username});
      outcomes.push({index, state: saved.duplicate ? 'duplicate' : 'saved', id: `private/${saved.id}`, sha256: saved.sha256});
    } catch {
      outcomes.push({index, state: 'failed', reason: '写入失败，请稍后重试这一段。'});
    }
  }
  return outcomes;
}

/** Search only this account's reviewed source packets. */
export async function searchPersonalScripts(root, accountId, query, limit) {
  const vault = await accountVault(root, accountId);
  if (!vault) return {scanned: 0, results: []};
  const allowedGrants = await grants(vault);
  if (!String(query ?? '').trim()) return {scanned: allowedGrants.size, results: []};
  const found = await searchVault(vault, {query, limit, allowedGrants});
  return {scanned: found.scanned, results: found.results.map(entry => ({...entry, id: `private/${entry.id}`}))};
}

/** Read one exact page from a private script ID of the signed-in account. */
export async function readPersonalScript(root, accountId, privateId, start) {
  const id = PRIVATE_ID.exec(privateId)?.[1];
  if (!id) return null;
  const vault = await accountVault(root, accountId);
  if (!vault) return null;
  const grant = (await grants(vault)).get(id);
  if (!grant) return null;
  const page = await readDocumentPage(vault, id, {start, ...grant});
  return page && {...page, id: privateId};
}

/** Read up to the first 24000 characters of an account-owned source. */
export async function readPersonalOpening(root, accountId, privateId, start) {
  const id = PRIVATE_ID.exec(privateId)?.[1];
  if (!id) return null;
  const vault = await accountVault(root, accountId);
  if (!vault) return null;
  const grant = (await grants(vault)).get(id);
  if (!grant) return null;
  const page = await readOpening(vault, id, {start, ...grant});
  return page && {...page, id: privateId};
}
