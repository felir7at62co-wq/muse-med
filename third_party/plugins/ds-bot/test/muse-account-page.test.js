// Muse: the user's avatar on the Account page and in the sidebar capsule, and the Feishu rows
// beside it.
import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'
import { runInNewContext } from 'node:vm'
import { test } from 'node:test'
import { build } from 'esbuild'
import { youLook } from '../src/client/characters.js'
import { lookOf } from '../src/client/characters.js'

test('the avatar is the saved picture, else the saved character, else one picked from the name', () => {
  const picked = lookOf({ id: 'user:ylk' })
  assert.deepEqual(youLook({}, 'ylk'), picked)
  assert.deepEqual(youLook(undefined, 'ylk'), picked)
  assert.deepEqual(youLook({ you: { shape: 'moon', color: 'green' } }, 'ylk'), { shape: 'moon', color: 'green' })
  assert.equal(youLook({ you: { image: 'data:image/png;base64,AAAA' } }, 'ylk').image, 'data:image/png;base64,AAAA')
})

test('a saved character that is no longer known falls back to the picked one', () => {
  assert.deepEqual(youLook({ you: { shape: 'no-such-shape', color: 'green' } }, 'ylk'), lookOf({ id: 'user:ylk' }))
  assert.equal(youLook({ you: { shape: 'moon', color: 'nope' } }, 'ylk').color, lookOf({ id: 'user:ylk' }).color)
})

// The Account page's Feishu rows read the Muse account details as the gateway sends them:
// with a relay sign-in, identities arrive under `profile` and departments under `organization`.

const { outputFiles } = await build({
  entryPoints: [fileURLToPath(new URL('../src/client/account-page.js', import.meta.url))],
  bundle: true, format: 'cjs', platform: 'browser', write: false, logLevel: 'silent',
  external: ['react', 'react-dom', '@deepseek-ai/dsh-client-ui-primitives'],
})
const module = { exports: {} }
runInNewContext(outputFiles[0].text, { module, exports: module.exports, require: () => ({}) })
const { feishuOf } = module.exports

const department = (id, path, pathIds) => ({ id, name: path.split(' / ').at(-1), path, pathIds })

test('a relay sign-in shows the Feishu name from the profile and the synced departments', () => {
  const { feishu, departments } = feishuOf({
    protocol: 'account-data-v1', account: { id: '0123456789abcdef', username: 'ylk' },
    profile: { version: 1, account: { id: '0123456789abcdef', username: 'ylk', feishuIdentities: [{ name: '杨老师' }] } },
    organization: { status: 'available', updatedAt: null, departments: [
      department('od-1', '某某影业 / 内容中心 / 编剧组', ['0', 'od-9', 'od-1']),
      department('od-2', '某某影业 / 发行部', ['0', 'od-2']),
    ] },
  })
  assert.equal(feishu.name, '杨老师')
  assert.deepEqual([...departments], ['内容中心 / 编剧组', '发行部'])
})

test('a person directly under the enterprise keeps its name, and unavailable data gives none', () => {
  const top = feishuOf({ account: { feishuIdentities: [{ name: 'A' }] },
    organization: { status: 'available', departments: [department('0', '某某影业', ['0'])] } })
  assert.deepEqual([...top.departments], ['某某影业'])
  const none = feishuOf({ account: { feishuIdentities: [{ name: 'A' }] }, organization: { status: 'unavailable', departments: [] } })
  assert.deepEqual([...none.departments], [])
  assert.equal(feishuOf(null).feishu, undefined)
})

test('full details fall back to the identity\'s own organization record', () => {
  const { feishu, departments } = feishuOf({ account: { feishuIdentities: [{ name: 'B', organization: {
    status: 'available', departments: [department('od-3', '某某影业 / 宣传部', ['0', 'od-3'])] } }] } })
  assert.equal(feishu.name, 'B')
  assert.deepEqual([...departments], ['宣传部'])
})
