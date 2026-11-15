/** Canonical ancestor aliases preserve ownership without accepting endpoint links or unreadable paths. */
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import * as Files from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { JubianLedger } from '@deepseek-ai/dsh-jubian'
import { afterEach, expect, it, onTestFinished, vi } from 'vitest'
import { recoveryProject, recordedVideoPreview } from '../src/video-recovery-project.ts'
import { isProjectVideoIntent } from '../src/video-recovery.ts'

vi.mock('node:fs/promises', async original => ({ ...await original<typeof import('node:fs/promises')>() }))
afterEach(() => { vi.restoreAllMocks() })

it('accepts ancestor aliases for a recorded intent and refuses a final preview link', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'recovery-alias-')))
  onTestFinished(() => rm(root, { recursive: true, force: true }))
  const physical = join(root, 'physical'), alias = join(root, 'alias')
  const project = join(physical, 'project')
  await mkdir(join(project, 'video_tasks'), { recursive: true })
  await writeFile(join(project, 'project_config.json'), '{"jubian_script_id":1}')
  const preview = join(project, 'video_tasks', 'preview.json')
  await writeFile(preview, '{}')
  await symlink(physical, alias, process.platform === 'win32' ? 'junction' : 'dir')
  const aliasProject = join(alias, 'project')
  const ledger = new JubianLedger({ root: join(root, 'ledger') })
  const { record } = await ledger.begin({ idempotencyKey: 'original', method: 'storyboard_native_submit', scriptId: 1,
    requestSha256: 'original', beforeTaskIds: [], videoPreviewPath: join(aliasProject, 'video_tasks', 'preview.json') })
  const selected = await recoveryProject(aliasProject)
  expect(selected.directory).toBe(project)
  expect(await recordedVideoPreview(record, selected)).toBe(preview)
  expect(await isProjectVideoIntent(record, aliasProject)).toBe(true)
  expect(await isProjectVideoIntent(undefined, aliasProject)).toBe(false)
  await expect(recoveryProject('relative')).rejects.toThrow('absolute')
  const link = join(project, 'video_tasks', 'linked.json')
  await symlink(preview, link, 'file')
  expect(await recordedVideoPreview({ ...record, video_preview_path: link }, selected)).toBeUndefined()
  const denial = Object.assign(new Error('directory inspection denied'), { code: 'EACCES' })
  vi.spyOn(Files, 'lstat').mockRejectedValueOnce(denial)
  await expect(recordedVideoPreview(record, selected)).rejects.toBe(denial)
})
