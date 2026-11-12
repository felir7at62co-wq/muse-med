/** Reject a changed engine or corresponding source archive before packaging. */
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
const root = new URL('../', import.meta.url);
const source = JSON.parse(readFileSync(new URL('SOURCE.json', root), 'utf8'));
const hash = file => createHash('sha256').update(readFileSync(new URL(file, root))).digest('hex');
if (hash('upstream/engine.cjs') !== source.engineSha256) throw new Error('Hongguo engine checksum mismatch');
if (hash(source.sourceArchive) !== source.sourceArchiveSha256) throw new Error('Hongguo corresponding source checksum mismatch');
for (const patch of source.localPatches) {
  if (!/^patches\/[a-z0-9-]+\.patch$/.test(patch.file) || hash(patch.file) !== patch.sha256) throw new Error('Hongguo local patch checksum mismatch');
}
