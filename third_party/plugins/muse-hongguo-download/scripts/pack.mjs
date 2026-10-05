/** Produce a host-version-matched tarball; credentials and local source configuration are never packed. */
import { mkdirSync, readFileSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
const root = fileURLToPath(new URL('../', import.meta.url));
const args = process.argv.slice(2);
if (args.length && (args.length !== 2 || args[0] !== '--out' || !isAbsolute(args[1]))) throw new Error('Usage: node scripts/pack.mjs [--out <absolute directory>]');
const output = args[1] ?? join(root, 'releases');
const source = JSON.parse(readFileSync(join(root, 'SOURCE.json'), 'utf8'));
const host = JSON.parse(readFileSync(new URL('../../../../apps/desktop-host/package.json', import.meta.url), 'utf8'));
const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
if (source.hostVersion !== host.version || manifest.peerDependencies['@deepseek-ai/dsh-tools'] !== host.version
  || manifest.peerDependencies['@deepseek-ai/dsh-agent'] !== host.version
  || manifest.peerDependencies['@deepseek-ai/dsh-subprocess'] !== host.version) throw new Error('Rebuild SOURCE.json and host peer versions for this Muse release');
mkdirSync(output, { recursive: true });
const npm = process.env.npm_execpath;
const result = npm ? spawnSync(process.execPath, [npm, 'pack', '--ignore-scripts', '--pack-destination', output], { cwd: root, stdio: 'inherit' })
  : spawnSync('npm', ['pack', '--ignore-scripts', '--pack-destination', output], { cwd: root, stdio: 'inherit', shell: false });
process.exitCode = result.status ?? 1;
