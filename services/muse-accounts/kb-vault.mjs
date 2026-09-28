// Cloud knowledge base storage: immutable source packets plus lexical recall.
//
// Session captures land in raw/ as upstream source packets (immutable after
// capture) so the knowledge layer stays clean; recall reads both raw/ packets
// and the distilled wiki/ pages so an ingested session is searchable at once.
import {chmod, lstat, mkdir, open, readdir, readFile, rename, rm, rmdir, writeFile} from 'node:fs/promises';
import {constants} from 'node:fs';
import {createHash} from 'node:crypto';
import {join, relative, sep} from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
import {cosine, blendScore, contentHash, needsChunks} from './kb-embedding.mjs';

const MAX_TEXT = 400000;
const MAX_TITLE = 200;
const SOURCE_ID = /^SRC-\d{4}-\d{2}-\d{2}-\d{3}$/;
const SAFE_SOURCE = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,200}$/;
const LOCK = '.kb.lock';

/** Cross-process lock; a crashed writer leaves the lock for an administrator. */
async function withLock(path, fn, timeoutMs = 20000) {
  const started = Date.now();
  for (;;) {
    try { await mkdir(path); break; }
    catch (error) {
      if (error.code !== 'EEXIST') throw error;
      if (Date.now() - started > timeoutMs) throw new Error(`Knowledge base busy; inspect stale lock: ${path}`);
      await delay(30);
    }
  }
  try { return await fn(); } finally { await rmdir(path); }
}

const digest = value => createHash('sha256').update(value).digest('hex');

function requireText(value, label, max) {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${label} is required`);
  if (value.length > max) throw new Error(`${label} is too long`);
  return value;
}

async function existingIds(sources) {
  try { return (await readdir(sources)).filter(name => SOURCE_ID.test(name)).sort(); }
  catch (error) { if (error.code === 'ENOENT') return []; throw error; }
}

async function findDuplicate(sources, hash) {
  for (const id of await existingIds(sources)) {
    try {
      const manifest = JSON.parse(await readFile(join(sources, id, 'manifest.json'), 'utf8'));
      if (manifest.content_sha256 === hash) return id;
    } catch { /* An unreadable packet is not a duplicate match. */ }
  }
  return null;
}

export async function ingestSession(vaultRoot, {title, text, source, author} = {}, {now = new Date()} = {}) {
  requireText(text, 'text', MAX_TEXT);
  requireText(title, 'title', MAX_TITLE);
  requireText(source, 'source', 200);
  if (!SAFE_SOURCE.test(source) || source.includes('..')) throw new Error('source must be a relative identifier without traversal');
  const authorName = typeof author === 'string' && author.trim() ? author.trim().slice(0, 64) : 'unknown';
  const sources = join(vaultRoot, 'raw', 'sources');
  const hash = digest(text);

  return withLock(join(vaultRoot, LOCK), async () => {
    await mkdir(sources, {recursive: true});
    const duplicate = await findDuplicate(sources, hash);
    if (duplicate) return {id: duplicate, path: join(sources, duplicate), duplicate: true, sha256: hash, title};

    const captured = now.toISOString().slice(0, 10);
    const ids = await existingIds(sources);
    // Allocate monotonically and never reuse a retired serial: wiki pages cite
    // [[sources/SRC-...]] by id, so a recycled id would silently repoint a citation.
    const counter = join(vaultRoot, 'meta', `kb-source-serial-${captured}`);
    let previous = 0;
    try {
      const recorded = (await readFile(counter, 'utf8')).trim();
      if (!/^(0|[1-9]\d{0,2})$/.test(recorded)) throw new Error('Invalid source counter; inspect before writing');
      previous = Number(recorded);
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
    const highest = ids.filter(id => id.slice(4, 14) === captured)
      .reduce((max, id) => Math.max(max, Number(id.slice(-3))), previous);
    const serial = highest + 1;
    if (serial > 999) throw new Error('Source serial is exhausted in this vault');
    const id = `SRC-${captured}-${String(serial).padStart(3, '0')}`;
    // Reserve before exposing the packet: a failed write may leave a gap, but
    // deleting even the newest packet must never recycle a referenced id.
    const temporaryCounter = `${counter}.${process.pid}.tmp`;
    await mkdir(join(vaultRoot, 'meta'), {recursive: true});
    try {
      await writeFile(temporaryCounter, String(serial), {flag: 'wx', mode: 0o600});
      await rename(temporaryCounter, counter);
    } finally { await rm(temporaryCounter, {force: true}); }

    const manifest = {
      id,
      captured,
      packet_version: '1.0',
      title,
      source,
      author: authorName,
      format: 'markdown',
      extractor: 'muse-kb',
      extraction_status: 'success',
      content_sha256: hash,
    };
    // Build beside the target and rename once, so a reader never sees a partial packet.
    const staging = join(sources, `.${id}.staging`);
    await mkdir(staging, {recursive: true});
    try {
      await writeFile(join(staging, 'extracted.md'), text, {encoding: 'utf8', flag: 'wx'});
      await writeFile(join(staging, 'manifest.json'), JSON.stringify(manifest, null, 2), {encoding: 'utf8', flag: 'wx'});
      // The gateway runs with UMask=0077; explicitly grant the shared editor
      // group access before the atomic rename exposes this packet to readers.
      await chmod(join(staging, 'extracted.md'), 0o660);
      await chmod(join(staging, 'manifest.json'), 0o660);
      await chmod(staging, 0o2770);
      await rename(staging, join(sources, id));
    } catch (error) {
      await rm(staging, {recursive: true, force: true}).catch(() => {});
      throw error;
    }
    return {id, path: join(sources, id), duplicate: false, sha256: hash, title};
  });
}

export function documentContent(body, fallbackTitle) {
  const title = body.match(/^---\s*$[\s\S]*?^title:\s*(.+)$/m)?.[1]?.trim() ?? fallbackTitle;
  const text = body.replace(/^---[\s\S]*?---\s*/, '');
  const canonical = `${title}\n${text}`;
  return {title, text, hash: contentHash(needsChunks(title, text) ? `chunk-v1\0${canonical}` : canonical)};
}

// The editor-writable vault is a trust boundary: open and stat the SAME fd,
// rather than lstat(path) followed by a symlink-following readFile(path).
export async function readRegularPage(path) {
  let handle;
  try { handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW); }
  catch (error) { if (['ENOENT', 'ELOOP', 'ENOTDIR'].includes(error.code)) return null; throw error; }
  try {
    const info = await handle.stat();
    if (!info.isFile() || info.size > MAX_TEXT * 3) return null;
    const body = await handle.readFile('utf8');
    return body.length <= MAX_TEXT ? body : null;
  } finally { await handle.close(); }
}

export async function collectDocuments(vaultRoot) {
  const documents = [];
  const readPage = async (path, id, fallbackTitle) => {
    const body = await readRegularPage(path);
    if (body === null) return;
    documents.push({id, body, ...documentContent(body, fallbackTitle), path});
  };

  const sources = join(vaultRoot, 'raw', 'sources');
  for (const id of await existingIds(sources)) {
    const packet = join(sources, id), manifestPath = join(packet, 'manifest.json');
    if (!(await lstat(packet).catch(() => null))?.isDirectory()) continue;
    // A source packet carries its human title in manifest.json, not in the body.
    let title = id;
    if ((await lstat(manifestPath).catch(() => null))?.isFile()) {
      try {
        const value = JSON.parse(await readFile(manifestPath, 'utf8')).title;
        if (typeof value === 'string' && value.trim() && value.length <= MAX_TITLE) title = value.trim();
      } catch { /* Fall back to the packet id when the manifest is unreadable. */ }
    }
    await readPage(join(packet, 'extracted.md'), id, title);
  }
  const wiki = join(vaultRoot, 'wiki');
  const walk = async dir => {
    let entries;
    try { entries = await readdir(dir, {withFileTypes: true}); }
    catch (error) { if (error.code === 'ENOENT') return; throw error; }
    for (const entry of entries) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) await walk(path);
      else if (entry.isFile() && entry.name.endsWith('.md')) {
        const id = `wiki/${relative(wiki, path).slice(0, -3).split(sep).join('/')}`;
        await readPage(path, id, entry.name.slice(0, -3));
      }
    }
  };
  await walk(wiki);
  return documents;
}

/**
 * Recall over raw source packets and distilled wiki pages.
 *
 * Lexical scoring always works offline. When an embedder and a vector index are
 * supplied, the query is embedded once and blended with cosine similarity — but
 * any embedding failure degrades silently to the lexical result rather than
 * failing the search. `semanticFloor` exists because cosine between unrelated
 * Chinese texts is far from zero, so without a floor every document would match.
 */
export async function searchVault(vaultRoot, {query, limit = 8, embedder, vectors, semanticWeight = 0.5, semanticFloor = 0.5} = {}) {
  const raw = String(query ?? '').trim();
  if (!raw) return {ok: true, results: [], semantic: false};
  if (embedder?.enabled) vectors?.refresh?.();
  const documents = await collectDocuments(vaultRoot);
  const lowered = raw.toLocaleLowerCase();
  const words = [...new Intl.Segmenter('zh', {granularity: 'word'}).segment(lowered)]
    .filter(part => part.isWordLike).map(part => part.segment);
  const tokens = [...new Set([lowered, ...words])].filter(token => token.length > 0);
  const size = Math.min(20, Math.max(1, Number(limit) || 8));

  const lexicalFor = document => {
    const title = document.title.toLocaleLowerCase();
    const body = document.body.toLocaleLowerCase();
    return tokens.reduce((sum, token) => sum + (body.split(token).length - 1) + (title.includes(token) ? 6 : 0), 0);
  };

  let queryVector = null;
  if (embedder?.enabled && vectors) {
    try { queryVector = await embedder.embed(raw); }
    catch { queryVector = null; }
  }
  const weight = queryVector ? Math.min(1, Math.max(0, Number(semanticWeight) || 0)) : 0;
  const highest = documents.reduce((max, document) => Math.max(max, lexicalFor(document)), 0) || 1;
  const floor = Math.min(1, Math.max(0, Number(semanticFloor) || 0));

  const results = documents.map(document => {
    const lexical = lexicalFor(document) / highest;
    const stored = queryVector ? vectors.get(document.id, document.hash) : null;
    const similar = stored ? Math.max(...(Array.isArray(stored[0]) ? stored : [stored]).map(vector => cosine(queryVector, vector))) : 0;
    // Without a stored vector a document can only be recalled lexically.
    const score = weight > 0 ? blendScore(lexical, stored ? similar : 0, weight) : lexical;
    return {id: document.id, title: document.title, path: document.path, score, lexical, similar, preview: document.text.slice(0, 400)};
  }).filter(entry => entry.lexical > 0 || entry.similar >= floor)
    .sort((a, b) => b.score - a.score || a.id.localeCompare(b.id));

  return {ok: true, scanned: documents.length, semantic: !!queryVector, results: results.slice(0, size)};
}
