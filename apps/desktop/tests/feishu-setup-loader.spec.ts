/** Editable credentials and activation metadata through the new Muse Config/mount and real Loader. */
import { execFile } from 'node:child_process'
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { expect, it } from 'vitest'
import { feishuGateLayer, migrateFeishuProfileName } from '../../desktop-host/src/feishu-gate.ts'
import { loadOverlayPatches } from '@deepseek-ai/dsh-app-boot'

const root = fileURLToPath(new URL('../../..', import.meta.url))
const execute = promisify(execFile)

it.each([
  ['lifecycle', 'saves credentials while off, enables after restart, and retains later credential edits'],
  ['late-credentials', 'keeps an enabled bridge writable until credentials are stored and the backend restarts'],
  ['legacy', 'requires the product switch even when the bridge section stores enabled true'],
  ['expressions', 'evaluates credential expressions before deciding startup activation'],
  ['other-rows', 'leaves other entries and inherited child configs unchanged without a bridge row'],
  ['profile-shadow', 'pins native IM, includes its browser boot entry and retains remote despite an upstream profile package'],
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

it('migrates the exact legacy profile guard once with a private original-byte backup', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'muse-im-profile-name-'))
  const path = join(dir, 'cordis.patch.yml')
  const before = [
    '# Existing private settings', '- id: feishu-channel', "  name: '@wenbin_wb/dsh-bridge' # provider",
    '  disabled: false', '  config:', '    appId: cli_test',
    '    appSecret: !!js process.env.SYNTHETIC_FEISHU_SECRET', '    activeSessionId: original-session',
    '    allowFrom: [oc_group, ou_owner]', '- id: muse-desktop-bridge', "  name: '@wenbin_wb/dsh-bridge/remote'", '',
  ].join('\n')
  try {
    writeFileSync(path, before)
    const backups = await Promise.all([migrateFeishuProfileName(dir), migrateFeishuProfileName(dir)])
    const backup = backups.find(path => path !== undefined)
    expect(backup).toBeDefined()
    expect(backups.filter(path => path !== undefined)).toHaveLength(1)
    expect(readFileSync(backup!, 'utf8')).toBe(before)
    const after = readFileSync(path, 'utf8')
    expect(after).toBe(before.replace("name: '@wenbin_wb/dsh-bridge'", "name: '@xmanrui/dsh-im'"))
    if (process.platform !== 'win32') {
      expect(statSync(backup!).mode & 0o777).toBe(0o600)
      expect(statSync(path).mode & 0o777).toBe(0o600)
    }
    expect(await migrateFeishuProfileName(dir)).toBeUndefined()
    expect(readdirSync(dir).filter(name => name.endsWith('.bak'))).toHaveLength(1)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

it('migrates inserted legacy Feishu rows without touching unrelated providers or config fields', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'muse-im-profile-insert-'))
  const path = join(dir, 'cordis.patch.yml')
  const patches = [{ insert: [
    { id: 'feishu-channel', name: '@dsh-feishu/dsh-feishu', config: { enabled: false } },
    { id: 'group', group: true, config: [{ id: 'feishu-channel', name: '@wenbin_wb/dsh-bridge' }] },
    { id: 'other-id', name: '@wenbin_wb/dsh-bridge' },
    { id: 'feishu-channel', name: 'custom-feishu-provider' },
    { id: 'other', config: { id: 'feishu-channel', name: '@wenbin_wb/dsh-bridge' } },
  ] }, { id: 'feishu-channel', config: { enabled: true } }]
  try {
    writeFileSync(path, JSON.stringify(patches))
    expect(await migrateFeishuProfileName(dir)).toBeDefined()
    expect(loadOverlayPatches('test', path)).toEqual([{ insert: [
      { id: 'feishu-channel', name: '@xmanrui/dsh-im', config: { enabled: false } },
      { id: 'group', group: true, config: [{ id: 'feishu-channel', name: '@xmanrui/dsh-im' }] },
      { id: 'other-id', name: '@wenbin_wb/dsh-bridge' },
      { id: 'feishu-channel', name: 'custom-feishu-provider' },
      { id: 'other', config: { id: 'feishu-channel', name: '@wenbin_wb/dsh-bridge' } },
    ] }, { id: 'feishu-channel', config: { enabled: true } }])
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

it('leaves absent and invalid profile patches unwritten and rejects invalid YAML', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'muse-im-profile-invalid-'))
  const path = join(dir, 'cordis.patch.yml')
  try {
    expect(await migrateFeishuProfileName(dir)).toBeUndefined()
    for (const [before, message] of [
      ['- id: [unterminated\n', 'muse-med: profile patch is not valid YAML'],
      ['{"id":"feishu-channel"}\n', 'muse-med: profile patch must be a YAML sequence'],
      ['- appSecret: [private-test-credential\n', 'muse-med: profile patch is not valid YAML'],
    ] as const) {
      writeFileSync(path, before)
      await expect(migrateFeishuProfileName(dir)).rejects.toThrow(new Error(message))
      expect(readFileSync(path, 'utf8')).toBe(before)
      expect(readdirSync(dir)).toEqual(['cordis.patch.yml'])
    }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

it('reports legacy global home guards without editing shared home or project settings', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'muse-im-profile-home-'))
  const home = mkdtempSync(join(tmpdir(), 'muse-im-shared-home-'))
  const before = "- id: feishu-channel\n  name: '@wenbin_wb/dsh-bridge'\n  config: { enabled: false }\n"
  try {
    writeFileSync(join(dir, 'cordis.patch.yml'), before)
    writeFileSync(join(home, 'cordis.patch.yml'), before)
    await expect(migrateFeishuProfileName(dir, home)).rejects.toThrow(/legacy Feishu package name.*update its feishu-channel name/)
    expect(readFileSync(join(dir, 'cordis.patch.yml'), 'utf8')).toBe(before)
    expect(readFileSync(join(home, 'cordis.patch.yml'), 'utf8')).toBe(before)
    expect(readdirSync(dir)).toEqual(['cordis.patch.yml'])
    expect(readdirSync(home)).toEqual(['cordis.patch.yml'])
  } finally {
    rmSync(dir, { recursive: true, force: true })
    rmSync(home, { recursive: true, force: true })
  }
})
