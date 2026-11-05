/** Retain the retired Feishu source without building it for an unreviewed Host. */
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import test from 'node:test'

const root = resolve(import.meta.dirname, '../..')
const pin = JSON.parse(readFileSync(join(import.meta.dirname, 'sources.json'), 'utf8'))['dsh-feishu']

test('rejects the retained Feishu source without a Host qualification', () => {
  assert.equal(pin.desktop, false)
  const output = mkdtempSync(join(tmpdir(), 'muse-feishu-unreviewed-'))
  try {
    const result = spawnSync(process.execPath, [join(import.meta.dirname, 'build.mjs'), '--only', 'dsh-feishu', '--out', output], {
      cwd: root,
      encoding: 'utf8',
    })
    assert.equal(result.error, undefined)
    assert.equal(result.status, 1)
    assert.match(result.stderr, /dsh-feishu has no compatibility review for Host/u)
    assert.deepEqual(readdirSync(output), [])
  } finally {
    rmSync(output, { recursive: true, force: true })
  }
})
