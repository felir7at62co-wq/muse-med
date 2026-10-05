/** Syntax-check each shipped JavaScript module without requiring a built Muse host. */
import { readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
const root = fileURLToPath(new URL('../', import.meta.url));
for (const file of readdirSync(join(root, 'src')).filter(name => name.endsWith('.js'))) {
  const result = spawnSync(process.execPath, ['--check', join(root, 'src', file)], { stdio: 'inherit' });
  if (result.status !== 0) process.exit(result.status ?? 1);
}
