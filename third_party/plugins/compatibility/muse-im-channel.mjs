/** Native IM settings and channels, with a one-time import of the old Muse bot. */
import z from '@deepseek-ai/schemastery'
import { dshHomePath } from '@deepseek-ai/dsh-home-paths'
import { createImHostPlugin } from './upstream.js'
import { migrateMuseIm, reconcileMuseImWorkspaces } from './muse-im-migration.mjs'
import { createMuseImAdmission } from './muse-im-admission.mjs'
import { createMuseImTeamScope } from './muse-im-team.mjs'
import { createUpdateService } from '../plugin-src/host/update-service.mjs'
import { installUpdateRpc } from '../plugin-src/host/update-rpc.mjs'

export const name = 'muse-im'
export const inject = ['connection', 'credentials', 'typertGateway', 'sessions', 'sessionPersistence']

/** Existing fields remain readable for import; native IM owns subsequent bot edits. */
export const Config = z.object({
  enabled: z.boolean().default(false),
  appId: z.string().default('').volatile(),
  appSecret: z.string().role('secret').default('').volatile(),
  registeredBy: z.string().default('').volatile(),
  allowFrom: z.array(z.string()).default([]).volatile(),
  activeSessionId: z.string().default('').volatile(),
  requireMention: z.boolean().default(true),
  denyTools: z.array(z.string()).default(['exit_plan_mode']),
  agentPreset: z.string().default('short-drama'),
  defaultCwd: z.string().required(false),
  dataDir: z.string().required(false),
  dshHome: z.string().required(false),
  feishuDataDir: z.string().required(false),
  inboundClaimRetentionMs: z.number().step(1).min(1).default(7 * 24 * 60 * 60 * 1000),
  inboundClaimMaxEntries: z.number().step(1).min(1).default(100000),
  cardThrottleMs: z.number().min(100).max(5000).default(400),
  maxFileBytes: z.number().min(1).default(100 * 1024 * 1024),
  retainedCardOwners: z.number().step(1).min(1).default(1000),
  digestIntervalSec: z.number().min(1).default(30),
  approvalTimeoutSec: z.number().min(1).default(600),
  maxMessageChars: z.number().min(200).default(2000),
  sendChunkDelayMs: z.number().min(100).max(1000).default(200),
})

/** Import existing credentials once, then start only the native IM connection owners. */
export async function apply(ctx, supplied) {
  if (ctx.fiber.entry?.options.id !== 'feishu-channel') throw new Error('The Muse IM provider must be mounted as feishu-channel')
  const config = { ...supplied, dshHome: supplied.dshHome ?? dshHomePath(),
    ...Object.fromEntries(['appId', 'appSecret', 'registeredBy', 'allowFrom', 'activeSessionId']
      .map(key => [key, supplied[key].get()])) }
  const migration = await migrateMuseIm(ctx, config)
  await reconcileMuseImWorkspaces(ctx, config)
  const museAdmission = createMuseImAdmission(config, migration)
  let team
  const providers = new Map()
  const subscriptions = new Map()
  const subscribe = (key, provider) => {
    subscriptions.get(key)?.()
    subscriptions.delete(key)
    if (team?.registerFeishuProvider) subscriptions.set(key, team.registerFeishuProvider(provider))
  }
  ctx.inject(['museTeam'], scope => {
    const service = scope.get('museTeam')
    team = service
    for (const [key, provider] of providers) subscribe(key, provider)
    scope.effect(() => () => {
      if (team !== service) return
      for (const dispose of subscriptions.values()) dispose()
      subscriptions.clear()
      team = undefined
    }, 'muse-im: team routing service')
  })
  const museTeam = { forBot: (imBotId, appId, scope, workspaces) => {
    const scoped = createMuseImTeamScope(scope, {
      imBotId, appId, dshHome: config.dshHome, getTeam: () => team,
      retentionMs: config.inboundClaimRetentionMs, maxEntries: config.inboundClaimMaxEntries,
      legacyAdmission: museAdmission.forBot(imBotId, workspaces),
    })
    providers.set(imBotId, scoped.connectedBots)
    subscribe(imBotId, scoped.connectedBots)
    return scoped
  } }

  const plugin = createImHostPlugin({ installUpdateRpc: updateCtx => {
    const refuseUpdate = async () => { throw Object.assign(new Error('IM updates are supplied by Muse'), { code: 'unsupported-runtime' }) }
    const statusService = createUpdateService({ runtime: {
      inspect: async () => ({ eligible: false, blockedReason: 'unsupported-runtime',
        installedVersion: '5.1.0', environmentKind: 'desktop' }),
      install: refuseUpdate,
    } })
    return installUpdateRpc(updateCtx, { service: { ...statusService, check: refuseUpdate, install: refuseUpdate } })
  } })
  await plugin.apply(ctx, { dshHome: config.dshHome, feishu: {
    agentPreset: config.agentPreset,
    maxFileBytes: config.maxFileBytes,
    ...(config.defaultCwd === undefined ? {} : { workspace: config.defaultCwd }),
    ...(config.feishuDataDir === undefined ? {} : { dataDir: config.feishuDataDir }),
    museAdmission,
    museTeam,
  } })
}
