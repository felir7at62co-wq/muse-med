/** Model tools on the data station with the signed-in Muse account: whole-collection (全收录) search and 立即转写 requeue. */
import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { MuseDataError, museDataFailure, type MuseDataFailure, type MuseDataStationClient } from './data-station.ts'
import type { MuseDataWorks } from './types.ts'

/** Validated result size of one search. */
export interface MuseDataToolOptions {
  /** Works returned per page. */
  readonly pageSize: number
}

const PLATFORMS = ['hongguo', 'douyin', 'lvpaopao', 'fanqie', 'qimao'] as const
const HONGGUO_ID = /^hongguo:\d{1,32}$/u
/** Longest search words the station accepts. */
const MAX_QUERY_CHARS = 200
/** Highest page number the station accepts. */
const MAX_PAGE = 100_000

const failureGuidance: Record<MuseDataFailure, string> = {
  'sign-in-required': '未登录 Muse 账号或登录已失效。请用户先在设置中登录 Muse，再重试。',
  'team-access-required': '当前 Muse 账号不在数据站成员名单中，不能查看数据站。请用户联系数据站管理员加入名单。',
  'station-unavailable': '数据站暂时不可用。稍后重试。',
  'invalid-input': `query 最多 ${MAX_QUERY_CHARS} 个字，page 是从 1 开始的整数；重新排队的 id 形如 hongguo:7550544718799588376。`,
  'invalid-response': '数据站返回了无法识别的结果。稍后重试。',
  unconfirmed: '没有取得数据站的结果。稍后重试。',
  timeout: '数据站请求超时，没有取得结果。稍后重试。',
  unavailable: '暂时无法连接数据站，没有取得结果。稍后重试。',
  'not-requeueable': '这部剧正在转写或已经有剧本，数据站没有重新排队。转写进度在数据站的储备看板里。',
}

function failed(error: unknown) {
  const code = museDataFailure(error).code
  return { state: 'error' as const, code, guidance: failureGuidance[code] }
}

function listed(work: MuseDataWorks['items'][number]) {
  const metrics: Record<string, number> = {}
  for (const metric of work.metrics) if (metric.value !== null && !(metric.label in metrics)) metrics[metric.label] = metric.value
  return {
    id: work.id, platform: work.platform, title: work.title ?? work.sourceId,
    ...(work.author === null ? {} : { author: work.author }),
    ...(work.tags.length === 0 ? {} : { tags: work.tags.slice(0, 8) }),
    ...(work.episodeCount === null ? {} : { episodes: work.episodeCount }),
    ...(work.wordCount === null ? {} : { words: work.wordCount }),
    metrics, board: work.board, ...(work.rank === null ? {} : { rank: work.rank }), observedAt: work.observedAt,
    ...(work.description === '' ? {} : { description: work.description }),
  }
}

/**
 * Register `data_station_search`, which finds dramas and source novels in the data station's whole collection, and
 * `data_station_requeue`, which puts a Hongguo drama back at the front of the transcription queue as the signed-in member.
 * @param ctx - Context with the owning tool registry.
 * @param client - Account-token station transport owned by the plugin.
 * @param options - Validated result size.
 */
export function mountMuseDataTools(ctx: Context, client: Pick<MuseDataStationClient, 'works' | 'rush'>, options: MuseDataToolOptions): void {
  ctx.tools.register(defineTool({
    name: 'data_station_search', deferLoading: true,
    description: '在数据站的全收录里找剧和原著：红果短剧、抖音、绿泡泡的短剧和番茄、七猫的小说，使用当前登录的 Muse 账号。'
      + 'query 按剧名、作者、编号、简介和标签匹配，不填则列出最近收录的作品；platform 限定平台，不填则搜全部平台。'
      + `每页 ${options.pageSize} 部，最近采到的在前；每部带数据站编号 id、集数或字数、平台指标（如热度、收藏、在读）、最近所在榜单和名次、采集时间和简介开头。`
      + '这里是团队数据站已经收录的作品，不是平台实时搜索；找不到时换个关键词或去掉 platform 再试。',
    parameters: {
      query: { type: 'string', description: `剧名、作者、编号或关键词，最多 ${MAX_QUERY_CHARS} 字；不填则列出最近收录的作品。` },
      platform: { type: 'string', enum: PLATFORMS, description: 'hongguo 红果短剧，douyin 抖音，lvpaopao 绿泡泡，fanqie 番茄小说，qimao 七猫小说；不填则搜全部平台。' },
      page: { type: 'integer', description: '页码，从 1 开始，默认 1。' },
    },
    output: { schema: { type: 'json' }, render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }] },
    presentCall: args => ({ card: 'generic', title: args.query ?? args.platform ?? '全收录', kind: 'read' }),
    async execute(args) {
      try {
        const query = args.query?.trim() ?? ''
        const page = args.page ?? 1
        if (query.length > MAX_QUERY_CHARS || !Number.isSafeInteger(page) || page < 1 || page > MAX_PAGE) throw new MuseDataError('invalid-input')
        const found = await client.works({
          ...(args.platform === undefined ? {} : { platform: args.platform }), ...(query === '' ? {} : { q: query }), page, limit: options.pageSize,
        })
        return { state: 'ok' as const, total: found.total, page: found.page, pages: Math.ceil(found.total / options.pageSize), works: found.items.map(listed),
          ...(found.items.length === 0 ? { guidance: '没有找到。换个关键词，或去掉 platform 搜全部平台。' } : {}) }
      } catch (error) { return failed(error) }
    },
  }))
  ctx.tools.register(defineTool({
    name: 'data_station_requeue', deferLoading: true,
    description: '把一部红果短剧放回数据站转写队列最前（立即转写），使用当前登录的 Muse 账号，记在这个账号名下。'
      + '用于待处理、失败或被淘汰的剧再转一次：已下载的原片和已通过的集沿用，没通过的集再给一轮。正在转写或已有剧本的剧不会重新排队。'
      + '排队后由云端 Muse 的转写 Bot 领取。',
    parameters: {
      id: { type: 'string', required: true, description: '数据站编号，形如 hongguo:7550544718799588376。' },
    },
    output: { schema: { type: 'json' }, render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }] },
    presentCall: args => ({ card: 'generic', title: args.id, kind: 'execute' }),
    async execute(args) {
      try {
        const id = args.id.trim()
        if (!HONGGUO_ID.test(id)) throw new MuseDataError('invalid-input')
        const job = await client.rush(id)
        return { state: 'ok' as const, id: job.workId, jobState: job.state, lane: job.lane }
      } catch (error) { return failed(error) }
    },
  }))
}
