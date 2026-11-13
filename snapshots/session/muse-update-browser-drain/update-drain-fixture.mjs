/** Record a real legacy browser-poll drain while the Headless Agent keeps its task. */
import assert from 'node:assert/strict'
import { readFile, writeFile } from 'node:fs/promises'
import { createRequire, registerHooks } from 'node:module'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

const botRoot = new URL('../../../third_party/plugins/ds-bot/', import.meta.url).href
const requireDesktop = createRequire(new URL('../../../apps/desktop-host/package.json', import.meta.url))
// The packaged Bot receives these peers from Desktop; this fixture uses that same owner.
const hooks = process.env.DSH_EXAMPLE_MODE === 'lib' ? registerHooks({
  resolve(specifier, context, nextResolve) {
    if (!context.parentURL?.startsWith(botRoot) || !specifier.startsWith('@deepseek-ai/')) return nextResolve(specifier, context)
    return { url: pathToFileURL(requireDesktop.resolve(specifier)).href, shortCircuit: true }
  },
}) : undefined
let runBrowserUpdateDrainProbe
try {
  const fixture = await import('../../../third_party/plugins/ds-bot/test/update-drain-fixture.mjs')
  runBrowserUpdateDrainProbe = fixture.runBrowserUpdateDrainProbe
} finally { hooks?.deregister() }

export const name = 'snapshot-update-drain'
export const inject = ['tools', 'agents', 'jobs']

/** @param {import('@deepseek-ai/cordis').Context} ctx - Shipped Headless context. */
export function apply(ctx) {
  let completed = false
  ctx.on('tools/pre-execute', async (exec, next) => {
    if (exec.name !== 'read') return next()
    assert.equal(completed, false, 'The update-drain evidence is read once')
    assert.ok(exec.agent, 'The recorded Agent owns the evidence file')
    assert.deepEqual(exec.arguments, { file_path: 'update-drain-proof.json' })
    const proof = await runBrowserUpdateDrainProbe(ctx, { expectedActiveTasks: true })
    await writeFile(join(exec.agent.session.header.cwd, 'update-drain-proof.json'), `${JSON.stringify(proof, null, 2)}\n`)
    completed = true
    return next()
  })
  ctx.on('llm/stream', async function* (options, next) {
    if (completed) {
      const text = options.messages.filter(message => message.role === 'tool')
        .flatMap(message => message.content).filter(block => block.type === 'text').map(block => block.text).join('\n')
      assert.match(text, /"lockCompletedBeforeDeadline": true/)
      assert.match(text, /"activeTasksRetained": true/)
      assert.match(text, /"pendingHandlers": 0/)
      const cwd = ctx.agents.get(options.sessionId).session.header.cwd
      const saved = JSON.parse(await readFile(join(cwd, 'update-drain-proof.json'), 'utf8'))
      assert.equal(saved.interruptedPollCancelled, true)
      assert.equal(saved.resumedReadCompleted, true)
    }
    yield* next()
  })
}
