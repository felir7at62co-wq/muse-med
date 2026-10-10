/** Own an isolated, default-TLS S3 transport for the selected Windows multipart upload. */
import { Agent as HTTPSAgent } from 'node:https'

/**
 * Create a same-SDK client without Expect negotiation; dispose only its acquired resources.
 * @param options - Original credential provider, identical SDK classes, HTTPS agent constructor and bounded logger. Cleanup reports receive no SDK error arguments.
 * @returns Owned client and idempotent disposal. Constructor failures retain their original error; disposal failures stop successful publication.
 */
export function createIsolatedMultipartTransport({ sourceClient, S3Client, NodeHttpHandler, Agent = HTTPSAgent,
  logger, onCleanupFailure = () => {} }) {
  const resources = []
  function acquire(resource) {
    const destroy = resource.destroy
    let destroyed = false
    resource.destroy = function (...args) {
      if (destroyed) return
      destroyed = true
      return Reflect.apply(destroy, this, args)
    }
    resources.unshift(resource)
    return resource
  }
  function dispose() {
    let failed = false
    for (const resource of resources) {
      try { resource.destroy() }
      catch (_error) { failed = true /* Release every acquired resource, without exposing SDK errors. */ }
    }
    if (failed) {
      try { onCleanupFailure() }
      catch (_error) { /* A diagnostic callback does not replace the disposal failure. */ }
      throw new Error('Muse TOS: isolated transport disposal failed.')
    }
  }
  try {
    const agent = acquire(new Agent({ keepAlive: false, maxSockets: 1 }))
    const handler = acquire(new NodeHttpHandler({ httpsAgent: agent }))
    const client = acquire(new S3Client({ region: 'cn-beijing', endpoint: 'https://tos-s3-cn-beijing.volces.com',
      credentials: sourceClient.config.credentials, maxAttempts: 1, forcePathStyle: false,
      requestChecksumCalculation: 'WHEN_REQUIRED', responseChecksumValidation: 'WHEN_REQUIRED',
      expectContinueHeader: false, requestHandler: handler, logger }))
    return { client, dispose }
  } catch (error) {
    try { dispose() }
    catch (_cleanupError) { /* The constructor error remains primary after all acquired resources are released. */ }
    throw error
  }
}
