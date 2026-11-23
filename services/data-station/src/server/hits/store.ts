/**
 * Persistent state of the daily hit-transcription loop: detail-page readings, candidate evaluations,
 * one transcription job per drama with leases held by non-human workers, and an append-only event log.
 */
import { randomBytes } from 'node:crypto';
import type { PGlite } from '@electric-sql/pglite';
import { z } from 'zod';
import { ACTIVE_JOB_STATES, type ActiveJobState, type ClaimedJob, type DouyinTopicCheck, type HitBoardSummary, type HitEvaluation, type JobChecks, type JobLane, type TranscriptionJob, type TranscriptionJobState, type VideoArchive } from '../../shared/hits.ts';
import type { HongguoDetail } from '../collectors/hongguo-detail.ts';
import type { HitRules } from './rules.ts';

/** A job operation refused for a reason the caller can act on. */
export class HitJobError extends Error {
  constructor(message: string, readonly status: 400 | 404 | 409 | 422) { super(message); this.name = 'HitJobError'; }
}

/** The last detail-page attempt for a drama; `reading` is the last successful one and survives later failures. */
export interface DetailRecord { attemptedAt: string; outcome: 'success' | 'missing' | 'failed'; reading: HongguoDetail | null; }

/** A stored candidate evaluation. */
export interface CandidateRecord { qualified: boolean; firstQualifiedAt: string | null; ipKey: string | null; ipCheckedAt: string | null; evaluation: HitEvaluation; }

interface JobRow {
  work_id: string; state: TranscriptionJobState; lane: JobLane; priority: number | null;
  qualified_at: Date | string; queued_at: Date | string; rush_at: Date | string | null; requested_by: string | null;
  worker_id: string | null; lease_id: string | null; claimed_at: Date | string | null; heartbeat_at: Date | string | null; lease_expires_at: Date | string | null;
  attempts: number; progress: TranscriptionJob['progress']; videos: VideoArchive | null; script_id: string | null; checks: JobChecks | null;
  last_error: TranscriptionJob['lastError']; review: TranscriptionJob['review']; published_at: Date | string | null; created_at: Date | string; updated_at: Date | string;
}

const iso = (value: Date | string | null): string | null => value === null ? null : new Date(value).toISOString();
const ACTIVE: readonly string[] = ACTIVE_JOB_STATES;
const ORDER = `(rush_at IS NULL), rush_at ASC, CASE lane WHEN 'manual' THEN 0 WHEN 'new' THEN 1 ELSE 2 END,
  CASE WHEN lane='new' THEN qualified_at END ASC, priority DESC NULLS LAST, qualified_at ASC, work_id ASC`;

function toJob(row: JobRow): TranscriptionJob {
  return {
    workId: row.work_id, sourceId: row.work_id.replace(/^hongguo:/, ''), state: row.state, lane: row.lane, priority: row.priority,
    qualifiedAt: iso(row.qualified_at)!, queuedAt: iso(row.queued_at)!, rushAt: iso(row.rush_at), requestedBy: row.requested_by,
    workerId: row.worker_id, claimedAt: iso(row.claimed_at), heartbeatAt: iso(row.heartbeat_at), leaseExpiresAt: iso(row.lease_expires_at),
    attempts: row.attempts, progress: row.progress, videos: row.videos, scriptId: row.script_id, checks: row.checks,
    lastError: row.last_error, review: row.review ?? null, publishedAt: iso(row.published_at), createdAt: iso(row.created_at)!, updatedAt: iso(row.updated_at)!,
  };
}

/** Input of `drama_tos_upload` (Muse commit 928501c6b2); unknown fields are ignored and URLs are rebuilt from keys. */
const tosObject = z.object({
  kind: z.string().min(1).max(40), key: z.string().min(1).max(1024),
  bytes: z.number().int().nonnegative().safe().nullish(), sha256: z.string().regex(/^[0-9a-fA-F]{64}$/).nullish(), status: z.string().max(40).nullish(),
}).passthrough();
export const tosUploadSchema = z.object({
  bucket: z.string().min(1).max(63), date: z.string().regex(/^\d{8}$/), directory: z.string().min(1).max(1024),
  objects: z.array(tosObject).max(5_000), manifest: z.object({ key: z.string().min(1).max(1024) }).passthrough(),
}).passthrough();
export type TosUpload = z.infer<typeof tosUploadSchema>;

/** Worker progress input; stages may move freely among the active states (a failed check can return to transcribing). */
export const progressSchema = z.object({
  state: z.enum(ACTIVE_JOB_STATES).optional(),
  episode: z.number().int().min(0).max(100_000).nullish(),
  totalEpisodes: z.number().int().min(1).max(100_000).nullish(),
  message: z.string().max(500).nullish(),
}).refine(value => value.episode == null || value.totalEpisodes == null || value.episode <= value.totalEpisodes, { message: 'episode exceeds totalEpisodes' });
export type ProgressInput = z.infer<typeof progressSchema>;

export const failureSchema = z.object({
  reason: z.string().trim().min(1).max(1_000), stage: z.string().max(40).nullish(),
  /** True (default) re-queues the job while it has attempts left. */
  retryable: z.boolean().default(true),
  /** True sends the job to 待处理 at once, e.g. after the program checks failed twice. */
  needsAttention: z.boolean().default(false),
});
export type FailureInput = z.input<typeof failureSchema>;

function validDate(value: string): boolean {
  const text = `${value.slice(0, 4)}-${value.slice(4, 6)}-${value.slice(6, 8)}`;
  return !Number.isNaN(Date.parse(`${text}T00:00:00Z`)) && new Date(`${text}T00:00:00Z`).toISOString().startsWith(text);
}

/** Owns the loop's tables. All job transitions are single conditional statements, so concurrent claims cannot both win. */
export class HitStore {
  private readonly now: () => number;
  constructor(readonly database: PGlite, private rules: HitRules, now?: () => number) { this.now = now ?? Date.now; }

  /** Replaces the rules used for leases, attempts and video validation. */
  setRules(rules: HitRules): void { this.rules = rules; }
  private time(offset = 0): string { return new Date(this.now() + offset).toISOString(); }

  async initialize(): Promise<void> {
    await this.database.exec(`
      CREATE TABLE IF NOT EXISTS hongguo_details (work_id text PRIMARY KEY REFERENCES works(id), attempted_at timestamptz NOT NULL,
        outcome text NOT NULL CHECK (outcome IN ('success','missing','failed')), reading jsonb);
      CREATE TABLE IF NOT EXISTS hit_candidates (work_id text PRIMARY KEY REFERENCES works(id), qualified boolean NOT NULL,
        first_qualified_at timestamptz, evaluated_at timestamptz NOT NULL, ip_key text, ip_checked_at timestamptz, evaluation jsonb NOT NULL);
      CREATE INDEX IF NOT EXISTS hit_candidates_qualified ON hit_candidates(qualified);
      CREATE TABLE IF NOT EXISTS transcription_jobs (
        work_id text PRIMARY KEY REFERENCES works(id),
        state text NOT NULL CHECK (state IN ('queued','downloading','transcribing','checking','published','failed','needs-attention','rejected')),
        lane text NOT NULL CHECK (lane IN ('manual','new','backlog')), priority double precision,
        qualified_at timestamptz NOT NULL, queued_at timestamptz NOT NULL, rush_at timestamptz, requested_by text,
        worker_id text, lease_id text, claimed_at timestamptz, heartbeat_at timestamptz, lease_expires_at timestamptz,
        attempts integer NOT NULL DEFAULT 0, progress jsonb, videos jsonb, script_id text, checks jsonb, last_error jsonb,
        published_at timestamptz, created_at timestamptz NOT NULL, updated_at timestamptz NOT NULL);
      CREATE INDEX IF NOT EXISTS transcription_jobs_state ON transcription_jobs(state);
      CREATE TABLE IF NOT EXISTS transcription_job_events (id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY, work_id text NOT NULL,
        at timestamptz NOT NULL, from_state text, to_state text NOT NULL, actor text NOT NULL, note text);
      CREATE INDEX IF NOT EXISTS transcription_job_events_work ON transcription_job_events(work_id, at);
      -- Tables created before 选材复核 lack the rejected state and the review column.
      ALTER TABLE transcription_jobs ADD COLUMN IF NOT EXISTS review jsonb;
      ALTER TABLE transcription_jobs DROP CONSTRAINT IF EXISTS transcription_jobs_state_check;
      ALTER TABLE transcription_jobs ADD CONSTRAINT transcription_jobs_state_check
        CHECK (state IN ('queued','downloading','transcribing','checking','published','failed','needs-attention','rejected'));
      CREATE TABLE IF NOT EXISTS douyin_topics (work_id text PRIMARY KEY REFERENCES works(id), checked_at timestamptz NOT NULL, result jsonb NOT NULL);
    `);
  }

  private async event(workId: string, from: string | null, to: string, actor: string, note: string | null = null): Promise<void> {
    await this.database.query('INSERT INTO transcription_job_events(work_id,at,from_state,to_state,actor,note) VALUES($1,$2,$3,$4,$5,$6)',
      [workId, this.time(), from, to, actor.slice(0, 200), note?.slice(0, 1_000) ?? null]);
  }

  /** Events of one job, oldest first. */
  async events(workId: string): Promise<{ at: string; from: string | null; to: string; actor: string; note: string | null }[]> {
    const rows = await this.database.query<{ at: Date; from_state: string | null; to_state: string; actor: string; note: string | null }>(
      'SELECT at,from_state,to_state,actor,note FROM transcription_job_events WHERE work_id=$1 ORDER BY id', [workId]);
    return rows.rows.map(row => ({ at: iso(row.at)!, from: row.from_state, to: row.to_state, actor: row.actor, note: row.note }));
  }

  // ---------------------------------------------------------------- detail readings and evaluations

  async details(): Promise<Map<string, DetailRecord>> {
    const rows = await this.database.query<{ work_id: string; attempted_at: Date; outcome: DetailRecord['outcome']; reading: HongguoDetail | null }>('SELECT work_id,attempted_at,outcome,reading FROM hongguo_details');
    return new Map(rows.rows.map(row => [row.work_id, { attemptedAt: iso(row.attempted_at)!, outcome: row.outcome, reading: row.reading }]));
  }

  /** The detail read of one work, if any. */
  async detail(workId: string): Promise<DetailRecord | undefined> {
    const row = (await this.database.query<{ attempted_at: Date; outcome: DetailRecord['outcome']; reading: HongguoDetail | null }>('SELECT attempted_at,outcome,reading FROM hongguo_details WHERE work_id=$1', [workId])).rows[0];
    return row && { attemptedAt: iso(row.attempted_at)!, outcome: row.outcome, reading: row.reading };
  }

  async recordDetail(workId: string, outcome: DetailRecord['outcome'], reading: HongguoDetail | null = null): Promise<void> {
    await this.database.query(`INSERT INTO hongguo_details(work_id,attempted_at,outcome,reading) VALUES($1,$2,$3,$4::jsonb)
      ON CONFLICT(work_id) DO UPDATE SET attempted_at=EXCLUDED.attempted_at,outcome=EXCLUDED.outcome,reading=COALESCE(EXCLUDED.reading,hongguo_details.reading)`,
    [workId, this.time(), outcome, reading ? JSON.stringify(reading) : null]);
  }

  /** The last Douyin topic check of each drama. */
  async topics(): Promise<Map<string, DouyinTopicCheck>> {
    const rows = await this.database.query<{ work_id: string; result: DouyinTopicCheck }>('SELECT work_id,result FROM douyin_topics');
    return new Map(rows.rows.map(row => [row.work_id, row.result]));
  }

  async recordTopic(workId: string, check: DouyinTopicCheck): Promise<void> {
    await this.database.query(`INSERT INTO douyin_topics(work_id,checked_at,result) VALUES($1,$2,$3::jsonb)
      ON CONFLICT(work_id) DO UPDATE SET checked_at=EXCLUDED.checked_at,result=EXCLUDED.result`, [workId, check.checkedAt, JSON.stringify(check)]);
  }

  async candidates(): Promise<Map<string, CandidateRecord>> {
    return this.candidateRows('SELECT work_id,qualified,first_qualified_at,ip_key,ip_checked_at,evaluation FROM hit_candidates', []);
  }

  /**
   * Candidate records of the given works only; reading every evaluation takes seconds once the selector has scored
   * thousands of dramas, and the database serves one query at a time.
   */
  async candidatesFor(workIds: readonly string[]): Promise<Map<string, CandidateRecord>> {
    if (!workIds.length) return new Map();
    return this.candidateRows('SELECT work_id,qualified,first_qualified_at,ip_key,ip_checked_at,evaluation FROM hit_candidates WHERE work_id = ANY($1::text[])', [[...workIds]]);
  }

  /** IDs of qualifying candidates, without their evaluations. */
  async qualifiedIds(): Promise<string[]> {
    return (await this.database.query<{ work_id: string }>('SELECT work_id FROM hit_candidates WHERE qualified')).rows.map(row => row.work_id);
  }

  private async candidateRows(sql: string, params: unknown[]): Promise<Map<string, CandidateRecord>> {
    const rows = await this.database.query<{ work_id: string; qualified: boolean; first_qualified_at: Date | null; ip_key: string | null; ip_checked_at: Date | null; evaluation: HitEvaluation }>(sql, params);
    return new Map(rows.rows.map(row => [row.work_id, { qualified: row.qualified, firstQualifiedAt: iso(row.first_qualified_at), ipKey: row.ip_key, ipCheckedAt: iso(row.ip_checked_at), evaluation: row.evaluation }]));
  }

  /**
   * Upserts evaluations in one transaction, then vacuums the table; the first qualifying time is kept once set.
   * @returns Each work's first qualifying time after the write.
   */
  async saveEvaluations(items: { workId: string; evaluation: HitEvaluation; ipKey: string | null; ipCheckedAt: string | null }[]): Promise<Map<string, string | null>> {
    const result = new Map<string, string | null>();
    if (!items.length) return result;
    await this.database.transaction(async transaction => {
      for (const item of items) {
        const row = await transaction.query<{ first_qualified_at: Date | null }>(`INSERT INTO hit_candidates(work_id,qualified,first_qualified_at,evaluated_at,ip_key,ip_checked_at,evaluation)
          VALUES($1,$2,CASE WHEN $2 THEN $3::timestamptz END,$3,$4,$5,$6::jsonb)
          ON CONFLICT(work_id) DO UPDATE SET qualified=EXCLUDED.qualified,
            first_qualified_at=COALESCE(hit_candidates.first_qualified_at,EXCLUDED.first_qualified_at),
            evaluated_at=EXCLUDED.evaluated_at,ip_key=EXCLUDED.ip_key,ip_checked_at=EXCLUDED.ip_checked_at,evaluation=EXCLUDED.evaluation
          RETURNING first_qualified_at`, [item.workId, item.evaluation.qualified, item.evaluation.evaluatedAt, item.ipKey, item.ipCheckedAt, JSON.stringify(item.evaluation)]);
        result.set(item.workId, iso(row.rows[0]!.first_qualified_at));
      }
    });
    // A selection pass rewrites most rows and the embedded database has no autovacuum; without this the table grew to
    // gigabytes of dead rows and every board read scanned them from disk.
    await this.database.query('VACUUM hit_candidates');
    return result;
  }

  /** Earliest observation of each work, for the new-work lane. */
  async firstSeen(workIds: string[]): Promise<Map<string, string>> {
    if (!workIds.length) return new Map();
    const rows = await this.database.query<{ work_id: string; first: Date }>('SELECT work_id,min(observed_at) AS first FROM observations WHERE work_id=ANY($1::text[]) GROUP BY work_id', [workIds]);
    return new Map(rows.rows.map(row => [row.work_id, iso(row.first)!]));
  }

  // ---------------------------------------------------------------- jobs

  async job(workId: string): Promise<TranscriptionJob | null> {
    const row = (await this.database.query<JobRow>('SELECT * FROM transcription_jobs WHERE work_id=$1', [workId])).rows[0];
    return row ? toJob(row) : null;
  }

  /** All jobs, queued ones in claim order first. */
  async jobs(): Promise<TranscriptionJob[]> {
    await this.sweep();
    return (await this.database.query<JobRow>(`SELECT * FROM transcription_jobs ORDER BY (state<>'queued'), ${ORDER}`)).rows.map(toJob);
  }

  /** Queued jobs in the order claims will take them. */
  async queue(limit = 100): Promise<TranscriptionJob[]> {
    await this.sweep();
    return (await this.database.query<JobRow>(`SELECT * FROM transcription_jobs WHERE state='queued' ORDER BY ${ORDER} LIMIT $1`, [limit])).rows.map(toJob);
  }

  /**
   * Adds a queued job for a qualifying work; an existing job of any state is left unchanged.
   * @returns True when a job was created.
   */
  async enqueue(workId: string, input: { lane: Exclude<JobLane, 'manual'>; qualifiedAt: string; priority: number | null }): Promise<boolean> {
    const now = this.time();
    const inserted = await this.database.query(`INSERT INTO transcription_jobs(work_id,state,lane,priority,qualified_at,queued_at,created_at,updated_at)
      VALUES($1,'queued',$2,$3,$4,$5,$5,$5) ON CONFLICT(work_id) DO NOTHING RETURNING work_id`, [workId, input.lane, input.priority, input.qualifiedAt, now]);
    if (!inserted.rows.length) return false;
    await this.event(workId, null, 'queued', 'selection', input.lane === 'new' ? '新上榜作品入选' : '储备作品入选');
    return true;
  }

  /** Removes an untouched automatic job whose work no longer qualifies. */
  async withdraw(workId: string, reason: string): Promise<boolean> {
    const removed = await this.database.query(`DELETE FROM transcription_jobs WHERE work_id=$1 AND state='queued' AND lane<>'manual' AND attempts=0 AND rush_at IS NULL RETURNING work_id`, [workId]);
    if (!removed.rows.length) return false;
    await this.event(workId, 'queued', 'withdrawn', 'selection', reason);
    return true;
  }

  /** Updates the backlog ordering value of a queued job. */
  async setPriority(workId: string, priority: number | null): Promise<void> {
    await this.database.query(`UPDATE transcription_jobs SET priority=$2 WHERE work_id=$1 AND state='queued' AND priority IS DISTINCT FROM $2`, [workId, priority]);
  }

  /**
   * 立即转写: moves a work to the front of the queue, creating a manual job when it has none and re-queuing a failed one.
   * @throws HitJobError 409 while a worker holds it or once it is published.
   */
  async rush(workId: string, requestedBy: string, input: { qualifiedAt: string | null; priority: number | null }): Promise<TranscriptionJob> {
    await this.sweep();
    const now = this.time();
    const inserted = await this.database.query<JobRow>(`INSERT INTO transcription_jobs(work_id,state,lane,priority,qualified_at,queued_at,rush_at,requested_by,created_at,updated_at)
      VALUES($1,'queued','manual',$2,$3,$4,$4,$5,$4,$4) ON CONFLICT(work_id) DO NOTHING RETURNING *`, [workId, input.priority, input.qualifiedAt ?? now, now, requestedBy]);
    if (inserted.rows[0]) { await this.event(workId, null, 'queued', requestedBy, '立即转写'); return toJob(inserted.rows[0]); }
    const current = (await this.job(workId))!;
    if (ACTIVE.includes(current.state)) throw new HitJobError('这部剧正在转写中', 409);
    if (current.state === 'published') throw new HitJobError('这部剧已有剧本', 409);
    const updated = await this.database.query<JobRow>(`UPDATE transcription_jobs SET state='queued',rush_at=COALESCE(rush_at,$2),requested_by=$3,
      attempts=CASE WHEN state='queued' THEN attempts ELSE 0 END,queued_at=CASE WHEN state='queued' THEN queued_at ELSE $2 END,
      worker_id=CASE WHEN state='queued' THEN worker_id END,lease_id=NULL,lease_expires_at=NULL,updated_at=$2,
      lane=CASE WHEN state='rejected' THEN 'manual' ELSE lane END
      WHERE work_id=$1 AND state IN ('queued','failed','needs-attention','rejected') RETURNING *`, [workId, now, requestedBy]);
    if (!updated.rows[0]) throw new HitJobError('任务状态已变化，请刷新后重试', 409);
    await this.event(workId, current.state, 'queued', requestedBy, '立即转写');
    return toJob(updated.rows[0]);
  }

  /**
   * Returns jobs whose worker stopped reporting: re-queued with their progress kept, or 待处理 after the last attempt.
   * Runs before every claim and listing.
   */
  async sweep(): Promise<number> {
    const now = this.time();
    const expired = await this.database.query<{ work_id: string; previous: string; state: string }>(`UPDATE transcription_jobs AS job SET
        state=CASE WHEN job.attempts >= $2 THEN 'needs-attention' ELSE 'queued' END,
        last_error=jsonb_build_object('at',$1::text,'reason','工人超过租约时间未汇报','stage',job.state),
        lease_id=NULL,lease_expires_at=NULL,queued_at=CASE WHEN job.attempts >= $2 THEN job.queued_at ELSE $1::timestamptz END,updated_at=$1
      FROM (SELECT work_id,state AS previous FROM transcription_jobs WHERE state IN ('downloading','transcribing','checking') AND lease_expires_at < $1::timestamptz) AS old
      WHERE job.work_id=old.work_id RETURNING job.work_id,old.previous,job.state`, [now, this.rules.queue.maxAttempts]);
    for (const row of expired.rows) await this.event(row.work_id, row.previous, row.state, 'station', '租约过期');
    return expired.rows.length;
  }

  private leaseEnd(): string { return this.time(this.rules.queue.leaseMinutes * 60_000); }

  /**
   * Claims a job for a worker. Repeating a claim with the same worker returns the same lease (idempotent);
   * a work held by another live worker is refused.
   * @param input `workId` claims that work; without it, the first queued job in priority order.
   * @returns The claimed job and lease, or null when nothing is queued.
   */
  async claim(input: { workerId: string; workId?: string }): Promise<ClaimedJob | null> {
    await this.sweep();
    const now = this.time();
    const held = await this.database.query<JobRow>(`SELECT * FROM transcription_jobs WHERE worker_id=$1 AND state IN ('downloading','transcribing','checking')
      AND lease_id IS NOT NULL ${input.workId ? 'AND work_id=$2' : ''} ORDER BY claimed_at DESC LIMIT 1`, input.workId ? [input.workerId, input.workId] : [input.workerId]);
    if (held.rows[0]) return { job: toJob(held.rows[0]), lease: held.rows[0].lease_id! };
    const lease = randomBytes(24).toString('base64url');
    const target = input.workId ? '$5' : `(SELECT work_id FROM transcription_jobs WHERE state='queued' ORDER BY ${ORDER} LIMIT 1)`;
    const claimed = await this.database.query<JobRow>(`UPDATE transcription_jobs SET state='downloading',worker_id=$1,lease_id=$2,claimed_at=$3,heartbeat_at=$3,
      lease_expires_at=$4,attempts=attempts+1,updated_at=$3 WHERE work_id=${target} AND state='queued' RETURNING *`,
    input.workId ? [input.workerId, lease, now, this.leaseEnd(), input.workId] : [input.workerId, lease, now, this.leaseEnd()]);
    const row = claimed.rows[0];
    if (row) {
      await this.event(row.work_id, 'queued', 'downloading', input.workerId, `第 ${row.attempts} 次领取`);
      return { job: toJob(row), lease };
    }
    if (!input.workId) return null;
    const current = await this.job(input.workId);
    if (!current) throw new HitJobError('这部剧没有转写任务', 404);
    if (ACTIVE.includes(current.state)) throw new HitJobError('这部剧已由其他工人领取', 409);
    if (current.state === 'published') throw new HitJobError('这部剧已有剧本', 409);
    throw new HitJobError(`任务处于「${current.state}」，需要成员点「立即转写」后才能再次领取`, 409);
  }

  /** Whether this lease is the job's current or publishing lease, whatever its state. */
  async ownsLease(workId: string, lease: string): Promise<boolean> {
    return (await this.database.query('SELECT 1 FROM transcription_jobs WHERE work_id=$1 AND lease_id=$2', [workId, lease])).rows.length > 0;
  }

  /** Checks that a lease still holds an active job. */
  async assertLease(workId: string, lease: string): Promise<TranscriptionJob> {
    await this.sweep();
    const row = (await this.database.query<JobRow>('SELECT * FROM transcription_jobs WHERE work_id=$1', [workId])).rows[0];
    if (!row) throw new HitJobError('这部剧没有转写任务', 404);
    if (!row.lease_id || row.lease_id !== lease) throw new HitJobError('租约已失效，请重新领取', 409);
    if (!ACTIVE.includes(row.state)) throw new HitJobError('任务不在进行中', 409);
    return toJob(row);
  }

  /** Records a stage and episode progress, and extends the lease (also usable as a bare heartbeat). */
  async progress(workId: string, lease: string, input: ProgressInput): Promise<TranscriptionJob> {
    const job = await this.assertLease(workId, lease);
    const state: ActiveJobState = input.state ?? job.state as ActiveJobState;
    const moved = state !== job.state;
    const previous = job.progress;
    const progress = {
      episode: input.episode !== undefined ? input.episode : moved ? null : previous?.episode ?? null,
      totalEpisodes: input.totalEpisodes !== undefined ? input.totalEpisodes : previous?.totalEpisodes ?? null,
      message: input.message !== undefined ? input.message : moved ? null : previous?.message ?? null,
      updatedAt: this.time(),
    };
    if (progress.episode != null && progress.totalEpisodes != null && progress.episode > progress.totalEpisodes) throw new HitJobError('已完成集数超过总集数', 400);
    const updated = await this.database.query<JobRow>(`UPDATE transcription_jobs SET state=$3,progress=$4::jsonb,heartbeat_at=$5,lease_expires_at=$6,updated_at=$5
      WHERE work_id=$1 AND lease_id=$2 AND state IN ('downloading','transcribing','checking') RETURNING *`,
    [workId, lease, state, JSON.stringify(progress), this.time(), this.leaseEnd()]);
    if (!updated.rows[0]) throw new HitJobError('租约已失效，请重新领取', 409);
    if (moved) await this.event(workId, job.state, state, job.workerId ?? 'worker');
    return toJob(updated.rows[0]);
  }

  /**
   * Validates a `drama_tos_upload` result against this drama's fixed folder and stores it with station-built public URLs.
   * Allowed while the lease holds the job, and after publishing with the lease that published it.
   */
  async recordVideos(workId: string, lease: string, upload: TosUpload): Promise<TranscriptionJob> {
    const row = (await this.database.query<JobRow>('SELECT * FROM transcription_jobs WHERE work_id=$1', [workId])).rows[0];
    if (!row) throw new HitJobError('这部剧没有转写任务', 404);
    if (!row.lease_id || row.lease_id !== lease || !(ACTIVE.includes(row.state) || row.state === 'published')) throw new HitJobError('租约已失效，请重新领取', 409);
    if (ACTIVE.includes(row.state)) await this.assertLease(workId, lease);
    const archive = this.archive(row.work_id.replace(/^hongguo:/, ''), upload);
    const updated = await this.database.query<JobRow>('UPDATE transcription_jobs SET videos=$3::jsonb,updated_at=$4 WHERE work_id=$1 AND lease_id=$2 RETURNING *',
      [workId, lease, JSON.stringify(archive), this.time()]);
    if (!updated.rows[0]) throw new HitJobError('租约已失效，请重新领取', 409);
    await this.event(workId, row.state, row.state, row.worker_id ?? 'worker', `原片归档 ${archive.objects.length} 个对象`);
    return toJob(updated.rows[0]);
  }

  /** Builds the stored archive; every key must sit under `<root>/hongguo/<date>/<seriesId>/` in the configured bucket. */
  archive(seriesId: string, upload: TosUpload): VideoArchive {
    const { bucket, root, publicOrigin } = this.rules.videos;
    if (upload.bucket !== bucket) throw new HitJobError(`只接受 ${bucket} 桶`, 422);
    if (!validDate(upload.date)) throw new HitJobError('日期必须是 YYYYMMDD', 422);
    const directory = `${root}/hongguo/${upload.date}/${seriesId}/`;
    if (upload.directory.replace(/\/?$/, '/') !== directory) throw new HitJobError(`目录必须是 ${directory}`, 422);
    const safeKey = (key: string) => key.startsWith(directory) && key.length > directory.length && !/(^|\/)\.\.?(\/|$)|\/\/|[\\\x00-\x1f\x7f]/.test(key);
    if (!safeKey(upload.manifest.key) || upload.objects.some(object => !safeKey(object.key))) throw new HitJobError(`对象路径必须位于 ${directory} 内`, 422);
    const url = (key: string) => `${publicOrigin}/${key.split('/').map(encodeURIComponent).join('/')}`;
    return {
      bucket, date: upload.date, directory, directoryUrl: url(directory.slice(0, -1)) + '/',
      manifest: { key: upload.manifest.key, url: url(upload.manifest.key) },
      objects: upload.objects.map(object => ({ kind: object.kind, key: object.key, url: url(object.key), bytes: object.bytes ?? null,
        sha256: object.sha256?.toLowerCase() ?? null, status: object.status ?? null })),
      recordedAt: this.time(),
    };
  }

  /** Marks the job published after its script entered the library; the lease stays valid for a later video record. */
  async publish(workId: string, lease: string, scriptId: string, checks: JobChecks | null): Promise<TranscriptionJob> {
    const existing = await this.job(workId);
    if (existing?.state === 'published' && existing.scriptId === scriptId) return existing;
    const job = await this.assertLease(workId, lease);
    const now = this.time();
    const updated = await this.database.query<JobRow>(`UPDATE transcription_jobs SET state='published',script_id=$3,checks=$4::jsonb,published_at=$5,
      lease_expires_at=NULL,progress=COALESCE(progress,'{}'::jsonb) || jsonb_build_object('updatedAt',$6::text),updated_at=$5
      WHERE work_id=$1 AND lease_id=$2 AND state IN ('downloading','transcribing','checking') RETURNING *`, [workId, lease, scriptId, checks ? JSON.stringify(checks) : null, now, now]);
    if (!updated.rows[0]) throw new HitJobError('租约已失效，请重新领取', 409);
    await this.event(workId, job.state, 'published', job.workerId ?? 'worker', `剧本 ${scriptId}`);
    return toJob(updated.rows[0]);
  }

  /**
   * Records a worker failure: re-queued while attempts remain and the failure is retryable, `failed` afterwards,
   * or `needs-attention` when the worker says so (program checks did not pass).
   */
  async fail(workId: string, lease: string, input: FailureInput): Promise<TranscriptionJob> {
    const failure = failureSchema.parse(input);
    const job = await this.assertLease(workId, lease);
    const next: TranscriptionJobState = failure.needsAttention ? 'needs-attention'
      : failure.retryable && job.attempts < this.rules.queue.maxAttempts ? 'queued' : 'failed';
    const now = this.time();
    const updated = await this.database.query<JobRow>(`UPDATE transcription_jobs SET state=$3,last_error=$4::jsonb,lease_id=NULL,lease_expires_at=NULL,
      queued_at=CASE WHEN $3='queued' THEN $5::timestamptz ELSE queued_at END,updated_at=$5
      WHERE work_id=$1 AND lease_id=$2 AND state IN ('downloading','transcribing','checking') RETURNING *`,
    [workId, lease, next, JSON.stringify({ at: now, reason: failure.reason, stage: failure.stage ?? job.state }), now]);
    if (!updated.rows[0]) throw new HitJobError('租约已失效，请重新领取', 409);
    await this.event(workId, job.state, next, job.workerId ?? 'worker', failure.reason);
    return toJob(updated.rows[0]);
  }

  /**
   * 选材复核 rejection: the worker judged the whole drama's audience outside the selection standard.
   * Allowed in any active stage with a valid lease; the job ends as `rejected` and is never re-queued by the selection.
   */
  async reject(workId: string, lease: string, reason: string): Promise<TranscriptionJob> {
    const text = reason.trim();
    if (!text || text.length > 500) throw new HitJobError('淘汰理由需要 1–500 字', 400);
    const job = await this.assertLease(workId, lease);
    const now = this.time();
    const updated = await this.database.query<JobRow>(`UPDATE transcription_jobs SET state='rejected',review=$3::jsonb,lease_id=NULL,lease_expires_at=NULL,updated_at=$4
      WHERE work_id=$1 AND lease_id=$2 AND state IN ('downloading','transcribing','checking') RETURNING *`,
    [workId, lease, JSON.stringify({ rejectedAt: now, reason: text, workerId: job.workerId }), now]);
    if (!updated.rows[0]) throw new HitJobError('租约已失效，请重新领取', 409);
    await this.event(workId, job.state, 'rejected', job.workerId ?? 'worker', text);
    return toJob(updated.rows[0]);
  }

  /** Board totals. `dayStart` is the latest Beijing midnight. */
  async summary(): Promise<Omit<HitBoardSummary, 'candidates'> & { candidates: number }> {
    await this.sweep();
    const now = this.now();
    const dayStart = new Date(Math.floor((now + 8 * 3_600_000) / 86_400_000) * 86_400_000 - 8 * 3_600_000).toISOString();
    const since = new Date(now - this.rules.queue.summaryWindowDays * 86_400_000).toISOString();
    const counts = (await this.database.query<{ today: number; failures: number; rejected: number; queued: number; active: number; average: number | null }>(`SELECT
      count(*) FILTER (WHERE state='published' AND published_at >= $1)::int AS today,
      count(*) FILTER (WHERE state IN ('failed','needs-attention'))::int AS failures,
      count(*) FILTER (WHERE state='rejected')::int AS rejected,
      count(*) FILTER (WHERE state='queued')::int AS queued,
      count(*) FILTER (WHERE state IN ('downloading','transcribing','checking'))::int AS active,
      avg(extract(epoch FROM published_at - qualified_at)) FILTER (WHERE state='published' AND published_at >= $2)::float8 AS average
      FROM transcription_jobs`, [dayStart, since])).rows[0]!;
    const candidates = (await this.database.query<{ count: number }>('SELECT count(*)::int AS count FROM hit_candidates WHERE qualified')).rows[0]!.count;
    let stock = 0;
    if ((await this.database.query<{ exists: boolean }>("SELECT to_regclass('script_artifacts') IS NOT NULL AS exists")).rows[0]!.exists) {
      stock = (await this.database.query<{ count: number }>("SELECT count(DISTINCT work_id)::int AS count FROM script_artifacts WHERE work_id LIKE 'hongguo:%'")).rows[0]!.count;
    }
    return { stock, addedToday: counts.today, averageHoursToDownload: counts.average === null ? null : Math.round(counts.average / 360) / 10,
      averageWindowDays: this.rules.queue.summaryWindowDays, failures: counts.failures, rejected: counts.rejected, queued: counts.queued, active: counts.active, candidates };
  }
}
