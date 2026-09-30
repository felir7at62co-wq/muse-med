/** Selection invalidation after editing material-marker identities in place. */
import { readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { JubianError } from '@deepseek-ai/dsh-jubian'
import type { JubianLedger } from '@deepseek-ai/dsh-jubian'
import { normalizedPrompt, stableSha256 } from '@deepseek-ai/dsh-jubian-api'
import { atomicWriteJson } from './json-file.ts'

function pathOf(ledger: JubianLedger, scriptId: number, storyboardId: number): string {
  return join(ledger.root, 'selection', `${scriptId}-${storyboardId}.required.json`)
}
function markerHash(prompt: unknown): string {
  if (typeof prompt !== 'string') throw new JubianError('CONTRACT_CHANGED', 'Missing prompt for selection review')
  return stableSha256([...normalizedPrompt(prompt).matchAll(/@\[([^\]]+)\]\(([^()\s]+)\)/g)]
    .map(match => [match[1], match[2]]))
}
async function required(ledger: JubianLedger, scriptId: number, storyboardId: number, prompt: unknown): Promise<boolean> {
  let raw: string
  try { raw = await readFile(pathOf(ledger, scriptId, storyboardId), 'utf8') }
  catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return false
    throw error
  }
  const value: unknown = JSON.parse(raw)
  if (!value || typeof value !== 'object' || !('version' in value) || value.version !== 1
    || !('script_id' in value) || value.script_id !== scriptId
    || !('storyboard_id' in value) || value.storyboard_id !== storyboardId
    || !('markers_sha256' in value) || typeof value.markers_sha256 !== 'string'
    || !/^[a-f0-9]{64}$/.test(value.markers_sha256)) {
    throw new JubianError('CONTRACT_CHANGED', 'Unreadable selection requirement; inspect the card before generating')
  }
  return value.markers_sha256 === markerHash(prompt)
}

/**
 * Persist a marker change requiring an explicit verified selection before video preparation.
 * @param ledger - Account-local ledger directory owning the requirement.
 * @param scriptId - Bound remote project ID.
 * @param storyboardId - Existing card ID.
 * @param prompt - Approved edited prompt; only markers determine the requirement.
 * @returns Completion after the requirement is atomically saved.
 */
export async function markReselection(ledger: JubianLedger, scriptId: number, storyboardId: number, prompt: unknown): Promise<void> {
  await atomicWriteJson(pathOf(ledger, scriptId, storyboardId), { version: 1, script_id: scriptId,
    storyboard_id: storyboardId, markers_sha256: markerHash(prompt) })
}

/**
 * Refuse preparing or submitting a card whose edited markers have not been reselected.
 * @param ledger - Account-local selection requirements.
 * @param scriptId - Bound remote project ID.
 * @param storyboardId - Card being prepared or submitted.
 * @param prompt - Current live prompt.
 * @returns Completion if its marker identities are eligible for preparation.
 */
export async function assertSelectionReady(ledger: JubianLedger, scriptId: number, storyboardId: number, prompt: unknown): Promise<void> {
  if (await required(ledger, scriptId, storyboardId, prompt)) {
    throw new JubianError('INVALID_ARGUMENT', '素材标记已修改，必须先 select_assets 并回读核对，再 prepare_video；同 key 换名称也需要重新选源。')
  }
}

/**
 * Clear the matching requirement only after a selection has been explicitly verified.
 * @param ledger - Account-local selection requirements.
 * @param scriptId - Verified selection's project ID.
 * @param storyboardId - Verified card ID.
 * @param prompt - Prompt in the verified selection snapshot.
 * @returns Completion after the matching requirement is removed.
 */
export async function clearReselection(ledger: JubianLedger, scriptId: number, storyboardId: number, prompt: unknown): Promise<void> {
  if (await required(ledger, scriptId, storyboardId, prompt)) await rm(pathOf(ledger, scriptId, storyboardId), { force: true })
}
