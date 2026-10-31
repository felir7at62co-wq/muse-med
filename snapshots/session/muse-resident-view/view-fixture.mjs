/** Assert direct Bot view availability through the shipped discovery composition. */
import assert from 'node:assert/strict'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { apply as mountPreset } from '../muse-editing-tool-catalog/editing-preset-fixture.mjs'
import { importSnapshotModule } from '../muse-fixture-import.mjs'
const Jubian = await importSnapshotModule(
  new URL('../../../packages/jubian/tool-jubian/src/index.ts', import.meta.url),
  new URL('../../../packages/jubian/tool-jubian/lib/index.js', import.meta.url),
)
const DramaSettings = await importSnapshotModule(
  new URL('../../../packages/drama/drama-settings/src/index.ts', import.meta.url),
  new URL('../../../packages/drama/drama-settings/lib/index.js', import.meta.url),
)
const ManuscriptRevisions = await importSnapshotModule(
  new URL('../../../apps/desktop-host/src/manuscript-revisions.ts', import.meta.url),
  new URL('../../../apps/desktop-host/lib/manuscript-revisions.js', import.meta.url),
)
const SourceRecovery = await importSnapshotModule(
  new URL('../../../apps/desktop-host/src/source-recovery.ts', import.meta.url),
  new URL('../../../apps/desktop-host/lib/source-recovery.js', import.meta.url),
)
export const name = 'resident-view-assertions'
export const inject = ['agentPresets', 'tools', 'systemPrompt', 'llm', 'credentials', 'sessionProjections']
export async function apply(ctx) {
  // A scenario-local seed keeps the existing manuscript cache directory representable in Git.
  const cache = join(process.cwd(), '.muse/manuscript-revisions')
  await mkdir(cache, { recursive: true })
  await writeFile(join(cache, 'fixture-seed'), '')
  await ctx.plugin(DramaSettings, {}).await()
  await ctx.plugin(ManuscriptRevisions, {}).await()
  await ctx.plugin(SourceRecovery, {}).await()
  await ctx.plugin(Jubian, { workspaceSecrets: false, sessionVideoSelection: true,
    defaultVideoModel: { modelId: 'doubao-seedance-2-5-260628', platformId: 'FANG_ZHOU', resolution: '480p' },
  }).await()
  await mountPreset(ctx, { presetId: 'short-drama', hidePlatformShellTools: true })
  ctx.on('llm/stream', async function* (options, next) {
    assert.equal(options.tools.filter(tool => tool.name === 'show_view').length, 1)
    assert.ok(options.tools.some(tool => tool.name === 'list_bots'))
    assert.ok(options.tools.some(tool => tool.name === 'update_bot'))
    assert.ok(options.tools.some(tool => tool.name === 'video_inspect'))
    assert.ok(!options.tools.some(tool => tool.name === 'fixture_optional_tool'))
    for (const name of ['drama_shot', 'manuscript_revision', 'drama_project', 'source_recover',
      'muse_production', 'jubian_catalog', 'jubian_organize', 'jubian_find', 'drama_character_reference_project',
      'drama_character_references', 'drama_character_reference_view', 'drama_render']) {
      assert.ok(!options.tools.some(tool => tool.name === name), `Production tool stays on demand: ${name}`)
    }
    yield* next()
  })
  ctx.on('session/event', (_session, event) => {
    if (event.type === 'tool/call') assert.equal(event.data.name, 'show_view')
  })
}
