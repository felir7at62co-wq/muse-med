import { constants } from 'node:fs'
import { open, realpath, stat } from 'node:fs/promises'
import { basename, resolve } from 'node:path'
import { within } from '../folders.js'

const refuse = reason => Object.assign(new Error(reason), { refused: true })
const sizeError = (size, limit) => refuse(size === 0 ? 'empty file' : `file exceeds the ${limit / 1024 ** 2} MiB limit`)
const sameFile = (left, right) => left.dev === right.dev && left.ino === right.ino
  && left.size === right.size && left.mtimeNs === right.mtimeNs && left.ctimeNs === right.ctimeNs

// Check the file actually opened, in case a parent directory or the file changed
// between resolution and open. A symlink that leads outside the workspace is refused.
async function useFile({ root, path, limit, inData, identity }, action) {
  let handle
  try {
    const real = await realpath(path)
    if (!within(real, root)) throw refuse('outside your working folder')
    if (await inData(real)) throw refuse('inside Muse data')
    if (!(await stat(real)).isFile()) throw refuse('not a regular file')
    handle = await open(real, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0))
    const info = await handle.stat({ bigint: true })
    const confirmed = await realpath(real)
    const current = await stat(confirmed, { bigint: true })
    if (!info.isFile() || confirmed !== real || !sameFile(current, info)) {
      throw refuse('file changed while it was being opened')
    }
    if (identity !== undefined && !sameFile(identity, info)) throw refuse('file changed after it was queued')
    const size = Number(info.size)
    if (size === 0 || size > limit) throw sizeError(size, limit)
    return await action(handle, real, size, info)
  } catch (error) {
    if (error?.refused === true) throw error
    // System messages can disclose paths outside the workspace.
    throw refuse(error?.code === 'ENOENT' || error?.code === 'ENOTDIR' ? 'no file at that path' : 'file could not be read')
  } finally {
    await handle?.close()
  }
}

/**
 * Validate a file selected for chat delivery without reading its contents.
 * @param {{ root: string, workspace: string, base: string, path: string, limit: number, inData: (path: string) => Promise<boolean> }} request - Canonical and configured workspace, session directory, user path, byte cap and protected-data check.
 * @returns {Promise<{ path: string, name: string, identity: import('node:fs').BigIntStats }>} The checked path, displayed filename and file identity.
 */
export async function checkWorkFile({ root, workspace, base, path, limit, inData }) {
  const full = resolve(base, path)
  if (!within(full, root) && !within(full, resolve(workspace))) throw refuse('outside your working folder')
  return useFile({ root, path: full, limit, inData }, (_handle, real, _size, identity) => ({ path: real, name: basename(full), identity }))
}

/**
 * Read a queued file only while it still satisfies the same constraints.
 * @param {{ root: string, path: string, limit: number, inData: (path: string) => Promise<boolean>, identity: import('node:fs').BigIntStats }} request - Checked path and identity, workspace, byte cap and protected-data check.
 * @returns {Promise<Buffer>} The bytes to attach to the message.
 */
export function readWorkFile(request) {
  return useFile(request, async (handle, _real, size, identity) => {
    const bytes = Buffer.allocUnsafe(size)
    let offset = 0
    while (offset < size) {
      const { bytesRead } = await handle.read(bytes, offset, size - offset, offset)
      if (bytesRead === 0) throw refuse('file became shorter while it was being read')
      offset += bytesRead
    }
    if (!sameFile(await handle.stat({ bigint: true }), identity)) throw refuse('file changed while it was being read')
    return bytes
  })
}
