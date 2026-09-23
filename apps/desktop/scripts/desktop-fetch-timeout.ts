/** Build-owned deadline for pnpm's complete registry response bodies. */

/**
 * Resolve the native pnpm fetch-timeout without admitting other npm environment overrides.
 * @param env - Builder environment; the optional override is positive integer milliseconds.
 * @returns Bounded request deadline, defaulting to thirty minutes for large native tarballs.
 */
export function desktopFetchTimeout(env: NodeJS.ProcessEnv): number {
  const value = env.DSH_DESKTOP_FETCH_TIMEOUT_MS
  if (value === undefined) return 1_800_000
  const timeout = Number(value)
  if (!/^[1-9]\d*$/u.test(value) || !Number.isSafeInteger(timeout) || timeout > 2_147_483_647) {
    throw new Error('DSH_DESKTOP_FETCH_TIMEOUT_MS must be a positive safe integer no greater than 2147483647 milliseconds')
  }
  return timeout
}
