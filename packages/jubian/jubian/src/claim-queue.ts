/** Reservations and budget changes share a process queue and a local writer lock. */
import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { withFileLock } from '@deepseek-ai/dsh-atomic-write'

const pending = new Map<string, Promise<unknown>>()

/**
 * Serialize accounting changes across instances and local Host processes.
 * @param root - Resolved ledger root.
 * @param run - Operation that reads accounting before committing its change.
 * @returns The operation's result; rejection does not block later operations.
 */
export async function withLedgerQueue<T>(root: string, run: () => Promise<T>): Promise<T> {
  const key = process.platform === 'win32' ? root.toLowerCase() : root
  const previous = pending.get(key) ?? Promise.resolve()
  const operation = previous.catch(() => undefined).then(async () => {
    await mkdir(root, { recursive: true, mode: 0o700 })
    return await withFileLock(join(root, 'writer.lock'), run)
  })
  pending.set(key, operation)
  try { return await operation }
  finally { if (pending.get(key) === operation) pending.delete(key) }
}
