/** Pack the current host's canonical Douyin runtime without modifying source files. */
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const repository = resolve(root, '../../..');
const args = process.argv.slice(2);
if (args.length !== 0 && (args.length !== 2 || args[0] !== '--out' || !isAbsolute(args[1]))) throw new Error('Use node scripts/pack.mjs [--out <absolute-directory>]');
const output = args.length ? args[1] : join(root, 'dist');
mkdirSync(output, { recursive: true });
const staging = mkdtempSync(join(tmpdir(), 'muse-douyin-pack-'));
try {
  for (const name of ['package.json', 'src', 'cordis.patch.yml', 'README.md', 'README.zh.md', 'README.i18n.yaml', 'LICENSE']) cpSync(join(root, name), join(staging, name), { recursive: true });
  const skill = join(repository, 'apps/desktop-host/skills/douyin-download');
  mkdirSync(join(staging, 'python'));
  cpSync(join(skill, 'runtime'), join(staging, 'python/runtime'), { recursive: true });
  // The canonical script expects runtime/ beside scripts/; the package preserves that layout.
  mkdirSync(join(staging, 'python/scripts'));
  cpSync(join(skill, 'scripts/download.py'), join(staging, 'python/scripts/download.py'));
  const runtime = JSON.parse(readFileSync(join(skill, 'runtime/SOURCE.json'), 'utf8'));
  const hostVersion = JSON.parse(readFileSync(join(repository, 'apps/desktop-host/package.json'), 'utf8')).version;
  writeFileSync(join(staging, 'SOURCE.json'), JSON.stringify({ name: 'muse-douyin-download', hostVersion,
    hostProtocolVersion: 6, browserBridgeVersion: 3,
    script: 'apps/desktop-host/skills/douyin-download/scripts/download.py',
    scriptSha256: createHash('sha256').update(readFileSync(join(skill, 'scripts/download.py'))).digest('hex'), runtime }, null, 2) + '\n');
  const cli = process.env.npm_execpath;
  const packArgs = ['pack', '--json', '--pack-destination', output];
  const result = spawnSync(cli ? process.execPath : 'npm', cli ? [cli, ...packArgs] : packArgs,
    { cwd: staging, encoding: 'utf8', env: { ...process.env, npm_config_ignore_scripts: 'true' } });
  if (result.error) throw result.error;
  if (result.status !== 0 || result.signal) throw new Error('Douyin package creation failed');
  const packed = JSON.parse(result.stdout);
  const { filename } = Array.isArray(packed) ? packed[0] : packed;
  const manifest = JSON.parse(readFileSync(join(staging, 'package.json'), 'utf8'));
  const archive = join(output, `${manifest.name}-${manifest.version}.tgz`);
  if (typeof filename !== 'string' || resolve(output, filename) !== archive) throw new Error('Unexpected Douyin package filename');
  process.stdout.write(JSON.stringify({ package: archive, hostVersion }) + '\n');
} finally { rmSync(staging, { recursive: true, force: true }); }
