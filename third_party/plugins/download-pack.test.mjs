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

test('packs every owned tool through pnpm without modifying source or exposing local credentials', async () => {
  const output = mkdtempSync(join(tmpdir(), 'muse-download-pack-'))
  const pins = JSON.parse(readFileSync(join(import.meta.dirname, 'owned-downloads.json'), 'utf8'))
  const names = Object.keys(pins)
  const before = names.map(name =>
    readFileSync(join(import.meta.dirname, name, 'package.json')))
  try {
    const result = spawnSync(process.execPath, [join(import.meta.dirname, 'build-downloads.mjs'), '--out', output], {
      cwd: repository, encoding: 'utf8', timeout: 120000,
      env: { ...process.env, npm_execpath: join(repository, 'node_modules/pnpm/bin/pnpm.cjs') },
    })
    assert.equal(result.error, undefined)
    assert.equal(result.signal, null)
    assert.equal(result.status, 0, result.stdout + result.stderr)
    assert.deepEqual(readdirSync(output).sort(), Object.entries(pins).map(([name, pin]) => `${name}-${pin.version}.tgz`).sort())
    for (const [name, pin] of Object.entries(pins)) {
      const archive = join(output, `${name}-${pin.version}.tgz`)
      const entries = new Map()
      await listTar({ file: archive, onReadEntry(entry) {
        assert.equal(entries.has(entry.path), false, `Duplicate archive member: ${entry.path}`)
        const hash = createHash('sha256')
        entry.on('data', chunk => { hash.update(chunk) })
        entry.on('end', () => { entries.set(entry.path, hash.digest('hex')) })
      } })
      assert.ok(entries.has('package/src/index.js'))
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
