/** Review the panel's profile-only activation in private staging while preserving upstream files. */
import assert from 'node:assert/strict'
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { applyMcpDesktopCompatibility, mcpDesktopCompatibility } from './mcp-desktop.mjs'

const source = join(import.meta.dirname, '../dsh-skill-mcp-panel')

test('retains the panel services without the automatic global CLI installer', () => {
  const root = mkdtempSync(join(tmpdir(), 'muse-panel-overlay-'))
  const original = readFileSync(join(source, 'src/index.ts'))
  const shim = readFileSync(join(source, 'src/global-shim.ts'))
  try {
    cpSync(source, root, { recursive: true })
    assert.deepEqual(applyMcpDesktopCompatibility(root), mcpDesktopCompatibility)
    assert.equal(mcpDesktopCompatibility.globalCliShim, false)
    const mounted = readFileSync(join(root, 'src/index.ts'), 'utf8')
    assert.doesNotMatch(mounted, /ensureGlobalShim|global-shim/)
    assert.match(mounted, /new SkillsViewerGateway\(ctx\);/)
    assert.match(mounted, /new McpManagerGateway\(ctx\);/)
    assert.match(mounted, /ctx\.skills\.registerProvider/)
    assert.deepEqual(readFileSync(join(source, 'src/index.ts')), original)
    assert.deepEqual(readFileSync(join(source, 'src/global-shim.ts')), shim)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

for (const anchor of ['import { ensureGlobalShim } from "./global-shim.js";', '  ensureGlobalShim(ctx.logger);']) {
  test(`requires source review when the retained CLI activation anchor changes: ${anchor}`, () => {
    const root = mkdtempSync(join(tmpdir(), 'muse-panel-anchor-'))
    try {
      cpSync(source, root, { recursive: true })
      const path = join(root, 'src/index.ts')
      writeFileSync(path, readFileSync(path, 'utf8').replace(anchor, '// changed upstream CLI activation'))
      assert.throws(() => applyMcpDesktopCompatibility(root), /MCP Desktop overlay anchor changed: src\/index\.ts/)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
}
