/** Account-authenticated, explicitly approved MediaKit pilot jobs. */
import {createHash} from 'node:crypto';
import {constants} from 'node:fs';
import {open} from 'node:fs/promises';
import {isIP} from 'node:net';
import {validId} from './store.mjs';
import {createMediaKitProvider} from './mediakit-provider.mjs';
import {openMediaKitJobs} from './mediakit-jobs.mjs';

const prefix = '/api/media-postprocess';
const jobPath = /^\/api\/media-postprocess\/jobs\/([a-f0-9]{64})(\/fallback)?$/u;
const resolutions = new Set(['720p', '1080p']);
const hexDigest = /^[a-f0-9]{64}$/u;
const price = /^(?:0|[1-9][0-9]{0,4})\.[0-9]{2}$/u;
const maxRequestBytes = 8192;
const maxConfigBytes = 256 * 1024;
const sha256 = value => createHash('sha256').update(value).digest('hex');
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const positiveId = value => Number.isSafeInteger(value) && value > 0;
const approvalKey = (accountId, scriptId, taskId, operation) => JSON.stringify([accountId, scriptId, taskId, operation]);

function canonicalMediaUrl(value) {
  if (typeof value !== 'string' || value.length > 4096) return undefined;
  const url = URL.parse(value);
  if (!url || url.href !== value || url.protocol !== 'https:' || url.port || url.username || url.password ||
    url.hash || !url.hostname.includes('.') || isIP(url.hostname) || url.hostname.endsWith('.localhost')) return undefined;
  return url;
}

function exactOrigin(value) {
  if (typeof value !== 'string') return false;
  return canonicalMediaUrl(value + '/')?.origin === value;
}

function configError() {
  return Error('Invalid MediaKit pilot configuration');
}

function compileApprovals(entries) {
  if (!Array.isArray(entries)) throw configError();
  const byClip = new Map();
  const byJobKey = new Map();
  const sourceOrigins = new Set();
  for (const entry of entries) {
    if (!object(entry) || !validId(entry.accountId) || !positiveId(entry.scriptId) || !positiveId(entry.taskId) ||
      !exactOrigin(entry.sourceOrigin) || typeof entry.sourcePath !== 'string' || !entry.sourcePath.startsWith('/') ||
      typeof entry.sourceSha256 !== 'string' || !hexDigest.test(entry.sourceSha256) || !object(entry.operations)) {
      throw configError();
    }
    const source = canonicalMediaUrl(entry.sourceOrigin + entry.sourcePath);
    if (source?.pathname !== entry.sourcePath) throw configError();
    const actions = Object.entries(entry.operations);
    if (actions.length === 0) throw configError();
    for (const [operation, value] of actions) {
      if (!object(value) || typeof value.priceCny !== 'string' || !price.test(value.priceCny) || value.priceCny === '0.00' ||
        !(operation === 'upscale' && resolutions.has(value.resolution) ||
          operation === 'erase_subtitle' && value.resolution === undefined)) throw configError();
      const lookup = approvalKey(entry.accountId, entry.scriptId, entry.taskId, operation);
      if (byClip.has(lookup)) throw configError();
      const jobKey = sha256(lookup);
      const approved = {
        ...value, jobKey, operation, accountId: entry.accountId,
        sourceOrigin: entry.sourceOrigin, sourcePath: entry.sourcePath, sourceSha256: entry.sourceSha256,
      };
      byClip.set(lookup, approved);
      byJobKey.set(jobKey, approved);
      sourceOrigins.add(entry.sourceOrigin);
    }
  }
  return {byClip, byJobKey, sourceOrigins};
}

/**
 * Open the MediaKit pilot using the gateway's private configuration and durable job directory.
 * @param {string|undefined} file Configuration path. An absent path disables the pilot.
 * @param {object} [options] Optional test-only HTTP transport override. The default uses the provider's live endpoint.
 * @returns {Promise<object|undefined>} Allowlisted preview, submission and lookup operations, or undefined when disabled.
 */
export async function loadMediaKitPilot(file, {fetchImpl} = {}) {
  if (!file) return undefined;
  const flags = constants.O_RDONLY | (process.platform === 'win32' ? 0 : constants.O_NOFOLLOW | constants.O_NONBLOCK);
  const handle = await open(file, flags);
  let config;
  try {
    const info = await handle.stat();
    if (!info.isFile() || info.size > maxConfigBytes || process.platform !== 'win32' && (info.mode & 0o777) !== 0o600) {
      throw Error('MediaKit configuration requires a private 0600 regular file');
    }
    try { config = JSON.parse(await handle.readFile('utf8')); }
    catch (error) { if (error instanceof SyntaxError) throw configError(); throw error; }
  } finally {
    await handle.close();
  }
  if (!object(config) || !Array.isArray(config.resultOrigins) || config.resultOrigins.length === 0 ||
    !config.resultOrigins.every(exactOrigin)) throw configError();
  const requestRatePerMinute = config.requestRatePerMinute ?? 60;
  if (!Number.isSafeInteger(requestRatePerMinute) || requestRatePerMinute <= 0) throw configError();
  const {byClip, byJobKey, sourceOrigins} = compileApprovals(config.approvals);
  const provider = createMediaKitProvider({
    apiKey: config.apiKey, queueId: config.queueId, timeoutMs: config.timeoutMs, fetchImpl,
  });
  const jobs = await openMediaKitJobs({directory: config.receiptDirectory, provider, allowedSourceOrigins: [...sourceOrigins]});
  const resultOrigins = new Set(config.resultOrigins);
  return {
    requestRatePerMinute,
    async preview(accountId, input) {
      const key = approvalKey(accountId, input.scriptId, input.taskId, input.operation);
      const entry = byClip.get(key);
      const url = canonicalMediaUrl(input.videoUrl);
      const existing = await jobs.submissionMatch(accountId, sha256(key), input);
      if (!entry || input.resolution !== entry.resolution || !url || entry.sourceOrigin !== url.origin ||
        entry.sourcePath !== url.pathname || sha256(input.videoUrl) !== entry.sourceSha256) {
        return {state: existing === 'absent' ? 'ineligible' : 'blocked'};
      }
      if (existing === 'different') return {state: 'blocked'};
      return {state: 'ready', jobKey: entry.jobKey, amount: entry.priceCny, unit: 'CNY'};
    },
    submit: jobs.submit,
    async claimFallback(accountId, jobKey, options) {
      const entry = byJobKey.get(jobKey);
      if (entry?.accountId !== accountId) return false;
      return await jobs.claimFallback(accountId, jobKey, entry, options);
    },
    async inspect(accountId, jobKey) {
      const result = await jobs.inspect(accountId, jobKey);
      if (result.state !== 'completed') return result;
      const url = canonicalMediaUrl(result.videoUrl);
      if (!url || !resultOrigins.has(url.origin)) return {state: 'unknown', code: 'MEDIAKIT_RESULT_ORIGIN_UNAPPROVED'};
      return {...result, downloadOrigin: url.origin};
    },
  };
}

function validRequest(value, submit) {
  if (!object(value) || !positiveId(value.scriptId) || !positiveId(value.taskId) || typeof value.videoUrl !== 'string' ||
    !(value.operation === 'upscale' && resolutions.has(value.resolution) ||
    value.operation === 'erase_subtitle' && value.resolution === undefined)) return false;
  if (submit ? typeof value.jobKey !== 'string' || !hexDigest.test(value.jobKey) : value.jobKey !== undefined) return false;
  return Object.keys(value).every(key => ['scriptId', 'taskId', 'videoUrl', 'operation', 'resolution', 'jobKey'].includes(key));
}

async function body(req) {
  if (req.headers['content-type']?.split(';', 1)[0].trim().toLowerCase() !== 'application/json') return {status: 415};
  const chunks = [];
  let size = 0;
  for await (const chunk of req.iterator({destroyOnReturn: false})) {
    size += chunk.length;
    if (size > maxRequestBytes) return {status: 413};
    chunks.push(chunk);
  }
  try { return {value: JSON.parse(Buffer.concat(chunks).toString('utf8'))}; }
  catch (error) { if (error instanceof SyntaxError) return {status: 400}; throw error; }
}

/**
 * Serve the private pilot without passing source addresses or provider response data into gateway errors.
 * @param {object} options Gateway-provided request, route and authenticated session operations.
 * @returns {Promise<boolean>} Whether the MediaKit namespace handled this request.
 */
export async function mediaKitRoute({req, res, path, mediaKit, currentSession, originOK, rate, reply, accepting}) {
  if (path !== prefix && !path.startsWith(prefix + '/')) return false;
  function answer(status, data, headers) {
    req.resume();
    if (!res.destroyed) reply(res, status, JSON.stringify(data), {'content-type': 'application/json; charset=utf-8', ...headers});
    return true;
  }
  if (!mediaKit) return answer(404, {code: 'not_found'});
  const preview = path === prefix + '/preview';
  const submit = path === prefix + '/jobs';
  const match = jobPath.exec(path);
  const fallback = match?.[2] !== undefined;
  if (!preview && !submit && !match) return answer(404, {code: 'not_found'});
  const s = currentSession();
  if (!s) return answer(401, {code: 'account_session_expired'});
  const method = match && !fallback ? 'GET' : 'POST';
  if (req.method !== method) return answer(405, {code: 'invalid_request'}, {allow: method});
  if (!originOK(method === 'POST')) return answer(403, {code: 'origin_denied'});
  if (!rate(s.id, mediaKit.requestRatePerMinute)) return answer(429, {code: 'request_rate'}, {'retry-after': '60'});
  const stillSignedIn = () => !res.destroyed && currentSession()?.token === s.token;
  try {
    if (fallback) {
      if (!accepting()) return answer(503, {code: 'server_draining'});
      const claimed = await mediaKit.claimFallback(s.id, match[1], {isAuthorized: () => stillSignedIn() && accepting()});
      if (!stillSignedIn()) return answer(401, {code: 'account_session_expired'});
      return answer(200, {claimed});
    }
    if (match) {
      const result = await mediaKit.inspect(s.id, match[1]);
      if (!stillSignedIn()) return answer(401, {code: 'account_session_expired'});
      return answer(200, result);
    }
    const parsed = await body(req);
    if (parsed.status) return answer(parsed.status, {code: 'invalid_request'});
    if (!validRequest(parsed.value, submit)) return answer(400, {code: 'invalid_request'});
    if (!stillSignedIn()) return answer(401, {code: 'account_session_expired'});
    const entry = await mediaKit.preview(s.id, parsed.value);
    if (!stillSignedIn()) return answer(401, {code: 'account_session_expired'});
    if (preview) return entry.state === 'blocked' ? answer(409, {code: 'existing_media_processing'}) : answer(200, entry);
    if (entry.state !== 'ready' || entry.jobKey !== parsed.value.jobKey) {
      return answer(200, {state: 'conflict', code: 'preview_mismatch'});
    }
    if (!accepting()) return answer(503, {code: 'server_draining'});
    const result = await mediaKit.submit(s.id, entry.jobKey, parsed.value, {
      isAuthorized: () => stillSignedIn() && accepting(),
    });
    if (!stillSignedIn()) return answer(401, {code: 'account_session_expired'});
    if (result.state === 'not_authorized') return answer(503, {code: 'server_draining'});
    return answer(200, result);
  } catch (_error) {
    return answer(503, {code: 'mediakit_temporarily_unavailable'});
  }
}
