/** Qualify the pinned multi-provider subscription source against Muse's Host and Client. */
import { createHash } from 'node:crypto'
import { cpSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

/** Reviewed upstream and local behavior recorded in every built artifact. */
export const subscriptionsDesktopCompatibility = Object.freeze({
  upstreamCommit: 'b8023110864494acefc6f5963c2a197d85dda20c',
  legacyRoute: 'openai-codex',
  currentRoute: 'codex',
  attachments: 'DSH native composer and image gallery',
  credentials: 'one-time local import without deleting the previous credential record',
  migrationRecovery: 'failed imports persist manual login, retain old credentials and leave sign-in available',
  activation: 'one subscription provider; no legacy image or model-picker overrides',
  requiredImageInput: 'Codex retains request images and account routes expose that capability',
})

function edit(directory, path, digest, before, after) {
  const filename = join(directory, path)
  const text = readFileSync(filename, 'utf8')
  if (createHash('sha256').update(text).digest('hex') !== digest || text.split(before).length !== 2) {
    throw new Error(`community plugins: subscription ${path} requires source review`)
  }
  writeFileSync(filename, text.replace(before, after))
}

/**
 * Add only the saved-route adapter to copied upstream source before building.
 * @param {string} directory - Private staging package directory.
 * @returns {void}
 */
export function applySubscriptionsDesktopCompatibility(directory) {
  const file = join(directory, 'src/index.ts')
  let source = readFileSync(file, 'utf8')
  const before = '    return ctx.llm.registerAdapter([provider], route)'
  if (source.split(before).length !== 2) throw new Error('community plugins: subscription registration requires source review')
  if (createHash('sha256').update(source).digest('hex') !== '5154559c87687ccc829d4e94dfd95bfb93b1a7453fea020dd13f1e8f1f4148fc') {
    throw new Error('community plugins: subscription source differs from the reviewed pin')
  }
  source = `import { legacyCodexAlias } from './muse-legacy-alias.mjs'\nimport { attachMigrationIssue } from './muse-recovery.mjs'\n${source}`
  source = source.replace(before, `    if (provider === 'codex') ctx.llm.registerAdapter(['openai-codex'], legacyCodexAlias(route))\n${before}`)
  for (const [before, after] of [
    ['export function apply(ctx: Context, config: Config): void {', 'export function apply(ctx: Context, config: Config, migrationIssue?: string): void {'],
    ['  registerAuthRpc(ctx, new SubscriptionsAuthController(', '  registerAuthRpc(ctx, attachMigrationIssue(new SubscriptionsAuthController('],
    ['  ), speed, {', '  ), migrationIssue), speed, {'],
  ]) {
    if (source.split(before).length !== 2) throw new Error('community plugins: subscription recovery requires source review')
    source = source.replace(before, after)
  }
  writeFileSync(file, source)
  cpSync(new URL('./subscriptions-legacy-alias.mjs', import.meta.url), join(directory, 'src/muse-legacy-alias.mjs'))
  cpSync(new URL('./subscriptions-recovery.mjs', import.meta.url), join(directory, 'src/muse-recovery.mjs'))
  edit(directory, 'src/providers/codex.ts', '917b6ecbd536cde8e03cdd4af2b28d2c901af3de30f710f5a3f7ad790b6924cb',
    'export class CodexAdapter extends LlmAdapter {',
    'export class CodexAdapter extends LlmAdapter {\n  override readonly supportsRequiredImageInput = true')
  edit(directory, 'src/providers/account-preferences.ts', '1e65de90f88bd4ff2f89958e10b65e5d74fd3082edb36037d3a5bc9273a0e6a5',
    '  constructor(private readonly options: Options) { super() }',
    '  override readonly supportsRequiredImageInput: boolean\n  constructor(private readonly options: Options) { super(); this.supportsRequiredImageInput = options.adapter.supportsRequiredImageInput }')
}

/**
 * Install the local credential importer after the upstream Host has been bundled.
 * @param {string} directory - Private staging package directory.
 * @returns {void}
 */
export function finishSubscriptionsDesktopCompatibility(directory) {
  cpSync(new URL('./subscriptions-migration.mjs', import.meta.url), join(directory, 'lib/muse-migration.mjs'))
  cpSync(new URL('./subscriptions-recovery.mjs', import.meta.url), join(directory, 'lib/muse-recovery.mjs'))
  writeFileSync(join(directory, 'lib/index.js'), `/** Muse subscription activation with recoverable local credential import. */
import * as upstream from './upstream.js'
import { disableLegacyImport, migrateSubscriptionsCredentials } from './muse-migration.mjs'
import { recoverSubscriptionsMigration } from './muse-recovery.mjs'
export { name, Config } from './upstream.js'
export const inject = [...upstream.inject, 'credentials']
export async function apply(ctx, config) {
  const migrationIssue = await recoverSubscriptionsMigration(ctx.credentials, migrateSubscriptionsCredentials, disableLegacyImport)
  if (migrationIssue !== undefined) ctx.logger.warn(migrationIssue)
  upstream.apply(ctx, config, migrationIssue)
}
`)
}
