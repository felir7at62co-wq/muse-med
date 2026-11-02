/** Inspect the source-built native Bot package independently of a paid provider. */
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import test from 'node:test'
import { museBotDesktopCompatibility } from './compatibility/muse-bot-desktop.mjs'
import { resolvePnpmEntrypoint } from '../../scripts/pnpm-entrypoint.mjs'

const root = resolve(import.meta.dirname, '../..')
const source = join(import.meta.dirname, 'ds-bot')
const pin = JSON.parse(readFileSync(join(import.meta.dirname, 'sources.json'), 'utf8'))['ds-bot']

function member(archive, name) {
  const result = spawnSync('tar', ['-xOzf', archive, `package/${name}`], { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 })
  assert.equal(result.error, undefined)
  assert.equal(result.status, 0, result.stderr)
  return result.stdout
}

test('packs the Muse Bot Host, rebuilt Client and Apache notice without a standalone app', { timeout: 120_000 }, () => {
  const output = mkdtempSync(join(tmpdir(), 'muse-bot-build-'))
  const before = readFileSync(join(source, 'client.js'))
  const officeBefore = readFileSync(join(source, 'office.js'))
  try {
    const environment = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/KEY|SECRET|TOKEN|PASSWORD|^NODE_TEST_/iu.test(key)))
    environment.npm_execpath = resolvePnpmEntrypoint(join(root, 'node_modules/pnpm/package.json'))
    const result = spawnSync(process.execPath, [join(import.meta.dirname, 'build.mjs'), '--only', 'ds-bot', '--out', output], {
      cwd: root, env: environment, encoding: 'utf8', timeout: 110_000, maxBuffer: 8 * 1024 * 1024,
    })
    assert.equal(result.error, undefined)
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`)
    assert.deepEqual(readdirSync(output), [`ds-bot-${pin.version}.tgz`])
    const archive = join(output, `ds-bot-${pin.version}.tgz`)
    const manifest = JSON.parse(member(archive, 'package.json'))
    assert.equal(manifest.name, 'ds-bot')
    assert.equal(manifest.version, pin.version)
    assert.equal(manifest.license, 'Apache-2.0')
    assert.deepEqual(manifest.scripts, {})
    assert.equal(manifest.bin, undefined)
    assert.equal(manifest.peerDependencies['@deepseek-ai/dsh-web'], undefined)
    assert.equal(manifest.exports['./web-search'], undefined)
    assert.equal(manifest.dependencies['deep-view'], '0.1.0')
    assert.equal(member(archive, 'LICENSE'), readFileSync(join(source, 'LICENSE'), 'utf8'))
    assert.equal(member(archive, 'NOTICE'), readFileSync(join(source, 'NOTICE'), 'utf8'))
    const bundledLicenses = member(archive, 'BUNDLED_LICENSES.md')
    for (const dependency of ['deep-view', '@xmldom/xmldom']) {
      assert.ok(bundledLicenses.includes(readFileSync(join(import.meta.dirname, 'toolchain/node_modules', dependency, 'LICENSE'), 'utf8')))
    }
    assert.match(member(archive, 'client.js'), /window\.__ModuleLoader__\.load\(/u)
    assert.match(member(archive, 'client.js'), /Muse Bot/u)
    assert.ok(member(archive, 'src/host/muse-config.js').trim())
    for (const file of ['avatar-library', 'privacy', 'learning', 'office-skills']) {
      assert.ok(member(archive, `src/host/${file}.js`).trim())
    }
    for (const skill of ['office', 'office-tools']) {
      assert.ok(member(archive, `src/office/skills/${skill}/SKILL.md`).trim())
    }
    const officeCli = join(output, 'office.mjs')
    writeFileSync(officeCli, member(archive, 'office.js'))
    const inspected = spawnSync(process.execPath, [officeCli, 'docx', 'read', join(source, 'test/fixtures/office/sample.docx'), '--json'], { encoding: 'utf8' })
    assert.equal(inspected.status, 0, inspected.stderr)
    assert.equal(JSON.parse(inspected.stdout).ok, true)
    for (const file of ['src/host/tools.js', 'src/host/prompt.js']) {
      assert.equal(member(archive, file), readFileSync(join(source, file), 'utf8'))
    }
    assert.equal(member(archive, 'cordis.patch.yml'), readFileSync(join(source, 'cordis.patch.yml'), 'utf8'))
    assert.match(member(archive, 'cordis.patch.yml'), /memoryReview: true/u)
    assert.equal(member(archive, 'src/host/memory.js'), readFileSync(join(source, 'src/host/memory.js'), 'utf8'))
    assert.equal(member(archive, 'src/host/muse-config.js'), readFileSync(join(source, 'src/host/muse-config.js'), 'utf8'))
    const metadata = JSON.parse(member(archive, 'SOURCE.json'))
    assert.deepEqual(metadata.upstream, pin)
    assert.deepEqual(metadata.compatibilityOverlay, museBotDesktopCompatibility)
    assert.equal(metadata.compatibilityOverlay.memoryReview, true)
    assert.equal(metadata.compatibilityOverlay.autoSessionBots, false)
    const list = spawnSync('tar', ['-tzf', archive], { encoding: 'utf8' })
    assert.equal(list.status, 0)
    assert.doesNotMatch(list.stdout, /(?:^|\n)package\/(?:dev|node_modules|test|web-search\.js|\.env|\.git)(?:\/|$|\n)/u)
    assert.deepEqual(readFileSync(join(source, 'client.js')), before)
    assert.deepEqual(readFileSync(join(source, 'office.js')), officeBefore)
  } finally {
    rmSync(output, { recursive: true, force: true })
  }
})
