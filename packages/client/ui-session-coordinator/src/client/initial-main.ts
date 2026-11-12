/** Follow connection generations while one feature owns the startup attempt. */

/**
 * Start or retry the initial navigation after each connection reset.
 * @param lifetime - feature lifetime.
 * @param onReset - register the connection reset callback.
 * @param start - start an attempt whose signal aborts on reset or disposal.
 * @param onError - report a failure only while its attempt is active.
 * @returns disposer for the reset listener and current attempt.
 */
export function followInitialMain(
  lifetime: AbortSignal,
  onReset: (follow: () => void) => () => void,
  start: (signal: AbortSignal) => Promise<void>,
  onError: (error: unknown) => void,
): () => void {
  let attempt: AbortController | undefined
  const follow = (): void => {
    attempt?.abort()
    attempt = new AbortController()
    const signal = AbortSignal.any([attempt.signal, lifetime])
    if (signal.aborted) return
    void start(signal).catch((error: unknown) => { if (!signal.aborted) onError(error) })
  }
  const stop = onReset(follow)
  follow()
  return () => { stop(); attempt?.abort() }
}
