/** Durable project-bound voice registration reservations; no provider credential is retained. */
import {createHash, randomBytes} from 'node:crypto';
import {mkdir, lstat, realpath, open, readFile, rename, unlink, rmdir} from 'node:fs/promises';
import {isAbsolute, join} from 'node:path';
import {performance} from 'node:perf_hooks';
import {setTimeout as delay} from 'node:timers/promises';

const actions = new Set(['acquire', 'start', 'complete', 'abandon', 'read']);
const states = new Set(['reserved', 'submitted', 'ready']);
const providerOrigin = 'https://web.jubianai.net/prod-api';
const fail = (status, code, message) => { throw Object.assign(Error(message), {status, code}); };
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const positive = value => Number.isSafeInteger(value) && value > 0;
const text = value => typeof value === 'string' && value.trim().length > 0 && value.length <= 256 && !/[\x00-\x1f\x7f]/.test(value);
const hash = value => createHash('sha256').update(value).digest('hex');
const tag = slot => `⟦muse-voice:v1:${Buffer.from(JSON.stringify([slot.script_id, slot.character_id, slot.voice_period_id])).toString('base64url')}⟧`;
const sameSlot = (one, two) => one.script_id === two.script_id && one.character_id === two.character_id && one.voice_period_id === two.voice_period_id;

function validateRequest(value) {
  if (!record(value) || Object.keys(value).some(key => !['action', 'script_id', 'character_id', 'voice_period_id', 'operation_key', 'lease_id', 'asset_id'].includes(key))
    || !actions.has(value.action) || !positive(value.script_id) || !text(value.character_id) || !text(value.voice_period_id) || !text(value.operation_key)
    || value.lease_id !== undefined && (typeof value.lease_id !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(value.lease_id))
    || value.asset_id !== undefined && !positive(value.asset_id)) fail(400, 'invalid_request', 'Invalid voice reservation request');
  if (['start', 'complete', 'abandon'].includes(value.action) && value.lease_id === undefined) fail(400, 'invalid_request', 'Voice reservation lease is required');
  if (value.action === 'complete' && value.asset_id === undefined) fail(400, 'invalid_request', 'Completed audio identity is required');
  return value;
}

function readAsset(value, slot, assetId) {
  if (!record(value)) fail(409, 'asset_unverified', 'Audio asset is unavailable or unreadable');
  const number = value => typeof value === 'string' && /^[1-9][0-9]*$/.test(value) ? Number(value) : value;
  const ids = [value.id, value.asset_id].filter(entry => entry !== undefined).map(number);
  const projects = [value.scriptId, value.script_id].filter(entry => entry !== undefined).map(number);
  const categories = [value.assetType, value.asset_type].filter(entry => entry !== undefined);
  const id = ids[0], project = projects[0];
  const name = value.assetName ?? value.name, url = value.assetUrl ?? value.url;
  if (!positive(id) || id !== assetId || ids.some(entry => entry !== id) || project !== slot.script_id || projects.some(entry => entry !== project)
    || categories.length === 0 || categories.some(entry => entry !== 4)
    || value.delFlag !== 0 && value.delFlag !== '0'
    || value.deleted !== undefined && value.deleted !== false && value.deleted !== 0 && value.deleted !== '0'
    || typeof name !== 'string' || !name.endsWith(tag(slot))) {
    fail(409, 'asset_unverified', 'Audio asset project, category or voice identity does not match');
  }
  let parsed;
  try { parsed = new URL(url); } catch (_error) { fail(409, 'asset_unverified', 'Audio asset URL is unreadable'); }
  if (typeof url !== 'string' || parsed.protocol !== 'https:' || parsed.username || parsed.password || parsed.hash || url.includes('\\')) {
    fail(409, 'asset_unverified', 'Audio asset requires a credential-free HTTPS URL');
  }
  return {asset_id: id, script_id: project, asset_type: 4, name, url,
    character_id: slot.character_id, voice_period_id: slot.voice_period_id, voice_slot_tag: tag(slot)};
}

function readReceipt(value, slot) {
  if (!record(value) || Object.keys(value).some(key => !['version', 'script_id', 'character_id', 'voice_period_id', 'state', 'owner_account_id', 'operation_key', 'lease_id', 'lease_expires_at', 'updated_at', 'asset_id'].includes(key))
    || value.version !== 1 || !sameSlot(value, slot) || !states.has(value.state) || !text(value.owner_account_id)
    || !text(value.operation_key) || typeof value.lease_id !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(value.lease_id)
    || !Number.isSafeInteger(value.updated_at) || value.updated_at < 0 || !Number.isSafeInteger(value.lease_expires_at) || value.lease_expires_at < 0
    || value.state === 'ready' && !positive(value.asset_id) || value.state !== 'ready' && value.asset_id !== undefined) fail(503, 'receipt_unreadable', 'Voice reservation receipt requires operator inspection');
  return value;
}

/**
 * Resolve deployment-varying reservations and lock waits; a directory is required to enable the service.
 * @param {object} environment Gateway environment; never contains a Jubian credential for this service.
 * @returns {object|undefined} Validated service options, or undefined when explicitly unconfigured.
 */
export function resolveVoiceSlotOptions(environment = process.env) {
  if (!environment.MUSE_VOICE_SLOTS_DIR) return undefined;
  const field = (name, fallback) => environment[name] === undefined ? fallback : Number(environment[name]);
  return {root: environment.MUSE_VOICE_SLOTS_DIR,
    reservationLeaseMs: field('MUSE_VOICE_SLOTS_LEASE_MS', 120000), lockWaitMs: field('MUSE_VOICE_SLOTS_LOCK_WAIT_MS', 10000),
    lockPollMs: field('MUSE_VOICE_SLOTS_LOCK_POLL_MS', 25), timeoutMs: field('MUSE_VOICE_SLOTS_TIMEOUT_MS', 10000)};
}

/**
 * Verify only fixed-origin, read-only project and audio identities using the requesting collaborator's token.
 * @param {object} options Instance-local fetch transport and bounded timeout; no origin override is supported.
 * @returns {object} Project and asset readers that return accepted provider data and redact all upstream errors.
 */
export function createJubianVoiceVerifier({fetcher = fetch, timeoutMs = 10000, maximumBytes = 1048576} = {}) {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || !Number.isSafeInteger(maximumBytes) || maximumBytes < 1) throw Error('Invalid voice verification limits');
  async function get(token, path) {
    let response;
    try { response = await fetcher(providerOrigin + path, {method: 'GET', headers: {authorization: `Bearer ${token}`, accept: 'application/json'}, redirect: 'error', signal: AbortSignal.timeout(timeoutMs)}); }
    catch (_error) { fail(503, 'provider_unavailable', 'Jubian voice verification is temporarily unavailable'); }
    if (!response.ok) {
      await response.body?.cancel();
      fail(response.status === 401 || response.status === 403 ? 403 : 503, 'project_access_unverified', 'Jubian access could not be verified');
    }
    let parsed;
    try {
      const chunks = []; let size = 0;
      for await (const chunk of response.body ?? []) { size += chunk.length; if (size > maximumBytes) fail(503, 'provider_unavailable', 'Jubian verification response exceeded its limit'); chunks.push(chunk); }
      parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    } catch (_error) { fail(503, 'provider_unavailable', 'Jubian verification response is unreadable'); }
    const envelope = Array.isArray(parsed) && parsed.length === 1 ? parsed[0] : parsed;
    if (!record(envelope) || ![0, 200].includes(envelope.code)) fail(403, 'project_access_unverified', 'Jubian access could not be verified');
    const inner = envelope.data;
    return record(inner) && [0, 200].includes(inner.code) && Object.hasOwn(inner, 'data') ? inner.data : inner;
  }
  return {
    verifyProject: async ({token, scriptId}) => {
      const value = await get(token, `/aigc/script/${scriptId}`);
      const ids = record(value) ? [value.id, value.scriptId].filter(entry => entry !== undefined) : [];
      if (ids.length === 0 || ids.some(id => id !== scriptId && id !== String(scriptId))) fail(403, 'project_access_unverified', 'Jubian project access could not be verified');
    },
    verifyAsset: ({token, assetId}) => get(token, `/aigc/asset/${assetId}`),
  };
}

/**
 * Create a cross-process durable reservation service for one gateway deployment.
 * Exclusive directory locks are never stolen: an interrupted lock needs operator cleanup after its writer is stopped.
 * Submitted receipts never expire; a lost creation response can only settle through its original owner and lease.
 * @param {object} options Absolute private root, exact-project/asset readers, clock and reservation/lock limits.
 * @returns {object} Startup readiness and account-authenticated request operations; raw provider tokens are never saved.
 */
export function createVoiceSlots({root, verifyProject, verifyAsset, now = Date.now, reservationLeaseMs = 120000, lockWaitMs = 10000, lockPollMs = 25}) {
  if (typeof root !== 'string' || !isAbsolute(root) || typeof verifyProject !== 'function' || typeof verifyAsset !== 'function'
    || ![reservationLeaseMs, lockWaitMs, lockPollMs].every(value => Number.isSafeInteger(value) && value > 0) || lockPollMs > lockWaitMs) throw Error('Invalid voice reservation configuration');
  let directory;
  const ready = (async () => {
    await mkdir(root, {recursive: true, mode: 0o700});
    const metadata = await lstat(root);
    if (!metadata.isDirectory() || metadata.isSymbolicLink() || process.platform !== 'win32' && (metadata.mode & 0o077) !== 0) throw Error('Voice reservation directory must be private and cannot be a symlink');
    directory = await realpath(root);
  })();
  async function save(file, value) {
    const temporary = `${file}.${randomBytes(16).toString('hex')}.tmp`;
    const handle = await open(temporary, 'wx', 0o600);
    try {
      try { await handle.writeFile(JSON.stringify(value)); await handle.sync(); }
      finally { await handle.close(); }
      await rename(temporary, file);
      if (process.platform !== 'win32') { const parent = await open(directory, 'r'); try { await parent.sync(); } finally { await parent.close(); } }
    } finally {
      try { await unlink(temporary); }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
  }
  async function locked(slot, run) {
    await ready;
    const file = join(directory, hash(JSON.stringify([slot.script_id, slot.character_id, slot.voice_period_id])) + '.json');
    const lock = file + '.lock', started = performance.now();
    while (true) {
      try { await mkdir(lock, {mode: 0o700}); break; }
      catch (error) { if (error.code !== 'EEXIST') throw error; }
      if (performance.now() - started >= lockWaitMs) fail(503, 'reservation_busy', 'Voice reservation is busy; inspect an interrupted writer before removing its lock');
      await delay(Math.min(lockPollMs, Math.max(1, lockWaitMs - (performance.now() - started))));
    }
    try {
      let receipt;
      try {
        const handle = await open(file, 'r');
        try {
          const metadata = await handle.stat();
          if (!metadata.isFile() || metadata.size > 8192 || process.platform !== 'win32' && (metadata.mode & 0o077) !== 0) fail(503, 'receipt_unreadable', 'Voice reservation receipt must be private and bounded');
          let parsed;
          try { parsed = JSON.parse(await handle.readFile('utf8')); }
          catch (_error) { fail(503, 'receipt_unreadable', 'Voice reservation receipt is unreadable'); }
          receipt = readReceipt(parsed, slot);
        }
        finally { await handle.close(); }
      } catch (error) { if (error.code !== 'ENOENT') throw error; }
      return await run(receipt, value => save(file, value));
    } finally { await rmdir(lock); }
  }
  return {
    ready: () => ready,
    /** Verify current project access, then read or mutate only the caller's original registration lease. */
    request: async (accountId, token, value, {isAuthorized = () => true} = {}) => {
      const request = validateRequest(value);
      if (!text(accountId) || typeof token !== 'string' || token.length < 1 || token.length > 8192 || /[\x00-\x20\x7f]/.test(token)) fail(400, 'invalid_request', 'A private Jubian token and account are required');
      const authorize = () => { if (!isAuthorized()) fail(401, 'account_session_expired', 'Muse account session is no longer active'); };
      authorize(); await verifyProject({token, scriptId: request.script_id, accountId}); authorize();
      return locked(request, async (stored, save) => {
        authorize();
        const stamp = now();
        if (!Number.isSafeInteger(stamp) || stamp < 0) throw Error('Invalid voice reservation clock');
        const expired = stored?.state === 'reserved' && stored.lease_expires_at <= stamp;
        const current = expired ? undefined : stored;
        const owner = current?.owner_account_id === accountId && current.operation_key === request.operation_key;
        const base = {script_id: request.script_id, character_id: request.character_id, voice_period_id: request.voice_period_id};
        const view = (receipt, extra = {}) => ({...base, state: receipt?.state ?? 'available',
          ...(receipt && owner ? {owner_operation: true, lease_id: receipt.lease_id, ...(receipt.state === 'reserved' ? {lease_expires_at: receipt.lease_expires_at} : {})} : {}), ...extra});
        async function confirmed(receipt) {
          const asset = readAsset(await verifyAsset({token, scriptId: request.script_id, assetId: receipt.asset_id, accountId}), request, receipt.asset_id);
          authorize(); return asset;
        }
        if (request.action === 'read') return current?.state === 'ready' ? view(current, {asset: await confirmed(current)}) : view(current);
        if (request.action === 'acquire') {
          if (current?.state === 'ready') return view(current, {asset: await confirmed(current)});
          if (current) return owner ? view(current) : {...base, state: 'busy', blocking_state: current.state};
          const receipt = {...base, version: 1, state: 'reserved', owner_account_id: accountId, operation_key: request.operation_key,
            lease_id: randomBytes(32).toString('base64url'), lease_expires_at: stamp + reservationLeaseMs, updated_at: stamp};
          authorize(); await save(receipt);
          return {...base, state: 'reserved', owner_operation: true, lease_id: receipt.lease_id, lease_expires_at: receipt.lease_expires_at};
        }
        if (!current || !owner || current.lease_id !== request.lease_id) fail(409, 'lease_conflict', 'Voice registration lease is unavailable or belongs to another operation');
        if (request.action === 'start') {
          if (current.state === 'ready') return view(current, {asset: await confirmed(current), started_now: false});
          if (current.state === 'submitted') return view(current, {started_now: false});
          const next = {...current, state: 'submitted', updated_at: stamp}; authorize(); await save(next); return view(next, {started_now: true});
        }
        if (request.action === 'abandon') {
          if (current.state !== 'reserved') fail(409, 'submitted_registration', 'A submitted voice registration requires original-operation reconciliation');
          const next = {...current, lease_expires_at: stamp, updated_at: stamp}; authorize(); await save(next); return {...base, state: 'available'};
        }
        if (current.state === 'reserved') fail(409, 'registration_not_started', 'Voice registration has not been marked as submitted');
        if (current.state === 'ready' && current.asset_id !== request.asset_id) fail(409, 'asset_conflict', 'Completed voice registration cannot change its asset');
        const asset = await confirmed({...current, asset_id: request.asset_id});
        if (current.state !== 'ready') { authorize(); await save({...current, state: 'ready', asset_id: request.asset_id, updated_at: stamp}); }
        return view({...current, state: 'ready'}, {asset});
      });
    },
  };
}
