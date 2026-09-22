/** Compiler output and lifecycle through a Loader-owned test composition. */
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import Tools from '@deepseek-ai/dsh-tools'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import * as ShotCompiler from '../src/index.ts'
import type { DramaShotReport } from '../src/types.ts'
import { assetRow, manifestDocument, speakingShot } from './harness.ts'

it('loads a warning-producing compiler with explicit board budgets and disposes it', async () => {
  const root = await mkdtemp(join(tmpdir(), 'shot-loader-'))
  const ctx = new Context()
  try {
    const script = join(root, 'script.txt')
    const assets = join(root, 'assets.json')
    await writeFile(script, speakingShot(1, '苏晚：等我3秒', ['发声类型：心声', '时长：20秒', '核心场景：后厨']))
    await writeFile(assets, JSON.stringify(manifestDocument(assetRow('苏晚', '角色'), assetRow('后厨', '场景'))))
    const config = join(root, 'cordis.yml')
    await writeFile(config, [
      "- name: '@deepseek-ai/dsh-system-prompt'",
      "- name: '@deepseek-ai/dsh-tools'",
      "- name: '@deepseek-ai/dsh-tool-shot-script'",
      '',
    ].join('\n'))
    ctx.baseUrl = pathToFileURL(root).href + '/'
    await ctx.plugin(Loader)
    ctx.loader.builtins.include = Include
    const modules = new Map<string, unknown>([
      ['@deepseek-ai/dsh-system-prompt', SystemPrompt], ['@deepseek-ai/dsh-tools', Tools],
      ['@deepseek-ai/dsh-tool-shot-script', ShotCompiler],
    ])
    ctx.loader.internal = { version: 'v2', async import(specifier: string) {
      if (!modules.has(specifier)) throw new Error(`Unexpected module ${specifier}`)
      return modules.get(specifier)
    } } as unknown as NonNullable<typeof ctx.loader.internal>
    await ctx.loader.create({ name: 'cordis:include', config: { path: pathToFileURL(config).href } })
    await ctx.loader.await()
    for (const entry of ctx.loader.entries()) await entry.fiber?.await()
    const tools = ctx.tools
    const outcomes = []
    for (const budget of [30, 15]) {
      const result = await tools.execute({ signal: new AbortController().signal,
        callId: ToolCallId(`budget-${budget}`), name: 'drama_shot',
        arguments: { method: 'preview', script, assets, max_submit_seconds: budget } })
      expect(result.isError).toBe(false)
      const content = result.content[0]
      if (content?.type !== 'text') throw new Error('Expected rendered compiler report')
      const report = JSON.parse(content.text) as DramaShotReport
      outcomes.push({ budget, ok: report.ok, speech: report.shots.map(shot => ({
        text: shot.text, speaker: shot.speaker, voice: shot.voice_type, seconds: shot.duration_seconds,
      })), warnings: report.warnings.map(issue => issue.code), failures: report.failures.map(issue => issue.code),
      submit: report.packages.map(item => item.submit_seconds) })
    }
    expect(outcomes).toMatchInlineSnapshot(`
      [
        {
          "budget": 30,
          "failures": [],
          "ok": true,
          "speech": [
            {
              "seconds": 20,
              "speaker": "苏晚",
              "text": "等我3秒",
              "voice": "vo",
            },
          ],
          "submit": [
            21,
          ],
          "warnings": [
            "seconds_in_shot_body",
            "narration_marker",
            "legacy_duration_mismatch",
          ],
        },
        {
          "budget": 15,
          "failures": [
            "shot_exceeds_package_budget",
          ],
          "ok": false,
          "speech": [
            {
              "seconds": 20,
              "speaker": "苏晚",
              "text": "等我3秒",
              "voice": "vo",
            },
          ],
          "submit": [],
          "warnings": [
            "seconds_in_shot_body",
            "narration_marker",
            "legacy_duration_mismatch",
          ],
        },
      ]
    `)
    const entry = [...ctx.loader.entries()].find(row => row.options.name === '@deepseek-ai/dsh-tool-shot-script')
    await entry?.fiber?.dispose()
    expect(tools.get('drama_shot')).toBeUndefined()
  } finally {
    await ctx.fiber.dispose()
    await rm(root, { recursive: true, force: true })
  }
})
