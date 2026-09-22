/** Publish content-addressed BGM audio, verify public reads, then publish its catalog. */
import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { parseArgs } from 'node:util'
import { HeadObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3'
import type { HeadObjectCommandOutput } from '@aws-sdk/client-s3'
import { load } from 'js-yaml'
import { prepareBgmPublication, verifyBgmSource } from './bgm-publication.ts'
import type { BgmPublication } from './bgm-publication.ts'

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

/**
 * Read the operator's explicitly named TOS record without logging credential contents.
 * @param path - DSH-managed credential document, never a release input.
 * @returns The key pair for the S3 client only.
 */
export async function readTosCredentialRecord(path: string): Promise<{ accessKeyId: string; secretAccessKey: string }> {
  let document: unknown
  try { document = load(await readFile(path, 'utf8')) }
  catch { throw new Error('Cannot read the managed TOS credential record') }
  const entry = record(document) && document.version === 1 && record(document.records)
    ? document.records['drama-resources/tos-muse'] : undefined
  const env = record(entry) && entry.kind === 'api-key' && record(entry.env) ? entry.env : undefined
  if (typeof env?.TOS_ACCESS_KEY_ID !== 'string' || !env.TOS_ACCESS_KEY_ID.trim()
    || typeof env.TOS_SECRET_ACCESS_KEY !== 'string' || !env.TOS_SECRET_ACCESS_KEY.trim()) {
    throw new Error('Managed credential drama-resources/tos-muse is missing or invalid')
  }
  return { accessKeyId: env.TOS_ACCESS_KEY_ID, secretAccessKey: env.TOS_SECRET_ACCESS_KEY }
}

function statusOf(error: unknown): number | undefined {
  return record(error) && record(error.$metadata) && typeof error.$metadata.httpStatusCode === 'number'
    ? error.$metadata.httpStatusCode : undefined
}

async function head(client: S3Client, bucket: string, key: string): Promise<HeadObjectCommandOutput | undefined> {
  try { return await client.send(new HeadObjectCommand({ Bucket: bucket, Key: key })) }
  catch (error) {
    if (statusOf(error) === 404) return undefined
    throw new Error(`TOS HEAD failed (HTTP ${statusOf(error) ?? 'unknown'}); no write was retried`)
  }
}

function verifyExisting(value: HeadObjectCommandOutput, bytes: number, sha256: string): void {
  if (value.ContentLength !== bytes || value.Metadata?.sha256 !== sha256.slice(7)) {
    throw new Error('TOS existing object differs from the verified publication; refusing to overwrite')
  }
}

async function verifyPublic(url: string, bytes: number, sha256: string, timeoutMs: number): Promise<void> {
  const response = await fetch(url, { redirect: 'error', signal: AbortSignal.timeout(timeoutMs) })
  if (!response.ok || !response.body) throw new Error(`BGM public read failed (HTTP ${response.status})`)
  const reader = response.body.getReader()
  const hash = createHash('sha256')
  let size = 0
  try {
    for (;;) {
      const chunk = await reader.read()
      if (chunk.done) break
      size += chunk.value.byteLength
      if (size > bytes) throw new Error('BGM public size exceeds verified source')
      hash.update(chunk.value)
    }
  } finally { await reader.cancel() }
  if (size !== bytes) throw new Error('BGM public size differs from verified source')
  if (`sha256:${hash.digest('hex')}` !== sha256) throw new Error('BGM public hash differs from verified source')
}

async function put(client: S3Client, input: ConstructorParameters<typeof PutObjectCommand>[0]): Promise<void> {
  try { await client.send(new PutObjectCommand(input)) }
  catch (error) { throw new Error(`TOS PUT failed (HTTP ${statusOf(error) ?? 'unknown'}); reconcile before retrying`) }
}

/**
 * Create missing objects only; publish the catalog after every audio object passes a public hash read.
 * @param client - Explicitly configured S3 client; callers disable automatic retries.
 * @param bucket - Operator-authorized bucket.
 * @param plan - Verified sources and their public catalog.
 * @param timeoutMs - Per-public-read abort budget, in milliseconds.
 * @returns Audio upload/reuse counts and the publicly verified catalog URL.
 */
/** Counts and the publicly verified catalogue URL one publication produced. */
export interface BgmUploadResult {
  /** Content-addressed audio objects this run created. */
  uploaded: number
  /** Verified objects that already existed and were left untouched. */
  reused: number
  /** The catalogue URL whose bytes were read back from the bucket. */
  manifest_url: string
}

export async function uploadBgmPublication(
  client: S3Client,
  bucket: string,
  plan: BgmPublication,
  timeoutMs = 60_000,
): Promise<BgmUploadResult> {
  if (!plan.manifest.tracks.length) throw new Error('BGM publication is empty')
  const body = JSON.stringify(plan.manifest)
  const bytes = Buffer.byteLength(body)
  const digest = `sha256:${createHash('sha256').update(body).digest('hex')}`
  const manifestKey = 'bgm/index.json'
  const manifestUrl = new URL(`/${manifestKey}`, plan.manifest.tracks[0]!.url).href
  for (const artifact of plan.artifacts) await verifyBgmSource(artifact.source, artifact.bytes, artifact.sha256)
  const existingManifest = await head(client, bucket, manifestKey)
  if (existingManifest) verifyExisting(existingManifest, bytes, digest)
  let uploaded = 0
  let reused = 0
  for (const artifact of plan.artifacts) {
    const existing = await head(client, bucket, artifact.key)
    if (existing) {
      verifyExisting(existing, artifact.bytes, artifact.sha256)
      reused++
    } else {
      await verifyBgmSource(artifact.source, artifact.bytes, artifact.sha256)
      const stream = createReadStream(artifact.source)
      try {
        await put(client, { Bucket: bucket, Key: artifact.key, Body: stream,
          ContentLength: artifact.bytes, ContentType: artifact.contentType,
          Metadata: { sha256: artifact.sha256.slice(7) }, IfNoneMatch: '*',
          CacheControl: 'public, max-age=31536000, immutable' })
      } finally { stream.destroy() }
      uploaded++
    }
    const url = new URL(`/${artifact.key}`, manifestUrl).href
    await verifyPublic(url, artifact.bytes, artifact.sha256, timeoutMs)
  }
  if (!existingManifest) {
    await put(client, { Bucket: bucket, Key: manifestKey, Body: body, ContentLength: bytes,
      ContentType: 'application/json; charset=utf-8', Metadata: { sha256: digest.slice(7) },
      IfNoneMatch: '*', CacheControl: 'public, max-age=300' })
  }
  await verifyPublic(manifestUrl, bytes, digest, timeoutMs)
  return { uploaded, reused, manifest_url: manifestUrl }
}

async function main(): Promise<void> {
  const { values } = parseArgs({ options: {
    index: { type: 'string' }, library: { type: 'string' }, origin: { type: 'string' },
    bucket: { type: 'string' }, region: { type: 'string' }, endpoint: { type: 'string' },
    credentials: { type: 'string' }, upload: { type: 'boolean', default: false },
  } })
  if (!values.index || !values.library || !values.origin) throw new Error('Required: --index --library --origin')
  const plan = await prepareBgmPublication(values.index, values.library, values.origin)
  if (!values.upload) {
    console.log(JSON.stringify({ dry_run: true, tracks: plan.manifest.tracks.length,
      bytes: plan.artifacts.reduce((total, item) => total + item.bytes, 0) }))
    return
  }
  if (!values.bucket || !values.region || !values.endpoint) throw new Error('Upload requires --bucket --region --endpoint')
  const endpoint = new URL(values.endpoint)
  if (endpoint.protocol !== 'https:' || endpoint.username || endpoint.password || endpoint.pathname !== '/' || endpoint.search || endpoint.hash) {
    throw new Error('Upload endpoint must be an HTTPS origin')
  }
  const credentialsPath = values.credentials ?? join(process.env.DSH_HOME ?? join(homedir(), '.dsh'), '.credentials.yaml')
  const credentials = await readTosCredentialRecord(credentialsPath)
  const client = new S3Client({ endpoint: endpoint.origin, region: values.region, credentials,
    maxAttempts: 1, forcePathStyle: false, requestChecksumCalculation: 'WHEN_REQUIRED', responseChecksumValidation: 'WHEN_REQUIRED' })
  try { console.log(JSON.stringify(await uploadBgmPublication(client, values.bucket, plan))) }
  finally { client.destroy() }
}

if (process.argv[1] !== undefined && import.meta.filename === resolve(process.argv[1])) {
  main().catch(() => {
    // SDK and YAML diagnostics can contain credentials or document excerpts.
    process.stderr.write('BGM publication failed; no credentials were logged. Verify configuration, source hashes, and TOS object state before retrying.\n')
    process.exitCode = 1
  })
}
