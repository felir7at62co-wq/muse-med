/**
 * The model-facing `drama_hit_queue` tool: a transcription worker claims one
 * 红果 hit from the data station's job queue, reports progress, registers the
 * stored videos and publishes the finished screenplay, or reports failure.
 * @module @deepseek-ai/dsh-tool-hit-queue
 */
import { lstat, readFile } from 'node:fs/promises'
import { basename, extname, isAbsolute } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { credentialRef, type CredentialRef } from '@deepseek-ai/dsh-credentials'
import { HarnessError } from '@deepseek-ai/dsh-error'
import { assertNever, type JsonValue } from '@deepseek-ai/dsh-util-values'
import { defineTool } from '@deepseek-ai/dsh-tools'
import z from '@deepseek-ai/schemastery'
import { loadManifest } from './manifest.ts'
import { callStation, type Fetch, type StationSettings } from './station.ts'

export type { Fetch } from './station.ts'

/** Cordis plugin name. */
export const name = 'hit-queue'
/** Register only after the Host tool service is available. */
export const inject = ['tools']

/** Actions of `drama_hit_queue`. */
export const ACTIONS = ['claim', 'status', 'progress', 'videos', 'publish', 'fail'] as const
/** Working states a worker may report. */
export const WORK_STATES = ['downloading', 'transcribing', 'checking'] as const

const MIB = 1024 * 1024
const WORK_ID = /^(?:hongguo:)?[0-9]{1,32}$/
const SCRIPT_TYPES: Readonly<Record<string, string>> = {
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.md': 'text/markdown',
  '.txt': 'text/plain',
  '.pdf': 'application/pdf',
}

/** Deployment configuration. */
export interface Config {
  /** Credential reference for the station service token. */
  readonly tokenRef: string
  /** Service API root without a trailing slash. */
  readonly baseUrl: string
  /** Public object-store origin that manifest URLs must start with, without a trailing slash. */
  readonly manifestOrigin: string
  /** Per-request timeout in milliseconds. */
  readonly requestTimeoutMs: number
  /** Maximum station response or manifest size in bytes. */
  readonly maxResponseBytes: number
  /** Maximum screenplay file size in bytes; the station accepts at most 20 MiB. */
  readonly maxScriptBytes: number
}

/**
 * Schemastery definition. The defaults address the station on the same host
 * (`muse-data-web` listens on 127.0.0.1:19617) and the public `muse` bucket origin.
 */
export const Config = z.object({
  tokenRef: z.string().role('credential-ref').required(),
  baseUrl: z.string().default('http://127.0.0.1:19617/api/service/hits'),
  manifestOrigin: z.string().default('https://muse.tos-cn-beijing.volces.com'),
  requestTimeoutMs: z.number().step(1).min(1_000).max(300_000).default(60_000),
  maxResponseBytes: z.number().step(1).min(1_024).max(32 * MIB).default(4 * MIB),
  maxScriptBytes: z.number().step(1).min(1).max(20 * MIB).default(20 * MIB),
})

interface Resolved {
  readonly tokenRef: CredentialRef
  readonly station: StationSettings
  readonly manifestOrigin: string
  readonly maxScriptBytes: number
}

function misconfigured(message: string): TypeError {
  return new TypeError(`hit-queue: ${message}`)
}

function resolveConfig(config: Config): Resolved {
  if (!/^https?:\/\/[^/?#\s]+(?:\/[^?#\s]*[^/?#\s])?$/.test(config.baseUrl)) {
    throw misconfigured('baseUrl must be an http(s) URL without a trailing slash, query or fragment')
  }
  if (!/^https:\/\/[a-z0-9.-]+$/.test(config.manifestOrigin)) throw misconfigured('manifestOrigin must be an https origin without a path')
  return {
    tokenRef: credentialRef(config.tokenRef),
    station: { baseUrl: config.baseUrl, requestTimeoutMs: config.requestTimeoutMs, maxResponseBytes: config.maxResponseBytes },
    manifestOrigin: config.manifestOrigin,
    maxScriptBytes: config.maxScriptBytes,
  }
}

/** Replaceable network access, for tests. */
export interface Dependencies {
  readonly fetch: Fetch
}

const defaultDependencies: Dependencies = { fetch: (input, init) => fetch(input, init) }

/** Arguments after schema validation. */
interface Args {
  action: typeof ACTIONS[number]
  work_id?: string
  lease?: string
  state?: typeof WORK_STATES[number]
  episode?: number
  total_episodes?: number
  message?: string
  manifest_url?: string
  script_path?: string
  checks_passed?: boolean
  checks_summary?: string
  reason?: string
  stage?: string
  retryable?: boolean
  needs_attention?: boolean
}

function invalid(message: string): HarnessError {
  return new HarnessError(message, 'HIT_QUEUE_INVALID_REQUEST')
}

function required<T>(value: T | undefined, field: string, action: string): T {
  if (value === undefined) throw invalid(`${action} 需要 ${field}`)
  return value
}

function checkedWorkId(id: string): string {
  if (!WORK_ID.test(id)) throw invalid('work_id 必须是红果 series_id（可带 hongguo: 前缀）')
  return id
}

function workPath(args: Args): string {
  return `/jobs/${encodeURIComponent(checkedWorkId(required(args.work_id, 'work_id', args.action)))}`
}

function seriesId(workId: string): string {
  return workId.replace(/^hongguo:/, '')
}

async function scriptForm(args: Args, lease: string, maxBytes: number): Promise<FormData> {
  const path = required(args.script_path, 'script_path', 'publish')
  const type = SCRIPT_TYPES[extname(path).toLowerCase()]
  if (!isAbsolute(path) || type === undefined) throw invalid('script_path 必须是 .docx、.md、.txt 或 .pdf 的绝对路径')
  const stat = await lstat(path)
  if (!stat.isFile()) throw invalid(`script_path 必须是普通文件：${path}`)
  if (stat.size > maxBytes) throw new HarnessError(`剧本文件超过 ${maxBytes} 字节：${path}`, 'HIT_QUEUE_LIMIT')
  const form = new FormData()
  form.set('lease', lease)
  form.set('file', new Blob([await readFile(path)], { type }), basename(path))
  form.set('checks', JSON.stringify({ passed: required(args.checks_passed, 'checks_passed', 'publish'), summary: args.checks_summary ?? '' }))
  return form
}

/**
 * Register `drama_hit_queue`.
 * @param ctx - Host context with the tool registry; the credential store is read at call time.
 * @param config - Deployment configuration.
 * @param dependencies - Network access; tests replace it.
 */
export function apply(ctx: Context, config: Config, dependencies: Dependencies = defaultDependencies): void {
  const resolved = resolveConfig(config)

  async function token(): Promise<string> {
    const credentials = ctx.get('credentials')
    const value = credentials === undefined ? undefined : await credentials.resolve(resolved.tokenRef)
    if (value === undefined) throw new HarnessError('数据站服务令牌未配置，请在部署的凭据中设置', 'HIT_QUEUE_UNCONFIGURED')
    return value.value
  }

  async function run(args: Args, workerId: string | undefined, signal: AbortSignal): Promise<{ action: Args['action']; result: JsonValue }> {
    const call = async (method: 'GET' | 'POST' | 'PUT', path: string, body?: { json?: unknown; form?: FormData }) =>
      callStation(dependencies.fetch, resolved.station, await token(), { method, path, ...body }, signal)
    switch (args.action) {
      case 'claim': {
        if (workerId === undefined) throw invalid('claim 只能在会话中调用')
        const work = args.work_id === undefined ? {} : { workId: seriesId(checkedWorkId(args.work_id)) }
        return { action: 'claim', result: await call('POST', '/claim', { json: { workerId, ...work } }) }
      }
      case 'status':
        return { action: 'status', result: await call('GET', workPath(args)) }
      case 'progress': {
        const path = `${workPath(args)}/progress`
        const json = {
          lease: required(args.lease, 'lease', 'progress'),
          ...(args.state === undefined ? {} : { state: args.state }),
          ...(args.episode === undefined ? {} : { episode: args.episode }),
          ...(args.total_episodes === undefined ? {} : { totalEpisodes: args.total_episodes }),
          ...(args.message === undefined ? {} : { message: args.message }),
        }
        return { action: 'progress', result: await call('POST', path, { json }) }
      }
      case 'videos': {
        const path = `${workPath(args)}/videos`
        const lease = required(args.lease, 'lease', 'videos')
        const manifest = await loadManifest(dependencies.fetch, required(args.manifest_url, 'manifest_url', 'videos'),
          resolved.manifestOrigin, resolved.station.maxResponseBytes, signal)
        if (manifest.workId !== seriesId(required(args.work_id, 'work_id', 'videos'))) {
          throw invalid(`上传清单属于作品 ${manifest.workId}，与 work_id 不一致`)
        }
        return { action: 'videos', result: await call('PUT', path, { json: { lease, upload: manifest.upload } }) }
      }
      case 'publish': {
        const path = `${workPath(args)}/script`
        const form = await scriptForm(args, required(args.lease, 'lease', 'publish'), resolved.maxScriptBytes)
        return { action: 'publish', result: await call('POST', path, { form }) }
      }
      case 'fail': {
        const path = `${workPath(args)}/fail`
        const json = {
          lease: required(args.lease, 'lease', 'fail'),
          reason: required(args.reason, 'reason', 'fail'),
          ...(args.stage === undefined ? {} : { stage: args.stage }),
          ...(args.retryable === undefined ? {} : { retryable: args.retryable }),
          ...(args.needs_attention === undefined ? {} : { needsAttention: args.needs_attention }),
        }
        return { action: 'fail', result: await call('POST', path, { json }) }
      }
      /* v8 ignore next -- the tool schema admits only the handled actions */
      default: return assertNever(args.action)
    }
  }

  ctx.tools.register(defineTool({
    name: 'drama_hit_queue',
    description: '数据站爆款转写任务队列。claim 领取一部待转写的红果剧（不填 work_id 取队首），返回任务和租约 lease；'
      + '之后每一步都带上 work_id 和 lease。progress 上报阶段和第几集，也作心跳，至少每 30 分钟一次；'
      + 'videos 用 drama_tos_upload 返回的 manifest.url 登记原片；publish 上传通过程序检查的剧本并发布；'
      + 'fail 报告失败，检查重写后仍不过时设 needs_attention。status 查询任务。',
    parameters: {
      action: { type: 'string', enum: ACTIONS, required: true, description: '要执行的操作。' },
      work_id: { type: 'string', description: '红果剧 series_id；claim 时可不填。' },
      lease: { type: 'string', description: 'claim 返回的租约。' },
      state: { type: 'string', enum: WORK_STATES, description: 'progress：当前阶段。' },
      episode: { type: 'integer', description: 'progress：正在处理第几集。' },
      total_episodes: { type: 'integer', description: 'progress：总集数。' },
      message: { type: 'string', description: 'progress：一句话进度说明。' },
      manifest_url: { type: 'string', description: 'videos：drama_tos_upload 返回的 manifest.url。' },
      script_path: { type: 'string', description: 'publish：剧本文件的绝对路径（.docx、.md、.txt 或 .pdf）。' },
      checks_passed: { type: 'boolean', description: 'publish：程序检查是否全部通过；未通过时改用 fail。' },
      checks_summary: { type: 'string', description: 'publish：检查结果摘要，例如「65/65 集通过」。' },
      reason: { type: 'string', description: 'fail：失败原因。' },
      stage: { type: 'string', description: 'fail：失败所在阶段。' },
      retryable: { type: 'boolean', description: 'fail：能否重新排队重试，默认 true。' },
      needs_attention: { type: 'boolean', description: 'fail：直接标为待人工处理。' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: { action: { type: 'string', enum: ACTIONS, required: true }, result: { type: 'json', required: true } },
      },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
    },
    execute: async (args, exec) => run(args, exec.agent === undefined ? undefined : `muse-worker-${exec.agent.session.id}`, exec.signal),
    presentCall: args => ({ card: 'generic', title: `Hit queue: ${args.action}`, kind: args.action === 'status' ? 'read' : 'other' }),
  }))
}
