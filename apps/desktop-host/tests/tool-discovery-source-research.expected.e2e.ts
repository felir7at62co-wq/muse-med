/** Built-peer source-research discovery against the real packaged plugin. */
import { beforeAll, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Agents from '@deepseek-ai/dsh-agent'
import Sessions from '@deepseek-ai/dsh-session'
import Projections from '@deepseek-ai/dsh-session-projection'
import Tools from '@deepseek-ai/dsh-tools'
import Prompt from '@deepseek-ai/dsh-system-prompt'
import LocalFileSystem from '@deepseek-ai/dsh-fs-local'
import UserQuestionService from '@deepseek-ai/dsh-user-questions'
import { collectToolCatalog, type ToolCatalog } from '../../../scripts/gen-tool-catalog.ts'
import { capabilityMemberships } from '../../../packages/core/tool-discovery/src/capabilities.ts'
import { ToolSearchIndex } from '../../../packages/core/tool-discovery/src/search.ts'
import { loadSourceResearchPlugin } from './fixtures/source-research-plugin.ts'
import { config } from './fixtures/discovery-config.ts'

let catalog: ToolCatalog
beforeAll(async () => { catalog = await collectToolCatalog() })

it('discovers source snapshot, report and work relation tools by Chinese requests while keeping them deferred', async () => {
  const ctx = new Context()
  try {
    await ctx.plugin(Prompt)
    await ctx.plugin(Tools)
    await ctx.plugin(Sessions)
    await ctx.plugin(Projections).await()
    await ctx.plugin(Agents).await()
    await ctx.plugin(LocalFileSystem)
    await ctx.plugin(UserQuestionService)
    await ctx.plugin(await loadSourceResearchPlugin(ctx)).await()
    const researchSchemas = ctx.tools.schemas()
    expect(researchSchemas.map(schema => schema.name).sort()).toEqual(['source_report', 'source_snapshot', 'work_mapping'])
    const schemas = new Map([...catalog.flatMap(entry => entry.schemas), ...researchSchemas].map(schema => [schema.name, schema]))
    const index = new ToolSearchIndex([...schemas.values()].map(schema => ({
      ...schema, keywords: config.keywords?.[schema.name] ?? [],
    })), { k1: config.k1 ?? 1.2, b: config.b ?? 0.75 })
    for (const [query, name] of [['选材快照', 'source_snapshot'], ['快照对比', 'source_snapshot'], ['选材日报', 'source_report'], ['同名作品', 'work_mapping'], ['改编关系', 'work_mapping']] as const) {
      expect(index.search(query, config.maxResults ?? 8).map(result => result.name), query).toContain(name)
      expect(config.alwaysLoad).not.toContain(name)
      expect(capabilityMemberships(name, config.capabilities ?? [])).toContain('data-sourcing')
    }
  } finally {
    await ctx.fiber.dispose()
  }
})
