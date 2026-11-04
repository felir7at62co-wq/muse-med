/** Scoped source-research tools. Collection accepts official-client requests, never model-supplied source results. */
import { SourceResearch } from './service.js';
export { resolveConfig } from './service.js';
export const name = 'muse-source-research';
export const inject = ['tools', 'agents', 'fs'];

const text = { type: 'string' };
const project = { type: 'string', description: '发起Session cwd内的项目目录；默认当前目录，禁止通过符号链接越界' };
const array = values => ({ type: 'array', minItems: 1, uniqueItems: true, items: { type: 'string', enum: values } });
const operation = { type: 'string', enum: ['rankings'] };
const refresh = { type: 'boolean', description: '跳过来源短期缓存；false保留原始测量时间，不把缓存当作新测量' };
const hongguo = { type: 'object', additionalProperties: false, required: ['operation'], properties: { operation, refresh,
  boards: array(['hot-drama', 'hot-real-drama', 'hot-ai-drama', 'hot-comic-drama']) } };
const qimao = { type: 'object', additionalProperties: false, required: ['operation'], properties: { operation, refresh,
  source: { type: 'string', enum: ['rank', 'library'] }, channels: array(['boy', 'girl']), boards: array(['hot', 'new', 'over', 'collect', 'update']), periods: array(['date', 'month']),
  pages: { type: 'integer', minimum: 1, description: '仅library真实分页；固定近3天更新、30万字以下、连载中、click排序。rank不接受pages' } } };
const snapshotSchema = { type: 'object', additionalProperties: false, required: ['action'], properties: {
  action: { type: 'string', enum: ['collect', 'import_legacy', 'list', 'read', 'compare'] }, project,
  platform: { type: 'string', enum: ['hongguo', 'qimao'] },
  request: { type: 'object', additionalProperties: false, required: ['operation'], properties: {
    ...qimao.properties, boards: { type: 'array', minItems: 1, uniqueItems: true, items: { type: 'string', enum: [...hongguo.properties.boards.items.enum, ...qimao.properties.boards.items.enum] } },
  } },
  path: { type: 'string', description: 'import_legacy必填：项目内已有legacy JSON，保留原文件、原字段及SHA，不把它称为官方新采集' },
  snapshotId: text, beforeId: text, afterId: text,
} };
const ids = { type: 'array', minItems: 1, uniqueItems: true, items: text };
const reportSchema = { type: 'object', additionalProperties: false, required: ['action'], properties: {
  action: { type: 'string', enum: ['build', 'read'] }, project, snapshotIds: ids, baselineIds: ids, reportId: text,
} };

/** @param ctx Scoped tools, agent identity, filesystem and optional sandbox policy. @param config Deployment resource/client settings. @returns Nothing; scoped effects own registrations and in-flight collection. */
export function apply(ctx, config = {}) {
  const service = new SourceResearch(ctx, config);
  ctx.effect(() => () => service.dispose(), 'source research: abort and await owned calls');
  const definitions = [
    { name: 'source_snapshot', type: 'snapshot', parameters: snapshotSchema, title: '管理选材来源快照',
      description: '真实采集红果官方公开榜单或七猫公开榜单首屏/筛选书库，保存不可覆盖的v1来源快照；collect仅接受平台和rankings请求，不能提交模型编造的sourceResult。import_legacy只导入项目内旧JSON为legacy_file证据，保留源路径/SHA和原字段；list/read/compare读取项目内快照。按平台+真实ID去重，无ID原样保留但不入统计。比较要求相同范围及指标原语义/单位/标签，未知不是0，缓存测量时间不变，不推断新增/退榜、在读人数、市场总量或跨平台身份。写入前检查当前文件权限，只读会在HTTP前拒绝。' },
    { name: 'source_report', type: 'report', parameters: reportSchema, title: '生成有来源依据的选材日报',
      description: '用已有snapshotIds生成不可覆盖的选材日报JSON和deliverables/选材日报/Markdown，记录全部输入ID/SHA、每个平台采集范围、缺页、未知指标、同口径共有字段变化；baselineIds可选，无基线不算增长。仅使用工具读取的真实快照；不接受模型JSON当官方数据，不计算假市场密度、蓝海或自动无AI/无S2结论。read按reportId校验读取。JSON已保存但Markdown失败时返回partial和具体receipt，可复核证据。' },
  ];
  for (const definition of definitions) ctx.effect(() => ctx.tools.register({
    name: definition.name, description: definition.description, parameters: definition.parameters,
    output: { schema: { type: 'object', additionalProperties: true }, render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }] },
    timeoutMs: service.config.toolTimeoutMs,
    execute: (args, exec) => service.execute(definition.type, args, exec.signal),
    presentCall: args => ({ card: 'generic', title: definition.title, kind: ['read', 'list', 'compare'].includes(args.action) ? 'read' : 'write' }),
    presentResult: (_args, result) => ({ card: 'generic', title: definition.title, content: result.content }),
  }), `source research: ${definition.name}`);
}
