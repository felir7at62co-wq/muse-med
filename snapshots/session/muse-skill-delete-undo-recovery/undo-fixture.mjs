/** Complete Skill undo drives the production Gateway, scanner and native registry. */
import assert from 'node:assert/strict'
import { mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { SkillsViewerGateway } from '../../../third_party/plugins/dsh-skill-mcp-panel/src/index.ts'

const enabledName = 'snapshot-restored-skill'
const disabledName = 'snapshot-disabled-skill'
const toolName = 'snapshot_skill_delete_undo'
const callId = 'call_skill_delete_undo'
const enabledBody = '# Restored fixture\nRead references/context.md before running scripts/helper.py.'
const contents = new Map([
  [`${enabledName}/SKILL.md`, Buffer.from(`---\nname: ${enabledName}\ndescription: Snapshot complete bundle recovery fixture\n---\n${enabledBody}\n`)],
  [`${enabledName}/references/context.md`, Buffer.from('# Required context\nThe recovered bundle must retain this resource.\n')],
  [`${enabledName}/scripts/helper.py`, Buffer.from('print("restored resource")\n')],
  [`${enabledName}/.metadata/settings.json`, Buffer.from('{"retained":true}\n')],
  [`${enabledName}/assets/sample.bin`, Buffer.from([0, 255, 17, 128])],
  [`category/${disabledName}/SKILL.md.disabled`, Buffer.from(`---\nname: ${disabledName}\ndescription: Snapshot nested disabled bundle recovery fixture\n---\n# Disabled fixture\nKeep this skill disabled after undo.\n`)],
  [`category/${disabledName}/references/disabled-context.md`, Buffer.from('# Disabled resource\nNested location and disabled state must be retained.\n')],
])

/** Loader identity for the complete Skill restoration conversation. */
export const name = 'snapshot-skill-delete-undo-recovery'
/** Production Gateway and native registry dependencies remain supplied by Headless. */
export const inject = ['tools', 'skills', 'llm', 'sessions', 'agents']

/**
 * Recover two complete bundles without reading or writing the user's Skill roots.
 * @param ctx - Headless Loader context owning the tool and Gateway child.
 * @returns Completion after fixture registration.
 */
export function apply(ctx) {
  let ran = false, visibleResult = false, resultText
  ctx.effect(() => ctx.tools.register(defineTool({
    name: toolName,
    description: 'Delete and undo isolated enabled and nested disabled Skill bundles through the production manager, verify every resource byte and original state, then load the restored Skill from the native registry.',
    parameters: {},
    output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
    async execute(_args, exec) {
      assert.equal(ran, false)
      ran = true
      const project = join(process.cwd(), 'project')
      const root = join(project, '.dsh', 'skills')
      const marker = join(project, '.git')
      await mkdir(project, { recursive: true })
      await writeFile(marker, 'isolated snapshot project marker\n', { flag: 'wx' })
      let gateway, child
      try {
        for (const [path, data] of contents) {
          const target = join(root, path)
          await mkdir(dirname(target), { recursive: true })
          await writeFile(target, data, { flag: 'wx' })
        }
        child = ctx.plugin(scope => { gateway = new SkillsViewerGateway(scope) })
        await child
        gateway.homes = () => ({ dshHome: join(process.cwd(), '.dsh', 'undo-home'), agentsHome: join(process.cwd(), '.dsh', 'undo-agents') })
        gateway.viewFor = () => ({ registry: ctx.skills, cwd: project, scope: exec.agent })
        gateway.workspaces = async () => ({ workspaces: [{ path: project, label: 'Undo fixture', sessions: 1 }] })
        const ownedRows = async () => (await gateway.list(exec.agent.id)).skills.filter(row => row.name === enabledName || row.name === disabledName)
        const before = await ownedRows()
        assert.equal(before.length, 2)
        const enabled = before.find(row => row.name === enabledName)
        const disabled = before.find(row => row.name === disabledName)
        assert.equal(enabled.enabled, true)
        assert.equal(enabled.rel, enabledName)
        assert.equal(disabled.enabled, false)
        assert.equal(disabled.rel, `category/${disabledName}`)
        for (const row of before) assert.deepEqual(row.scope, { kind: 'workspace', path: project, label: 'Undo fixture' })

        const enabledReceipt = await gateway.trashSkill(enabledName, exec.agent.id, project)
        assert.equal(enabledReceipt.name, enabledName)
        assert.equal(typeof enabledReceipt.undoToken, 'string')
        await assert.rejects(stat(join(root, enabledName)), { code: 'ENOENT' })
        const disabledReceipt = await gateway.trashSkill(disabledName, exec.agent.id, project)
        assert.equal(disabledReceipt.name, disabledName)
        assert.equal(typeof disabledReceipt.undoToken, 'string')
        assert.notEqual(disabledReceipt.undoToken, enabledReceipt.undoToken)
        await assert.rejects(stat(join(root, 'category', disabledName)), { code: 'ENOENT' })
        assert.deepEqual(await ownedRows(), [])

        const discovered = Promise.withResolvers(), observation = new AbortController()
        void discovered.promise.catch((_error) => {
          // File restoration awaits this observation below; contain an earlier rejection until then.
        })
        const signal = AbortSignal.any([exec.signal, observation.signal])
        const onAbort = () => discovered.reject(signal.reason)
        signal.addEventListener('abort', onAbort, { once: true })
        if (signal.aborted) onAbort()
        let checking = Promise.resolve(), settled = false
        const check = () => {
          checking = checking.then(async () => {
            if (settled || signal.aborted) return
            const skill = await ctx.skills.get(enabledName, { cwd: project, scope: exec.agent, signal })
            if (skill?.name === enabledName && skill.content === enabledBody
              && skill.path === join(root, enabledName, 'SKILL.md')) {
              settled = true; discovered.resolve(skill)
            }
          }).catch(error => { settled = true; discovered.reject(error) })
        }
        const stop = ctx.on('skills/change', check)
        const deadline = setTimeout(() => {
          observation.abort(new Error('The native registry did not discover the exact restored Skill before the deadline'))
        }, 10000)
        try {
          const disabledRestore = await gateway.restoreSkill(disabledReceipt.undoToken)
          const enabledRestore = await gateway.restoreSkill(enabledReceipt.undoToken)
          check()
          assert.equal(disabledRestore.name, disabledName)
          assert.equal(enabledRestore.name, enabledName)
          assert.equal(disabledRestore.recoveryRetained, false)
          assert.equal(enabledRestore.recoveryRetained, false)
          for (const [path, data] of contents) assert.deepEqual(await readFile(join(root, path)), data, path)
          await assert.rejects(stat(join(root, 'category', disabledName, 'SKILL.md')), { code: 'ENOENT' })
          const after = await ownedRows()
          assert.deepEqual(after, before)
          const skill = await discovered.promise
          assert.ok(skill, 'The native registry must discover the restored Skill')
          assert.equal(skill.name, enabledName)
          assert.equal(skill.content, enabledBody)
          assert.equal(skill.path, join(root, enabledName, 'SKILL.md'))
          resultText = JSON.stringify({
            restored: [enabledName, disabledName],
            originalWorkspacePreserved: true,
            nestedDisabled: { rel: disabled.rel, enabled: false },
            resourceFiles: [...contents.keys()],
            nativeSkillContent: skill.content,
          })
          return resultText
        } finally {
          settled = true; clearTimeout(deadline); stop()
          signal.removeEventListener('abort', onAbort)
          observation.abort(new Error('Skill discovery observation finished'))
          await checking
        }
      } finally {
        try { await child?.dispose() }
        finally { await rm(marker) }
      }
    },
  })))
  ctx.on('llm/stream', async function* (options, next) {
    assert.ok(options.tools.some(tool => tool.name === toolName))
    for (const message of options.messages) {
      if (message.role !== 'tool' || message.toolCallId !== callId) continue
      const text = message.content.filter(block => block.type === 'text').map(block => block.text).join('\n')
      assert.equal(text, resultText)
      assert.equal(JSON.parse(text).nativeSkillContent, enabledBody)
      visibleResult = true
    }
    yield* next()
  })
  ctx.on('agent/turn-stopping', ({ agent }) => {
    const events = agent.session.snapshotEvents()
    const results = events.filter(event => event.type === 'tool/result')
    assert.equal(results.length, 1)
    assert.equal(results[0].data.message.isError, false, JSON.stringify(results[0].data.message.content))
    assert.deepEqual(results[0].data.message.content, [{ type: 'text', text: resultText }])
    assert.equal(ran, true)
    assert.equal(visibleResult, true, 'The native restored Skill body must reach the next model request')
    assert.deepEqual(events.filter(event => event.type === 'assistant/message').at(-1).data.message.content,
      [{ type: 'text', text: 'SKILL DELETE UNDO VERIFIED' }])
  })
}
