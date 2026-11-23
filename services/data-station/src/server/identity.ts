import { createHash, timingSafeEqual } from 'node:crypto';
import { constants, lstatSync, realpathSync } from 'node:fs';
import http from 'node:http';
import { lstat, open, realpath } from 'node:fs/promises';
import { isAbsolute, resolve, sep } from 'node:path';
import { z } from 'zod';
import type { UserIdentity } from '../shared/types.ts';

const MAX_IDENTITY_BYTES = 1_048_576;
const username = z.string().regex(/^[A-Za-z0-9._-]{1,64}$/);
const plainText = (max: number) => z.string().min(1).max(max).refine(value => value.trim() === value && !/[\p{Cc}]/u.test(value));
/** Muse account names may be non-ASCII; the proxy header mode keeps the stricter ASCII form. */
const museUsername = plainText(64);
function identitySchema(name: z.ZodType<string>) {
  return z.object({
    version: z.literal(1),
    proxySecret: z.string().regex(/^[0-9a-fA-F]{64}$/),
    users: z.array(z.object({
      username: name, id: plainText(200), name: plainText(200), role: z.enum(['admin', 'member']),
    }).strict()).min(1).max(10_000),
  }).strict().superRefine((value, context) => {
    if (new Set(value.users.map(user => user.username)).size !== value.users.length
      || new Set(value.users.map(user => user.id)).size !== value.users.length) {
      context.addIssue({ code: 'custom', message: 'Identity names and IDs must be unique' });
    }
  });
}
type IdentityFile = z.infer<ReturnType<typeof identitySchema>>;

/** The Muse website's session cookie, shared by every path on the same HTTPS origin. */
export const MUSE_SESSION_COOKIE = '__Host-muse';

/**
 * A request without data-station access: `login` needs a Muse sign-in, `forbidden` is signed in
 * but not on the private list, and `unavailable` could not be checked with the Muse gateway.
 */
export interface IdentityDenial { denied: 'login' | 'forbidden' | 'unavailable'; }
/** An account, a specific denial, or null when the request did not come through the private proxy. */
export type IdentityResult = UserIdentity | IdentityDenial | null;

function proxyKeyMatches(request: Request, secret: Buffer): boolean {
  const supplied = request.headers.get('X-Muse-Data-Key');
  if (!supplied || !/^[0-9a-fA-F]{64}$/.test(supplied)) return false;
  const candidate = Buffer.from(supplied, 'hex');
  return candidate.byteLength === secret.byteLength && timingSafeEqual(candidate, secret);
}

/** Validates the exact HTTPS origin used for browser writes behind the private reverse proxy. */
export function publicDataOrigin(value: string): string {
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash || value !== url.origin) throw new Error('Invalid origin');
    return url.origin;
  } catch (error) { throw new Error('MUSE_DATA_PUBLIC_ORIGIN must be an exact HTTPS origin without a path or credentials'); }
}

function privateMode(mode: number): boolean { return [0o600, 0o640].includes(mode & 0o7777); }

/** Rejects public, linked or non-file identity locations before any identity JSON is read. */
export function privateIdentityFilePath(value: string): string {
  try {
    if (!isAbsolute(value) || resolve(value) !== value || value.split(sep).some(part => part === '.muse' || part === '.dsh')) throw new Error('Invalid location');
    if (realpathSync(value) !== value) throw new Error('Linked location');
    const stat = lstatSync(value);
    if (!stat.isFile() || !privateMode(stat.mode) || stat.size > MAX_IDENTITY_BYTES || stat.size === 0) throw new Error('Invalid file');
    return value;
  } catch (error) { throw new Error('MUSE_DATA_IDENTITY_FILE must be a private regular file with mode 0600 or 0640 and no symbolic links'); }
}

/** Reads and validates the private account file once, with the username form required by the caller's mode. */
async function readIdentityFile(identityFile: string, schema: ReturnType<typeof identitySchema>): Promise<IdentityFile> {
  privateIdentityFilePath(identityFile);
  let parsed: IdentityFile;
  const handle = await open(identityFile, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || !privateMode(stat.mode) || stat.size <= 0 || stat.size > MAX_IDENTITY_BYTES || await realpath(identityFile) !== identityFile) throw new Error('Invalid identity file');
    const bytes = Buffer.alloc(MAX_IDENTITY_BYTES + 1);
    let used = 0;
    for (;;) {
      const read = await handle.read(bytes, used, bytes.length - used, used);
      used += read.bytesRead;
      if (used > MAX_IDENTITY_BYTES) throw new Error('Identity file exceeds the byte limit');
      if (!read.bytesRead) break;
    }
    const after = await handle.stat();
    const current = await lstat(identityFile);
    if (after.size !== stat.size || after.mtimeMs !== stat.mtimeMs || after.size !== used || !privateMode(after.mode)
      || !current.isFile() || current.ino !== stat.ino || current.dev !== stat.dev || !privateMode(current.mode)
      || await realpath(identityFile) !== identityFile) throw new Error('Identity file changed during startup');
    parsed = schema.parse(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, used))));
  } catch (error) {
    throw new Error('Data station identity JSON is invalid or changed during startup');
  } finally { await handle.close(); }
  return parsed;
}

/**
 * Loads this data station's private accounts once, authenticating only the fixed proxy key and username headers.
 * @param identityFile Absolute private JSON file owned by the independent data station.
 * @returns An account provider that rejects untrusted keys and unknown users without a preview fallback.
 */
export async function createTrustedProxyIdentity(identityFile: string): Promise<(request: Request) => Promise<UserIdentity | null>> {
  const parsed = await readIdentityFile(identityFile, identitySchema(username));
  const secret = Buffer.from(parsed.proxySecret, 'hex');
  const users = new Map(parsed.users.map(user => [user.username, { id: user.id, name: user.name, role: user.role }]));
  return async request => {
    if (!proxyKeyMatches(request, secret)) return null;
    const name = request.headers.get('X-Muse-Data-User');
    if (!name || !username.safeParse(name).success) return null;
    const user = users.get(name);
    return user ? { ...user } : null;
  };
}

const museAccountSchema = z.object({ version: z.literal(1), accountId: z.string().min(1).max(200), username: z.string().min(1).max(200), admin: z.boolean() });
/** The signed-in Muse account as reported by the Muse gateway. */
export type MuseAccount = z.infer<typeof museAccountSchema>;

/** Validates a loopback HTTP origin for the Muse account gateway. */
export function museGatewayOrigin(value: string): string {
  const url = new URL(value);
  if (url.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) || url.username || url.password
    || url.pathname !== '/' || url.search || url.hash || value.replace(/\/$/, '') !== url.origin) throw new Error('MUSE_DATA_MUSE_GATEWAY must be a loopback http origin');
  return url.origin;
}

/**
 * Asks the Muse gateway's `GET /api/muse/identity` who owns a session cookie, over loopback with the public Host.
 * @param gatewayOrigin Loopback origin of the Muse account gateway.
 * @param publicHost Host header the gateway expects for the public website.
 * @param timeoutMs Request deadline.
 * @returns A lookup resolving to the account, or null when the gateway rejects the session; other failures reject.
 */
export function createMuseGatewayLookup(gatewayOrigin: string, publicHost: string, timeoutMs: number, via: 'cookie' | 'bearer' = 'cookie'): (token: string) => Promise<MuseAccount | null> {
  const url = new URL('/api/muse/identity', museGatewayOrigin(gatewayOrigin));
  return token => new Promise<MuseAccount | null>((resolvePromise, reject) => {
    const credential = via === 'cookie' ? { cookie: `${MUSE_SESSION_COOKIE}=${token}` } : { authorization: `Bearer ${token}` };
    const request = http.request(url, { method: 'GET', timeout: timeoutMs,
      headers: { host: publicHost, ...credential, accept: 'application/json' } }, response => {
      const status = response.statusCode ?? 0;
      if (status === 401 || status === 403 || (status >= 300 && status < 400)) { response.resume(); resolvePromise(null); return; }
      if (status !== 200) { response.resume(); reject(new Error(`Muse gateway returned HTTP ${status}`)); return; }
      const chunks: Buffer[] = [];
      let size = 0;
      response.on('data', (chunk: Buffer) => {
        size += chunk.byteLength;
        if (size > 16_384) { request.destroy(new Error('Muse identity response is too large')); return; }
        chunks.push(chunk);
      });
      response.on('end', () => {
        try { resolvePromise(museAccountSchema.parse(JSON.parse(Buffer.concat(chunks).toString('utf8')))); }
        catch (error) { reject(error instanceof Error ? error : new Error('Invalid Muse identity response')); }
      });
      response.on('error', reject);
    });
    request.on('timeout', () => request.destroy(new Error('Muse gateway timed out')));
    request.on('error', reject);
    request.end();
  });
}

function sessionToken(cookie: string | null): string | null {
  for (const part of cookie?.split(';') ?? []) {
    const [name, ...value] = part.trim().split('=');
    if (name === MUSE_SESSION_COOKIE) {
      const token = value.join('=');
      return /^[A-Za-z0-9_-]{16,512}$/.test(token) ? token : null;
    }
  }
  return null;
}

/** Options for reusing the Muse website sign-in. Lookups are injectable for tests. */
export interface MuseSessionIdentityOptions {
  lookup: (token: string) => Promise<MuseAccount | null>;
  /** How long an accepted or refused account stays cached; revocation takes effect after this time. */
  cacheMs: number;
  now?: () => number;
  /**
   * Feishu departments: an account not in the private file is admitted as a member when its Feishu person is in an admitted department;
   * every admitted account carries its department.
   */
  directory?: { lookup(username: string): { allowed: boolean; name: string | null; department: string | null } | null };
}

/**
 * Decides access for a Muse account: the private list first (its role and name), then an admitted Feishu department (member).
 * @returns The account with its department, or `forbidden`.
 */
function admit(account: MuseAccount, listed: Pick<UserIdentity, 'id' | 'name' | 'role'> | undefined, directory: MuseSessionIdentityOptions['directory']): UserIdentity | IdentityDenial {
  const entry = directory?.lookup(account.username) ?? null;
  const department = entry?.department ? { department: entry.department } : {};
  const muse = { username: account.username, admin: account.admin };
  if (listed) return { ...listed, ...department, muse };
  if (entry?.allowed) return { id: `muse-${account.accountId}`, name: entry.name ?? account.username, role: 'member', ...department, muse };
  return { denied: 'forbidden' };
}

/**
 * Reuses the Muse website's Feishu sign-in: the private proxy forwards the Muse session cookie, the
 * gateway names its account, and only usernames in the private file get access with the role listed there.
 * @param identityFile Private account file whose `username` values are Muse usernames.
 * @param options Gateway lookup and cache lifetime.
 * @returns A provider returning the account, a denial, or null for requests without the private proxy key.
 */
export async function createMuseSessionIdentity(identityFile: string, options: MuseSessionIdentityOptions): Promise<(request: Request) => Promise<IdentityResult>> {
  if (!Number.isInteger(options.cacheMs) || options.cacheMs < 0 || options.cacheMs > 3_600_000) throw new Error('Muse session cache time must be 0..3600000 ms');
  const parsed = await readIdentityFile(identityFile, identitySchema(museUsername));
  const secret = Buffer.from(parsed.proxySecret, 'hex');
  const users = new Map(parsed.users.map(user => [user.username, { id: user.id, name: user.name, role: user.role }]));
  const now = options.now ?? Date.now;
  const cache = new Map<string, { result: UserIdentity | IdentityDenial; expires: number }>();
  return async request => {
    if (!proxyKeyMatches(request, secret)) return null;
    const token = sessionToken(request.headers.get('cookie'));
    if (!token) return { denied: 'login' };
    const key = createHash('sha256').update(token).digest('hex');
    const cached = cache.get(key);
    if (cached && cached.expires > now()) return structuredClone(cached.result);
    cache.delete(key);
    let account: MuseAccount | null;
    try { account = await options.lookup(token); }
    catch { return { denied: 'unavailable' }; }
    if (!account) return { denied: 'login' };
    const result = admit(account, users.get(account.username), options.directory);
    if (options.cacheMs > 0) {
      while (cache.size >= 1_000) cache.delete(cache.keys().next().value!);
      cache.set(key, { result, expires: now() + options.cacheMs });
    }
    return structuredClone(result);
  };
}

/** Header desktop Muse sends its account session token in; the public Nginx entry clears `Authorization`. */
export const MUSE_ACCOUNT_TOKEN_HEADER = 'X-Muse-Account-Token';

/**
 * Identifies desktop Muse by the signed-in member's own Muse account token rather than a shared service token.
 * The gateway's `GET /api/muse/identity` (Bearer) names the account; only usernames in the private file get access,
 * with the role listed there. Results are cached by token digest for `cacheMs`; the token itself is never stored or logged.
 * @param identityFile The same private account file the Muse website sign-in uses.
 * @returns The account, `login` for a missing or rejected token, `forbidden` for an account not on the list, or `unavailable`.
 */
export async function createMuseAccountTokenIdentity(identityFile: string, options: MuseSessionIdentityOptions): Promise<(request: Request) => Promise<UserIdentity | IdentityDenial>> {
  if (!Number.isInteger(options.cacheMs) || options.cacheMs < 0 || options.cacheMs > 3_600_000) throw new Error('Muse account cache time must be 0..3600000 ms');
  const parsed = await readIdentityFile(identityFile, identitySchema(museUsername));
  const users = new Map(parsed.users.map(user => [user.username, { id: user.id, name: user.name, role: user.role }]));
  const now = options.now ?? Date.now;
  const cache = new Map<string, { result: UserIdentity | IdentityDenial; expires: number }>();
  return async request => {
    const token = request.headers.get(MUSE_ACCOUNT_TOKEN_HEADER)?.trim() ?? '';
    if (!/^[A-Za-z0-9._~+/=-]{16,2048}$/.test(token)) return { denied: 'login' };
    const key = createHash('sha256').update(token).digest('hex');
    const cached = cache.get(key);
    if (cached && cached.expires > now()) return structuredClone(cached.result);
    cache.delete(key);
    let account: MuseAccount | null;
    try { account = await options.lookup(token); }
    catch { return { denied: 'unavailable' }; }
    const result: UserIdentity | IdentityDenial = account ? admit(account, users.get(account.username), options.directory) : { denied: 'login' };
    if (options.cacheMs > 0) {
      while (cache.size >= 1_000) cache.delete(cache.keys().next().value!);
      cache.set(key, { result, expires: now() + options.cacheMs });
    }
    return structuredClone(result);
  };
}
