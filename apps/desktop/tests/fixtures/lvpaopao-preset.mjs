/** Source-only plugin imports stay outside the Desktop TypeScript program. */
import * as Lvpaopao from '../../../../third_party/plugins/muse-lvpaopao/src/index.ts'
import LvpaopaoBridge from '../../../../third_party/plugins/muse-lvpaopao/src/bridge.ts'

/** Return the actual source modules for the test Loader. */
export function lvpaopaoModules() {
  return new Map([
    ['muse-lvpaopao/bridge', { default: LvpaopaoBridge }],
    ['muse-lvpaopao', Lvpaopao],
  ])
}

/** Read readiness without exposing third-party declaration merging to Desktop. */
export function bridgeConfigured(ctx) {
  return ctx.lvpaopaoBridge.configuration !== undefined
}

/** Exercise the actual shared service after consumer disposal. */
export function requestBridgeStatus(ctx, signal) {
  return ctx.lvpaopaoBridge.request('status', {}, signal)
}
