// Resumable source/wiki vector backfill. Run alongside the development gateway:
// the index writer merges under a cross-process lock at each checkpoint.
import {readFile} from 'node:fs/promises';
import {realpathSync} from 'node:fs';
import {pathToFileURL} from 'node:url';
import {collectDocuments} from './kb-vault.mjs';
import {createEmbedder, embeddingChunks, openVectorIndex} from './kb-embedding.mjs';

export async function reindexVault(vaultRoot, {embedder, vectors, batchSize = 20, onProgress = () => {}} = {}) {
  if (!embedder?.enabled || !vectors) throw new Error('Embedding is not configured');
  if (!Number.isSafeInteger(batchSize) || batchSize < 1) throw new Error('Invalid checkpoint batch size');
  vectors.refresh();
  const documents = await collectDocuments(vaultRoot);
  let added = 0, skipped = 0, pending = 0;
  try {
    for (const document of documents) {
      if (vectors.get(document.id, document.hash)) { skipped++; continue; }
      const chunks = [];
      for (const part of embeddingChunks(document.title, document.text)) chunks.push(await embedder.embed(part));
      vectors.put(document.id, {hash: document.hash, vector: chunks.length === 1 ? chunks[0] : chunks});
      added++;
      if (++pending >= batchSize) {
        await vectors.save();
        pending = 0;
        onProgress({added, skipped, total: documents.length});
      }
    }
  } finally {
    if (pending) await vectors.save();
  }
  // Scan once more before pruning: a packet ingested while backfilling must not
  // have its vector removed merely because it was absent from the initial list.
  vectors.refresh();
  vectors.prune(new Set((await collectDocuments(vaultRoot)).map(document => document.id)));
  await vectors.save();
  return {added, skipped, total: documents.length, indexed: vectors.size()};
}

if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  const vaultRoot = process.env.MUSE_KB_VAULT, file = process.env.MUSE_KB_VECTORS, keyFile = process.env.MUSE_KB_EMBEDDING_KEY;
  if (!vaultRoot || !file || !keyFile) throw new Error('MUSE_KB_VAULT, MUSE_KB_VECTORS and MUSE_KB_EMBEDDING_KEY file are required');
  const apiKey = (await readFile(keyFile, 'utf8')).trim();
  const embedder = createEmbedder({apiKey, ...process.env.MUSE_KB_EMBEDDING_MODEL ? {model: process.env.MUSE_KB_EMBEDDING_MODEL} : {}, ...process.env.MUSE_KB_EMBEDDING_ENDPOINT ? {endpoint: process.env.MUSE_KB_EMBEDDING_ENDPOINT} : {}});
  const vectors = openVectorIndex({file, model: embedder.model});
  const result = await reindexVault(vaultRoot, {embedder, vectors, onProgress: ({added, skipped, total}) => console.log(`向量回填：新增 ${added}、跳过 ${skipped}、共 ${total}`)});
  console.log('向量回填完成：' + JSON.stringify(result));
}
