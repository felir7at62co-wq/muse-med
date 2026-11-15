/** Real Skill migration receipts stay distinct from successful filesystem moves. */
import assert from 'node:assert/strict'
import { mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { importSkillPanelSnapshot } from '../muse-skill-panel-import.mjs'

const { PANEL_MANIFEST, SkillsViewerGateway } = await importSkillPanelSnapshot('index')

const conflictName = 'snapshot-conflict-skill'
const movableName = 'snapshot-movable-skill'
const secondName = 'snapshot-second-skill'
const toolName = 'snapshot_skill_migration_receipts'
const callId = 'call_skill_migration_receipts'
const bodyFor = (name, origin) => `# ${name}\nOrigin: ${origin}\nRead references/context.md before using scripts/helper.py.`
const bundleFor = (name, origin) => new Map([
  ['SKILL.md', Buffer.from(`---\nname: ${name}\ndescription: Snapshot migration ${origin} fixture\n---\n${bodyFor(name, origin)}\n`)],
  ['references/context.md', Buffer.from(`${name}: ${origin} resource\n`)],
  ['scripts/helper.py', Buffer.from(`print("${origin}")\n`)],
  ['assets/sample.bin', Buffer.from([0, 255, origin === 'source' ? 17 : 34])],
])

/** Loader identity for all-failed, mixed and successful migration receipt delivery. */
export const name = 'snapshot-skill-migration-receipts'
/** Real Gateway, tools and native Skill registry services are supplied by Headless. */
export const inject = ['tools', 'skills', 'llm', 'sessions', 'agents']

/**
 * Compare every production batch receipt with complete source and target bytes.
 * @param ctx - Headless Loader context owning the fixture tool and Gateway child.
 * @returns Completion after fixture registration.
 */
export function apply(ctx) {
  let ran = false, visibleResult = false, resultText
  ctx.effect(() => ctx.tools.register(defineTool({
    name: toolName,
    description: 'Exercise real all-failed, mixed and all-success Skill move batches, verify unchanged conflicts and complete moved files, and deliver the actual receipts and native loaded Skill body.',
    parameters: {},
    output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
    async execute(_args, exec) {
      assert.equal(ran, false)
      ran = true
      const source = join(process.cwd(), 'migration-source')
      const target = join(process.cwd(), 'migration-target')
      const fresh = join(process.cwd(), 'migration-fresh')
      const roots = [source, target, fresh]
      const skillRoot = project => join(project, '.dsh', 'skills')
      const writeBundle = async (project, name, origin) => {
        for (const [path, data] of bundleFor(name, origin)) {
          const destination = join(skillRoot(project), name, path)
          await mkdir(dirname(destination), { recursive: true })
          await writeFile(destination, data, { flag: 'wx' })
        }
      }
      const assertBundle = async (project, name, origin) => {
        for (const [path, data] of bundleFor(name, origin)) {
          assert.deepEqual(await readFile(join(skillRoot(project), name, path)), data, `${name}/${path}`)
        }
      }
      const markers = []
      let gateway, child
      try {
        for (const project of roots) {
          await mkdir(project, { recursive: true })
          const marker = join(project, '.git')
          await writeFile(marker, 'isolated migration snapshot project marker\n', { flag: 'wx' })
          markers.push(marker)
        }
        for (const name of [conflictName, movableName, secondName]) await writeBundle(source, name, 'source')
        await writeBundle(target, conflictName, 'existing target')
        child = ctx.plugin(scope => { gateway = new SkillsViewerGateway(scope) })
        await child
        gateway.homes = () => ({ dshHome: join(process.cwd(), '.dsh', 'migration-home'), agentsHome: join(process.cwd(), '.dsh', 'migration-agents') })
        gateway.viewFor = () => ({ registry: ctx.skills, cwd: source, scope: exec.agent })
        gateway.workspaces = async () => ({ workspaces: roots.map(path => ({ path, label: 'Migration fixture', sessions: 1 })) })
        const invocation = PANEL_MANIFEST.invocations.find(row => row.id === 'dsh-skill-mcp-panel#skillsViewer/batchMigrate')
        assert.ok(invocation)
        const migrate = async (names, destination) => {
          const receipt = await gateway.batchMigrate(exec.agent.id, { from: source, targets: [destination], mode: 'move', names })
          assert.doesNotThrow(() => invocation.result.create().parse(receipt))
          return receipt
        }
        const conflictError = '目标位置已存在同名技能："' + join(skillRoot(target), conflictName) + '"'
        const failedRow = { name: conflictName, target, ok: false, error: conflictError }

        const allFailed = await migrate([conflictName], target)
        assert.deepEqual(allFailed.results, [failedRow])
        await assertBundle(source, conflictName, 'source')
        await assertBundle(target, conflictName, 'existing target')

        const mixed = await migrate([conflictName, movableName], target)
        assert.deepEqual(mixed.results, [failedRow, { name: movableName, target, ok: true }])
        await assertBundle(source, conflictName, 'source')
        await assertBundle(target, conflictName, 'existing target')
        await assert.rejects(stat(join(skillRoot(source), movableName)), { code: 'ENOENT' })
        await assertBundle(target, movableName, 'source')

        const allSucceeded = await migrate([conflictName, secondName], fresh)
        assert.deepEqual(allSucceeded.results, [
          { name: conflictName, target: fresh, ok: true },
          { name: secondName, target: fresh, ok: true },
        ])
        for (const name of [conflictName, secondName]) {
          await assert.rejects(stat(join(skillRoot(source), name)), { code: 'ENOENT' })
          await assertBundle(fresh, name, 'source')
        }
        await assertBundle(target, conflictName, 'existing target')
        const skill = await ctx.skills.get(secondName, { cwd: fresh, scope: exec.agent })
        assert.ok(skill, 'The native registry must discover the successful target Skill')
        assert.equal(skill.name, secondName)
        assert.equal(skill.content, bodyFor(secondName, 'source'))
        assert.equal(skill.path, join(skillRoot(fresh), secondName, 'SKILL.md'))
        resultText = JSON.stringify({ allFailed, mixed, allSucceeded, nativeSkillContent: skill.content })
        return resultText
      } finally {
        try { await child?.dispose() }
        finally { await Promise.all(markers.map(marker => rm(marker))) }
      }
    },
  })))
  ctx.on('llm/stream', async function* (options, next) {
    assert.ok(options.tools.some(tool => tool.name === toolName))
    for (const message of options.messages) {
      if (message.role !== 'tool' || message.toolCallId !== callId) continue
      const text = message.content.filter(block => block.type === 'text').map(block => block.text).join('\n')
      assert.equal(text, resultText)
      const receipts = JSON.parse(text)
      assert.deepEqual(receipts.allFailed.results.map(row => row.ok), [false])
      assert.deepEqual(receipts.mixed.results.map(row => row.ok), [false, true])
      assert.deepEqual(receipts.allSucceeded.results.map(row => row.ok), [true, true])
      assert.equal(receipts.nativeSkillContent, bodyFor(secondName, 'source'))
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
    assert.equal(visibleResult, true, 'Actual Host receipts must reach the next model request')
    assert.deepEqual(events.filter(event => event.type === 'assistant/message').at(-1).data.message.content,
      [{ type: 'text', text: 'SKILL MIGRATION RECEIPTS VERIFIED' }])
  })
}
