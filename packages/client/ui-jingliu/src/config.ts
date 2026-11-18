/** Public origins of the production studio and script workshop. */
import Schema from '@deepseek-ai/schemastery'

/** Public page configuration exposed to the desktop renderer. */
export interface Config {
  /** HTTPS studio origin or HTTP loopback origin for a local studio. */
  studioOrigin?: string
  /** Private HTTP loopback endpoint serving OpenChatCut. */
  editorOrigin?: string
  /** HTTPS workshop origin or HTTP loopback origin for a local script workshop. */
  workshopOrigin?: string
}

/** A missing origin leaves that application's entry hidden. */
export const Config = Schema.object({ studioOrigin: Schema.string(), workshopOrigin: Schema.string(), editorOrigin: Schema.string() })

/**
 * Resolve a workbench's original page from its configured origin.
 * @param origin - Dedicated origin without credentials, query, or fragment.
 * @param page - Studio or script workshop landing page.
 * @returns Public page URL, or undefined for an unconfigured workbench.
 */
export function studioUrl(origin: string | undefined, page: 'jingliu' | 'workshop' = 'jingliu'): string | undefined {
  if (!origin) return undefined
  const url = new URL(origin)
  const localHttp = url.protocol === 'http:' && ['127.0.0.1', '[::1]'].includes(url.hostname)
  if ((!localHttp && url.protocol !== 'https:') || url.origin !== origin.replace(/\/$/u, '')) {
    throw new TypeError(`${page} requires an HTTPS origin or HTTP loopback origin.`)
  }
  return new URL(page === 'jingliu' ? '/fwp/v2/auth/muse/embed' : '/v1/auth/muse/embed', url).href
}

/**
 * Resolve the local editor without forwarding Muse account credentials.
 * @param origin - Numeric HTTP loopback origin with an explicit port.
 * @returns Editor homepage, or undefined when disabled.
 */
export function editorUrl(origin: string | undefined): string | undefined {
  if (!origin) return undefined
  const url = new URL(origin)
  if (url.protocol !== 'http:' || !url.port || !['127.0.0.1', '[::1]'].includes(url.hostname) ||
    url.origin !== origin.replace(/\/$/u, '')) throw new TypeError('OpenChatCut requires a numeric HTTP loopback origin with a port.')
  return url.href
}
