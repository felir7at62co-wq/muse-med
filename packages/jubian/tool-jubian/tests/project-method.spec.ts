/** Project lookup validation and readback reporting of the project tool entry point. */
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { JubianClient, JubianLedger } from '@deepseek-ai/dsh-jubian'
import { projectMethod, type ProjectArgs } from '../src/project.ts'

let root: string
beforeEach(async () => { root = await mkdtemp(join(tmpdir(), 'jubian-project-method-')) })
afterEach(async () => { await rm(root, { recursive: true, force: true }) })

type Transport = NonNullable<ConstructorParameters<typeof JubianClient>[0]['fetch']>

/** Client whose GET readback of the created project can fail with an error that is not a Jubian error. */
class ReadbackClient extends JubianClient {
  constructor(private readonly readbackFailure: Error | undefined, fetch: Transport) {
    super({ credential: async () => 'PRIVATE_TEST_TOKEN', fetch })
  }

  override async request(...args: Parameters<JubianClient['request']>): ReturnType<JubianClient['request']> {
    if (args[0].method === 'GET' && this.readbackFailure !== undefined) throw this.readbackFailure
    return await super.request(...args)
  }
}

function transport(readbackBody: unknown, sent: unknown[] = []): Transport {
  return async (input, init) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
    const path = new URL(url).pathname.replace('/prod-api', '')
    const method = init?.method ?? 'GET'
    if (path === '/aigc/script' && method === 'POST') {
      const body: unknown = typeof init?.body === 'string' ? JSON.parse(init.body) : null
      sent.push(body)
      return new Response(JSON.stringify({ code: 200, data: 91 }))
    }
    if (path === '/aigc/script/91' && method === 'GET') return new Response(JSON.stringify({ code: 200, data: readbackBody }))
    throw new Error(`Unexpected request ${method} ${path}`)
  }
}

const CREATE = { method: 'create', idempotency_key: 'create-project', script_name: '项目名',
  production_type: 0, produce_type: 2, script_style: 0, episode_count: 2, storyboard_count_per_episode: 1 } satisfies ProjectArgs

describe('project tool entry point', () => {
  it('refuses a project lookup without a positive script_id before contacting the provider', async () => {
    const client = new ReadbackClient(new Error('provider must not be contacted'), transport(null))
    await expect(projectMethod(client, new JubianLedger({ root }), { method: 'get' }))
      .rejects.toMatchObject({ code: 'INVALID_ARGUMENT', detail: 'script_id must be a positive integer' })
  })

  it('refuses a project readback that answers for a different project ID', async () => {
    const client = new ReadbackClient(undefined, transport({ id: 92, scriptName: '别的项目' }))
    await expect(projectMethod(client, new JubianLedger({ root }), { method: 'get', script_id: 91 }))
      .rejects.toMatchObject({ code: 'CONTRACT_CHANGED', detail: 'Project readback returned a different ID' })
  })

  it('keeps a created project ID and reports the contract failure when readback names another project', async () => {
    const client = new ReadbackClient(undefined, transport({ id: 92, scriptName: '别的项目' }))
    const result = await projectMethod(client, new JubianLedger({ root }), CREATE)
    expect(result).toMatchObject({ script_id: 91, outcome: 'accepted', readback: { status: 'unavailable' } })
    expect(JSON.stringify(result.readback)).toContain('Project readback returned a different ID')
  })

  it('keeps a created project ID and reports a generic reason when readback fails outside the Jubian error types', async () => {
    const client = new ReadbackClient(new TypeError('socket pool exhausted'), transport(null))
    const result = await projectMethod(client, new JubianLedger({ root }), CREATE)
    expect(result).toMatchObject({ script_id: 91, outcome: 'accepted',
      readback: { status: 'unavailable', reason: 'Project readback failed' } })
  })

  it('creates a canvas project without storyboard sizing and sends only the fields the caller gave', async () => {
    const sent: unknown[] = []
    const client = new ReadbackClient(undefined, transport({ id: 91, scriptName: '画布项目' }, sent))
    const result = await projectMethod(client, new JubianLedger({ root }),
      { method: 'create', idempotency_key: 'canvas-project', script_name: '画布项目', production_type: 1, produce_type: 2 })
    expect(result).toMatchObject({ script_id: 91, outcome: 'accepted', readback: { status: 'read' } })
    expect(sent).toHaveLength(1)
    expect(sent[0]).not.toHaveProperty('scriptStyle')
    expect(sent[0]).toMatchObject({ scriptName: '画布项目', productionType: 1, produceType: 2 })
  })

  it('refuses an unsupported method value coming from model JSON', async () => {
    const args = JSON.parse('{"method":"delete","script_id":91}') as ProjectArgs
    const client = new ReadbackClient(undefined, transport(null))
    await expect(projectMethod(client, new JubianLedger({ root }), args))
      .rejects.toMatchObject({ code: 'INVALID_ARGUMENT', detail: 'Unsupported jubian_project method' })
  })
})
