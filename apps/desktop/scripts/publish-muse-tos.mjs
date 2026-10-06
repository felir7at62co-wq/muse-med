/** Publish an exact three-target Muse release to TOS, verifying public bytes before channel promotion. */
import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3'
import { createReadStream } from 'node:fs'
import { createHash } from 'node:crypto'
import { parseArgs } from 'node:util'
import { finished } from 'node:stream/promises'
import { createMuseMirrorPlan } from './muse-release-mirror.mjs'
import { readDesktopProductConfig } from './desktop-build-version.mjs'

const { values } = parseArgs({ options: {
  version: { type: 'string' }, commit: { type: 'string' },
  'mac-arm64': { type: 'string' }, 'mac-x64': { type: 'string' }, 'win-x64': { type: 'string' },
  'dry-run': { type: 'boolean', default: false },
} })

function required(name) {
  const value = process.env[name]?.trim()
  if (!value) throw new Error(`Muse TOS: ${name} must be configured privately`)
  return value
}

async function main() {
  const product = readDesktopProductConfig()
  if (values.version !== product.version) throw new Error('Muse TOS: release version differs from the current product version')
  const plan = await createMuseMirrorPlan({ version: values.version, sourceCommit: values.commit,
    artifactDirectories: Object.fromEntries(['mac-arm64', 'mac-x64', 'win-x64'].map(target => [target, values[target]])),
    legacyRcDiscovery: product.legacyRcDiscovery })
  if (values['dry-run']) {
    console.log(JSON.stringify({ stage: 'validated', version: plan.version, sourceCommit: plan.sourceCommit,
      binaries: plan.artifacts.map(file => ({ key: file.key, sha256: file.sha256, size: file.size })), feeds: plan.metadata.map(file => file.key) }))
    return
  }
  if (required('MUSE_TOS_BUCKET') !== 'muse' || required('MUSE_TOS_REGION') !== 'cn-beijing'
    || required('MUSE_TOS_S3_ENDPOINT') !== 'https://tos-s3-cn-beijing.volces.com'
    || required('MUSE_TOS_PUBLIC_BASE_URL') !== 'https://muse.tos-cn-beijing.volces.com'
    || required('MUSE_TOS_PREFIX') !== 'releases') throw new Error('Muse TOS: upload destination differs from the sealed application feeds')
  const client = new S3Client({ region: 'cn-beijing', endpoint: 'https://tos-s3-cn-beijing.volces.com',
    credentials: { accessKeyId: required('VOLCENGINE_ACCESS_KEY_ID'), secretAccessKey: required('VOLCENGINE_SECRET_ACCESS_KEY') },
    requestChecksumCalculation: 'WHEN_REQUIRED', responseChecksumValidation: 'WHEN_REQUIRED', maxAttempts: 1 })
  const publicUrl = key => `https://muse.tos-cn-beijing.volces.com/${key}`
  async function verifyPublic(key, expected, size) {
    const response = await fetch(publicUrl(key), { signal: AbortSignal.timeout(1800000) })
    if (!response.ok || !response.body) throw new Error('Muse TOS: public release object is unavailable')
    const hash = createHash('sha256')
    let bytes = 0
    for await (const chunk of response.body) { bytes += chunk.length; hash.update(chunk) }
    if (hash.digest('hex') !== expected || size !== undefined && bytes !== size) throw new Error('Muse TOS: public object checksum or size differs from the verified build')
  }
  try {
    for (const file of plan.artifacts) {
      const stream = createReadStream(file.path)
      try {
        await client.send(new PutObjectCommand({ Bucket: 'muse', Key: file.key, Body: stream, ContentLength: file.size,
          ContentType: file.contentType, CacheControl: 'public, max-age=31536000, immutable', IfNoneMatch: '*' }),
        { abortSignal: AbortSignal.timeout(1800000) })
      } catch (error) {
        if (error.$metadata?.httpStatusCode !== 412) throw error
      } finally {
        stream.destroy()
        await finished(stream, { cleanup: true }).catch(error => {
          if (error.code !== 'ERR_STREAM_PREMATURE_CLOSE') throw error
        })
      }
      await verifyPublic(file.key, file.sha256, file.size)
      console.log(JSON.stringify({ stage: 'binary-verified', key: file.key, sha256: file.sha256, size: file.size }))
    }
    for (const file of plan.metadata) {
      await client.send(new PutObjectCommand({ Bucket: 'muse', Key: file.key, Body: file.contents,
        ContentType: file.contentType, CacheControl: 'no-cache, max-age=0, must-revalidate' }),
      { abortSignal: AbortSignal.timeout(30000) })
      await verifyPublic(file.key, file.sha256, Buffer.byteLength(file.contents))
      console.log(JSON.stringify({ stage: 'feed-verified', key: file.key, sha256: file.sha256 }))
    }
    console.log(JSON.stringify({ stage: 'published', version: plan.version, sourceCommit: plan.sourceCommit, binaries: plan.artifacts.length, feeds: plan.metadata.length }))
  } finally { client.destroy() }
}

main().catch(error => {
  console.error(JSON.stringify({ stage: 'failed', errorName: error.name, status: error.$metadata?.httpStatusCode ?? null,
    detail: error.message.startsWith('Muse ') ? error.message : 'Upload or public verification failed; reconcile objects before retrying.' }))
  process.exitCode = 1
})
