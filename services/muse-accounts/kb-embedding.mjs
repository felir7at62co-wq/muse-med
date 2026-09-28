// Semantic embeddings for the cloud knowledge base.
//
// Provider: Volcengine ARK multimodal embeddings. Its shape is deliberately not
// the OpenAI one — `input` must be `[{type:'text',text}]`, the reply is a single
// `data.embedding` array, and one call returns exactly one 2048-dimension vector
// for one text. Measured on the live endpoint: identical text yields a
// byte-identical vector, so storing vectors and comparing by cosine is safe.
import {mkdir, rename, rmdir, rm, writeFile} from 'node:fs/promises';
import {readFileSync} from 'node:fs';
import {createHash, randomBytes} from 'node:crypto';
import {dirname} from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';

export const DEFAULT_ENDPOINT = 'https://ark.cn-beijing.volces.com/api/v3/embeddings/multimodal';
export const DEFAULT_MODEL = 'doubao-embedding-vision-251215';

/**
 * @param options.apiKey - provider credential; when absent the embedder is disabled.
 * @param options.fetchImpl - injectable for tests.
 */
export function createEmbedder({apiKey, model = DEFAULT_MODEL, endpoint = DEFAULT_ENDPOINT, fetchImpl = fetch, retries = 1, timeoutMs = 20000} = {}) {
  const enabled = typeof apiKey === 'string' && apiKey.trim().length > 0;
  async function attempt(text) {
    const response = await fetchImpl(endpoint, {
      method: 'POST',
      headers: {authorization: 'Bearer ' + apiKey, 'content-type': 'application/json'},
      body: JSON.stringify({model, input: [{type: 'text', text}]}),
      signal: AbortSignal.timeout(timeoutMs),
    });
    const payload = await response.json().catch(() => null);
    if (!response.ok) {
      const detail = String(payload?.error?.message ?? JSON.stringify(payload ?? {})).replaceAll(apiKey, '[REDACTED]').slice(0, 200);
      throw Object.assign(new Error(`Embedding provider rejected the request (${response.status}): ${detail}`), {status: response.status});
    }
    const vector = payload?.data?.embedding;
    if (!Array.isArray(vector) || !vector.length || vector.some(value => typeof value !== 'number' || !Number.isFinite(value))) {
      throw Object.assign(new Error('Embedding provider returned no usable embedding'), {status: 200});
    }
    return vector;
  }
  return {
    enabled,
    model,
    endpoint,
    async embed(text) {
      if (!enabled) throw new Error('Embedding is not configured');
      if (typeof text !== 'string' || !text.trim()) throw new Error('Embedding text is required');
      const body = text.length > 6000 ? text.slice(0, 6000) : text;
      let last;
      for (let attemptIndex = 0; attemptIndex <= retries; attemptIndex++) {
        try { return await attempt(body); }
        catch (error) {
          last = error;
          // Only transient conditions are worth a second call; a 4xx will not change.
          const transient = error.status === undefined || error.status >= 500 || error.status === 429;
          if (!transient) throw error;
        }
      }
      throw last;
    },
  };
}

const digest = value => createHash('sha256').update(value).digest('hex');
export const contentHash = text => digest(text);

// One provider call accepts one text. Keep a small overlap so a fact spanning
// a boundary can still appear intact in at least one chunk.
const MAX_INPUT = 6000;
export const needsChunks = (title, text) => text.length + Math.min(title.length, 200) + 1 > MAX_INPUT;
export function embeddingChunks(title, text) {
  const prefix = `${title.slice(0, 200)}\n`;
  const size = MAX_INPUT - prefix.length;
  if (text.length <= size) return [prefix + text];
  const chunks = [];
  for (let start = 0; start < text.length; start += size - 200) chunks.push(prefix + text.slice(start, start + size));
  return chunks;
}

/** Cosine similarity, guarded against zero vectors. */
export function cosine(left, right) {
  if (!Array.isArray(left) || !Array.isArray(right) || left.length !== right.length || !left.length) return 0;
  let dot = 0, leftNorm = 0, rightNorm = 0;
  for (let index = 0; index < left.length; index++) {
    dot += left[index] * right[index];
    leftNorm += left[index] * left[index];
    rightNorm += right[index] * right[index];
  }
  if (leftNorm === 0 || rightNorm === 0) return 0;
  return dot / (Math.sqrt(leftNorm) * Math.sqrt(rightNorm));
}

/** Blend a 0..1 lexical score with cosine similarity; weight 0 stays purely lexical. */
export function blendScore(lexical, semantic, weight) {
  const w = Math.min(1, Math.max(0, Number(weight) || 0));
  const semanticPart = Math.min(1, Math.max(0, semantic));
  return lexical * (1 - w) + semanticPart * w;
}

/**
 * Sidecar vector index. Entries are keyed by document id and carry the content
 * hash and model that produced them, so edited content and model changes are
 * detected rather than silently compared against a stale vector.
 */
export function openVectorIndex({file, model = DEFAULT_MODEL} = {}) {
  if (!file) throw new Error('Vector index file is required');
  function load() {
    let raw;
    try { raw = readFileSync(file, 'utf8'); }
    catch (error) { if (error.code === 'ENOENT') return new Map(); throw error; }
    let parsed;
    try { parsed = JSON.parse(raw); }
    catch (error) { throw new Error(`Invalid vector index JSON: ${file}`, {cause: error}); }
    if (parsed?.version !== 1 || typeof parsed.model !== 'string' || !parsed.model
      || !parsed.entries || typeof parsed.entries !== 'object' || Array.isArray(parsed.entries)) {
      throw new Error(`Invalid vector index format: ${file}`);
    }
    if (parsed.model !== model) return new Map();
    const numeric = vector => Array.isArray(vector) && vector.length > 0
      && vector.every(number => typeof number === 'number' && Number.isFinite(number));
    return new Map(Object.entries(parsed.entries).filter(([, value]) =>
      typeof value?.hash === 'string' && (numeric(value.vector)
        || Array.isArray(value.vector) && value.vector.length > 0 && value.vector.every(numeric))));
  }
  let entries = load();
  const pending = new Map(), removed = new Set();
  let saveQueue = Promise.resolve();
  function refresh() {
    entries = load();
    for (const id of removed) entries.delete(id);
    for (const [id, entry] of pending) entries.set(id, entry);
  }
  async function saveNow() {
    if (!pending.size && !removed.size) return;
    await mkdir(dirname(file), {recursive: true});
    const lock = `${file}.lock`, started = Date.now();
    for (;;) {
      try { await mkdir(lock); break; }
      catch (error) {
        if (error.code !== 'EEXIST') throw error;
        if (Date.now() - started > 20000) throw new Error(`Vector index busy; inspect stale lock: ${lock}`);
        await delay(30);
      }
    }
    let temporary;
    try {
      const updates = new Map(pending), deletions = new Set(removed), merged = load();
      for (const id of deletions) merged.delete(id);
      for (const [id, entry] of updates) merged.set(id, entry);
      temporary = `${file}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
      await writeFile(temporary, JSON.stringify({version: 1, model, entries: Object.fromEntries(merged)}), {mode: 0o600, flag: 'wx'});
      await rename(temporary, file);
      for (const [id, entry] of updates) if (pending.get(id) === entry) pending.delete(id);
      for (const id of deletions) removed.delete(id);
      refresh();
    } finally {
      if (temporary) await rm(temporary, {force: true});
      await rmdir(lock);
    }
  }
  return {
    file, model, refresh,
    size: () => entries.size,
    get(id, hash) {
      const entry = entries.get(id);
      return entry && entry.hash === hash ? entry.vector : null;
    },
    put(id, entry) { removed.delete(id); pending.set(id, entry); entries.set(id, entry); },
    has: id => entries.has(id),
    ids: () => new Set(entries.keys()),
    prune(validIds) {
      for (const id of entries.keys()) if (!validIds.has(id)) { pending.delete(id); removed.add(id); entries.delete(id); }
    },
    save() {
      const next = saveQueue.then(saveNow);
      saveQueue = next.catch(() => {});
      return next;
    },
  };
}
