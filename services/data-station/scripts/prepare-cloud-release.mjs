#!/usr/bin/env node
/** Packages an already-built server with a separate /data/ client build and isolated production dependencies. */
import { execFile } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { chmod, cp, lstat, mkdir, open, readFile, readdir, readlink, realpath, rm, writeFile } from 'node:fs/promises';
import { basename, dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import { promisify } from 'node:util';
import { pathToFileURL } from 'node:url';

const exec = promisify(execFile);
const hash = value => createHash('sha256').update(value).digest('hex');
const tarMetadataOptions = ['--no-xattrs', '--no-acls', ...(process.platform === 'darwin' ? ['--no-mac-metadata', '--no-fflags'] : [])];
const tarEnvironment = { COPYFILE_DISABLE: '1', COPY_EXTENDED_ATTRIBUTES_DISABLE: '1' };
const archiveInventoryPython = `import json, sys, tarfile
members = []
with tarfile.open(sys.argv[1], mode='r:gz') as archive:
    for member in archive:
        kind = 'd' if member.isdir() else 'l' if member.issym() else '-' if member.isfile() else '?'
        name = member.name.rstrip('/') + '/' if member.isdir() else member.name
        members.append({'name': name, 'type': kind, 'linkTarget': member.linkname if member.issym() else None})
print(json.dumps(members, ensure_ascii=True))
`;
const inside = (root, path) => { const scope = relative(root, path); return scope !== '..' && !scope.startsWith(`..${sep}`) && !isAbsolute(scope); };
const ignored = name => name === '.data' || name === '.git' || name === '.env' || name.startsWith('.env.') || name.startsWith('._')
  || ['tests', 'test', '__tests__', '__pycache__', '.bin', '.modules.yaml', '.pnpm-workspace-state-v1.json', '.DS_Store',
    'credentials.json', 'identities.json', 'htpasswd', 'server.env', 'browser-profiles', 'playwright-report', 'test-results'].includes(name)
  || /(?:\.pyc|\.log|\.(?:test|spec)\.[cm]?[jt]sx?)$/.test(name) || /^test_.*\.py$/.test(name);

async function run(file, args, cwd, environment = {}) {
  try { return (await exec(file, args, { cwd, maxBuffer: 16 * 1024 * 1024, env: { ...process.env, CI: '1', ...environment } })).stdout.trim(); }
  catch { throw new Error(`Cloud packaging command failed: ${file} ${args[0] ?? ''}`); }
}

async function plainDirectory(path) {
  const actual = await realpath(path);
  if (actual !== path || !(await lstat(path)).isDirectory()) throw new Error('Cloud packaging paths must be real directories without symbolic-link ancestors');
}

async function parentSafe(root, path) {
  if (!inside(root, path)) throw new Error('Cloud packaging path escapes its project');
  let ancestor = path;
  for (;;) {
    try { if (await realpath(ancestor) !== ancestor) throw new Error('Cloud packaging paths cannot use symbolic links'); return; }
    catch (error) {
      if (!error || error.code !== 'ENOENT') throw error;
      const parent = resolve(ancestor, '..'); if (parent === ancestor) throw error; ancestor = parent;
    }
  }
}

async function file(path) {
  const stat = await lstat(path);
  if (!stat.isFile() || stat.isSymbolicLink() || await realpath(path) !== path) throw new Error('Required built output or source file is not a canonical regular file');
  return readFile(path);
}

async function walk(root, options = {}) {
  const records = [];
  const descend = async path => {
    for (const name of (await readdir(path)).sort()) {
      const target = resolve(path, name), stat = await lstat(target);
      if (stat.isSymbolicLink()) {
        if (!options.links) throw new Error('Code and built outputs cannot contain symbolic links');
        const link = await readlink(target);
        if (isAbsolute(link) || !inside(root, resolve(path, link)) || !inside(root, await realpath(target))) throw new Error('Dependency symbolic link escapes its bundle');
        if (!ignored(name)) records.push({ path: relative(root, target).split(sep).join('/'), linkTarget: link });
      } else {
        if (ignored(name)) continue;
        if (stat.isDirectory()) await descend(target);
        else if (stat.isFile()) records.push({ path: relative(root, target).split(sep).join('/'), byteLength: stat.size });
        else throw new Error('Cloud bundle contains a special file');
      }
    }
  };
  await descend(root); return records;
}

async function copyTree(source, destination, links = false, allowedFile) {
  await plainDirectory(source); await walk(source, { links });
  await cp(source, destination, { recursive: true, dereference: false, verbatimSymlinks: true,
    filter: async path => path === source || !relative(source, path).split(sep).some(ignored)
      && (!allowedFile || (await lstat(path)).isDirectory() || allowedFile(basename(path))) });
}

async function checkClient(path) {
  await plainDirectory(path); await walk(path);
  const html = (await file(resolve(path, 'index.html'))).toString('utf8');
  const urls = [...html.matchAll(/\b(?:src|href)\s*=\s*["'](\/(?!\/)[^"']*)["']/g)].map(match => match[1]);
  if (!urls.length || !urls.some(url => url.startsWith('/data/assets/')) || urls.some(url => !url.startsWith('/data/'))) throw new Error('Cloud client assets must use the /data/ base');
  for (const url of urls) {
    const local = decodeURIComponent(url.slice('/data/'.length).split(/[?#]/)[0]);
    const target = resolve(path, local);
    if (!inside(path, target)) throw new Error('Cloud client asset escapes its build directory');
    await file(target);
  }
}

async function pruneInstalledTree(path) {
  for (const name of await readdir(path)) {
    const target = resolve(path, name), stat = await lstat(target);
    if (ignored(name)) await rm(target, { recursive: true, force: true });
    else if (stat.isDirectory() && !stat.isSymbolicLink()) await pruneInstalledTree(target);
  }
}

async function normalizeModes(path) {
  await chmod(path, 0o755);
  for (const name of await readdir(path)) {
    const target = resolve(path, name), stat = await lstat(target);
    if (stat.isSymbolicLink()) continue;
    if (stat.isDirectory()) await normalizeModes(target);
    else if (stat.isFile()) await chmod(target, stat.mode & 0o111 ? 0o755 : 0o644);
    else throw new Error('Cloud bundle contains a special file');
  }
}

async function directoryInventory(root) {
  const directories = [];
  const descend = async path => {
    for (const name of (await readdir(path)).sort()) {
      const target = resolve(path, name), stat = await lstat(target);
      if (stat.isDirectory() && !stat.isSymbolicLink()) {
        directories.push(relative(root, target).split(sep).join('/')); await descend(target);
      }
    }
  };
  await descend(root); return directories;
}

function declaredMembers(manifest) {
  const members = new Map([['app/', { type: 'd' }], ['app/RELEASE.json', { type: '-' }]]);
  const add = (path, type, linkTarget) => {
    if (typeof path !== 'string' || /[\x00-\x1f\x7f\\]/.test(path)
      || path.split('/').some(part => !part || part === '.' || part === '..' || part.startsWith('._'))) throw new Error('Release manifest contains an unsafe archive member');
    const name = `app/${path}${type === 'd' ? '/' : ''}`;
    if (members.has(name)) throw new Error('Release manifest repeats an archive member');
    members.set(name, { type, ...(linkTarget ? { linkTarget } : {}) });
  };
  for (const path of manifest.directories) add(path, 'd');
  for (const record of manifest.files) add(record.path, record.linkTarget ? 'l' : '-', record.linkTarget);
  return members;
}

/**
 * Checks the actual tar member names, types and link targets against the declared files and directories.
 * @param {string} archive Absolute path to the generated archive.
 * @param {{files:Array<{path:string,linkTarget?:string}>,directories:string[]}} manifest Generated release inventory; RELEASE.json and the app root are implicit members.
 * @returns {Promise<{total:number,files:number,links:number,directories:number}>} Verified member counts. Extra metadata, duplicates, omitted members and mismatched types or links fail.
 */
export async function verifyCloudArchive(archive, manifest) {
  const expected = declaredMembers(manifest);
  // macOS tar -t hides valid AppleDouble members; Python's standard parser lists the actual entries without extraction.
  const members = JSON.parse(await run('python3', ['-c', archiveInventoryPython, archive], dirname(archive)));
  const counts = { total: members.length, files: 0, links: 0, directories: 0 }, seen = new Set();
  for (const { name, type, linkTarget } of members) {
    if (!name.startsWith('app/') || name.split('/').some(part => part.startsWith('._'))) throw new Error('Cloud archive contains a member outside app/ or AppleDouble metadata');
    const declared = expected.get(name);
    if (!declared || seen.has(name)) throw new Error('Cloud archive contains an undeclared or duplicate member');
    seen.add(name);
    if (type !== declared.type) throw new Error('Cloud archive member type differs from its manifest');
    if (declared.type === 'l' && linkTarget !== declared.linkTarget) throw new Error('Cloud archive symbolic-link target differs from its manifest');
    counts[declared.type === 'd' ? 'directories' : declared.type === 'l' ? 'links' : 'files']++;
  }
  if (seen.size !== expected.size) throw new Error('Cloud archive is missing declared members');
  return counts;
}

async function dependencyAudit(nodeRoot, dependencies) {
  const files = await walk(nodeRoot, { links: true }), native = [], packages = [];
  for (const record of files) {
    if (record.linkTarget) continue;
    const path = resolve(nodeRoot, record.path);
    if (basename(path) === 'package.json') {
      const manifest = JSON.parse((await file(path)).toString('utf8'));
      if (manifest.name && manifest.version) packages.push({ name: manifest.name, version: manifest.version });
      if (manifest.os?.length || manifest.cpu?.length) native.push({ path: record.path, reason: 'package os/cpu restriction' });
      const buildScripts = ['preinstall', 'install', 'postinstall'].map(key => manifest.scripts?.[key] ?? '').join(' ');
      if (manifest.gypfile || /node-gyp|node-pre-gyp|prebuild-install|node-gyp-build|cmake-js|prebuildify/.test(buildScripts)) native.push({ path: record.path, reason: 'native build metadata with scripts disabled' });
    }
    const handle = await open(path, 'r'), magic = Buffer.alloc(4);
    try { await handle.read(magic, 0, 4, 0); } finally { await handle.close(); }
    const hex = magic.toString('hex');
    if (basename(path) === 'binding.gyp' || /\.(?:node|dll|dylib|so(?:\.\d+)?)$/i.test(path) || hex === '7f454c46'
      || ['feedface', 'feedfacf', 'cefaedfe', 'cffaedfe', 'cafebabe', 'bebafeca', 'cafebabf', 'bfbafeca'].includes(hex)
      || magic[0] === 0x4d && magic[1] === 0x5a) native.push({ path: record.path, reason: 'native module or executable signature' });
  }
  if (native.length) throw new Error(`Production dependencies need installation with the target Linux x64 Node; portable packaging refused (${native.map(item => `${item.path}: ${item.reason}`).join(', ')})`);
  const direct = {};
  for (const name of Object.keys(dependencies).sort()) {
    const path = resolve(nodeRoot, name, 'package.json');
    if (!inside(nodeRoot, await realpath(path))) throw new Error('Direct dependency escapes node_modules');
    const manifest = JSON.parse((await readFile(path)).toString('utf8'));
    if (manifest.name !== name || typeof manifest.version !== 'string' || !manifest.version) throw new Error('Production dependency identity is missing or inconsistent');
    direct[name] = manifest.version;
  }
  return { direct, packages: packages.sort((a, b) => a.name.localeCompare(b.name) || a.version.localeCompare(b.version)), nativeFiles: [] };
}

/**
 * Creates an offline-ready app archive without touching the root node_modules or existing dist directory.
 * @param {{cwd?:string,nodeModulesRoot?:string,buildClient?:boolean,allowDirty?:boolean}} options Project root. The supplied dependency tree and dirty bypass are only for isolated fixtures.
 * @returns {Promise<{archive:string,sha256:string,manifest:string,stagingDirectory:string}>} Frozen tarball and receipts in ignored artifacts.
 */
export async function prepareCloudRelease(options = {}) {
  const requestedRoot = resolve(options.cwd ?? process.cwd()); await plainDirectory(requestedRoot);
  const root = requestedRoot;
  const packageBytes = await file(resolve(root, 'package.json')), lockBytes = await file(resolve(root, 'pnpm-lock.yaml'));
  const sourcePackage = JSON.parse(packageBytes.toString('utf8'));
  if (sourcePackage.name !== 'muse-data-web' || !sourcePackage.dependencies || !lockBytes.length) throw new Error('Cloud packaging requires the Muse Data Web package and frozen lockfile');
  const gitRoot = await run('git', ['rev-parse', '--show-toplevel'], root);
  const sourceCommit = await run('git', ['rev-parse', 'HEAD'], root);
  const sourceStatus = await run('git', ['status', '--porcelain', '--untracked-files=normal'], root);
  const sourceDirty = Boolean(sourceStatus) || gitRoot !== root;
  if (sourceDirty && !options.allowDirty) throw new Error('Cloud packaging requires clean committed source');
  if (options.allowDirty && !options.nodeModulesRoot) throw new Error('Dirty-source bypass is restricted to isolated fixture dependency trees');
  if (options.nodeModulesRoot && !options.allowDirty) throw new Error('Supplied node_modules trees are restricted to isolated fixtures');
  if ((await readdir(root)).some(name => name === '.env' || name.startsWith('.env.') && name !== '.env.example')) throw new Error('Cloud client build requires a checkout without dotenv files; .env.example is allowed and file contents are never read by the packager');
  const serverSource = resolve(root, 'dist-server'); await plainDirectory(serverSource);
  const serverBytes = await file(resolve(serverSource, 'main.js'));
  if (!serverBytes.length) throw new Error('Built server output is empty');
  for (const path of ['third_party/fanqie-original/worker.py', 'third_party/fanqie-original/engine.py', 'third_party/fanqie-original/LICENSE',
    'third_party/fanqie-original/requirements.txt', 'scripts/setup-novel-runtime.mjs', 'src/server/collectors/qimao/LICENSE', 'src/server/collectors/qimao/THIRD_PARTY_NOTICES.md']) await file(resolve(root, path));
  const staging = resolve(root, '.data/cloud-release-pack'), app = resolve(staging, 'app'), client = resolve(staging, 'dist');
  await parentSafe(root, staging); await mkdir(staging, { recursive: true, mode: 0o700 });
  await parentSafe(root, app);
  await rm(app, { recursive: true, force: true }); await mkdir(app, { mode: 0o755 });
  const packageManager = options.nodeModulesRoot ? 'fixture-provided-tree' : await run('pnpm', ['--version'], root);
  if (options.buildClient !== false) {
    await run('pnpm', ['exec', 'vite', 'build', '--base=/data/', '--outDir=.data/cloud-release-pack/dist'], root);
  }
  await checkClient(client);
  await copyTree(client, resolve(app, 'dist'));
  await copyTree(serverSource, resolve(app, 'dist-server'));
  await copyTree(resolve(root, 'third_party/fanqie-original'), resolve(app, 'third_party/fanqie-original'), false,
    name => /\.py$/.test(name) || /(?:^|-)LICENSE$/.test(name) || name === 'README.md' || name === 'SOURCE.json' || name === 'requirements.txt');
  await mkdir(resolve(app, 'scripts'), { recursive: true });
  await writeFile(resolve(app, 'scripts/setup-novel-runtime.mjs'), await file(resolve(root, 'scripts/setup-novel-runtime.mjs')));
  await writeFile(resolve(app, 'package.json'), packageBytes); await writeFile(resolve(app, 'pnpm-lock.yaml'), lockBytes);
  await mkdir(resolve(app, 'licenses'), { recursive: true });
  for (const name of ['LICENSE', 'THIRD_PARTY_NOTICES.md']) await writeFile(resolve(app, 'licenses', `qimao-metadata-${name}`), await file(resolve(root, 'src/server/collectors/qimao', name)));
  for (const name of await readdir(root)) if (/^LICENSE(?:\.[A-Za-z0-9_-]+)?$/.test(name)) await writeFile(resolve(app, name), await file(resolve(root, name)));
  if (options.nodeModulesRoot) {
    const supplied = resolve(options.nodeModulesRoot);
    if (basename(supplied) !== 'node_modules' || supplied === resolve(root, 'node_modules') || !inside(root, supplied) || inside(staging, supplied)) throw new Error('Fixture dependency tree is outside its isolated project or aliases staging');
    await copyTree(supplied, resolve(app, 'node_modules'), true);
  } else {
    await run('pnpm', ['install', '--prod', '--frozen-lockfile', '--ignore-scripts'], app);
    // Keep only runtime files; the service starts the built server directly, without generated package-bin shims.
    await pruneInstalledTree(resolve(app, 'node_modules'));
  }
  const dependencies = await dependencyAudit(resolve(app, 'node_modules'), sourcePackage.dependencies);
  const records = await walk(app, { links: true });
  const files = [];
  for (const record of records) files.push(record.linkTarget ? record : { ...record, sha256: hash(await file(resolve(app, record.path))) });
  const directories = await directoryInventory(app);
  const id = `${new Date().toISOString().replace(/\D/g, '').slice(0, 14)}-${sourceCommit.slice(0, 8)}-${randomUUID().slice(0, 8)}`;
  const output = resolve(root, 'artifacts', `cloud-release-${id}`); await parentSafe(root, output); await mkdir(output, { recursive: true, mode: 0o700 });
  const manifest = { version: 1, createdAt: new Date().toISOString(), sourceCommit, sourceDirty, serverSHA256: hash(serverBytes), assetsBase: '/data/',
    target: { os: 'linux', arch: 'x64', node: '24.21.0' }, buildHost: { os: process.platform, arch: process.arch, node: process.versions.node },
    dependenciesPin: { packageSHA256: hash(packageBytes), lockSHA256: hash(lockBytes), packageManager,
      install: options.nodeModulesRoot ? 'provided isolated fixture' : 'pnpm install --prod --frozen-lockfile --ignore-scripts',
      qualification: 'portable-javascript-and-wasm', ...dependencies }, directories, files };
  await writeFile(resolve(app, 'RELEASE.json'), JSON.stringify(manifest, null, 2) + '\n');
  const manifestPath = resolve(output, 'manifest.json'); await writeFile(manifestPath, JSON.stringify(manifest, null, 2) + '\n', { mode: 0o600 });
  await normalizeModes(app);
  const archive = resolve(output, `muse-data-web-${id}.tar.gz`);
  await run('tar', [...tarMetadataOptions, '-czf', archive, '-C', staging, 'app'], root, tarEnvironment);
  try { await verifyCloudArchive(archive, manifest); }
  catch (error) { await rm(archive, { force: true }); throw error; }
  const sha256 = hash(await readFile(archive));
  await writeFile(`${archive}.sha256`, `${sha256}  ${basename(archive)}\n`, { mode: 0o600 });
  return { archive, sha256, manifest: manifestPath, stagingDirectory: app };
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  try {
    const args = process.argv.slice(2); let cwd;
    if (args.length) { if (args.length !== 2 || args[0] !== '--cwd') throw new Error('Usage: node scripts/prepare-cloud-release.mjs [--cwd /absolute/project]'); cwd = args[1]; }
    const result = await prepareCloudRelease({ cwd }); console.log(JSON.stringify(result, null, 2));
  } catch (error) { console.error(error instanceof Error ? error.message : 'Cloud packaging failed'); process.exitCode = 1; }
}
