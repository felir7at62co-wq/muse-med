/** File delivery rejects lexical and physical paths outside the active workspace. */
import { realpath, stat } from 'node:fs/promises'
import { isAbsolute } from 'node:path'
import { isPathAllowedForSend } from './upstream/platform/message-split.js'

/**
 * Validate the physical file before passing its canonical path to the SDK sender.
 * @param {object} options Active workspace, requested file path, and SDK send callback.
 * @returns {Promise<object>} Result from the sender; invalid paths reject before sending.
 */
export async function sendWorkspaceFile({ cwd, filePath, send }) {
  if (typeof cwd !== 'string' || !isAbsolute(cwd) || typeof filePath !== 'string' || !isAbsolute(filePath) || !isPathAllowedForSend(filePath, cwd)) throw new Error('Feishu media is outside the active workspace')
  const [workspace, file] = await Promise.all([realpath(cwd), realpath(filePath)])
  if (!isPathAllowedForSend(file, workspace) || !(await stat(file)).isFile()) throw new Error('Feishu media is outside the active workspace')
  return await send(file)
}
