/** Prepare the separately licensed, isolated Windows CPU music-emotion runtime. */
import { createHash, randomUUID } from 'node:crypto'
import { cp, lstat, mkdir, mkdtemp, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { extract } from 'tar'
import { assertMediaArchivePath, inventory, obtain, run, shortStage, type MediaResource } from './media-resources.ts'

/** Public, hash-locked inputs for the noncommercial MERT inference payload. */
export interface BgmRuntimeLock {
  version: 1
  pythonVersion: string
  python: MediaResource
  mertRevision: string
  license: 'CC-BY-NC-4.0'
  models: MediaResource[]
  wheels: MediaResource[]
  sdists?: Array<MediaResource & { name: string; version: string }>
  notices?: MediaResource[]
}

/** Validate release inputs before filesystem or network operations.
 * @param value - Parsed lock file.
 * @returns Validated BGM runtime lock.
 */
export function validateBgmRuntimeLock(value: unknown): BgmRuntimeLock {
  if (typeof value !== 'object' || value === null) throw new Error('bgm lock: expected object')
  const lock = value as BgmRuntimeLock
  if (lock.version !== 1 || !/^3\.11\.\d+$/u.test(lock.pythonVersion) || lock.license !== 'CC-BY-NC-4.0'
    || lock.mertRevision !== '12af15fef9d0ac838c3f475bfbbf26d2060dd4f5'
    || !Array.isArray(lock.models) || !Array.isArray(lock.wheels) || lock.wheels.length === 0) {
    throw new Error('bgm lock: unsupported runtime or model license/revision')
  }
  const requiredModels = ['config.json', 'preprocessor_config.json', 'configuration_MERT.py', 'modeling_MERT.py',
    'pytorch_model.bin', 'J_all.ckpt', 'btc_model_large_voca.pt', 'README-MERT.md', 'LICENSE-CC-BY-NC-4.0.txt']
  const names = lock.models.map(resource => resource?.filename)
  if (names.length !== requiredModels.length || !requiredModels.every(name => names.includes(name))) {
    throw new Error('bgm lock: incomplete or duplicate model resources')
  }
  if (lock.sdists !== undefined && (!Array.isArray(lock.sdists) || lock.sdists.some(source =>
    typeof source?.name !== 'string' || !/^[a-zA-Z0-9_.-]+$/u.test(source.name)
    || typeof source.version !== 'string' || !/^[a-zA-Z0-9_.+!-]+$/u.test(source.version)))) {
    throw new Error('bgm lock: invalid source distribution')
  }
  if (lock.notices !== undefined && !Array.isArray(lock.notices)) throw new Error('bgm lock: invalid notices')
  const artifactNames = new Set<string>()
  for (const resource of [lock.python, ...lock.models, ...lock.wheels, ...(lock.sdists ?? []), ...(lock.notices ?? [])]) {
    if (typeof resource !== 'object' || resource === null || typeof resource.filename !== 'string'
      || typeof resource.url !== 'string' || !/^[a-f0-9]{64}$/u.test(resource.sha256)
      || !Number.isSafeInteger(resource.bytes) || resource.bytes <= 0) throw new Error('bgm lock: invalid resource')
    assertMediaArchivePath(resource.filename)
    if (artifactNames.has(resource.filename.toLowerCase())) throw new Error('bgm lock: duplicate artifact filename')
    artifactNames.add(resource.filename.toLowerCase())
    if (resource.filename.includes('/')) throw new Error('bgm lock: artifact filename must be a basename')
    const url = new URL(resource.url)
    if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) {
      throw new Error('bgm lock: public HTTPS URL required')
    }
  }
  return lock
}

/** Verify an existing BGM payload without repairing or deleting it.
 * @param root - Prepared runtime root.
 * @param lock - Expected release inputs.
 */
export async function verifyPreparedBgmRuntime(root: string, lock: BgmRuntimeLock): Promise<void> {
  if (!(await lstat(root)).isDirectory()) throw new Error('bgm reuse: expected a real directory')
  for (const name of ['resources.lock.json', 'bgm-runtime.json']) {
    if (!(await lstat(join(root, name))).isFile()) throw new Error('bgm reuse: metadata must be regular files')
  }
  const prior: unknown = JSON.parse(await readFile(join(root, 'resources.lock.json'), 'utf8'))
  if (JSON.stringify(prior) !== JSON.stringify(lock)) throw new Error('bgm reuse: input lock changed; use a fresh output')
  const descriptor: unknown = JSON.parse(await readFile(join(root, 'bgm-runtime.json'), 'utf8'))
  if (typeof descriptor !== 'object' || descriptor === null || !('version' in descriptor) || descriptor.version !== 1
    || !('files' in descriptor) || !Array.isArray(descriptor.files)) throw new Error('bgm reuse: invalid inventory')
  const actual = (await inventory(root)).filter(file => file.path !== 'bgm-runtime.json')
  if (JSON.stringify(actual) !== JSON.stringify(descriptor.files)) throw new Error('bgm reuse: payload inventory changed')
}

const packageRoot = resolve(import.meta.dirname, '../../../packages/perception/perception-bgm')

function isolatedEnvironment(root: string, work: string, ffmpegPath: string): NodeJS.ProcessEnv {
  const systemRoot = process.env.SystemRoot
  if (!systemRoot) throw new Error('bgm preparation: SystemRoot is required')
  return {
    SystemRoot: systemRoot, WINDIR: systemRoot,
    PATH: [join(root, 'python'), join(root, 'python/DLLs'), join(root, 'python/Library/bin'),
      dirname(ffmpegPath), join(systemRoot, 'System32')].join(';'),
    HOME: work, USERPROFILE: work, APPDATA: work, LOCALAPPDATA: work, TEMP: work, TMP: work,
    HF_HOME: join(root, 'models/hf-cache'), HF_MODULES_CACHE: join(work, 'hf-modules'),
    NUMBA_CACHE_DIR: join(work, 'numba'), MPLCONFIGDIR: join(work, 'matplotlib'), TORCH_HOME: join(work, 'torch'),
    HF_HUB_OFFLINE: '1', TRANSFORMERS_OFFLINE: '1', HF_HUB_DISABLE_TELEMETRY: '1',
    OMP_NUM_THREADS: '1', MKL_NUM_THREADS: '1', OPENBLAS_NUM_THREADS: '1',
    PYTHONDONTWRITEBYTECODE: '1', PIP_NO_INDEX: '1', PIP_DISABLE_PIP_VERSION_CHECK: '1',
    SOURCE_DATE_EPOCH: '1704067200',
  }
}

/** Run real MP3 emotion inference using a cold home and the bundled interpreter.
 * @param root - Prepared BGM root.
 * @param ffmpegPath - Bundled FFmpeg executable, placed on the smoke's search path.
 */
export async function smokeBgmRuntime(root: string, ffmpegPath: string): Promise<void> {
  const work = await mkdtemp(join(dirname(root), '.bgm-smoke-'))
  try {
    await run(join(root, 'python/python.exe'), ['-I', '-B', '-X', 'utf8',
      resolve(import.meta.dirname, 'smoke-bgm-runtime.py'), root, join(packageRoot, 'python/worker_main.py')],
    isolatedEnvironment(root, work, ffmpegPath))
  } finally { await rm(work, { recursive: true, force: true }) }
}

/**
 * Remove bytecode that hash-locked upstream distributions ship.
 *
 * A reviewed wheel can carry `__pycache__` entries beside its sources, and the
 * worker runs with `-B`, so the payload keeps sources only.
 * @param root - Payload root, or any extracted directory.
 */
export async function pruneUpstreamBytecode(root: string): Promise<void> {
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const path = join(root, entry.name)
    if (entry.isDirectory()) {
      if (entry.name === '__pycache__') await rm(path, { recursive: true, force: true })
      else await pruneUpstreamBytecode(path)
    } else if (/\.py[co]$/u.test(entry.name)) await rm(path, { force: true })
  }
}

/** Build or verify the separate noncommercial model runtime without changing the main media Python.
 * @param options - Exclusive output, hash cache, bundled FFmpeg and locked public inputs.
 * @returns Verified runtime root.
 */
export async function prepareBgmRuntime(options: {
  output: string
  cache: string
  ffmpegPath: string
  lock: BgmRuntimeLock
}): Promise<string> {
  if (process.platform !== 'win32' || process.arch !== 'x64') throw new Error('bgm preparation requires Windows x64')
  const lock = validateBgmRuntimeLock(options.lock)
  const output = resolve(options.output)
  let exists = false
  try { await lstat(output); exists = true } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
  if (exists) {
    await verifyPreparedBgmRuntime(output, lock)
    await smokeBgmRuntime(output, options.ffmpegPath)
    await verifyPreparedBgmRuntime(output, lock)
    return output
  }
  await mkdir(options.cache, { recursive: true })
  await mkdir(dirname(output), { recursive: true })
  const stage = await shortStage(output)
  const work = await mkdtemp(join(dirname(stage), '.bw-'))
  try {
    const files = new Map<string, string>()
    for (const resource of [lock.python, ...lock.models, ...lock.wheels, ...(lock.sdists ?? []), ...(lock.notices ?? [])]) {
      process.stdout.write(`bgm: verify ${resource.filename}\n`)
      files.set(resource.filename, await obtain(resource, options.cache))
    }
    const names = new Set<string>()
    await extract({ file: files.get(lock.python.filename)!, cwd: stage, filter(path, entry) {
      assertMediaArchivePath(path)
      if (!path.startsWith('python/') || !('type' in entry) || (entry.type !== 'File' && entry.type !== 'Directory')) {
        throw new Error('bgm Python archive: unexpected member or link')
      }
      const key = path.toLowerCase()
      if (names.has(key)) throw new Error('bgm Python archive: duplicate Windows path')
      names.add(key)
      // Upstream bytecode embeds build-machine paths; the worker starts with -B.
      return !path.split('/').includes('__pycache__') && !/\.py[co]$/u.test(path)
    } })
    const python = join(stage, 'python')
    const site = join(python, 'Lib/site-packages')
    // Distributions come only from this lock, not from the standalone builder's bundled pip environment.
    await rm(site, { recursive: true, force: true })
    await mkdir(site, { recursive: true })
    await rm(join(python, 'Scripts'), { recursive: true, force: true })
    await writeFile(join(python, 'python311._pth'), '.\nDLLs\nLib\nLib/site-packages\nimport site\n')
    const environment = isolatedEnvironment(stage, work, options.ffmpegPath)
    const pip = lock.wheels.find(wheel => wheel.filename.startsWith('pip-'))
    if (!pip) throw new Error('bgm lock: a locked pip bootstrap wheel is required')
    const interpreter = join(python, 'python.exe')
    const bootstrap = ['-I', '-B', '-X', 'utf8', '-c',
      'import sys,runpy;sys.path.insert(0,sys.argv.pop(1));runpy.run_module("pip",run_name="__main__")', files.get(pip.filename)!]
    const requirements = lock.wheels.map((wheel) => {
      const match = /^([\w.]+)-([\w.+!]+)-.*\.whl$/u.exec(wheel.filename)
      if (!match) throw new Error('bgm lock: invalid wheel filename')
      return `${match[1]}==${match[2]} --hash=sha256:${wheel.sha256}`
    }).join('\n')
    const requirementsPath = join(work, 'requirements.lock')
    await writeFile(requirementsPath, requirements + '\n')
    await run(interpreter, [...bootstrap, '--isolated', 'install', '--no-index', '--no-deps', '--no-compile',
      '--only-binary=:all:', '--prefix', python, '--find-links', resolve(options.cache), '--require-hashes', '-r', requirementsPath], environment)
    const builtSources = []
    const built = join(work, 'wheels')
    await mkdir(built)
    await mkdir(join(stage, 'licenses/sources'), { recursive: true })
    for (const notice of lock.notices ?? []) await cp(files.get(notice.filename)!, join(stage, 'licenses', notice.filename))
    for (const source of lock.sdists ?? []) {
      await run(interpreter, ['-I', '-B', '-m', 'pip', '--isolated', 'wheel', '--no-index', '--no-deps',
        '--no-build-isolation', '--wheel-dir', built, files.get(source.filename)!], environment)
      const candidates = (await readdir(built)).filter(name => name.endsWith('.whl'))
      if (candidates.length !== 1) throw new Error('bgm source build: expected one wheel')
      const wheel = join(built, candidates[0]!)
      const bytes = await readFile(wheel)
      builtSources.push({ source, wheel: { filename: candidates[0], bytes: bytes.length,
        sha256: createHash('sha256').update(bytes).digest('hex') } })
      await run(interpreter, ['-I', '-B', '-m', 'pip', '--isolated', 'install', '--no-index', '--no-deps', '--no-compile',
        '--prefix', python, wheel], environment)
      await rm(wheel)
      await cp(files.get(source.filename)!, join(stage, 'licenses/sources', source.filename))
    }
    const reviewedShim = "import os; var = 'SETUPTOOLS_USE_DISTUTILS'; enabled = os.environ.get(var, 'local') == 'local'; enabled and __import__('_distutils_hack').add_shim();"
    for (const name of await readdir(site)) {
      if (!name.endsWith('.pth')) continue
      if (name !== 'distutils-precedence.pth' || (await readFile(join(site, name), 'utf8')).trim() !== reviewedShim) {
        throw new Error('bgm: unreviewed Python startup hook')
      }
      await rm(join(site, name))
    }
    await rm(join(python, 'Scripts'), { recursive: true, force: true })
    const hub = join(stage, 'models/hf-cache/hub')
    const repository = join(hub, 'models--m-a-p--MERT-v1-95M')
    const snapshot = join(repository, 'snapshots', lock.mertRevision)
    await mkdir(snapshot, { recursive: true })
    await mkdir(join(repository, 'refs'))
    await writeFile(join(repository, 'refs/main'), lock.mertRevision)
    await writeFile(join(hub, 'version.txt'), '1')
    for (const name of ['config.json', 'preprocessor_config.json', 'configuration_MERT.py', 'modeling_MERT.py', 'pytorch_model.bin']) {
      await cp(files.get(name)!, join(snapshot, name))
    }
    await cp(files.get('README-MERT.md')!, join(snapshot, 'README.md'))
    await cp(files.get('README-MERT.md')!, join(stage, 'licenses/README-MERT.md'))
    await cp(files.get('LICENSE-CC-BY-NC-4.0.txt')!, join(stage, 'licenses/LICENSE-CC-BY-NC-4.0.txt'))
    await cp(files.get('J_all.ckpt')!, join(stage, 'models/J_all.ckpt'))
    await cp(join(packageRoot, 'python/data'), join(stage, 'models/data'), { recursive: true })
    await cp(files.get('btc_model_large_voca.pt')!, join(stage, 'models/data/btc_model_large_voca.pt'))
    await cp(join(packageRoot, 'python/LICENSE-Music2Emo'), join(stage, 'licenses/LICENSE-Music2Emo'))
    await cp(join(packageRoot, 'SOURCES.md'), join(stage, 'licenses/Music2Emo-SOURCES.md'))
    await writeFile(join(stage, 'licenses/MERT-ATTRIBUTION.txt'), [
      'm-a-p/MERT-v1-95M — CC-BY-NC-4.0; noncommercial use and redistribution only.',
      `https://huggingface.co/m-a-p/MERT-v1-95M/tree/${lock.mertRevision}`,
      'Retain the accompanying model card, author credits and full license. No commercial permission is granted.',
      'This package preserves the model weights and uses the hash-locked remote-code snapshot without modification.',
      'The Music2Emotion adapter and its documented changes are covered by the retained MIT notice; this does not relicense MERT.',
      'Python and wheel distribution licenses remain beside their code. Source-built dependencies are recorded with their source archives.',
      '',
    ].join('\n'))
    await writeFile(join(stage, 'resources.lock.json'), JSON.stringify(lock, null, 2) + '\n')
    await writeFile(join(stage, 'source-builds.json'), JSON.stringify(builtSources, null, 2) + '\n')
    // A reviewed wheel may carry bytecode beside its sources (numpy 1.26.4 ships
    // `numpy/distutils/__pycache__/conv_template.cpython-311.pyc`). The payload
    // keeps sources only, so the invariant below still means "nothing was
    // compiled on this build machine".
    await pruneUpstreamBytecode(stage)
    const payload = await inventory(stage)
    const compiled = payload.filter(file => file.path.split('/').includes('__pycache__') || /\.py[co]$/u.test(file.path))
    if (compiled.length > 0) {
      throw new Error('bgm payload: unexpected generated Python bytecode in '
        + compiled.slice(0, 3).map(file => file.path).join(', '))
    }
    await writeFile(join(stage, 'bgm-runtime.json'), JSON.stringify({ version: 1, pythonVersion: lock.pythonVersion,
      license: lock.license, files: payload }, null, 2) + '\n')
    await smokeBgmRuntime(stage, options.ffmpegPath)
    await verifyPreparedBgmRuntime(stage, lock)
    await rename(stage, output)
    return output
  } finally {
    await rm(stage, { recursive: true, force: true })
    await rm(work, { recursive: true, force: true })
  }
}
