/** Muse/DSH Cordis plugin: public Hongguo metadata tools, with no install-time code. */
import { HongguoClient } from './client.js';
import { BOARDS } from './parser.js';
export const name = 'muse-hongguo-search';
export const inject = ['tools'];
export { HongguoClient, resolveConfig } from './client.js';

const nullable = type => ({ oneOf: [{ type }, { type: 'null' }] });
const metricSchema = { type: 'object', additionalProperties: false,
  properties: { raw: nullable('string'), value: nullable('number'), approximate: { type: 'boolean' }, precisionStep: nullable('number') },
  required: ['raw', 'value', 'approximate', 'precisionStep'] };
const itemSchema = { type: 'object', additionalProperties: true, properties: {
  seriesId: { type: 'string' }, title: { type: 'string' }, url: { type: 'string' },
  watchPageUrl: nullable('string'), urlKind: { type: 'string' }, watchPageKind: { type: 'string' }, coverUrl: nullable('string'), description: { type: 'string' }, tags: { type: 'array', items: { type: 'string' } },
  collection: metricSchema, likes: metricSchema, episodeCount: nullable('integer'), episodeStatus: nullable('string'),
  heat: { type: 'object', additionalProperties: true, properties: { raw: nullable('string'), value: nullable('number') } },
  rating: nullable('number'), scoreText: nullable('string'), sourceUrl: { type: 'string' }, fetchedAt: { type: 'string' },
  actors: { type: 'array', items: { type: 'object', additionalProperties: false, properties: { name: { type: 'string' }, role: { type: 'string' } }, required: ['name', 'role'] } },
  observations: { type: 'array', items: { type: 'object', additionalProperties: true, properties: { board: { type: 'string' }, page: { type: 'integer' }, rank: { type: 'integer' }, sourceUrl: { type: 'string' }, fetchedAt: { type: 'string' }, updateDate: nullable('string'), sourceFormat: { type: 'string' }, collection: metricSchema } } },
  conflicts: { type: 'array', items: { type: 'object', additionalProperties: true, properties: { field: { type: 'string' }, values: { type: 'array', items: { type: 'number' } } } } },
  thresholdStatus: { type: 'string', enum: ['meets', 'below', 'uncertain', 'unknown'] },
}, required: ['seriesId', 'title', 'url', 'collection'] };
const outputSchema = { type: 'object', additionalProperties: true, properties: {
  scope: { type: 'string' }, items: { type: 'array', items: itemSchema },
  fetchedAt: { type: 'string' }, fromCache: { type: 'boolean' }, note: { type: 'string' },
  coverage: { type: 'object', additionalProperties: true, properties: {
    pagesFetched: { type: 'integer' }, pagesExpected: { type: 'integer' }, uniqueSeries: { type: 'integer' }, complete: { type: 'boolean' },
    truncated: { type: 'boolean' }, failures: { type: 'array', items: { type: 'object', additionalProperties: true } },
  } },
}, required: ['items', 'fetchedAt', 'fromCache'] };
const common = {
  refresh: { type: 'boolean', description: '默认false；true跳过短期内存缓存重新读取公开网页' },
};
const paging = {
  limit: { type: 'integer', description: '返回条数，默认20，范围1–400；搜索工具默认10且最大10' },
  offset: { type: 'integer', description: '结果数组偏移，默认0；搜索中仅切分首屏窗口，不触发官网翻页' },
};
const boards = { type: 'array', items: { type: 'string', enum: BOARDS }, description: '榜单范围，默认全部四榜；综合/真人/AI/漫剧' };

/** Raw ToolDefinition input validation; Muse validates canonical output after execution. */
function validateArgs(value, properties, required = []) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError('Tool arguments must be an object');
  for (const key of required) if (!Object.hasOwn(value, key)) throw new TypeError(`Missing argument: ${key}`);
  for (const [key, entry] of Object.entries(value)) {
    const spec = properties[key];
    if (!spec || !Object.hasOwn(properties, key)) throw new TypeError(`Unknown argument: ${key}`);
    if (spec.type === 'integer' ? !Number.isSafeInteger(entry) : spec.type === 'array' ? !Array.isArray(entry) : typeof entry !== spec.type) throw new TypeError(`Invalid argument: ${key}`);
  }
  return value;
}

/** Register four read-only tools. ctx.tools.register owns registration cleanup. */
export function apply(ctx, config = {}) {
  const client = new HongguoClient(config);
  ctx.effect(() => () => client.dispose(), 'hongguo: abort requests and clear memory cache');
  const definitions = [
    { name: 'hongguo_search', title: '搜索红果短剧', method: 'search',
      description: '当用户说找红果短剧、按剧名找剧时，先在红果官方公开关键词网页搜索，拿到seriesId后可调用hongguo_detail查更多数据，超出热播榜范围。当前只获得首屏最多10条，可能含语义推荐；sourceReportedTotal不代表已获取数量。不登录、不下载视频。',
      properties: { query: { type: 'string', description: '关键词，1–100字符' }, ...paging, ...common }, required: ['query'] },
    { name: 'hongguo_rankings', title: '读取红果热播榜', method: 'rankings',
      description: '遍历所选红果官方热播榜公开分页（默认四榜各最多5页），按seriesId去重。收藏/点赞/热度分开；保留每页来源、更新文案、采集时间和冲突。coverage.complete只代表榜单分页，不代表全片库。',
      properties: { boards, ...common } },
    { name: 'hongguo_detail', title: '读取红果剧集详情', method: 'detail',
      description: '当用户想查某部红果剧的数据时，按搜索或榜单给出的seriesId读取官方公开详情：简介、演员、集数、收藏与点赞源字段。仅返回请求的ID；url是官网详情页；watchPageUrl如有则为网页实际链接的官方播放页，并非视频文件或保证可播放的直链。不返回用户评论或下载视频。source整数可能经过平台处理，不承诺后台精度。',
      properties: { seriesId: { type: 'string', description: '搜索或榜单返回的十进制字符串ID，不能转成JS数字' }, ...common }, required: ['seriesId'], detail: true },
    { name: 'hongguo_collections', title: '筛选百万收藏短剧', method: 'collections',
      description: '在官方公开热播榜覆盖范围内筛选收藏数，默认阈值1000000。遍历分页后去重，按最小观察收藏值降序。万/亿展示值是近似数，阈值附近和冲突跨阈值列为uncertain；默认不混入结果。不是全红果片库筛选。',
      properties: { minCollections: { type: 'integer', description: '收藏阈值，默认1000000，非负安全整数' }, includeUncertain: { type: 'boolean', description: '默认false；true把待核实条目包含在items，同时保留thresholdStatus' }, boards, ...paging, ...common } },
  ];
  for (const definition of definitions) {
    ctx.tools.register({
      name: definition.name, description: definition.description,
      parameters: { type: 'object', additionalProperties: false, properties: definition.properties, required: definition.required ?? [] },
      output: { schema: definition.detail ? itemSchema : outputSchema,
        render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }] },
      timeoutMs: (client.config.requestTimeoutMs + client.config.requestIntervalMs) * client.config.maxPages * BOARDS.length * (client.config.incompletePageRetries + 1) + 10000,
      async execute(args, exec) { return client[definition.method](validateArgs(args, definition.properties, definition.required), exec.signal); },
      presentCall() { return { card: 'generic', title: definition.title, kind: definition.detail ? 'read' : 'search' }; },
      presentResult(_args, result) { return { card: 'generic', title: definition.title, content: result.content }; },
    });
  }
}
