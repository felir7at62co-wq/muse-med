/** Public render arguments through a Loader-owned tool registration. */
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import Tools, { validateJsonSchemaValue } from '@deepseek-ai/dsh-tools'
import * as Render from '../src/index.ts'
import { cleanup, runContext, tempProject } from './harness.ts'

it('loads the renderer, accepts public arguments, and removes its tool on disposal', async () => {
  const root = await tempProject()
  const ctx = new Context()
  try {
    const config = join(root, 'cordis.yml')
    await writeFile(config, [
      "- name: '@deepseek-ai/dsh-system-prompt'",
      "- name: '@deepseek-ai/dsh-tools'",
      "- name: '@deepseek-ai/dsh-tool-episode-render'",
      '',
    ].join('\n'))
    ctx.baseUrl = pathToFileURL(root).href + '/'
    await ctx.plugin(Loader)
    ctx.loader.builtins.include = Include
    const modules = new Map<string, unknown>([
      ['@deepseek-ai/dsh-system-prompt', SystemPrompt],
      ['@deepseek-ai/dsh-tools', Tools],
      ['@deepseek-ai/dsh-tool-episode-render', Render],
    ])
    ctx.loader.internal = {
      version: 'v2',
      async import(specifier: string) {
        if (!modules.has(specifier)) throw new Error(`unexpected module: ${specifier}`)
        return modules.get(specifier)
      },
    } as unknown as NonNullable<typeof ctx.loader.internal>
    await ctx.loader.create({ name: 'cordis:include', config: { path: pathToFileURL(config).href } })
    await ctx.loader.await()
    for (const entry of ctx.loader.entries()) await entry.fiber?.await()
    const tool = ctx.tools.get('drama_render')
    expect(tool).toBeDefined()
    if (tool === undefined) throw new Error('missing drama_render')
    const videoTool = ctx.tools.get('drama_video')
    expect(videoTool).toBeDefined()
    if (videoTool === undefined) throw new Error('missing drama_video')
    const video = join(root, 'source.mp4')
    await writeFile(video, 'exact video version')
    const banArgs = { method: 'ban', project: root, video, labels: ['人物对调'], reason: '用户指定' }
    expect(validateJsonSchemaValue(videoTool.parameters, banArgs, '')).toEqual([])
    const ban = await videoTool.execute(banArgs, runContext())
    expect(validateJsonSchemaValue(videoTool.output.schema, ban, '')).toEqual([])
    // The schema check above already validated this value; narrow it for `render`
    // without adding a type-only workspace dependency to this package.
    const rendered = videoTool.output.render(
      banArgs,
      ban as Parameters<typeof videoTool.output.render>[1],
    ) as { type: string; text: string }[]
    const text = rendered[0]?.text ?? ''
    const owned = JSON.parse(text) as Record<string, unknown>
    expect({ ...owned, project: '<project>', manifest_path: '<project>/video-bans.json' }).toMatchInlineSnapshot(`
      {
        "banned": true,
        "labels": [
          "人物对调",
        ],
        "manifest_path": "<project>/video-bans.json",
        "method": "ban",
        "project": "<project>",
        "reason": "用户指定",
        "review_status": "not_assessed",
        "sha256": "cca729571d4b27fc3a64090bf227a3bcbb24b117be88e7ca7e8efaefc2d2a719",
        "videos": [],
      }
    `)
    const listArgs = { method: 'list', project: root }
    expect(validateJsonSchemaValue(videoTool.parameters, listArgs, '')).toEqual([])
    const list = await videoTool.execute(listArgs, runContext())
    expect(validateJsonSchemaValue(videoTool.output.schema, list, '')).toEqual([])
    expect(list).toMatchObject({ banned: true, videos: [{ labels: ['人物对调'], reason: '用户指定', banned: true }] })
    const unban = await videoTool.execute({ method: 'unban', project: root, video }, runContext())
    expect(validateJsonSchemaValue(videoTool.output.schema, unban, '')).toEqual([])
    expect(unban).toMatchObject({ banned: false, review_status: 'not_assessed', labels: ['人物对调'] })
    const missing = join(root, 'missing.json')
    for (const method of ['prepare', 'render', 'verify']) {
      const args = {
        method, project: root, episode: 1, shots: missing, timeline: missing,
        subtitle_srt: join(root, 'subtitles.srt'), last_shot: 1,
        bgm: join(root, 'bgm.wav'), ending_audio: join(root, 'ending.wav'),
        ending_effect: join(root, 'effect.mp4'), output: join(root, 'output.mp4'),
      }
      expect(validateJsonSchemaValue(tool.parameters, args, '')).toEqual([])
      await expect(tool.execute(args, runContext())).rejects.toMatchObject({ code: 'ENOENT', path: missing })
    }
    const entry = [...ctx.loader.entries()].find(row => row.options.name === '@deepseek-ai/dsh-tool-episode-render')
    expect(entry?.fiber).toBeDefined()
    await entry?.fiber?.dispose()
    expect(ctx.tools.get('drama_render')).toBeUndefined()
    expect(ctx.tools.get('drama_video')).toBeUndefined()
  } finally {
    await ctx.fiber.dispose()
    await cleanup(root)
  }
})
