/** Keep native Muse Bot activation separate from upstream search and standalone apps. */
import assert from 'node:assert/strict'
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { applyMuseBotDesktopCompatibility, museBotDesktopCompatibility } from './muse-bot-desktop.mjs'

const source = join(import.meta.dirname, '../ds-bot')

function staged(run) {
  const directory = mkdtempSync(join(tmpdir(), 'muse-bot-overlay-'))
  try {
    for (const file of ['package.json', 'cordis.patch.yml', 'NOTICE']) cpSync(join(source, file), join(directory, file))
    run(directory)
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
}

test('qualifies the native plugin without changing its retained manifest or attribution', () => {
  const original = readFileSync(join(source, 'package.json'))
  assert.equal(museBotDesktopCompatibility.memoryReview, true)
  staged(directory => {
    const patch = readFileSync(join(directory, 'cordis.patch.yml'), 'utf8')
    assert.match(patch, /memoryReview: true/u)
    applyMuseBotDesktopCompatibility(directory)
    assert.equal(readFileSync(join(directory, 'cordis.patch.yml'), 'utf8'), patch)
    const manifest = JSON.parse(readFileSync(join(directory, 'package.json'), 'utf8'))
    assert.equal(manifest.name, 'ds-bot')
    assert.equal(manifest.version, '0.2.2')
    assert.equal(manifest.peerDependencies['@deepseek-ai/dsh-web'], undefined)
    assert.equal(manifest.exports['./web-search'], undefined)
    assert.equal(manifest.exports['./client'], './client.js')
    assert.ok(manifest.files.includes('NOTICE'))
    assert.ok(!manifest.files.includes('web-search.js'))
    assert.equal(readFileSync(join(directory, 'NOTICE'), 'utf8'), readFileSync(join(source, 'NOTICE'), 'utf8'))
  })
  assert.deepEqual(readFileSync(join(source, 'package.json')), original)
})

test('rejects an older bundle that disables the restored memory review default', () => {
  staged(directory => {
    const path = join(directory, 'cordis.patch.yml')
    writeFileSync(path, readFileSync(path, 'utf8').replace('memoryReview: true', 'memoryReview: false'))
    assert.throws(() => applyMuseBotDesktopCompatibility(directory), /preserve the Muse profile services/u)
  })
})

test('rejects a search override or a second plugin row', () => {
  staged(directory => {
    writeFileSync(join(directory, 'cordis.patch.yml'), `${readFileSync(join(directory, 'cordis.patch.yml'), 'utf8')}\n- id: web\n  config: { searchProvider: auto }\n`)
    assert.throws(() => applyMuseBotDesktopCompatibility(directory), /preserve the Muse profile services/u)
  })
})

test('rejects package drift and empty attribution', () => {
  staged(directory => {
    const manifest = JSON.parse(readFileSync(join(directory, 'package.json'), 'utf8'))
    writeFileSync(join(directory, 'package.json'), JSON.stringify({ ...manifest, version: '0.2.3' }))
    assert.throws(() => applyMuseBotDesktopCompatibility(directory), /new source review/u)
  })
  staged(directory => {
    writeFileSync(join(directory, 'NOTICE'), '')
    assert.throws(() => applyMuseBotDesktopCompatibility(directory), /attribution notice/u)
  })
})
