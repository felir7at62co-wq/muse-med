/** Await the reviewed Feishu SDK's underlying socket after requesting a forced close. */
import { once } from 'node:events'

/**
 * Close one SDK connection without leaving an unobserved close listener after failure.
 * @param {object | null} client SDK client whose pinned wsConfig exposes its current socket.
 * @returns {Promise<void>} Settles after socket closure, or rejects with the close failure.
 */
export async function closeMuseImSocket(client) {
  const socket = client?.wsConfig?.getWSInstance?.()
  const controller = new AbortController()
  const closed = socket && socket.readyState !== 3 ? once(socket, 'close', { signal: controller.signal }) : undefined
  closed?.catch(() => undefined)
  try {
    await client?.close({ force: true })
    await closed
  } finally {
    controller.abort()
  }
}
