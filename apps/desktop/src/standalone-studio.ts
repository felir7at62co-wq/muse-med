/** The opt-in standalone studio address carried to the desktop application document. */

/** Chromium's explicit additional-argument prefix for the standalone studio. */
export const STANDALONE_STUDIO_ARG = '--muse-standalone-studio='

/**
 * Accept only an IPv4 loopback origin with an explicit nondefault port.
 * @param configured - Administrator-provided MUSE_LOCALMINIDRAMA_URL.
 * @returns The origin without credentials, paths, fragments, or query parameters.
 */
export function standaloneStudioOrigin(configured: string | undefined): string | undefined {
  if (configured === undefined || configured === '') return undefined
  const port = /^http:\/\/127\.0\.0\.1:([1-9][0-9]{0,4})\/?$/u.exec(configured)?.[1]
  if (port === undefined || Number(port) > 65_535 || Number(port) === 80) {
    throw new Error('MUSE_LOCALMINIDRAMA_URL must be an http://127.0.0.1 origin with an explicit nondefault port')
  }
  return 'http://127.0.0.1:' + port
}
