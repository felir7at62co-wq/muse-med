import { cp, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import SkillRegistry from '@deepseek-ai/dsh-skill'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import LocalSubprocessRuntime from '@deepseek-ai/dsh-subprocess-local'
import Sessions from '@deepseek-ai/dsh-session'
import { SessionQueryEngine } from '@deepseek-ai/dsh-session-query'
import { loadOverlayPatches } from '@deepseek-ai/dsh-app-boot'
import { Config as DiscoveryConfig } from '@deepseek-ai/dsh-tool-discovery'
import { ToolSearchIndex } from '../../../packages/core/tool-discovery/src/search.ts'
import { expect, it } from 'vitest'
import * as desktopOffice from '../src/office.ts'

class OfficeQueries extends SessionQueryEngine {
  async searchSessions(): Promise<never> { throw new Error('Search is not part of Office loading') }
  async searchEvents(): Promise<never> { throw new Error('Search is not part of Office loading') }
}

it.each([[undefined, true], ['advisory', true], [undefined, false]] as const)(
  'loads Desktop Office with review policy %s and recovery %s, then removes it on disposal', async (reviewMode, recoveryEnabled) => {
    const root = await mkdtemp(join(tmpdir(), 'desktop-office-'))
    const ctx = new Context()
    try {
      const assets = join(root, 'runtime', 'office-skills')
      await cp(new URL('../../../packages/skill/skill-office/assets/', import.meta.url), assets, { recursive: true })
      const nodeDirectory = join(root, 'runtime', 'primary-runtime', 'dependencies', 'node', 'bin')
      await mkdir(nodeDirectory, { recursive: true })
      await cp(process.execPath, join(nodeDirectory, process.platform === 'win32' ? 'node.exe' : 'node'))
      ctx.baseUrl = pathToFileURL(root).href + '/'
      await ctx.plugin(Loader)
      ctx.loader.builtins.include = Include
      expect('default' in desktopOffice).toBe(false)
      expect(ctx.loader.unwrapExports(desktopOffice)).toBe(desktopOffice)
      const modules = new Map<string, unknown>([
        ['agents', AgentRegistry], ['systemPrompt', SystemPrompt], ['tools', ToolRuntime],
        ['skills', SkillRegistry], ['subprocess', LocalSubprocessRuntime], ['office', desktopOffice],
        ['sessions', Sessions], ['sessionQuery', OfficeQueries],
      ])
      ctx.loader.internal = {
        version: 'v2',
        async import(specifier: string) {
          if (!modules.has(specifier)) throw new Error(`unexpected plugin ${specifier}`)
          return modules.get(specifier)
        },
      } as unknown as NonNullable<typeof ctx.loader.internal>
      const config = join(root, 'cordis.yml')
      await writeFile(config, [
        '- name: sessions', '- name: sessionQuery', '- name: agents', '- name: systemPrompt', '- name: tools',
        '- name: skills', '- name: subprocess', '- name: office',
        '  config:', `    source: ${JSON.stringify(join(root, 'runtime', 'primary-runtime'))}`,
        `    root: ${JSON.stringify(join(root, 'installed'))}`,
        `    runtimeDir: ${JSON.stringify(join(root, 'dsh'))}`, '',
        ...(reviewMode === undefined ? [] : [`    docxReviewMode: ${reviewMode}`]),
        ...(recoveryEnabled ? [] : ['    sourceRecovery: false']),
      ].join('\n'))
      await ctx.loader.create({ name: 'cordis:include', config: { path: pathToFileURL(config).href } })
      await ctx.loader.await()
      for (const entry of ctx.loader.entries()) await entry.fiber?.await()
      expect((await ctx.skills.list()).map(skill => skill.name)).toEqual(['office-docx', 'office-pptx', 'office-xlsx'])
      expect((await ctx.skills.get('office-pptx'))?.resourceBase).toEqual({ kind: 'directory', path: join(assets, 'office-pptx') })
      expect((await ctx.skills.get('office-pptx'))?.content).toContain('libreofficeKit')
      expect((await ctx.skills.get('office-pptx'))?.content).toContain(JSON.stringify(nodeDirectory).slice(1, -1))
      expect(ctx.tools.schemas().map(tool => tool.name)).toEqual([
        'load_workspace_dependencies', 'manuscript_revision', ...(recoveryEnabled ? ['source_recover'] : []),
        'jianying_draft', 'screenplay_export_docx',
      ])
      const discovery = loadOverlayPatches('desktop-office-discovery', fileURLToPath(new URL('../config/desktop.cordis.patch.yml', import.meta.url)))
        .flatMap(patch => patch.insert ?? []).find(row => row.id === 'tool-discovery')
      if (!discovery) throw new Error('Missing Desktop tool-discovery row')
      const raw: unknown = discovery.config
      if (!raw || typeof raw !== 'object' || !('alwaysLoad' in raw)
        || !Array.isArray(raw.alwaysLoad) || !raw.alwaysLoad.every((value: unknown): value is string => typeof value === 'string')) {
        throw new Error('Missing resident tool names')
      }
      const searchConfig = DiscoveryConfig({ ...raw, alwaysLoad: raw.alwaysLoad })
      const index = new ToolSearchIndex(ctx.tools.schemas().map(schema => ({ ...schema, keywords: searchConfig.keywords?.[schema.name] })),
        { k1: searchConfig.k1 ?? 1.2, b: searchConfig.b ?? 0.75 })
      for (const [query, tool] of [['生成可编辑草稿', 'jianying_draft'], ['导出剧本Word', 'screenplay_export_docx'],
        ['找工作间依赖', 'load_workspace_dependencies'], ['精修核对原稿对照', 'manuscript_revision']]) {
        expect(index.search(query, 1).map(result => result.name)).toEqual([tool])
      }
      const description = ctx.tools.schemas().find(tool => tool.name === 'screenplay_export_docx')?.description
      expect(description).toContain(reviewMode === 'advisory' ? '不要求独立审校' : '严格候选验收')
      const entry = [...ctx.loader.entries()].find(entry => entry.options.name === 'office')
      expect(entry).toBeDefined()
      await entry?.fiber?.dispose()
      expect(await ctx.skills.list()).toEqual([])
      expect(ctx.tools.schemas()).toEqual([])
    } finally {
      await ctx.fiber.dispose()
      await rm(root, { recursive: true, force: true })
    }
  })
