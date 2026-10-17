/** Actual creation composition with model-request assertions and no live provider I/O. */
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { apply as mountPreset } from '../muse-editing-tool-catalog/editing-preset-fixture.mjs'
import { importSnapshotModule, importSnapshotPackage } from '../muse-fixture-import.mjs'

const [{ defineTool }, Jubian] = await Promise.all([
  importSnapshotPackage('@deepseek-ai/dsh-tools', new URL('../../../apps/desktop-host/package.json', import.meta.url)),
  importSnapshotModule(new URL('../../../packages/jubian/tool-jubian/src/index.ts', import.meta.url),
    new URL('../../../packages/jubian/tool-jubian/lib/index.js', import.meta.url)),
])
export const name = 'snapshot-creation-preset'
export const inject = ['agentPresets', 'tools', 'systemPrompt', 'skills', 'llm', 'agents', 'credentials']

/**
 * Mount the real native preset and verify its direct and program-only model surfaces.
 * @param {import('@deepseek-ai/cordis').Context} ctx - Snapshot Host services.
 */
export async function apply(ctx) {
  await ctx.plugin(Jubian, { baseUrl: 'https://snapshot-jubian.invalid', workspaceSecrets: false }).await()
  await mountPreset(ctx, { presetId: 'creation', hidePlatformShellTools: true })
  ctx.effect(() => ctx.skills.register({ name: 'hidden-authoring', description: 'Unapproved runtime authoring',
    source: 'runtime', content: 'Unapproved instructions' }))
  for (const name of ['delegation_alias', 'spawn_teammate']) {
    ctx.effect(() => ctx.tools.register(defineTool({ name, description: 'Unapproved model orchestration alias',
      parameters: {}, output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
      execute: async () => { assert.fail('Creation must never execute an orchestration alias') },
    })))
  }
  let requests = 0
  const dispatches = []
  let workflowPath
  let qualityPath
  ctx.on('llm/stream', async function* (options, next) {
    assert.deepEqual(options.tools.map(tool => tool.name), ['run_code'], 'Creation exposes only run_code directly')
    const system = options.messages.filter(message => message.role === 'system')
      .flatMap(message => message.content).filter(block => block.type === 'text').map(block => block.text).join('\n')
    assert.match(system, /Program-only SDK bindings:/u)
    for (const instruction of ['## 创作共用规则', '只推进所需阶段', 'audio-transcribe', '来源事实与原声转写保留',
      '重大事件反转、关系立场、动机或关键揭晓变化先确认', '成稿与独立《修改说明》并列交付',
      '小说、换梗与新写', '详细写作标准随 screenplay-format 按需读取',
      '新创作视频剧本默认 story-faithful-v2', '先取得真实总时长并分窗检查整集', '所有计费、剧变和知识库操作']) {
      assert.ok(system.includes(instruction), 'Shared task routing, sources, authorization, delivery and cost rules are automatic')
    }
    assert.equal(system.split('## 创作共用规则').length - 1, 1, 'Shared guidance is not repeated')
    assert.ok(system.includes('下一模型轮检查'), 'Shared guidance requires a later model self-check')
    assert.ok(system.includes('historical independent'), 'Historical independent review remains explicit')
    assert.ok(system.includes('create_goal may infer goal intent'), 'Creation retains the grouped goal policy')
    assert.ok(system.includes('Track every background job id you start.'), 'Creation retains the grouped jobs policy')
    const agent = ctx.agents.get(options.sessionId)
    assert.ok(agent, 'The model request belongs to the real creation agent')
    const project = ctx.tools.schemas(agent).find(tool => tool.name === 'screenplay_project')
    assert.ok(project, 'Creation includes the real screenplay project schema')
    const commands = project.parameters.properties.request.oneOf
    for (const method of ['init_story_faithful', 'fork_story_faithful']) {
      const command = commands.find(command => command.properties.method.const === method)
      assert.ok(command, `The actual creation preset enables ${method}`)
      assert.equal(command.properties.videos.items.properties.episode.type, 'integer',
        'The real story command schema exposes each video episode')
      const marker = `method: "${method}";`
      const offset = system.indexOf(marker)
      assert.ok(offset >= 0, `The generated creative SDK includes ${method}`)
      assert.match(system.slice(offset).split('} | {', 1)[0],
        /videos:\s*\{[^}]*episode\??:\s*number;[^}]*\}\[\];/u,
        'The actual model request SDK exposes videos[].episode')
    }
    for (const instruction of ['C review所在外层run_code必须成功结束，下一模型轮才可commit/export',
      '外层失败或取消时重新stage、B完整读回，再于下一模型轮C审校']) {
      assert.ok(project.description.includes(instruction), 'The real story tool describes successful outer C settlement')
      assert.ok(system.includes(instruction), 'The actual model request SDK includes the C-to-commit sequence')
    }
    const fork = commands.find(command => command.properties.method.const === 'fork_refinement')
    assert.ok(fork, 'The actual creation preset enables its refinement fork')
    assert.deepEqual(fork.properties.allowed_categories.items.enum,
      ['performance_detail', 'minimal_os', 'supporting_dialogue'])
    const stage = commands.find(command => command.properties.method.const === 'stage')
    assert.ok(stage.properties.modification_notes, 'Refinement stages expose modification notes')
    assert.ok(stage.properties.scenes.items.properties.beats.items.properties.sync_with,
      'Refinement preserves source-backed synchronous action display')
    assert.ok(system.includes('fork_refinement'), 'The generated SDK exposes the configured refinement command')
    assert.ok(system.includes('当编写短剧镜头脚本时，建议每个镜头控制在1–4秒'), 'Shot pacing applies when writing short-drama shot scripts')
    assert.ok(system.includes('按8个有效字/秒计算预算'), 'The model receives the current speech budgeting rule')
    assert.ok(system.includes('禁止镜头时长字段'), 'Generation prompts exclude shooting-time instructions')
    assert.ok(system.includes('多人站位参考图'), 'Visible multi-character scenes require positioning references')
    for (const name of ['skill', 'screenplay_project', 'drama_assets', 'jubian_budget', 'video_inspect']) {
      assert.ok(system.includes(`\n  ${name}:`), `The real creative SDK includes ${name}`)
    }
    for (const name of ['subagent', 'subagent_fork', 'workflow', 'ralph', 'delegation_alias', 'spawn_teammate']) {
      assert.ok(!system.includes(`\n  ${name}:`), `Creation excludes the ${name} SDK binding`)
    }
    const catalogs = options.messages.flatMap(message => message.content)
      .filter(block => block.type === 'text').map(block => block.text).join('\n')
    assert.ok(!catalogs.includes('hidden-authoring'), 'The isolated creative catalog excludes unapproved skills')
    const entries = options.messages.flatMap(message => message.source?.kind === 'skill-catalog'
      ? message.source.entries : [])
    assert.ok(!entries.some(skill => skill.name === 'muse-creation'), 'The removed guide is absent from the catalog')
    assert.ok(entries.some(skill => skill.name === 'muse-script-editing'), 'The current editing skill is discoverable')
    assert.ok(entries.some(skill => skill.name === 'muse-dialogue-polish'), 'The dialogue specialist is discoverable')
    assert.match(entries.find(skill => skill.name === 'muse-dialogue-polish').description, /台词质量|对白互不回应/u,
      'The automatic catalog describes the professional match for this task')
    assert.ok(entries.some(skill => skill.name === 'screenplay-format'), 'The shared writing entry is discoverable')
    assert.ok(catalogs.includes("If the user names a skill, or the task clearly matches a skill's description"),
      'The automatic catalog instructs matching tasks to load the full skill')
    assert.ok(catalogs.includes('This catalog contains summaries only; do not infer or follow'),
      'The automatic catalog does not substitute summaries for full skill instructions')
    assert.ok(!entries.some(skill => skill.name === 'xiaohongshu-reference'), 'The removed reference skill is absent from the catalog')
    const source = await ctx.skills.get('muse-dialogue-polish', { scope: agent, cwd: agent.session.header.cwd })
    assert.ok(source, 'The original professional skill is available')
    assert.equal(source.resourceBase.kind, 'directory')
    workflowPath = join(source.resourceBase.path, 'references/dialogue-workflow.md')
    const isolated = ctx.agentPresets.serviceFor(agent, 'skills')
    const formatSource = await ctx.skills.get('screenplay-format', { scope: agent, cwd: agent.session.header.cwd })
    const format = await isolated.get('screenplay-format', { scope: agent, cwd: agent.session.header.cwd })
    assert.ok(formatSource && format, 'The actual shared writing entry is available')
    assert.equal(format.resourceBase.kind, 'directory')
    assert.deepEqual(format.resourceBase, formatSource.resourceBase, 'The format skill retains its real resource location')
    assert.equal(format.content, formatSource.content, 'The format skill body has no preset-local prepend')
    qualityPath = join(format.resourceBase.path, 'references/writing-quality.md')
    const qualityBody = await readFile(qualityPath, 'utf8')
    assert.equal(qualityBody, await readFile(
      new URL('../../../apps/desktop-host/skills/screenplay-format/references/writing-quality.md', import.meta.url), 'utf8'),
    'The real resource contains the complete shipped shared standard')
    for (const heading of ['# Muse 精修与 QA 指南', '# 共同自检协议', '## 表演展示不改变剧情结构']) {
      assert.ok(!catalogs.includes(heading), 'Unloaded detailed templates and QA bodies are absent')
    }
    if (requests < 3) {
      assert.ok(!catalogs.includes(format.content), 'The format body is absent until its actual skill result')
    }
    if (requests < 4) {
      assert.ok(!catalogs.includes(qualityBody), 'The complete shared standard is absent before its actual read result')
    }
    if (requests === 0) {
      assert.equal(options.messages.filter(message => message.role === 'tool').length, 0,
        'The first request has shared rules without any earlier tool or skill result')
      assert.ok(!catalogs.includes(source.content), 'The first request has not preloaded the specialist body')
      assert.ok(!system.includes('先读 muse-creation'), 'The optional guide is not a mandatory entry skill')
    } else {
      const results = options.messages.filter(message => message.role === 'tool')
      assert.equal(results.length, requests)
      assert.equal(results[0].toolCallId, 'call_creation_skill')
      const skillText = results[0].content.filter(block => block.type === 'text').map(block => block.text).join('')
      assert.equal(results[0].isError, false, `The real skill call succeeds: ${skillText}`)
      const value = JSON.parse(skillText)
      const skill = await isolated.get('muse-dialogue-polish', { scope: agent, cwd: agent.session.header.cwd })
      assert.equal(value.name, 'muse-dialogue-polish')
      assert.equal(value.provider, 'muse-creation')
      assert.deepEqual(value.resourceBase, source.resourceBase, 'The model gets the real resource location')
      assert.equal(value.content, skill.content, 'The next model round receives the full skill body')
      assert.equal(value.content, source.content, 'The specialist body is unchanged without MODE_GUIDANCE prepending')
      assert.match(value.content, /screenplay-format/u, 'The specialist points to the shared writing entry')
      if (requests >= 2) {
        assert.equal(results[1].toolCallId, 'call_creation_workflow')
        const workflowText = results[1].content.filter(block => block.type === 'text').map(block => block.text).join('')
        assert.equal(results[1].isError, false, `The real workflow read succeeds: ${workflowText}`)
        const workflow = JSON.parse(workflowText)
        assert.equal(workflow.path, workflowPath, 'The reference is read from the actual resourceBase')
        assert.equal(workflow.offset, 1)
        assert.equal(workflow.lines.length, workflow.totalLines, 'The complete dialogue workflow is model-visible')
        assert.deepEqual(workflow.lines.map(line => line.number), workflow.lines.map((_line, index) => index + 1))
        assert.equal(workflow.lines.map(line => line.text).join('\n') + '\n', await readFile(workflowPath, 'utf8'))
      }
      if (requests >= 3) {
        assert.equal(results[2].toolCallId, 'call_creation_format')
        const formatText = results[2].content.filter(block => block.type === 'text').map(block => block.text).join('')
        assert.equal(results[2].isError, false, `The real format skill call succeeds: ${formatText}`)
        const loadedFormat = JSON.parse(formatText)
        assert.equal(loadedFormat.name, 'screenplay-format')
        assert.equal(loadedFormat.provider, 'muse-creation')
        assert.deepEqual(loadedFormat.resourceBase, format.resourceBase, 'The model receives the format resourceBase')
        assert.equal(loadedFormat.content, format.content, 'The next model round receives the complete format body')
        assert.match(loadedFormat.content, /references\/writing-quality\.md/u,
          'The loaded format body points to its same-package full writing standard')
      }
      if (requests === 4) {
        assert.equal(results[3].toolCallId, 'call_creation_quality')
        const qualityText = results[3].content.filter(block => block.type === 'text').map(block => block.text).join('')
        assert.equal(results[3].isError, false, `The actual shared writing standard read succeeds: ${qualityText}`)
        const quality = JSON.parse(qualityText)
        assert.equal(quality.path, qualityPath, 'The reference uses the actual format resourceBase')
        assert.equal(quality.offset, 1)
        assert.equal(quality.lines.length, quality.totalLines, 'The complete shared writing standard is model-visible')
        assert.deepEqual(quality.lines.map(line => line.number), quality.lines.map((_line, index) => index + 1))
        assert.equal(quality.lines.map(line => line.text).join('\n') + '\n', qualityBody,
          'The actual later Adapter.messages contains every byte of the shared writing standard')
        for (const rule of ['未交代不等于不知道', '建议不等于已落实', '本轮未改变或沿用', '本轮修订尚待后轮复检']) {
          assert.ok(qualityBody.includes(rule), 'The actual on-demand model input includes evidence-based revision review guidance')
        }
      } else {
        assert.ok(requests >= 1 && requests <= 3, 'Only the four on-demand read-only calls precede the answer')
      }
    }
    requests++
    yield* next()
  })
  ctx.on('session/event', (_session, event) => {
    if (event.type === 'tool/ptc-dispatch-start') {
      dispatches.push(event.data.name)
      if (event.data.name === 'skill') {
        assert.deepEqual(event.data.arguments, {
          name: dispatches.length === 1 ? 'muse-dialogue-polish' : 'screenplay-format',
        })
      }
      else {
        assert.equal(event.data.name, 'read', 'The read-only smoke dispatches no production or media work')
        assert.deepEqual(Object.keys(event.data.arguments), ['file_path'])
        assert.equal(resolve(event.data.arguments.file_path), dispatches.length === 2 ? workflowPath : qualityPath)
      }
    }
    if (event.type === 'turn/end') {
      assert.equal(requests, 5, 'Four on-demand full-body reads and the answer use exactly five model rounds')
      assert.deepEqual(dispatches, ['skill', 'read', 'skill', 'read'], 'The optional guide is not automatically loaded')
    }
  })
}
