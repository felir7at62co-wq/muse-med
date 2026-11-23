/** Periodic 绿泡泡 status check that refreshes the collector card and sends Feishu notices on state changes. */
import { constants } from 'node:fs';
import { lstat, open, realpath } from 'node:fs/promises';
import { isAbsolute, resolve } from 'node:path';
import type { LvpaopaoStore } from './store.ts';

/** Sends one plain-text notice; failures are reported to the caller. */
export type NoticeSender = (text: string) => Promise<void>;

/**
 * Reads a Feishu custom-bot webhook URL from a private file (absolute, regular, 0600 or 0640, no symbolic links, at most 4 KiB).
 * @throws Without revealing the file contents.
 */
export async function loadFeishuWebhook(path: string): Promise<URL> {
  const invalid = () => new Error('MUSE_DATA_LVPAOPAO_ALERT_WEBHOOK_FILE must be a private regular file (0600 or 0640, no symbolic links) holding one https://open.feishu.cn webhook URL');
  if (!isAbsolute(path) || resolve(path) !== path) throw invalid();
  try {
    const stat = await lstat(path);
    if (!stat.isFile() || ![0o600, 0o640].includes(stat.mode & 0o7777) || stat.size === 0 || stat.size > 4_096 || await realpath(path) !== path) throw invalid();
    const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const url = new URL((await handle.readFile('utf8')).trim());
      if (url.protocol !== 'https:' || !['open.feishu.cn', 'open.larksuite.com'].includes(url.hostname) || !url.pathname.startsWith('/open-apis/bot/v2/hook/')) throw invalid();
      return url;
    } finally { await handle.close(); }
  } catch { throw invalid(); }
}

/**
 * Creates a sender for a Feishu custom bot.
 * @param url Webhook URL; never logged.
 */
export function feishuSender(url: URL, fetcher: typeof fetch = fetch): NoticeSender {
  return async text => {
    const response = await fetcher(url, { method: 'POST', headers: { 'content-type': 'application/json' }, signal: AbortSignal.timeout(10_000),
      body: JSON.stringify({ msg_type: 'text', content: { text } }) });
    const body = await response.json().catch(() => null) as { code?: number; StatusCode?: number } | null;
    if (!response.ok || (body?.code ?? body?.StatusCode ?? 0) !== 0) throw new Error(`Feishu webhook answered ${response.status}`);
  };
}

/** Runs `LvpaopaoStore.evaluate` every minute and delivers its notices. */
export class LvpaopaoWatchdog {
  private timer: ReturnType<typeof setInterval> | null = null;
  private running: Promise<void> | null = null;
  constructor(private readonly store: LvpaopaoStore, private readonly send: NoticeSender | null, private readonly intervalMs = 60_000) {}

  /** One check; a failed delivery is logged and not retried, the next state change sends a new notice. */
  async tick(): Promise<void> {
    await this.store.syncCollectorStatus();
    const notice = await this.store.evaluate();
    if (!notice || !this.send) return;
    try { await this.send(notice.text); }
    catch (error) { console.error('[muse-data-web] 绿泡泡告警发送失败:', error instanceof Error ? error.message.slice(0, 120) : 'Error'); }
  }

  /** Checks now and then every interval; overlapping checks are skipped. */
  start(): void {
    if (this.timer) return;
    const check = () => {
      if (this.running) return;
      this.running = this.tick().catch(error => { console.error('[muse-data-web] 绿泡泡状态检查失败:', error instanceof Error ? error.name : 'Error'); })
        .finally(() => { this.running = null; });
    };
    this.timer = setInterval(check, this.intervalMs);
    check();
  }

  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    await this.running;
  }
}
