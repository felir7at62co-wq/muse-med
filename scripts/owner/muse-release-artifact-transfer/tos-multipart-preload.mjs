/** Runner-only multipart transport using the approved original publisher's identical SDK module. */
import './tos-publisher-preload.mjs'
import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import { readFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { parseArgs } from 'node:util'
import { APPROVED_MULTIPART_SEAL_SHA256, installSealedMultipartBridge } from './tos-multipart-bridge.mjs'
import { createIsolatedMultipartTransport } from './tos-multipart-transport.mjs'

const publisher = process.env.MUSE_TOS_APPROVED_PUBLISHER
if (!publisher || resolve(process.argv[1]) !== publisher || !process.env.MUSE_TOS_APPROVED_SEAL
  || !process.env.MUSE_TOS_APPROVED_ARTIFACT_ROOT) throw new Error('Approved multipart publisher inputs are required')
const sealBytes = await readFile(process.env.MUSE_TOS_APPROVED_SEAL)
if (createHash('sha256').update(sealBytes).digest('hex') !== APPROVED_MULTIPART_SEAL_SHA256) {
  throw new Error('Multipart publication seal bytes differ from the approved original batch')
}
const seal = JSON.parse(sealBytes.toString('utf8'))
const root = resolve(process.env.MUSE_TOS_APPROVED_ARTIFACT_ROOT)
const { values } = parseArgs({ args: process.argv.slice(2), options: {
  version: { type: 'string' }, commit: { type: 'string' }, 'mac-arm64': { type: 'string' }, 'win-x64': { type: 'string' },
} })
if (values.version !== seal.version || values.commit !== seal.sourceCommit
  || values['mac-arm64'] !== join(root, 'mac-arm64') || values['win-x64'] !== join(root, 'win-x64')) {
  throw new Error('Original publisher arguments differ from the approved multipart batch')
}
const publisherRequire = createRequire(publisher)
const sdk = publisherRequire('@aws-sdk/client-s3')
const sdkRequire = createRequire(publisherRequire.resolve('@aws-sdk/client-s3/package.json'))
const { NodeHttpHandler } = sdkRequire('@smithy/node-http-handler')
installSealedMultipartBridge({ S3Client: sdk.S3Client, PutObjectCommand: sdk.PutObjectCommand,
  S3ServiceException: sdk.S3ServiceException, commands: sdk, seal,
  createMultipartTransport: options => createIsolatedMultipartTransport({ ...options, S3Client: sdk.S3Client, NodeHttpHandler }),
  selectedKeys: [`releases/${seal.version}/win-x64/muse-med-${seal.version}-win-x64.exe`],
  artifactDirectories: { 'mac-arm64': values['mac-arm64'], 'win-x64': values['win-x64'] },
  onEvent: event => process.stdout.write(`${JSON.stringify(event)}\n`) })
