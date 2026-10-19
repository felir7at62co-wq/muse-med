/** Qualify every owned bundle through the pnpm entry used by Desktop packaging. */
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'
import { test } from 'node:test'
import { t as listTar } from 'tar'

const repository = resolve(import.meta.dirname, '../..')
const embeddedSourceRoots = {
  'muse-reverse-tools': 'resources/reverse-skill/',
  'muse-fanqie-download': '',
}

const pins = JSON.parse(readFileSync(join(import.meta.dirname, 'owned-downloads.json'), 'utf8'))
const sourceManifests = new Map(Object.keys(pins).map(name => [name,
  readFileSync(join(import.meta.dirname, name, 'package.json'))]))

for (const [name, pin] of Object.entries(pins)) test(`packs ${name} through pnpm without modifying source or exposing local credentials`, async () => {
  const output = mkdtempSync(join(tmpdir(), 'muse-download-pack-'))
  const before = sourceManifests.get(name)
  const manifest = JSON.parse(before.toString('utf8'))
  try {
    const result = spawnSync(process.execPath, [join(import.meta.dirname, 'build-downloads.mjs'), '--only', name, '--out', output], {
      cwd: repository, encoding: 'utf8', timeout: 120000,
      env: { ...process.env, npm_execpath: join(repository, 'node_modules/pnpm/bin/pnpm.cjs') },
    })
    assert.equal(result.error, undefined)
    assert.equal(result.signal, null)
    assert.equal(result.status, 0, result.stdout + result.stderr)
    assert.deepEqual(readdirSync(output), [`${name}-${pin.version}.tgz`])
    {
      const archive = join(output, `${name}-${pin.version}.tgz`)
      const entries = new Map()
      const seen = new Set()
      const metadata = new Map()
      const memberTypes = new Map()
      await listTar({ file: archive, onReadEntry(entry) {
        assert.equal(seen.has(entry.path), false, `Duplicate archive member: ${entry.path}`)
        seen.add(entry.path)
        memberTypes.set(entry.path, entry.type)
        const hash = createHash('sha256')
        const chunks = []
        entry.on('data', (chunk) => {
          hash.update(chunk)
          if (entry.path === 'package/SOURCE.json' || entry.path === 'package/package.json') chunks.push(chunk)
        })
        entry.on('end', () => {
          entries.set(entry.path, hash.digest('hex'))
          if (chunks.length) metadata.set(entry.path, JSON.parse(Buffer.concat(chunks).toString('utf8')))
        })
      } })
      assert.ok(entries.has(`package/${manifest.main.replace(/^\.\//u, '')}`), manifest.main)
      assert.deepEqual(metadata.get('package/package.json'), manifest)
      assert.doesNotMatch([...entries.keys()].join('\n'), /(?:^|\/)(?:node_modules|config\.json|devices\.json|\.env)(?:\/|$|\n)/u)
      if (name === 'muse-lvpaopao') {
        assert.ok(entries.has('package/lib/bridge.js'))
        assert.deepEqual(manifest.exports['./bridge'], { types: './lib/bridge.d.ts', default: './lib/bridge.js' })
        const source = metadata.get('package/SOURCE.json')
        assert.equal(source.name, name)
        assert.equal(source.hostVersion, JSON.parse(readFileSync(join(repository, 'apps/desktop-host/package.json'), 'utf8')).version)
        assert.equal(source.nativeHelperIncluded, false)
        assert.equal(source.connectionConfigurationIncluded, false)
        const runtimeFiles = [...entries.keys()].filter(path => path.startsWith('package/lib/')).map(path => path.slice('package/'.length)).sort()
        assert.ok(runtimeFiles.length > 0)
        assert.deepEqual(Object.keys(source.files).sort(), runtimeFiles)
        for (const [path, sha256] of Object.entries(source.files)) {
          assert.match(sha256, /^[a-f0-9]{64}$/u)
          assert.equal(entries.get(`package/${path}`), sha256, path)
        }
        for (const [path, type] of memberTypes) {
          assert.equal(type, 'File', path)
          assert.ok(path.startsWith('package/') && !path.split('/').includes('..'), path)
        }
        assert.doesNotMatch([...entries.keys()].join('\n'), /(?:^|\/)(?:native|private|node_modules|\.ssh|connection\.json|config\.json|devices\.json|\.env)(?:\/|$|\n)|\.(?:pem|key|p12|pfx|mp4|mov|dll|pyc)(?:$|\n)/iu)
      }
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
    for (const [sourceName, original] of sourceManifests)
      assert.deepEqual(readFileSync(join(import.meta.dirname, sourceName, 'package.json')), original)
  } finally {
    rmSync(output, { recursive: true, force: true })
  }
})
