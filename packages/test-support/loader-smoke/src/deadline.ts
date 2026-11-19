/** Test and subprocess deadlines shared by Loader smokes and source-only Vitest configuration. */

/** Default subprocess deadline, independent of the enclosing runner's timeout. */
export const LOADER_SMOKE_PROCESS_TIMEOUT_MS = 30_000

/** Default test deadline, including time for subprocess diagnostics and cleanup. */
export const LOADER_SMOKE_TEST_TIMEOUT_MS = LOADER_SMOKE_PROCESS_TIMEOUT_MS + 15_000

/**
 * Reserve diagnostic and cleanup time inside the enclosing test's effective deadline.
 * @param testTimeoutMs - Runner deadline; zero leaves the runner unbounded and keeps the default subprocess deadline.
 * @returns Subprocess deadline with the same reserve as the default Loader smoke.
 * @throws When the deadline is non-finite or leaves no subprocess time.
 */
export function loaderSmokeProcessTimeout(testTimeoutMs: number): number {
  if (testTimeoutMs === 0) return LOADER_SMOKE_PROCESS_TIMEOUT_MS
  const reserve = LOADER_SMOKE_TEST_TIMEOUT_MS - LOADER_SMOKE_PROCESS_TIMEOUT_MS
  if (!Number.isFinite(testTimeoutMs) || testTimeoutMs <= reserve) {
    throw new Error(`Loader smoke test deadline ${testTimeoutMs}ms must exceed the ${reserve}ms diagnostic and cleanup reserve`)
  }
  return testTimeoutMs - reserve
}
