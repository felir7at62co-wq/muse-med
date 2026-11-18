/** Public origin of the deployment that hosts the ShotFlow production workspace. */
import Schema from '@deepseek-ai/schemastery'

/** Public page configuration exposed to the desktop renderer. */
export interface Config {
  /** HTTPS studio origin or HTTP loopback origin for a local studio. */
  studioOrigin?: string
}

/** A missing origin leaves the studio entry hidden. */
export const Config = Schema.object({ studioOrigin: Schema.string() })

/**
 * Resolve the production workspace from its configured origin.
 * @param origin - Dedicated studio origin without credentials, query, or fragment.
 * @returns ShotFlow page URL, or undefined when the integration is unconfigured.
 */
export function studioUrl(origin: string | undefined): string | undefined {
  if (!origin) return undefined
  const url = new URL(origin)
  const localHttp = url.protocol === 'http:' && ['127.0.0.1', '[::1]'].includes(url.hostname)
  if ((!localHttp && url.protocol !== 'https:') || url.origin !== origin.replace(/\/$/u, '')) {
    throw new TypeError('Jingliu studioOrigin requires an HTTPS origin or HTTP loopback origin.')
  }
  return new URL('/sfp/', url).href
}
