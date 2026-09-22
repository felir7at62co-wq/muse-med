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

it.each([false, true])('matches without Python or weights and unloads (remote=%s)', async (remote) => {
  const root = await mkdtemp(join(import.meta.dirname, 'match-'))
  const ctx = new Context()
  const start = vi.spyOn(EmotionWorker.prototype, 'start')
    .mockRejectedValue(new Error('match must never start Python'))
  try {
    const indexPath = join(root, 'index.json')
    await writeFile(indexPath, JSON.stringify([
      { path: 'calm.mp3', valence: 3, arousal: 2, moods: ['calm'] },
      { path: 'bright.mp3', valence: 8, arousal: 7, moods: ['happy'] },
    ]))
    const audio = Buffer.from('loader fixture')
    const hash = createHash('sha256').update(audio).digest('hex')
    const catalogUrl = 'https://example.com/bgm/index.json'
    const url = `https://example.com/bgm/tracks/${hash}.mp3`
    if (remote) vi.stubGlobal('fetch', vi.fn(async (input: string) => input === catalogUrl
      ? new Response(JSON.stringify({ version: 1, tracks: [
        { id: `sha256:${hash}`, name: 'calm.mp3', sha256: `sha256:${hash}`, bytes: audio.length,
          url, valence: 3, arousal: 2, moods: ['calm'] },
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
    ctx.loader.internal = { version: 'v2', async import(specifier: string) {
      if (!modules.has(specifier)) throw new Error(`Unexpected module ${specifier}`)
      return modules.get(specifier)
    } } as unknown as NonNullable<typeof ctx.loader.internal>
    await ctx.loader.create({ name: 'cordis:include', config: { path: pathToFileURL(config).href } })
    await ctx.loader.await()
    for (const entry of ctx.loader.entries()) await entry.fiber?.await()
    const result = await ctx.tools.execute({ signal: new AbortController().signal,
      callId: ToolCallId('bgm-offline'), name: 'bgm_match',
      arguments: { method: 'match', valence: 3, arousal: 2, limit: 1 } })
    expect(result.isError).toBe(false)
    const content = result.content[0]
    if (content?.type !== 'text') throw new Error('Expected match result')
    expect(JSON.parse(content.text)).toEqual({
      target: { valence: 3, arousal: 2 }, evaluated_tracks: remote ? 1 : 2,
      candidates: [{ ...(remote ? { track_id: `sha256:${hash}`, name: 'calm.mp3', url } : { path: 'calm.mp3' }),
        valence: 3, arousal: 2, moods: ['calm'], distance: 0 }],
      note: 'candidates are ranked by measured distance; choose one yourself.',
    })
    if (remote) {
      const download = await ctx.tools.execute({ signal: new AbortController().signal,
        callId: ToolCallId('bgm-download'), name: 'bgm_match',
        arguments: { method: 'download', track_id: `sha256:${hash}` } })
      expect(download.isError).toBe(false)
      const text = download.content[0]
      if (text?.type !== 'text') throw new Error('Expected download result')
      const output = JSON.parse(text.text) as { path: string; sha256: string }
      expect(await readFile(output.path)).toEqual(audio)
      expect(output.sha256).toBe(`sha256:${hash}`)
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
