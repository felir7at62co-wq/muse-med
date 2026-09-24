import assert from 'node:assert/strict'
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import { applyLarkDesktopCompatibility } from '../compatibility/lark-desktop.mjs'

const root = fileURLToPath(new URL('../', import.meta.url))

test('staged Lark configuration gates registration and cross-instance effects without changing upstream', () => {
  const staging = mkdtempSync(join(root, '.lark-overlay-test-'))
  try {
    cpSync(join(root, 'dsh-lark-bridge/src'), join(staging, 'src'), { recursive: true })
    applyLarkDesktopCompatibility(staging)
    const config = readFileSync(join(staging, 'src/config.ts'), 'utf8')
    const runtime = readFileSync(join(staging, 'src/runtime.ts'), 'utf8')
    const bridge = readFileSync(join(staging, 'src/bridge.ts'), 'utf8')
    for (const key of ['enabled', 'autoRegistration', 'crossInstanceSync']) {
      assert.match(config, new RegExp(`${key}: z\\.boolean\\(\\)\\.default\\(true\\)`))
      assert.match(config, new RegExp(`${key}: config\\.${key} \\?\\? true`))
    }
    assert.ok(runtime.indexOf('settings.register(') < runtime.indexOf('if (!resolved.enabled) return'))
    assert.match(runtime, /settings\.register\(SETTINGS_NAMESPACE, Config, \{ base: config, applies: 'restart' \}\)/u)
    assert.match(runtime, /if \(resolved\.crossInstanceSync\) \{[\s\S]*await readSettings\(\)[\s\S]*startSyncLayer\(resolved\)/u)
    assert.ok(runtime.indexOf('if (!resolved.autoRegistration) return') > runtime.indexOf('if (hasCredentials(resolved))'))
    assert.match(bridge, /if \(config\.crossInstanceSync && msg\.content\.trim\(\) !== '\/bot activate'\)/u)
    assert.match(bridge, /config\.crossInstanceSync \? getSyncContext\(\) : undefined,/u)
    assert.ok(!readFileSync(join(root, 'dsh-lark-bridge/src/config.ts'), 'utf8').includes('crossInstanceSync'))
  } finally {
    rmSync(staging, { recursive: true, force: true })
  }
})

test('an unreviewed upstream revision is rejected without a partial source overlay', () => {
  const staging = mkdtempSync(join(root, '.lark-overlay-test-'))
  try {
    cpSync(join(root, 'dsh-lark-bridge/src'), join(staging, 'src'), { recursive: true })
    const path = join(staging, 'src/bridge.ts')
    writeFileSync(path, readFileSync(path, 'utf8').replace("if (msg.content.trim() !== '/bot activate')", 'if (false)'))
    const before = readFileSync(join(staging, 'src/config.ts'), 'utf8')
    assert.throws(() => applyLarkDesktopCompatibility(staging), /source review/u)
    assert.equal(readFileSync(join(staging, 'src/config.ts'), 'utf8'), before)
  } finally {
    rmSync(staging, { recursive: true, force: true })
  }
})
