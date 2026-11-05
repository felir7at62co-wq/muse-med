/** Resolve the native node-pty input used by the SDK and SSH executable builders. */

import { existsSync, lstatSync } from 'node:fs'
import { cp, readdir, rm } from 'node:fs/promises'
import { join } from 'node:path'

/**
 * Stage the selected prebuild, retaining files that already share the installed file's inode.
 * @param packageDirectory - installed node-pty package directory.
 * @param stagedPackageDirectory - deployed node-pty package directory.
 * @param selected - prebuild directory name for the target platform and architecture.
 * @returns resolves after the target prebuild is staged and other targets are removed.
 */
export async function stageNodePtyPrebuild(packageDirectory: string, stagedPackageDirectory: string, selected: string): Promise<void> {
  const source = join(packageDirectory, 'prebuilds', selected)
  const prebuilds = join(stagedPackageDirectory, 'prebuilds')
  if (existsSync(source)) {
    await cp(source, join(prebuilds, selected), { recursive: true, filter: (from, to) => {
      const destinationStat = lstatSync(to, { bigint: true, throwIfNoEntry: false })
      if (!destinationStat?.isFile() || destinationStat.ino === 0n || destinationStat.dev === 0n) return true
      const sourceStat = lstatSync(from, { bigint: true })
      return sourceStat.ino !== destinationStat.ino || sourceStat.dev !== destinationStat.dev
    } })
  }
  for (const entry of await readdir(prebuilds, { withFileTypes: true })) {
    if (entry.isDirectory() && entry.name !== selected) await rm(join(prebuilds, entry.name), { recursive: true, force: true })
  }
}

/**
 * Prefer the workflow's manylinux build and fall back to node-pty's target prebuild.
 * @param packageDirectory - installed node-pty package directory.
 * @param arch - Linux target architecture.
 * @returns the existing addon path.
 */
export function resolveLinuxNodePtyAddon(
  packageDirectory: string,
  arch: 'x64' | 'arm64',
): string {
  const built = join(packageDirectory, 'build', 'Release', 'pty.node')
  if (existsSync(built)) return built
  const prebuilt = join(packageDirectory, 'prebuilds', `linux-${arch}`, 'pty.node')
  if (existsSync(prebuilt)) return prebuilt
  throw new Error(
    `executable-native-pty: node-pty addon is absent from both ${built} and ${prebuilt}.`,
  )
}

/**
 * Require both node-pty addons used by the Windows ConPTY backend.
 * @param packageDirectory - staged node-pty package directory.
 * @param arch - Windows target architecture.
 * @returns the existing addon paths in load order.
 */
export function resolveWindowsNodePtyAddons(
  packageDirectory: string,
  arch: 'x64',
): string[] {
  const directory = join(packageDirectory, 'prebuilds', `win32-${arch}`)
  const addons = [
    join(directory, 'conpty.node'),
    join(directory, 'conpty_console_list.node'),
  ]
  const missing = addons.filter(path => !existsSync(path))
  if (missing.length > 0) {
    throw new Error(`executable-native-pty: Windows node-pty addons are missing: ${missing.join(', ')}.`)
  }
  return addons
}
