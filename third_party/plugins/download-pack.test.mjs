/** Qualify both download bundles through the pnpm entry used by Desktop packaging. */
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'
import { test } from 'node:test'

const repository = resolve(import.meta.dirname, '../..')

test('packs both download tools through pnpm without modifying source or exposing local credentials', () => {
  const output = mkdtempSync(join(tmpdir(), 'muse-download-pack-'))
  const before = ['muse-hongguo-download', 'muse-douyin-download'].map(name =>
    readFileSync(join(import.meta.dirname, name, 'package.json')))
  try {
    const result = spawnSync(process.execPath, [join(import.meta.dirname, 'build-downloads.mjs'), '--out', output], {
      cwd: repository, encoding: 'utf8', timeout: 120000,
      env: { ...process.env, npm_execpath: join(repository, 'node_modules/pnpm/bin/pnpm.cjs') },
    })
    assert.equal(result.error, undefined)
    assert.equal(result.signal, null)
    assert.equal(result.status, 0, result.stdout + result.stderr)
    const pins = JSON.parse(readFileSync(join(import.meta.dirname, 'owned-downloads.json'), 'utf8'))
    assert.deepEqual(readdirSync(output).sort(), Object.entries(pins).map(([name, pin]) => `${name}-${pin.version}.tgz`).sort())
    for (const [name, pin] of Object.entries(pins)) {
      const archive = join(output, `${name}-${pin.version}.tgz`)
      const listed = spawnSync('tar', ['-tzf', archive], { encoding: 'utf8', timeout: 30000 })
      assert.equal(listed.error, undefined)
      assert.equal(listed.signal, null)
      assert.equal(listed.status, 0, listed.stderr)
      assert.match(listed.stdout, /package\/src\/index\.js/u)
      assert.doesNotMatch(listed.stdout, /(?:^|\/)(?:node_modules|config\.json|devices\.json|\.env)(?:\/|$|\n)/u)
    }
    for (const [index, name] of ['muse-hongguo-download', 'muse-douyin-download'].entries())
      assert.deepEqual(readFileSync(join(import.meta.dirname, name, 'package.json')), before[index])
  } finally {
    rmSync(output, { recursive: true, force: true })
  }
})
