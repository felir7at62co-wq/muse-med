/** Scoped source-research tools. Collection accepts official-client requests, never model-supplied source results. */
import { SourceResearch } from './service.js';
export { resolveConfig } from './service.js';
export const name = 'muse-source-research';
export const inject = ['tools', 'agents', 'fs', 'userQuestions'];

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
  mappingIds: { ...ids, description: 'build可选：显式引用作品关系提案，保存构建时的人审revision/SHA/状态；不传时不添加映射内容' },
} };
const sourceRef = { type: 'object', additionalProperties: false, required: ['snapshotId', 'itemId'], properties: {
  snapshotId: { type: 'string', description: '已保存并可通过source_snapshot读取的快照ID' },
  itemId: { type: 'string', description: '快照canonicalItems里的真实来源十进制字符串ID；平台/标题/SHA由工具读取，不能由模型提供' },
} };

/** @param ctx Scoped tools, agent identity, filesystem, human questions and optional sandbox policy. @param config Deployment resource/client settings. @returns Nothing; scoped effects own registrations and in-flight collection. */
export function apply(ctx, config = {}) {
  const service = new SourceResearch(ctx, config);
  ctx.effect(() => () => service.dispose(), 'source research: abort and await owned calls');
  const definitions = [
    { name: 'source_snapshot', type: 'snapshot', parameters: snapshotSchema, title: '管理选材来源快照',
      description: '真实采集红果官方公开榜单或七猫公开榜单首屏/筛选书库，保存不可覆盖的v1来源快照；collect仅接受平台和rankings请求，不能提交模型编造的sourceResult。import_legacy只导入项目内旧JSON为legacy_file证据，保留源路径/SHA和原字段；list/read/compare读取项目内快照。按平台+真实ID去重，无ID原样保留但不入统计。比较要求相同范围及指标原语义/单位/标签，未知不是0，缓存测量时间不变，不推断新增/退榜、在读人数、市场总量或跨平台身份。写入前检查当前文件权限，只读会在HTTP前拒绝。' },
    { name: 'source_report', type: 'report', parameters: reportSchema, title: '生成有来源依据的选材日报',
      description: '用已有snapshotIds生成不可覆盖的选材日报JSON和deliverables/选材日报/Markdown，记录全部输入ID/SHA、每个平台采集范围、缺页、未知指标、同口径共有字段变化；baselineIds可选，无基线不算增长。可选mappingIds仅显式引用作品关系，报告保存当时的人审状态/revision/SHA；未审核提案保持未核实，后续改判不改旧报告。仅使用真实快照，不接受模型JSON当官方数据，不计算假市场密度、蓝海或自动无AI/无S2结论。read按reportId核验；JSON已保存但Markdown失败返回partial与具体receipt。' },
    { name: 'work_mapping', type: 'mapping', title: '审核作品关系证据',
      parameters: { type: 'object', additionalProperties: false, required: ['action'], properties: {
        action: { type: 'string', enum: ['propose', 'read', 'list', 'lookup', 'review', 'supersede'] }, project,
        left: sourceRef, right: sourceRef, sourceRef,
        sourceKey: { type: 'string', description: 'lookup三选一：hongguo:<ID>或qimao:<ID>，仅返回该平台ID的历史提案及原快照证据，不自动扩展旧确认到新快照' },
        relation: { type: 'string', enum: ['same_work', 'adaptation_of', 'same_series', 'sequel_of'], description: 'same_work同作；same_series同系列不等于同作；adaptation_of左侧改编自右侧；sequel_of左侧是右侧续作' },
        reason: { type: 'string', maxLength: service.config.maxMappingReasonChars, description: 'propose必填模型理由，明确未核实；不能由同名自动确认' },
        mappingId: text, expectedProposalSha256: { type: 'string', description: 'review/supersede必填：read返回的proposalSha256完整文件SHA-256' },
        expectedRevision: { type: 'integer', minimum: 0, description: 'review初始0，supersede必须等于已存在最新revision；旧回答不能写入新revision' },
      } },
      description: '用已保存红果/七猫快照的{snapshotId,itemId}两端提出关系，平台、ID、标题和SHA由工具核验；同名仅是未审核提案，不自动合并指标。propose/read/list/lookup管理直接关系，lookup恰选mappingId/sourceRef/sourceKey；sourceKey只查同平台ID的历史证据，不自动扩展旧确认到新快照。review和supersede必须提供预期提案SHA与revision，通过真实用户提问确认/拒绝/待核实；模型不能提交confirmed或decision。只读在提问前拒绝，取消、无回答服务、子agent或失效回答不写决定。决定追加不可覆盖的修订；改关系/证据另建提案。同系列不等于同作，来源未给季数仍未知；未命中只表示本证据未观察到，不推断全平台无AI或无S2，不做传递合并。' },
  ];
  for (const definition of definitions) ctx.effect(() => ctx.tools.register({
    name: definition.name, description: definition.description, parameters: definition.parameters,
    output: { schema: { type: 'object', additionalProperties: true }, render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }] },
    timeoutMs: service.config.toolTimeoutMs,
    execute: (args, exec) => service.execute(definition.type, args, exec.signal),
    presentCall: args => ({ card: 'generic', title: definition.title, kind: ['read', 'list', 'compare', 'lookup'].includes(args.action) ? 'read' : 'write' }),
    presentResult: (_args, result) => ({ card: 'generic', title: definition.title, content: result.content }),
  }), `source research: ${definition.name}`);
}
