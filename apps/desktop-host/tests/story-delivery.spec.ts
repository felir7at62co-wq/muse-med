/** Two-process story approval and actual Host Word/Present handoff using original synthetic media. */
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { z } from 'zod'
import { expect, it } from 'vitest'
import { LOADER_SMOKE_TEST_TIMEOUT_MS } from '@deepseek-ai/dsh-loader-smoke'
import { prepareStoryFixture, runStoryFixture, readStoryFixture } from '../../../packages/drama/screenplay-project/tests/fixtures/story-faithful-fixture.ts'
import { approveVideoMarkdown } from '../src/video-delivery.ts'

it.skipIf(!process.env.MUSE_TEST_PRIMARY_RUNTIME)('cold-verifies actual story evidence before Word and paired Present, rejecting a changed report', async () => {
  const root = await mkdtemp(join(tmpdir(), 'story-host-delivery-'))
  try {
    await prepareStoryFixture(root)
    const first = await runStoryFixture(root), fixture = await readStoryFixture(root, first.stdout)
    expect(fixture.project.accepted).toHaveLength(1)
    if (fixture.input === undefined) throw Error('The accepted synthetic story was not exported')
    await expect(approveVideoMarkdown([fixture.input], join(root, 'without-host.docx'), 1000000, fixture.projectPath))
      .rejects.toThrow('story_video_evidence_pending')
    await mkdir(join(root, 'host'), { recursive: true })
    await writeFile(join(root, 'host/runtime.patch.yml'), `- id: screenplay-docx\n  config:\n    source: ${JSON.stringify(process.env.MUSE_TEST_PRIMARY_RUNTIME)}\n    maxInputBytes: 1000000\n    maxProjectBytes: 1000000\n    timeoutMs: 30000\n`)
    await runStoryFixture(root, { phase: 'accepted-cold', prompt: 'Verify the accepted original synthetic story and deliver Word with its separate notes.',
      patches: [fileURLToPath(new URL('./fixtures/video-delivery/story.cordis.yml', import.meta.url)), join(root, 'host/runtime.patch.yml')],
      env: { MUSE_TEST_PRIMARY_RUNTIME: process.env.MUSE_TEST_PRIMARY_RUNTIME } })
    const rows = z.array(z.object({ name: z.literal('run_code'), isError: z.boolean(), content: z.unknown() }))
      .parse(JSON.parse(await readFile(join(root, 'story-host-results.json'), 'utf8')))
    expect(rows.map(row => row.isError)).toEqual([false, true, false, false, false, false, true])
    expect(JSON.stringify(rows[1]!.content)).toContain('refinement_delivery_pair')
    expect(JSON.stringify(rows[6]!.content)).toContain('video_delivery_unaccepted')
    const exported = await readFile(join(root, 'managed/final/episode.md'), 'utf8')
    expect(exported).not.toContain('修改说明')
  } finally { await rm(root, { recursive: true, force: true }) }
}, LOADER_SMOKE_TEST_TIMEOUT_MS * 3)
