import { readFile } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import yaml from 'js-yaml'
import { describe, expect, it } from 'vitest'
import { JUBIAN_TOKEN_REF, JubianClient, JubianLedger } from '@deepseek-ai/dsh-jubian'
import { mediaMethod, videoMethod } from '../src/methods.ts'

const enabled = process.env.DSH_JUBIAN_LIVE === '1'
const SCRIPT_ID = Number(process.env.DSH_JUBIAN_SCRIPT_ID ?? '2708')
/** Where the operator wants the real artifact; the check has no other side effect. */
const OUTPUT_DIR = process.env.DSH_JUBIAN_OUTPUT_DIR ?? join(tmpdir(), 'jubian-live-out')

/** One child result as this check reads it back from the tool. */
interface LiveSubtask {
  subtask_id: number
  video_url: string | null
  duration_seconds: number | null
  subtitle_box: unknown
  image_urls: string[]
}

async function storedToken(): Promise<string> {
  const home = process.env.DSH_HOME ?? join(homedir(), '.dsh')
  const document = yaml.load(await readFile(join(home, '.credentials.yaml'), 'utf8')) as
    { refs?: Record<string, unknown> } | undefined
  const value = document?.refs?.[JUBIAN_TOKEN_REF]
  if (typeof value !== 'string' || !value) throw new Error(`${JUBIAN_TOKEN_REF} is absent from the credential document`)
  return value
}

describe.skipIf(!enabled)('live video read and media download', () => {
  it('reads a project video task and its child result, then downloads the MP4', async () => {
    const client = new JubianClient({ credential: storedToken, maxResponseBytes: 32 * 1024 * 1024 })
    const ledger = new JubianLedger({ root: join(OUTPUT_DIR, 'ledger') })

    const listed = await videoMethod(client, ledger, { method: 'tasks', script_id: SCRIPT_ID, page_num: 1 })
    const tasks = (listed.tasks as { total: number; rows: { task_id: number; status: string | null }[] }).rows
    expect(tasks.length).toBeGreaterThan(0)

    const subtasks = await videoMethod(client, ledger, { method: 'subtasks', task_id: tasks[0]!.task_id })
    const rows = (subtasks.subtasks as { rows: LiveSubtask[] }).rows
    const first = rows.find(row => row.video_url !== null)
    expect(first, 'no child result carried a video URL').toBeDefined()

    // Save the finished video and its bound reference images where a human (or a
    // frame extractor) can reach them.
    const target = join(OUTPUT_DIR, `subtask-${first!.subtask_id}.mp4`)
    const downloaded = await mediaMethod({ method: 'download', media_kind: 'video',
      media_url: first!.video_url!, output_path: target })
    const bytes = await readFile(target)
    expect(bytes.subarray(4, 8).toString('ascii')).toBe('ftyp')

    const savedImages: string[] = []
    for (const [index, url] of first!.image_urls.entries()) {
      const image = await mediaMethod({ method: 'download', media_kind: 'image', media_url: url,
        output_path: join(OUTPUT_DIR, `ref-${index + 1}.jpg`) })
      savedImages.push(String(image.path))
    }
    console.log('ARTIFACT video =', downloaded.path, downloaded.bytes, downloaded.sha256)
    console.log('ARTIFACT duration_seconds =', first!.duration_seconds, 'subtitle_box =',
      JSON.stringify(first!.subtitle_box))
    console.log('ARTIFACT images =', JSON.stringify(savedImages))
    expect(savedImages.length).toBe(first!.image_urls.length)
  }, 600000)
})
