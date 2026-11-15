/** Recheck v2 file claims without granting Session or publication authority. */
import { lstat, readdir, realpath } from 'node:fs/promises'
import { inspectEpisodeFile } from './episode-render-inputs.ts'
import type { EpisodeRenderDescriptorV2, EpisodeRenderDescriptorV4 } from './episode-render-descriptor.ts'

/**
 * Recheck the staged bytes and, for a Host capture, the original bytes and directory entries.
 * This does not authenticate the descriptor, Session, workspace or aliases and does not lock files.
 * @param descriptor - Structurally checked data from the physical execution.
 * @param mode - Worker stage-only check or Host original-and-stage check.
 * @param signal - Owning Host or worker lifetime.
 */
export async function verifyEpisodeSourceClaimFiles(descriptor: EpisodeRenderDescriptorV2 | EpisodeRenderDescriptorV4,
  mode: 'stage' | 'original-and-stage', signal: AbortSignal): Promise<void> {
  signal.throwIfAborted()
  if (await realpath(descriptor.stageRoot) !== descriptor.stageRoot) throw new Error('Episode source stage root changed')
  const directories = mode === 'stage' ? [] : descriptor.sourceClaim.directories
  const snapshots = await Promise.all(directories.map(async (directory) => {
    signal.throwIfAborted()
    const before = await lstat(directory.originalPath)
    if (!before.isDirectory() || before.isSymbolicLink() || await realpath(directory.originalPath) !== directory.originalPath) {
      throw new Error('Episode source directory is not canonical')
    }
    const names = (await readdir(directory.originalPath)).sort()
    if (JSON.stringify(names) !== JSON.stringify([...directory.entries].sort())) throw new Error('Episode source directory changed')
    return { directory, before, names }
  }))
  for (const file of descriptor.sourceClaim.files) {
    for (const path of mode === 'stage' ? [file.stagedPath] : [file.originalPath, file.stagedPath]) {
      const fact = await inspectEpisodeFile(path, signal)
      if (fact.sha256 !== file.sha256 || fact.bytes !== file.bytes) throw new Error('Episode source file changed')
    }
    if (mode === 'original-and-stage') for (const alias of file.aliases ?? []) {
      signal.throwIfAborted()
      if (await realpath(alias) !== file.originalPath) throw new Error('Episode source alias changed')
    }
  }
  for (const { directory, before, names } of snapshots) {
    signal.throwIfAborted()
    const after = await lstat(directory.originalPath)
    if (!after.isDirectory() || after.isSymbolicLink() || after.dev !== before.dev || after.ino !== before.ino
      || after.mtimeMs !== before.mtimeMs || after.ctimeMs !== before.ctimeMs
      || await realpath(directory.originalPath) !== directory.originalPath
      || JSON.stringify((await readdir(directory.originalPath)).sort()) !== JSON.stringify(names)) {
      throw new Error('Episode source directory changed during inspection')
    }
  }
}
