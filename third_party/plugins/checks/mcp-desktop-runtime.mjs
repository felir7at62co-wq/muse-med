/** Verify built-in discovery against the panel's real wire codec without exposing connection secrets. */
import assert from 'node:assert/strict'
import childProcess from 'node:child_process'
import { test } from 'node:test'
import fsPromises, { chmod, mkdir, mkdtemp, readFile, readdir, writeFile, rm } from 'node:fs/promises'
import { EventEmitter } from 'node:events'
import { syncBuiltinESMExports } from 'node:module'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { pathToFileURL, fileURLToPath } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import SkillRegistry from '@deepseek-ai/dsh-skill'
import * as SkillFilesystem from '@deepseek-ai/dsh-skill-filesystem'
import chokidar from 'chokidar'
import { McpManagerGateway } from './lib/mcp/gateway.js'
import { mcpListResultSchema } from './lib/mcp/wire.js'
import { apply } from './lib/index.js'
import { currentVersion, fetchUpdateCheck } from './lib/version.js'

test('excludes shared agent skills from panel management and nested discovery while retaining Muse skills', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'muse-panel-skill-roots-'))
  const ctx = new Context()
  const controller = new AbortController()
  const previous = { DSH_HOME: process.env.DSH_HOME, MUSE_HOME: process.env.MUSE_HOME, DSH_AGENTS_HOME: process.env.DSH_AGENTS_HOME }
  const providers = []
  const home = join(dir, 'muse')
  const shared = join(dir, 'shared-agents')
  const body = name => `---\nname: ${name}\ndescription: ${name}\n---\n${name} body\n`
  const files = []
  // Discovery needs no live filesystem notifications; record watcher roots without opening host handles.
  const watcher = new EventEmitter()
  watcher.close = async () => {}
  const watch = t.mock.method(chokidar, 'watch', () => watcher)
  try {
    process.env.DSH_HOME = process.env.MUSE_HOME = home
    process.env.DSH_AGENTS_HOME = shared
    for (const [root, rel, name] of [
      [shared, 'hindsight-coding-agent', 'hindsight-coding-agent'],
      [shared, 'coding/nested-memory', 'nested-memory'],
      [home, 'muse-local', 'muse-local'],
      [home, 'custom/nested-creative', 'nested-creative'],
    ]) {
      const file = join(root, 'skills', rel, 'SKILL.md')
      await mkdir(join(file, '..'), { recursive: true })
      const content = body(name)
      await writeFile(file, content)
      files.push([file, content])
    }
    ctx.provide('typert', { register: () => () => {} })
    ctx.provide('skills', {
      registerProvider: factory => providers.push(factory),
      list: async () => [],
      get: async () => undefined,
    })
    ctx.provide('agents', { get: () => undefined })
    ctx.provide('sessions', { list: () => [] })
    apply(ctx)
    const gateway = ctx.get('skillsViewer')
    assert.deepEqual((await gateway.list()).skills.map(skill => skill.name).sort(), ['muse-local', 'nested-creative'])
    assert.equal(await gateway.content('hindsight-coding-agent'), null)
    assert.equal(await gateway.entryInScope('hindsight-coding-agent', 'global'), undefined)
    const migrated = await gateway.batchMigrate(undefined, {
      from: null, targets: [null], mode: 'copy', names: ['hindsight-coding-agent'],
    })
    assert.equal(migrated.results[0].ok, false)
    const provider = providers[0]({ signal: controller.signal, invalidate: () => {} })
    assert.deepEqual(watch.mock.calls[0].arguments[0], [join(home, 'skills')])
    const candidates = await provider.list()
    assert.deepEqual(candidates.map(candidate => candidate.name), ['nested-creative'])
    assert.match((await provider.get(candidates[0])).content, /nested-creative body/)
    for (const [file, content] of files) assert.equal(await readFile(file, 'utf8'), content)
  } finally {
    controller.abort()
    watch.mock.restore()
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
    await ctx.fiber.dispose()
    await rm(dir, { recursive: true, force: true })
  }
})

test('mounts the bundled panel without installing a global CLI or writing into a read-only application', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'muse-mcp-readonly-app-'))
  const ctx = new Context()
  const manifests = []
  const providers = []
  const messages = []
  const previousAppData = process.env.APPDATA
  const prefix = t.mock.method(childProcess, 'execFileSync', () => dir)
  syncBuiltinESMExports()
  try {
    if (process.platform !== 'win32') await chmod(dir, 0o500)
    else process.env.APPDATA = dir
    ctx.provide('logger', { info: message => messages.push(message) })
    ctx.provide('typert', { register: manifest => {
      manifests.push(manifest)
      return () => { manifests.splice(manifests.indexOf(manifest), 1) }
    } })
    ctx.provide('skills', { registerProvider: factory => { providers.push(factory) } })
    apply(ctx)
    assert.equal(prefix.mock.callCount(), 0, 'Host activation must not query or install a global npm command')
    assert.deepEqual(await readdir(dir), [], 'the application payload must remain unchanged')
    assert.deepEqual(messages, [], 'read-only failures must not be swallowed as successful activation')
    assert.ok(ctx.get('skillsViewer'), 'the Skills gateway remains registered')
    assert.ok(ctx.get('mcpManager'), 'the MCP gateway remains registered')
    assert.equal(manifests.length, 1)
    assert.equal(providers.length, 1)
  } finally {
    prefix.mock.restore()
    syncBuiltinESMExports()
    if (process.platform === 'win32') {
      if (previousAppData === undefined) delete process.env.APPDATA
      else process.env.APPDATA = previousAppData
    }
    await ctx.fiber.dispose()
    if (process.platform !== 'win32') await chmod(dir, 0o700)
    await rm(dir, { recursive: true, force: true })
  }
})

test('lists mounted knowledge-base tools separately from editable profile connections', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'muse-mcp-panel-'))
  const ctx = new Context()
  try {
    await writeFile(join(dir, 'cordis.patch.yml'), '[]\n')
    ctx.baseUrl = pathToFileURL(dir).href + '/'
    ctx.provide('tools', { schemas: () => [
      { name: 'mcp__muse-account__muse_account_status' },
      { name: 'mcp__muse-account__muse_kb_search' },
      { name: 'shell' },
    ] })
    const gateway = new McpManagerGateway(ctx)
    const result = mcpListResultSchema.parse(await gateway.list())
    assert.deepEqual(result.servers, [])
    assert.equal(result.externalServers.length, 1)
    const row = result.externalServers[0]
    assert.equal(row.serverName, 'muse-account')
    assert.equal(row.managed, false)
    assert.equal(row.fiberPhase, 'active')
    assert.equal(row.toolCount, 2)
    assert.equal(row.command, undefined)
    assert.deepEqual(row.envKeys, [])
  } finally {
    await ctx.fiber.dispose()
    await rm(dir, { recursive: true, force: true })
  }
})

/** Exercise saved files through the shipped panel and filesystem registry, not an empty catalog stub. */
async function skillFixture(options = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'muse-skill-import-'))
  const home = join(dir, 'muse')
  const workspace = join(dir, 'workspace')
  const previous = Object.fromEntries(['MUSE_HOME', 'DSH_HOME', 'DSH_AGENTS_HOME'].map(key => [key, process.env[key]]))
  const contexts = []
  const body = name => `---\nname: ${name}\ndescription: Synthetic retained import fixture.\n---\n${name} body\n`
  const sentinel = join(home, 'skills', 'existing-user-skill', 'SKILL.md')
  try {
    process.env.MUSE_HOME = process.env.DSH_HOME = home
    process.env.DSH_AGENTS_HOME = join(dir, 'shared-agents')
    await mkdir(join(workspace, '.git'), { recursive: true })
    await mkdir(join(sentinel, '..'), { recursive: true })
    await writeFile(sentinel, body('existing-user-skill'))
    const savedSentinel = await readFile(sentinel)
    const open = async (includeProjectRoots = true) => {
      const ctx = new Context()
      contexts.push(ctx)
      await ctx.plugin(SkillRegistry)
      await ctx.plugin(SkillFilesystem, { includeDefaultRoots: false, includeProjectRoots,
        customSkillDirs: [join(home, 'skills')], watch: true, watchUsePolling: true })
      const manifests = []
      ctx.provide('typert', { register: manifest => { manifests.push(manifest); return () => {} } })
      ctx.provide('agents', { get: id => id === 'restricted' ? { id } : undefined })
      ctx.provide('sessions', { list: () => [{ header: { cwd: workspace } }], get: () => ({ header: { cwd: workspace } }) })
      ctx.provide('agentPresets', { serviceFor: () => ({ list: async () => [], get: async () => undefined }) })
      apply(ctx)
      await ctx.skills.list({ cwd: workspace })
      const invocation = manifests[0].invocations.find(row => row.method === 'addSkill')
      return { ctx, gateway: ctx.get('skillsViewer'), decode: value => invocation.result.create().parse(value) }
    }
    const initial = await open(options.includeProjectRoots ?? true)
    const add = async (name, workspaceTarget, sessionId) => initial.decode(await initial.gateway.addSkill(sessionId, {
      kind: 'bundle', files: [{ path: `${name}/SKILL.md`, base64: Buffer.from(body(name)).toString('base64') }],
      ...(workspaceTarget ? { workspace: workspaceTarget } : {}),
    }))
    return { dir, home, workspace, sentinel, body, open, add, ...initial,
      async close() {
        try {
          for (const ctx of contexts.reverse()) await ctx.fiber.dispose()
          assert.deepEqual(await readFile(sentinel), savedSentinel, 'existing user Skill bytes survive every operation')
        } finally {
          for (const [key, value] of Object.entries(previous)) {
            if (value === undefined) delete process.env[key]
            else process.env[key] = value
          }
          await rm(dir, { recursive: true, force: true })
        }
      },
    }
  } catch (error) {
    try { for (const ctx of contexts.reverse()) await ctx.fiber.dispose() }
    finally {
      for (const [key, value] of Object.entries(previous)) {
        if (value === undefined) delete process.env[key]
        else process.env[key] = value
      }
      await rm(dir, { recursive: true, force: true })
    }
    throw error
  }
}

test('imports global and project Skills and preserves both after registry restart', async () => {
  const f = await skillFixture()
  try {
    const upstreamReceipt = { added: [{ name: 'existing-receipt', kind: 'bundle' }], skipped: [], warnings: [], scope: { kind: 'global' } }
    assert.deepEqual(f.decode(upstreamReceipt), upstreamReceipt, 'additive status fields keep upstream receipts decodable')
    assert.deepEqual(await f.add('global-import'), { added: [{ name: 'global-import', kind: 'bundle' }], skipped: [], warnings: [], scope: { kind: 'global' }, status: 'saved', discovery: 'ready' })
    const project = await f.add('project-import', f.workspace)
    assert.equal(project.status, 'saved')
    assert.equal(project.discovery, 'ready')
    await f.ctx.fiber.dispose()
    const reopened = await f.open()
    for (const name of ['global-import', 'project-import', 'existing-user-skill']) {
      assert.ok(await reopened.ctx.skills.get(name, { cwd: f.workspace }), `${name} remains available after reopening`)
    }
    assert.match(await readFile(join(f.workspace, '.dsh', 'skills', 'project-import', 'SKILL.md'), 'utf8'), /project-import body/)
  } finally { await f.close() }
})

test('retains saved project files when the configured provider does not discover that root', async () => {
  const f = await skillFixture({ includeProjectRoots: false })
  try {
    const receipt = await f.add('pending-project-import', f.workspace)
    assert.equal(receipt.status, 'saved')
    assert.equal(receipt.discovery, 'pending')
    const file = join(f.workspace, '.dsh', 'skills', 'pending-project-import', 'SKILL.md')
    assert.match(await readFile(file, 'utf8'), /pending-project-import body/)
    assert.equal(await f.ctx.skills.get('pending-project-import', { cwd: f.workspace }), undefined)
    const reopened = await f.open(true)
    assert.ok(await reopened.ctx.skills.get('pending-project-import', { cwd: f.workspace }))
  } finally { await f.close() }
})

test('preserves a saved Skill when the current conversation filters it out', async () => {
  const f = await skillFixture()
  try {
    const receipt = await f.add('other-conversation-import', undefined, 'restricted')
    assert.equal(receipt.status, 'saved')
    assert.equal(receipt.discovery, 'pending')
    assert.ok(await f.ctx.skills.get('other-conversation-import', { cwd: f.workspace }))
    assert.match(await readFile(join(f.home, 'skills', 'other-conversation-import', 'SKILL.md'), 'utf8'), /other-conversation-import body/)
  } finally { await f.close() }
})

test('reports unavailable discovery without deleting saved files and rejects invalid formats before writes', async (t) => {
  const f = await skillFixture()
  try {
    t.mock.method(f.ctx.skills, 'get', async () => { throw new Error('fixture discovery unavailable') })
    const receipt = await f.add('unavailable-import')
    assert.equal(receipt.status, 'saved')
    assert.equal(receipt.discovery, 'unavailable')
    assert.match(await readFile(join(f.home, 'skills', 'unavailable-import', 'SKILL.md'), 'utf8'), /unavailable-import body/)
    await assert.rejects(f.gateway.addSkill(undefined, { kind: 'bundle', files: [
      { path: 'invalid-format/SKILL.md', base64: Buffer.from('not a skill').toString('base64') },
    ] }), /技能格式不符合要求/)
    assert.equal((await readdir(join(f.home, 'skills'))).includes('invalid-format'), false)
  } finally { await f.close() }
})


test('rolls back only newly written batch targets after a real filesystem write failure', async (t) => {
  const f = await skillFixture()
  const originalWrite = fsPromises.writeFile
  let intercepted
  try {
    intercepted = t.mock.method(fsPromises, 'writeFile', async (path, ...args) => {
      if (String(path).endsWith('second-broken.md')) throw new Error('fixture disk write failure')
      return originalWrite(path, ...args)
    })
    syncBuiltinESMExports()
    await assert.rejects(f.gateway.addSkill(undefined, { kind: 'flat', files: [
      { path: 'first-new.md', base64: Buffer.from(f.body('first-new')).toString('base64') },
      { path: 'second-broken.md', base64: Buffer.from(f.body('second-broken')).toString('base64') },
    ] }), /写入技能文件失败（已回滚）.*fixture disk write failure/)
    const saved = await readdir(join(f.home, 'skills'))
    assert.equal(saved.includes('first-new.md'), false)
    assert.equal(saved.includes('second-broken.md'), false)
    assert.equal(saved.some(name => name.startsWith('.dsh-skill-staging-')), false)
  } finally {
    intercepted?.mock.restore()
    syncBuiltinESMExports()
    await f.close()
  }
})


test('reports the installed stable version and preserves detection of a genuinely newer release', async (t) => {
  assert.equal(currentVersion(), '2.3.5')
  let tag = 'v2.3.5'
  const calls = []
  t.mock.method(globalThis, 'fetch', async (url) => {
    calls.push(String(url))
    assert.equal(String(url), 'https://api.github.com/repos/Fishquito7/dsh-skill-mcp-panel/releases/latest')
    return new Response(JSON.stringify({ tag_name: tag }), { status: 200 })
  })
  assert.deepEqual(await fetchUpdateCheck(), { latest: '2.3.5', updateAvailable: false, rateLimited: false })
  tag = 'v2.3.6'
  assert.deepEqual(await fetchUpdateCheck(), { latest: '2.3.6', updateAvailable: true, rateLimited: false })
  tag = 'v2.1.2'
  assert.deepEqual(await fetchUpdateCheck(), { latest: '2.1.2', updateAvailable: false, rateLimited: false })
  assert.equal(calls.length, 3)
})

test('both rendered panel tabs clear a stale update notice but retain future Muse-managed updates', async () => {
  const fixture = await readFile(new URL('./test-panel-render.mjs', import.meta.url), 'utf8')
  const marker = '// ── 1. 技能页签'
  assert.ok(fixture.includes(marker))
  const harness = fixture.slice(0, fixture.indexOf(marker))
  const assertions = String.raw`
  const textOf = view => {
    const texts=[];
    const collect=node=>{if(typeof node==='string'){texts.push(node);return;}if(Array.isArray(node)){node.forEach(collect);return;}if(node&&typeof node==='object'&&node.props)collect(node.props.children);};
    collect(view.section);return texts.join(' ');
  };
  for(const tab of ['skills','mcp']){
    reset(skills,tab);
    const base=tab==='skills'?rpc:mcpFace;
    let view=await mount({...base,checkUpdateRemote:async()=>({current:'2.3.5',latest:'2.3.6',updateAvailable:true})});
    check(tab+' opens and shows a genuine future update through Muse',()=>{
      const text=textOf(view);assert(text.includes('2.3.6'),'future version absent');
      assert(text.includes('Muse'),'managed application guidance absent');
      assert(!text.includes('dsh-panel update'),'unsupported global CLI instruction visible');
    });
    view=await mount({...base,checkUpdateRemote:async()=>({current:'2.3.5',latest:'2.3.5',updateAvailable:false})});
    check(tab+' clears the previous banner after the installed version catches up',()=>assert(!textOf(view).includes('2.3.6'),'stale update remains'));
    view=await mount({...base,checkUpdateRemote:async()=>({current:'2.3.5',latest:'2.4.0',updateAvailable:true})});
    check(tab+' continues to show later releases',()=>assert(textOf(view).includes('2.4.0'),'future updates were suppressed'));
  }
  if(failures)process.exit(1);
  `
  const outcome = childProcess.spawnSync(process.execPath, ['--input-type=module', '-', fileURLToPath(new URL('./lib/client.js', import.meta.url))], {
    input: harness + assertions, encoding: 'utf8', timeout: 30000,
  })
  assert.equal(outcome.error, undefined)
  assert.equal(outcome.signal, null)
  assert.equal(outcome.status, 0, outcome.stdout + outcome.stderr)
})
