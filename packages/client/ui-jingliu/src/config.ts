/** Public origins of the Jingliu production studio. */
import Schema from '@deepseek-ai/schemastery'

/** Public page configuration exposed to the desktop renderer. */
export interface Config {
  /** HTTPS studio origin or HTTP loopback origin for a local studio. */
  studioOrigin?: string
}

/** A missing origin leaves that application's entry hidden. */
export const Config = Schema.object({ studioOrigin: Schema.string() })

/**
 * Resolve a workbench's original page from its configured origin.
 * @param origin - Dedicated origin without credentials, query, or fragment.
 * @returns Public page URL, or undefined for an unconfigured workbench.
 */
export function studioUrl(origin: string | undefined): string | undefined {
  if (!origin) return undefined
  const url = new URL(origin)
  const localHttp = url.protocol === 'http:' && ['127.0.0.1', '[::1]'].includes(url.hostname)
  if (url.protocol === 'https:' && origin.replace(/\/$/u, '') === url.origin + '/jingliu') return url.origin + '/jingliu/'
  if ((!localHttp && url.protocol !== 'https:') || url.origin !== origin.replace(/\/$/u, '')) {
    throw new TypeError('Jingliu requires an HTTPS origin or HTTP loopback origin.')
  }
  return new URL('/fwp/v2/auth/muse/embed', url).href
}
