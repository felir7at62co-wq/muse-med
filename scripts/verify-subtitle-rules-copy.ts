/**
 * Require Muse's vendored subtitle rules to be byte copies of Jingliu's modules.
 *
 * Muse-native projects correct subtitles locally and Jingliu projects on the Jingliu server; both must apply
 * the same rules. A missing file on either side fails, so the local runner never ships partial rules.
 * @module scripts/verify-subtitle-rules-copy
 */

import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

/** Jingliu source directory, relative to the repository root. */
export const JINGLIU_RULES_DIR = 'services/jingliu/backend/app'
/** Muse vendored directory, relative to the repository root. */
export const MUSE_RULES_DIR = 'packages/drama/skills/skills/tweet-drama-draft-build/scripts/subtitle_rules'
/** Modules that must be identical in both directories. */
export const SHARED_RULE_MODULES = ['subtitle_align.py', 'subtitle_cues.py'] as const

function read(root: string, path: string): Buffer | undefined {
  try { return readFileSync(resolve(root, path)) }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw error
  }
}

/**
 * Compare every shared rule module in one repository tree.
 * @param root - Repository root.
 * @returns One repository-relative diagnostic per missing or differing module; empty when all match.
 */
export function compareSubtitleRuleCopies(root: string): string[] {
  return SHARED_RULE_MODULES.flatMap((name) => {
    const source = `${JINGLIU_RULES_DIR}/${name}`, copy = `${MUSE_RULES_DIR}/${name}`
    const original = read(root, source), vendored = read(root, copy)
    if (original === undefined) return [`${source} is missing; the vendored rules have no source to match.`]
    if (vendored === undefined) return [`${copy} is missing; copy ${source} byte for byte.`]
    return original.equals(vendored) ? [] : [`${copy} differs from ${source}; copy it byte for byte.`]
  })
}

if (import.meta.main) {
  const failures = compareSubtitleRuleCopies(resolve(import.meta.dirname, '..'))
  for (const failure of failures) console.error(`verify-subtitle-rules-copy: ${failure}`)
  if (failures.length > 0) process.exit(1)
  console.log(`verify-subtitle-rules-copy: ${String(SHARED_RULE_MODULES.length)} rule modules match.`)
}
