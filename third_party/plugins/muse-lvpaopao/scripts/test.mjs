/** Run owned regressions through the repository's supported TypeScript source loader. */
import { readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

const root = fileURLToPath(new URL('../', import.meta.url));
const repository = fileURLToPath(new URL('../../../../', import.meta.url));
const files = readdirSync(join(root, 'tests')).filter(name => name.endsWith('.test.mjs')).sort();
const result = spawnSync(process.execPath, ['--import', 'tsx/esm', '--test', ...files.map(name => join(root, 'tests', name))], {
  cwd: repository,
  stdio: 'inherit',
  env: { ...process.env, TSX_TSCONFIG_PATH: join(repository, 'tsconfig.base.json') },
});
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
