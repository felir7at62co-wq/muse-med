/**
 * Persistence for the 绿泡泡 Mac collector: ranking runs become ordinary board observations, engagement readings keep their own
 * history, and the latest heartbeat, pending commands and alert state live in `data_meta`. Login screenshots stay in memory only.
 */
import { createHash, randomUUID } from 'node:crypto';
import type { PGlite } from '@electric-sql/pglite';
import type { CollectorStatus, Metric, Work } from '../../shared/types.ts';
import {
  LVPAOPAO_BOARD_PREFIX, LVPAOPAO_HUMAN_STATES, LVPAOPAO_STATE_LABELS,
  type LvpaopaoAction, type LvpaopaoAdminStatus, type LvpaopaoCommand, type LvpaopaoRunSummary, type LvpaopaoState, type LvpaopaoStatus,
} from '../../shared/lvpaopao.ts';
import type { DataRepository } from '../repository.ts';
import type { LvpaopaoEngagement, LvpaopaoHeartbeat, LvpaopaoRun } from './contract.ts';

/** Mini-program entry used as every work's source link; the platform has no per-drama web page. */
export const LVPAOPAO_SOURCE_URL = 'weixin://dl/business/?appid=wx404dde55fb12df78';
/** Unacknowledged commands are re-sent with each heartbeat for this long. */
const COMMAND_TTL_MS = 30 * 60_000;
/** A login screenshot older than this is no longer shown. */
const LOGIN_SCREEN_TTL_MS = 3 * 60_000;
const HEARTBEAT_KEY = 'lvpaopao_heartbeat_v1';
const COMMANDS_KEY = 'lvpaopao_commands_v1';
const ALERT_KEY = 'lvpaopao_alert_v1';
const ENGAGEMENT_KEYS = [['likes', '点赞'], ['comments', '评论'], ['recommendations', '推荐'], ['shares', '分享']] as const;

/** A run whose `runId` was already stored with different content. */
export class LvpaopaoConflictError extends Error {
  constructor() { super('同一 runId 已上报过不同内容'); this.name = 'LvpaopaoConflictError'; }
}

interface StoredHeartbeat { heartbeat: LvpaopaoHeartbeat; receivedAt: string; }
interface AlertState { state: LvpaopaoState; since: string; notified: boolean; }
/** One alert or recovery notice decided by `evaluate`. */
export interface LvpaopaoNotice { kind: 'alert' | 'recovered'; state: LvpaopaoState; text: string; }

/**
 * Builds the works of one ranking board, keeping each drama once at its best rank.
 * @param board Board read by the collector.
 * @param totals Latest engagement totals by work ID, measured no later than the board.
 * @returns Works ready for `DataRepository.ingestBatch`.
 */
export function boardWorks(board: LvpaopaoRun['rankings'][number], totals: ReadonlyMap<string, { metrics: Metric[]; measuredAt: string; episodeCount: number | null }>): Work[] {
  const best = new Map<string, LvpaopaoRun['rankings'][number]['entries'][number]>();
  for (const entry of board.entries) {
    const sourceId = `${entry.srcAppId}:${entry.dramaId}`;
    const current = best.get(sourceId);
    if (!current || entry.rank < current.rank) best.set(sourceId, entry);
  }
  return [...best.entries()].map(([sourceId, entry]) => {
    const id = `lvpaopao:${sourceId}`;
    const measured = totals.get(id);
    return {
      id, sourceId, platform: 'lvpaopao', kind: 'drama', title: entry.title, author: null, description: '', coverUrl: null,
      sourceUrl: LVPAOPAO_SOURCE_URL, tags: [], category: '', episodeCount: measured?.episodeCount ?? null, wordCount: null,
      serialStatus: null, publishedAt: null, metrics: measured?.metrics ?? [], rank: entry.rank, rankChange: null,
      board: `${LVPAOPAO_BOARD_PREFIX}${board.boardName}`, origin: 'live', observedAt: board.observedAt, sourceUpdatedAt: null,
      ...(measured ? { metricsObservedAt: measured.measuredAt } : {}),
    };
  });
}

/**
 * Sums one drama's per-episode counts; a total stays null when no episode reported that count.
 * @param reading Engagement reading of one drama.
 */
export function engagementTotals(reading: LvpaopaoEngagement): Metric[] {
  return ENGAGEMENT_KEYS.map(([key, label]) => {
    const values = reading.episodes.map(episode => episode[key]).filter((value): value is number => value !== null);
    return { key, label, value: values.length ? values.reduce((sum, value) => sum + value, 0) : null, unit: '次' };
  });
}

export interface LvpaopaoStoreOptions {
  /** Whether a collector token is configured; without it the status reads `not_configured`. */
  configured: boolean;
  /** Heartbeat silence after which the collector counts as offline. */
  offlineMs: number;
  alertsConfigured?: boolean;
  now?: () => number;
}

/** Owns the 绿泡泡 tables and derived collector status. */
export class LvpaopaoStore {
  private loginScreen: { png: Buffer; capturedAt: string; kind: 'qr' | 'confirm' | 'unknown'; receivedAt: number } | null = null;
  private readonly now: () => number;
  /** Serializes read-modify-write updates of `data_meta` entries. */
  private queue: Promise<unknown> = Promise.resolve();
  constructor(private readonly database: PGlite, private readonly repository: DataRepository, private readonly options: LvpaopaoStoreOptions) {
    this.now = options.now ?? Date.now;
  }

  async initialize(): Promise<void> {
    await this.database.exec(`
      CREATE TABLE IF NOT EXISTS lvpaopao_runs (run_id text PRIMARY KEY, kind text NOT NULL, status text NOT NULL, reason text,
        slot timestamptz NOT NULL, finished_at timestamptz NOT NULL, received_at timestamptz NOT NULL, sha256 text NOT NULL, summary jsonb NOT NULL);
      CREATE INDEX IF NOT EXISTS lvpaopao_runs_finished ON lvpaopao_runs(finished_at);
      CREATE TABLE IF NOT EXISTS lvpaopao_engagement (work_id text NOT NULL, observed_at timestamptz NOT NULL, payload jsonb NOT NULL,
        PRIMARY KEY(work_id, observed_at));
    `);
  }

  private iso(): string { return new Date(this.now()).toISOString(); }

  private serial<T>(task: () => Promise<T>): Promise<T> {
    const next = this.queue.then(task, task);
    this.queue = next.catch(() => undefined);
    return next;
  }

  private async readMeta<T>(key: string): Promise<T | null> {
    const row = (await this.database.query<{ value: string }>('SELECT value FROM data_meta WHERE key=$1', [key])).rows[0];
    return row ? JSON.parse(row.value) as T : null;
  }

  private async writeMeta(key: string, value: unknown): Promise<void> {
    await this.database.query('INSERT INTO data_meta(key,value) VALUES($1,$2) ON CONFLICT(key) DO UPDATE SET value=EXCLUDED.value', [key, JSON.stringify(value)]);
  }

  /** Latest engagement totals at or before `at` for the given works. */
  private async totalsBefore(ids: string[], at: string): Promise<Map<string, { metrics: Metric[]; measuredAt: string; episodeCount: number | null }>> {
    if (!ids.length) return new Map();
    const rows = await this.database.query<{ work_id: string; observed_at: Date; payload: LvpaopaoEngagement }>(`SELECT DISTINCT ON (work_id) work_id, observed_at, payload
      FROM lvpaopao_engagement WHERE work_id=ANY($1::text[]) AND observed_at <= $2::timestamptz ORDER BY work_id, observed_at DESC`, [ids, at]);
    return new Map(rows.rows.map(row => [row.work_id, { metrics: engagementTotals(row.payload), measuredAt: row.payload.observedAt, episodeCount: row.payload.episodeCount }]));
  }

  /**
   * Stores one uploaded run. Ranking boards become live board batches; engagement readings join the engagement history.
   * Data is written before the run row, and every write is idempotent, so an upload interrupted midway can be repeated.
   * @returns Whether the run was already stored, and the number of distinct dramas written.
   * @throws LvpaopaoConflictError when the `runId` exists with different content.
   */
  async ingestRun(run: LvpaopaoRun): Promise<{ duplicate: boolean; works: number }> {
    const sha256 = createHash('sha256').update(JSON.stringify(run)).digest('hex');
    const existing = (await this.database.query<{ sha256: string }>('SELECT sha256 FROM lvpaopao_runs WHERE run_id=$1', [run.runId])).rows[0];
    if (existing) {
      if (existing.sha256 !== sha256) throw new LvpaopaoConflictError();
      return { duplicate: true, works: 0 };
    }
    const dramas = new Set<string>();
    if (run.status !== 'failed') {
      for (const reading of run.engagement) {
        const id = `lvpaopao:${reading.srcAppId}:${reading.dramaId}`;
        dramas.add(id);
        await this.database.query('INSERT INTO lvpaopao_engagement(work_id,observed_at,payload) VALUES($1,$2,$3::jsonb) ON CONFLICT DO NOTHING',
          [id, reading.observedAt, JSON.stringify(reading)]);
      }
      for (const board of run.rankings) {
        if (!board.entries.length) continue;
        const ids = board.entries.map(entry => `lvpaopao:${entry.srcAppId}:${entry.dramaId}`);
        const works = boardWorks(board, await this.totalsBefore(ids, board.observedAt));
        for (const work of works) dramas.add(work.id);
        await this.repository.ingestBatch({ platform: 'lvpaopao', observedAt: board.observedAt, works,
          coverage: `绿泡泡 · ${board.boardName}：读取 ${board.entries.length} 条${board.total !== null ? `（平台共 ${board.total} 条）` : ''}${board.partial ? '，部分条目无效' : ''}` });
      }
    }
    const summary: LvpaopaoRunSummary = { runId: run.runId, kind: run.kind, slot: run.slot, status: run.status, reason: run.reason,
      finishedAt: run.finishedAt, receivedAt: this.iso(), boards: run.rankings.length, dramas: dramas.size };
    const inserted = await this.database.query(`INSERT INTO lvpaopao_runs(run_id,kind,status,reason,slot,finished_at,received_at,sha256,summary)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb) ON CONFLICT DO NOTHING RETURNING run_id`,
    [run.runId, run.kind, run.status, run.reason, run.slot, run.finishedAt, summary.receivedAt, sha256, JSON.stringify(summary)]);
    if (!inserted.rows.length) return this.ingestRun(run);
    if (run.status !== 'failed' && run.kind === 'rankings') {
      await this.repository.patchCollector('lvpaopao', { lastSuccessAt: run.finishedAt, count: await this.repository.countLiveWorks('lvpaopao'),
        coverage: `${run.rankings.length} 个榜单；最近一次 ${run.status === 'partial' ? '部分完成' : '完成'}` });
    }
    return { duplicate: false, works: dramas.size };
  }

  /**
   * Records a heartbeat and returns the commands the collector should run.
   * @param heartbeat Validated collector report.
   */
  async heartbeat(heartbeat: LvpaopaoHeartbeat): Promise<{ commands: Omit<LvpaopaoCommand, 'requestedBy'>[]; serverTime: string }> {
    await this.writeMeta(HEARTBEAT_KEY, { heartbeat, receivedAt: this.iso() } satisfies StoredHeartbeat);
    if (heartbeat.wechat.loggedIn) this.loginScreen = null;
    await this.syncCollectorStatus();
    const commands = await this.pendingCommands();
    return { commands: commands.map(({ id, action, issuedAt }) => ({ id, action, issuedAt })), serverTime: this.iso() };
  }

  private async pendingCommands(): Promise<LvpaopaoCommand[]> {
    const cutoff = this.now() - COMMAND_TTL_MS;
    return (await this.readMeta<LvpaopaoCommand[]>(COMMANDS_KEY) ?? []).filter(command => Date.parse(command.issuedAt) > cutoff);
  }

  /**
   * Queues a command for the collector; an identical pending command is returned instead of a second one.
   * @param action Command to run on the Mac.
   * @param requestedBy Name of the administrator.
   */
  enqueue(action: LvpaopaoAction, requestedBy: string): Promise<LvpaopaoCommand> {
    return this.serial(async () => {
      const pending = await this.pendingCommands();
      const same = pending.find(command => command.action === action);
      if (same) return same;
      const command: LvpaopaoCommand = { id: `c-${randomUUID()}`, action, issuedAt: this.iso(), requestedBy: requestedBy.slice(0, 80) };
      await this.writeMeta(COMMANDS_KEY, [...pending, command]);
      return command;
    });
  }

  /**
   * Removes an acknowledged command.
   * @returns Whether the command was pending.
   */
  acknowledge(id: string): Promise<boolean> {
    return this.serial(async () => {
      const pending = await this.pendingCommands();
      const rest = pending.filter(command => command.id !== id);
      await this.writeMeta(COMMANDS_KEY, rest);
      return rest.length !== pending.length;
    });
  }

  /** Keeps the latest login-window screenshot for administrators. */
  putLoginScreen(png: Buffer, capturedAt: string, kind: 'qr' | 'confirm' | 'unknown'): void {
    this.loginScreen = { png, capturedAt, kind, receivedAt: this.now() };
  }

  clearLoginScreen(): void { this.loginScreen = null; }

  /** The current login screenshot, or null once it is stale. */
  currentLoginScreen(): { png: Buffer; capturedAt: string; kind: 'qr' | 'confirm' | 'unknown' } | null {
    if (!this.loginScreen || this.now() - this.loginScreen.receivedAt > LOGIN_SCREEN_TTL_MS) return null;
    return this.loginScreen;
  }

  private derive(stored: StoredHeartbeat | null): LvpaopaoState {
    if (!this.options.configured) return 'not_configured';
    if (!stored) return 'never-connected';
    if (this.now() - Date.parse(stored.receivedAt) > this.options.offlineMs) return 'offline';
    return stored.heartbeat.state;
  }

  /** Member-visible status. */
  async status(): Promise<LvpaopaoStatus> {
    const stored = await this.readMeta<StoredHeartbeat>(HEARTBEAT_KEY);
    const state = this.derive(stored);
    const last = (await this.database.query<{ finished_at: Date }>(`SELECT max(finished_at) AS finished_at FROM lvpaopao_runs
      WHERE kind='rankings' AND status<>'failed'`)).rows[0]?.finished_at ?? null;
    const screen = this.currentLoginScreen();
    const heartbeat = stored?.heartbeat;
    const message = state === 'offline' ? `已超过 ${Math.round(this.options.offlineMs / 60_000)} 分钟没有收到 Mac 心跳，可能是 Mac 睡眠、断网或关机`
      : state === 'never-connected' ? '采集端还没有连上数据站；登录专用微信并安装采集端后自动开始'
        : state === 'not_configured' ? '服务器尚未配置采集端令牌' : heartbeat?.message ?? '';
    return {
      state, label: LVPAOPAO_STATE_LABELS[state], message, needsHuman: LVPAOPAO_HUMAN_STATES.includes(state),
      lastHeartbeatAt: stored?.receivedAt ?? null, lastSuccessAt: last ? new Date(last).toISOString() : null,
      nextSlot: heartbeat?.nextSlot ?? null, wechat: heartbeat?.wechat ?? null, pendingUploads: heartbeat?.pendingUploads ?? 0,
      loginScreen: screen ? { capturedAt: screen.capturedAt, kind: screen.kind } : null,
    };
  }

  /** Administrator status with recent runs and pending commands. */
  async adminStatus(): Promise<LvpaopaoAdminStatus> {
    const runs = await this.database.query<{ summary: LvpaopaoRunSummary }>('SELECT summary FROM lvpaopao_runs ORDER BY finished_at DESC LIMIT 20');
    return { ...await this.status(), runs: runs.rows.map(row => row.summary), commands: await this.pendingCommands(), alertsConfigured: this.options.alertsConfigured ?? false };
  }

  /** Mirrors the derived status into the shared collector card. */
  async syncCollectorStatus(): Promise<void> {
    const status = await this.status();
    const current = (await this.repository.collectors()).find(item => item.platform === 'lvpaopao');
    const state: CollectorStatus['state'] = status.state === 'collecting' ? 'running' : status.state === 'not_configured' || status.state === 'never-connected' ? 'not_configured'
      : status.state === 'ok' ? (status.lastSuccessAt ? 'success' : 'idle') : status.state === 'recovering' || status.state === 'offline-network' ? 'idle' : 'failed';
    await this.repository.updateCollector({
      platform: 'lvpaopao', state, lastSuccessAt: status.lastSuccessAt, lastAttemptAt: status.lastHeartbeatAt,
      message: `${status.label}${status.message ? `：${status.message}` : ''}`, coverage: current?.coverage && current.state !== 'not_configured' ? current.coverage : 'Mac 采集端推送的绿泡泡榜单与互动数',
      count: current?.count ?? 0, nextRunAt: status.nextSlot,
    });
  }

  /**
   * Decides whether the current state needs a notice: one alert when a state needing a person begins, one recovery notice
   * with the outage window when collection resumes. Repeated calls in the same state send nothing.
   */
  evaluate(): Promise<LvpaopaoNotice | null> {
    return this.serial(async () => {
      const status = await this.status();
      const previous = await this.readMeta<AlertState>(ALERT_KEY);
      const now = this.iso();
      const alerting = status.needsHuman || status.state === 'error';
      const healthy = status.state === 'ok' || status.state === 'collecting';
      if (previous?.state === status.state) return null;
      // An outage already reported stays open through intermediate states such as automatic recovery, so its end is still announced.
      const open = Boolean(previous?.notified) && !healthy;
      await this.writeMeta(ALERT_KEY, { state: status.state, since: open ? previous!.since : now, notified: alerting || open } satisfies AlertState);
      if (alerting) return { kind: 'alert', state: status.state, text: `【绿泡泡采集】${status.label}：${status.message}` };
      if (healthy && previous?.notified) {
        return { kind: 'recovered', state: status.state, text: `【绿泡泡采集】已恢复。中断时段 ${beijing(previous.since)} 至 ${beijing(now)}，这段时间的榜单没有采到。` };
      }
      return null;
    });
  }
}

function beijing(iso: string): string {
  return new Intl.DateTimeFormat('zh-CN', { timeZone: 'Asia/Shanghai', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date(iso));
}
