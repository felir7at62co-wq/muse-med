/** Compile the owned adapter against the already-built matching Harness installation. */
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const root = fileURLToPath(new URL('../', import.meta.url));
const repository = fileURLToPath(new URL('../../../../', import.meta.url));
const peers = {
  '@deepseek-ai/cordis': 'vendor/cordis',
  '@deepseek-ai/schemastery': 'vendor/schemastery',
  '@deepseek-ai/dsh-tools': 'packages/core/tools',
  '@deepseek-ai/dsh-agent': 'packages/core/agent',
  '@deepseek-ai/dsh-session': 'packages/core/session',
  '@deepseek-ai/dsh-subprocess': 'packages/subprocess/subprocess',
  '@deepseek-ai/dsh-sandbox-policy': 'packages/sandbox/sandbox-policy',
  '@deepseek-ai/dsh-home-paths': 'packages/util/home-paths',
};

/**
 * Compile into an owned destination without installing or copying runtime peers.
 * @param {string} output - Package lib directory or a private packaging directory.
 * @returns {void} After a successful strict compiler run and output copy.
 */
export function buildLvpaopao(output) {
  const staging = mkdtempSync(join(tmpdir(), 'muse-lvpaopao-build-'));
  try {
    for (const name of ['src', 'package.json', 'tsconfig.json']) cpSync(join(root, name), join(staging, name), { recursive: true });
    const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
    for (const [name, path] of Object.entries(peers)) {
      if (!Object.hasOwn(manifest.peerDependencies, name)) throw new Error(`Missing runtime peer ${name}`);
      const source = join(repository, path);
      if (!existsSync(join(source, 'lib'))) throw new Error(`Build the Harness peer before packing: ${name}`);
      const destination = join(staging, 'node_modules', name);
      mkdirSync(join(destination, '..'), { recursive: true });
      symlinkSync(source, destination, process.platform === 'win32' ? 'junction' : 'dir');
    }
    mkdirSync(join(staging, 'node_modules', '@types'), { recursive: true });
    symlinkSync(join(repository, 'node_modules/@types/node'), join(staging, 'node_modules/@types/node'), process.platform === 'win32' ? 'junction' : 'dir');
    const result = spawnSync(process.execPath, [join(repository, 'node_modules/typescript/bin/tsc'), '-p', join(staging, 'tsconfig.json')], {
      cwd: repository, stdio: 'inherit',
    });
    if (result.error) throw result.error;
    if (result.status !== 0 || result.signal) throw new Error('Lvpaopao TypeScript build failed');
    rmSync(output, { recursive: true, force: true });
    mkdirSync(output, { recursive: true });
    cpSync(join(staging, 'lib'), output, { recursive: true });
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) buildLvpaopao(join(root, 'lib'));
