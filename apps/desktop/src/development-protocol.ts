/** Protocol registration policy for unpackaged Desktop launches. */

/**
 * Read whether a development instance may register the system dsh protocol.
 * @param env - Development process environment; packaged launches do not read this setting.
 * @returns Explicit registration choice, defaulting to the existing enabled behavior.
 */
export function resolveDevelopmentProtocolRegistration(env: NodeJS.ProcessEnv): '0' | '1' {
  const value = env.DSH_DESKTOP_DEV_REGISTER_PROTOCOL ?? '1'
  if (value !== '0' && value !== '1') throw new Error('DSH_DESKTOP_DEV_REGISTER_PROTOCOL must be 0 or 1')
  return value
}
