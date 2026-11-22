import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { compareSubtitleRuleCopies, JINGLIU_RULES_DIR, MUSE_RULES_DIR, SHARED_RULE_VECTORS } from './verify-subtitle-rules-copy.ts'

const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })

function tree(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), 'dsh-subtitle-rules-'))
  roots.push(root)
  for (const path of [JINGLIU_RULES_DIR, MUSE_RULES_DIR, `${SHARED_RULE_VECTORS.source}/..`, `${SHARED_RULE_VECTORS.copy}/..`]) {
    mkdirSync(join(root, path), { recursive: true })
  }
  for (const [path, text] of Object.entries({ [SHARED_RULE_VECTORS.source]: '{}', [SHARED_RULE_VECTORS.copy]: '{}', ...files })) {
    writeFileSync(join(root, path), text)
  }
  return root
}

describe('subtitle rules copy gate', () => {
  const both = (align: string, cues: string) => ({
    [`${JINGLIU_RULES_DIR}/subtitle_align.py`]: 'align\n', [`${MUSE_RULES_DIR}/subtitle_align.py`]: align,
    [`${JINGLIU_RULES_DIR}/subtitle_cues.py`]: 'cues\n', [`${MUSE_RULES_DIR}/subtitle_cues.py`]: cues,
  })

  it('accepts byte-identical copies', () => {
    expect(compareSubtitleRuleCopies(tree(both('align\n', 'cues\n')))).toEqual([])
  })

  it('rejects a one-byte difference', () => {
    expect(compareSubtitleRuleCopies(tree(both('align\r\n', 'cues\n')))).toEqual([
      `${MUSE_RULES_DIR}/subtitle_align.py differs from ${JINGLIU_RULES_DIR}/subtitle_align.py; copy it byte for byte.`,
    ])
  })

  it('rejects differing vectors', () => {
    expect(compareSubtitleRuleCopies(tree({ ...both('align\n', 'cues\n'), [SHARED_RULE_VECTORS.copy]: '{"cases":[]}' }))).toEqual([
      `${SHARED_RULE_VECTORS.copy} differs from ${SHARED_RULE_VECTORS.source}; copy it byte for byte.`,
    ])
  })

  it('rejects a missing source or copy instead of skipping it', () => {
    const root = tree({ [`${JINGLIU_RULES_DIR}/subtitle_align.py`]: 'align\n', [`${MUSE_RULES_DIR}/subtitle_align.py`]: 'align\n',
      [`${MUSE_RULES_DIR}/subtitle_cues.py`]: 'cues\n' })
    expect(compareSubtitleRuleCopies(root)).toEqual([
      `${JINGLIU_RULES_DIR}/subtitle_cues.py is missing; the vendored rules have no source to match.`,
    ])
    rmSync(join(root, MUSE_RULES_DIR, 'subtitle_align.py'))
    expect(compareSubtitleRuleCopies(root)[0]).toContain(`${MUSE_RULES_DIR}/subtitle_align.py is missing`)
  })
})
