import { access, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import Tools from '@deepseek-ai/dsh-tools'
import { MemoryCredentials } from '../../../credentials/credentials/tests/memory.ts'
import { configurationFixture } from '../../../settings/settings/tests/configuration-fixture.ts'
import * as Jubian from '../src/index.ts'

async function fixture() {
  return configurationFixture({
    hmr: false,
    rows: [
      { id: 'prompt', name: 'cordis:prompt' },
      { id: 'tools', name: 'cordis:tools' },
      { id: 'credentials', name: 'cordis:credentials', config: { JUBIANAI_ADMIN_TOKEN: 'fixture-token' } },
    ],
    builtins: { prompt: SystemPrompt, tools: Tools, credentials: MemoryCredentials, jubian: Jubian },
  })
}

it('awaits private QA database initialization and closes it when the loaded plugin is disposed', async () => {
  const { ctx, home } = await fixture()
  const dataRoot = await mkdtemp(join(tmpdir(), 'character-reference-qa-loader-'))
  const databasePath = join(dataRoot, 'database', 'authorization.sqlite')
  try {
    const id = await ctx.loader.create({
      name: 'cordis:jubian',
      config: {
        ledgerRoot: join(home, 'ledger'),
        workspaceSecrets: false,
        characterReferenceQaAuthorizationDataRoot: dataRoot,
        characterReferenceQaAuthorizationDatabasePath: databasePath,
      },
    })
    await ctx.loader.await()
    const entry = ctx.loader.resolve(id)
    await entry.fiber?.await()
    await access(databasePath)
    await entry.fiber?.dispose()
    await rm(dataRoot, { recursive: true })
  } finally {
    await ctx.fiber.dispose()
    await rm(dataRoot, { recursive: true, force: true })
  }
})

it('surfaces an uncontained QA database as a Loader fiber failure', async () => {
  const { ctx, home } = await fixture()
  try {
    const id = await ctx.loader.create({
      name: 'cordis:jubian',
      config: {
        ledgerRoot: join(home, 'ledger'),
        workspaceSecrets: false,
        characterReferenceQaAuthorizationDataRoot: join(home, 'trusted'),
        characterReferenceQaAuthorizationDatabasePath: join(home, 'outside.sqlite'),
      },
    })
    await ctx.loader.await()
    await expect(ctx.loader.resolve(id).fiber?.await()).rejects.toThrow(
      'database path must be inside its trusted data root',
    )
  } finally {
    await ctx.fiber.dispose()
  }
})
