/** Replay a real local migration and voice save against an isolated provider. */
import assert from 'node:assert/strict'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { importSnapshotModule } from '../muse-fixture-import.mjs'
import { applyLoopbackServerEffect } from '../loopback-fixture-server.mjs'

const Guidance = await importSnapshotModule(
  new URL('../../../apps/desktop-host/src/short-drama-guidance.ts', import.meta.url),
  new URL('../../../apps/desktop-host/lib/short-drama-guidance.js', import.meta.url),
)

export const name = 'project-migration-fixture'
export const inject = ['tools', 'settings', 'loader', 'systemPrompt']

const image = { assetId: 'target-shen', materialAssetId: 310706, materialType: 'image',
  materialUrl: 'https://media.example/shen.png', fileName: '沈明棠', materialKey: 'shen', sortOrder: 1 }
const audio = { materialType: 'audio', materialKey: 'voice_shen', materialUrl: 'https://media.example/shen.wav',
  materialName: '沈明棠声线', fileName: 'shen.wav', sortOrder: 1, audioDuration: 2 }
const originalModel = { modelId: 'doubao-seedance-2-5-260628', platformId: 'FANG_ZHOU',
  standardId: 61, modelGenerationTypeId: 71, videoStandardId: 337, genType: 3, genNum: 1,
  ratio: '9:16', resolution: '480p', duration: 20, prompt: '@[沈明棠](shen)坐在镜前。', materialList: [image] }
const originalBoard = { id: 2743862, scriptId: 6750, episodeId: 159430, episodeCount: 1,
  storyboardName: 'EP01-P1', isGenerate: 0, modelConfig: JSON.stringify(originalModel), storyboardMaterialList: [image] }

/** @param {import('@deepseek-ai/cordis').Context} ctx - Shipped profile owner. */
export async function apply(ctx) {
  const cwd = process.cwd(), source = join(cwd, 'source'), target = join(cwd, 'target')
  const original = await readFile(join(source, 'project_config.json'), 'utf8')
  await mkdir(target)
  await ctx.plugin(Guidance, {}).await()
  let board = structuredClone(originalBoard), baseUrl, entry, failure, requests = 0, puts = 0
  let migrated, preview, applied, observed = false
  const outcomes = []
  await applyLoopbackServerEffect(ctx, { label: 'project-migration-loopback', onCleanup() {},
    onListening(address) { baseUrl = `http://127.0.0.1:${address.port}/prod-api` },
    async requestListener(request, response) {
      try {
        assert.equal(request.headers.authorization, 'Bearer offline-project-migration-fixture')
        requests++
        const path = new URL(request.url, 'http://127.0.0.1').pathname
        let body = Buffer.alloc(0)
        for await (const chunk of request) { body = Buffer.concat([body, chunk]); assert.ok(body.length < 65536) }
        let data
        if (request.method === 'GET' && path === '/prod-api/aigc/storyboard/2743862') data = board
        else if (request.method === 'GET' && path === '/prod-api/aigc/asset/310790') {
          data = { id: 310790, scriptId: 6750, assetType: 4, assetName: '沈明棠声线', isLocal: 1,
            delFlag: '0', assetUrl: audio.materialUrl }
        } else if (request.method === 'PUT' && path === '/prod-api/aigc/storyboard') {
          const value = JSON.parse(body.toString('utf8'))
          assert.equal(++puts, 1)
          assert.equal(value.isGenerate, 0)
          assert.equal(value.scriptId, 6750)
          assert.equal(value.episodeId, 159430)
          assert.deepEqual(JSON.parse(value.modelConfig).materialList, [image, audio])
          board = value
          data = null
        } else throw new Error(`Unexpected migration provider request: ${request.method} ${path}`)
        response.writeHead(200, { 'content-type': 'application/json' })
        response.end(JSON.stringify({ code: 200, data }))
      } catch (error) {
        failure = error
        response.writeHead(500); response.end('{"code":500}')
      }
    },
  })
  ctx.effect(() => async () => {
    if (entry !== undefined) { await entry.fiber?.dispose(); ctx.loader.remove(entry.id) }
  })
  const id = await ctx.loader.create({ name: new URL('../../../packages/jubian/tool-jubian/tests/snapshot-plugin.mjs', import.meta.url).href,
    config: { baseUrl, ledgerRoot: join(cwd, '.dsh/migration-ledger'), workspaceSecrets: false, timeoutMs: 3000 } })
  entry = ctx.loader.resolve(id)
  await entry.fiber.await()
  ctx.on('tools/post-execute', async (exec, result, next) => {
    const decision = await next()
    if (!['drama_project', 'jubian_storyboard'].includes(exec.name)) return decision
    assert.equal(failure, undefined, failure?.stack)
    assert.equal(decision.kind, 'accept')
    assert.equal(await readFile(join(source, 'project_config.json'), 'utf8'), original)
    const stage = outcomes.length
    outcomes.push({ name: exec.name, method: exec.arguments.action ?? exec.arguments.method, isError: result.isError })
    if (stage === 0) {
      assert.equal(result.isError, true)
      assert.equal(requests, 0, 'The mismatched source directory is refused before provider access')
      return decision
    }
    assert.equal(result.isError, false, JSON.stringify(result.content))
    const value = JSON.parse(result.content[0].text)
    if (stage === 1) {
      preview = value
      assert.equal(value.migration.source_script_id, 6292)
      assert.equal(value.migration.target_script_id, 6750)
      await assert.rejects(readFile(join(target, 'project_config.json')), { code: 'ENOENT' })
    } else if (stage === 2) {
      migrated = JSON.parse(await readFile(join(target, 'project_config.json'), 'utf8'))
      assert.deepEqual(migrated, preview.proposed)
      assert.equal(migrated.jubian_script_id, 6750)
      assert.equal(migrated.project_bible.initial_budget_cents, 0)
      assert.equal(migrated.project_bible.revision, 1)
      assert.deepEqual(migrated.project_bible.characters, [
        { character_id: 'shen', name: '沈明棠', voice_profile: { description: '平静成年女声' } },
      ])
      for (const value of ['70001', '80001', '80002', '90001', 'old-voice', 'old-provider', 'old-result', 'source-assets']) {
        assert.ok(!JSON.stringify(migrated).includes(value), `Source-only value leaked: ${value}`)
      }
    } else if (stage === 3) {
      assert.equal(value.config.jubian_script_id, 6750)
    } else if (stage === 4) {
      assert.equal(value.status, 'ready')
      assert.deepEqual(value.audio_asset_bindings.map(item => item.asset_id), [310790])
    } else if (stage === 5) {
      applied = value
      assert.equal(value.verified_readback, true)
      assert.equal(puts, 1)
    } else if (stage === 6) {
      assert.deepEqual(value.storyboard.snapshot, board)
      assert.deepEqual(JSON.parse(board.modelConfig).materialList, [image, audio])
    } else assert.fail('Unexpected extra migration operation')
    return decision
  })
  ctx.on('llm/stream', async function* (options, next) {
    const allText = options.messages.flatMap(message => message.content.filter(block => block.type === 'text').map(block => block.text)).join('\n')
    assert.ok(allText.includes('migration_from'), 'Current migration guidance reaches the model')
    for (const message of options.messages) {
      if (message.role === 'tool' && message.toolCallId === 'call_project_migration') {
        assert.equal(message.isError, false, JSON.stringify(message.content))
        assert.ok(message.content.some(block => block.type === 'text' && block.text.includes('MIGRATION_CONFIRMED')))
        observed = true
      }
    }
    yield* next()
  })
  ctx.on('agent/turn-stopping', async () => {
    assert.equal(failure, undefined, failure?.stack)
    assert.equal(observed, true)
    assert.equal(outcomes.length, 7)
    assert.equal(puts, 1)
    assert.ok(migrated && applied)
    await writeFile(join(cwd, 'migration-proof.json'), `${JSON.stringify({
      sourceProject: 6292, targetProject: 6750, sourceBytesUnchanged: true, targetBindingReadBack: true,
      oldRemoteReferencesCopied: false, sourceMismatchProviderRequests: 0,
      audioAsset: 310790, audioVerifiedReadback: applied.verified_readback,
      freeProviderPuts: puts, paidRequests: 0, modelObservedResult: observed, outcomes,
    }, null, 2)}\n`, { flag: 'wx' })

  })
}
