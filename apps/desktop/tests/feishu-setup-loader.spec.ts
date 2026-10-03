/** Editable Feishu credentials and startup activation through the shipped bridge and real Loader. */
import { execFile } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { expect, it } from 'vitest'
import { feishuGateLayer } from '../../desktop-host/src/feishu-gate.ts'

const root = fileURLToPath(new URL('../../..', import.meta.url))
const execute = promisify(execFile)

it.each([
  ['lifecycle', 'saves credentials while off, enables after restart, and retains later credential edits'],
  ['late-credentials', 'keeps an enabled bridge writable until credentials are stored and the backend restarts'],
  ['legacy', 'requires the product switch even when the bridge section stores enabled true'],
  ['expressions', 'evaluates credential expressions before deciding startup activation'],
  ['other-rows', 'leaves other entries and inherited child configs unchanged without a bridge row'],
])('%s: %s', async (scenario) => {
  // The source-mode launcher resolves the staged bridge's workspace dependencies through tsconfig paths.
  const result = await execute(process.execPath, ['--import', 'tsx/esm',
    'apps/desktop/tests/fixtures/feishu-setup-loader.mjs', scenario], {
    cwd: root,
    windowsHide: true,
    timeout: 25_000,
    env: Object.fromEntries(Object.entries(process.env)
      .filter(([key]) => !/KEY|SECRET|TOKEN|PASSWORD|^NODE_OPTIONS$|^NODE_PATH$/iu.test(key))),
  })
  expect(result.stdout.trim().split('\n').at(-1)).toBe(JSON.stringify({ scenario, passed: true, networkCalls: 0 }))
}, 30_000)

it('adds the setup dependency without replacing existing service intercepts or array dependencies', () => {
  expect(feishuGateLayer([{ id: 'feishu-channel', inject: ['tools'] }])).toEqual([
    { id: 'feishu-channel', inject: ['tools', 'feishuSetup'] },
  ])
  expect(feishuGateLayer([{ id: 'feishu-channel', inject: { tools: { filter: 'retained' } } }])).toEqual([
    { id: 'feishu-channel', inject: { tools: { filter: 'retained' }, feishuSetup: {} } },
  ])
  expect(feishuGateLayer([{ id: 'feishu-channel', inject: ['feishuSetup'] }])).toEqual([
    { id: 'feishu-channel', inject: ['feishuSetup'] },
  ])
  expect(feishuGateLayer([{ id: 'other-row' }])).toEqual([])
})
