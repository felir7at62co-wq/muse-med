/** Scoped read-only Qimao metadata tools; collection never fetches a chapter or evaluates page JavaScript. */
import { QimaoClient } from './client.js';
import { CHANNELS, BOARDS, PERIODS } from './parser.js';
export { QimaoClient, resolveConfig } from './client.js';
export const name = 'muse-qimao-data';
export const inject = ['tools'];

const nullable = type => ({ oneOf: [{ type }, { type: 'null' }] });
const metric = { type: 'object', additionalProperties: false, properties: {
  label: { type: 'string' }, raw: nullable('string'), value: nullable('number'), approximate: { type: 'boolean' },
  precisionStep: nullable('number'), observedAt: { type: 'string' }, missingReason: nullable('string'),
}, required: ['label', 'raw', 'value', 'approximate', 'precisionStep', 'observedAt', 'missingReason'] };
const book = { type: 'object', additionalProperties: true, properties: {
  bookId: { type: 'string' }, title: { type: 'string' }, url: { type: 'string' }, author: { type: 'string' }, tags: { type: 'array', items: { type: 'string' } },
  description: { type: 'string' }, status: nullable('string'), updatedAt: nullable('string'), wordCount: metric,
  currentReaders: { type: 'null' }, goldenPick: { type: 'null' }, fetchedAt: { type: 'string' }, sourceUrl: { type: 'string' },
  metrics: { type: 'object', additionalProperties: false, properties: { heat: metric, cumulativePopularity: metric, readOccurrences: metric }, required: ['heat', 'cumulativePopularity', 'readOccurrences'] },
  missingMetrics: { type: 'array', items: { type: 'object', additionalProperties: false, properties: { field: { type: 'string' }, reason: { type: 'string' } }, required: ['field', 'reason'] } },
  observations: { type: 'array', items: { type: 'object', additionalProperties: true } },
}, required: ['bookId', 'title', 'url', 'author', 'description', 'metrics', 'currentReaders', 'goldenPick', 'sourceUrl', 'fetchedAt'] };
const collection = { type: 'object', additionalProperties: true, properties: {
  scope: { type: 'string' }, items: { type: 'array', items: book }, fetchedAt: { type: 'string' }, fromCache: { type: 'boolean' }, note: { type: 'string' },
  coverage: { type: 'object', additionalProperties: true, properties: {
    completeFor: { type: 'string', enum: ['requested_public_pages'] }, siteWide: { type: 'boolean' }, pagesRequested: { type: 'integer' },
    pagesFetched: { type: 'integer' }, uniqueBooks: { type: 'integer' }, complete: { type: 'boolean' },
    failures: { type: 'array', items: { type: 'object', additionalProperties: true } }, metrics: { type: 'object', additionalProperties: true },
  } },
}, required: ['scope', 'items', 'coverage', 'fetchedAt', 'fromCache', 'note'] };
const selection = {
  source: { type: 'string', enum: ['rank', 'library'], description: 'rank读取所选榜单首屏；library读取近3天更新、30万字以下、连载中的按点击量书库页，不代表全库' },
  channels: { type: 'array', items: { type: 'string', enum: Object.keys(CHANNELS) }, description: 'rank频道，默认boy/girl；library不接受此参数' },
  boards: { type: 'array', items: { type: 'string', enum: Object.keys(BOARDS) }, description: 'rank榜种：大热hot、新书new、完结over、收藏collect、更新update；默认全部' },
  periods: { type: 'array', items: { type: 'string', enum: Object.keys(PERIODS) }, description: '大热榜date日榜/month月榜，默认两者；其余榜仅date，library不接受此参数' },
  pages: { type: 'integer', description: '仅library真实页码范围，从第1页起取至此页；默认配置maxPages=3，不能用于榜单翻页' },
  refresh: { type: 'boolean', description: 'true跳过短期缓存；默认false，缓存带原采集时间且按配置TTL失效' },
};

/**
 * Register read-only tools in the caller's scope and dispose their owned requests on unload.
 * @param ctx Cordis scope with the tool registry and effect owner.
 * @param config Validated by the client before registration.
 * @returns Nothing; scoped effects own registration and request cleanup.
 */
export function apply(ctx, config = {}) {
  const client = new QimaoClient(config);
  ctx.effect(() => () => client.dispose(), 'qimao: abort requests and await metadata reads');
  const definitions = [
    { name: 'qimao_rankings', method: 'rankings', title: '读取七猫公开榜单与书库', properties: selection,
      description: '七猫小说选材：静态读取男/女频大热、新书、完结、收藏、更新榜首屏，大热分日/月；或读取公开筛选书库的真实分页。核验实际频道、榜种、周期和页码，拒绝重复页。仅覆盖所选公开窗口，coverage.complete仅表示请求范围成功；指标完整性另报。热度、累计人气值、次阅读分别保留原名与时间；在读人数、金选未知，不下载正文、不登录。' },
    { name: 'qimao_search', method: 'search', title: '在七猫公开采集窗口找书', properties: { ...selection,
      query: { type: 'string', description: '书名或作者片段，1–100字符；只匹配所选公开采集窗口，不是全站搜索' },
      offset: { type: 'integer', description: '过滤结果偏移，默认0；不触发额外官网翻页' },
      limit: { type: 'integer', description: '返回条数，默认20，范围1–100' } }, required: ['query'],
      description: '按书名或作者在本次所选七猫公开榜单首屏/筛选书库页面内过滤候选。返回matchedInWindow、availableInWindow和原覆盖说明；complete始终false，不得把没找到解释成七猫没有此书。可用qimao_detail按返回bookId核对详情。不访问小说正文。' },
    { name: 'qimao_detail', method: 'detail', title: '读取七猫书籍公开详情', properties: {
      bookId: { type: 'string', description: 'qimao_rankings/search返回的十进制字符串书ID或官方/shuku/ID/链接，不转JS数字' },
      refresh: selection.refresh,
    }, required: ['bookId'], detail: true,
      description: '读取指定七猫书籍主信息区的公开元数据，核验真实bookId，返回书名、作者、分类、简介、状态、字数、更新时间、累计人气值和次阅读的原名/值/采集时间/缺失原因。次阅读不是当前在读人数，累计人气值不是当日投票；currentReaders和goldenPick均未知。仅解析DOM，不执行网页脚本、不抓取或返回章节正文。' },
  ];
  for (const definition of definitions) ctx.effect(() => ctx.tools.register({
    name: definition.name, description: definition.description,
    parameters: { type: 'object', additionalProperties: false, properties: definition.properties, required: definition.required ?? [] },
    output: { schema: definition.detail ? book : collection, render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }] },
    timeoutMs: (client.config.requestTimeoutMs * 2 + client.config.requestIntervalMs) * Math.max(12, client.config.maxPages) + 10000,
    execute: (args, exec) => client[definition.method](args, exec.signal),
    presentCall: () => ({ card: 'generic', title: definition.title, kind: definition.detail ? 'read' : 'search' }),
    presentResult: (_args, result) => ({ card: 'generic', title: definition.title, content: result.content }),
  }), `qimao: ${definition.name}`);
}
