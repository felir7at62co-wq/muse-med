/** Exercise the shipped upload validator without creating or sending media. */
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { importSnapshotModule } from '../muse-fixture-import.mjs'

export const name = 'snapshot-short-drama-upload'
export const inject = ['tools']

/** Run the validator before the recorded model reads its external result. */
export function apply(ctx) {
  let completed = false
  ctx.on('tools/pre-execute', async (exec, next) => {
    if (exec.name !== 'read') return next()
    assert.equal(completed, false)
    assert.ok(exec.agent)
    assert.deepEqual(exec.arguments, { file_path: 'upload-proof.json' })
    const { validateShortDramaDelivery } = await importSnapshotModule(
      new URL('../../../apps/desktop-host/src/short-drama-delivery.ts', import.meta.url),
      new URL('../../../apps/desktop-host/lib/types/short-drama-delivery.js', import.meta.url))
    const root = await mkdtemp(join(tmpdir(), 'muse-upload-snapshot-'))
    try {
      const project = join(root, 'short-drama'), episode = join(project, '视频', '第41集')
      const upload = join(episode, '00-交付上传', '41.mp4'), preview = join(episode, '01-修复候选', '41.mp4')
      for (const directory of [join(episode, '00-交付上传'), join(episode, '01-修复候选')]) await mkdir(directory, { recursive: true })
      await writeFile(join(project, 'project_config.json'), JSON.stringify({ jubian_script_id: 1 }))
      await writeFile(upload, 'unverified copy')
      await writeFile(preview, 'preview')
      await assert.rejects(validateShortDramaDelivery([upload], exec.signal), {
        name: 'ShortDramaUploadError', code: 'SHORT_DRAMA_UPLOAD_UNSTAGED',
      })
      assert.equal(await validateShortDramaDelivery([preview], exec.signal), undefined)
      const result = { rejected: 'SHORT_DRAMA_UPLOAD_UNSTAGED', preview: 'unchanged' }
      await writeFile(join(exec.agent.session.header.cwd, 'upload-proof.json'), JSON.stringify(result, null, 2) + '\n')
      completed = true
    } finally { await rm(root, { recursive: true, force: true }) }
    return next()
  })
}
