/** Validate and publish a new binary download inside the initiating workspace. */
import { createHash } from 'node:crypto'
import { createWriteStream } from 'node:fs'
import { link, lstat, mkdir, mkdtemp, realpath, rmdir, unlink } from 'node:fs/promises'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { Readable, Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'

function contained(root, target) {
  const difference = relative(root, target)
  return !isAbsolute(difference) && difference !== '..' && !difference.startsWith('..' + sep)
}

function outputComponents(path) {
  if (typeof path !== 'string' || !path || !path.isWellFormed() || /[\u0000-\u001f\u007f<>:"|?*]/u.test(path)) {
    throw new Error('Download outputPath must be a safe workspace-relative file path')
  }
  const components = path.split(/[\\/]/u)
  if (components.some(component => !component || /[. ]$/u.test(component)
    || /^(?:CON|PRN|AUX|NUL|COM[0-9¹²³]|LPT[0-9¹²³])(?:\.|$)/iu.test(component))) {
    throw new Error('Download outputPath must be a safe workspace-relative file path')
  }
  return components
}

async function infoAt(path) {
  try { return await lstat(path) }
  catch (error) {
    if (error.code !== 'ENOENT') throw error
    return null
  }
}

function sameIdentity(before, after) {
  return before.dev === after.dev && before.ino === after.ino
}

async function realDirectory(path, info) {
  if (!info?.isDirectory() || info.isSymbolicLink() || relative(path, await realpath(path)) !== '') {
    throw new Error('Download output directories must be real workspace directories')
  }
}

async function checkParents(plan, signal, create = false) {
  for (const directory of plan.directories) {
    signal.throwIfAborted()
    const prior = plan.identities.get(directory)
    let info = await infoAt(directory)
    if (prior && (!info || !sameIdentity(prior, info))) throw new Error('Download output directory changed')
    if (!info && !create) return
    if (!info) {
      try { await mkdir(directory, { mode: 0o700 }) }
      catch (error) { if (error.code !== 'EEXIST') throw error }
      info = await infoAt(directory)
    }
    await realDirectory(directory, info)
    plan.identities.set(directory, info)
  }
}

async function requireAbsent(path) {
  if (await infoAt(path)) throw new Error('Download destination already exists')
}

/** Check the destination before contacting the provider or touching the filesystem. */
export async function prepareDownloadTarget(workspaceRoot, workspaceCwd, outputPath, signal) {
  const components = outputComponents(outputPath)
  if (typeof workspaceRoot !== 'string' || !isAbsolute(workspaceRoot)
    || typeof workspaceCwd !== 'string' || !isAbsolute(workspaceCwd)) {
    throw new Error('Download requires a writable initiating workspace')
  }
  const suppliedRoot = resolve(workspaceRoot)
  const suppliedCwd = resolve(workspaceCwd)
  if (!contained(suppliedRoot, suppliedCwd)) throw new Error('Download cwd must be inside the writable workspace')
  const root = await realpath(suppliedRoot)
  if ((await lstat(suppliedRoot)).isSymbolicLink()) throw new Error('Download workspace root must not be a link')
  const cwd = resolve(root, relative(suppliedRoot, suppliedCwd))
  if (relative(cwd, await realpath(suppliedCwd)) !== '') throw new Error('Download cwd must not pass through a link')
  const target = join(cwd, ...components)
  const directories = [root]
  for (const segment of relative(root, dirname(target)).split(sep).filter(Boolean)) {
    directories.push(join(directories.at(-1), segment))
  }
  const plan = { target, directories, identities: new Map() }
  await checkParents(plan, signal)
  await requireAbsent(target)
  return plan
}

/** Stream a bounded response into private staging, then publish once without replacing another file. */
export async function saveDownload(response, plan, maximum, signal) {
  const declared = response.headers.get('content-length')
  const length = declared === null ? null : Number(declared)
  const encoding = response.headers.get('content-encoding')
  if (!response.body || (encoding !== null && encoding.toLowerCase() !== 'identity')
    || (length !== null && (!/^[0-9]+$/u.test(declared) || !Number.isSafeInteger(length) || length < 1 || length > maximum))) {
    await response.body?.cancel().catch(() => {})
    throw new Error('Download response has an unsupported encoding or length')
  }

  let directory, ownership
  const hash = createHash('sha256')
  let bytes = 0
  const meter = new Transform({
    transform(chunk, _encoding, done) {
      bytes += chunk.length
      if (bytes > maximum || (length !== null && bytes > length)) {
        done(new Error('Download exceeded its allowed byte count'))
        return
      }
      hash.update(chunk)
      done(null, chunk)
    },
  })
  try {
    await checkParents(plan, signal, true)
    await requireAbsent(plan.target)
    directory = await mkdtemp(join(dirname(plan.target), '.drama-web-'))
    ownership = await lstat(directory)
    await realDirectory(directory, ownership)
    const temporary = join(directory, 'payload')
    await pipeline(Readable.fromWeb(response.body), meter, createWriteStream(temporary, { flags: 'wx', mode: 0o600 }), { signal })
    if (!bytes || (length !== null && bytes !== length)) throw new Error('Download body did not match its declared length')
    await checkParents(plan, signal)
    const current = await lstat(directory)
    await realDirectory(directory, current)
    if (!sameIdentity(ownership, current)) throw new Error('Download staging directory changed')
    signal.throwIfAborted()
    try { await link(temporary, plan.target) }
    catch (error) {
      if (error.code === 'EEXIST') throw new Error('Download destination already exists')
      throw error
    }
    return { path: plan.target, bytes, sha256: hash.digest('hex') }
  }
  finally {
    if (response.body && !response.body.locked) await response.body.cancel().catch(() => {})
    if (directory && ownership) {
      const current = await infoAt(directory).catch(() => null)
      if (current && sameIdentity(ownership, current) && !current.isSymbolicLink()
        && await realpath(directory).then(path => relative(path, directory) === '', () => false)) {
        await unlink(join(directory, 'payload')).catch(() => {})
        await rmdir(directory).catch(() => {})
      }
    }
  }
}
