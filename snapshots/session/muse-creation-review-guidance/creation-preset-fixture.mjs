/** Replay full on-demand review guidance through the actual creation preset and Node PTC. */
import assert from 'node:assert/strict'
import { apply as mountPreset } from '../muse-editing-tool-catalog/editing-preset-fixture.mjs'
import { importSnapshotModule } from '../muse-fixture-import.mjs'
const Jubian = await importSnapshotModule(new URL('../../../packages/jubian/tool-jubian/src/index.ts', import.meta.url),
  new URL('../../../packages/jubian/tool-jubian/lib/index.js', import.meta.url))
export const name = 'snapshot-creation-preset'
export const inject = ['agentPresets', 'tools', 'systemPrompt', 'skills', 'llm', 'agents', 'credentials']
/** Mount the product preset and verify complete skill bodies in later requests. */
export async function apply(ctx) {
  await ctx.plugin(Jubian, { baseUrl: 'https://snapshot-jubian.invalid', workspaceSecrets: false }).await()
  await mountPreset(ctx, { presetId: 'creation', hidePlatformShellTools: true })
  let requests = 0
  ctx.on('llm/stream', async function* (options, next) {
    assert.deepEqual(options.tools.map(tool => tool.name), ['run_code'])
    const agent = ctx.agents.get(options.sessionId)
    assert.ok(agent)
    const results = options.messages.filter(message => message.role === 'tool')
    assert.equal(results.length, requests)
    const names = ['screenplay-project', 'video-review', 'screenplay-format']
    for (let index = 0; index < Math.min(requests, names.length); index++) {
      const result = results[index]
      assert.equal(result.isError, false)
      const value = JSON.parse(result.content.filter(block => block.type === 'text').map(block => block.text).join(''))
      const skill = await ctx.skills.get(names[index], { scope: agent, cwd: agent.session.header.cwd })
      assert.ok(skill)
      assert.equal(value.name, names[index])
      assert.equal(value.provider, 'muse-creation')
      assert.equal(value.content, skill.content, 'Actual later model input includes the complete current guide')
      assert.deepEqual(value.resourceBase, skill.resourceBase)
      if (index === 0) for (const rule of ['每模型轮最多4张', '成功模型轮', '只读操作不会改变项目修订号', '属于场次节拍', '不是按几分钟定时过期', '摘要里的“已读”不是凭据', 'B 不要求紧邻 C', '成稿渠道', 'expected_revision', '不包含目录索引', '同一个纯姓名', '必须逐字等于', '不能仅补 `witnesses`', '不在每轮反复生成整段长 JSON', '由对白宣布的结果', '不为满足维度名称虚构动作']) {
        assert.ok(value.content.includes(rule), 'The actual source-review guide contains: ' + rule)
      }
    }
    requests++
    yield* next()
  })
  ctx.on('session/event', (_session, event) => {
    if (event.type === 'turn/end') assert.equal(requests, 5)
  })
}
