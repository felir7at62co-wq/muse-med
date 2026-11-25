/** Record the real DS Bot file tool against an offline Feishu connection. */
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { install as installIm } from '../../../third_party/plugins/ds-bot/src/host/im/index.js'
import { adapters } from '../../../third_party/plugins/ds-bot/src/host/im/platforms/index.js'
import { install as installTools } from '../../../third_party/plugins/ds-bot/src/host/tools.js'

export const inject = ['tools']

/** Mount the production tool and queue, replacing only the roster and Feishu wire. */
export async function apply(ctx) {
  const home = await mkdtemp(join(tmpdir(), 'muse-im-send-snapshot-'))
  const workspace = await realpath(process.cwd())
  const bot = { id: 'snapshot-bot', name: 'Snapshot Bot' }
  const channel = { id: 'snapshot-feishu', enabled: true, platform: 'feishu', botId: bot.id,
    account: { id: 'offline-account', name: 'Offline bot' },
    chats: { 'offline-chat': { kind: 'group', title: 'Offline Feishu', target: { botId: bot.id } } } }
  const state = { bots: { [bot.id]: bot }, rooms: {}, im: { connections: { [channel.id]: channel } } }
  let sessionId
  const runtime = {
    ctx, state, home, config: {}, teamTools: [], live: new Map(), groupOwners: new Map(), chatOwners: new Map(),
    load: async () => state,
    refresh: async () => {},
    readOnly: () => undefined,
    isBotSession: id => id !== undefined && id === sessionId,
    selfOf: id => id === sessionId ? bot.id : undefined,
    botOf: id => state.bots[id],
    roomOf: () => undefined,
    workDirOf: () => workspace,
    sessionFolder: () => workspace,
    real: realpath,
    inData: async () => false,
    onSaved() {},
    onRoomLine() {},
    onApproval() {},
    redactSecrets: value => value,
    warn: (...args) => { throw new Error(args.map(String).join(' ')) },
  }
  ctx.on('agent/created', ({ agent }) => { sessionId = agent.session.id })
  installTools(runtime)
  const imSend = runtime.teamTools.find(tool => tool.name === 'im_send')
  assert.ok(imSend)
  runtime.teamTools = [imSend]
  ctx.on('agent/created', ({ agent }) => {
    agent.ctx.effect(() => agent.ctx.tools.restrict({ allow: [] }))
  })

  const receipts = []
  const wired = Promise.withResolvers()
  const original = adapters.feishu
  ctx.effect(() => {
    adapters.feishu = {
      connect(_fields, _env, { onStatus }) {
        onStatus({ state: 'ready' })
        wired.resolve()
        return {
          fileLimit: 1024,
          async send(chat, body) {
            assert.equal(chat.key, 'offline-chat')
            receipts.push({ kind: 'text', text: body.text })
            return { messageId: 'offline-text' }
          },
          async sendFile(chat, file) {
            assert.equal(chat.key, 'offline-chat')
            assert.equal(file.name, 'delivery.txt')
            assert.equal(file.data.toString('utf8'), 'Offline Muse file delivery.\n')
            const destination = join(workspace, 'offline-wire')
            await mkdir(destination)
            await writeFile(join(destination, file.name), file.data)
            receipts.push({ kind: 'file', name: file.name, bytes: file.data.length })
            await writeFile(join(destination, 'receipts.json'), `${JSON.stringify(receipts, null, 2)}\n`)
            return { messageId: 'offline-file' }
          },
        }
      },
    }
    return async () => {
      adapters.feishu = original
      await rm(home, { recursive: true, force: true })
    }
  }, 'offline Feishu transport')
  installIm(runtime)
  await wired.promise
}
