/** Pack the compiled Muse-owned adapter with matching Host metadata and no local connection files. */
import { cpSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { buildLvpaopao } from './build.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const repository = fileURLToPath(new URL('../../../../', import.meta.url));
const args = process.argv.slice(2);
if (args.length && (args.length !== 2 || args[0] !== '--out' || !isAbsolute(args[1]))) throw new Error('Use node scripts/pack.mjs [--out <absolute-directory>]');
const output = args[1] ?? join(root, 'releases');
const staging = mkdtempSync(join(tmpdir(), 'muse-lvpaopao-pack-'));
try {
  for (const name of ['package.json', 'cordis.patch.yml', 'README.md', 'README.zh.md', 'README.i18n.yaml', 'LICENSE']) cpSync(join(root, name), join(staging, name));
  buildLvpaopao(join(staging, 'lib'));
  const hostVersion = JSON.parse(readFileSync(join(repository, 'apps/desktop-host/package.json'), 'utf8')).version;
  const manifest = JSON.parse(readFileSync(join(staging, 'package.json'), 'utf8'));
  for (const [name, version] of Object.entries(manifest.peerDependencies)) {
    if (name.startsWith('@deepseek-ai/dsh-') && version !== hostVersion) throw new Error(`Incompatible Host peer ${name}`);
  }
  const files = Object.fromEntries(readdirSync(join(staging, 'lib')).sort().map(name => [
    `lib/${name}`, createHash('sha256').update(readFileSync(join(staging, 'lib', name))).digest('hex'),
  ]));
  writeFileSync(join(staging, 'SOURCE.json'), JSON.stringify({ name: manifest.name, hostVersion,
    source: 'Muse-owned Lvpaopao adapter', files, nativeHelperIncluded: false, connectionConfigurationIncluded: false }, null, 2) + '\n');
  const archives = join(staging, 'packed');
  mkdirSync(archives);
  const cli = process.env.npm_execpath;
  const packArgs = ['pack', '--pack-destination', archives];
  const result = spawnSync(cli ? process.execPath : 'npm', cli ? [cli, ...packArgs] : packArgs, {
    cwd: staging, encoding: 'utf8', env: { ...process.env, npm_config_ignore_scripts: 'true' },
  });
  if (result.error) throw result.error;
  if (result.status !== 0 || result.signal) throw new Error('Lvpaopao package creation failed: ' + result.stderr);
  const filename = `${manifest.name}-${manifest.version}.tgz`;
  if (JSON.stringify(readdirSync(archives)) !== JSON.stringify([filename])) throw new Error('Unexpected Lvpaopao archive filename');
  mkdirSync(output, { recursive: true });
  cpSync(join(archives, filename), join(output, filename));
  process.stdout.write(JSON.stringify({ package: join(output, filename), hostVersion }) + '\n');
} finally {
  rmSync(staging, { recursive: true, force: true });
}
