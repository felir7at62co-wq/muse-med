/** Exercise IM-only file schemas and the real Tools pipeline against the upstream artifact registry. */
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { Context } from '@deepseek-ai/cordis'
import Sessions, { SessionId } from '@deepseek-ai/dsh-session'
import Tools, { defineTool } from '@deepseek-ai/dsh-tools'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import { createScope } from '@deepseek-ai/dsh-scope'
import { installMuseImFiles } from './lib/muse-im-files.mjs'
import { OutboundArtifactRegistry, createOutboundArtifactTool, materializeOutboundArtifact, releaseOutboundArtifact } from './src/channels/shared/semantic/artifact.mjs'

const TOOL = 'dsh_im_return_file'

async function fixture(t, { maxFileBytes = 1024 } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'muse-im-files-'))
  const workspace = join(root, 'workspace')
  const outside = join(root, 'outside')
  await Promise.all([mkdir(workspace), mkdir(outside)])
  const ctx = new Context()
  await ctx.plugin(Sessions)
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(Tools)
  const registry = new OutboundArtifactRegistry()
  let agentScope
  let guiScope
  let release
  t.after(async () => {
    release?.()
    registry.clear()
    await agentScope?.dispose()
    await guiScope?.dispose()
    await ctx.fiber.dispose()
    await rm(root, { recursive: true, force: true })
  })
  let stageCalls = 0
  const stage = registry.stage.bind(registry)
  registry.stage = (...args) => { stageCalls++; return stage(...args) }
  const plugin = ctx.plugin({ inject: ['tools', 'systemPrompt'], apply(scope) {
    installMuseImFiles(scope, { registry, createTool: createOutboundArtifactTool, maxFileBytes })
  } })
  await plugin
  const makeAgent = async id => {
    const session = ctx.sessions.create(SessionId(id), { meta: { cwd: workspace } })
    const agent = { id: session.id, session, options: {}, ctx: undefined }
    let scope
    await ctx.plugin({ inject: ['tools', 'systemPrompt'], apply(inner) { scope = createScope(inner, agent) } })
    agent.ctx = scope.ctx
    return { agent, scope }
  }
  const { agent, scope } = await makeAgent('im-files-agent')
  agentScope = scope
  const guiFixture = await makeAgent('gui-agent')
  const gui = guiFixture.agent
  guiScope = guiFixture.scope
  release = registry.openConsumer(agent.session.id, 'rpc-files')
  agent.session.append('turn/start', { turn: 1 })
  await ctx.serial('agent/inbox/claimed', { agent, turn: 1, message: { source: { rpcId: 'rpc-files' } } })
  const execute = (path, signal = new AbortController().signal) => ctx.tools.execute({ agent, name: TOOL,
    arguments: { path }, callId: `call-${path}`, signal })
  return { ctx, root, workspace, outside, agent, gui, registry, plugin, execute, release, stageCalls: () => stageCalls }
}

test('only an IM-owned Agent receives the file tool and successful native execution commits exact file bytes', async t => {
  const f = await fixture(t)
  assert.ok(f.ctx.tools.schemas(f.agent).some(tool => tool.name === TOOL))
  assert.ok(!f.ctx.tools.schemas(f.gui).some(tool => tool.name === TOOL))
  assert.ok(!f.ctx.tools.schemas().some(tool => tool.name === TOOL))
  const paths = []
  f.agent.ctx.on('deliverables/validate', requested => { paths.push(...requested) })
  await writeFile(join(f.workspace, 'clip.mp4'), 'synthetic video bytes')
  const result = await f.execute('clip.mp4')
  assert.notEqual(result.isError, true, JSON.stringify(result))
  assert.equal(f.stageCalls(), 1)
  assert.equal(paths.length, 1)
  assert.match(paths[0], /clip\.mp4$/u)
  const [artifact] = f.registry.take(f.agent.session.id, 1)
  assert.ok(artifact, 'only the real tools/result observer commits the native result')
  const file = await materializeOutboundArtifact(artifact)
  assert.equal(file.bytes.toString(), 'synthetic video bytes')
  releaseOutboundArtifact(artifact)
})

test('external files, lexical traversal, physical symlink escapes, directories and oversized files never stage', async t => {
  const f = await fixture(t, { maxFileBytes: 4 })
  await writeFile(join(f.outside, 'private.txt'), 'data')
  await writeFile(join(f.workspace, 'large.txt'), '12345')
  const paths = [join(f.outside, 'private.txt'), '../outside/private.txt', '.', 'large.txt']
  try {
    await symlink(f.outside, join(f.workspace, 'escape'), process.platform === 'win32' ? 'junction' : 'dir')
    paths.push('escape/private.txt')
  } catch (error) {
    if (process.platform !== 'win32' || !['EPERM', 'EACCES'].includes(error.code)) throw error
  }
  for (const path of paths) assert.equal((await f.execute(path)).isError, true, path)
  assert.equal(f.stageCalls(), 0)
  assert.deepEqual(f.registry.take(f.agent.session.id, 1), [])
})

test('a managed-deliverable validator rejection prevents all artifact staging and delivery', async t => {
  const f = await fixture(t)
  let validations = 0
  f.agent.ctx.on('deliverables/validate', () => { validations++; throw new Error('Managed screenplay Word delivery is not approved') })
  await writeFile(join(f.workspace, '剧本.docx'), 'synthetic document')
  const result = await f.execute('剧本.docx')
  assert.equal(result.isError, true)
  assert.match(JSON.stringify(result), /not approved/u)
  assert.equal(validations, 1)
  assert.equal(f.stageCalls(), 0)
  assert.deepEqual(f.registry.take(f.agent.session.id, 1), [])
})

test('cancellation during delivery validation does not stage bytes or modify other media tools', async t => {
  const f = await fixture(t)
  const controller = new AbortController()
  f.agent.ctx.on('deliverables/validate', () => controller.abort(new DOMException('Cancelled while validating', 'AbortError')))
  await writeFile(join(f.workspace, 'clip.mp4'), 'video')
  assert.equal((await f.execute('clip.mp4', controller.signal)).isError, true)
  assert.equal(f.stageCalls(), 0)
  let probes = 0
  f.agent.ctx.tools.register(defineTool({ name: 'ffmpeg_probe', description: 'Synthetic unrelated media tool', parameters: {},
    output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
    execute: async () => { probes++; return 'probe' } }))
  const result = await f.ctx.tools.execute({ agent: f.agent, name: 'ffmpeg_probe', arguments: {}, callId: 'probe', signal: new AbortController().signal })
  assert.notEqual(result.isError, true)
  assert.equal(probes, 1)
})

test('turn completion and channel unload remove only their scoped file contribution', async t => {
  const f = await fixture(t)
  f.agent.ctx.tools.register(defineTool({ name: 'ffmpeg_probe', description: 'Synthetic unrelated media tool', parameters: {},
    output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] }, execute: async () => 'probe' }))
  f.agent.session.append('turn/end', { turn: 1, status: 'completed' })
  assert.ok(!f.ctx.tools.schemas(f.agent).some(tool => tool.name === TOOL))
  assert.ok(f.ctx.tools.schemas(f.agent).some(tool => tool.name === 'ffmpeg_probe'))
  f.registry.openConsumer(f.agent.session.id, 'rpc-second')
  f.agent.session.append('turn/start', { turn: 2 })
  await f.ctx.serial('agent/inbox/claimed', { agent: f.agent, turn: 2, message: { source: { rpcId: 'rpc-second' } } })
  assert.ok(f.ctx.tools.schemas(f.agent).some(tool => tool.name === TOOL))
  await f.plugin.dispose()
  assert.ok(!f.ctx.tools.schemas(f.agent).some(tool => tool.name === TOOL))
  assert.ok(f.ctx.tools.schemas(f.agent).some(tool => tool.name === 'ffmpeg_probe'))
})

test('a released delivery consumer cannot inspect or stage another file', async t => {
  const f = await fixture(t)
  let validations = 0
  f.agent.ctx.on('deliverables/validate', () => { validations++ })
  await writeFile(join(f.workspace, 'clip.mp4'), 'video')
  f.release()
  assert.equal((await f.execute('clip.mp4')).isError, true)
  assert.equal(validations, 0)
  assert.equal(f.stageCalls(), 0)
})
