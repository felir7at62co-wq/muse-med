import { createHash } from 'node:crypto'
import { mkdtemp, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import CredentialProvider, { type ResolvedCredential } from '@deepseek-ai/dsh-credentials'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import * as NativeToolExecutor from '@deepseek-ai/dsh-tool-executor-native'
import { executeToolFixture } from '@deepseek-ai/dsh-tool-testkit'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import { afterEach, beforeEach, describe, expect, it, onTestFinished } from 'vitest'
import * as plugin from '../src/index.ts'
import type { TosSdkClient, TosSdkModule } from '../src/tos-client.ts'

const NOW = new Date('2026-11-15T02:00:00.000Z')
const DIRECTORY = 'download-video-20261115/hongguo/7470000000000000001/'

function config(overrides: Partial<plugin.Config> = {}): plugin.Config {
  return {
    accessKeyIdRef: 'VOLCENGINE_ACCESS_KEY_ID',
    secretAccessKeyRef: 'VOLCENGINE_SECRET_ACCESS_KEY',
    bucket: 'muse',
    region: 'cn-beijing',
    endpoint: 'tos-cn-beijing.volces.com',
    publicBaseUrl: 'https://muse.tos-cn-beijing.volces.com',
    keyPrefix: 'download-video-',
    timeZone: 'Asia/Shanghai',
    maxFiles: 10,
    maxFileBytes: 1_000,
    maxTotalBytes: 2_000,
    partSizeBytes: 5 * 1024 * 1024,
    taskNum: 1,
    maxRetryCount: 0,
    requestTimeoutMs: 10_000,
    connectionTimeoutMs: 1_000,
    ...overrides,
  }
}

class MapCredentials extends CredentialProvider {
  constructor(ctx: Context, private readonly values: Readonly<Record<string, string>>) { super(ctx) }
  resolve(ref: string): Promise<ResolvedCredential | undefined> {
    const value = this.values[ref]
    return Promise.resolve(value === undefined ? undefined : { value, source: 'store' })
  }
  describe() { return Promise.resolve({ configured: false, writable: false }) }
  set() { return Promise.resolve() }
  unset() { return Promise.resolve() }
  readRecord() { return Promise.resolve(undefined) }
  describeRecord() { return Promise.resolve({ configured: false, writable: false }) }
  listRecords() { return Promise.resolve([]) }
  modifyRecord() { return Promise.resolve(undefined) }
  deleteRecord() { return Promise.resolve() }
}

/** In-memory SDK that records the credentials it was built with. */
function memorySdk() {
  const objects = new Map<string, { length: number; sha256: string }>()
  const credentials: unknown[] = []
  class TosClient implements TosSdkClient {
    static readonly CancelToken = { source: () => ({ token: 'token', cancel: () => {} }) }
    constructor(options: Record<string, unknown>) { credentials.push([options.accessKeyId, options.accessKeySecret]) }
    headObject(input: { key: string }) {
      const object = objects.get(input.key)
      return object === undefined
        ? Promise.reject(Object.assign(new Error('missing'), { statusCode: 404 }))
        : Promise.resolve({ data: { 'content-length': String(object.length), 'x-tos-meta-sha256': object.sha256 } })
    }
    async uploadFile(input: Record<string, unknown>) {
      const meta = input.meta as { sha256: string }
      objects.set(String(input.key), { length: (await stat(String(input.file))).size, sha256: meta.sha256 })
      return {}
    }
    putObject(input: Record<string, unknown>) {
      objects.set(String(input.key), { length: (input.body as Buffer).byteLength, sha256: (input.meta as { sha256: string }).sha256 })
      return Promise.resolve({})
    }
  }
  const sdk: TosSdkModule = { TosClient }
  return { sdk, objects, credentials }
}

let root: string
beforeEach(async () => { root = await mkdtemp(join(tmpdir(), 'drama-tos-plugin-')) })
afterEach(async () => { await rm(root, { recursive: true, force: true }) })

async function bench(options: { credentials?: Record<string, string>; sdk?: TosSdkModule; real?: true } = {}) {
  const ctx = new Context()
  onTestFinished(async () => { await ctx.fiber.dispose() })
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(NativeToolExecutor)
  if (options.credentials !== undefined) {
    const values = options.credentials
    await ctx.plugin(class extends MapCredentials { constructor(inner: Context) { super(inner, values) } })
  }
  const sdk = options.sdk ?? memorySdk().sdk
  const fiber = options.real === true
    ? await ctx.plugin(plugin, { accessKeyIdRef: 'VOLCENGINE_ACCESS_KEY_ID', secretAccessKeyRef: 'VOLCENGINE_SECRET_ACCESS_KEY' })
    : await ctx.plugin({ name: plugin.name, inject: plugin.inject,
      apply: (inner: Context) => { plugin.apply(inner, config(), { loadSdk: () => Promise.resolve(sdk), now: () => NOW }) } })
  const call = (args: unknown) => executeToolFixture(ctx, {
    name: 'drama_tos_upload', arguments: args, callId: ToolCallId('upload-call'), signal: new AbortController().signal,
  })
  return { ctx, call, fiber }
}

const KEYS = { VOLCENGINE_ACCESS_KEY_ID: 'AKLTtest', VOLCENGINE_SECRET_ACCESS_KEY: 'secret-test' }

describe('drama_tos_upload', () => {
  it('registers the model-facing description and removes the tool when its fiber is disposed', async () => {
    const { ctx, fiber } = await bench()
    const definition = ctx.tools.get('drama_tos_upload')
    expect(definition?.description).toBe('把一部红果剧的原片和转写材料存到 TOS，位置是 download-video-<日期>/hongguo/<series_id>/<kind>/<文件名>，'
      + '文件公开可读，返回每个文件的公开地址和本次清单。远端已有同名同内容的文件记为已存在，同名不同内容的不会覆盖；不会删除远端文件。'
      + 'remove_local 为 true 时，全部文件核对成功后才删除这些本地文件。')
    expect(definition?.presentCall?.({ series_id: '1', files: [{ path: '/a.mp4', kind: 'video' }] }))
      .toEqual({ card: 'generic', title: 'Upload drama media to TOS', kind: 'other' })
    await fiber.dispose()
    expect(ctx.tools.get('drama_tos_upload')).toBeUndefined()
  })

  it('uploads through the executor with credentials from the Host store', async () => {
    const memory = memorySdk()
    const { call } = await bench({ credentials: KEYS, sdk: memory.sdk })
    const video = join(root, '001.mp4')
    await writeFile(video, 'video-1')

    const result = await call({ series_id: '7470000000000000001', title: '剧名', date: '20261115',
      files: [{ path: video, kind: 'video', name: 'ep001.mp4' }], remove_local: true })

    expect(result.isError).toBe(false)
    expect(result.value).toMatchObject({
      objects: [{ key: `${DIRECTORY}video/ep001.mp4`, status: 'uploaded', sha256: createHash('sha256').update('video-1').digest('hex') }],
      removed_local: [video],
      manifest: { key: `${DIRECTORY}manifest-20261115T020000000Z.json` },
    })
    expect(memory.credentials).toEqual([['AKLTtest', 'secret-test']])
    expect(result.content).toEqual([{ type: 'text', text: JSON.stringify(result.value) }])
  })

  it('uses the configured time zone for the default date and keeps local files unless asked', async () => {
    const { call } = await bench({ credentials: KEYS })
    const asr = join(root, '001.json')
    await writeFile(asr, '{}')
    const result = await call({ series_id: '7470000000000000001', files: [{ path: asr, kind: 'asr' }] })
    expect(result.isError).toBe(false)
    expect(result.value).toMatchObject({ date: '20261115', removed_local: [], kept_local: [{ path: asr }] })
  })

  it.each([
    ['no credential service', undefined],
    ['a missing access key id', { VOLCENGINE_SECRET_ACCESS_KEY: 'secret-test' }],
    ['a missing secret', { VOLCENGINE_ACCESS_KEY_ID: 'AKLTtest' }],
  ])('reports an unconfigured deployment with %s', async (_label, credentials) => {
    const { call } = await bench(credentials === undefined ? {} : { credentials })
    const asr = join(root, '001.json')
    await writeFile(asr, '{}')
    const result = await call({ series_id: '7470000000000000001', files: [{ path: asr, kind: 'asr' }] })
    expect(result.isError).toBe(true)
    expect(JSON.stringify(result.error)).toContain('TOS 密钥')
  })

  it('validates the request before reading credentials in the shipped plugin form', async () => {
    const { call } = await bench({ real: true })
    const result = await call({ series_id: 'abc', files: [{ path: '/tmp/x.mp4', kind: 'video' }] })
    expect(result.isError).toBe(true)
    expect(JSON.stringify(result.error)).toContain('series_id')
  })
})

describe('configuration', () => {
  it('accepts the in-region endpoint', async () => {
    const ctx = new Context()
    onTestFinished(async () => { await ctx.fiber.dispose() })
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime)
    await ctx.plugin({ name: plugin.name, inject: plugin.inject,
      apply: (inner: Context) => { plugin.apply(inner, config({ endpoint: 'tos-cn-beijing.ivolces.com' })) } })
    expect(ctx.tools.get('drama_tos_upload')).toBeDefined()
  })

  it.each([
    ['bucket', { bucket: 'Muse_Bucket' }, 'bucket'],
    ['region', { region: 'beijing' }, 'region'],
    ['endpoint', { endpoint: 'tos-cn-shanghai.volces.com' }, 'endpoint'],
    ['public origin', { publicBaseUrl: 'https://muse.tos-cn-beijing.volces.com/' }, 'publicBaseUrl'],
    ['key prefix', { keyPrefix: 'download-video' }, 'keyPrefix'],
    ['time zone', { timeZone: 'Mars/Olympus' }, 'timeZone'],
  ])('fails at load for an invalid %s', (_label, overrides, field) => {
    expect(() => { plugin.apply(new Context(), config(overrides)) }).toThrow(new RegExp(`drama-tos-upload: ${field}`))
  })
})
