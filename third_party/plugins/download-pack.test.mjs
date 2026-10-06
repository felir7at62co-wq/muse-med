/** Qualify every owned bundle through the pnpm entry used by Desktop packaging. */
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'
import { test } from 'node:test'

const repository = resolve(import.meta.dirname, '../..')
const embeddedSourceRoots = {
  'muse-reverse-tools': 'resources/reverse-skill/',
  'muse-fanqie-download': '',
}

test('packs every owned tool through pnpm without modifying source or exposing local credentials', () => {
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
      const listed = spawnSync('tar', ['-tzf', archive], { encoding: 'utf8', timeout: 30000 })
      assert.equal(listed.error, undefined)
      assert.equal(listed.signal, null)
      assert.equal(listed.status, 0, listed.stderr)
      assert.match(listed.stdout, /package\/src\/index\.js/u)
      assert.doesNotMatch(listed.stdout, /(?:^|\/)(?:node_modules|config\.json|devices\.json|\.env)(?:\/|$|\n)/u)
      if (Object.hasOwn(embeddedSourceRoots, name)) {
        const source = JSON.parse(readFileSync(join(import.meta.dirname, name, 'SOURCE.json'), 'utf8'))
        assert.ok(source.files.length > 0)
        for (const file of source.files) {
          // npm excludes upstream Git ignore metadata from distributable archives.
          if (name === 'muse-reverse-tools' && file.path === 'skills/pentest-tools/src-hunter/.gitignore') continue
          const member = `package/${embeddedSourceRoots[name]}${file.path}`
          const extracted = spawnSync('tar', ['-xOf', archive, member], { timeout: 30000, maxBuffer: 16 * 1024 * 1024 })
          assert.equal(extracted.error, undefined, member)
          assert.equal(extracted.signal, null, member)
          assert.equal(extracted.status, 0, `${member}: ${extracted.stderr}`)
          assert.equal(createHash('sha256').update(extracted.stdout).digest('hex'), file.sha256, member)
        }
      }
    }
    for (const [index, name] of names.entries())
      assert.deepEqual(readFileSync(join(import.meta.dirname, name, 'package.json')), before[index])
  } finally {
    rmSync(output, { recursive: true, force: true })
  }
})
