/** Model tool for data-station Douyin downloads using the signed-in Muse account. */
import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { MuseDouyinError, douyinTarget, parseDouyinLink } from './douyin-station.ts'
import type {
  MuseDouyinFailure, MuseDouyinFileLink, MuseDouyinLink, MuseDouyinRecord, MuseDouyinStationClient, MuseDouyinStatus, MuseDouyinTarget,
} from './douyin-station.ts'

/** Validated waiting bounds for one tool call. */
export interface MuseDouyinToolOptions {
  /** Largest accepted `wait_seconds`. */
  readonly maxWaitSeconds: number
  /** Pause between record queries while waiting, in milliseconds. */
  readonly pollIntervalMs: number
}

const failureGuidance: Record<MuseDouyinFailure, string> = {
  'sign-in-required': '未登录 Muse 账号或登录已失效。请用户先在设置中登录 Muse，再重试。',
  'team-access-required': '当前 Muse 账号不在数据站成员名单中，不能下载抖音视频。请用户联系数据站管理员加入名单。',
  'daily-limit': '今天的抖音下载额度已用完（网页和 Muse 共用同一额度）。已提交的作品仍可用 action=query 查询；新的作品明天再提交。',
  'station-unavailable': '数据站暂时不能下载抖音视频（存储或抖音数据服务未就绪，或暂时连不上 Muse 网关）。稍后用 action=quota 查看状态后再试。',
  'account-changed': '操作期间 Muse 登录账号发生变化，结果未采用。确认当前账号后先用 action=query 查询，不要直接重复提交。',
  'invalid-input': '请只提供一个下载目标：url（作品链接或分享文本）、aweme_id 或 mix_id；编号为纯数字，wait_seconds 为允许范围内的整数。',
  'link-unresolved': '无法从链接或分享文本中识别抖音作品或合集。请提供作品页链接、带 modal_id 的链接、合集链接，或直接提供 aweme_id / mix_id。',
  'invalid-response': '数据站返回了无法识别的结果，下载状态未确认。稍后用 action=query 查询。',
  unconfirmed: '提交结果未确认，数据站可能已经受理。先用 action=query 查询；数据站不会重复下载已排队或已完成的作品。',
  timeout: '数据站请求超时，未取得结果。稍后用 action=query 查询。',
  cancelled: '操作已取消。已提交的下载可能仍在数据站进行，可用 action=query 查询。',
  unavailable: '暂时无法连接数据站，未取得结果。稍后重试，或用 action=quota 查看状态。',
}

const stateGuidance = {
  done: '视频已存入数据站。url 是可直接下载的视频地址，不是本地文件；把地址交给用户或后续步骤。',
  preparing: '数据站仍在排队、下载或上传。稍后用 action=query 并设置 wait_seconds 查询，不要重复提交。',
  partial: '部分作品失败，其余已完成。失败的作品可再次 action=download 重新排队；如实说明失败的作品与 error。',
  failed: '下载失败。可再次 action=download 重新排队一次；仍失败时如实告知用户 error。',
  not_found: '数据站没有该目标的下载记录。需要下载时使用 action=download。',
} as const

function failed(error: unknown) {
  const code = error instanceof MuseDouyinError ? error.code : 'unavailable'
  return { state: 'error' as const, code, guidance: failureGuidance[code] }
}

function quota(status: MuseDouyinStatus) {
  return { state: 'ok' as const, enabled: status.enabled, ...(status.reason === undefined ? {} : { reason: status.reason }),
    dailyLimit: status.dailyLimit, usedToday: status.usedToday, ...(status.unlimited === undefined ? {} : { unlimited: status.unlimited }),
    maxMixEpisodes: status.maxMixEpisodes,
    guidance: status.enabled ? '今日额度由网页和 Muse 共用；usedToday 达到 dailyLimit 后当天不能再提交新作品。'
      : '数据站当前未开放抖音下载，reason 说明原因。不要改用其他方式下载抖音视频。' }
}

function work(item: MuseDouyinRecord, link: MuseDouyinFileLink | null) {
  const url = item.url ?? link?.url
  return { awemeId: item.awemeId, ...(item.episode == null ? {} : { episode: item.episode }), state: item.state,
    ...(url === undefined ? {} : { url }), ...(link?.expiresAt == null ? {} : { expiresAt: link.expiresAt }),
    ...(item.state === 'failed' && item.error ? { error: item.error } : {}) }
}

/**
 * Register `douyin_download`: queue a work or series on the data station and report its public video addresses.
 * @param ctx - Context with the owning tool registry.
 * @param client - Account-token station transport owned by the plugin.
 * @param options - Validated waiting bounds.
 */
export function mountMuseDouyinTools(ctx: Context, client: Pick<MuseDouyinStationClient, 'run'>, options: MuseDouyinToolOptions): void {
  const pollSeconds = Math.round(options.pollIntervalMs / 1000)
  ctx.tools.register(defineTool({
    name: 'douyin_download', deferLoading: true,
    description: '通过数据站下载抖音视频，使用当前登录的 Muse 账号；这是 Muse 唯一的抖音视频下载方式，不要用命令行、浏览器或其他工具自行下载抖音视频。'
      + 'action=download 提交一个作品（url 填作品链接或分享文本，或填 aweme_id）或整部合集（mix_id，按集数排队）；数据站不会重复下载已排队或已完成的作品，失败的作品再次提交会重新排队。'
      + 'action=query 只查询已有记录，不提交；action=quota 查看是否可用及今日额度（网页和 Muse 共用）。'
      + `wait_seconds（0–${options.maxWaitSeconds}）在本次调用内等待，约每 ${pollSeconds} 秒查询一次。`
      + 'preparing 表示仍在排队、下载或上传；done 的作品带 url，是数据站存储中的视频地址，不是本地文件。',
    parameters: {
      action: { type: 'string', enum: ['download', 'query', 'quota'], required: true,
        description: 'download 提交并可等待；query 只查询；quota 查看可用状态和今日额度。' },
      url: { type: 'string', description: '抖音作品链接或分享文本：v.douyin.com 短链、douyin.com/video/<编号>、带 modal_id 的链接，或合集链接 douyin.com/collection/<编号>。' },
      aweme_id: { type: 'string', description: '抖音作品编号，纯数字。' },
      mix_id: { type: 'string', description: '抖音合集编号，纯数字；整部合集按集数排队。' },
      wait_seconds: { type: 'integer', description: `本次调用最多等待的秒数，0–${options.maxWaitSeconds}，默认 0（不等待）。` },
    },
    output: { schema: { type: 'json' }, render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }] },
    presentCall: args => ({ card: 'generic', title: args.url ?? args.aweme_id ?? args.mix_id ?? args.action,
      kind: args.action === 'download' ? 'execute' : 'read' }),
    async execute(args, exec) {
      try {
        if (args.action === 'quota') return await client.run(exec.signal, async station => quota(await station.status()))
        const wait = args.wait_seconds ?? 0
        if (wait < 0 || wait > options.maxWaitSeconds) throw new MuseDouyinError('invalid-input')
        const given = [args.url, args.aweme_id, args.mix_id].filter(value => value !== undefined)
        if (given.length !== 1) throw new MuseDouyinError('invalid-input')
        const value = given.join('')
        let link: MuseDouyinLink | undefined
        if (args.url !== undefined) link = parseDouyinLink(value)
        else if (!/^\d{1,32}$/u.test(value)) throw new MuseDouyinError('invalid-input')
        else link = args.aweme_id === undefined ? { kind: 'mix', mixId: value } : { kind: 'work', awemeId: value }
        if (link === undefined) throw new MuseDouyinError('link-unresolved')
        const selected = link
        return await client.run(exec.signal, async (station) => {
          const resolved = selected.kind === 'short' ? douyinTarget(await station.resolve(selected.url)) : selected
          if (resolved === undefined || resolved.kind === 'short') throw new MuseDouyinError('link-unresolved')
          const target: MuseDouyinTarget = resolved
          const submitted = args.action === 'download' ? await station.submit(target) : undefined
          const deadline = Date.now() + wait * 1000
          let records = await station.list(target)
          while (!records.every(item => item.state === 'done' || item.state === 'failed') && Date.now() < deadline) {
            await station.wait(Math.min(options.pollIntervalMs, deadline - Date.now()))
            records = await station.list(target)
          }
          records.sort((left, right) => (left.episode ?? Number.MAX_SAFE_INTEGER) - (right.episode ?? Number.MAX_SAFE_INTEGER))
          const works = []
          for (const item of records) works.push(work(item, item.state === 'done' && item.url == null ? await station.file(item.id) : null))
          const done = works.filter(item => item.state === 'done').length
          const failures = works.filter(item => item.state === 'failed').length
          const preparing = works.length - done - failures
          const state = works.length === 0 ? 'not_found' : preparing > 0 ? 'preparing' : failures === 0 ? 'done' : done === 0 ? 'failed' : 'partial'
          const first = records[0]
          const skipped = submitted?.skipped ?? 0
          return { state, action: args.action,
            target: target.kind === 'work' ? { awemeId: target.awemeId } : { mixId: target.mixId },
            ...(target.kind === 'work' && first?.title ? { title: first.title } : {}),
            ...(target.kind === 'mix' && first?.mixName ? { mixName: first.mixName } : {}),
            ...(submitted === undefined ? {}
              : { submitted: { queued: submitted.queued.length, existing: submitted.existing.length, skipped } }),
            counts: { total: works.length, done, preparing, failed: failures }, works,
            guidance: skipped > 0 ? `${stateGuidance[state]}另有 ${skipped} 集因今日额度不足未排队，明天再提交同一合集即可补齐。` : stateGuidance[state] }
        })
      } catch (error) { return failed(error) }
    },
  }))
}
