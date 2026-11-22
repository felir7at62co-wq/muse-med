/** Loader-booted tool with real FFmpeg, the real subprocess provider, the bundled-rules Python and the account client. */
import { readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import LocalSubprocess from '@deepseek-ai/dsh-subprocess-local'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import Tools from '@deepseek-ai/dsh-tools'
import * as NativeToolExecutor from '@deepseek-ai/dsh-tool-executor-native'
import { executeModelToolFixture } from '@deepseek-ai/dsh-tool-testkit'
import { readSubtitleClockReceipt } from '@deepseek-ai/dsh-tool-episode-render/subtitles'
import { expect, it } from 'vitest'
import * as EpisodeSubtitles from '../src/index.ts'
import { hasMedia, realProject, rulesPython, scriptedAccount } from './real-project.ts'

it.runIf(hasMedia && rulesPython !== undefined)('builds corrected subtitles end to end and removes its tool and prompt section on disposal', async () => {
  const lines = ['林晨，你终于回来了', '妈说林晨在等你，你买不买']
  const project = await realProject(lines)
  const heard = (text: string) => Array.from(text, (char, index) => ({ start: 0.2 + index * 0.15, end: 0.32 + index * 0.15, text: char }))
  const gateway = await scriptedAccount(project.root, new Map([[await project.audioSha(0), heard('林辰你终于回来了')],
    [await project.audioSha(1), heard('妈说林辰在等你你卖不卖')]]))
  const ctx = new Context()
  try {
    const config = join(project.root, 'cordis.yml')
    await writeFile(config, ["- name: '@deepseek-ai/dsh-system-prompt'", "- name: '@deepseek-ai/dsh-tools'", "- name: '@deepseek-ai/dsh-subprocess-local'", '- name: fixture-account',
      "- name: '@deepseek-ai/dsh-tool-episode-subtitles'", '  config:', `    pythonPath: ${JSON.stringify(rulesPython)}`,
      `    ffmpegPath: ${JSON.stringify(process.env.DSH_FFMPEG_PATH ?? 'ffmpeg')}`, `    ffprobePath: ${JSON.stringify(process.env.DSH_FFPROBE_PATH ?? 'ffprobe')}`,
      '    pollIntervalMs: 1000', ''].join('\n'))
    ctx.baseUrl = pathToFileURL(project.root).href + '/'
    await ctx.plugin(Loader)
    ctx.loader.builtins.include = Include
    const modules = new Map<string, unknown>([['@deepseek-ai/dsh-system-prompt', SystemPrompt], ['@deepseek-ai/dsh-tools', Tools], ['@deepseek-ai/dsh-subprocess-local', LocalSubprocess],
      ['fixture-account', gateway.plugin], ['@deepseek-ai/dsh-tool-episode-subtitles', EpisodeSubtitles]])
    ctx.loader.internal = { version: 'v2', loadCache: new Map(),
      register() { throw new Error('Unexpected loader hooks') }, getOrCreateModuleJob() { throw new Error('Unexpected loader job') },
      resolveSync() { throw new Error('Unexpected loader resolution') }, load() { throw new Error('Unexpected loader load') },
      async import(specifier: string) {
        if (!modules.has(specifier)) throw new Error(`Unexpected module ${specifier}`)
        return modules.get(specifier)
      } }
    await ctx.loader.create({ name: 'cordis:include', config: { path: pathToFileURL(config).href } })
    await ctx.loader.await()
    for (const entry of ctx.loader.entries()) await entry.fiber?.await()
    await ctx.plugin(NativeToolExecutor)
    const tools = ctx.tools
    const sections = async () => (await ctx.systemPrompt.assemble()).sections.map(section => section.name)
    expect(await sections()).toContain('tool:episode_subtitles')
    const call = async (id: string) => await executeModelToolFixture(ctx, { name: 'episode_subtitles', callId: ToolCallId(id),
      signal: new AbortController().signal, arguments: { source: 'local', project: project.root, episodes: [1] } })
    const text = (result: Awaited<ReturnType<typeof call>>) =>
      JSON.parse((result.content[0] as { text: string }).text) as Record<string, unknown>
    expect(text(await call('first'))).toMatchObject({ status: 'waiting', asr: { pending_packs: 1 } })
    expect(gateway.submits).toEqual([[await project.audioSha(0), await project.audioSha(1)]])
    gateway.complete()
    const built = text(await call('second'))
    expect(built).toMatchObject({ status: 'needs_review', needs_review: { 1: 2 }, next: { tool: 'episode_subtitles', args: { method: 'review' } } })
    const srt = join(project.root, 'editing', '01.srt')
    const body = await readFile(srt, 'utf8')
    expect(body).toContain('林晨你终于回来了')
    expect(body).toContain('妈说林晨在等你')
    expect(body).not.toContain('林辰')
    expect((await readSubtitleClockReceipt(srt))?.receipt).toMatchObject({ version: 2, producer: 'episode_subtitles', review_pending: 2 })
    const review = async (id: string, extra: Record<string, unknown> = {}) => text(await executeModelToolFixture(ctx, { name: 'episode_subtitles',
      callId: ToolCallId(id), signal: new AbortController().signal, arguments: { method: 'review', source: 'local', project: project.root, episodes: [1], ...extra } }))
    const page = await review('review')
    expect(page).toMatchObject({ pending: 2, items: [{ shot: 2, kind: 'differ', heard: '卖', script: '买' }, { shot: 2, kind: 'differ', heard: '卖', script: '买' }] })
    const [first, second] = page.items as { id: string }[]
    expect(await review('decide', { decisions: [{ id: first!.id, action: 'script' }, { id: second!.id, action: 'script' }] }))
      .toMatchObject({ pending: 0, applied: 2, status: 'ready', next: { tool: 'jianying_draft' } })
    expect(await readFile(srt, 'utf8')).toContain('你买不买')
    await project.editLine(0, '林晨，你可算回来了')
    expect(text(await call('third'))).toMatchObject({ status: 'needs_review', changed: { 1: [1] } })
    expect(await readFile(srt, 'utf8')).toContain('你买不买')
    expect(gateway.submits).toHaveLength(1)
    const entry = [...ctx.loader.entries()].find(row => row.options.name === '@deepseek-ai/dsh-tool-episode-subtitles')
    await entry?.fiber?.dispose()
    expect(tools.get('episode_subtitles')).toBeUndefined()
    expect(await sections()).not.toContain('tool:episode_subtitles')
  } finally {
    await ctx.fiber.dispose()
    await rm(project.root, { recursive: true, force: true })
  }
}, 120_000)
