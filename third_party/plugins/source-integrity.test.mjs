/** Maintained retained-source edits are exact inputs to the artifact builder. */
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { assertCommunitySourceIntegrity } from './source-integrity.mjs'

test('accepts declared local bytes and rejects changed or missing files', () => {
  const root = mkdtempSync(join(tmpdir(), 'muse-retained-integrity-'))
  try {
    const bytes = 'export const fixture = true\n'
    const pin = { localModifications: { files: { 'index.js': { sha256: createHash('sha256').update(bytes).digest('hex') } } } }
    writeFileSync(join(root, 'index.js'), bytes)
    assertCommunitySourceIntegrity(root, pin)
    writeFileSync(join(root, 'index.js'), 'export const fixture = false\n')
    assert.throws(() => assertCommunitySourceIntegrity(root, pin), /local source hash mismatch: index\.js/)
    rmSync(join(root, 'index.js'))
    assert.throws(() => assertCommunitySourceIntegrity(root, pin), /ENOENT/)
    assertCommunitySourceIntegrity(root, {})
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
