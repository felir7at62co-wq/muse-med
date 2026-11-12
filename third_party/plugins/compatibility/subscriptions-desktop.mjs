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
  composerPanel: 'CSS anchor positioning with native outside-pointer dismissal',
})

function edit(directory, path, digest, changes) {
  const filename = join(directory, path)
  let text = readFileSync(filename, 'utf8')
  if (createHash('sha256').update(text).digest('hex') !== digest) {
    throw new Error(`community plugins: subscription ${path} requires source review`)
  }
  for (const [before, after] of changes) {
    if (text.split(before).length !== 2) throw new Error(`community plugins: subscription ${path} requires source review`)
    text = text.replace(before, after)
  }
  writeFileSync(filename, text)
}

const usageAnchorCss = `
.dsh-subscription-usage-panel {
  position-area: none;
  top: max(12px, var(--dsh-frame-overlay-top, 12px));
  bottom: max(12px, calc(anchor(top) + 8px));
  left: max(12px, anchor(left));
  right: 12px;
  max-height: min(560px, calc(100dvh - 12px - max(12px, var(--dsh-frame-overlay-top, 12px))));
  position-try-fallbacks: --muse-subscription-window, --muse-subscription-opposite, --muse-subscription-wide-opposite, --muse-subscription-tall, --muse-subscription-viewport;
  align-self: end;
  justify-self: start;
  height: fit-content;
  min-height: 0;
  margin: 0;
}
@position-try --muse-subscription-window {
  top: max(12px, var(--dsh-frame-overlay-top, 12px));
  bottom: max(12px, calc(anchor(top) + 8px));
  left: 12px;
  right: 12px;
  align-self: safe end;
  justify-self: safe end;
}
@position-try --muse-subscription-opposite {
  top: max(12px, calc(anchor(bottom) + 8px));
  bottom: 12px;
  align-self: start;
}
@position-try --muse-subscription-wide-opposite {
  top: max(12px, calc(anchor(bottom) + 8px));
  bottom: 12px;
  left: 12px;
  right: 12px;
  align-self: start;
  justify-self: safe end;
}
@position-try --muse-subscription-tall {
  top: max(12px, var(--dsh-frame-overlay-top, 12px));
  bottom: 12px;
  left: max(12px, anchor(left));
  right: 12px;
  align-self: safe start;
}
@position-try --muse-subscription-viewport {
  inset: max(12px, var(--dsh-frame-overlay-top, 12px)) 12px 12px;
  align-self: safe start;
  justify-self: safe end;
}
`

/**
 * Adapt saved routes, image support and composer anchors in copied upstream source before building.
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
    [['export class CodexAdapter extends LlmAdapter {',
      'export class CodexAdapter extends LlmAdapter {\n  override readonly supportsRequiredImageInput = true']])
  edit(directory, 'src/providers/account-preferences.ts', '1e65de90f88bd4ff2f89958e10b65e5d74fd3082edb36037d3a5bc9273a0e6a5',
    [['  constructor(private readonly options: Options) { super() }',
      '  override readonly supportsRequiredImageInput: boolean\n  constructor(private readonly options: Options) { super(); this.supportsRequiredImageInput = options.adapter.supportsRequiredImageInput }']])
  edit(directory, 'src/client/SubscriptionUsageBadge.tsx', '2b58f178faf113081e23c2999e6e63a85abd864052519c6a93d83590b6f9370e', [
    ["import { useCallback, useEffect, useRef, useState } from 'react'", "import { useCallback, useEffect, useId, useRef, useState } from 'react'"],
    ["import { useAnchoredPosition, useDismissOnOutsidePointer } from '@deepseek-ai/dsh-client-ui-primitives'", "import { useDismissOnOutsidePointer } from '@deepseek-ai/dsh-client-ui-primitives'"],
    ["  const pos = useAnchoredPosition({ open, anchorRef: rootRef, panelRef, side: 'top', gap: PANEL_GAP, margin: PANEL_MARGIN })", "  const anchorName = `--muse-subscription-${useId().replaceAll(':', '')}`"],
    ["    <span ref={rootRef} style={styles.anchor}>", "    <span ref={rootRef} style={{ ...styles.anchor, anchorName }}>"],
    ["      <style>{subscriptionChromeCss}</style>", "      <style>{subscriptionChromeCss + usageAnchorCss}</style>"],
    ["          style={{ ...styles.panel, ...(pos ?? MEASURE_STYLE) }}", "          style={{ ...styles.panel, positionAnchor: anchorName }}"],
    ["/** Distance between the trigger's top edge and the dialog's bottom (host stat dialogs use the same). */\nconst PANEL_GAP = 8\n\n/** Distance kept between the dialog and each viewport edge. */\nconst PANEL_MARGIN = 12\n\n", ''],
    ["/**\n * Unplaced portal panel: hidden but laid out so the clamp measures real\n * dimensions (the `useAnchoredPosition` measure pass).\n */\nconst MEASURE_STYLE: CSSProperties = { visibility: 'hidden', left: 0, top: 0 }", `/** Viewport-constrained positioning shared with the native composer stats panels. */\nconst usageAnchorCss = ${JSON.stringify(usageAnchorCss)}`],
    ["    maxHeight: 'min(560px, 100dvh - 24px)', overflowY: 'auto', overscrollBehavior: 'contain',", "    overflowY: 'auto', overscrollBehavior: 'contain',"],
  ])
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
