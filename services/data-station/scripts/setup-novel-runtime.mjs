/** Installs the pinned free-reading runtime inside this data project's own ignored data directory. */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, realpathSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = realpathSync(fileURLToPath(new URL('../', import.meta.url)));
const args = process.argv.slice(2);
if (args.length && (args.length !== 2 || args[0] !== '--python')) throw new Error('Usage: node scripts/setup-novel-runtime.mjs [--python /absolute/python3]');
const sourcePython = args[1] ?? 'python3';
const runtime = resolve(root, '.data/novel-runtime');
let parent = runtime;
while (!existsSync(parent)) parent = dirname(parent);
if (realpathSync(parent) !== parent) throw new Error('Symlinked novel runtime directories are not allowed');
mkdirSync(runtime, { recursive: true, mode: 0o700 });
if (realpathSync(runtime) !== runtime) throw new Error('Symlinked novel runtime directories are not allowed');
const environment = { PATH: process.env.PATH ?? '/usr/bin:/bin' };
for (const key of ['HTTPS_PROXY', 'HTTP_PROXY', 'ALL_PROXY', 'NO_PROXY', 'https_proxy', 'http_proxy', 'all_proxy', 'no_proxy', 'SSL_CERT_FILE', 'SSL_CERT_DIR']) {
  if (process.env[key]) environment[key] = process.env[key];
}
function run(executable, parameters) {
  const result = spawnSync(executable, parameters, { cwd: root, env: environment, stdio: 'inherit' });
  if (result.error || result.status !== 0) throw new Error('Novel runtime setup did not complete');
}
const python = resolve(runtime, process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python3');
if (!existsSync(python)) run(sourcePython, ['-m', 'venv', runtime]);
run(python, ['-I', '-m', 'pip', 'install', '--disable-pip-version-check', '--no-deps', '--only-binary=:all:', '--index-url', 'https://pypi.org/simple', '-r', resolve(root, 'third_party/fanqie-original/requirements.txt')]);
run(python, ['-I', '-B', '-X', 'utf8', '-c', 'import Crypto, ssl; from Crypto.Cipher import AES; print("Novel runtime ready; PyCryptodome " + Crypto.__version__); ssl.create_default_context()']);
console.log(`Python: ${python}`);
