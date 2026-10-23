/** Offline matching through a Loader-owned composition and the real tool registry. */
import { createHash } from 'node:crypto'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import Tools from '@deepseek-ai/dsh-tools'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import * as Bgm from '../src/index.ts'
import { EmotionWorker } from '../src/worker.ts'

interface MatchOutput { candidates: { path?: string }[]; recommendation?: string }

it.each([[false, false], [true, false], [false, true], [true, true]])('matches without Python or weights and unloads (remote=%s, feedback=%s)', async (remote, useFeedback) => {
  const root = await mkdtemp(join(import.meta.dirname, 'match-'))
  const ctx = new Context()
  const licenseInfo = { status: 'declared', license: 'Fixture commercial licence', commercial_use: true,
    source: 'https://rights.example/licence', attribution: 'Fixture composer', scope: 'Commercial short-drama release' }
  const start = vi.spyOn(EmotionWorker.prototype, 'start')
    .mockRejectedValue(new Error('match must never start Python'))
  try {
    const indexPath = join(root, 'index.json')
    const audio = Buffer.from('loader fixture')
    const hash = createHash('sha256').update(audio).digest('hex')
    await writeFile(indexPath, JSON.stringify([
      { path: 'calm.mp3', valence: 3, arousal: 2, moods: ['calm'], license_info: licenseInfo,
        ...(useFeedback ? { sha256: `sha256:${hash}` } : {}) },
      { path: 'bright.mp3', valence: 8, arousal: 7, moods: ['happy'] },
    ]))
    const feedback = { feedback_id: 'user-hall-rejection', source_sha256: hash, decision: 'reject',
      context_tags: ['hall', 'family conflict'], reason: 'The user found this cue too playful.',
      recorded_at: '2026-10-21T10:00:00+08:00', episode: 23 }
    if (useFeedback) await writeFile(join(root, 'project_config.json'), JSON.stringify({ project_bible: { bgm_feedback: [feedback] } }))
    const catalogUrl = 'https://example.com/bgm/index.json'
    const url = `https://example.com/bgm/tracks/${hash}.mp3`
    if (remote) vi.stubGlobal('fetch', vi.fn(async (input: string) => input === catalogUrl
      ? new Response(JSON.stringify({ version: 1, tracks: [
        { id: `sha256:${hash}`, name: 'calm.mp3', sha256: `sha256:${hash}`, bytes: audio.length,
          url, valence: 3, arousal: 2, moods: ['calm'], license_info: licenseInfo },
      ] })) : new Response(audio)))
    const config = join(root, 'cordis.yml')
    await writeFile(config, [
      "- name: '@deepseek-ai/dsh-system-prompt'",
      "- name: '@deepseek-ai/dsh-tools'",
      "- name: '@deepseek-ai/dsh-perception-bgm'",
      `  config: ${JSON.stringify({ indexPath, pythonExecutable: join(root, 'missing-python'),
        weightsPath: join(root, 'missing.ckpt'),
        ...(remote ? { catalogUrl, cacheDir: join(root, 'cache') } : {}) })}`,
      '',
    ].join('\n'))
    ctx.baseUrl = pathToFileURL(root).href + '/'
    await ctx.plugin(Loader)
    ctx.loader.builtins.include = Include
    const modules = new Map<string, unknown>([
      ['@deepseek-ai/dsh-system-prompt', SystemPrompt], ['@deepseek-ai/dsh-tools', Tools],
      ['@deepseek-ai/dsh-perception-bgm', Bgm],
    ])
    ctx.loader.internal = { version: 'v2', loadCache: new Map(),
      register() { throw new Error('Unexpected loader hooks') },
      getOrCreateModuleJob() { throw new Error('Unexpected loader job') },
      resolveSync() { throw new Error('Unexpected loader resolution') },
      load() { throw new Error('Unexpected loader load') }, async import(specifier: string) {
        if (!modules.has(specifier)) throw new Error(`Unexpected module ${specifier}`)
        return modules.get(specifier)
      } }
    await ctx.loader.create({ name: 'cordis:include', config: { path: pathToFileURL(config).href } })
    await ctx.loader.await()
    for (const entry of ctx.loader.entries()) await entry.fiber?.await()
    const result = await ctx.tools.execute({ signal: new AbortController().signal,
      callId: ToolCallId('bgm-offline'), name: 'bgm_match',
      arguments: { method: 'match', valence: 3, arousal: 2, limit: 1, intended_use: 'commercial',
        ...(useFeedback ? { project: root, context_tags: ['hall', 'family conflict'] } : {}) } })
    expect(result.isError).toBe(false)
    const content = result.content[0]
    if (content?.type !== 'text') throw new Error('Expected match result')
    if (!useFeedback) expect(JSON.parse(content.text)).toEqual({
      target: { valence: 3, arousal: 2 }, evaluated_tracks: remote ? 1 : 2,
      candidates: [{ ...(remote ? { track_id: `sha256:${hash}`, name: 'calm.mp3', url } : { path: 'calm.mp3' }),
        valence: 3, arousal: 2, moods: ['calm'], distance: 0,
        license_info: licenseInfo, license_warnings: [] }],
      note: 'candidates are ranked by measured distance; choose one yourself.',
    })
    else {
      const output = JSON.parse(content.text) as MatchOutput
      expect(output).toMatchObject({ music_optional: true, withheld_count: 1,
        withheld_candidates: [{ distance: 0, license_info: licenseInfo,
          project_preference: { decision: 'reject', feedback_id: feedback.feedback_id, reason: feedback.reason } }],
        project_preferences: { status: 'ready', feedback_count: 1 } })
      expect(output.candidates).toHaveLength(remote ? 0 : 1)
      if (remote) expect(output.recommendation).toContain('without added BGM')
      else expect(output.candidates[0]?.path).toBe('bright.mp3')

      const match = async (tags: string[]) => {
        const result = await ctx.tools.execute({ signal: new AbortController().signal,
          callId: ToolCallId('bgm-fresh-feedback'), name: 'bgm_match',
          arguments: { method: 'match', valence: 3, arousal: 2, limit: 1, project: root, context_tags: tags } })
        expect(result.isError).toBe(false)
        const content = result.content[0]
        if (content?.type !== 'text') throw new Error('Expected fresh preference match result')
        return JSON.parse(content.text) as MatchOutput
      }
      expect(await match(['kitchen'])).toMatchObject({ withheld_count: 0,
        candidates: [{ distance: 0, project_preference: { decision: 'unreviewed', history: [{ applicable: false }] } }] })
      const acceptance = { ...feedback, feedback_id: 'user-explicitly-reversed', decision: 'accept',
        reason: 'The user explicitly changed their mind.', recorded_at: '2026-10-22T10:00:00+08:00' }
      await writeFile(join(root, 'project_config.json'), JSON.stringify({ project_bible: { bgm_feedback: [feedback, acceptance] } }))
      expect(await match(['hall', 'family conflict'])).toMatchObject({ withheld_count: 0,
        candidates: [{ distance: 0, project_preference: { decision: 'accept', feedback_id: acceptance.feedback_id } }] })
      if (!remote) {
        await writeFile(indexPath, '[]')
        const empty = await match(['hall', 'family conflict'])
        expect(empty).toMatchObject({ evaluated_tracks: 0, candidates: [], music_optional: true })
        expect(empty.recommendation).toContain('without added BGM')
      }
      const unscoped = await ctx.tools.execute({ signal: new AbortController().signal,
        callId: ToolCallId('bgm-no-project'), name: 'bgm_match',
        arguments: { method: 'match', valence: 3, arousal: 2, context_tags: ['hall'] } })
      expect(unscoped.isError).toBe(true)
      const errorContent = unscoped.content[0]
      if (errorContent?.type !== 'text') throw new Error('Expected missing project error text')
      expect(errorContent.text).toContain('context_tags requires project')
    }
    if (remote) {
      const download = await ctx.tools.execute({ signal: new AbortController().signal,
        callId: ToolCallId('bgm-download'), name: 'bgm_match',
        arguments: { method: 'download', track_id: `sha256:${hash}`, intended_use: 'commercial' } })
      expect(download.isError).toBe(false)
      const text = download.content[0]
      if (text?.type !== 'text') throw new Error('Expected download result')
      const output = JSON.parse(text.text) as { path: string; sha256: string }
      expect(await readFile(output.path)).toEqual(audio)
      expect(output.sha256).toBe(`sha256:${hash}`)
      expect(output).toMatchObject({ license_info: licenseInfo, license_warnings: [] })
    }
    expect(start).not.toHaveBeenCalled()
    const entry = [...ctx.loader.entries()].find(row => row.options.name === '@deepseek-ai/dsh-perception-bgm')
    await entry?.fiber?.dispose()
    expect(ctx.tools.get('bgm_match')).toBeUndefined()
  } finally {
    start.mockRestore()
    vi.unstubAllGlobals()
    await ctx.fiber.dispose()
    await rm(root, { recursive: true, force: true })
  }
})
