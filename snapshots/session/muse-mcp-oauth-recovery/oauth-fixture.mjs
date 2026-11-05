/** OAuth recovery through the shipped Loader and isolated local HTTP transport. */
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { McpManagerGateway } from '../../../third_party/plugins/dsh-skill-mcp-panel/src/mcp/gateway.ts'
import { oauthFile } from '../../../third_party/plugins/dsh-skill-mcp-panel/src/oauth.ts'

/** Loader plugin name. */
export const name = 'snapshot-mcp-oauth-recovery'
/** The fixture contributes one model tool without contacting external providers. */
export const inject = ['tools']

/** Drive the production gateway and assert persistence and awaited shutdown.
 * @param ctx - Headless Loader context owning the tool and gateway child.
 */
export function apply(ctx) {
  let ran = false
  ctx.tools.register(defineTool({
    name: 'snapshot_oauth_recovery',
    description: 'Verify the local OAuth fixture without contacting an external server.',
    parameters: {},
    output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
    async execute() {
      assert.equal(ran, false)
      ran = true
      const home = await mkdtemp(join(tmpdir(), 'muse-keyless-oauth-'))
      const received = Promise.withResolvers()
      const release = Promise.withResolvers()
      let tokenCalls = 0, headerWrites = 0, gateway, origin
      const idp = createServer(async (request, response) => {
        const path = new URL(request.url, 'http://localhost').pathname
        response.setHeader('content-type', 'application/json')
        if (path.endsWith('/.well-known/oauth-authorization-server')) {
          response.end(JSON.stringify({ authorization_endpoint: origin + '/authorize', token_endpoint: origin + '/token' }))
        } else if (path === '/token') {
          tokenCalls++
          request.resume()
          received.resolve()
          await release.promise
          response.end(JSON.stringify({ access_token: 'fixture-token', expires_in: 3600 }))
        } else { response.writeHead(404); response.end('{}') }
      })
      let child
      try {
        await new Promise(resolve => idp.listen(0, '127.0.0.1', resolve))
        origin = 'http://127.0.0.1:' + idp.address().port
        child = ctx.plugin(scope => { gateway = new McpManagerGateway(scope) })
        await child
        gateway.dshHomeOf = () => home
        gateway.readRows = async () => ({ managed: [{ config: { serverName: 'fixture', transport: 'streamable-http', url: origin + '/mcp' } }], external: [] })
        gateway.writeAuthHeader = async () => { headerWrites++ }
        const start = await gateway.oauthStart({ serverName: 'fixture', clientId: 'fixture-client' })
        const callback = new URL(start.redirectUri)
        callback.searchParams.set('code', 'fixture-single-use-code')
        callback.searchParams.set('state', new URL(start.authUrl).searchParams.get('state'))
        await fetch(callback)
        const first = gateway.oauthPoll({ flowId: start.flowId })
        await received.promise
        const second = gateway.oauthPoll({ flowId: start.flowId })
        release.resolve()
        const answers = await Promise.all([first, second])
        assert.equal(tokenCalls, 1, 'A single-use authorization code is redeemed once')
        assert.deepEqual(answers[0], answers[1])
        assert.equal(answers[0].status, 'done')
        assert.equal(headerWrites, 1)
        assert.equal(JSON.parse(await readFile(oauthFile(home), 'utf8')).servers.fixture.accessToken, 'fixture-token')
        assert.deepEqual(await gateway.oauthPoll({ flowId: start.flowId }), answers[0])
        const pending = await gateway.oauthStart({ serverName: 'fixture', clientId: 'fixture-client' })
        const probe = new URL('/', pending.redirectUri)
        assert.equal((await fetch(probe)).status, 404)
        await child.dispose()
        await assert.rejects(fetch(probe))
        await assert.rejects(gateway.oauthStart({ serverName: 'fixture', clientId: 'fixture-client' }))
        return 'OAuth verified: one redemption, one saved header, matching poll results, and callback listener closed after unload.'
      } finally {
        release.resolve()
        await child?.dispose()
        idp.closeAllConnections()
        await new Promise(resolve => idp.close(resolve))
        await rm(home, { recursive: true, force: true })
      }
    },
  }))
  ctx.on('agent/turn-stopping', ({ agent }) => {
    const events = agent.session.snapshotEvents()
    const results = events.filter(event => event.type === 'tool/result')
    assert.equal(results.length, 1)
    assert.equal(results[0].data.message.isError, false, JSON.stringify(results[0].data.message.content))
    assert.equal(ran, true)
    assert.deepEqual(events.filter(event => event.type === 'assistant/message').at(-1).data.message.content,
      [{ type: 'text', text: 'OAUTH RECOVERY VERIFIED' }])
  })
}
