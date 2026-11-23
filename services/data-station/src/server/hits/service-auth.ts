/**
 * Service identity for non-human workers: one bearer token read once from a private file named by
 * `MUSE_DATA_SERVICE_TOKEN_FILE`. It authorizes only `/api/service/*`; user cookies never authorize those routes.
 */
import { createHash, timingSafeEqual } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, open, realpath } from 'node:fs/promises';
import { isAbsolute, resolve, sep } from 'node:path';

/** Header accepted besides `Authorization: Bearer`, because the public Nginx entry clears `Authorization`. */
export const SERVICE_TOKEN_HEADER = 'X-Muse-Data-Service-Token';
const TOKEN = /^[A-Za-z0-9._~+/=-]{32,512}$/;

/** Verifies a request's service token in constant time. */
export interface ServiceIdentity {
  /** Name recorded in job events, e.g. `muse-transcription`. */
  readonly name: string;
  verify(request: Request): boolean;
}

/**
 * Creates a verifier for one token.
 * @param token At least 32 characters of `A-Z a-z 0-9 . _ ~ + / = -`.
 */
export function createServiceIdentity(token: string, name = 'muse-transcription'): ServiceIdentity {
  if (!TOKEN.test(token)) throw new Error('Service token must be 32–512 URL-safe characters');
  const expected = createHash('sha256').update(token).digest();
  return {
    name,
    verify(request) {
      const bearer = /^Bearer\s+(\S+)$/i.exec(request.headers.get('authorization') ?? '')?.[1];
      const supplied = bearer ?? request.headers.get(SERVICE_TOKEN_HEADER);
      if (!supplied || !TOKEN.test(supplied)) return false;
      return timingSafeEqual(createHash('sha256').update(supplied).digest(), expected);
    },
  };
}

/**
 * Reads a token file: absolute, a regular file without symbolic links, mode 0600 or 0640, at most 4 KiB; surrounding whitespace is ignored.
 * @throws Without revealing the file contents.
 */
export async function loadServiceIdentity(path: string, name = 'muse-transcription', variable = 'MUSE_DATA_SERVICE_TOKEN_FILE'): Promise<ServiceIdentity> {
  const invalid = () => new Error(`${variable} must be a private regular file (0600 or 0640, no symbolic links) holding one token of 32–512 URL-safe characters`);
  if (!isAbsolute(path) || resolve(path) !== path || path.split(sep).some(part => part === '.muse')) throw invalid();
  try {
    const stat = await lstat(path);
    if (!stat.isFile() || ![0o600, 0o640].includes(stat.mode & 0o7777) || stat.size === 0 || stat.size > 4_096 || await realpath(path) !== path) throw invalid();
    const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    try { return createServiceIdentity(new TextDecoder('utf-8', { fatal: true }).decode(await handle.readFile()).trim(), name); }
    finally { await handle.close(); }
  } catch { throw invalid(); }
}
