/** Exercise the account remote provider without any legacy Feishu implementation. */
import assert from 'node:assert/strict'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { test } from 'node:test'
import { Context } from '@deepseek-ai/cordis'
import * as remote from './lib/remote.mjs'
import * as retired from './lib/index.js'

test('mounts the typed account remote provider and stops an unused tunnel', async () => {
  const ctx = new Context()
  try {
    await ctx.plugin(remote)
    assert.equal(typeof ctx.museDesktopBridge.createTunnel, 'function')
    const tunnel = ctx.museDesktopBridge.createTunnel({
      serverUrl: 'ws://127.0.0.1:1/api/desktop/connect', headers: { cookie: 'muse_session=synthetic' },
      localPort: 1, loopbackCookie: 'host=synthetic', deviceId: 'synthetic-device', chunkBytes: 32768, ackTimeoutMs: 1000, reconnectMaxIntervalMs: 1000,
    })
    await tunnel.stop()
    assert.equal(ctx.get('feishu'), undefined)
  } finally {
    await ctx.fiber.dispose()
  }
  assert.equal(ctx.get('museDesktopBridge'), undefined)
})

test('rejects the retired root with credentials and contains no legacy channel payload', () => {
  const manifest = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8'))
  assert.equal(manifest.exports['./remote'], './lib/remote.mjs')
  assert.equal(manifest.dsh.client, undefined)
  assert.equal(manifest.dependencies['@larksuiteoapi/node-sdk'], undefined)
  assert.equal(manifest.devDependencies, undefined)
  assert.deepEqual(readdirSync(new URL('./lib/', import.meta.url)).sort(), ['index.js', 'muse-desktop-tunnel.mjs', 'remote.mjs', 'upstream'])
  assert.deepEqual(readdirSync(new URL('./lib/upstream/', import.meta.url)).sort(), ['session-strip.js', 'tunnel-client.mjs'])
  for (const path of ['client', 'lib/upstream/feishu', 'lib/upstream/platform', 'lib/muse-feishu-files.mjs', 'lib/muse-feishu-identity.mjs']) {
    assert.equal(existsSync(new URL(`./${path}`, import.meta.url)), false, `${path} is not an account remote dependency`)
  }
  let plugins = 0
  assert.throws(() => retired.apply({ plugin: () => { plugins++ } }, {
    enabled: true, appId: 'synthetic-app', appSecret: 'synthetic-secret', registeredBy: 'ou_owner',
  }), /legacy Feishu root provider has been removed; use @xmanrui\/dsh-im/)
  assert.equal(plugins, 0)
})
