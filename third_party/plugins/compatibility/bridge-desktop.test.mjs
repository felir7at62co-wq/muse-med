import assert from 'node:assert/strict'
import { appendFileSync, cpSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import test from 'node:test'

const source = join(import.meta.dirname, '../dsh-bridge')
const overlayPath = join(import.meta.dirname, 'bridge-desktop.mjs')

test('packs only authenticated Muse transport and refuses the retired Feishu root', async () => {
  assert.ok(existsSync(overlayPath), 'the reviewed bridge artifact overlay is required')
  const { applyBridgeDesktopCompatibility } = await import(pathToFileURL(overlayPath).href)
  const root = mkdtempSync(join(tmpdir(), 'muse-bridge-overlay-'))
  try {
    cpSync(source, root, { recursive: true })
    applyBridgeDesktopCompatibility(root)
    const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
    assert.equal(manifest.name, '@wenbin_wb/dsh-bridge')
    assert.equal(manifest.bin, undefined)
    assert.deepEqual(manifest.scripts, {})
    assert.equal(manifest.exports['./remote'], './lib/remote.mjs')
    assert.equal(manifest.exports['./client'], undefined)
    assert.deepEqual(manifest.dependencies, {
      ws: '8.21.3', '@deepseek-ai/dsh-muse-account': '0.2.1-alpha.1', '@xmanrui/dsh-im': '5.1.0',
    })
    assert.equal(manifest.devDependencies, undefined)
    assert.equal(manifest.dsh.client, undefined)
    const patch = readFileSync(join(root, 'cordis.patch.yml'), 'utf8')
    assert.match(patch, /id: feishu-channel\n\s+name: '@xmanrui\/dsh-im'/u)
    assert.doesNotMatch(patch, /name: '@wenbin_wb\/dsh-bridge'/u)
    assert.match(readFileSync(join(root, 'LICENSE'), 'utf8'), /MIT License/)
    assert.deepEqual(readdirSync(join(root, 'lib')).sort(), ['index.js', 'muse-desktop-tunnel.mjs', 'remote.mjs', 'upstream'])
    assert.deepEqual(readdirSync(join(root, 'lib/upstream')).sort(), ['session-strip.js', 'tunnel-client.mjs'])
    for (const path of ['lib/cloudflared-manager.mjs', 'lib/auth', 'client', 'scripts']) {
      assert.equal(existsSync(join(root, path)), false, `${path} must be excluded`)
    }
    const retired = await import(pathToFileURL(join(root, 'lib/index.js')).href)
    let plugins = 0
    assert.throws(() => retired.apply({ plugin: () => { plugins++ } }, {
      enabled: true, appId: 'synthetic-app', appSecret: 'synthetic-secret', registeredBy: 'ou_owner',
    }), /legacy Feishu root provider has been removed; use @xmanrui\/dsh-im/)
    assert.equal(plugins, 0, 'retired credentials cannot activate any channel')
    assert.doesNotMatch(readFileSync(join(root, 'lib/index.js'), 'utf8'), /import|FeishuGateway|FeishuConversationNode|ConversationBridge/)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('refuses changes to a retained tunnel module before packing', async () => {
  const { applyBridgeDesktopCompatibility } = await import(pathToFileURL(overlayPath).href)
  const root = mkdtempSync(join(tmpdir(), 'muse-bridge-review-'))
  try {
    cpSync(source, root, { recursive: true })
    appendFileSync(join(root, 'lib/tunnel-client.mjs'), '\n// changed upstream source\n')
    assert.throws(() => applyBridgeDesktopCompatibility(root), /tunnel-client\.mjs requires source review/)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('preserves the tunnel response projection dependency without a legacy conversation service', async () => {
  const { applyBridgeDesktopCompatibility } = await import(pathToFileURL(overlayPath).href)
  const root = mkdtempSync(join(tmpdir(), 'muse-bridge-storage-'))
  try {
    cpSync(source, root, { recursive: true })
    applyBridgeDesktopCompatibility(root)
    const { stripSessionProjections } = await import(pathToFileURL(join(root, 'lib/upstream/session-strip.js')).href)
    const result = stripSessionProjections('/api/session.history', Buffer.from(JSON.stringify({
      result: { ok: true, value: { projections: { values: { title: 'Owned title', contextHeaders: 'large', contextTimeline: 'large' } } } },
    })))
    assert.equal(result.stripped, true)
    assert.deepEqual(JSON.parse(result.body.toString()), {
      result: { ok: true, value: { projections: { values: { title: 'Owned title' } } } },
    })
    assert.equal(existsSync(join(root, 'lib/upstream/platform')), false)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
