/** Consume only this scenario's empty input-directory marker. */
import { readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'

/**
 * @param {string} workspace - Private replay workspace copied from this owner's seed.
 * @returns {Promise<void>} Completion after the marker has been checked and removed.
 */
export async function consumeDraftSeed(workspace) {
  const marker = join(workspace, 'drafts', '.keep')
  if (await readFile(marker, 'utf8') !== '') throw new Error('Expected the empty draft-directory seed marker')
  await rm(marker)
}
