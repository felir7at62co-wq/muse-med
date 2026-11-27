/** Volcengine AI MediaKit async submissions and status queries. */
const endpoint = 'https://mediakit.cn-beijing.volces.com/api/v1';
const tools = new Map([
  ['upscale', 'enhance-video-generative'],
  ['erase_subtitle', 'erase-video-subtitle-pro'],
]);
const resolutions = new Set(['720p', '1080p']);
const taskIdPattern = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/u;
const tokenPattern = /^[\x20-\x7e]{1,64}$/u;
const maxResponseBytes = 64 * 1024;
const rejections = new Map([
  ['MissingParameter', {status: 400, code: 'MEDIAKIT_INVALID_ARGUMENT'}],
  ['InvalidParameter', {status: 400, code: 'MEDIAKIT_INVALID_ARGUMENT'}],
  ['AuthenticationError', {status: 401, code: 'MEDIAKIT_AUTHENTICATION_REQUIRED'}],
  ['AccessDenied', {status: 403, code: 'MEDIAKIT_PERMISSION_DENIED'}],
  ['RequestLimitExceeded', {status: 429, code: 'MEDIAKIT_RATE_LIMITED'}],
]);

function validTaskId(value) {
  return typeof value === 'string' && taskIdPattern.test(value);
}

function validVideoUrl(value) {
  if (typeof value !== 'string' || /[\x00-\x20\x7f]/u.test(value)) return false;
  const parsed = URL.parse(value);
  return parsed?.protocol === 'https:' && !parsed.username && !parsed.password && !parsed.hash;
}

function submissionRejection(status, payload) {
  if (payload?.task_id !== undefined && payload.task_id !== '') return undefined;
  if (payload?.success === false) {
    const rejection = rejections.get(payload.error?.code);
    if (rejection && (status === rejection.status || status >= 200 && status < 300)) return rejection.code;
  }
  if (payload?.success === undefined && payload?.error === undefined) {
    const rejection = rejections.get(payload?.code);
    if (rejection && status === rejection.status) return rejection.code;
  }
  return undefined;
}

async function readBody(response) {
  if (!response.body) return null;
  let size = 0;
  const buffers = [];
  for await (const chunk of response.body) {
    size += chunk.byteLength;
    if (size > maxResponseBytes) return null;
    buffers.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(buffers).toString('utf8'));
  } catch (error) {
    if (error instanceof SyntaxError) return null;
    throw error;
  }
}

/**
 * Create the fixed-origin MediaKit client. A rejected submission had no accepted task.
 * An unknown submission may have been accepted. A failed task does not establish its billing status.
 * @param {object} options Provider credential, optional queue, timeout in milliseconds and an optional HTTP transport.
 * @param {string} options.apiKey MediaKit bearer credential.
 * @param {string} [options.queueId] Target queue. Omitting it selects the provider's default queue.
 * @param {number} options.timeoutMs Deadline for the request and response body.
 * @param {typeof fetch} [options.fetchImpl] Transport override for offline tests.
 * @returns {object} Methods to submit an operation with a stable client token and query its provider task ID.
 */
export function createMediaKitProvider({apiKey, queueId, timeoutMs, fetchImpl = fetch}) {
  if (typeof apiKey !== 'string' || !/^[\x21-\x7e]+$/u.test(apiKey) ||
    !Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 2_147_483_647 ||
    queueId !== undefined && (typeof queueId !== 'string' || !queueId)) {
    throw Error('Invalid MediaKit provider configuration');
  }
  const headers = {Authorization: 'Bearer ' + apiKey, Accept: 'application/json'};

  async function request(path, body) {
    const init = body === undefined
      ? {method: 'GET', headers}
      : {method: 'POST', headers: {...headers, 'Content-Type': 'application/json'}, body: JSON.stringify(body)};
    let response;
    try {
      response = await fetchImpl(endpoint + path, {
        ...init,
        redirect: 'error',
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (_transportError) {
      // The server may already have accepted the request. The transport error may contain credentials.
      return undefined;
    }
    let payload;
    try { payload = await readBody(response); }
    catch (_readError) { return undefined; }
    return {status: response.status, success: response.ok, payload};
  }

  return {
    async submit({operation, videoUrl, resolution, clientToken}) {
      const tool = tools.get(operation);
      if (tool === undefined || !validVideoUrl(videoUrl) ||
        typeof clientToken !== 'string' || !tokenPattern.test(clientToken) ||
        (operation === 'upscale' ? !resolutions.has(resolution) : resolution !== undefined)) {
        return {state: 'rejected', code: 'MEDIAKIT_INVALID_ARGUMENT'};
      }
      const settings = operation === 'upscale' ? {resolution} : {model_version: 'v5', mode: 'Subtitle'};
      const result = await request('/tools/' + tool, {
        video_url: videoUrl,
        client_token: clientToken,
        ...(queueId === undefined ? {} : {queue_id: queueId}),
        ...settings,
      });
      if (result === undefined) return {state: 'unknown', code: 'MEDIAKIT_TRANSPORT'};
      const {status, success, payload} = result;
      if (success && payload?.success === true && validTaskId(payload.task_id)) {
        return {state: 'accepted', taskId: payload.task_id};
      }
      const code = submissionRejection(status, payload);
      return code === undefined
        ? {state: 'unknown', code: 'MEDIAKIT_INVALID_RESPONSE'}
        : {state: 'rejected', code};
    },

    async query(taskId) {
      if (!validTaskId(taskId)) return {state: 'unknown', code: 'MEDIAKIT_INVALID_ARGUMENT'};
      const result = await request('/tasks/' + taskId);
      if (result === undefined) return {state: 'unknown', code: 'MEDIAKIT_TRANSPORT'};
      const {status, success, payload} = result;
      if (status === 410 && payload?.code === 'TaskCanceled' && payload.success === undefined &&
        (payload.task_id === undefined || payload.task_id === taskId)) {
        return {state: 'failed', code: 'MEDIAKIT_TASK_CANCELED'};
      }
      if (success && payload?.success === true && payload.task_id === taskId) {
        if (payload.status === 'running') return {state: 'pending'};
        if (payload.status === 'failed') return {state: 'failed', code: 'MEDIAKIT_TASK_FAILED'};
        if (payload.status === 'completed' && validVideoUrl(payload.result?.video_url)) {
          return {state: 'completed', videoUrl: payload.result.video_url};
        }
      }
      return {state: 'unknown', code: 'MEDIAKIT_INVALID_RESPONSE'};
    },
  };
}
