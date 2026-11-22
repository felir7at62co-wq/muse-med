/**
 * REAL composition: episode_subtitles and the batch jianying_draft through the Loader, with real FFmpeg, the managed
 * subprocess provider, the bundled-rules Python with pyJianYingDraft, and the Muse account client behind a scripted
 * gateway. It replays the reported failure: a trim of shot 2 plus a regenerated shot 4.
 */
import { execFileSync, spawnSync } from 'node:child_process'
import { mkdir, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
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
import * as EpisodeSubtitles from '@deepseek-ai/dsh-tool-episode-subtitles'
import { expect, it } from 'vitest'
import { hasMedia, realProject, rulesPython, scriptedAccount } from '../../../packages/drama/tool-episode-subtitles/tests/real-project.ts'
import * as JianyingDraft from '../src/jianying-draft.ts'

const draftPython = rulesPython !== undefined
  && spawnSync(rulesPython, ['-c', 'import pyJianYingDraft, pymediainfo'], { stdio: 'ignore' }).status === 0 ? rulesPython : undefined
const which = (command: string) => { try { return execFileSync('which', [command], { encoding: 'utf8' }).trim() } catch { return command } }

it.runIf(hasMedia && draftPython !== undefined)('refuses a stale episode by changed shots and redoes only the regenerated shot', async () => {
  const lines = ['林晨回来了', '妈在等你', '你先坐下', '我去倒茶']
  const project = await realProject(lines, { separateAudio: true })
  const heard = (text: string) => Array.from(text, (char, index) => ({ start: 0.2 + index * 0.15, end: 0.32 + index * 0.15, text: char }))
  const words = new Map<string, ReturnType<typeof heard>>()
  for (const [index, line] of lines.entries()) words.set(await project.audioSha(index), heard(line))
  const gateway = await scriptedAccount(project.root, words)
  const drafts = join(project.root, 'jianying-drafts')
  await mkdir(drafts)
  const ffmpeg = which('ffmpeg'), ffprobe = which('ffprobe')
  const ctx = new Context()
  try {
    const config = join(project.root, 'cordis.yml')
    await writeFile(config, ["- name: '@deepseek-ai/dsh-system-prompt'", "- name: '@deepseek-ai/dsh-tools'", "- name: '@deepseek-ai/dsh-subprocess-local'",
      '- name: fixture-account', "- name: '@deepseek-ai/dsh-tool-episode-subtitles'", '  config:', `    pythonPath: ${JSON.stringify(draftPython)}`,
      `    ffmpegPath: ${JSON.stringify(ffmpeg)}`, `    ffprobePath: ${JSON.stringify(ffprobe)}`, '    pollIntervalMs: 1000',
      '- name: jianying-draft', '  config:', `    source: ${JSON.stringify(project.root)}`, `    pythonPath: ${JSON.stringify(draftPython)}`,
      `    ffmpegPath: ${JSON.stringify(ffmpeg)}`, `    ffprobePath: ${JSON.stringify(ffprobe)}`, '    timeoutMs: 240000', '    graceMs: 1000',
      '    maxInputBytes: 1048576', '    maxOutputBytes: 1048576', ''].join('\n'))
    ctx.baseUrl = pathToFileURL(project.root).href + '/'
    await ctx.plugin(Loader)
    ctx.loader.builtins.include = Include
    const modules = new Map<string, unknown>([['@deepseek-ai/dsh-system-prompt', SystemPrompt], ['@deepseek-ai/dsh-tools', Tools],
      ['@deepseek-ai/dsh-subprocess-local', LocalSubprocess], ['fixture-account', gateway.plugin],
      ['@deepseek-ai/dsh-tool-episode-subtitles', EpisodeSubtitles], ['jianying-draft', JianyingDraft]])
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
    let calls = 0
    const run = async (name: string, args: Record<string, unknown>) => {
      const result = await executeModelToolFixture(ctx, { name, callId: ToolCallId(`call-${String(++calls)}`), signal: new AbortController().signal,
        arguments: args })
      return JSON.parse((result.content[0] as { text: string }).text) as Record<string, unknown>
    }
    const subtitles = () => run('episode_subtitles', { source: 'local', project: project.root, episodes: [1] })
    const draft = () => run('jianying_draft', { source: 'local', project: project.root, episodes: [1], drafts_dir: drafts })

    expect(await subtitles()).toMatchObject({ status: 'waiting' })
    gateway.complete()
    expect(await subtitles()).toMatchObject({ status: 'ready', next: { tool: 'jianying_draft' } })
    const first = await draft()
    expect(first).toMatchObject({ created: [{ episode: 1 }], refused: [], music_missing: [1] })
    const path = (first.created as { path: string }[])[0]!.path
    expect((await stat(join(path, 'draft_content.json'))).isFile()).toBe(true)
    expect(await draft()).toMatchObject({ created: [], existing: [{ episode: 1, path }] })

    await project.trim(1, 1.5)
    await project.regenerate(3, 950)
    words.set(await project.audioSha(3), heard('我去倒茶吧'))
    expect(await draft()).toMatchObject({ created: [], refused: [{ episode: 1, reason: 'subtitles_stale', changed_shots: [2, 4] }],
      next: { tool: 'episode_subtitles', args: { episodes: [1] } } })

    expect(await subtitles()).toMatchObject({ status: 'waiting', changed: { 1: [4] } })
    expect(gateway.submits.slice(1)).toEqual([[await project.audioSha(3)]])
    gateway.complete()
    expect(await subtitles()).toMatchObject({ status: 'ready' })
    const second = await draft()
    expect(second).toMatchObject({ created: [{ episode: 1 }], refused: [] })
    expect((second.created as { path: string }[])[0]!.path).not.toBe(path)

    const switched = await run('jianying_draft', { source: 'local', project: project.root, episodes: [1, 2], drafts_dir: drafts,
      switches: { music: false, ending: false, watermark: false, watermark_text: '自定义' } })
    expect(switched).toMatchObject({ created: [{ episode: 1 }], music_missing: [], unsupported: ['watermark_text'],
      refused: [{ episode: 2, reason: 'not_selected', detail: 'package_missing' }] })
    const requests = join(project.root, 'drafts', 'requests')
    const latest = (await readdir(requests)).filter(name => name.endsWith('.json') && !name.endsWith('.clock.json')).sort().at(-1)!
    const request = JSON.parse(await readFile(join(requests, latest), 'utf8')) as Record<string, unknown>
    expect(request).toMatchObject({ music_decision: 'none', ending: false, watermark: false })
    expect(request).not.toHaveProperty('ending_audio')
    expect(request).not.toHaveProperty('bgm')
  } finally {
    await ctx.fiber.dispose()
    await rm(project.root, { recursive: true, force: true })
  }
}, 600_000)
