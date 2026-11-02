/** Qualify every owned bundle through the pnpm entry used by Desktop packaging. */
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'
import { pathToFileURL } from 'node:url'
import { test } from 'node:test'
import { t as listTar } from 'tar'
import { resolvePnpmEntrypoint } from '../../scripts/pnpm-entrypoint.mjs'

const repository = resolve(import.meta.dirname, '../..')
const embeddedSourceRoots = {
  'muse-reverse-tools': 'resources/reverse-skill/',
  'muse-fanqie-download': '',
}

function lifecycleEntrypoint(pnpm) {
  const directory = mkdtempSync(join(tmpdir(), 'pnpm-lifecycle-entry-'))
  try {
    writeFileSync(join(directory, 'probe.mjs'), "process.stdout.write(process.env.npm_execpath ?? '')\n")
    writeFileSync(join(directory, 'package.json'), JSON.stringify({ private: true,
      scripts: { probe: 'node probe.mjs' } }))
    const result = spawnSync(process.execPath, [pnpm, '--silent', '--dir', directory, 'run', 'probe'], {
      encoding: 'utf8', timeout: 15000,
    })
    assert.equal(result.error, undefined)
    assert.equal(result.signal, null)
    assert.equal(result.status, 0, result.stderr)
    const entry = result.stdout.trim()
    assert.ok(entry)
    assert.doesNotMatch(entry, /[\r\n]/u)
    return entry
  } finally { rmSync(directory, { recursive: true, force: true }) }
}

for (const mode of ['javascript', 'lifecycle']) test(`packs every owned tool through the pnpm ${mode} entry without modifying source or exposing local credentials`, async () => {
  const output = mkdtempSync(join(tmpdir(), 'muse-download-pack-'))
  const pins = JSON.parse(readFileSync(join(import.meta.dirname, 'owned-downloads.json'), 'utf8'))
  const names = Object.keys(pins)
  const before = names.map(name =>
    readFileSync(join(import.meta.dirname, name, 'package.json')))
  try {
    const pnpm = resolvePnpmEntrypoint(join(repository, 'node_modules/pnpm/package.json'))
    const result = spawnSync(process.execPath, [join(import.meta.dirname, 'build-downloads.mjs'), '--out', output], {
      cwd: repository, encoding: 'utf8', timeout: 120000,
      env: { ...process.env, npm_execpath: mode === 'lifecycle' ? lifecycleEntrypoint(pnpm) : pnpm },
    })
    assert.equal(result.error, undefined)
    assert.equal(result.signal, null)
    assert.equal(result.status, 0, result.stdout + result.stderr)
    assert.deepEqual(readdirSync(output).sort(), Object.entries(pins).map(([name, pin]) => `${name}-${pin.version}.tgz`).sort())
    for (const [name, pin] of Object.entries(pins)) {
      const archive = join(output, `${name}-${pin.version}.tgz`)
      const reader = pathToFileURL(join(repository, 'scripts/release/tarball.ts')).href
      const qualification = spawnSync(process.execPath, ['--import', 'tsx/esm', '--input-type=module', '-e',
        `import assert from 'node:assert/strict'; import { packedManifest, tarballFiles } from ${JSON.stringify(reader)};
        const archive = process.argv[1]; assert.equal(packedManifest(archive).name, process.argv[2]);
        assert.ok(tarballFiles(archive).includes('package/package.json'));`, archive, name],
      { cwd: repository, encoding: 'utf8', timeout: 30000,
        env: { ...Object.fromEntries(Object.entries(process.env).filter(([name]) => name.toUpperCase() !== 'PATH')), PATH: '' } })
      assert.equal(qualification.error, undefined)
      assert.equal(qualification.signal, null)
      assert.equal(qualification.status, 0, qualification.stdout + qualification.stderr)
      const entries = new Map()
      await listTar({ file: archive, onReadEntry(entry) {
        assert.equal(entries.has(entry.path), false, `Duplicate archive member: ${entry.path}`)
        const hash = createHash('sha256')
        entry.on('data', chunk => { hash.update(chunk) })
        entry.on('end', () => { entries.set(entry.path, hash.digest('hex')) })
      } })
      const manifest = JSON.parse(readFileSync(join(import.meta.dirname, name, 'package.json'), 'utf8'))
      assert.ok(entries.has(`package/${manifest.main.replace(/^\.\//u, '')}`))
      assert.doesNotMatch([...entries.keys()].join('\n'), /(?:^|\/)(?:node_modules|config\.json|devices\.json|\.env)(?:\/|$|\n)/u)
      if (Object.hasOwn(embeddedSourceRoots, name)) {
        const source = JSON.parse(readFileSync(join(import.meta.dirname, name, 'SOURCE.json'), 'utf8'))
        assert.ok(source.files.length > 0)
        for (const file of source.files) {
          // npm excludes upstream Git ignore metadata from distributable archives.
          if (name === 'muse-reverse-tools' && file.path === 'skills/pentest-tools/src-hunter/.gitignore') continue
          const member = `package/${embeddedSourceRoots[name]}${file.path}`
          assert.equal(entries.get(member), file.sha256, member)
        }
      }
    }
    for (const [index, name] of names.entries())
      assert.deepEqual(readFileSync(join(import.meta.dirname, name, 'package.json')), before[index])
  } finally {
    rmSync(output, { recursive: true, force: true })
  }
})
