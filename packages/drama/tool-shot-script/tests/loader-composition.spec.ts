/** Compiler output and lifecycle through a Loader-owned test composition. */
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
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
import type { DramaShotReport, MatchedPayload } from '../src/types.ts'
import { actionShot, assetRow, manifestDocument, speakingShot } from './harness.ts'

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
    const assetOutcomes = []
    await writeFile(script, speakingShot(1, '阿舟：苏晚怎么还不来？', ['出镜人物：阿舟', '核心场景：后厨'])
      .replaceAll('苏晚站在', '阿舟站在').replaceAll('【苏晚】', '【阿舟】'))
    for (const ambiguous of [false, true]) {
      await writeFile(assets, JSON.stringify(manifestDocument(
        assetRow('陆沉舟（家常装）', '角色', { aliases: ['阿舟'] }),
        assetRow('陆沉舟（职场装）', '角色', { aliases: ['阿舟'], state_or_costume: '非孕期；青年；职场装' }),
        ...(ambiguous ? [assetRow('陆沉舟（家常装B）', '角色', { aliases: ['阿舟'] })] : []),
        assetRow('苏晚', '角色'), assetRow('后厨', '场景'),
      )))
      const result = await tools.execute({ signal: new AbortController().signal,
        callId: ToolCallId(`assets-${String(ambiguous)}`), name: 'drama_shot',
        arguments: { method: 'validate', script, assets, episode: 1 } })
      expect(result.isError).toBe(false)
      const content = result.content[0]
      if (content?.type !== 'text') throw new Error('Expected rendered asset report')
      const report = JSON.parse(content.text) as DramaShotReport
      assetOutcomes.push({ ambiguous, ok: report.ok,
        bound: report.shots[0]?.bindings.map(binding => binding.name),
        failures: report.failures.map(issue => issue.code) })
    }
    expect(assetOutcomes).toMatchInlineSnapshot(`
      [
        {
          "ambiguous": false,
          "bound": [
            "陆沉舟（家常装）",
            "后厨",
          ],
          "failures": [],
          "ok": true,
        },
        {
          "ambiguous": true,
          "bound": [
            "后厨",
          ],
          "failures": [
            "asset_binding_ambiguous",
          ],
          "ok": false,
        },
      ]
    `)
    await writeFile(script, speakingShot(1, '苏晚：原文台词', ['出镜人物：苏晚', '核心场景：后厨', '关键道具：奶瓶']))
    const versionOutcomes = []
    for (const scenario of [
      { episode: 1, ambiguous: '' }, { episode: 2, ambiguous: '' },
      { episode: 1, ambiguous: 'scene' }, { episode: 1, ambiguous: 'prop' },
    ]) {
      await writeFile(assets, JSON.stringify(manifestDocument(
        assetRow('苏晚', '角色', { jubian_asset_id: '71001', jubian_material_id: '81001', episodes: [1] }),
        assetRow('苏晚', '角色', { jubian_asset_id: '71002', jubian_material_id: '81002', episodes: [2] }),
        assetRow('后厨', '场景', { jubian_asset_id: '72001', jubian_material_id: '82001', episodes: [1] }),
        assetRow('后厨', '场景', { jubian_asset_id: '72002', jubian_material_id: '82002', episodes: [2] }),
        assetRow('奶瓶', '道具', { jubian_asset_id: '73001', jubian_material_id: '83001', episodes: [1] }),
        assetRow('奶瓶', '道具', { jubian_asset_id: '73002', jubian_material_id: '83002', episodes: [2] }),
        ...(scenario.ambiguous === 'scene' ? [assetRow('后厨', '场景', { jubian_asset_id: '72003', jubian_material_id: '82003' })]
          : scenario.ambiguous === 'prop' ? [assetRow('奶瓶', '道具', { jubian_asset_id: '73003', jubian_material_id: '83003' })] : []),
      )))
      const result = await tools.execute({ signal: new AbortController().signal,
        callId: ToolCallId(`versions-${scenario.episode}-${scenario.ambiguous}`), name: 'drama_shot',
        arguments: { method: 'validate', script, assets, episode: scenario.episode } })
      expect(result.isError).toBe(false)
      const content = result.content[0]
      if (content?.type !== 'text') throw new Error('Expected rendered version report')
      const report = JSON.parse(content.text) as DramaShotReport
      versionOutcomes.push({ ...scenario, ok: report.ok,
        bound: report.shots[0]?.bindings.map(binding => ({ name: binding.name,
          asset_id: binding.asset_id, material_id: binding.material_id })),
        failures: report.failures.map(issue => ({ code: issue.code, message: issue.message })) })
    }
    expect(versionOutcomes).toMatchInlineSnapshot(`
      [
        {
          "ambiguous": "",
          "bound": [
            {
              "asset_id": "71001",
              "material_id": "81001",
              "name": "苏晚",
            },
            {
              "asset_id": "72001",
              "material_id": "82001",
              "name": "后厨",
            },
            {
              "asset_id": "73001",
              "material_id": "83001",
              "name": "奶瓶",
            },
          ],
          "episode": 1,
          "failures": [],
          "ok": true,
        },
        {
          "ambiguous": "",
          "bound": [
            {
              "asset_id": "71002",
              "material_id": "81002",
              "name": "苏晚",
            },
            {
              "asset_id": "72002",
              "material_id": "82002",
              "name": "后厨",
            },
            {
              "asset_id": "73002",
              "material_id": "83002",
              "name": "奶瓶",
            },
          ],
          "episode": 2,
          "failures": [],
          "ok": true,
        },
        {
          "ambiguous": "scene",
          "bound": [
            {
              "asset_id": "71001",
              "material_id": "81001",
              "name": "苏晚",
            },
            {
              "asset_id": "73001",
              "material_id": "83001",
              "name": "奶瓶",
            },
          ],
          "episode": 1,
          "failures": [
            {
              "code": "asset_binding_ambiguous",
              "message": "镜头1的 后厨 无法唯一绑定资产版本：资产 后厨（jubian_asset_id 72001 / material 82001）；资产 后厨（jubian_asset_id 72003 / material 82003）。用不同的完整资产名明确本镜版本，或补清 episodes；不按清单顺序猜。",
            },
          ],
          "ok": false,
        },
        {
          "ambiguous": "prop",
          "bound": [
            {
              "asset_id": "71001",
              "material_id": "81001",
              "name": "苏晚",
            },
            {
              "asset_id": "72001",
              "material_id": "82001",
              "name": "后厨",
            },
          ],
          "episode": 1,
          "failures": [
            {
              "code": "asset_binding_ambiguous",
              "message": "镜头1的 奶瓶 无法唯一绑定资产版本：资产 奶瓶（jubian_asset_id 73001 / material 83001）；资产 奶瓶（jubian_asset_id 73003 / material 83003）。用不同的完整资产名明确本镜版本，或补清 episodes；不按清单顺序猜。",
            },
          ],
          "ok": false,
        },
      ]
    `)
    const animalScript = actionShot(1, ['出镜人物：赵大刚', '核心场景：后厨', '关键道具：无',
      '四层朝向链：【目光落在小鸡身上】；', '动作复杂度：较复杂',
      '素材映射：@[赵大刚](human) @[后厨](scene)']).replaceAll('苏晚', '赵大刚')
    expect(animalScript).not.toContain('@[黄色雏鸡]')
    await writeFile(script, animalScript)
    await mkdir(join(root, 'episodes'), { recursive: true })
    await writeFile(join(root, 'episodes', '02.txt'), '赵大刚的目光落在小鸡身上。')
    await writeFile(assets, JSON.stringify(manifestDocument(
      assetRow('赵大刚', '角色', { jubian_asset_id: '71001', episodes: [2] }),
      assetRow('黄色雏鸡', '角色', { jubian_asset_id: '71002', episodes: [1, 2],
        subject_kind: 'animal', aliases: ['小鸡'], state_or_costume: '黄色绒毛' }),
      assetRow('后厨', '场景', { jubian_asset_id: '71003', episodes: [2] }),
    )))
    const animalResult = await tools.execute({ signal: new AbortController().signal,
      callId: ToolCallId('visible-animal'), name: 'drama_shot',
      arguments: { method: 'compile', script, assets, project: root, episode: 2, max_submit_seconds: 15 } })
    expect(animalResult.isError).toBe(false)
    const animalContent = animalResult.content[0]
    if (animalContent?.type !== 'text') throw new Error('Expected rendered animal report')
    const animalReport = JSON.parse(animalContent.text) as DramaShotReport
    expect(animalReport.ok).toBe(true)
    const matched = JSON.parse(await readFile(join(root, 'matches', '02.matched.json'), 'utf8')) as MatchedPayload
    expect(matched.video_tasks[0]?.prompt).toContain(animalScript)
    expect(matched.video_tasks[0]?.prompt).toBe(animalReport.packages[0]?.prompt)
    expect({ ok: animalReport.ok, failures: animalReport.failures.map(issue => issue.code),
      bound: animalReport.shots[0]?.bindings.map(binding => binding.name),
      packages: animalReport.packages.map(item => ({ names: item.material_names, keys: item.material_keys,
        mappings: item.prompt.split('\n').filter(line => line.startsWith('素材映射：')) })) }).toMatchInlineSnapshot(`
        {
          "bound": [
            "赵大刚",
            "黄色雏鸡",
            "后厨",
          ],
          "failures": [],
          "ok": true,
          "packages": [
            {
              "keys": [
                "human",
                "scene",
                "asset_71002",
              ],
              "mappings": [
                "素材映射：@[赵大刚](human) @[后厨](scene)",
                "素材映射：@[黄色雏鸡](asset_71002)",
              ],
              "names": [
                "赵大刚",
                "黄色雏鸡",
                "后厨",
              ],
            },
          ],
        }
      `)
    const entry = [...ctx.loader.entries()].find(row => row.options.name === '@deepseek-ai/dsh-tool-shot-script')
    await entry?.fiber?.dispose()
    expect(tools.get('drama_shot')).toBeUndefined()
  } finally {
    await ctx.fiber.dispose()
    await rm(root, { recursive: true, force: true })
  }
})
