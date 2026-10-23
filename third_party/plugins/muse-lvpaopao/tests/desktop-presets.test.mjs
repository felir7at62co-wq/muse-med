/** Desktop owns one lazy native bridge and one tool inside the unified director. */
import { readFileSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import Tools from '@deepseek-ai/dsh-tools'
import { AgentRegistry } from '@deepseek-ai/dsh-agent'
import LocalSubprocess from '@deepseek-ai/dsh-subprocess-local'
import { createScope } from '@deepseek-ai/dsh-scope'
import { createRequire } from 'node:module'
const { parse: parseYaml } = createRequire(new URL('../../../../apps/desktop-host/package.json', import.meta.url))('yaml')
import assert from 'node:assert/strict'
import test from 'node:test'
import * as Consumer from '../src/index.ts'
import Bridge from '../src/bridge.ts'

function rows(path) {
  return parseYaml(readFileSync(new URL(path, import.meta.url), 'utf8'), {
    customTags: [{ tag: 'tag:yaml.org,2002:js', resolve: (value) => ({ __jsExpr: value }) }],
  })
}

test('loads one Host bridge and scopes Lvpaopao to the director without launching preparation', async () => {
  const host = rows('../../../../apps/desktop-host/config/desktop.cordis.patch.yml')
  assert.equal(host.flatMap(row => row.insert ?? []).filter(row => row.name === 'muse-lvpaopao/bridge').length, 1)
  assert.equal(host.flatMap(row => row.insert ?? []).some(row => row.name === 'muse-lvpaopao'), false)
  assert.equal(rows('../../../../apps/desktop-host/presets/short-drama/agent.cordis.yml').filter(row => row.name === 'muse-lvpaopao').length, 1)
  assert.equal(rows('../../../../apps/desktop-host/presets/minimal/agent.cordis.yml').some(row => row.name?.startsWith('muse-lvpaopao')), false)
  const directory = await mkdtemp(join(tmpdir(), 'muse-lvpaopao-preset-'))
  const ctx = new Context()
  try {
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(Tools)
    await ctx.plugin(AgentRegistry)
    await ctx.plugin(LocalSubprocess)
    let spawns = 0
    const spawn = ctx.subprocess.spawn.bind(ctx.subprocess)
    ctx.subprocess.spawn = spec => { spawns++; return spawn(spec) }
    await ctx.plugin(Bridge, { connectionFile: join(directory, 'absent.json'), autoSetup: false })
    const key = {}, scope = createScope(ctx, key)
    try {
      await scope.ctx.plugin(Consumer)
      assert.deepEqual(ctx.tools.schemas(key).map(tool => tool.name), ['lvpaopao'])
      assert.deepEqual(ctx.tools.schemas(), [])
      assert.equal(spawns, 0)
    } finally { await scope.dispose() }
    assert.deepEqual(ctx.tools.schemas(key), [])
    assert.equal(spawns, 0)
  } finally {
    await ctx.fiber.dispose()
    await rm(directory, { recursive: true, force: true })
  }
})
