/** Replay nested argument errors without weakening project policy or mutating fixture inputs. */
import assert from 'node:assert/strict'
import { apply as mountFixture, inject } from '../muse-creation-source-id-recovery/creation-preset-fixture.mjs'
export { inject }
export const name = 'snapshot-creation-preset'
/** Mount the shared readonly fixture with actual argument correction and policy denial. */
export async function apply(ctx) {
  await mountFixture(ctx, { argumentDiagnostics: true, stableBindingDiagnostics: true })
  ctx.on('llm/stream', async function* (options, next) {
    for (const result of options.messages.filter(message => message.role === 'tool' && message.isError)) {
      const text = result.content.filter(block => block.type === 'text').map(block => block.text).join('')
      assert.ok(text.includes('ToolCallError:'))
      assert.equal(text.includes('file://'), false)
      assert.equal(text.includes('node:internal'), false)
    }
    yield* next()
  })
}
