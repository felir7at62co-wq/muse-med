/** Workspace reference intake uses real path resolution and header-derived roots. */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdir, symlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { failureOf, openWorkspace, signal, type Harness } from './harness.ts'

let harness: Harness
beforeEach(async () => { harness = await openWorkspace('dsh-workspace-references-') })
afterEach(async () => { await harness.dispose() })

describe('workspaceFiles.references', () => {
  it('returns ordered workspace-relative paths for existing regular files', async () => {
    await mkdir(join(harness.workspace, 'src'))
    await writeFile(join(harness.workspace, 'src', 'notes 中文.txt'), 'notes')
    await writeFile(join(harness.workspace, 'clip.mp4'), 'video')
    expect(await harness.endpoint().references(harness.scope, harness.workspace, [
      join(harness.workspace, 'clip.mp4'), join(harness.workspace, 'src', 'notes 中文.txt'),
    ], signal())).toEqual(['clip.mp4', 'src/notes 中文.txt'])
  })

  it('rejects a source root different from the target session workspace', async () => {
    await writeFile(join(harness.workspace, 'notes.txt'), 'notes')
    expect(await failureOf(harness.endpoint().references(harness.scope, harness.outside, ['notes.txt'], signal())))
      .toMatchObject({ code: 'workspace-file/outside-workspace' })
  })

  it('refuses the complete batch when any path leaves the workspace', async () => {
    await writeFile(join(harness.workspace, 'notes.txt'), 'notes')
    await writeFile(join(harness.outside, 'secret.txt'), 'private')
    expect(await failureOf(harness.endpoint().references(harness.scope, harness.workspace, [
      'notes.txt', join(harness.outside, 'secret.txt'),
    ], signal()))).toMatchObject({ code: 'workspace-file/outside-workspace' })
  })

  it('rejects a file reached through a directory link outside the workspace', async () => {
    await writeFile(join(harness.outside, 'secret.txt'), 'private')
    await symlink(harness.outside, join(harness.workspace, 'linked'), process.platform === 'win32' ? 'junction' : 'dir')
    expect(await failureOf(harness.endpoint().references(harness.scope, harness.workspace, ['linked/secret.txt'], signal())))
      .toMatchObject({ code: 'workspace-file/outside-workspace' })
  })

  it('rejects missing files and directories', async () => {
    await mkdir(join(harness.workspace, 'folder'))
    const endpoint = harness.endpoint()
    expect(await failureOf(endpoint.references(harness.scope, harness.workspace, ['missing.txt'], signal())))
      .toMatchObject({ code: 'workspace-file/not-found' })
    expect(await failureOf(endpoint.references(harness.scope, harness.workspace, ['folder'], signal())))
      .toMatchObject({ code: 'workspace-file/not-regular-file' })
  })
})
