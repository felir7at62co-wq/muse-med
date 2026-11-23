import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { lstat, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { promisify } from 'node:util';
import { pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

const execute = promisify(execFile);
const roots: string[] = [];
const moduleUrl = pathToFileURL(resolve('scripts/prepare-cloud-release.mjs')).href;
const packaging = await import(moduleUrl);
const prepareCloudRelease: (options: { cwd: string; nodeModulesRoot: string; allowDirty?: boolean; buildClient: boolean }) => Promise<{
  archive: string; sha256: string; manifest: string; stagingDirectory: string;
}> = packaging.prepareCloudRelease;
interface ArchiveInventory { files: { path: string; linkTarget?: string }[]; directories: string[]; }
const verifyCloudArchive: (archive: string, manifest: ArchiveInventory) => Promise<{
  total: number; files: number; links: number; directories: number;
}> = packaging.verifyCloudArchive;

async function put(root: string, path: string, value: string | Uint8Array) {
  const target = resolve(root, path); await mkdir(dirname(target), { recursive: true }); await writeFile(target, value);
}
async function fixture() {
  await mkdir(resolve('.data'), { recursive: true });
  const root = await mkdtemp(resolve('.data', 'cloud-packaging-')); roots.push(root);
  const files: Record<string, string> = {
    'package.json': JSON.stringify({ name: 'muse-data-web', version: '0.1.0', type: 'module', dependencies: { 'fixture-runtime': '1.2.3' } }),
    'pnpm-lock.yaml': 'lockfileVersion: 9\nfixture-production-pin: 1.2.3\n',
    'dist-server/main.js': 'import "fixture-runtime";\nconsole.log("fixture-built-server");\n',
    '.data/cloud-release-pack/dist/index.html': '<script type="module" src="/data/assets/app.js"></script><link href="/data/assets/app.css" rel="stylesheet">',
    '.data/cloud-release-pack/dist/assets/app.js': 'document.body.dataset.fixture="cloud-base";\n',
    '.data/cloud-release-pack/dist/assets/app.css': 'body { margin: 0 }\n',
    'third_party/fanqie-original/worker.py': 'print("fixture source, not executed")\n',
    'third_party/fanqie-original/engine.py': 'ENGINE = "fixture"\n',
    'third_party/fanqie-original/LICENSE': 'Fixture license\n',
    'third_party/fanqie-original/requirements.txt': 'pycryptodome==3.23.0\n',
    'scripts/setup-novel-runtime.mjs': 'export const fixtureSetup = true;\n',
    'src/server/collectors/qimao/LICENSE': 'Fixture metadata license\n',
    'src/server/collectors/qimao/THIRD_PARTY_NOTICES.md': 'Fixture metadata source reference\n',
    'deps/node_modules/.pnpm/fixture-runtime@1.2.3/node_modules/fixture-runtime/package.json': JSON.stringify({ name: 'fixture-runtime', version: '1.2.3', type: 'module', exports: './index.js' }),
    'deps/node_modules/.pnpm/fixture-runtime@1.2.3/node_modules/fixture-runtime/index.js': 'export const runtime = true;\n',
    'deps/node_modules/.pnpm/fixture-runtime@1.2.3/node_modules/fixture-runtime/runtime.wasm': '\0asm\x01\0\0\0',
    '.env.example': 'EXAMPLE_TEMPLATE_MUST_NOT_SHIP\n',
    '.data/live/database.bin': 'PRIVATE_DATABASE_MUST_NOT_SHIP\n',
    'tests/body-fixture.txt': 'TEST_MUST_NOT_SHIP\n',
    'third_party/fanqie-original/test_worker.py': 'SOURCE_TEST_MUST_NOT_SHIP\n',
    'third_party/fanqie-original/__pycache__/cache.pyc': 'CACHE_MUST_NOT_SHIP\n',
    'third_party/fanqie-original/credentials.json': 'CREDENTIALS_MUST_NOT_SHIP\n',
    'third_party/fanqie-original/unknown-private.json': 'UNAPPROVED_SOURCE_FILE_MUST_NOT_SHIP\n',
    'deps/node_modules/.pnpm/fixture-runtime@1.2.3/node_modules/fixture-runtime/tests/secret.test.js': 'DEPENDENCY_TEST_MUST_NOT_SHIP\n',
    'deps/node_modules/.pnpm/fixture-runtime@1.2.3/node_modules/fixture-runtime/.env': 'DEPENDENCY_ENV_MUST_NOT_SHIP\n',
    'node_modules/root-sentinel': 'ROOT_DEPS_MUST_REMAIN_UNCHANGED\n',
    'dist/local-preview-sentinel': 'ROOT_DIST_MUST_REMAIN_UNCHANGED\n',
  };
  for (const [path, value] of Object.entries(files)) await put(root, path, value);
  await mkdir(resolve(root, '.data/cloud-release-pack/dist/empty-assets'));
  await symlink('.pnpm/fixture-runtime@1.2.3/node_modules/fixture-runtime', resolve(root, 'deps/node_modules/fixture-runtime'));
  return { root, options: { cwd: root, nodeModulesRoot: resolve(root, 'deps/node_modules'), allowDirty: true, buildClient: false } };
}

afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });

describe('isolated cloud release packaging', () => {
  it('allows .env.example, creates a real relocatable tar, verifies hashes and excludes sensitive or unrelated trees', async () => {
    const { root, options } = await fixture();
    if (process.platform === 'darwin') await execute('xattr', ['-w', 'com.apple.cloud-packaging-fixture', 'nonsecret-fixture', resolve(root, 'dist-server/main.js')]);
    const packed = await prepareCloudRelease(options);
    const archiveBytes = await readFile(packed.archive);
    expect(packed.sha256).toBe(createHash('sha256').update(archiveBytes).digest('hex'));
    const list = (await execute('tar', ['-tzf', packed.archive])).stdout.trim().split('\n');
    expect(list).toContain('app/dist/index.html'); expect(list).toContain('app/dist-server/main.js');
    expect(list.some(path => path.endsWith('/runtime.wasm'))).toBe(true);
    expect(list.some(path => /\.env|\.data|__pycache__|test_worker|secret\.test|credentials|unknown-private|root-sentinel|local-preview-sentinel/.test(path))).toBe(false);
    const manifest = JSON.parse(await readFile(packed.manifest, 'utf8'));
    const inventory: ArchiveInventory = manifest;
    expect(list.toSorted()).toEqual(['app/', 'app/RELEASE.json', ...inventory.directories.map(path => `app/${path}/`), ...inventory.files.map(record => `app/${record.path}`)].toSorted());
    expect(list.some(path => path.split('/').some(part => part.startsWith('._')))).toBe(false);
    expect(inventory.directories).toContain('dist/empty-assets');
    expect(await verifyCloudArchive(packed.archive, inventory)).toEqual({ total: list.length,
      files: inventory.files.filter(record => !record.linkTarget).length + 1, links: inventory.files.filter(record => record.linkTarget).length,
      directories: inventory.directories.length + 1 });
    expect(manifest).toMatchObject({ sourceDirty: true, assetsBase: '/data/', target: { os: 'linux', arch: 'x64', node: '24.21.0' },
      dependenciesPin: { direct: { 'fixture-runtime': '1.2.3' }, qualification: 'portable-javascript-and-wasm' } });
    expect(manifest.serverSHA256).toBe(createHash('sha256').update(await readFile(resolve(root, 'dist-server/main.js'))).digest('hex'));
    const extracted = resolve(root, 'extracted'); await mkdir(extracted); await execute('tar', ['-xzf', packed.archive, '-C', extracted]);
    const runtime = await import(pathToFileURL(resolve(extracted, 'app/node_modules/fixture-runtime/index.js')).href);
    expect(runtime.runtime).toBe(true);
    expect((await lstat(resolve(packed.stagingDirectory, 'package.json'))).mode & 0o777).toBe(0o644);
    expect((await lstat(packed.stagingDirectory)).mode & 0o777).toBe(0o755);
    expect(await readFile(resolve(root, 'node_modules/root-sentinel'), 'utf8')).toBe('ROOT_DEPS_MUST_REMAIN_UNCHANGED\n');
    expect(await readFile(resolve(root, 'dist/local-preview-sentinel'), 'utf8')).toBe('ROOT_DIST_MUST_REMAIN_UNCHANGED\n');
    expect((await readFile(resolve(extracted, 'app/RELEASE.json'), 'utf8'))).not.toContain('MUST_NOT_SHIP');
  });

  it.each(['outer-appledouble', 'undeclared-file', 'missing-member', 'wrong-type', 'wrong-link-target', 'duplicate-member'] as const)('rejects a real archive that differs from its manifest: %s', async change => {
    const f = await fixture(); const packed = await prepareCloudRelease(f.options);
    const inventory: ArchiveInventory = JSON.parse(await readFile(packed.manifest, 'utf8'));
    const app = packed.stagingDirectory, stage = dirname(app), archive = resolve(f.root, 'tampered.tar.gz');
    const extra: string[] = [];
    if (change === 'outer-appledouble' && process.platform !== 'darwin') { await put(f.root, '._app', 'UNDECLARED_MAC_METADATA'); extra.push('-C', f.root, '._app'); }
    if (change === 'undeclared-file') await put(app, 'dist/undeclared.js', 'UNDECLARED_FILE');
    if (change === 'missing-member') await rm(resolve(app, 'dist/empty-assets'), { recursive: true });
    if (change === 'wrong-type') { await rm(resolve(app, 'dist/assets/app.js')); await symlink('app.css', resolve(app, 'dist/assets/app.js')); }
    if (change === 'wrong-link-target') {
      await rm(resolve(app, 'node_modules/fixture-runtime'));
      await symlink('.pnpm/fixture-runtime@1.2.3/node_modules/fixture-runtime/index.js', resolve(app, 'node_modules/fixture-runtime'));
    }
    if (change === 'duplicate-member') extra.push('app/dist/assets/app.js');
    const flags = ['--no-xattrs', '--no-acls', ...(process.platform === 'darwin' ? ['--no-mac-metadata', '--no-fflags'] : [])];
    if (change === 'outer-appledouble' && process.platform === 'darwin') {
      await execute('xattr', ['-w', 'com.apple.cloud-packaging-fixture', 'nonsecret-fixture', app]);
      const environment = { ...process.env }; delete environment.COPYFILE_DISABLE; delete environment.COPY_EXTENDED_ATTRIBUTES_DISABLE;
      await execute('tar', ['--mac-metadata', '-czf', archive, '-C', stage, 'app'], { env: environment });
      const actual = JSON.parse((await execute('python3', ['-c', 'import json,sys,tarfile; print(json.dumps([member.name for member in tarfile.open(sys.argv[1])]))', archive])).stdout);
      expect(actual).toContain('._app');
    } else {
      await execute('tar', [...flags, '-czf', archive, '-C', stage, 'app', ...extra], {
        env: { ...process.env, COPYFILE_DISABLE: '1', COPY_EXTENDED_ATTRIBUTES_DISABLE: '1' },
      });
    }
    await expect(verifyCloudArchive(archive, inventory)).rejects.toThrow(change === 'outer-appledouble' ? /outside app\/ or AppleDouble/ : /Cloud archive/);
  });

  it.each(['.env', '.env.production', '.env.local', '.env.example.local'])('rejects actual dotenv %s before touching staging even when the client build is skipped', async name => {
    const f = await fixture(); await put(f.root, name, 'PRIVATE_CONTENT_MUST_NOT_BE_READ\n');
    await put(f.root, '.data/cloud-release-pack/app/keep', 'STAGING_MUST_REMAIN\n');
    await expect(prepareCloudRelease(f.options)).rejects.toThrow('without dotenv files');
    expect(await readFile(resolve(f.root, '.data/cloud-release-pack/app/keep'), 'utf8')).toBe('STAGING_MUST_REMAIN\n');
    expect((await readdir(f.root)).includes('artifacts')).toBe(false);
  });

  it('rejects missing built output and a wrong asset base before creating a release archive', async () => {
    const missing = await fixture(); await rm(resolve(missing.root, 'dist-server/main.js'));
    await expect(prepareCloudRelease(missing.options)).rejects.toThrow();
    const wrong = await fixture(); await put(wrong.root, '.data/cloud-release-pack/dist/index.html', '<script src="/assets/app.js"></script>');
    await expect(prepareCloudRelease(wrong.options)).rejects.toThrow('/data/');
    expect((await readdir(wrong.root)).includes('artifacts')).toBe(false);
  });

  it('rejects dirty real-mode sources and root dependency aliases', async () => {
    const f = await fixture();
    await expect(prepareCloudRelease({ ...f.options, allowDirty: false })).rejects.toThrow('clean committed');
    await expect(prepareCloudRelease({ ...f.options, nodeModulesRoot: resolve(f.root, 'node_modules') })).rejects.toThrow('Fixture dependency tree');
  });

  it.each(['absolute', 'relative'] as const)('rejects a dependency link escaping its bundle: %s', async kind => {
    const f = await fixture(); const outside = resolve(f.root, 'private.txt'); await writeFile(outside, 'OUTSIDE_SECRET');
    await symlink(kind === 'absolute' ? outside : '../../private.txt', resolve(f.root, 'deps/node_modules/leak'));
    await expect(prepareCloudRelease(f.options)).rejects.toThrow('escapes its bundle');
    expect(await readFile(outside, 'utf8')).toBe('OUTSIDE_SECRET');
    expect((await readdir(f.root)).includes('artifacts')).toBe(false);
  });

  it('rejects a staging ancestor link and never deletes an external sentinel', async () => {
    const f = await fixture(); await rm(resolve(f.root, '.data/cloud-release-pack'), { recursive: true });
    const outside = resolve(f.root, 'external-staging'); await mkdir(outside); await writeFile(resolve(outside, 'keep'), 'KEEP');
    await symlink(outside, resolve(f.root, '.data/cloud-release-pack'));
    await expect(prepareCloudRelease(f.options)).rejects.toThrow('symbolic');
    expect(await readFile(resolve(outside, 'keep'), 'utf8')).toBe('KEEP');
  });

  it('refuses a symlinked client asset tree before copying or reading its external contents', async () => {
    const f = await fixture(); const assets = resolve(f.root, '.data/cloud-release-pack/dist/assets');
    await rm(assets, { recursive: true });
    const outside = resolve(f.root, 'external-assets'); await mkdir(outside); await writeFile(resolve(outside, 'app.js'), 'PRIVATE_EXTERNAL');
    await symlink(outside, assets);
    await expect(prepareCloudRelease(f.options)).rejects.toThrow('symbolic');
    expect(await readFile(resolve(outside, 'app.js'), 'utf8')).toBe('PRIVATE_EXTERNAL');
    expect((await readdir(f.root)).includes('artifacts')).toBe(false);
  });

  it.each([
    { file: 'binding.node', bytes: Buffer.from('native') },
    { file: 'binding.gyp', bytes: Buffer.from('{"targets": []}') },
    { file: 'executable', bytes: Buffer.from([0x7f, 0x45, 0x4c, 0x46]) },
    { file: 'executable', bytes: Buffer.from([0xcf, 0xfa, 0xed, 0xfe]) },
    { file: 'executable', bytes: Buffer.from([0x4d, 0x5a, 0x00, 0x00]) },
  ])('refuses platform native payloads while requiring target installation: $file', async entry => {
    const f = await fixture(); await put(f.root, `deps/node_modules/.pnpm/fixture-runtime@1.2.3/node_modules/fixture-runtime/${entry.file}`, entry.bytes);
    await expect(prepareCloudRelease(f.options)).rejects.toThrow('target Linux x64 Node');
    expect((await readdir(f.root)).includes('artifacts')).toBe(false);
  });

  it('refuses os/cpu-qualified dependencies instead of declaring them portable', async () => {
    const f = await fixture(); await put(f.root, 'deps/node_modules/.pnpm/fixture-runtime@1.2.3/node_modules/fixture-runtime/package.json', JSON.stringify({ name: 'fixture-runtime', version: '1.2.3', os: ['darwin'], cpu: ['arm64'] }));
    await expect(prepareCloudRelease(f.options)).rejects.toThrow('os/cpu restriction');
  });
});
