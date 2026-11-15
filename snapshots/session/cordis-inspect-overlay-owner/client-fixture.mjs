/** Keyless Client Slots inspection through the shipped Host query transport. */
import assert from 'node:assert/strict'
import { Context } from '@deepseek-ai/cordis'
import { SlotRegistry } from '../../../packages/client/ui-renderer/src/client/registry.ts'
import { clientInspectProviders } from '../../../packages/extensions/cordis-client-runner/src/client/providers.ts'
import { registerSilentClientTransport } from '../cordis-inspect-timeout/client-fixture.mjs'

/** Loader identity for the isolated Client inspection recording. */
export const name = 'client-inspect-overlay-owner-fixture'
/** Host inspection and Gateway services used by this recording. */
export const inject = ['cordisInspect', 'agents', 'llm', 'typertGateway']

/**
 * Mirror a real Slots provider and return its unmodified query output to the model.
 * @param {import('@deepseek-ai/cordis').Context} ctx - Snapshot Host context.
 */
export async function apply(ctx) {
  const client = new Context()
  const fiber = client.plugin(SlotRegistry)
  ctx.effect(() => () => fiber.dispose())
  await fiber
  const unregister = client.slots.registerFactory({
    name: 'snapshot.conversation-overlay',
    scope: 'session',
    children: { 'conversation.content.overlay': { kind: 'list', scope: 'session' } },
  }, () => null)
  ctx.effect(() => unregister)
  const provider = clientInspectProviders(client).find(item => item.manifest.id === 'Slots')
  assert.ok(provider)
  await registerSilentClientTransport(ctx)()
  ctx.cordisInspect.syncClientManifest([provider.manifest])
  ctx.on('cordis/inspect-query', async (request) => {
    assert.equal(request.provider, 'Slots')
    assert.equal(request.method, 'listSubTree')
    assert.deepEqual(request.input, { root: 'conversation.content.overlay' })
    const agent = ctx.agents.get(request.agentId)
    assert.ok(agent)
    const data = await provider.query(request.method, request.input, {
      signal: new AbortController().signal,
      sessionId: request.agentId,
    })
    assert.equal(ctx.cordisInspect.resolveClientQuery(agent, request.requestId, { ok: true, data }).accepted, true)
  })
  let requests = 0
  ctx.on('llm/stream', (options, next) => {
    const results = options.messages.filter(message => message.role === 'tool')
    assert.equal(results.length, requests++ === 0 ? 0 : 1)
    for (const result of results) {
      assert.equal(result.isError, false)
      assert.equal(result.toolCallId, 'inspect-overlay-owner')
      const text = result.content.filter(part => part.type === 'text').map(part => part.text).join('\n')
      const inspection = JSON.parse(text)
      assert.equal(inspection.platform, 'client')
      assert.equal(inspection.provider, 'Slots')
      assert.equal(inspection.method, 'listSubTree')
      const owner = inspection.data.selected.catalog.ownerProps.join('\n')
      assert.match(owner, /\bactiveView: string \| null/, 'The continuing model request receives the resolved View owner field')
      assert.match(owner, /Resolved registered View, or null while no View is available\./)
    }
    return next()
  })
}
