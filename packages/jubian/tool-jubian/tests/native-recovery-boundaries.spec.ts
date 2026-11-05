/** Durable recovery refuses replaced project entries before provider reads. */
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import * as files from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it, onTestFinished, vi } from 'vitest'
import { JubianClient, JubianLedger } from '@deepseek-ai/dsh-jubian'
import { recoverVideoSubmission } from '../src/native.ts'

vi.mock('node:fs/promises', async importOriginal => ({ ...await importOriginal<typeof import('node:fs/promises')>() }))

it.each(['project-file', 'tasks-link', 'config-link', 'preview-directory', 'preview-link'] as const)(
  'does not query or submit when the recorded recovery %s is unsafe', async (kind) => {
    const root = await mkdtemp(join(tmpdir(), 'jubian-recovery-entry-'))
    onTestFinished(async () => { await rm(root, { recursive: true, force: true }) })
    const project = join(root, 'project')
    const tasks = join(project, 'video_tasks')
    const preview = join(tasks, 'preview.json')
    const ledger = new JubianLedger({ root: join(root, 'ledger') })
    await ledger.begin({ idempotencyKey: 'recover-original', method: 'storyboard_native_submit',
      requestSha256: 'request-digest', beforeTaskIds: [], videoPreviewPath: preview })
    if (kind === 'project-file') await writeFile(project, 'replaced directory')
    else {
      await mkdir(project)
      if (kind === 'tasks-link') {
        const elsewhere = join(root, 'elsewhere')
        await mkdir(elsewhere)
        await symlink(elsewhere, tasks, process.platform === 'win32' ? 'junction' : 'dir')
      } else {
        await mkdir(tasks)
        if (kind === 'config-link') {
          const target = join(root, 'other-config.json')
          await writeFile(target, '{}')
          await symlink(target, join(project, 'project_config.json'), 'file')
        } else {
          await writeFile(join(project, 'project_config.json'), '{}')
          if (kind === 'preview-directory') await mkdir(preview)
          else {
            const target = join(root, 'other-preview.json')
            await writeFile(target, '{}')
            await symlink(target, preview, 'file')
          }
        }
      }
    }
    const fetch = vi.fn<typeof globalThis.fetch>()
    const client = new JubianClient({ credential: async () => 'fixture-token', fetch })
    expect(await recoverVideoSubmission(client, ledger, project, 'recover-original')).toBeUndefined()
    expect(fetch).not.toHaveBeenCalled()
    expect(await ledger.find('recover-original')).toMatchObject({ outcome: null })
  },
)

it('refuses a preview that resolves outside the project after entry checks', async () => {
  const root = await mkdtemp(join(tmpdir(), 'jubian-recovery-resolution-'))
  onTestFinished(async () => { await rm(root, { recursive: true, force: true }) })
  const project = join(root, 'project')
  const preview = join(project, 'video_tasks', 'preview.json')
  await mkdir(join(project, 'video_tasks'), { recursive: true })
  await writeFile(join(project, 'project_config.json'), '{}')
  await writeFile(preview, '{}')
  const ledger = new JubianLedger({ root: join(root, 'ledger') })
  await ledger.begin({ idempotencyKey: 'recover-original', method: 'storyboard_native_submit',
    requestSha256: 'request-digest', beforeTaskIds: [], videoPreviewPath: preview })
  const canonicalProject = await files.realpath(project)
  const resolution = vi.spyOn(files, 'realpath').mockResolvedValueOnce(canonicalProject)
    .mockResolvedValueOnce(join(root, 'replaced-preview.json'))
  onTestFinished(() => { resolution.mockRestore() })
  const fetch = vi.fn<typeof globalThis.fetch>()
  const client = new JubianClient({ credential: async () => 'fixture-token', fetch })
  expect(await recoverVideoSubmission(client, ledger, project, 'recover-original')).toBeUndefined()
  expect(fetch).not.toHaveBeenCalled()
})
