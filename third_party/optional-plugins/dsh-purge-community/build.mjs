/** Rebuild the optional adapter from its pinned archive and reviewed patch. */
import { createHash, randomUUID } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { chmodSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, symlinkSync, writeFileSync } from 'node:fs'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'
import { c as createTar, t as listTar } from 'tar'

const kitRoot = dirname(fileURLToPath(import.meta.url))
const repository = resolve(kitRoot, '../../..')
const hash = data => createHash('sha256').update(data).digest('hex')
const hashPattern = /^[a-f0-9]{64}$/u
const maxFileBytes = 16 * 1024 * 1024
const maxTotalBytes = 64 * 1024 * 1024

/** Validate a package-relative path shared by the archive and payload inventory. */
export function packagePath(name) {
  if (typeof name !== 'string' || /[\\:\u0000-\u001f]/u.test(name)
    || name.split('/').some(part => !part || part === '.' || part === '..')) throw new Error('Unsafe package member')
  return name
}

/** Read all regular members, rejecting links, duplicate paths and oversized input. */
export function readPackageArchive(archive) {
  const files = new Map()
  const seen = new Set()
  let total = 0
  listTar({ file: archive, sync: true, strict: true, onReadEntry(entry) {
    const full = entry.path.replace(/\/$/u, '')
    packagePath(full)
    if (!full.startsWith('package/')) throw new Error('Archive member is outside package/')
    const name = packagePath(full.slice('package/'.length))
    if (!['File', 'OldFile', 'Directory'].includes(entry.type)) throw new Error('Archive contains a link or special member')
    const folded = name.toLowerCase()
    if (seen.has(folded)) throw new Error('Archive contains a duplicate or case-colliding member')
    seen.add(folded)
    if (seen.size > 2048) throw new Error('Archive contains too many members')
    if (entry.type === 'Directory') return
    if (entry.size > maxFileBytes || total + entry.size > maxTotalBytes) throw new Error('Archive size limit exceeded')
    total += entry.size
    const chunks = []
    let size = 0
    entry.on('data', chunk => {
      size += chunk.length
      if (size > maxFileBytes || size > entry.size) throw new Error('Archive member size mismatch')
      chunks.push(chunk)
    })
    entry.on('end', () => {
      if (size !== entry.size) throw new Error('Incomplete archive member')
      files.set(name, { bytes: Buffer.concat(chunks), mode: entry.mode & 0o777 })
    })
  } })
  if (!files.has('package.json')) throw new Error('Archive has no package manifest')
  return files
}

function inventory(source) {
  if (source.schemaVersion !== 1 || source.adapter?.name !== 'dsh-purge-community'
    || !/^[0-9]+\.[0-9]+\.[0-9]+-muse\.[0-9]+$/u.test(source.adapter.version)
    || !hashPattern.test(source.upstream?.sha256 ?? '') || !hashPattern.test(source.adapter.patchSha256 ?? '')
    || !Array.isArray(source.files) || source.files.length === 0) throw new Error('Invalid adapter source inventory')
  const result = new Map()
  for (const entry of source.files) {
    const name = packagePath(entry.path)
    if (result.has(name.toLowerCase()) || !hashPattern.test(entry.sha256 ?? '')
      || !Number.isSafeInteger(entry.size) || entry.size < 0 || entry.size > maxFileBytes) throw new Error('Invalid payload identity')
    result.set(name.toLowerCase(), entry)
  }
  return [...result.values()].sort((a, b) => a.path.localeCompare(b.path, 'en'))
}

function writeInside(root, name, bytes, mode = 0o644) {
  const target = resolve(root, packagePath(name))
  if (!target.startsWith(root + sep)) throw new Error('Package path escaped staging')
  mkdirSync(dirname(target), { recursive: true })
  writeFileSync(target, bytes, { flag: 'wx', mode })
  chmodSync(target, mode)
}

function regularFiles(root, prefix = '') {
  const result = []
  for (const name of readdirSync(join(root, prefix))) {
    if (!prefix && name === '.git') continue
    const file = prefix ? `${prefix}/${name}` : name
    const stat = lstatSync(join(root, file))
    if (stat.isSymbolicLink()) throw new Error('Staged package contains a link')
    if (stat.isDirectory()) result.push(...regularFiles(root, file))
    else if (stat.isFile()) result.push(file)
    else throw new Error('Staged package contains a special member')
  }
  return result.sort((a, b) => a.localeCompare(b, 'en'))
}

function git(args, cwd) {
  const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => !/KEY|SECRET|TOKEN|PASSWORD|^GIT_/iu.test(name)))
  env.GIT_TERMINAL_PROMPT = '0'
  const result = spawnSync('git', ['-c', 'core.autocrlf=false', '-c', 'core.safecrlf=false', ...args], {
    cwd, env, encoding: 'utf8', windowsHide: true, timeout: 30000,
  })
  if (result.error || result.status !== 0) throw new Error(`Adapter patch failed: ${result.error?.message ?? result.stderr}`)
}

function verifyFiles(root, expected) {
  if (JSON.stringify(regularFiles(root)) !== JSON.stringify(expected.map(entry => entry.path))) throw new Error('Staged payload file list changed')
  for (const entry of expected) {
    const bytes = readFileSync(join(root, entry.path))
    if (bytes.length !== entry.size || hash(bytes) !== entry.sha256) throw new Error(`Staged payload differs from accepted file: ${entry.path}`)
  }
}

/** Attach the repository's exact YAML dependency only for executing package tests. */
export function prepareTestDependencies(packageDir) {
  const require = createRequire(join(repository, 'apps/desktop-host/package.json'))
  const manifest = require.resolve('yaml/package.json')
  if (JSON.parse(readFileSync(manifest, 'utf8')).version !== '2.9.1') throw new Error('Adapter tests require YAML 2.9.1')
  const modules = join(packageDir, 'node_modules')
  mkdirSync(modules)
  symlinkSync(dirname(manifest), join(modules, 'yaml'), process.platform === 'win32' ? 'junction' : 'dir')
}

/**
 * Build a byte-verified optional package without opening or changing a Muse profile.
 * @param {{out: string, sourceDir?: string, withTestDependencies?: boolean}} options Build destination and optional fixture source.
 * @returns {{version: string, archive: string, sha256: string, packageDir: string, files: number}} Build receipt.
 */
export function buildAdapter({ out, sourceDir = kitRoot, withTestDependencies = false }) {
  const source = JSON.parse(readFileSync(join(sourceDir, 'SOURCE.json'), 'utf8'))
  const expected = inventory(source)
  const archive = join(sourceDir, packagePath(source.upstream.archive))
  const upstream = readFileSync(archive)
  if (upstream.length !== source.upstream.bytes || hash(upstream) !== source.upstream.sha256) throw new Error('Upstream archive identity mismatch')
  const patch = join(sourceDir, packagePath(source.adapter.patch))
  if (hash(readFileSync(patch)) !== source.adapter.patchSha256) throw new Error('Adapter patch identity mismatch')
  const original = readPackageArchive(archive)
  const output = resolve(out)
  mkdirSync(output, { recursive: true })
  if (lstatSync(output).isSymbolicLink()) throw new Error('Output directory cannot be a link')
  const staging = mkdtempSync(join(output, '.adapter-'))
  const packageDir = join(staging, 'package')
  mkdirSync(packageDir)
  for (const [name, entry] of original) writeInside(packageDir, name, entry.bytes, entry.mode)
  git(['init', '--quiet'], packageDir)
  git(['apply', '--check', patch], packageDir)
  git(['apply', patch], packageDir)
  verifyFiles(packageDir, expected)
  const manifest = JSON.parse(readFileSync(join(packageDir, 'package.json'), 'utf8'))
  if (manifest.name !== source.adapter.name || manifest.version !== source.adapter.version) throw new Error('Adapter package identity mismatch')
  const final = join(output, `${manifest.name}-${manifest.version}.tgz`)
  if (lstatIfPresent(final)?.isSymbolicLink()) throw new Error('Output archive cannot be a link')
  const temporary = join(output, `.package-${randomUUID()}.tgz`)
  createTar({ cwd: staging, file: temporary, sync: true, portable: true, mtime: new Date(0), gzip: true,
    filter(name, stat) {
      const relativeName = name.replace(/^package\//u, '')
      stat.mode = (stat.mode & ~0o777) | (original.get(relativeName)?.mode ?? 0o644)
      return true
    },
  }, expected.map(entry => `package/${entry.path}`))
  const packed = readPackageArchive(temporary)
  if (packed.size !== expected.length || expected.some(entry => hash(packed.get(entry.path)?.bytes ?? '') !== entry.sha256)) throw new Error('Packed payload differs from accepted files')
  renameSync(temporary, final)
  const receipt = { version: manifest.version, archive: final, sha256: hash(readFileSync(final)), packageDir, files: packed.size }
  writeFileSync(join(output, 'build.json'), JSON.stringify(receipt, null, 2) + '\n')
  if (withTestDependencies) prepareTestDependencies(packageDir)
  return receipt
}

function lstatIfPresent(file) {
  try { return lstatSync(file) } catch (error) { if (error.code === 'ENOENT') return undefined; throw error }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { values } = parseArgs({ options: { out: { type: 'string' }, 'with-test-deps': { type: 'boolean', default: false } } })
  if (!values.out) throw new Error('--out is required')
  console.log(JSON.stringify(buildAdapter({ out: values.out, withTestDependencies: values['with-test-deps'] }), null, 2))
}
