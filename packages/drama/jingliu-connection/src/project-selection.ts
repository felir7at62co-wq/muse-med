/** Durable cloud project selection, separate from a conversation's local filesystem. */
import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { writeFileAtomic } from '@deepseek-ai/dsh-atomic-write'
import { resolveDshHome } from '@deepseek-ai/dsh-home-paths'
import { HarnessError } from '@deepseek-ai/dsh-error'
import { isRecord } from './http.ts'
import type { SelectedProject } from './types.ts'

function filename(session: string): string {
  return join(resolveDshHome(), 'jingliu', 'sessions', createHash('sha256').update(session).digest('hex') + '.json')
}

/**
 * Recover the recorded production after restarting Muse.
 * @param session - Actual Muse conversation.
 * @returns The stored selection or null before confirmation.
 */
export async function readSelection(session: string): Promise<(SelectedProject & { owner: string }) | null> {
  let json: string
  try { json = await readFile(filename(session), 'utf8') }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error }
  const data: unknown = JSON.parse(json)
  if (!isRecord(data) || data.version !== 1 || data.session !== session || typeof data.owner !== 'string' || !data.owner ||
      typeof data.id !== 'string' || !/^[a-zA-Z0-9_-]{1,128}$/u.test(data.id) || typeof data.title !== 'string') {
    throw new HarnessError('无法读取这段对话的制片项目，请重新确认项目。', 'JINGLIU_INVALID_PROJECT')
  }
  return { id: data.id, title: data.title, owner: data.owner }
}

/**
 * Atomically associate a production with one conversation and studio identity.
 * @param session - Actual Muse conversation.
 * @param owner - Verified studio user.
 * @param project - Confirmed project.
 */
export async function storeSelection(session: string, owner: string, project: SelectedProject): Promise<void> {
  await writeFileAtomic(filename(session), JSON.stringify({ version: 1, session, owner, ...project }), { mode: 0o600, dirMode: 0o700 })
}
