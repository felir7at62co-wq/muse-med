/** Bounded public-page transport with request-local compatibility for Qimao's observed folded HTTP/1 headers. */
import https from 'node:https';
import { ORIGIN, QimaoError } from './parser.js';

/**
 * Admit only generated public metadata paths; callers cannot supply another origin or chapter path.
 * @param path Generated metadata pathname.
 * @returns The fixed official HTTPS URL.
 */
export function metadataUrl(path) {
  if (typeof path !== 'string' || !/^\/(?:paihang\/(?:boy|girl)\/(?:hot|new|over|collect|update)\/(?:date|month)\/|shuku\/(?:\d{1,24}|a-a-a-1-1-a-0-click-\d+)\/)$/u.test(path)) {
    throw new QimaoError('invalid_metadata_path', 'Only generated official Qimao metadata paths are supported');
  }
  return new URL(path, ORIGIN);
}

function responseStatus(status) {
  if (status === 403 || status === 429) throw new QimaoError('access_blocked', `The public site denied this request (HTTP ${status})`);
  if (status >= 300 && status < 400) throw new QimaoError('redirect_rejected', 'Public metadata redirects are not followed');
  if (status !== 200) throw new QimaoError('http_error', `The public metadata page returned HTTP ${status}`);
}

function responseHeaders(contentType, encoding, length, maximum) {
  if (!/^text\/html(?:;|$)/iu.test(contentType ?? '')) throw new QimaoError('invalid_content_type', 'The public metadata response is not HTML');
  if (encoding && encoding.toLowerCase() !== 'identity') throw new QimaoError('unsupported_encoding', 'The public metadata response ignored the identity encoding request');
  if (length !== undefined && length !== null && length !== '' && (!/^\d+$/u.test(String(length)) || Number(length) > maximum)) throw new QimaoError('response_too_large', 'The public metadata response exceeds maxResponseBytes');
}

const headers = Object.freeze({ accept: 'text/html', 'accept-encoding': 'identity', 'user-agent': 'Muse-Qimao-Metadata/0.1' });

/**
 * Race an owned operation against cancellation and detach its listener after either outcome.
 * @param promise The owned operation or admission barrier.
 * @param signal Cancellation for the current caller.
 * @returns The operation's value unless the caller cancels first.
 */
export function abortable(promise, signal) {
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const aborted = () => { signal.removeEventListener('abort', aborted); reject(signal.reason); };
    signal.addEventListener('abort', aborted, { once: true });
    promise.then(value => { signal.removeEventListener('abort', aborted); resolve(value); }, error => { signal.removeEventListener('abort', aborted); reject(error); });
  });
}

async function strictHtml(url, config, signal, fetchPage) {
  const response = await abortable(fetchPage(url.href, { redirect: 'error', credentials: 'omit', headers, signal }), signal);
  try {
    responseStatus(response.status);
    if (response.redirected || response.url && response.url !== url.href) throw new QimaoError('redirect_rejected', 'The public metadata response changed its URL');
    responseHeaders(response.headers.get('content-type'), response.headers.get('content-encoding'), response.headers.get('content-length'), config.maxResponseBytes);
  } catch (error) { await response.body?.cancel(); throw error; }
  if (!response.body) throw new QimaoError('empty_response', 'The public metadata response has no body');
  const reader = response.body.getReader(), chunks = [];
  let size = 0;
  try {
    while (true) {
      const chunk = await abortable(reader.read(), signal);
      if (chunk.done) break;
      size += chunk.value.byteLength;
      if (size > config.maxResponseBytes) throw new QimaoError('response_too_large', 'The public metadata response exceeds maxResponseBytes');
      chunks.push(Buffer.from(chunk.value));
    }
  } catch (error) { await reader.cancel(); throw error; }
  finally { reader.releaseLock(); }
  const expected = response.headers.get('content-length');
  if (expected !== null && size !== Number(expected)) throw new QimaoError('response_length_mismatch', 'The public metadata body differs from its declared Content-Length');
  return Buffer.concat(chunks).toString('utf8');
}

/**
 * Validate completed identity-encoded legacy HTTP bodies, including explicit framing and actual byte counts.
 * @param response Incoming response whose socket remains owned by the request.
 * @param config Validated size bounds.
 * @returns Completed UTF-8 HTML, rejecting ambiguous or incomplete framing.
 */
export function readLegacyResponse(response, config) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const chunks = [];
    let size = 0;
    const finish = (error, value) => { if (!settled) { settled = true; if (error) reject(error); else resolve(value); } };
    response.once('error', error => { finish(error); });
    response.once('close', () => { if (!response.complete) finish(new QimaoError('incomplete_response', 'The public metadata response ended before completion')); });
    try {
      responseStatus(response.statusCode);
      responseHeaders(response.headers['content-type'], response.headers['content-encoding'], response.headers['content-length'], config.maxResponseBytes);
      const raw = response.rawHeaders ?? [];
      const lengths = raw.filter((value, index) => index % 2 === 0 && value.toLowerCase() === 'content-length');
      if (lengths.length > 1 || response.headers['content-length'] !== undefined && response.headers['transfer-encoding'] !== undefined) throw new QimaoError('ambiguous_framing', 'The legacy response has conflicting HTTP body framing');
      if (response.headers['transfer-encoding'] !== undefined && response.headers['transfer-encoding'].toLowerCase() !== 'chunked') throw new QimaoError('ambiguous_framing', 'The legacy response has unsupported HTTP transfer framing');
    } catch (error) { finish(error); response.destroy(); return; }
    response.on('data', chunk => {
      if (settled) return;
      size += chunk.length;
      if (size > config.maxResponseBytes) {
        finish(new QimaoError('response_too_large', 'The public metadata response exceeds maxResponseBytes'));
        response.destroy(); return;
      }
      chunks.push(Buffer.from(chunk));
    });
    response.once('end', () => {
      const expected = response.headers['content-length'];
      if (!response.complete) finish(new QimaoError('incomplete_response', 'The legacy response did not complete its HTTP body'));
      else if (expected !== undefined && size !== Number(expected)) finish(new QimaoError('response_length_mismatch', 'The legacy metadata body differs from its declared Content-Length'));
      else finish(null, Buffer.concat(chunks).toString('utf8'));
    });
  });
}

/**
 * Request-local header compatibility, with TLS, fixed origin, no cookies and awaited socket closure.
 * @param url Fixed-source public metadata URL.
 * @param config Validated response bounds.
 * @param signal Deadline and caller cancellation.
 * @returns Completed HTML only after request resources close.
 */
export async function legacyHtml(url, config, signal) {
  if (url.origin !== ORIGIN || url.username || url.password || url.search || url.hash) throw new QimaoError('invalid_metadata_path', 'Header compatibility is restricted to official Qimao metadata');
  metadataUrl(url.pathname);
  let request, close, activeResponse;
  const closed = new Promise(resolve => { close = resolve; });
  const result = new Promise((resolve, reject) => {
    let settled = false;
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      if (error) reject(error); else resolve(value);
    };
    request = https.request(url, { method: 'GET', agent: false, rejectUnauthorized: true, insecureHTTPParser: true, headers, signal }, response => {
      activeResponse = response;
      void readLegacyResponse(response, config).then(value => { finish(null, value); }, error => { finish(error); request.destroy(); });
    });
    request.once('error', error => { finish(error); });
    request.once('close', () => { if (!activeResponse) finish(new QimaoError('incomplete_response', 'The metadata connection closed before response headers')); close(); });
    request.end();
  });
  try { return await result; }
  finally { request?.destroy(); await closed; }
}

/**
 * Prefer strict HTTP parsing; only observed parser/framing exceptions permit one fixed-source compatibility request.
 * @param path Generated public metadata path.
 * @param config Validated deployment settings.
 * @param signal Deadline and caller cancellation.
 * @param dependencies Optional transport implementations with the same response checks.
 * @returns Public HTML and the transport used, without account data.
 */
export async function readMetadata(path, config, signal, dependencies = {}) {
  const url = metadataUrl(path);
  signal.throwIfAborted();
  try { return { html: await strictHtml(url, config, signal, dependencies.fetch ?? globalThis.fetch), transport: 'fetch' }; }
  catch (error) {
    const code = error?.cause?.code ?? error?.code;
    if (signal.aborted || !config.allowLegacyResponseHeaders || !['HPE_INVALID_HEADER_TOKEN', 'UND_ERR_RES_CONTENT_LENGTH_MISMATCH'].includes(code)) throw error;
    return { html: await (dependencies.legacyRequest ?? legacyHtml)(url, config, signal), transport: 'https_legacy_headers' };
  }
}
