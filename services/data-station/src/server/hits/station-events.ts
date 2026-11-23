/**
 * Pushes 储备 job changes to the cloud Muse main Bot. The job event log (`transcription_job_events`) is the outbox: a cursor row
 * keeps the last event id the Bot acknowledged, so a failed or lost delivery is sent again and a restart replays nothing older.
 * Each delivery is signed with a shared secret over its timestamp and body.
 */
import { createHmac } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, open, realpath } from 'node:fs/promises';
import { isAbsolute, resolve } from 'node:path';
import type { PGlite } from '@electric-sql/pglite';

/** One job change as the main Bot receives it. */
export interface StationEvent {
  id: number;
  workId: string;
  title: string | null;
  at: string;
  from: string | null;
  to: string;
  actor: string;
  note: string | null;
}

/** Where and how often job changes are delivered. */
export interface StationEventOptions {
  /** The Bot's receiving route. */
  url: URL;
  /** Shared signing secret; never logged. */
  secret: string;
  /** Longest wait before ordinary changes go out together. */
  batchMs: number;
  /** How often the outbox is checked; 立即转写 and failures go out on the next check. */
  pollMs: number;
  /** Deadline of one delivery request. */
  requestTimeoutMs?: number;
  fetcher?: typeof fetch;
  now?: () => number;
}

/** Events read per delivery. */
const BATCH_LIMIT = 200;
const CURSOR = 'main-bot';

/**
 * Whether a change needs the Bot at once: a member's 立即转写 or a job that failed or needs attention.
 * @param event Change to classify.
 * @returns True when the change must not wait for the batch window.
 */
export function urgent(event: Pick<StationEvent, 'to' | 'note'>): boolean {
  return event.note === '立即转写' || event.to === 'failed' || event.to === 'needs-attention';
}

/**
 * Signs one delivery body.
 * @param secret Shared secret.
 * @param timestamp Milliseconds since the epoch, as sent in `x-muse-station-timestamp`.
 * @param body Exact request body.
 * @returns The `x-muse-station-signature` value.
 */
export function signDelivery(secret: string, timestamp: string, body: string): string {
  return 'sha256=' + createHmac('sha256', secret).update(`${timestamp}.${body}`).digest('hex');
}

/**
 * Reads the shared secret from a private file.
 * @param path Absolute path of a regular 0600 or 0640 file holding 32 to 4096 bytes, no symbolic links.
 * @returns The trimmed secret.
 */
export async function loadEventSecret(path: string): Promise<string> {
  const invalid = () => new Error('MUSE_DATA_STATION_EVENTS_SECRET_FILE must be a private regular file (0600 or 0640, no symbolic links) holding 32 to 4096 bytes');
  if (!isAbsolute(path) || resolve(path) !== path) throw invalid();
  try {
    const stat = await lstat(path);
    if (!stat.isFile() || ![0o600, 0o640].includes(stat.mode & 0o7777) || stat.size > 4_096 || await realpath(path) !== path) throw invalid();
    const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const secret = (await handle.readFile('utf8')).trim();
      if (secret.length < 32) throw invalid();
      return secret;
    } finally { await handle.close(); }
  } catch { throw invalid(); }
}

/** Delivers job changes past the cursor; one delivery at a time. */
export class StationEventSender {
  private timer: ReturnType<typeof setTimeout> | null = null;
  private running: Promise<unknown> | null = null;
  private stopped = false;
  private readonly now: () => number;

  constructor(private readonly database: PGlite, private readonly options: StationEventOptions) { this.now = options.now ?? Date.now; }

  /** Creates the cursor; a new cursor starts at the newest event, so history from before the Bot was connected is not replayed. */
  async initialize(): Promise<void> {
    await this.database.exec('CREATE TABLE IF NOT EXISTS station_event_cursor (name text PRIMARY KEY, last_id bigint NOT NULL, updated_at timestamptz NOT NULL)');
    await this.database.query(
      `INSERT INTO station_event_cursor(name,last_id,updated_at) SELECT $1, COALESCE(MAX(id),0), $2 FROM transcription_job_events ON CONFLICT (name) DO NOTHING`,
      [CURSOR, new Date(this.now()).toISOString()]);
  }

  /** Checks the outbox every `pollMs` until stopped. */
  start(): void {
    if (this.stopped || this.timer !== null) return;
    const tick = () => {
      this.timer = null;
      this.running = this.flush().catch(() => 0).finally(() => {
        this.running = null;
        if (!this.stopped) this.timer = setTimeout(tick, this.options.pollMs);
      });
    };
    this.timer = setTimeout(tick, this.options.pollMs);
  }

  /** Stops checking and waits for a delivery in progress. */
  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
    await this.running;
  }

  /**
   * Delivers pending changes when one is urgent, the oldest has waited `batchMs`, or `force` is set.
   * @param force Deliver whatever is pending without waiting for the batch window.
   * @returns How many changes the Bot acknowledged; 0 when nothing was due or the delivery failed.
   */
  async flush(force = false): Promise<number> {
    const cursor = await this.database.query<{ last_id: string | number }>('SELECT last_id FROM station_event_cursor WHERE name=$1', [CURSOR]);
    const last = Number(cursor.rows[0]?.last_id ?? 0);
    const rows = await this.database.query<{ id: string | number; work_id: string; at: Date; from_state: string | null; to_state: string; actor: string; note: string | null; title: string | null }>(
      `SELECT e.id, e.work_id, e.at, e.from_state, e.to_state, e.actor, e.note, w.payload->>'title' AS title
         FROM transcription_job_events e LEFT JOIN works w ON w.id = e.work_id
        WHERE e.id > $1 ORDER BY e.id LIMIT ${BATCH_LIMIT}`, [last]);
    if (rows.rows.length === 0) return 0;
    const events: StationEvent[] = rows.rows.map(row => ({
      id: Number(row.id), workId: row.work_id, title: row.title, at: new Date(row.at).toISOString(),
      from: row.from_state, to: row.to_state, actor: row.actor, note: row.note,
    }));
    const due = force || events.some(urgent) || this.now() - Date.parse(events[0]!.at) >= this.options.batchMs || events.length === BATCH_LIMIT;
    if (!due) return 0;
    const body = JSON.stringify({ deliveryId: `${events[0]!.id}-${events.at(-1)!.id}`, events });
    const timestamp = String(this.now());
    let response: Response;
    try {
      response = await (this.options.fetcher ?? fetch)(this.options.url, {
        method: 'POST', body, redirect: 'manual', signal: AbortSignal.timeout(this.options.requestTimeoutMs ?? 10_000),
        headers: { 'content-type': 'application/json', 'x-muse-station-timestamp': timestamp, 'x-muse-station-signature': signDelivery(this.options.secret, timestamp, body) },
      });
    } catch {
      console.warn('[muse-data-web] station events: delivery failed (unreachable)');
      return 0;
    }
    await response.body?.cancel();
    if (!response.ok) {
      console.warn(`[muse-data-web] station events: delivery refused (${response.status})`);
      return 0;
    }
    await this.database.query('UPDATE station_event_cursor SET last_id=$2, updated_at=$3 WHERE name=$1 AND last_id < $2', [CURSOR, events.at(-1)!.id, new Date(this.now()).toISOString()]);
    return events.length;
  }
}
