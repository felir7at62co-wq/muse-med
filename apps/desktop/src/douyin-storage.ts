/** Select workspace-scoped persistent login storage only for official Douyin video tabs. */
import { createHash } from 'node:crypto'
import { douyinCreatorPage, douyinPage } from './douyin-policy.ts'

/**
 * @param workspace - resolved workspace identity.
 * @param initialUrl - renderer's requested first page.
 * @returns a stable private partition for Douyin videos, otherwise absent.
 */
export function douyinStoragePartition(workspace: string, initialUrl: unknown): string | undefined {
  if (typeof initialUrl !== 'string' || !(douyinPage(initialUrl) || douyinCreatorPage(initialUrl))) return undefined
  return `persist:muse-douyin-${createHash('sha256').update(workspace).digest('hex')}`
}

/** @param value - guest navigation URL. @returns whether a persistent Douyin tab can navigate its main document there. */
export function douyinStorageNavigation(value: string): boolean {
  if (!URL.canParse(value)) return false
  const url = new URL(value)
  return (
    url.protocol === 'https:' &&
    !url.username &&
    !url.password &&
    (!url.port || url.port === '443') &&
    ['v.douyin.com', 'www.douyin.com', 'www.iesdouyin.com', 'creator.douyin.com'].includes(url.hostname)
  )
}
