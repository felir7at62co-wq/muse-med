/** Pack Muse-owned download tools independently of the retained community source inventory. */
import { readFileSync, mkdirSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { spawnSync } from 'node:child_process';

const root = fileURLToPath(new URL('.', import.meta.url));
const { values } = parseArgs({ options: { out: { type: 'string' }, only: { type: 'string' } } });
const pins = JSON.parse(readFileSync(join(root, 'owned-downloads.json'), 'utf8'));
const output = resolve(values.out || join(root, '../../.artifacts/download-plugins'));
if (values.only && !Object.hasOwn(pins, values.only)) throw new Error('Unknown Muse download tool');
mkdirSync(output, { recursive: true });
for (const [name, pin] of Object.entries(pins)) {
  if (values.only && values.only !== name) continue;
  const directory = join(root, name);
  const manifest = JSON.parse(readFileSync(join(directory, 'package.json'), 'utf8'));
  if (manifest.name !== name || manifest.version !== pin.version || !manifest.dsh?.bundle?.patch) {
    throw new Error(`Invalid Muse download bundle: ${name}`);
  }
  const result = spawnSync(process.execPath, [join(directory, 'scripts/pack.mjs'), '--out', output], {
    cwd: directory, stdio: 'inherit',
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`Packing ${name} failed`);
}
