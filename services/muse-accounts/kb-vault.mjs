// Cloud knowledge base storage: immutable source packets plus lexical recall.
//
// Session captures land in raw/ as upstream source packets (immutable after
// capture) so the knowledge layer stays clean; recall reads both raw/ packets
// and the distilled wiki/ pages so an ingested session is searchable at once.
import {chmod, lstat, mkdir, open, readdir, readFile, rename, rm, rmdir, writeFile} from 'node:fs/promises';
import {constants} from 'node:fs';
import {createHash, randomBytes} from 'node:crypto';
import {join, relative, sep} from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
import {cosine, blendScore, contentHash, needsChunks} from './kb-embedding.mjs';

const MAX_TEXT = 400000;
const MAX_TITLE = 200;
const SOURCE_ID = /^SRC-\d{4}-\d{2}-\d{2}-\d{3}$/;
const SAFE_SOURCE = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,200}$/;
const LOCK = '.kb.lock';
const OPENING_CHARS = 6000;
const OPENING_TOTAL_CHARS = 24_000;
const MAX_DOCUMENT_BYTES = 4 * 1024 * 1024;
const MAX_READ_START = 4_194_000;

function wikiParts(id) {
  if (typeof id !== 'string' || !id.startsWith('wiki/') || id.length > 400) return null;
  const parts = id.slice(5).split('/');
  return parts.some(part => !part || part === '.' || part === '..' || /[\\:\x00-\x1f<>"|?*]/.test(part) || part.length > 120) ? null : parts;
}

/** Accept the source IDs and wiki paths that the KB itself can resolve. */
export function validDocumentId(id) {
  return typeof id === 'string' && (SOURCE_ID.test(id) || wikiParts(id) !== null);
}

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

/** Existing capture directories must not redirect writes through symlinks or junctions. */
async function sourceDirectory(path, create = false) {
  if (create) {
    try { await mkdir(path, {mode: 0o700}); }
    catch (error) { if (error.code !== 'EEXIST') throw error; }
  }
  const info = await lstat(path).catch(error => {
    if (error.code === 'ENOENT') return null;
    throw error;
  });
  if (!info) return false;
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('Source storage must be a regular directory');
  return true;
}

/** Raw source packets and serial metadata remain below regular directory ancestors. */
async function sourceStorage(root, create = false) {
  if (!await sourceDirectory(root)) throw new Error('Source root must be an existing regular directory');
  if (await sourceDirectory(join(root, 'raw'), create)) await sourceDirectory(join(root, 'raw', 'sources'), create);
  await sourceDirectory(join(root, 'meta'), create);
}

/** Existing packet files and serial counters must not redirect reads outside their vault. */
async function sourceFile(path) {
  const info = await lstat(path).catch(error => {
    if (error.code === 'ENOENT') return null;
    throw error;
  });
  if (!info) return false;
  if (!info.isFile() || info.isSymbolicLink()) throw new Error('Source storage must be a regular file');
  return true;
}

async function findDuplicate(sources, hash) {
  for (const id of await existingIds(sources)) {
    const packet = join(sources, id), manifestPath = join(packet, 'manifest.json'), originalPath = join(packet, 'extracted.md');
    if (!await sourceDirectory(packet)) continue;
    if (!await sourceFile(manifestPath) || !await sourceFile(originalPath)) continue;
    let manifest;
    try {
      manifest = JSON.parse(await readRegularPage(manifestPath));
    } catch (error) { continue; /* Unreadable legacy metadata supplies no duplicate match. */ }
    if (manifest?.content_sha256 !== hash) continue;
    const original = await readRegularPage(originalPath);
    if (original === null || digest(original) !== hash) throw new Error('Immutable source hash changed; inspect the packet before capturing again');
    return id;
  }
  return null;
}

/** Capture immutable Markdown only in regular storage directories; duplicates verify original bytes.
 * @param {string} vaultRoot Existing regular shared, private, or project vault directory.
 * @param {object} capture Title, Markdown, relative source identifier, and optional author.
 * @param {object} options Capture date for source ID allocation.
 * @returns {Promise<object>} Immutable packet ID, path, title, digest, and duplicate status.
 * @throws {Error} Invalid input, redirected storage, or changed duplicate source bytes.
 */
export async function ingestSession(vaultRoot, {title, text, source, author} = {}, {now = new Date()} = {}) {
  requireText(text, 'text', MAX_TEXT);
  requireText(title, 'title', MAX_TITLE);
  requireText(source, 'source', 200);
  if (!SAFE_SOURCE.test(source) || source.includes('..')) throw new Error('source must be a relative identifier without traversal');
  const authorName = typeof author === 'string' && author.trim() ? author.trim().slice(0, 64) : 'unknown';
  const sources = join(vaultRoot, 'raw', 'sources');
  const hash = digest(text);

  await sourceStorage(vaultRoot);
  return withLock(join(vaultRoot, LOCK), async () => {
    await sourceStorage(vaultRoot, true);
    const duplicate = await findDuplicate(sources, hash);
    if (duplicate) return {id: duplicate, path: join(sources, duplicate), duplicate: true, sha256: hash, title};

    const captured = now.toISOString().slice(0, 10);
    const ids = await existingIds(sources);
    // Allocate monotonically and never reuse a retired serial: wiki pages cite
    // [[sources/SRC-...]] by id, so a recycled id would silently repoint a citation.
    const counter = join(vaultRoot, 'meta', `kb-source-serial-${captured}`);
    let previous = 0;
    await sourceFile(counter);
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
    const staging = join(sources, `.${id}.${randomBytes(8).toString('hex')}.staging`);
    await mkdir(staging, {mode: 0o700});
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

export function documentContent(body, fallbackTitle, {forceTitle = false} = {}) {
  const title = forceTitle ? fallbackTitle : body.match(/^---\s*$[\s\S]*?^title:\s*(.+)$/m)?.[1]?.trim() ?? fallbackTitle;
  const text = body.replace(/^---[\s\S]*?---\s*/, '');
  const canonical = `${title}\n${text}`;
  return {title, text, hash: contentHash(needsChunks(title, text) ? `chunk-v1\0${canonical}` : canonical)};
}

// The editor-writable vault is a trust boundary: open and stat the SAME fd,
// rather than lstat(path) followed by a symlink-following readFile(path).
export async function readRegularPage(path, {maxChars = MAX_TEXT, maxBytes = MAX_TEXT * 3} = {}) {
  let handle;
  try { handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW); }
  catch (error) { if (['ENOENT', 'ELOOP', 'ENOTDIR'].includes(error.code)) return null; throw error; }
  try {
    const info = await handle.stat();
    if (!info.isFile() || info.size > maxBytes) return null;
    const body = await handle.readFile('utf8');
    return body.length <= maxChars && Buffer.byteLength(body) <= maxBytes ? body : null;
  } finally { await handle.close(); }
}

function documentPath(vaultRoot, id) {
  if (SOURCE_ID.test(id)) return join(vaultRoot, 'raw', 'sources', id, 'extracted.md');
  const parts = wikiParts(id);
  return parts ? join(vaultRoot, 'wiki', ...parts.slice(0, -1), parts.at(-1) + '.md') : null;
}

// The hash authorizes the bytes returned by this handle, including bytes beyond
// a search preview. Parent paths may change between lookup and open.
async function readGrantedFile(path, sha256) {
  if (!/^[a-f0-9]{64}$/.test(sha256 ?? '')) return null;
  let handle;
  try { handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0)); }
  catch (error) { if (['ENOENT', 'ELOOP', 'ENOTDIR', 'EACCES', 'EPERM'].includes(error.code)) return null; throw error; }
  try {
    const info = await handle.stat();
    if (!info.isFile() || info.size > MAX_DOCUMENT_BYTES) return null;
    const chunks = [];
    const buffer = Buffer.alloc(64 * 1024);
    let total = 0;
    for (;;) {
      const {bytesRead} = await handle.read(buffer, 0, Math.min(buffer.length, MAX_DOCUMENT_BYTES + 1 - total), null);
      if (!bytesRead) break;
      total += bytesRead;
      if (total > MAX_DOCUMENT_BYTES) return null;
      chunks.push(Buffer.from(buffer.subarray(0, bytesRead)));
    }
    const bytes = Buffer.concat(chunks, total);
    if (digest(bytes) !== sha256) return null;
    return {body: bytes.toString('utf8'), sourceBytes: total};
  } finally { await handle.close(); }
}

async function readGrantedDocument(vaultRoot, id, grant) {
  const path = documentPath(vaultRoot, id);
  if (!path) return null;
  const file = await readGrantedFile(path, grant?.sha256);
  return file && {...file, path};
}

/** Read a bounded page from an exact source or wiki ID. Offsets count Unicode characters. */
export async function readDocumentPage(vaultRoot, id, {start = 0, sha256, title: grantTitle} = {}) {
  if (!Number.isInteger(start) || start < 0 || start > MAX_READ_START || start % OPENING_CHARS !== 0 || typeof id !== 'string') return null;
  const file = await readGrantedDocument(vaultRoot, id, {sha256});
  if (!file) return null;
  const characters = Array.from(file.body);
  if (start >= characters.length) return null;
  const page = characters.slice(start, start + OPENING_CHARS);
  const endExclusive = start + page.length;
  const truncated = endExclusive < characters.length;
  const type = SOURCE_ID.test(id) ? 'source' : 'wiki';
  const title = grantTitle ?? (type === 'source' ? id : documentContent(file.body, wikiParts(id).at(-1)).title);
  return {id, title, type, body: page.join(''), start, endExclusive, sourceBytes: file.sourceBytes, truncated, nextStart: truncated ? endExclusive : null};
}

/** Restrict script preparation to the first 24000 characters of a granted document. */
export async function readOpening(vaultRoot, id, {start = 0, sha256, title} = {}) {
  if (!SOURCE_ID.test(id) || !Number.isInteger(start) || start < 0 || start >= OPENING_TOTAL_CHARS || start % OPENING_CHARS !== 0) return null;
  const page = await readDocumentPage(vaultRoot, id, {start, sha256, title});
  if (!page) return null;
  return {
    ...page,
    opening: page.body,
    nextStart: page.truncated && page.endExclusive < OPENING_TOTAL_CHARS ? page.endExclusive : null,
    limitReached: page.truncated && page.endExclusive >= OPENING_TOTAL_CHARS,
  };
}

/** Load grant-verified documents, retaining complete text for Wiki search, reads, and archival.
 * @param {string} vaultRoot Shared vault directory.
 * @param {Map} grants Account-visible exact-byte permissions.
 * @param {object} options Whether complete text is needed instead of the search preview.
 * @returns {Promise<object[]>} Documents whose complete bytes match their granted hashes.
 */
export async function collectGrantedDocuments(vaultRoot, grants, {fullText = false} = {}) {
  const documents = [];
  for (const [id, grant] of grants) {
    const file = await readGrantedDocument(vaultRoot, id, grant);
    if (!file) continue;
    const source = SOURCE_ID.test(id);
    const fallbackTitle = grant.title ?? (source ? id : wikiParts(id).at(-1));
    const body = fullText ? file.body : file.body.slice(0, MAX_TEXT);
    documents.push({id, body, path: file.path, ...documentContent(body, fallbackTitle, {forceTitle: source || grant.title !== undefined})});
  }
  return documents;
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
export async function searchVault(vaultRoot, {query, limit = 8, embedder, vectors, semanticWeight = 0.5, semanticFloor = 0.5, allowedGrants} = {}) {
  const raw = String(query ?? '').trim();
  if (!raw) return {ok: true, results: [], semantic: false};
  if (embedder?.enabled) vectors?.refresh?.();
  const documents = (allowedGrants ? await collectGrantedDocuments(vaultRoot, allowedGrants) : await collectDocuments(vaultRoot))
    .map(document => {
      if (allowedGrants?.get(document.id)?.level !== 'opening') return document;
      const visible = Array.from(document.body).slice(0, OPENING_TOTAL_CHARS).join('');
      return {...document, body: visible, ...documentContent(visible, document.title, {forceTitle: true})};
    });
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
    const stored = queryVector && allowedGrants?.get(document.id)?.level !== 'opening' ? vectors.get(document.id, document.hash) : null;
    const similar = stored ? Math.max(...(Array.isArray(stored[0]) ? stored : [stored]).map(vector => cosine(queryVector, vector))) : 0;
    // Without a stored vector a document can only be recalled lexically.
    const score = weight > 0 ? blendScore(lexical, stored ? similar : 0, weight) : lexical;
    return {id: document.id, title: document.title, path: document.path, score, lexical, similar, semanticMatched: !!stored && similar >= floor, preview: document.text.slice(0, 400)};
  }).filter(entry => entry.lexical > 0 || entry.semanticMatched)
    .sort((a, b) => b.score - a.score || a.id.localeCompare(b.id));

  return {ok: true, scanned: documents.length, semantic: !!queryVector, results: results.slice(0, size)};
}
