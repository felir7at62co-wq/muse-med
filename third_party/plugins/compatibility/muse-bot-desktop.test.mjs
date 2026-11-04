/** Keep native Muse Bot activation separate from upstream search and standalone apps. */
import assert from 'node:assert/strict'
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { applyMuseBotDesktopCompatibility, museBotDesktopCompatibility } from './muse-bot-desktop.mjs'
import { createMuseBotMarketNavigation } from './muse-bot-market-client.mjs'

const source = join(import.meta.dirname, '../ds-bot')

function staged(run) {
  const directory = mkdtempSync(join(tmpdir(), 'muse-bot-overlay-'))
  try {
    for (const file of ['package.json', 'cordis.patch.yml', 'NOTICE']) cpSync(join(source, file), join(directory, file))
    mkdirSync(join(directory, 'src/client'), { recursive: true })
    cpSync(join(source, 'src/client/index.js'), join(directory, 'src/client/index.js'))
    run(directory)
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
}

test('qualifies the native plugin without changing its retained manifest or attribution', () => {
  const original = readFileSync(join(source, 'package.json'))
  assert.equal(museBotDesktopCompatibility.memoryReview, true)
  assert.equal(museBotDesktopCompatibility.autoSessionBots, false)
  staged(directory => {
    const patch = readFileSync(join(directory, 'cordis.patch.yml'), 'utf8')
    assert.match(patch, /memoryReview: true/u)
    applyMuseBotDesktopCompatibility(directory)
    assert.equal(readFileSync(join(directory, 'cordis.patch.yml'), 'utf8'), patch)
    const manifest = JSON.parse(readFileSync(join(directory, 'package.json'), 'utf8'))
    assert.equal(manifest.name, 'ds-bot')
    assert.equal(manifest.version, '0.2.4')
    assert.equal(manifest.peerDependencies['@deepseek-ai/dsh-web'], undefined)
    assert.equal(manifest.exports['./web-search'], undefined)
    assert.equal(manifest.exports['./client'], './client.js')
    assert.ok(manifest.files.includes('NOTICE'))
    assert.ok(manifest.files.includes('src/office/'))
    assert.ok(manifest.files.includes('office.js'))
    assert.equal(manifest.dependencies['deep-view'], '0.1.0')
    assert.ok(!manifest.files.includes('web-search.js'))
    assert.equal(readFileSync(join(directory, 'NOTICE'), 'utf8'), readFileSync(join(source, 'NOTICE'), 'utf8'))
    assert.match(readFileSync(join(directory, 'src/client/index.js'), 'utf8'), /ctx\.provide\('museBotMarketNavigation'/u)
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

test('rejects a bundle that registers native Sessions as Bots automatically', () => {
  staged(directory => {
    const path = join(directory, 'cordis.patch.yml')
    writeFileSync(path, readFileSync(path, 'utf8').replace('autoSessionBots: false', 'autoSessionBots: true'))
    assert.throws(() => applyMuseBotDesktopCompatibility(directory), /preserve the Muse profile services/u)
  })
})

test('opens only the adopted market Session in Bot mode after the native roster lists it', async () => {
  const calls = []
  let mode = 'agent'
  let listed
  const surface = { getSnapshot: () => ({ mode }), subscribe: () => () => {} }
  const actions = {
    adoptSession: async ({ sessionId }) => {
      calls.push(['adopt', sessionId])
      return { botId: 'bot-id', sessionId }
    },
    openSession: id => calls.push(['open', id]),
  }
  const navigation = createMuseBotMarketNavigation({
    surface, actions, sessionOf: id => id === 'bot-id' ? listed : undefined,
    pull: async () => { calls.push(['pull']); listed = 'market-session' },
  })
  const signal = new AbortController().signal
  assert.equal(await navigation.openSession('market-session', signal), false)
  assert.deepEqual(calls, [])
  mode = 'bot'
  assert.equal(await navigation.openSession('market-session', signal), true)
  assert.deepEqual(calls, [['adopt', 'market-session'], ['pull'], ['open', 'bot-id']])
})

test('does not open a replaced or superseded market Session', async () => {
  const controller = new AbortController()
  const surface = { getSnapshot: () => ({ mode: 'bot' }), subscribe: () => () => {} }
  const actions = {
    adoptSession: async ({ sessionId }) => ({ botId: 'bot-id', sessionId }),
    openSession: () => assert.fail('unexpected native navigation'),
  }
  const navigation = createMuseBotMarketNavigation({
    surface, actions, sessionOf: () => 'other-session', pull: async () => {},
  })
  await assert.rejects(navigation.openSession('market-session', controller.signal), /did not list the adopted Session/u)
  actions.adoptSession = async ({ sessionId }) => {
    controller.abort()
    return { botId: 'bot-id', sessionId }
  }
  assert.equal(await navigation.openSession('market-session', controller.signal), false)
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
