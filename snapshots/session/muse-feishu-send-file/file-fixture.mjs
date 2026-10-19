/** Exercise Muse's real file tool with an offline wire; no Feishu credentials or requests. */
import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync } from 'node:fs'
import { createRequire, registerHooks } from 'node:module'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

const runtime = new URL('../../../third_party/plugins/compatibility/muse-feishu-runtime.mjs', import.meta.url)
const requireDesktop = createRequire(new URL('../../../apps/desktop-host/package.json', import.meta.url))
const dependencies = new Set(['@deepseek-ai/schemastery', '@deepseek-ai/dsh-home-paths', '@deepseek-ai/dsh-tools'])
// The compatibility module receives installed dependencies when packaged; this fixture uses the same desktop owner.
const hooks = process.env.DSH_EXAMPLE_MODE === 'lib' ? registerHooks({
  resolve(specifier, context, nextResolve) {
    if (context.parentURL !== runtime.href || !dependencies.has(specifier)) return nextResolve(specifier, context)
    return { url: pathToFileURL(requireDesktop.resolve(specifier)).href, shortCircuit: true }
  },
}) : undefined
let registerMuseSendFile
try {
  const module = await import(runtime.href)
  registerMuseSendFile = module.registerMuseSendFile
} finally {
  hooks?.deregister()
}

export const inject = ['tools']

/** Register the production tool and record the fake wire's independently inspected file bytes. */
export function apply(ctx) {
  const destination = join(process.cwd(), 'offline-wire')
  const receipts = []
  const transport = {
    async sendText(chatId, text) {
      assert.equal(chatId, 'offline-chat')
      receipts.push({ kind: 'text', chatId, text })
    },
    async sendFile(chatId, name, bytes) {
      assert.equal(chatId, 'offline-chat')
      assert.equal(name, 'delivery.txt')
      assert.equal(new TextDecoder().decode(bytes), 'Offline Muse file delivery.\n')
      mkdirSync(destination)
      writeFileSync(join(destination, name), bytes)
      receipts.push({ kind: 'file', chatId, name, bytes: bytes.length, receipt: 'offline-file-1' })
      writeFileSync(join(destination, 'receipts.json'), `${JSON.stringify(receipts, null, 2)}\n`)
    },
    async sendImage() { throw new Error('This fixture accepts only the requested text file') },
  }
  ctx.on('agent/created', ({ agent }) => {
    agent.ctx.effect(() => registerMuseSendFile(agent.ctx, {
      sessionMap: { chatFor: id => id === agent.session.id ? 'offline-chat' : undefined },
      transport,
    }, 1024))
    agent.ctx.effect(() => agent.ctx.tools.restrict({ allow: [] }))
  })
}
