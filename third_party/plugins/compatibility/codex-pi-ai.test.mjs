import assert from 'node:assert/strict'
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import test from 'node:test'

const source = join(import.meta.dirname, '../dsh-codex-subscription')
const overlayPath = join(import.meta.dirname, 'codex-pi-ai.mjs')

test('binds the staged Codex provider to the reviewed Host pi-ai without changing retained source', async () => {
  assert.ok(existsSync(overlayPath), 'the reviewed pi-ai adaptation is required')
  const { applyCodexPiAiCompatibility } = await import(pathToFileURL(overlayPath).href)
  const retained = readFileSync(join(source, 'src/pi-ai-runtime.js'), 'utf8')
  const retainedFixtures = readFileSync(join(source, 'tests/plugin-integration.test.mjs'), 'utf8')
  const root = mkdtempSync(join(tmpdir(), 'muse-codex-pi-ai-'))
  try {
    cpSync(source, root, { recursive: true })
    applyCodexPiAiCompatibility(root)
    const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
    assert.equal(manifest.peerDependencies['@earendil-works/pi-ai'], '0.87.1')
    assert.match(readFileSync(join(root, 'src/pi-ai-runtime.js'), 'utf8'), /PI_AI_RUNTIME_VERSIONS = Object\.freeze\(\['0\.87\.1'\]\)/)
    assert.match(readFileSync(join(root, 'tests/plugin-integration.test.mjs'), 'utf8'), /resolveModel\('openai-codex', 'gpt-5\.6-luna'\)\)\.context\.contextWindow, 400_000/)
    assert.equal(readFileSync(join(source, 'src/pi-ai-runtime.js'), 'utf8'), retained)
    assert.equal(readFileSync(join(source, 'tests/plugin-integration.test.mjs'), 'utf8'), retainedFixtures)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('rejects an unreviewed catalog fixture before updating staged declarations', async () => {
  const { applyCodexPiAiCompatibility } = await import(pathToFileURL(overlayPath).href)
  const root = mkdtempSync(join(tmpdir(), 'muse-codex-pi-ai-fixtures-'))
  try {
    cpSync(source, root, { recursive: true })
    const manifestPath = join(root, 'package.json')
    const runtimePath = join(root, 'src/pi-ai-runtime.js')
    const manifest = readFileSync(manifestPath, 'utf8')
    const runtime = readFileSync(runtimePath, 'utf8')
    writeFileSync(join(root, 'tests/plugin-integration.test.mjs'), 'export {}\n')
    assert.throws(() => applyCodexPiAiCompatibility(root), /pi-ai catalog fixtures require source review/)
    assert.equal(readFileSync(manifestPath, 'utf8'), manifest)
    assert.equal(readFileSync(runtimePath, 'utf8'), runtime)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('rejects an unreviewed Codex runtime before updating its compatibility declaration', async () => {
  assert.ok(existsSync(overlayPath), 'the reviewed pi-ai adaptation is required')
  const { applyCodexPiAiCompatibility } = await import(pathToFileURL(overlayPath).href)
  const root = mkdtempSync(join(tmpdir(), 'muse-codex-pi-ai-review-'))
  try {
    cpSync(source, root, { recursive: true })
    const manifestPath = join(root, 'package.json')
    const manifest = readFileSync(manifestPath, 'utf8')
    writeFileSync(join(root, 'src/pi-ai-runtime.js'), 'export const PI_AI_RUNTIME_VERSIONS = []\n')
    assert.throws(() => applyCodexPiAiCompatibility(root), /pi-ai runtime requires source review/)
    assert.equal(readFileSync(manifestPath, 'utf8'), manifest)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
