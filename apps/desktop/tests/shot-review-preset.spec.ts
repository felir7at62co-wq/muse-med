/** The shipped short-drama compiler row supplies advisory behavior to the real Loader. */
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { loadOverlayPatches } from '@deepseek-ai/dsh-app-boot'
import { expect, it } from 'vitest'
import { assetRow, manifestDocument, speakingShot } from '../../../packages/drama/tool-shot-script/tests/harness.ts'
import { sessionVideoShot } from '../../../packages/drama/tool-shot-script/tests/fixtures/session-video.ts'

it('runs the shipped short-drama row as a non-blocking review and writes only its separate draft', async () => {
  const path = fileURLToPath(new URL('../../desktop-host/presets/short-drama/agent.cordis.yml', import.meta.url))
  const row = loadOverlayPatches('muse-shot-review-test', path).find(row => row.id === 'tool-shot-script')
  expect(row).toMatchObject({ name: '@deepseek-ai/dsh-tool-shot-script', config: { reviewMode: 'advisory', sessionVideoSelection: true } })
  expect(row?.disabled).not.toBe(true)
  const config: unknown = row?.config
  if (typeof config !== 'object' || config === null || !('reviewMode' in config) || config.reviewMode !== 'advisory'
    || !('sessionVideoSelection' in config) || config.sessionVideoSelection !== true
    || !('speechCharsPerSecond' in config) || config.speechCharsPerSecond !== 5) {
    throw new Error('The shipped shot reviewer must explicitly select advisory mode and conversation video settings')
  }
  const root = await mkdtemp(join(tmpdir(), 'muse-shot-review-preset-'))
  let tool: Awaited<ReturnType<typeof sessionVideoShot>> | undefined
  try {
    const script = join(root, 'script.txt')
    const assets = join(root, 'assets.json')
    const original = speakingShot(1, '苏晚：等一下，我还没有说完。', ['出镜人物：苏晚', '核心场景：后厨', '时长：20秒'])
    await writeFile(script, original)
    await writeFile(assets, JSON.stringify(manifestDocument(assetRow('苏晚', '角色'), assetRow('后厨', '场景'))))
    await writeFile(join(root, 'project_config.json'), JSON.stringify({ delivery: { max_effective_chars_per_shot: 3 } }))
    tool = await sessionVideoShot(root, { reviewMode: config.reviewMode, sessionVideoSelection: config.sessionVideoSelection,
      speechCharsPerSecond: config.speechCharsPerSecond })
    const agent = await tool.create('shipped-shot-review')
    const report = await tool.run(agent, { method: 'compile', script, assets, project: root, episode: 1, max_submit_seconds: 15 })
    expect(report).toMatchObject({ ok: true, review_mode: 'advisory', failures: [] })
    expect(report.warnings.map(issue => issue.code)).toContain('session_video_budget_ignored')
    expect(report.duration_budget).toMatchObject({ source: 'session', max_submit_seconds: 30 })
    expect(report.shots[0]?.duration_seconds).toBe(20)
    expect(report.packages[0]?.submit_seconds).toBe(21)
    expect(report.written.every(path => path.startsWith(join(root, 'shot_reviews/01/')))).toBe(true)
    expect(await readFile(join(root, 'shot_reviews/01/shot_script.txt'), 'utf8')).toBe(original)
    await writeFile(script, original.replace('时长：20秒', ''))
    const estimated = await tool.run(agent, { method: 'validate', script })
    expect(estimated.shots[0]?.duration_seconds).toBe(Math.ceil(estimated.shots[0]!.effective_chars / 5))
  } finally {
    await tool?.dispose()
    await rm(root, { recursive: true, force: true })
  }
})
