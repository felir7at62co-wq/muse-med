/** Real local Skill publication service through Native/PTC tool dispatch. */
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { importSnapshotModule } from '../muse-fixture-import.mjs'
export const name = 'market-local-lifecycle-fixture'
export const inject = ['tools', 'skills']
export const skillName = 'market-local-source'
const instructions = '---\nname: market-local-source\ndescription: Review a supplied scene.\nwhenToUse: When checking scene continuity.\ndisable-model-invocation: false\nuser-invocable: true\nmetadata:\n  owner: fixture-team\n  revision: 7\n---\nRead references/checklist.md and scripts/check.py. Keep the original scene.\n'
const resources = {
  'SKILL.md': Buffer.from(instructions),
  'references/checklist.md': Buffer.from('# Checklist\n\nKeep actions, speech and named subjects.\n'),
  'scripts/check.py': Buffer.from('def review(scene):\n    return {"scene": scene, "changed": False}\n'),
  'assets/sample.bin': Buffer.from([0, 1, 127, 128, 254, 255]),
}
const hash = value => createHash('sha256').update(value).digest('hex')
const limits = { archiveBytes: 1048576, expandedBytes: 2097152, fileCount: 32, recordBytes: 65536 }

async function filesUnder(directory, prefix = '') {
  const files = {}
  for (const entry of await readdir(join(directory, prefix), { withFileTypes: true })) {
    const path = prefix + entry.name
    if (entry.isDirectory()) Object.assign(files, await filesUnder(directory, path + '/'))
    else files[path] = hash(await readFile(join(directory, path)))
  }
  return files
}

/**
 * Mount the current service and a real private directory Skill, then observe actual results.
 * @param {import('@deepseek-ai/cordis').Context} ctx - Shipped Headless context.
 * @param {{executor:'native'|'ptc'}} config - Fixture executor.
 */
export async function apply(ctx, config) {
  const cwd = process.cwd(), root = join(cwd, '.dsh/market-local'), sourceRoot = join(cwd, '.dsh/market-source')
  const source = join(sourceRoot, skillName)
  for (const [path, bytes] of Object.entries(resources)) {
    const target = join(source, path)
    await mkdir(join(target, '..'), { recursive: true }); await writeFile(target, bytes)
  }
  const filesystem = await importSnapshotModule(new URL('../../../packages/skill/skill-filesystem/src/index.ts', import.meta.url),
    new URL('../../../packages/skill/skill-filesystem/lib/index.js', import.meta.url))
  await ctx.plugin(filesystem, { providerName: 'market-local-fixture', includeDefaultRoots: false,
    includeProjectRoots: false, customSkillDirs: [sourceRoot], watch: false }).await()
  const market = await importSnapshotModule(new URL('../../../packages/host/muse-market/src/index.ts', import.meta.url),
    new URL('../../../packages/host/muse-market/lib/index.js', import.meta.url))
  const packageModule = await importSnapshotModule(new URL('../../../packages/host/muse-market/src/package.ts', import.meta.url),
    new URL('../../../packages/host/muse-market/lib/package.js', import.meta.url))
  const { HarnessError } = await importSnapshotModule(new URL('../../../packages/llm/llm/src/index.ts', import.meta.url),
    new URL('../../../packages/llm/llm/lib/index.js', import.meta.url))
  await ctx.plugin(market.default, { root, ...limits }).await()
  let service
  await ctx.inject(['museMarket'], owner => { service = owner.museMarket }).await()
  assert.ok(service)
  let calls = 0, prepared, exported, beforeRefusal, refusalCode, preservedOnRefusal = false, retainedAfterRemoval = false
  const inner = [], outer = new Map(), seen = new Set(), starts = [], settles = []
  const methods = ['sources', 'prepare', 'exportPackage', 'importPackage', 'importPackage', 'installed', 'removePackage', 'installed']
  ctx.effect(() => ctx.tools.register({
    name: 'market_local', description: 'Call one real local Skill publication operation; removal void is encoded as JSON null.',
    parameters: { type: 'object', required: ['method'], properties: {
      method: { type: 'string', enum: ['sources', 'prepare', 'importPackage', 'installed', 'exportPackage', 'removePackage'] },
      metadata: { type: 'object' }, skillName: { type: 'string' }, base64: { type: 'string' }, id: { type: 'string' },
    }, additionalProperties: false },
    output: { schema: {}, render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }] },
    async execute(args) {
      let value
      try {
        switch (args.method) {
          case 'sources': value = await service.sources(); break
          case 'prepare': value = await service.prepare(args.metadata, args.skillName); break
          case 'importPackage': value = await service.importPackage(args.base64); break
          case 'installed': value = await service.installed(); break
          case 'exportPackage': value = await service.exportPackage(args.id); break
          case 'removePackage': value = await service.removePackage(args.id); break
          default: throw new Error('Unsupported fixture operation')
        }
      } catch (error) {
        if (error?.isDSHRemoteError !== true) throw error
        throw new HarnessError(JSON.stringify({ name: error.name, code: error.code,
          message: error.message, details: error.details }), error.code)
      }
      return value === undefined ? null : value
    },
  }))
  ctx.on('tools/post-execute', async (exec, result, next) => {
    const decision = await next()
    if (exec.name !== 'market_local') return decision
    assert.equal(decision.kind, 'accept'); assert.equal(decision.content, undefined)
    calls++
    inner.push({ isError: result.isError, content: result.content })
    assert.equal(exec.arguments.method, methods[calls - 1])
    if (calls === 4) {
      assert.equal(result.isError, true)
      const failure = JSON.parse(result.content[0].text.slice('Error: '.length))
      assert.equal(failure.name, 'RemoteError'); assert.equal(failure.code, 'muse-market/operation-failed')
      assert.equal(failure.message, 'Skill publication operation failed')
      assert.deepEqual(failure.details, { code: 'invalid-archive' })
      refusalCode = failure.details.code
      assert.deepEqual(await filesUnder(root), beforeRefusal)
      preservedOnRefusal = true
      return decision
    }
    assert.equal(result.isError, false, JSON.stringify(result.content))
    const value = JSON.parse(result.content[0].text)
    if (calls === 2) {
      prepared = value
      assert.equal(prepared.enabled, false); assert.equal(prepared.release.manifest.kind, 'skill')
      assert.equal(prepared.release.id, prepared.release.sha256)
      const bytes = await readFile(join(root, 'packages', prepared.release.id, 'publication.zip'))
      assert.equal(hash(bytes), prepared.release.sha256)
    } else if (calls === 1) {
      assert.equal(value.complete, true)
      assert.ok(value.skills.some(skill => skill.name === skillName))
    } else if (calls === 3) {
      exported = value
      const bytes = Buffer.from(value.base64, 'base64')
      assert.equal(hash(bytes), prepared.release.sha256)
      const decoded = packageModule.readMarketPackage(bytes, limits)
      assert.deepEqual(Object.keys(decoded.files).sort(), Object.keys(resources).map(path => `skills/${skillName}/${path}`).sort())
      for (const [path, original] of Object.entries(resources)) assert.deepEqual(Buffer.from(decoded.files[`skills/${skillName}/${path}`]), original)
      beforeRefusal = await filesUnder(root)
    } else if (calls === 5) {
      assert.deepEqual(value, prepared)
      const retainedResources = files => Object.fromEntries(Object.entries(files).filter(([path]) => path !== 'installations.json'))
      assert.deepEqual(retainedResources(await filesUnder(root)), retainedResources(beforeRefusal))
    } else if (calls === 6) {
      assert.deepEqual(value, [prepared]); assert.equal(value[0].enabled, false)
    } else if (calls === 7) {
      assert.equal(value, null)
      assert.equal(hash(await readFile(join(root, 'packages', prepared.release.id, 'publication.zip'))), prepared.release.sha256)
      retainedAfterRemoval = true
    } else {
      assert.equal(calls, 8); assert.deepEqual(value, [])
    }
    return decision
  })
  ctx.on('session/event', (_session, event) => {
    if (event.type === 'tool/result' && /^call_market_[1-8]$/.test(event.data.message.toolCallId)) outer.set(event.data.message.toolCallId, event.data.message)
    if (event.type === 'tool/ptc-dispatch-start' && event.data.name === 'market_local') starts.push(event.data)
    if (event.type === 'tool/ptc-dispatch' && event.data.name === 'market_local') settles.push(event.data)
  })
  ctx.on('llm/stream', async function* (options, next) {
    for (const message of options.messages) {
      if (message.role !== 'tool' || !/^call_market_[1-8]$/.test(message.toolCallId)) continue
      const logged = outer.get(message.toolCallId)
      assert.ok(logged); assert.deepEqual(message.content, logged.content)
      const index = Number(message.toolCallId.at(-1)) - 1
      if (index !== 3) {
        assert.equal(inner[index].isError, false, JSON.stringify(inner[index].content))
        assert.doesNotThrow(() => JSON.parse(message.content[0].text), message.content[0].text)
        assert.deepEqual(JSON.parse(message.content[0].text), JSON.parse(inner[index].content[0].text))
      } else if (config.executor === 'ptc') {
        const failure = JSON.parse(message.content[0].text)
        assert.equal(failure.name, 'ToolCallError'); assert.equal(failure.toolName, 'market_local')
        assert.deepEqual(JSON.parse(failure.message), JSON.parse(inner[index].content[0].text.slice('Error: '.length)))
      }
      seen.add(index)
    }
    if (seen.size === 8) {
      if (config.executor === 'ptc') {
        assert.equal(starts.length, 8); assert.equal(settles.length, 8)
        for (const [index, settled] of settles.entries()) {
          assert.equal(settled.isError, inner[index].isError)
          assert.deepEqual(settled.content, inner[index].content)
        }
        assert.equal(settles[3].isError, true)
        assert.equal(settles[3].error.code, 'muse-market/operation-failed')
      }
      for (const [path, original] of Object.entries(resources)) assert.deepEqual(await readFile(join(source, path)), original)
      await writeFile(join(cwd, 'market-local-proof.json'), JSON.stringify({
        serviceCalls: calls, fullResultsObserved: seen.size, releaseSha256: prepared.release.sha256,
        resourceSha256: Object.fromEntries(Object.entries(resources).map(([path, bytes]) => [path, hash(bytes)])),
        originalFrontmatterAndResourcesPreserved: true, archiveRoundtripSha256: hash(Buffer.from(exported.base64, 'base64')),
        duplicateImportKeptIdentityAndResources: true, installedDefaultsDisabled: true, corruptImportRefusedWithoutWrites: preservedOnRefusal,
        corruptBusinessCode: refusalCode,
        removedFromInstalled: true, archiveRetainedAfterRemoval: retainedAfterRemoval, sourceUnchanged: true,
        ptcDispatchStarts: starts.length, ptcDispatchSettles: settles.length,
      }, null, 2) + '\n', { flag: 'wx' })
    }
    yield* next()
  })
  ctx.on('agent/turn-stopping', () => { assert.equal(calls, 8); assert.equal(seen.size, calls) })
}
