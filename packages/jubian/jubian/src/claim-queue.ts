/** Same-runtime reservations and budget changes share one queue per resolved ledger root. */
const pending = new Map<string, Promise<unknown>>()

/**
 * Serialize an operation with every claim and budget update for this ledger.
 * @param root - Resolved ledger root.
 * @param run - Operation that reads accounting before committing its change.
 * @returns The operation's result; rejection does not block later operations.
 */
export async function withLedgerQueue<T>(root: string, run: () => Promise<T>): Promise<T> {
  const key = process.platform === 'win32' ? root.toLowerCase() : root
  const previous = pending.get(key) ?? Promise.resolve()
  const operation = previous.catch(() => undefined).then(run)
  pending.set(key, operation)
  try { return await operation }
  finally { if (pending.get(key) === operation) pending.delete(key) }
}
