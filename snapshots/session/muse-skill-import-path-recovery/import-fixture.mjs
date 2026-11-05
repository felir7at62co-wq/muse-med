/** Skill imports use the production Gateway and isolated filesystem roots. */
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { zipSync } from 'fflate'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { SkillsViewerGateway } from '../../../third_party/plugins/dsh-skill-mcp-panel/src/index.ts'
import { resolveImportTarget, validateImportPath } from '../../../third_party/plugins/dsh-skill-mcp-panel/src/skill-import.ts'

/** Loader identity for the isolated skill import conversation. */
export const name = 'snapshot-skill-import-path-recovery'
/** Services used by the production Gateway and request assertions. */
export const inject = ['tools', 'skills', 'llm', 'sessions', 'agents']

/**
 * Exercise pure path rejection and a normal resource package without external calls.
 * @param ctx - Headless Loader context owning the tool and Gateway child.
 * @returns Completion after fixture registration.
 */
export async function apply(ctx) {
  const root = await mkdtemp(join(tmpdir(), 'muse-keyless-skill-import-'))
  ctx.effect(() => () => rm(root, { recursive: true, force: true }))
  let ran = false, visibleResult = false, resultText
  ctx.tools.register(defineTool({
    name: 'snapshot_skill_import_paths',
    description: 'Verify skill import path validation and a normal resource package in isolated temporary roots.',
    parameters: {},
    output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
    async execute() {
      assert.equal(ran, false)
      ran = true
      let gateway, child
      try {
        const staging = join(root, 'pure-path-check')
        const invalidEntries = ['../outside.txt', '/absolute.txt', 'C:/absolute.txt', 'C:relative.txt', 'bundle/./file.txt']
        for (const path of invalidEntries) assert.throws(() => validateImportPath(path), /非法.*路径/)
        const invalidTargets = ['../outside.txt', '/absolute.txt', 'C:/absolute.txt', 'C:relative.txt', '.', '']
        for (const path of invalidTargets) assert.throws(() => resolveImportTarget(staging, path), /非法.*路径|超出.*暂存目录/)
        await assert.rejects(stat(staging), { code: 'ENOENT' })

        const project = join(root, 'project')
        await mkdir(join(project, '.git'), { recursive: true })
        child = ctx.plugin(scope => { gateway = new SkillsViewerGateway(scope) })
        await child
        gateway.homes = () => ({ dshHome: join(root, 'home'), agentsHome: join(root, 'agents') })
        gateway.viewFor = () => ({ registry: ctx.skills, cwd: project })
        const name = 'snapshot-portable-skill'
        const contents = new Map([
          ['SKILL.md', Buffer.from('---\nname: ' + name + '\ndescription: Snapshot resource import fixture\n---\n# Resource fixture\n')],
          ['scripts/helper.py', Buffer.from('print("fixture")\n')],
          ['.metadata/settings.json', Buffer.from('{"fixture":true}\n')],
          ['assets/sample.bin', Buffer.from([0, 255, 17])],
        ])
        const archive = zipSync(Object.fromEntries([...contents].map(([path, data]) => ['./portable-bundle/' + path, data])))
        const result = await gateway.addSkill(undefined, {
          kind: 'auto', workspace: project,
          files: [{ path: 'portable-bundle.zip', base64: Buffer.from(archive).toString('base64') }],
        })
        assert.deepEqual(result.added, [{ name, kind: 'bundle' }])
        assert.deepEqual(result.skipped, [])
        assert.deepEqual(result.warnings, [])
        assert.equal(result.scope.kind, 'workspace')
        const target = join(project, '.dsh', 'skills', name)
        for (const [path, data] of contents) assert.deepEqual(await readFile(join(target, path)), data, path)
        assert.ok(await ctx.skills.get(name, { cwd: project }), 'The native registry must discover the imported skill')
        await child.dispose()
        child = undefined
        await rm(root, { recursive: true, force: true })
        await assert.rejects(stat(root), { code: 'ENOENT' })
        resultText = JSON.stringify({
          added: result.added, skipped: result.skipped, warnings: result.warnings,
          rejectedEntryPaths: invalidEntries.length, rejectedTargets: invalidTargets.length,
          invalidPathsCreatedNoFiles: true, resourcesVerified: [...contents.keys()],
          discovered: true, temporaryRootRemoved: true,
        })
        return resultText
      } finally {
        await child?.dispose()
        await rm(root, { recursive: true, force: true })
      }
    },
  }))
  ctx.on('llm/stream', async function* (options, next) {
    assert.ok(options.tools.some(tool => tool.name === 'snapshot_skill_import_paths'))
    for (const message of options.messages) {
      if (message.role !== 'tool' || message.toolCallId !== 'call_skill_import_paths') continue
      const text = message.content.filter(block => block.type === 'text').map(block => block.text).join('\n')
      assert.equal(text, resultText)
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
    assert.equal(visibleResult, true, 'The actual import receipt must reach the next model request')
    assert.deepEqual(events.filter(event => event.type === 'assistant/message').at(-1).data.message.content,
      [{ type: 'text', text: 'SKILL IMPORT PATHS VERIFIED' }])
  })
}
