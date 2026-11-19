/** Stable clock and exact workspace/session entropy inputs for this isolated subprocess. */
import crypto from 'node:crypto'
import { syncBuiltinESMExports } from 'node:module'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
export const name = 'generation-watch-entropy-fixture'
/** @param {import('@deepseek-ai/cordis').Context} ctx - Isolated snapshot subprocess. */
export async function apply(ctx) {
  ctx.effect(() => {
    const OriginalDate = Date, randomUUID = crypto.randomUUID
    class FixtureDate extends OriginalDate {
      constructor(...args) { super(...(args.length ? args : [1790682041000])) }
      static now() { return OriginalDate.now() }
    }
    globalThis.Date = FixtureDate
    crypto.randomUUID = (...args) => {
      const stack = new Error().stack ?? ''
      const caller = stack.split('\n')[2] ?? ''
      if (/[\\/]headless[\\/](?:src|lib)[\\/]index\./u.test(caller)) return '11111111-1111-4111-8111-111111111111'
      if (stack.includes('workspace-owned-storage') && stack.includes('Array.map')) return '22222222-2222-4222-8222-222222222222'
      return randomUUID(...args)
    }
    syncBuiltinESMExports()
    return () => { globalThis.Date = OriginalDate; crypto.randomUUID = randomUUID; syncBuiltinESMExports() }
  })
  const sourcePath = join(process.env.DSH_HOME, 'storages', 'workspace.json')
  const root = join(process.env.DSH_HOME, 'storages', 'watch-owned')
  const state = { schemaVersion: 1, authorityId: '33333333-3333-4333-8333-333333333333', unitVersion: 2,
    global: null, workspaces: {}, epochs: {} }
  const text = `${JSON.stringify(state, null, 2)}\n`
  await mkdir(root, { recursive: true })
  await writeFile(join(root, 'state.json'), text)
  await writeFile(join(root, 'migration.json'), JSON.stringify({ schemaVersion: 1, sourceBackend: 'json', sourcePath,
    sourceSha256: null, authorityId: state.authorityId, initialStateSha256: crypto.createHash('sha256').update(text).digest('hex') }))
  ctx.provide('snapshotWatchEntropyReady', true)
}
