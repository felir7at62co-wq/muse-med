/** Rebuild the GPL engine from its retained, checksum-verified corresponding source archive. */
import { build } from '../../../../node_modules/esbuild/lib/main.js';
import { extract } from 'tar';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
const root = fileURLToPath(new URL('../', import.meta.url));
const source = JSON.parse(await readFile(join(root, 'SOURCE.json'), 'utf8'));
const archive = join(root, source.sourceArchive);
if (createHash('sha256').update(await readFile(archive)).digest('hex') !== source.sourceArchiveSha256) throw new Error('Hongguo source archive changed');
const directory = await mkdtemp(join(tmpdir(), 'hongguo-engine-build-'));
try {
  await extract({ file: archive, cwd: directory, strict: true });
  await build({ absWorkingDir: directory, entryPoints: ['src/native/hongguo.js'], outfile: root + 'upstream/engine.cjs', bundle: true,
    platform: 'node', format: 'cjs', target: 'node22', external: ['electron'], nodePaths: [join(directory, 'dependencies')],
    legalComments: 'inline', banner: { js: `/* GPL-3.0: ${source.repository} ${source.revision}; corresponding source: source.tar.gz */` } });
} finally { await rm(directory, { recursive: true, force: true }); }
