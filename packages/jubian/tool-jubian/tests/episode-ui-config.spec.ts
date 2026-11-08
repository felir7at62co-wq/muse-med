/** Public bootstrap polling comes from the actual Host Loader row and contains no credentials. */
import { join } from 'node:path'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { IndexInjection } from '@deepseek-ai/dsh-host-webserver'
import type { PeerId, PeerScope } from '@deepseek-ai/dsh-typert-protocol'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import Tools from '@deepseek-ai/dsh-tools'
import { afterEach, expect, it, vi } from 'vitest'
import { configurationFixture } from '../../../settings/settings/tests/configuration-fixture.ts'
import { MemoryCredentials } from '../../../credentials/credentials/tests/memory.ts'
import * as Jubian from '../src/index.ts'
import { EPISODE_UI_CONFIG_GLOBAL, EpisodeUiConfig } from '../src/episode-ui-config.ts'

afterEach(() => { vi.unstubAllEnvs() })

it('projects the configured non-default interval and removes its index listener on unload', async () => {
  const f = await configurationFixture({ hmr: false, rows: [
    { id: 'prompt', name: 'cordis:prompt' }, { id: 'tools', name: 'cordis:tools' },
    { id: 'credentials', name: 'cordis:credentials' },
  ], builtins: { prompt: SystemPrompt, tools: Tools, credentials: MemoryCredentials, jubian: Jubian } })
  vi.stubEnv('DSH_HOME', f.home)
  const entry = await f.ctx.loader.create({ name: 'cordis:jubian', config: { workspaceSecrets: false,
    ledgerRoot: join(f.home, 'ledger'), episodePollIntervalMs: 100,
    characterReferenceQaAuthorizationDataRoot: join(f.home, 'private-reference'),
    characterReferenceQaAuthorizationDatabasePath: join(f.home, 'private-reference', 'authorizations.sqlite') } })
  const fiber = f.ctx.loader.resolve(entry).fiber
  if (fiber === undefined) throw new Error('Actual Loader omitted the Jubian fiber')
  await fiber.await()
  const peer: PeerScope = { id: brandString<PeerId>('episode-ui-config-peer'), ctx: f.ctx,
    principal: { kind: 'owner' }, signal: new AbortController().signal, interactions: 'none', async dispose() {} }
  const rows: IndexInjection[] = []
  f.ctx.emit('webserver/index-inject', rows, peer)
  expect(rows.filter(row => row.kind === 'global' && row.name === EPISODE_UI_CONFIG_GLOBAL))
    .toEqual([{ kind: 'global', name: EPISODE_UI_CONFIG_GLOBAL, value: { episodePollIntervalMs: 100 } }])
  await fiber.dispose()
  const retired: IndexInjection[] = []
  f.ctx.emit('webserver/index-inject', retired, peer)
  expect(retired.filter(row => row.kind === 'global' && row.name === EPISODE_UI_CONFIG_GLOBAL)).toEqual([])
})

it('resolves the public default and rejects invalid bootstrap or deployment values', () => {
  expect(EpisodeUiConfig.parse({})).toEqual({ episodePollIntervalMs: 1000 })
  for (const value of [0, 99, 60001, 100.5, '100']) {
    expect(() => EpisodeUiConfig.parse({ episodePollIntervalMs: value })).toThrow()
  }
})
