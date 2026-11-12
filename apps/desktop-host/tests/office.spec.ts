import * as NativeToolExecutor from '@deepseek-ai/dsh-tool-executor-native'
import { readFileSync } from 'node:fs'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import SkillRegistry from '@deepseek-ai/dsh-skill'
import * as SkillOffice from '@deepseek-ai/dsh-skill-office'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import LocalSubprocessRuntime from '@deepseek-ai/dsh-subprocess-local'
import Sessions from '@deepseek-ai/dsh-session'
import SessionProjections from '@deepseek-ai/dsh-session-projection'
import { SessionQueryEngine } from '@deepseek-ai/dsh-session-query'
import { loadOverlayPatches } from '@deepseek-ai/dsh-app-boot'
import { Config as DiscoveryConfig } from '@deepseek-ai/dsh-tool-discovery'
import { ToolSearchIndex } from '../../../packages/core/tool-discovery/src/search.ts'
import { expect, it } from 'vitest'
import { parse as parseYaml } from 'yaml'
import * as desktopOffice from '../src/office.ts'

class OfficeQueries extends SessionQueryEngine {
  async searchSessions(): Promise<never> { throw new Error('Search is not part of Office loading') }
  async searchEvents(): Promise<never> { throw new Error('Search is not part of Office loading') }
}

it('enables native Office tools in working presets without enabling them in the coordinator', () => {
  for (const preset of ['standard', 'ptc', 'cordis', 'short-drama', 'creation', 'bot-coordinator', 'minimal']) {
    const rows = parseYaml(readFileSync(new URL(`../presets/${preset}/agent.cordis.yml`, import.meta.url), 'utf8'), {
      customTags: [{ tag: 'tag:yaml.org,2002:js', resolve: (value: string) => ({ __jsExpr: value }) }],
    }) as { id?: string; name?: string }[]
    const office = rows.filter(row => row.id === 'tool-office')
    if (preset === 'bot-coordinator' || preset === 'minimal') expect(office, preset).toEqual([])
    else expect(office, preset).toEqual([{ id: 'tool-office', name: '@deepseek-ai/dsh-tool-office' }])
  }
})

it.each([[undefined, true], ['advisory', true], [undefined, false]] as const)(
  'loads Desktop Office with review policy %s and recovery %s, then removes it on disposal', async (reviewMode, recoveryEnabled) => {
    const root = await mkdtemp(join(tmpdir(), 'desktop-office-'))
    const ctx = new Context()
    try {
      ctx.baseUrl = pathToFileURL(root).href + '/'
      await ctx.plugin(Loader)
      ctx.loader.builtins.include = Include
      expect('default' in desktopOffice).toBe(false)
      expect(ctx.loader.unwrapExports(desktopOffice)).toBe(desktopOffice)
      const modules = new Map<string, unknown>([
        ['agents', AgentRegistry], ['systemPrompt', SystemPrompt], ['tools', ToolRuntime],
        ['skills', SkillRegistry], ['skillOffice', SkillOffice], ['subprocess', LocalSubprocessRuntime], ['office', desktopOffice], ['nativeToolExecutor', NativeToolExecutor],
        ['sessions', Sessions], ['sessionProjections', SessionProjections], ['sessionQuery', OfficeQueries],
      ])
      ctx.loader.internal = {
        version: 'v2',
        loadCache: new Map(),
        register() { throw new Error('Unexpected loader hooks') },
        getOrCreateModuleJob() { throw new Error('Unexpected loader job') },
        resolveSync() { throw new Error('Unexpected loader resolution') },
        load() { throw new Error('Unexpected loader load') },
        async import(specifier: string) {
          if (!modules.has(specifier)) throw new Error(`unexpected plugin ${specifier}`)
          return modules.get(specifier)
        },
      }
      const config = join(root, 'cordis.yml')
      await writeFile(config, [
        '- name: sessions', '- name: sessionProjections', '- name: sessionQuery', '- name: agents', '- name: systemPrompt', '- name: tools',
        '- name: skills', '- name: skillOffice', '- name: subprocess', '- name: nativeToolExecutor', '- name: office',
        '  config:', `    source: ${JSON.stringify(join(root, 'runtime', 'primary-runtime'))}`,
        ...(reviewMode === undefined ? [] : [`    docxReviewMode: ${reviewMode}`]),
        ...(recoveryEnabled ? [] : ['    sourceRecovery: false']),
      ].join('\n'))
      await ctx.loader.create({ name: 'cordis:include', config: { path: pathToFileURL(config).href } })
      await ctx.loader.await()
      for (const entry of ctx.loader.entries()) await entry.fiber?.await()
      const officeSkills = ['office', 'office-docx', 'office-pptx', 'office-xlsx']
      expect((await ctx.skills.list()).map(skill => skill.name)).toEqual(officeSkills)
      expect(ctx.tools.schemas().map(tool => tool.name).toSorted()).toEqual([
        'manuscript_revision', ...(recoveryEnabled ? ['source_recover'] : []),
        'jianying_draft', 'screenplay_export_docx',
      ].toSorted())
      const discovery = loadOverlayPatches('desktop-office-discovery', fileURLToPath(new URL('../config/desktop.cordis.patch.yml', import.meta.url)))
        .flatMap(patch => patch.insert ?? []).find(row => row.id === 'tool-discovery')
      if (!discovery) throw new Error('Missing Desktop tool-discovery row')
      const raw: unknown = discovery.config
      if (!raw || typeof raw !== 'object' || !('alwaysLoad' in raw)
        || !Array.isArray(raw.alwaysLoad) || !raw.alwaysLoad.every((value: unknown): value is string => typeof value === 'string')) {
        throw new Error('Missing resident tool names')
      }
      const searchConfig = DiscoveryConfig({ ...raw, alwaysLoad: raw.alwaysLoad })
      const documents = ctx.tools.schemas().map(schema => ({ ...schema, keywords: searchConfig.keywords?.[schema.name] ?? [] }))
      const index = new ToolSearchIndex(documents,
        { k1: searchConfig.k1 ?? 1.2, b: searchConfig.b ?? 0.75 })
      for (const [query, tool] of [['生成可编辑草稿', 'jianying_draft'], ['导出剧本Word', 'screenplay_export_docx'],
        ['精修核对原稿对照', 'manuscript_revision']] as const) {
        expect(index.search(query, 1).map(result => result.name)).toEqual([tool])
      }
      const description = ctx.tools.schemas().find(tool => tool.name === 'screenplay_export_docx')?.description
      expect(description).toContain(reviewMode === 'advisory' ? '导出不要求批准候选' : '严格候选验收')
      const entry = [...ctx.loader.entries()].find(entry => entry.options.name === 'office')
      expect(entry).toBeDefined()
      await entry?.fiber?.dispose()
      expect((await ctx.skills.list()).map(skill => skill.name)).toEqual(officeSkills)
      expect(ctx.tools.schemas()).toEqual([])
    } finally {
      await ctx.fiber.dispose()
      await rm(root, { recursive: true, force: true })
    }
  })
