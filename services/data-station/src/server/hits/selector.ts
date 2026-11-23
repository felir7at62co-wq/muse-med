/**
 * Scheduled automatic selection of Hongguo dramas for transcription.
 * A drama qualifies when all hold: 收藏 above the threshold, the 下沉 topic rules, finished (not 连载), and no confirmed
 * adaptation of a Fanqie novel in the station's catalog. Detail pages fill completion status, cast and 收藏 where missing.
 */
import { createHash } from 'node:crypto';
import { setImmediate as yieldToEvents } from 'node:timers/promises';
import type { CollectionReading, DouyinTopicCheck, DramaCompletion, HitEvaluation, HitSelectionStatus, IpMatch, SinkEvaluation } from '../../shared/hits.ts';
import type { Metric, Work } from '../../shared/types.ts';
import { metricsMeasuredAt } from '../../shared/metrics.ts';
import type { CollectionManager } from '../collection-manager.ts';
import type { HongguoDetail } from '../collectors/hongguo-detail.ts';
import type { DataRepository } from '../repository.ts';
import { pace } from '../metrics/sources.ts';
import { FanqieIpIndex } from './ip-match.ts';
import type { HitRules } from './rules.ts';
import { evaluateSink } from './sink.ts';
import type { CandidateRecord, DetailRecord, HitStore } from './store.ts';

const HOUR = 3_600_000;
const NO_IP: IpMatch = { level: 'none', fanqieWorkId: null, fanqieTitle: null, reasons: [] };

/** Reads one drama's detail page; null when the source no longer has it. */
export type DetailReader = (seriesId: string, signal: AbortSignal) => Promise<HongguoDetail | null>;

export interface HitSelectorOptions {
  rules: HitRules;
  /** Time between scheduled runs. */
  intervalMs: number;
  /** Omitted: only data already collected is evaluated. */
  readDetail?: DetailReader;
  /**
   * Checks the drama's exact-name Douyin topic. `known` carries an earlier or hand-set hashtag, so only its counts are read again.
   * Omitted: no topic can be checked, so the Douyin gate (when required) keeps every drama out.
   */
  checkTopic?: (title: string, known: { hashtagId: string | null; manual: boolean } | null) => Promise<DouyinTopicCheck>;
  now?: () => number;
}

/** Most recent known 收藏 among the work's own record and its detail reading. */
export function collectionOf(work: Work, reading: HongguoDetail | null): CollectionReading | null {
  const own = work.metrics.find(metric => metric.key === 'collection' && metric.value !== null);
  const measured = own ? metricsMeasuredAt(work) : null;
  const fromWork: CollectionReading | null = own && measured ? { value: own.value!, measuredAt: measured, source: work.board ? 'board' : 'catalog' } : null;
  const fromDetail: CollectionReading | null = reading?.collection != null ? { value: reading.collection, measuredAt: reading.measuredAt, source: 'detail' } : null;
  if (!fromWork) return fromDetail;
  if (!fromDetail) return fromWork;
  return Date.parse(fromDetail.measuredAt) >= Date.parse(fromWork.measuredAt) ? fromDetail : fromWork;
}

/** Completion from the configured `series_status` values, else from explicit source text. */
export function completionOf(reading: HongguoDetail | null, rules: HitRules): DramaCompletion | null {
  if (!reading) return null;
  if (reading.seriesStatus !== null && rules.completion.completedStatuses.includes(reading.seriesStatus)) return 'completed';
  if (reading.seriesStatus !== null && rules.completion.serialStatuses.includes(reading.seriesStatus)) return 'serial';
  const text = reading.episodeRightText ?? '';
  if (/更新至|更新到|连载/u.test(text)) return 'serial';
  if (/已完结/u.test(text)) return 'completed';
  return null;
}

/** Replaces the values a reading measured; other metrics become unknown at the reading time. */
function mergeMetrics(previous: Metric[], measured: Metric[]): Metric[] {
  const read = new Map(measured.map(metric => [metric.key, metric]));
  return [...previous.map(metric => read.get(metric.key) ?? { ...metric, value: null }), ...measured.filter(metric => !previous.some(old => old.key === metric.key))];
}

const sinkInput = (work: Work) => ({ title: work.title, tags: work.tags, category: work.category, description: work.description });
const wan = (value: number) => value >= 100_000_000 ? `${Number((value / 100_000_000).toFixed(2))}亿` : value >= 10_000 ? `${Number((value / 10_000).toFixed(1))}万` : `${value}`;

/** Runs selection passes on a schedule; detail pages are read under the Hongguo collection lock. */
export class HitSelector {
  private rules: HitRules;
  private readonly now: () => number;
  private running: Promise<void> | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private closing = false;
  private readonly abort = new AbortController();
  private current: HitSelectionStatus = { state: 'idle', lastAttemptAt: null, lastSuccessAt: null, nextRunAt: null,
    evaluated: 0, detailsRead: 0, detailsFailed: 0, enqueued: 0, message: '等待首次选片' };

  constructor(private readonly repository: DataRepository, private readonly store: HitStore,
    private readonly collections: Pick<CollectionManager, 'requestTask'> | null, private readonly options: HitSelectorOptions) {
    if (!Number.isInteger(options.intervalMs) || options.intervalMs < 60_000) throw new Error('Selection interval must be at least one minute');
    this.rules = options.rules;
    this.now = options.now ?? Date.now;
  }

  private time(offset = 0): string { return new Date(this.now() + offset).toISOString(); }
  get ruleSet(): HitRules { return this.rules; }

  status(): HitSelectionStatus { return { ...this.current }; }

  /** Whether a detail page should be read before this run's evaluation. */
  private needsDetail(work: Work, sink: SinkEvaluation, record: DetailRecord | undefined): boolean {
    if (!sink.qualifies) return false;
    const now = this.now();
    const detail = this.rules.detail;
    const reading = record?.reading ?? null;
    const collection = collectionOf(work, reading);
    if (collection && collection.value <= this.rules.minCollection) {
      return collection.source !== 'board' && now - Date.parse(collection.measuredAt) >= detail.collectionRecheckHours * HOUR;
    }
    if (record && record.outcome !== 'success' && now - Date.parse(record.attemptedAt) < detail.failureRetryHours * HOUR) return false;
    if (!reading) return true;
    const age = now - Date.parse(reading.measuredAt);
    if (completionOf(reading, this.rules) === 'completed') return !collection && age >= detail.collectionRecheckHours * HOUR;
    return age >= detail.serialRecheckHours * HOUR;
  }

  /** Reads due detail pages one at a time; catalog-only works also get the measured counts on their own record. */
  private async readDetails(works: Work[], signal: AbortSignal): Promise<{ read: number; failed: number }> {
    let read = 0, failed = 0;
    for (const [index, work] of works.entries()) {
      if (index) await pace(this.rules.detail.requestIntervalMs, signal);
      signal.throwIfAborted();
      let reading: HongguoDetail | null;
      try { reading = await this.options.readDetail!(work.sourceId, signal); }
      catch (error) {
        if (signal.aborted) throw error;
        failed++;
        await this.store.recordDetail(work.id, 'failed');
        console.error('[muse-data-web] hongguo detail reading failed:', error instanceof Error ? `${error.name}: ${error.message.replace(/https?:\/\/\S+/g, '[来源地址]').slice(0, 200)}` : 'Error');
        continue;
      }
      if (!reading) { await this.store.recordDetail(work.id, 'missing'); continue; }
      await this.store.recordDetail(work.id, 'success', reading);
      read++;
      const measured: Metric[] = [{ key: 'heat', label: '热度', value: reading.heat }, { key: 'collection', label: '收藏', value: reading.collection }, { key: 'likes', label: '点赞', value: reading.likes }];
      if (work.board === '' && measured.some(metric => metric.value !== null) && Date.parse(reading.measuredAt) > Date.parse(work.observedAt)) {
        const { metricsObservedAt: _measured, ...current } = work;
        await this.repository.ingestBatch({ platform: 'hongguo', observedAt: reading.measuredAt, coverage: '选片详情页指标',
          works: [{ ...current, metrics: mergeMetrics(work.metrics, measured), observedAt: reading.measuredAt }] });
      }
    }
    return { read, failed };
  }

  /** Runs the read phase under the Hongguo lock; returns null when another Hongguo task holds it. */
  private async locked(task: (signal: AbortSignal) => Promise<{ read: number; failed: number }>): Promise<{ read: number; failed: number } | null> {
    if (!this.collections) return task(this.abort.signal);
    let result: { read: number; failed: number } | null = null;
    let failure: unknown = null;
    let finish!: () => void;
    const finished = new Promise<void>(resolve => { finish = resolve; });
    const accepted = await this.collections.requestTask('hongguo', async signal => {
      try { result = await task(AbortSignal.any([signal, this.abort.signal])); }
      catch (error) { failure = error; }
      finally { finish(); }
    });
    if (!accepted) return null;
    await finished;
    if (failure) throw failure;
    return result;
  }

  private evaluate(work: Work, sink: SinkEvaluation, reading: HongguoDetail | null, ip: IpMatch, douyin: DouyinTopicCheck | null = null, gate = false): HitEvaluation {
    const collection = collectionOf(work, reading);
    const completion = completionOf(reading, this.rules);
    const unmet: string[] = [];
    if (!sink.qualifies) unmet.push(sink.blocked ? `硬伤题材：${sink.blockHits.join('、')}` : '不够下沉');
    if (!collection) unmet.push('收藏未知');
    else if (collection.value <= this.rules.minCollection) unmet.push(`收藏未超过 ${wan(this.rules.minCollection)}`);
    if (this.rules.requireCompleted && completion === 'serial') unmet.push('连载中');
    if (this.rules.requireCompleted && completion === null) unmet.push('完结状态未知');
    if (this.rules.excludeConfirmedIp && ip.level === 'confirmed') unmet.push(`番茄 IP：《${ip.fanqieTitle}》`);
    if (gate) {
      if (!douyin) unmet.push('抖音话题未检查');
      else if (douyin.state === 'not_found') unmet.push('抖音没有同名话题');
      else if (douyin.state === 'error') unmet.push(`抖音话题查询失败：${douyin.error ?? '请稍后重试'}`);
      else if (douyin.state === 'below') unmet.push(`抖音话题播放 ${wan(douyin.viewCount ?? 0)} 未超过 ${wan(this.rules.douyin.minPlays)}`);
    }
    return { qualified: unmet.length === 0, unmet, collection, completion, completionMeasuredAt: reading?.measuredAt ?? null, sink, ip, douyin, evaluatedAt: this.time() };
  }

  /** One selection pass: read due detail pages, evaluate every 下沉 candidate, enqueue new qualifiers. */
  async run(): Promise<void> {
    const started = this.time();
    this.current = { ...this.current, state: 'running', lastAttemptAt: started, message: '正在选片' };
    try {
      const works = await this.repository.liveWorks('hongguo');
      const sinks = new Map(works.map(work => [work.id, evaluateSink(sinkInput(work), this.rules.sink)]));
      let details = await this.store.details();
      const order = (work: Work) => {
        const collection = collectionOf(work, details.get(work.id)?.reading ?? null);
        return collection ? (collection.value > this.rules.minCollection ? 0 : 2) : 1;
      };
      const due = works.filter(work => this.needsDetail(work, sinks.get(work.id)!, details.get(work.id)))
        .sort((a, b) => order(a) - order(b)
          || (collectionOf(b, details.get(b.id)?.reading ?? null)?.value ?? 0) - (collectionOf(a, details.get(a.id)?.reading ?? null)?.value ?? 0)
          || b.observedAt.localeCompare(a.observedAt) || a.id.localeCompare(b.id))
        .slice(0, this.rules.detail.batchSize);
      let reads: { read: number; failed: number } | null = { read: 0, failed: 0 };
      if (due.length && this.options.readDetail) reads = await this.locked(signal => this.readDetails(due, signal));
      details = await this.store.details();
      const refreshed = new Map((await this.repository.liveWorks('hongguo')).map(work => [work.id, work]));
      const index = new FanqieIpIndex(await this.repository.liveWorks('fanqie'), this.rules.ip);
      const previous = await this.store.candidates();
      const changes: Parameters<HitStore['saveEvaluations']>[0] = [];
      const evaluations = new Map<string, HitEvaluation>();
      const topics = await this.store.topics();
      const parts = new Map<string, { work: Work; sink: SinkEvaluation; reading: HongguoDetail | null; ip: IpMatch; ipKey: string | null; ipCheckedAt: string | null; stored: CandidateRecord | undefined; ready: boolean }>();
      let count = 0;
      for (const work of refreshed.values()) {
        const sink = sinks.get(work.id) ?? evaluateSink(sinkInput(work), this.rules.sink);
        const stored = previous.get(work.id);
        if (!sink.qualifies && !stored) continue;
        if (++count % 50 === 0) await yieldToEvents();
        const reading = details.get(work.id)?.reading ?? null;
        const base = this.evaluate(work, sink, reading, NO_IP);
        let ip = NO_IP, ipKey: string | null = null, ipCheckedAt: string | null = null;
        // The IP check is the most expensive one; it runs only for dramas meeting every other condition.
        if (base.qualified) {
          const roles = (reading?.cast ?? []).flatMap(person => person.role ? [person.role] : []);
          const description = work.description || reading?.description || '';
          ipKey = createHash('sha256').update(JSON.stringify([work.title, description, roles, index.version])).digest('hex');
          if (stored?.ipKey === ipKey && stored.ipCheckedAt && this.now() - Date.parse(stored.ipCheckedAt) < this.rules.ip.recheckHours * HOUR) {
            ip = stored.evaluation.ip; ipCheckedAt = stored.ipCheckedAt;
          } else { ip = index.match({ title: work.title, description, roles }); ipCheckedAt = this.time(); }
        }
        parts.set(work.id, { work, sink, reading, ip, ipKey, ipCheckedAt, stored, ready: this.evaluate(work, sink, reading, ip).qualified });
      }
      // Douyin topic checks run last and only for dramas meeting every other condition, paced, since one Douyin account serves them.
      const topicDue = [...parts.values()].filter(part => part.ready && part.work.title && this.needsTopic(topics.get(part.work.id)))
        .sort((a, b) => Number(Boolean(topics.get(a.work.id))) - Number(Boolean(topics.get(b.work.id)))
          || (collectionOf(b.work, b.reading)?.value ?? 0) - (collectionOf(a.work, a.reading)?.value ?? 0) || a.work.id.localeCompare(b.work.id))
        .slice(0, this.options.checkTopic ? this.rules.douyin.perRun : 0);
      let topicsChecked = 0;
      for (const [position, part] of topicDue.entries()) {
        if (position) await pace(this.rules.douyin.requestIntervalMs, this.abort.signal);
        const known = topics.get(part.work.id);
        const check = await this.options.checkTopic!(part.work.title!, known ? { hashtagId: known.hashtagId, manual: known.manual } : null);
        await this.store.recordTopic(part.work.id, check);
        topics.set(part.work.id, check);
        topicsChecked++;
      }
      for (const part of parts.values()) {
        const evaluation = this.evaluate(part.work, part.sink, part.reading, part.ip, topics.get(part.work.id) ?? null, this.rules.douyin.required);
        evaluations.set(part.work.id, evaluation);
        if (!part.stored || this.changed(part.stored, evaluation, part.ipKey)) changes.push({ workId: part.work.id, evaluation, ipKey: part.ipKey, ipCheckedAt: part.ipCheckedAt });
      }
      const firstQualified = await this.store.saveEvaluations(changes);
      const enqueued = await this.updateQueue(evaluations, previous, firstQualified);
      this.current = { state: reads === null ? 'idle' : 'success', lastAttemptAt: started, lastSuccessAt: this.time(), nextRunAt: this.current.nextRunAt,
        evaluated: evaluations.size, detailsRead: reads?.read ?? 0, detailsFailed: reads?.failed ?? 0, enqueued,
        message: `评估 ${evaluations.size} 部下沉候选，入选 ${[...evaluations.values()].filter(item => item.qualified).length} 部；读取详情 ${reads?.read ?? 0} 部${reads?.failed ? `，失败 ${reads.failed} 部` : ''}${reads === null ? '（红果正在采集，详情下轮再读）' : ''}；查抖音话题 ${topicsChecked} 部；新增排队 ${enqueued} 部` };
    } catch (error) {
      this.current = { ...this.current, state: 'failed', message: `选片中断：${error instanceof Error ? error.name : 'Error'}；已有候选与任务保留` };
      if (!this.abort.signal.aborted) console.error('[muse-data-web] hit selection failed:', error instanceof Error ? `${error.name}: ${error.message.slice(0, 200)}` : 'Error');
    }
  }

  /** Whether a drama's Douyin topic should be (re)checked: never checked, below or not found after the recheck time, or an error after the retry time. */
  private needsTopic(check: DouyinTopicCheck | undefined): boolean {
    if (!check) return true;
    if (check.state === 'pass') return false;
    const hours = check.state === 'error' ? this.rules.douyin.errorRetryHours : this.rules.douyin.recheckHours;
    return this.now() - Date.parse(check.checkedAt) >= hours * HOUR;
  }

  /**
   * Sets a drama's Douyin topic by hand (a person found the right one) and reads its counts now.
   * @throws When topic checks are not configured.
   */
  async setTopic(workId: string, title: string, hashtagId: string): Promise<DouyinTopicCheck> {
    if (!this.options.checkTopic) throw new Error('Douyin topic checks are not configured');
    const check = await this.options.checkTopic(title, { hashtagId, manual: true });
    await this.store.recordTopic(workId, check);
    return check;
  }

  /** Whether Douyin topics can be checked in this deployment. */
  get topicChecks(): boolean { return Boolean(this.options.checkTopic); }

  private changed(stored: CandidateRecord, evaluation: HitEvaluation, ipKey: string | null): boolean {
    const strip = (value: HitEvaluation) => JSON.stringify({ ...value, evaluatedAt: null });
    return stored.qualified !== evaluation.qualified || stored.ipKey !== ipKey || strip(stored.evaluation) !== strip(evaluation);
  }

  /** Enqueues qualifying works without a job, withdraws untouched automatic jobs that stopped qualifying, refreshes backlog order. */
  private async updateQueue(evaluations: Map<string, HitEvaluation>, previous: Map<string, CandidateRecord>, firstQualified: Map<string, string | null>): Promise<number> {
    const jobs = new Map((await this.store.jobs()).map(job => [job.workId, job]));
    const qualified = [...evaluations].filter(([, evaluation]) => evaluation.qualified);
    const fresh = qualified.filter(([id]) => !jobs.has(id));
    const firstSeen = await this.store.firstSeen(fresh.map(([id]) => id));
    let enqueued = 0;
    if (this.rules.autoEnqueue) {
      for (const [id, evaluation] of fresh) {
        const qualifiedAt = firstQualified.get(id) ?? previous.get(id)?.firstQualifiedAt ?? evaluation.evaluatedAt;
        const seen = firstSeen.get(id) ?? qualifiedAt;
        const lane = Date.parse(qualifiedAt) - Date.parse(seen) <= this.rules.queue.newWindowHours * HOUR ? 'new' : 'backlog';
        if (await this.store.enqueue(id, { lane, qualifiedAt, priority: evaluation.collection?.value ?? null })) enqueued++;
      }
    }
    for (const [id, job] of jobs) {
      const evaluation = evaluations.get(id);
      if (job.state !== 'queued' || !evaluation) continue;
      if (!evaluation.qualified) await this.store.withdraw(id, `不再入选：${evaluation.unmet.join('；')}`);
      else await this.store.setPriority(id, evaluation.collection?.value ?? null);
    }
    return enqueued;
  }

  /** Starts a pass now unless one is running. */
  request(): boolean {
    if (this.closing || this.running) return false;
    this.running = this.run().finally(() => { this.running = null; });
    return true;
  }

  /** Waits for the current pass. */
  async waitForIdle(): Promise<void> { await this.running; }

  /** Runs a pass now and then every interval. */
  start(): void {
    if (this.closing || this.timer) return;
    const tick = async () => {
      if (this.request()) await this.running;
      if (this.closing) return;
      this.current.nextRunAt = this.time(this.options.intervalMs);
      this.timer = setTimeout(() => { void tick(); }, this.options.intervalMs);
      this.timer.unref();
    };
    this.timer = setTimeout(() => { void tick(); }, 0);
    this.timer.unref();
  }

  async stop(): Promise<void> {
    this.closing = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.abort.abort();
    await this.running;
  }
}
