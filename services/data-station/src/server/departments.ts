/**
 * Feishu department membership for data-station sign-in.
 * The station reads the tenant's department tree and members with the Muse Feishu login app, and links Muse accounts to
 * Feishu people through a root-exported file holding only username, account ID and Feishu open_id per account.
 * Members of the configured departments (and their sub-departments) get in without being listed by hand; everyone's
 * department is shown beside their name. A failed sync keeps the last good snapshot.
 */
import { constants } from 'node:fs';
import { lstat, open, readFile, realpath, rename, writeFile } from 'node:fs/promises';
import { isAbsolute, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { z } from 'zod';

const FEISHU = 'https://open.feishu.cn/open-apis';

/** What the station knows about a Muse account from Feishu. */
export interface DirectoryEntry {
  /** In one of the admitted departments or below. */
  allowed: boolean;
  /** Feishu display name. */
  name: string | null;
  /** The person's department, preferring an admitted one; null when unknown. */
  department: string | null;
}

/** Looks up a Muse username; null when the account has no Feishu link the station knows. */
export interface DepartmentLookup { lookup(username: string): DirectoryEntry | null; }

export interface DirectoryStatus {
  state: 'idle' | 'success' | 'failed' | 'not_configured';
  syncedAt: string | null;
  lastAttemptAt: string | null;
  departments: number;
  people: number;
  admitted: number;
  linkedAccounts: number;
  allowedDepartments: string[];
  message: string;
}

interface Person { name: string; departments: string[]; }
interface Snapshot { syncedAt: string; departments: Record<string, { name: string; parent: string | null }>; people: Record<string, Person>; }

const appSchema = z.object({ appId: z.string().min(4).max(200), appSecret: z.string().min(8).max(500) }).passthrough();
const linksSchema = z.object({
  version: z.literal(1),
  accounts: z.array(z.object({
    username: z.string().min(1).max(200), accountId: z.string().min(1).max(200), disabled: z.boolean().optional(),
    feishu: z.array(z.object({ appId: z.string().max(200), openId: z.string().max(200) })).max(20),
  })).max(100_000),
}).passthrough();
const snapshotSchema = z.object({
  syncedAt: z.string(),
  departments: z.record(z.string(), z.object({ name: z.string(), parent: z.string().nullable() })),
  people: z.record(z.string(), z.object({ name: z.string(), departments: z.array(z.string()) })),
});

/** Reads a private JSON file: absolute, regular, no symbolic links, mode 0600 or 0640. Errors never include contents. */
async function readPrivateJson(path: string, label: string, maxBytes: number): Promise<unknown> {
  const invalid = (reason: string) => new Error(`${label} ${reason}`);
  if (!isAbsolute(path) || resolve(path) !== path) throw invalid('must be an absolute path');
  const stat = await lstat(path).catch(() => null);
  if (!stat?.isFile() || await realpath(path) !== path) throw invalid('must be a regular file without symbolic links');
  if (![0o600, 0o640].includes(stat.mode & 0o7777)) throw invalid('must have mode 0600 or 0640');
  if (stat.size === 0 || stat.size > maxBytes) throw invalid('has an invalid size');
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try { return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(await handle.readFile())); }
  catch { throw invalid('is not valid JSON'); }
  finally { await handle.close(); }
}

export interface FeishuDirectoryOptions {
  /** Private JSON with `appId` and `appSecret` (a copy of the Muse Feishu login app configuration). */
  appFile: string;
  /** Private JSON exported from the Muse accounts: `{ version: 1, accounts: [{ username, accountId, disabled, feishu: [{ appId, openId }] }] }`. */
  linksFile: string;
  /** Department names or open_department_ids whose members, including sub-departments, are admitted. */
  allowed: string[];
  /** Time between department syncs. */
  intervalMs: number;
  /** Where the last good snapshot is kept, inside the data directory. */
  cacheFile: string;
  /** Time between re-reads of the links file, so new Muse sign-ins are linked without waiting for a department sync. */
  linksIntervalMs?: number;
  /** Pause between Feishu requests. */
  requestIntervalMs?: number;
  fetch?: typeof globalThis.fetch;
  now?: () => number;
}

/** Keeps Feishu department membership and the Muse account links in memory, refreshed on a schedule. */
export class FeishuDirectory implements DepartmentLookup {
  private snapshot: Snapshot | null = null;
  private links = new Map<string, string[]>();
  private appId: string | null = null;
  private timers: ReturnType<typeof setTimeout>[] = [];
  private closing = false;
  private running: Promise<void> | null = null;
  private readonly now: () => number;
  private current: DirectoryStatus;

  constructor(private readonly options: FeishuDirectoryOptions) {
    if (!options.allowed.length) throw new Error('At least one admitted department is required');
    if (!Number.isInteger(options.intervalMs) || options.intervalMs < 60_000) throw new Error('Department sync interval must be at least one minute');
    this.now = options.now ?? Date.now;
    this.current = { state: 'idle', syncedAt: null, lastAttemptAt: null, departments: 0, people: 0, admitted: 0, linkedAccounts: 0,
      allowedDepartments: options.allowed, message: '等待首次同步飞书部门' };
  }

  status(): DirectoryStatus { return { ...this.current, ...this.counts() }; }

  private counts(): Pick<DirectoryStatus, 'departments' | 'people' | 'admitted' | 'linkedAccounts'> {
    const snapshot = this.snapshot;
    return { departments: snapshot ? Object.keys(snapshot.departments).length : 0, people: snapshot ? Object.keys(snapshot.people).length : 0,
      admitted: snapshot ? Object.values(snapshot.people).filter(person => this.admitted(person)).length : 0, linkedAccounts: this.links.size };
  }

  /** Loads the last good snapshot and the account links; a missing cache is not an error. */
  async initialize(): Promise<void> {
    try {
      this.snapshot = snapshotSchema.parse(JSON.parse(await readFile(this.options.cacheFile, 'utf8')));
      this.current = { ...this.current, syncedAt: this.snapshot.syncedAt, message: '使用上次同步的飞书部门' };
    } catch { /* No earlier snapshot; the first sync fills it. */ }
    await this.reloadLinks().catch(error => console.error('[muse-data-web] Muse account links unavailable:', error instanceof Error ? error.message : 'Error'));
  }

  /** Re-reads the app ID and the Muse account links; only open_ids of this app are kept, disabled accounts are left out. */
  async reloadLinks(): Promise<void> {
    const app = appSchema.parse(await readPrivateJson(this.options.appFile, 'MUSE_DATA_FEISHU_APP_FILE', 65_536));
    const links = linksSchema.parse(await readPrivateJson(this.options.linksFile, 'MUSE_DATA_FEISHU_LINKS_FILE', 16 * 1024 * 1024));
    this.appId = app.appId;
    this.links = new Map(links.accounts.filter(account => !account.disabled)
      .map(account => [account.username, account.feishu.filter(identity => identity.appId === app.appId).map(identity => identity.openId)] as [string, string[]])
      .filter(([, openIds]) => openIds.length > 0));
  }

  /** IDs of the admitted departments and every department below them. */
  private admittedDepartments(snapshot: Snapshot): Set<string> {
    const roots = Object.entries(snapshot.departments).filter(([id, department]) => this.options.allowed.includes(id) || this.options.allowed.includes(department.name)).map(([id]) => id);
    const result = new Set(roots);
    let grew = true;
    while (grew) {
      grew = false;
      for (const [id, department] of Object.entries(snapshot.departments)) {
        if (!result.has(id) && department.parent && result.has(department.parent)) { result.add(id); grew = true; }
      }
    }
    return result;
  }

  private admittedCache: { snapshot: Snapshot; ids: Set<string> } | null = null;
  private admittedIds(): Set<string> {
    if (!this.snapshot) return new Set();
    if (this.admittedCache?.snapshot !== this.snapshot) this.admittedCache = { snapshot: this.snapshot, ids: this.admittedDepartments(this.snapshot) };
    return this.admittedCache.ids;
  }

  private admitted(person: Person): boolean {
    const ids = this.admittedIds();
    return person.departments.some(id => ids.has(id));
  }

  lookup(username: string): DirectoryEntry | null {
    const snapshot = this.snapshot;
    const openIds = this.links.get(username);
    if (!snapshot || !openIds) return null;
    const people = openIds.map(id => snapshot.people[id]).filter((person): person is Person => Boolean(person));
    if (!people.length) return null;
    const admittedIds = this.admittedIds();
    const person = people.find(candidate => this.admitted(candidate)) ?? people[0]!;
    const departmentId = person.departments.find(id => admittedIds.has(id)) ?? person.departments.find(id => snapshot.departments[id]) ?? null;
    return { allowed: people.some(candidate => this.admitted(candidate)), name: person.name || null,
      department: departmentId ? snapshot.departments[departmentId]?.name ?? null : null };
  }

  private async call(path: string, token: string | null, init: { method?: string; body?: unknown; query?: Record<string, string> } = {}): Promise<Record<string, unknown>> {
    const url = `${FEISHU}${path}${init.query ? `?${new URLSearchParams(init.query)}` : ''}`;
    const response = await (this.options.fetch ?? globalThis.fetch)(url, { method: init.method ?? 'GET', redirect: 'error', signal: AbortSignal.timeout(20_000),
      headers: { 'content-type': 'application/json; charset=utf-8', ...(token ? { authorization: `Bearer ${token}` } : {}) },
      ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}) });
    const body = await response.json().catch(() => ({})) as Record<string, unknown>;
    if (body.code !== 0) throw new Error(`Feishu ${path.split('?')[0]} answered code ${String(body.code ?? response.status)}`);
    return body;
  }

  private async pages(path: string, token: string, query: Record<string, string>): Promise<Record<string, unknown>[]> {
    const items: Record<string, unknown>[] = [];
    let pageToken: string | undefined;
    for (let page = 0; page < 200; page++) {
      await delay(this.options.requestIntervalMs ?? 100);
      const body = await this.call(path, token, { query: { ...query, page_size: '50', ...(pageToken ? { page_token: pageToken } : {}) } });
      const data = (body.data ?? {}) as { items?: Record<string, unknown>[]; has_more?: boolean; page_token?: string };
      items.push(...(data.items ?? []));
      if (!data.has_more || !data.page_token) return items;
      pageToken = data.page_token;
    }
    throw new Error(`Feishu ${path} did not finish paging`);
  }

  /** Reads the whole department tree and its members; on failure the previous snapshot stays in use. */
  async sync(): Promise<void> {
    this.running ??= (async () => {
      const attempted = new Date(this.now()).toISOString();
      try {
        await this.reloadLinks();
        const app = appSchema.parse(await readPrivateJson(this.options.appFile, 'MUSE_DATA_FEISHU_APP_FILE', 65_536));
        const auth = await this.call('/auth/v3/tenant_access_token/internal', null, { method: 'POST', body: { app_id: app.appId, app_secret: app.appSecret } });
        const token = String(auth.tenant_access_token ?? '');
        if (!token) throw new Error('Feishu returned no tenant token');
        const rows = await this.pages('/contact/v3/departments/0/children', token, { fetch_child: 'true', department_id_type: 'open_department_id' });
        const departments: Snapshot['departments'] = {};
        for (const row of rows) {
          const id = String(row.open_department_id ?? '');
          if (!id) continue;
          const parent = String(row.parent_department_id ?? '');
          departments[id] = { name: String(row.name ?? ''), parent: parent && parent !== '0' ? parent : null };
        }
        const people: Snapshot['people'] = {};
        for (const id of Object.keys(departments)) {
          for (const user of await this.pages('/contact/v3/users/find_by_department', token, { department_id: id, department_id_type: 'open_department_id', user_id_type: 'open_id' })) {
            const openId = String(user.open_id ?? '');
            if (!openId) continue;
            const known = Array.isArray(user.department_ids) ? user.department_ids.map(String) : [id];
            people[openId] = { name: String(user.name ?? ''), departments: [...new Set([...(people[openId]?.departments ?? []), ...known])] };
          }
        }
        if (!Object.keys(departments).length) throw new Error('Feishu returned no departments');
        const snapshot: Snapshot = { syncedAt: new Date(this.now()).toISOString(), departments, people };
        this.snapshot = snapshot;
        const temporary = `${this.options.cacheFile}.tmp`;
        await writeFile(temporary, JSON.stringify(snapshot), { mode: 0o600 });
        await rename(temporary, this.options.cacheFile);
        const counts = this.counts();
        this.current = { ...this.current, state: 'success', syncedAt: snapshot.syncedAt, lastAttemptAt: attempted,
          message: `已同步 ${counts.departments} 个部门、${counts.people} 人；放行部门内 ${counts.admitted} 人；已关联 Muse 账号 ${counts.linkedAccounts} 个` };
      } catch (error) {
        const reason = error instanceof Error ? error.message.slice(0, 200) : 'Error';
        this.current = { ...this.current, state: 'failed', lastAttemptAt: attempted, message: `飞书部门同步失败，继续使用上次结果：${reason}` };
        console.error('[muse-data-web] Feishu department sync failed:', reason);
      }
    })().finally(() => { this.running = null; });
    return this.running;
  }

  /** Syncs now and then every interval; re-reads the account links more often. */
  start(): void {
    if (this.closing || this.timers.length) return;
    const loop = (work: () => Promise<void>, everyMs: number) => {
      const tick = async () => {
        await work().catch(() => {});
        if (!this.closing) { const timer = setTimeout(() => { void tick(); }, everyMs); timer.unref(); this.timers.push(timer); }
      };
      const first = setTimeout(() => { void tick(); }, 0); first.unref(); this.timers.push(first);
    };
    loop(() => this.sync(), this.options.intervalMs);
    loop(() => this.reloadLinks().catch(error => console.error('[muse-data-web] Muse account links unavailable:', error instanceof Error ? error.message : 'Error')),
      this.options.linksIntervalMs ?? 5 * 60_000);
  }

  async stop(): Promise<void> {
    this.closing = true;
    for (const timer of this.timers) clearTimeout(timer);
    this.timers = [];
    await this.running;
  }
}
