/** Await the reviewed Feishu SDK's underlying socket after requesting a forced close. */
import { once } from 'node:events'

/**
 * Close one SDK connection and wait until its socket has closed.
 * The SDK's `close()` removes every socket listener before it terminates the socket, so the
 * close listener is attached only after `close()` returns; `terminate()` emits `close` later.
 * @param {object | null} client SDK client whose pinned wsConfig exposes its current socket.
 * @returns {Promise<void>} Settles after socket closure, or rejects with the close failure.
 */
export async function closeMuseImSocket(client) {
  const socket = client?.wsConfig?.getWSInstance?.()
  await client?.close({ force: true })
  if (socket && socket.readyState !== 3) await once(socket, 'close')
}
