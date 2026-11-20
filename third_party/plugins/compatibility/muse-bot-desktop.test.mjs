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
  assert.equal(museBotDesktopCompatibility.agentPreset, 'short-drama-v2')
  assert.equal(museBotDesktopCompatibility.updateCheck, false)
  staged(directory => {
    const patch = readFileSync(join(directory, 'cordis.patch.yml'), 'utf8')
    assert.match(patch, /agentPreset: short-drama-v2$/mu)
    applyMuseBotDesktopCompatibility(directory)
    assert.equal(readFileSync(join(directory, 'cordis.patch.yml'), 'utf8'), patch)
    const manifest = JSON.parse(readFileSync(join(directory, 'package.json'), 'utf8'))
    assert.equal(manifest.name, 'ds-bot')
    assert.equal(manifest.version, '0.3.8')
    assert.equal(manifest.bin, undefined)
    assert.equal(manifest.peerDependencies['@deepseek-ai/dsh-web'], undefined)
    assert.equal(manifest.exports['./web-search'], undefined)
    assert.equal(manifest.exports['./client'], './client.js')
    for (const file of ['NOTICE', 'MUSE_SOURCE.json', 'src/office/', 'office.js', 'link.js', 'plugin.js']) assert.ok(manifest.files.includes(file), file)
    assert.ok(!manifest.files.includes('web-search.js'))
    assert.ok(!manifest.files.includes('bin/'))
    assert.equal(readFileSync(join(directory, 'NOTICE'), 'utf8'), readFileSync(join(source, 'NOTICE'), 'utf8'))
  })
  assert.deepEqual(readFileSync(join(source, 'package.json')), original)
})

test('rejects a bundle that puts Bot conversations on another preset', () => {
  staged(directory => {
    const path = join(directory, 'cordis.patch.yml')
    writeFileSync(path, readFileSync(path, 'utf8').replace('agentPreset: short-drama-v2', 'agentPreset: standard'))
    assert.throws(() => applyMuseBotDesktopCompatibility(directory), /preserve the Muse profile services/u)
  })
})

test('rejects a bundle that turns the upstream update check back on', () => {
  staged(directory => {
    const path = join(directory, 'cordis.patch.yml')
    writeFileSync(path, readFileSync(path, 'utf8').replace('updateCheck: false', 'updateCheck: true'))
    assert.throws(() => applyMuseBotDesktopCompatibility(directory), /preserve the Muse profile services/u)
  })
})
