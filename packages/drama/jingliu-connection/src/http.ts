/** Jingliu names, origin validation and media addresses over the shared workbench requests. */
import { HarnessError } from '@deepseek-ai/dsh-error'
import { WorkbenchHttpError, type WorkbenchLabel, type WorkbenchRequest } from '@deepseek-ai/dsh-workbench-connection'
import { boundedBytes as readBounded, workbenchOrigin } from '@deepseek-ai/dsh-workbench-connection/transport'

export { isRecord } from '@deepseek-ai/dsh-workbench-connection/transport'

/** Jingliu's name in failures and error codes. */
export const JINGLIU: WorkbenchLabel = { name: '镜流', code: 'JINGLIU' }

/** A failure reported by the Jingliu API. */
export const JingliuHttpError = WorkbenchHttpError
/** A failure reported by the Jingliu API. */
export type JingliuHttpError = WorkbenchHttpError

/** Validate the configured deployment before using its credentials.
 * @param value - Deployment origin with no route or credentials.
 * @returns Normalized origin.
 */
export function studioOrigin(value: string): string {
  return workbenchOrigin(value, 'jingliu', JINGLIU)
}

/** Options for one call below the deployment's V2 API. */
export type JingliuRequest = WorkbenchRequest

/**
 * Resolve a studio-relative file under its authenticated media mount.
 * @param deployment - Configured studio.
 * @param media - Native media path.
 * @returns An address confined to this studio's media mount.
 */
export function mediaUrl(deployment: string, media: string): URL {
  if (!/^\/fw(?:p)?\/media\//u.test(media) || /[?#\\]|%(?:25|2e|2f|5c)/iu.test(media) || media.split('/').some(s => s === '.' || s === '..')) {
    throw new HarnessError('素材地址不属于当前镜流媒体库。', 'JINGLIU_INVALID_MEDIA')
  }
  return new URL(deployment + media.replace(/^\/fwp?\//u, '/fwp/'))
}

/**
 * Read a response body up to the caller’s size limit.
 * @param response - Studio response.
 * @param limit - Maximum decoded bytes.
 * @returns The bounded body.
 */
export async function boundedBytes(response: Response, limit: number): Promise<Buffer> {
  return await readBounded(response, limit, JINGLIU)
}
