/** Channel policy applied after electron-updater's channel setter. */
import type { AppUpdater } from 'electron-updater'

/**
 * Select the operator-managed feed, accepting prereleases while preventing downgrades.
 * @param updater - Updater whose prior operations have settled.
 * @param channel - Selected distribution channel.
 * @param feedChannel - Product feed name; Muse stable releases retain their latest feed.
 */
export function selectUpdateChannel(updater: Pick<AppUpdater, 'channel' | 'allowDowngrade' | 'allowPrerelease'>,
  channel: 'nightly' | 'stable', feedChannel: string = channel): void {
  updater.channel = feedChannel
  // The library channel setter enables downgrades.
  updater.allowDowngrade = false
  updater.allowPrerelease = feedChannel !== 'latest'
}
