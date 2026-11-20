/** Removal of the supplier-credential file that older Desktop versions saved beside the account session. */
import { rm } from 'node:fs/promises'
import { dirname, join } from 'node:path'

/**
 * Delete `model-access.json` beside the account session, whichever login or gateway wrote it.
 * Desktop never stores or uses supplier credentials; every Muse model request goes through the account gateway.
 * @param sessionFile - Account session file whose directory may hold the retired file.
 * @returns Completion once no such regular file remains; any other filesystem failure rejects.
 */
export async function removeModelAccessFile(sessionFile: string): Promise<void> {
  await rm(join(dirname(sessionFile), 'model-access.json'), { force: true })
}
