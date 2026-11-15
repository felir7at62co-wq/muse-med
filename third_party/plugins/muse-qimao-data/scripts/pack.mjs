/** Pack only reviewed metadata source and notices in private staging, bound to the current Host version. */
import { createHash } from 'node:crypto';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const args = process.argv.slice(2);
if (args.length && (args.length !== 2 || args[0] !== '--out' || !isAbsolute(args[1]))) throw new Error('Use node scripts/pack.mjs [--out <absolute-directory>]');
const output = args[1] ?? join(root, 'dist');
const host = JSON.parse(readFileSync(new URL('../../../../apps/desktop-host/package.json', import.meta.url), 'utf8'));
const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
if (['@deepseek-ai/dsh-tools', '@deepseek-ai/dsh-brand'].some(name => manifest.peerDependencies[name] !== host.version)) throw new Error('Qimao peers must match the current Host version');
mkdirSync(output, { recursive: true });
const staging = mkdtempSync(join(tmpdir(), 'muse-qimao-pack-'));
try {
  const files = ['package.json', 'src', 'cordis.patch.yml', 'README.md', 'README.zh.md', 'README.i18n.yaml', 'LICENSE', 'THIRD_PARTY_NOTICES.md'];
  for (const file of files) cpSync(join(root, file), join(staging, file), { recursive: true });
  const hashes = {};
  for (const file of readdirSync(join(root, 'src')).sort()) hashes[`src/${file}`] = createHash('sha256').update(readFileSync(join(root, 'src', file))).digest('hex');
  writeFileSync(join(staging, 'SOURCE.json'), JSON.stringify({ name: manifest.name, hostVersion: host.version,
    reference: { repository: 'https://github.com/felir7at62co-wq/oh-story-claudecode', file: 'skills/story-long-scan/scripts/qimao-rank-scraper.js', blob: '399812177eba3b319a636d187e8cc617646ff1c3', license: 'MIT' },
    sourceFiles: hashes, dependencies: manifest.dependencies }, null, 2) + '\n');
  const cli = process.env.npm_execpath;
  const packArgs = ['pack', '--json', '--pack-destination', output];
  const result = spawnSync(cli ? process.execPath : 'npm', cli ? [cli, ...packArgs] : packArgs, {
    cwd: staging, encoding: 'utf8', env: { ...process.env, npm_config_ignore_scripts: 'true' },
  });
  if (result.error) throw result.error;
  if (result.status !== 0 || result.signal) throw new Error(`Qimao package creation failed: ${result.stderr}`);
  const packed = JSON.parse(result.stdout), entry = Array.isArray(packed) ? packed[0] : packed;
  const archive = join(output, `${manifest.name}-${manifest.version}.tgz`);
  if (typeof entry?.filename !== 'string' || resolve(output, entry.filename) !== archive) throw new Error('Unexpected Qimao package filename');
  process.stdout.write(JSON.stringify({ package: archive, hostVersion: host.version }) + '\n');
} finally { rmSync(staging, { recursive: true, force: true }); }
