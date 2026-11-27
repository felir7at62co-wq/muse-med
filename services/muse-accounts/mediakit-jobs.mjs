/** Private submission receipts for MediaKit video jobs. */
import {createHash, randomUUID} from 'node:crypto';
import {lstat, mkdir, readFile, rename, rm, writeFile} from 'node:fs/promises';
import {isAbsolute, join} from 'node:path';

const operations = new Set(['upscale', 'erase_subtitle']);
const operationKey = /^[a-zA-Z0-9_-]{1,128}$/u;
const shaPattern = /^[a-f0-9]{64}$/u;
const digest = parts => createHash('sha256').update(JSON.stringify(parts)).digest('hex');
const unknown = () => ({state: 'unknown', code: 'submission_unconfirmed'});
const approvalDigest = (operation, sourceSha256, resolution) => digest([operation, sourceSha256, resolution ?? null]);
const requestDigest = ({operation, videoUrl, resolution}) => digest([operation, videoUrl, resolution ?? null]);

function httpsOrigin(value) {
  const parsed = new URL(value);
  if (parsed.protocol !== 'https:' || parsed.username || parsed.password || parsed.hash) {
    throw Error('MediaKit requires a valid HTTPS media address');
  }
  return parsed;
}

async function readReceipt(path) {
  let content;
  try { content = await readFile(path, 'utf8'); }
  catch (error) { if (error.code === 'ENOENT') return undefined; throw error; }
  const receipt = JSON.parse(content);
  if (receipt.version !== 1 || !shaPattern.test(receipt.request) ||
    receipt.approval !== undefined && !shaPattern.test(receipt.approval) ||
    receipt.defaultRouting !== undefined && receipt.defaultRouting !== true ||
    !['unknown', 'accepted', 'rejected'].includes(receipt.state) ||
    receipt.state === 'accepted' && (typeof receipt.taskId !== 'string' || receipt.taskId.length === 0) ||
    receipt.state === 'rejected' && (typeof receipt.code !== 'string' || !/^[a-zA-Z0-9_-]{1,80}$/u.test(receipt.code))) {
    throw Error('Invalid MediaKit submission receipt');
  }
  return receipt;
}

async function saveReceipt(path, receipt) {
  const temporary = path + '.' + randomUUID() + '.tmp';
  try {
    await writeFile(temporary, JSON.stringify({version: 1, ...receipt}), {flag: 'wx', mode: 0o600});
    await rename(temporary, path);
  } catch (error) {
    await rm(temporary, {force: true});
    throw error;
  }
}

async function hasReservation(path) {
  try { await lstat(path); return true; }
  catch (error) { if (error.code === 'ENOENT') return false; throw error; }
}

/**
 * Open an account-scoped MediaKit dispatcher. The caller owns project authorization and spending admission.
 * An interrupted or unacknowledged submission retains its reservation across restart.
 * @param {object} options Absolute private receipt directory, MediaKit provider and allowed HTTPS input origins.
 * @returns {Promise<object>} Submit, inspect and single-use fallback claims scoped to the current account.
 */
export async function openMediaKitJobs({directory, provider, allowedSourceOrigins}) {
  if (typeof directory !== 'string' || !isAbsolute(directory) || typeof provider?.submit !== 'function' ||
    typeof provider?.query !== 'function' || !Array.isArray(allowedSourceOrigins)) {
    throw Error('Invalid MediaKit job configuration');
  }
  const sources = new Set(allowedSourceOrigins.map(value => {
    const url = httpsOrigin(value);
    if (url.origin !== value) throw Error('Expected a MediaKit input origin without a path');
    return url.origin;
  }));
  await mkdir(directory, {recursive: true, mode: 0o700});
  const metadata = await lstat(directory);
  if (!metadata.isDirectory() || process.platform !== 'win32' && (metadata.mode & 0o077) !== 0) {
    throw Error('MediaKit submission receipts need a private directory');
  }

  function locate(owner, key) {
    if (typeof owner !== 'string' || !owner || typeof key !== 'string' || !operationKey.test(key)) {
      throw Error('Invalid MediaKit submission identity');
    }
    const clientToken = digest([owner, key]);
    const reservation = join(directory, clientToken);
    return {clientToken, reservation, path: join(reservation, 'receipt.json')};
  }

  function dailyDirectory() {
    return join(directory, 'default-daily', new Date().toISOString().slice(0, 10));
  }

  async function reserveDailySlot(limit) {
    const day = dailyDirectory();
    await mkdir(day, {recursive: true, mode: 0o700});
    // Exclusive slots share the same limit across gateway restarts and concurrent processes.
    for (let slot = 1; slot <= limit; slot += 1) {
      try { await mkdir(join(day, String(slot)), {mode: 0o700}); return true; }
      catch (error) { if (error.code !== 'EEXIST') throw error; }
    }
    return false;
  }

  return {
    async defaultCapacityAvailable(limit) {
      // A slot can be taken only after every lower slot has been taken.
      return !await hasReservation(join(dailyDirectory(), String(limit)));
    },
    async submissionMatch(owner, key, input) {
      const {path, reservation} = locate(owner, key);
      const prior = await readReceipt(path);
      if (prior) return prior.request === requestDigest(input) ? 'same' : 'different';
      return await hasReservation(reservation) ? 'different' : 'absent';
    },
    async submit(owner, key, {operation, videoUrl, resolution}, {isAuthorized = () => true, defaultDailyLimit} = {}) {
      if (!isAuthorized()) return {state: 'not_authorized'};
      if (!operations.has(operation) || operation === 'upscale' && !['720p', '1080p'].includes(resolution) ||
        operation === 'erase_subtitle' && resolution !== undefined) {
        throw Error('Invalid MediaKit processing parameters');
      }
      if (typeof videoUrl !== 'string' || !sources.has(httpsOrigin(videoUrl).origin)) {
        throw Error('MediaKit input origin is not configured');
      }
      const {clientToken, reservation, path} = locate(owner, key);
      const request = requestDigest({operation, videoUrl, resolution});
      const approval = approvalDigest(operation, createHash('sha256').update(videoUrl).digest('hex'), resolution);
      try { await mkdir(reservation, {mode: 0o700}); }
      catch (error) {
        if (error.code !== 'EEXIST') throw error;
        const prior = await readReceipt(path);
        if (!prior) return unknown();
        if (prior.request !== request) return {state: 'conflict', code: 'idempotency_conflict'};
        if (prior.state === 'rejected') return {state: prior.state, code: prior.code};
        return prior.state === 'accepted' ? {state: 'accepted'} : unknown();
      }
      const binding = {request, approval, ...(defaultDailyLimit === undefined ? {} : {defaultRouting: true})};
      await saveReceipt(path, {state: 'unknown', ...binding});
      if (!isAuthorized()) return {state: 'not_authorized'};
      if (defaultDailyLimit !== undefined && !await reserveDailySlot(defaultDailyLimit)) {
        const rejected = {state: 'rejected', code: 'MEDIAKIT_CAPACITY_LIMIT'};
        await saveReceipt(path, {...binding, ...rejected});
        return rejected;
      }
      if (!isAuthorized()) return {state: 'not_authorized'};
      let result;
      try { result = await provider.submit({operation, videoUrl, resolution, clientToken}); }
      catch (_error) { return unknown(); }
      if (result.state === 'rejected') {
        await saveReceipt(path, {...binding, state: 'rejected', code: result.code});
        return {state: 'rejected', code: result.code};
      }
      if (result.state === 'accepted') {
        await saveReceipt(path, {...binding, state: 'accepted', taskId: result.taskId});
        return {state: 'accepted'};
      }
      return unknown();
    },
    async claimFallback(owner, key, approval, {isAuthorized = () => true} = {}) {
      if (!isAuthorized()) return false;
      const {path, reservation} = locate(owner, key);
      const prior = await readReceipt(path);
      if (prior?.state !== 'rejected' || !isAuthorized()) return false;
      if (prior.defaultRouting !== true && (approval === undefined ||
        prior.approval !== approvalDigest(approval.operation, approval.sourceSha256, approval.resolution))) return false;
      try { await mkdir(join(reservation, 'fallback-claimed'), {mode: 0o700}); }
      catch (error) { if (error.code === 'EEXIST') return false; throw error; }
      // A lost acknowledgement or revoked session leaves the grant consumed.
      return isAuthorized();
    },
    async inspect(owner, key) {
      const {path, reservation} = locate(owner, key);
      const prior = await readReceipt(path);
      if (!prior) {
        return await hasReservation(reservation) ? unknown() : {state: 'not_found'};
      }
      if (prior.state === 'rejected') return {state: 'rejected', code: prior.code};
      if (prior.state === 'unknown') return unknown();
      try { return await provider.query(prior.taskId); }
      catch (_error) { return {state: 'unknown', code: 'query_unconfirmed'}; }
    },
  };
}
