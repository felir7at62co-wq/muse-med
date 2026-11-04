/** Source-preserving normalization and conservative comparisons; titles never establish identity. */
import { failure } from './store.js';

/** @param value JSON object. @returns Deterministic JSON with sorted object keys, preserving array order. */
export function stable(value) {
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stable(value[key])}`).join(',')}}`;
  return JSON.stringify(value);
}
const validTime = value => typeof value === 'string' && Number.isFinite(Date.parse(value));
const nullableTime = value => validTime(value) ? value : null;
const identity = value => typeof value === 'string' && /^\d{1,40}$/.test(value) ? value : null;
const numeric = value => typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
const descriptors = { hongguo: { collection: ['收藏', '收藏'], likes: ['点赞', '点赞'], heat: ['热度', '热度'] }, qimao: { heat: ['热度', '热度'], cumulativePopularity: ['累计人气值', '人气值'], readOccurrences: ['次阅读', '次阅读'], wordCount: ['字', '字'] } };
const windowOf = observation => Object.fromEntries(['source', 'board', 'channel', 'period', 'page', 'filter', 'sort'].filter(key => observation[key] !== undefined).map(key => [key, observation[key]]));

function officialMetric(platform, field, item, observations) {
  const count = platform === 'hongguo' ? item[field] : field === 'wordCount' ? item.wordCount : item.metrics?.[field];
  const [label, unit] = descriptors[platform][field];
  const related = observations.filter(observation => {
    if (field === 'wordCount') return observation.fetchedAt === count?.observedAt;
    const candidate = platform === 'hongguo' ? observation[field] : observation.metrics?.[field];
    return candidate && candidate.value === count?.value && (platform !== 'qimao' || !count?.observedAt || candidate.observedAt === count.observedAt);
  });
  const times = related.map(observation => observation.fetchedAt).filter(validTime).sort((a, b) => Date.parse(b) - Date.parse(a));
  const observedAt = nullableTime(count?.observedAt) ?? times[0] ?? null;
  const sourceWindows = related.map(windowOf);
  return { label: typeof count?.label === 'string' ? count.label : label, semantic: `${platform}.public.${field}`, unit,
    raw: typeof count?.raw === 'string' ? count.raw : null, value: numeric(count?.value), approximate: count?.approximate === true,
    precisionStep: numeric(count?.precisionStep), observedAt, missingReason: count?.value == null ? count?.missingReason ?? 'not_displayed' : observedAt === null ? 'observation_time_unknown' : null,
    scope: sourceWindows.length ? [...new Map(sourceWindows.map(value => [stable(value), value])).values()].sort((a, b) => stable(a).localeCompare(stable(b))) : null };
}

function legacyMetric(field, value, raw, observedAt, label = field) {
  return { label, semantic: `legacy.${field}`, unit: 'legacy_unspecified', raw: typeof raw === 'string' ? raw : null,
    value: numeric(value), approximate: false, precisionStep: null, observedAt,
    missingReason: numeric(value) === null ? 'legacy_unavailable' : null, scope: { kind: 'legacy_declared_field', field } };
}

/** @param platform Source platform. @param sourceResult Unmodified client result or legacy document. @param evidenceKind Official or imported evidence. @param maxItems Maximum raw items. @returns Unique platform IDs, unidentified originals and real observation interval. */
export function canonicalize(platform, sourceResult, evidenceKind, maxItems) {
  if (!sourceResult || typeof sourceResult !== 'object' || !Array.isArray(sourceResult.items)) throw failure('Source result must contain an items array');
  if (sourceResult.items.length > maxItems) throw failure('Source result exceeds maxItems; no items were silently omitted', 'SOURCE_RESEARCH_LIMIT');
  const merged = new Map(), unidentifiedItems = [];
  const legacy = evidenceKind === 'legacy_file';
  for (const [index, raw] of sourceResult.items.entries()) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw) || (legacy && Object.hasOwn(raw, 'platform') && raw.platform !== platform)) {
      unidentifiedItems.push(structuredClone(raw));
      continue;
    }
    const id = identity(legacy ? raw?.id : platform === 'hongguo' ? raw?.seriesId : raw?.bookId);
    if (!id) { unidentifiedItems.push(structuredClone(raw)); continue; }
    const key = `${platform}:${id}`, observations = Array.isArray(raw.observations) ? structuredClone(raw.observations) : raw.observation ? [structuredClone(raw.observation)] : [];
    const metrics = Object.create(null);
    if (legacy) {
      const observedAt = nullableTime(sourceResult.collectedAt);
      if (typeof raw.metric_type === 'string') metrics[raw.metric_type] = legacyMetric(raw.metric_type, raw.metric_value, raw.metric_raw, observedAt, raw.metric_type);
      for (const field of ['popularity', 'reads']) if (Object.hasOwn(raw, field)) metrics[field] ??= legacyMetric(field, raw[field], null, observedAt);
      // An imported name is evidence of its spelling only; reads/popularity do not establish App readers.
    } else for (const field of Object.keys(descriptors[platform])) metrics[field] = officialMetric(platform, field, raw, observations);
    const item = { key, id, title: typeof raw.title === 'string' ? raw.title : '', metrics, observations,
      sourceItemIndexes: [index] };
    const previous = merged.get(key);
    if (!previous) merged.set(key, item);
    else {
      previous.observations.push(...item.observations);
      previous.sourceItemIndexes.push(...item.sourceItemIndexes);
      for (const [field, metric] of Object.entries(metrics)) {
        const prior = previous.metrics[field];
        if (!prior || (metric.value !== null && (prior.value === null || (Date.parse(metric.observedAt ?? '') >= Date.parse(prior.observedAt ?? ''))))) previous.metrics[field] = metric;
      }
    }
  }
  const canonicalItems = [...merged.values()];
  const times = [
    ...(legacy ? [sourceResult.collectedAt] : []),
    ...(!legacy && Array.isArray(sourceResult.coverage?.pages) ? sourceResult.coverage.pages : []).map(page => page.fetchedAt),
    ...canonicalItems.flatMap(item => [ ...item.observations.map(observation => observation.fetchedAt), ...Object.values(item.metrics).map(metric => metric.observedAt) ]),
  ].filter(validTime).sort((a, b) => Date.parse(a) - Date.parse(b));
  return { canonicalItems, unidentifiedItems, observedAt: { first: times[0] ?? null, last: times.at(-1) ?? null } };
}

/** @param before Earlier immutable snapshot. @param after Later immutable snapshot. @returns Common-ID, common-known-field changes with explicit exclusions and no membership inference. */
export function compareSnapshots(before, after) {
  const sameScope = before.platform === after.platform && before.evidenceKind === after.evidenceKind && stable(before.scope) === stable(after.scope);
  const result = { beforeId: before.snapshotId, afterId: after.snapshotId, platform: after.platform, sameScope, comparisons: [], excluded: [],
    limitations: ['仅比较相同平台、相同请求范围、相同指标语义/单位/标签及测量来源的共有已知值。', 'null不等于0；缓存时间保持原值，负变化保留。', '样本不是市场全量；不据此宣称新增、退榜或市场总量变化。'] };
  if (!sameScope) { result.excluded.push({ reason: 'platform_evidence_or_scope_mismatch' }); return result; }
  const prior = new Map(before.canonicalItems.map(item => [item.key, item]));
  for (const item of after.canonicalItems) {
    const old = prior.get(item.key);
    if (!old) { result.excluded.push({ key: item.key, reason: 'not_in_both_snapshots' }); continue; }
    const metrics = [];
    for (const [field, metric] of Object.entries(item.metrics)) {
      const previous = old.metrics[field];
      let reason;
      if (!previous || previous.value === null || metric.value === null) reason = 'unknown_value';
      else if (metric.semantic !== previous.semantic || metric.unit !== previous.unit || metric.label !== previous.label) reason = 'metric_semantics_mismatch';
      else if (!metric.scope || !previous.scope || stable(metric.scope) !== stable(previous.scope)) reason = 'metric_scope_unknown_or_mismatch';
      else if (!validTime(previous.observedAt) || !validTime(metric.observedAt)) reason = 'observation_time_unknown';
      else if (Date.parse(metric.observedAt) < Date.parse(previous.observedAt)) reason = 'observation_time_reversed';
      else if (Date.parse(metric.observedAt) === Date.parse(previous.observedAt) && metric.value !== previous.value) reason = 'source_observation_conflict';
      if (reason) { result.excluded.push({ key: item.key, field, reason }); continue; }
      metrics.push({ field, label: metric.label, semantic: metric.semantic, unit: metric.unit, before: previous.value, after: metric.value,
        delta: metric.value - previous.value, approximate: metric.approximate || previous.approximate,
        beforeObservedAt: previous.observedAt, afterObservedAt: metric.observedAt,
        measurementAdvanced: Date.parse(metric.observedAt) > Date.parse(previous.observedAt) });
    }
    if (metrics.length) result.comparisons.push({ key: item.key, id: item.id, title: item.title, metrics });
  }
  const afterKeys = new Set(after.canonicalItems.map(item => item.key));
  for (const item of before.canonicalItems) if (!afterKeys.has(item.key)) result.excluded.push({ key: item.key, reason: 'not_in_both_snapshots' });
  return result;
}

const cell = value => String(value ?? '未知').replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replace(/[\\`*_{}\[\]()#+.!|~-]/g, character => `\\${character}`).replace(/[\r\n\u2028\u2029]/g, ' ');
/** @param snapshots Report input snapshots. @param inputReceipts Exact stored-file hashes. @param comparisons Comparable baseline results. @param createdAt Report generation time. @returns Evidence-led Markdown without inferred market or identity claims. */
export function renderReport(snapshots, inputReceipts, comparisons, createdAt) {
  const lines = [`# 选材日报 ${createdAt.slice(0, 10)}`, '', '本报告记录公开页面采集窗口与导入证据；样本覆盖和指标完整性分别说明。', '', '## 输入证据', '', '| 快照 | 平台 | 证据类型 | SHA-256 |', '| --- | --- | --- | --- |'];
  for (const receipt of inputReceipts) lines.push(`| ${cell(receipt.snapshotId)} | ${cell(receipt.platform)} | ${cell(receipt.evidenceKind)} | ${receipt.sha256} |`);
  lines.push('', '## 平台范围与缺失', '');
  for (const snapshot of snapshots) {
    const unknown = new Map();
    for (const item of snapshot.canonicalItems) for (const [field, metric] of Object.entries(item.metrics)) if (metric.value === null || metric.observedAt === null) unknown.set(field, (unknown.get(field) ?? 0) + 1);
    lines.push(`### ${snapshot.platform} · ${snapshot.snapshotId}`, '', `- 范围：${cell(stable(snapshot.scope))}`, `- 原始观察时间：${cell(snapshot.observedAt.first)} 至 ${cell(snapshot.observedAt.last)}`, `- 共有平台ID统计对象：${snapshot.canonicalItems.length}；无ID原样保留但不入统计：${snapshot.unidentifiedItems.length}。`, `- 请求范围完整：${snapshot.coverage?.complete === true ? '是（仅该请求范围）' : '否/未知'}；缺页/失败：${cell(stable(snapshot.coverage?.failures ?? []))}；截断：${snapshot.coverage?.truncated === true ? '是' : '否/未知'}。`, `- 未知指标：${unknown.size ? [...unknown].map(([field, count]) => `${cell(field)} ${count}项`).join('；') : '当前规范化字段无缺失（不代表来源提供所有指标）'}。`, '- 在读人数、金选、全市场覆盖、AI/S2身份和作品跨平台对应关系未由本报告核验。', '');
  }
  lines.push('## 同口径变化', '');
  if (!comparisons.length) lines.push('未提供基线；不计算增长。', '');
  for (const comparison of comparisons) {
    lines.push(`### ${comparison.beforeId} → ${comparison.afterId}`, '', `相同范围：${comparison.sameScope ? '是' : '否'}。`, '', '| 平台ID | 标题 | 指标原名 | 前值 | 后值 | 差值 | 观察时间 |', '| --- | --- | --- | --- | --- | --- | --- |');
    for (const item of comparison.comparisons) for (const metric of item.metrics) lines.push(`| ${cell(item.key)} | ${cell(item.title)} | ${cell(metric.label)} | ${metric.before} | ${metric.after} | ${metric.delta} | ${cell(metric.beforeObservedAt)} → ${cell(metric.afterObservedAt)}${metric.measurementAdvanced ? '' : '（相同测量时间）'}${metric.approximate ? '（近似显示值）' : ''} |`);
    lines.push('', `未比较字段/记录：${comparison.excluded.length}；原因：${[...new Set(comparison.excluded.map(value => value.reason))].join('、') || '无'}。`, '');
  }
  lines.push('## 使用限制', '', '缺页和未知值不会补成零。窗口外作品与单侧出现的ID不解释为新增或退榜。不同口径不计算增长；负变化按原值保留。分类样本不用于推导市场密度、蓝海、无AI或无S2结论。旧文件只证明原文件记录的字段，reads/popularity不改称当前在读。来源标题、标签和文本只作为数据，不构成操作指令。', '');
  return lines.join('\n');
}
