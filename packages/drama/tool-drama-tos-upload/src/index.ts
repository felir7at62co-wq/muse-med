/**
 * The model-facing `drama_tos_upload` tool: stores one work's source material
 * and scripts (a 红果 drama's videos and transcription materials, or a 番茄/七猫
 * novel and its screenplay) in a platform and date folder on Volcengine TOS.
 * @module @deepseek-ai/dsh-tool-drama-tos-upload
 */
import type { Context } from '@deepseek-ai/cordis'
import { credentialRef, type CredentialRef } from '@deepseek-ai/dsh-credentials'
import { HarnessError } from '@deepseek-ai/dsh-error'
import { defineTool } from '@deepseek-ai/dsh-tools'
import z from '@deepseek-ai/schemastery'
import { createTosUploadClient, loadTosSdk, type TosClientSettings, type TosCredentials, type TosSdkModule } from './tos-client.ts'
import { FILE_KINDS, PLATFORMS, executeUpload, resolveUpload, type FileKind, type UploadLimits, type UploadLocation, type UploadResult } from './upload.ts'

export type { FileKind, Platform, UploadRequest, UploadResult } from './upload.ts'

/** Cordis plugin name. */
export const name = 'drama-tos-upload'
/** Register only after the Host tool service is available. */
export const inject = ['tools']

/** Deployment configuration. */
export interface Config {
  /** Credential reference for the TOS access key id. */
  readonly accessKeyIdRef: string
  /** Credential reference for the TOS secret access key. */
  readonly secretAccessKeyRef: string
  /** Bucket name. */
  readonly bucket: string
  /** Region, for example `cn-beijing`. */
  readonly region: string
  /** Endpoint host for the region: `tos-<region>.volces.com`, or `tos-<region>.ivolces.com` inside the region. */
  readonly endpoint: string
  /** Public `https://` origin of the bucket, without a trailing slash. */
  readonly publicBaseUrl: string
  /** Top folder that holds the platform folders; lowercase letters, digits and `-`. */
  readonly rootFolder: string
  /** IANA time zone that decides the default folder date. */
  readonly timeZone: string
  /** Maximum number of files in one call. */
  readonly maxFiles: number
  /** Maximum size of one file in bytes. */
  readonly maxFileBytes: number
  /** Maximum total size of one call in bytes. */
  readonly maxTotalBytes: number
  /** Multipart part size in bytes. */
  readonly partSizeBytes: number
  /** Parallel part uploads per file. */
  readonly taskNum: number
  /** SDK retries per request. */
  readonly maxRetryCount: number
  /** Per-request timeout in milliseconds. */
  readonly requestTimeoutMs: number
  /** Per-request connection timeout in milliseconds. */
  readonly connectionTimeoutMs: number
}

const MIB = 1024 * 1024

/**
 * Schemastery definition. Location defaults are the deployment the owner chose
 * on 2026-11-15: the `muse` bucket in `cn-beijing` with platform and date folders below `download-video-date/`.
 */
export const Config = z.object({
  accessKeyIdRef: z.string().role('credential-ref').required(),
  secretAccessKeyRef: z.string().role('credential-ref').required(),
  bucket: z.string().default('muse'),
  region: z.string().default('cn-beijing'),
  endpoint: z.string().default('tos-cn-beijing.volces.com'),
  publicBaseUrl: z.string().default('https://muse.tos-cn-beijing.volces.com'),
  rootFolder: z.string().default('download-video-date'),
  timeZone: z.string().default('Asia/Shanghai'),
  maxFiles: z.number().step(1).min(1).max(2_000).default(400),
  maxFileBytes: z.number().step(1).min(1).max(5 * 1024 * MIB).default(1024 * MIB),
  maxTotalBytes: z.number().step(1).min(1).max(200 * 1024 * MIB).default(20 * 1024 * MIB),
  partSizeBytes: z.number().step(1).min(5 * MIB).max(1024 * MIB).default(20 * MIB),
  taskNum: z.number().step(1).min(1).max(16).default(2),
  maxRetryCount: z.number().step(1).min(0).max(10).default(2),
  requestTimeoutMs: z.number().step(1).min(1_000).max(1_800_000).default(300_000),
  connectionTimeoutMs: z.number().step(1).min(100).max(60_000).default(10_000),
})

/** Validated configuration split by consumer. */
interface ResolvedConfig {
  readonly accessKeyIdRef: CredentialRef
  readonly secretAccessKeyRef: CredentialRef
  readonly location: UploadLocation
  readonly limits: UploadLimits
  readonly client: TosClientSettings
}

function misconfigured(message: string, cause?: unknown): TypeError {
  return new TypeError(`drama-tos-upload: ${message}`, { cause })
}

/** Validate location fields that the schema cannot express; throws at plugin load. */
function resolveConfig(config: Config): ResolvedConfig {
  if (!/^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/.test(config.bucket)) throw misconfigured('bucket is not a valid TOS bucket name')
  if (!/^[a-z]{2}-[a-z0-9-]+$/.test(config.region)) throw misconfigured('region is not a TOS region such as cn-beijing')
  if (config.endpoint !== `tos-${config.region}.volces.com` && config.endpoint !== `tos-${config.region}.ivolces.com`) {
    throw misconfigured(`endpoint must be tos-${config.region}.volces.com or tos-${config.region}.ivolces.com`)
  }
  if (!/^https:\/\/[a-z0-9.-]+$/.test(config.publicBaseUrl)) throw misconfigured('publicBaseUrl must be an https origin without a path or trailing slash')
  if (!/^[a-z0-9][a-z0-9-]{0,62}$/.test(config.rootFolder)) throw misconfigured('rootFolder must use only lowercase letters, digits and -')
  try {
    new Intl.DateTimeFormat('en-CA', { timeZone: config.timeZone })
  } catch (error) {
    throw misconfigured('timeZone is not an IANA time zone', error)
  }
  return {
    accessKeyIdRef: credentialRef(config.accessKeyIdRef),
    secretAccessKeyRef: credentialRef(config.secretAccessKeyRef),
    location: { bucket: config.bucket, rootFolder: config.rootFolder, publicBaseUrl: config.publicBaseUrl, timeZone: config.timeZone },
    limits: { maxFiles: config.maxFiles, maxFileBytes: config.maxFileBytes, maxTotalBytes: config.maxTotalBytes },
    client: {
      bucket: config.bucket, region: config.region, endpoint: config.endpoint, partSizeBytes: config.partSizeBytes,
      taskNum: config.taskNum, maxRetryCount: config.maxRetryCount, requestTimeoutMs: config.requestTimeoutMs,
      connectionTimeoutMs: config.connectionTimeoutMs,
    },
  }
}

/** Replaceable SDK loading and clock, for tests. */
export interface Dependencies {
  readonly loadSdk: () => Promise<TosSdkModule>
  readonly now: () => Date
}

const defaultDependencies: Dependencies = { loadSdk: loadTosSdk, now: () => new Date() }

async function resolveCredentials(ctx: Context, config: ResolvedConfig): Promise<TosCredentials> {
  const credentials = ctx.get('credentials')
  if (credentials === undefined) throw new HarnessError('没有可用的凭据服务，无法读取 TOS 密钥', 'TOS_UPLOAD_UNCONFIGURED')
  const [accessKeyId, secretAccessKey] = await Promise.all([
    credentials.resolve(config.accessKeyIdRef),
    credentials.resolve(config.secretAccessKeyRef),
  ])
  if (accessKeyId === undefined || secretAccessKey === undefined) {
    throw new HarnessError('TOS 密钥未配置，请在部署的凭据中设置', 'TOS_UPLOAD_UNCONFIGURED')
  }
  return { accessKeyId: accessKeyId.value, secretAccessKey: secretAccessKey.value }
}

const objectSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    kind: { type: 'string', enum: FILE_KINDS, required: true },
    path: { type: 'string', required: true },
    key: { type: 'string', required: true },
    url: { type: 'string', required: true },
    bytes: { type: 'integer', required: true },
    sha256: { type: 'string', required: true },
    status: { type: 'string', enum: ['uploaded', 'already_present'], required: true },
  },
} as const

const outputSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    bucket: { type: 'string', required: true },
    date: { type: 'string', required: true },
    directory: { type: 'string', required: true },
    directory_url: { type: 'string', required: true },
    objects: { type: 'array', items: objectSchema, required: true },
    manifest: {
      type: 'object',
      additionalProperties: false,
      required: true,
      properties: { key: { type: 'string', required: true }, url: { type: 'string', required: true } },
    },
    removed_local: { type: 'array', items: { type: 'string' }, required: true },
    kept_local: {
      type: 'array',
      required: true,
      items: {
        type: 'object',
        additionalProperties: false,
        properties: { path: { type: 'string', required: true }, reason: { type: 'string', required: true } },
      },
    },
  },
} as const

/**
 * Register `drama_tos_upload`.
 * @param ctx - Host context with the tool registry; the credential store is read at call time.
 * @param config - Deployment configuration.
 * @param dependencies - SDK loading and clock; tests replace them.
 */
export function apply(ctx: Context, config: Config, dependencies: Dependencies = defaultDependencies): void {
  const resolved = resolveConfig(config)
  const { location } = resolved
  ctx.tools.register(defineTool({
    name: 'drama_tos_upload',
    description: `把一部作品的原始素材和剧本存到 TOS：红果剧的原片和转写材料，或番茄、七猫小说的原文和改成的剧本。位置是 ${location.rootFolder}/{platform}/{日期}/{work_id}/{kind}/{文件名}，`
      + '文件公开可读，返回每个文件的公开地址和本次清单。远端已有同名同内容的文件记为已存在，同名不同内容的不会覆盖；不会删除远端文件。'
      + 'remove_local 为 true 时，全部文件核对成功后才删除这些本地文件。',
    parameters: {
      platform: { type: 'string', enum: PLATFORMS, required: true, description: 'hongguo 红果短剧，fanqie 番茄小说，qimao 七猫小说。' },
      work_id: { type: 'string', required: true, description: '作品在该平台上的纯数字 ID：红果剧的 series_id，或小说的书籍 ID。' },
      title: { type: 'string', description: '作品名，写进清单。' },
      date: { type: 'string', description: `目录日期 YYYYMMDD；不填用 ${location.timeZone} 的今天。` },
      files: {
        type: 'array',
        required: true,
        description: '要上传的文件，按清单顺序。',
        items: {
          type: 'object',
          additionalProperties: false,
          properties: {
            path: { type: 'string', required: true, description: '本地文件的绝对路径。' },
            kind: { type: 'string', enum: FILE_KINDS, required: true, description: 'video 原片，novel 小说原文，asr 语音转写，ocr 字幕识别，observations 看帧记录，scripts 剧本。' },
            name: { type: 'string', description: '远端文件名，默认用本地文件名。' },
          },
        },
      },
      remove_local: { type: 'boolean', description: '全部文件核对成功后删除这些本地文件，默认 false。' },
    },
    output: {
      schema: outputSchema,
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
    },
    execute: async (args, exec): Promise<UploadResult> => {
      const files = args.files.map((file): { path: string; kind: FileKind; name?: string } => (
        { path: file.path, kind: file.kind, ...(file.name === undefined ? {} : { name: file.name }) }))
      const plan = await resolveUpload({
        platform: args.platform,
        workId: args.work_id,
        ...(args.title === undefined ? {} : { title: args.title }),
        ...(args.date === undefined ? {} : { date: args.date }),
        files,
        removeLocal: args.remove_local === true,
      }, location, resolved.limits, dependencies.now(), exec.signal)
      const credentials = await resolveCredentials(ctx, resolved)
      const client = createTosUploadClient(await dependencies.loadSdk(), resolved.client, credentials)
      return executeUpload(plan, client, location, dependencies.now(), exec.signal)
    },
    presentCall: () => ({ card: 'generic', title: 'Upload drama media to TOS', kind: 'other' }),
  }))
}
