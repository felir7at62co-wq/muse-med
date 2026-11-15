/** Bounded NDJSON transport for a caller-configured, managed Hongguo v2 process. */
import { isAbsolute } from 'node:path';
import { TextDecoder } from 'node:util';

const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const own = (value, key) => Object.hasOwn(value, key);
const messages = {
  v2_not_ready: '红果 v2 引擎尚未完成握手',
  v2_closed: '红果 v2 引擎已关闭',
  v2_cancelled: '红果 v2 请求已取消',
  v2_start_timeout: '红果 v2 引擎启动超时',
  v2_request_timeout: '红果 v2 请求超时',
  v2_capacity: '红果 v2 待处理请求已达到配置上限',
  v2_protocol: '红果 v2 引擎返回无效协议消息',
  v2_protocol_version: '红果 v2 引擎协议版本不匹配',
  v2_line_size: '红果 v2 协议消息超过配置上限',
  v2_request_json: '红果 v2 请求无法编码为 JSON',
  v2_remote_error: '红果 v2 引擎拒绝了请求',
  v2_io: '红果 v2 引擎通信失败',
  v2_exit: '红果 v2 引擎已退出',
  v2_eof: '红果 v2 引擎输出已关闭',
  v2_notification: '红果 v2 通知处理失败',
  v2_shutdown: '红果 v2 引擎退出清理失败',
};
class V2EngineError extends Error {
  constructor(code, rpcCode) {
    super(messages[code]);
    this.code = code;
    if (Number.isSafeInteger(rpcCode)) this.rpcCode = rpcCode;
  }
}
const failure = (code, rpcCode) => new V2EngineError(code, rpcCode);
const deferred = () => {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  void promise.catch(() => {});
  return { promise, resolve, reject };
};

function checkedSpec(spec) {
  const invalid = key => { throw new TypeError(`Invalid v2 engine spec: ${key}`); };
  if (!object(spec)) invalid('object');
  if (!Array.isArray(spec.argv) || !spec.argv.length || spec.argv.some(value => typeof value !== 'string' || !value || value.includes('\0'))) invalid('argv');
  if (typeof spec.cwd !== 'string' || !isAbsolute(spec.cwd) || spec.cwd.includes('\0')) invalid('cwd');
  if (!object(spec.env) || Object.values(spec.env).some(value => value !== undefined && typeof value !== 'string')) invalid('env');
  if (typeof spec.clientVersion !== 'string' || !spec.clientVersion || spec.clientVersion.includes('\0')) invalid('clientVersion');
  for (const key of ['startupTimeoutMs', 'requestTimeoutMs', 'maxLineBytes', 'maxPendingRequests', 'shutdownTimeoutMs', 'processGraceMs']) {
    if (!Number.isSafeInteger(spec[key]) || spec[key] < 1 || spec[key] > 2_147_483_647) invalid(key);
  }
  return Object.freeze({ ...spec, argv: Object.freeze([...spec.argv]), env: Object.freeze({ ...spec.env }) });
}

/**
 * Own one lazy process; protocol results and notifications remain private to the caller.
 * @param {object} subprocess Managed subprocess service exposing spawn.
 * @param {object} spec Explicit argv/cwd/env, all six limits, and clientVersion; no defaults are applied.
 * @param {Function} [onNotification] Synchronous notification consumer; omitted means notifications are ignored.
 */
export class V2EngineClient {
  constructor(subprocess, spec, onNotification) {
    this.spec = checkedSpec(spec);
    this.subprocess = subprocess;
    this.onNotification = onNotification;
    this.state = 'idle';
    this.pending = new Map();
    this.writes = new Set();
    this.listeners = [];
    this.startWaiters = new Set();
    this.lineBuffer = Buffer.alloc(0);
    this.lineBytes = 0;
    this.nextId = 0n;
    this.handle = null;
    this.startTask = null;
    this.disposeTask = null;
    this.cleanupTask = null;
    this.error = null;
    this.exited = false;
    this.stdoutEnded = false;
    this.terminated = false;
    this.terminationFailed = false;
  }

  /**
   * Await engine.ready and a protocol-2 app.hello. Concurrent callers share startup.
   * @param {AbortSignal} [signal] Cancels this wait; cancelling the last startup waiter terminates startup.
   * @returns {Promise<object>} The validated hello result; it is not a download or license result.
   */
  async start(signal) {
    if (signal?.aborted) throw failure('v2_cancelled');
    if (this.state === 'closing' || this.state === 'closed') throw failure('v2_closed');
    if (this.exited) throw this.error ?? failure('v2_exit');
    if (this.state === 'ready') return this.hello;
    if (this.error) throw this.error;
    if (!this.startTask) this.beginStart();
    const waiter = {};
    this.startWaiters.add(waiter);
    let abort;
    const cancelled = new Promise((_resolve, reject) => {
      if (signal) { abort = () => reject(failure('v2_cancelled')); signal.addEventListener('abort', abort, { once: true }); }
    });
    try { return await Promise.race([this.startTask, cancelled]); }
    finally {
      if (abort) signal.removeEventListener('abort', abort);
      this.startWaiters.delete(waiter);
      if (this.state === 'starting' && !this.startWaiters.size) {
        this.fail(failure('v2_cancelled'));
        await this.cleanup();
      }
    }
  }

  beginStart() {
    this.state = 'starting';
    this.ready = deferred();
    this.startTimer = setTimeout(() => this.fail(failure('v2_start_timeout')), this.spec.startupTimeoutMs);
    this.startTask = (async () => {
      try {
        this.handle = this.subprocess.spawn({ argv: this.spec.argv, cwd: this.spec.cwd, env: this.spec.env,
          stdio: { stdin: 'pipe', stdout: 'pipe', stderr: 'pipe' }, graceMs: this.spec.processGraceMs });
        if (!this.handle.stdin || !this.handle.stdout || !this.handle.stderr) throw failure('v2_io');
        this.listen(this.handle.stdin, 'error', () => this.fail(failure('v2_io')));
        this.listen(this.handle.stdout, 'data', chunk => this.receive(chunk));
        this.listen(this.handle.stdout, 'end', () => this.endOutput());
        this.listen(this.handle.stdout, 'close', () => this.endOutput());
        this.listen(this.handle.stdout, 'error', () => this.fail(failure('v2_io')));
        this.listen(this.handle.stderr, 'data', () => {});
        this.listen(this.handle.stderr, 'error', () => this.fail(failure('v2_io')));
        this.handle.done.then(() => this.processExited(), () => this.processExited());
        await this.ready.promise;
        const hello = await this.rpc('app.hello', { client: 'Muse', clientVersion: this.spec.clientVersion, protocol: 2 }, undefined, this.spec.requestTimeoutMs);
        if (!object(hello) || hello.protocol !== 2 || hello.engineVersion !== this.readyVersion
          || !Array.isArray(hello.capabilities) || hello.capabilities.some(value => typeof value !== 'string')
          || !Number.isSafeInteger(hello.build) || hello.build < 0) throw failure('v2_protocol_version');
        if (this.error || this.state !== 'starting' || this.exited) throw this.error ?? failure('v2_exit');
        this.hello = hello;
        this.state = 'ready';
        return hello;
      } catch (error) {
        const safe = error instanceof V2EngineError ? error : failure('v2_io');
        this.fail(safe);
        await this.cleanup();
        throw safe;
      } finally { clearTimeout(this.startTimer); }
    })();
    void this.startTask.catch(() => {});
  }

  /**
   * Send one request after start; results stay private and remote error text is discarded.
   * @param {string} method Method name; lifecycle methods are owned by start/dispose.
   * @param {*} params JSON-encodable request parameters.
   * @param {AbortSignal} [signal] Cancels the request and sends $/cancelRequest; omission uses only the request deadline.
   * @returns {Promise<*>} The correlated result, or a fixed safe error.
   */
  request(method, params, signal) {
    if (this.error) return Promise.reject(this.error);
    if (this.state !== 'ready' || this.exited) return Promise.reject(failure(this.state === 'idle' || this.state === 'starting' ? 'v2_not_ready' : 'v2_closed'));
    if (['app.hello', 'app.shutdown', '$/cancelRequest'].includes(method)) return Promise.reject(failure('v2_protocol'));
    return this.rpc(method, params, signal, this.spec.requestTimeoutMs);
  }

  rpc(method, params, signal, timeoutMs) {
    if (typeof method !== 'string' || !method || signal?.aborted) return Promise.reject(failure(signal?.aborted ? 'v2_cancelled' : 'v2_request_json'));
    if (this.pending.size >= this.spec.maxPendingRequests) return Promise.reject(failure('v2_capacity'));
    const id = String(++this.nextId), value = deferred();
    const entry = { ...value, timer: null, abort: null, signal };
    this.pending.set(id, entry);
    const cancel = code => {
      if (!this.pending.has(id)) return;
      this.settle(id, failure(code));
      if (!this.exited && this.state !== 'closed') void this.write({ jsonrpc: '2.0', method: '$/cancelRequest', params: { id } }).catch(() => this.fail(failure('v2_io')));
    };
    entry.timer = setTimeout(() => cancel('v2_request_timeout'), timeoutMs);
    if (signal) { entry.abort = () => cancel('v2_cancelled'); signal.addEventListener('abort', entry.abort, { once: true }); }
    if (signal?.aborted) entry.abort();
    if (this.pending.has(id)) {
      void this.write({ jsonrpc: '2.0', id, method, params }).catch(error => {
        this.settle(id, error);
        if (error.code !== 'v2_request_json' && error.code !== 'v2_line_size') this.fail(error);
      });
    }
    return value.promise;
  }

  write(message) {
    let line;
    try { line = JSON.stringify(message); } catch (error) { return Promise.reject(failure('v2_request_json')); }
    if (Buffer.byteLength(line) > this.spec.maxLineBytes) return Promise.reject(failure('v2_line_size'));
    if (!this.handle || this.exited || this.error || this.state === 'closed') return Promise.reject(this.error ?? failure('v2_closed'));
    if (this.writes.size >= this.spec.maxPendingRequests + 1) return Promise.reject(failure('v2_capacity'));
    const value = deferred();
    this.writes.add(value);
    const done = error => { if (!this.writes.delete(value)) return; error ? value.reject(failure('v2_io')) : value.resolve(); };
    try { this.handle.stdin.write(`${line}\n`, done); } catch (error) { done(error); }
    return value.promise;
  }

  settle(id, error, result) {
    const entry = this.pending.get(id);
    if (!entry) return;
    this.pending.delete(id);
    clearTimeout(entry.timer);
    if (entry.abort) entry.signal.removeEventListener('abort', entry.abort);
    error ? entry.reject(error) : entry.resolve(result);
  }

  listen(stream, event, callback) { stream.on(event, callback); this.listeners.push(() => stream.off(event, callback)); }

  receive(chunk) {
    if (this.error || this.stdoutEnded) return;
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    let offset = 0;
    while (offset < bytes.length && !this.error) {
      const newline = bytes.indexOf(10, offset), end = newline < 0 ? bytes.length : newline;
      const size = this.lineBytes + end - offset;
      if (size > this.spec.maxLineBytes) { this.fail(failure('v2_line_size')); return; }
      if (size > this.lineBuffer.length) {
        const grown = Buffer.allocUnsafe(Math.min(this.spec.maxLineBytes, Math.max(size, this.lineBuffer.length * 2)));
        this.lineBuffer.copy(grown, 0, 0, this.lineBytes);
        this.lineBuffer = grown;
      }
      bytes.copy(this.lineBuffer, this.lineBytes, offset, end);
      this.lineBytes = size;
      if (newline < 0) return;
      const line = this.lineBuffer.subarray(0, this.lineBytes);
      this.lineBytes = 0;
      this.line(line);
      offset = newline + 1;
    }
  }

  line(bytes) {
    try {
      if (bytes.at(-1) === 13) bytes = bytes.subarray(0, -1);
      const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes).replace(/^\uFEFF/, '').trim();
      if (!text) return;
      const value = JSON.parse(text);
      if (!object(value) || value.jsonrpc !== '2.0') throw failure('v2_protocol');
      if (own(value, 'method')) {
        if (typeof value.method !== 'string' || !value.method || own(value, 'id') || own(value, 'result') || own(value, 'error')) throw failure('v2_protocol');
        if (value.method === 'engine.ready') {
          if (!object(value.params) || value.params.protocol !== 2 || typeof value.params.engineVersion !== 'string'
            || !value.params.engineVersion || this.readyVersion && this.readyVersion !== value.params.engineVersion) throw failure('v2_protocol_version');
          this.readyVersion = value.params.engineVersion;
          this.ready.resolve();
        }
        if (this.onNotification) {
          try { this.onNotification(value.method, value.params); } catch (error) { throw failure('v2_notification'); }
        }
        return;
      }
      if ((typeof value.id !== 'string' && !Number.isSafeInteger(value.id)) || own(value, 'result') === own(value, 'error')) throw failure('v2_protocol');
      if (own(value, 'error')) {
        if (!object(value.error) || !Number.isSafeInteger(value.error.code) || typeof value.error.message !== 'string') throw failure('v2_protocol');
        this.settle(value.id, failure('v2_remote_error', value.error.code));
      } else this.settle(value.id, null, value.result);
      // Well-formed replies for cancelled or unknown IDs never settle another request.
    } catch (error) { this.fail(error instanceof V2EngineError ? error : failure('v2_protocol')); }
  }

  endOutput() {
    if (this.stdoutEnded) return;
    this.stdoutEnded = true;
    if (this.lineBytes && !this.error) this.line(this.lineBuffer.subarray(0, this.lineBytes));
    this.lineBuffer = Buffer.alloc(0); this.lineBytes = 0;
    clearTimeout(this.drainTimer);
    if (this.state !== 'closing' && this.state !== 'closed') this.fail(failure(this.exited ? 'v2_exit' : 'v2_eof'));
    else for (const id of this.pending.keys()) this.settle(id, failure('v2_eof'));
  }

  processExited() {
    this.exited = true;
    if (this.stdoutEnded) { if (this.state !== 'closing' && this.state !== 'closed') this.fail(failure('v2_exit')); }
    else this.drainTimer = setTimeout(() => this.fail(failure('v2_exit')), this.spec.shutdownTimeoutMs);
  }

  terminate() {
    if (this.handle && !this.terminated) {
      this.terminated = true;
      try { this.handle.terminate(); }
      catch (error) { this.terminationFailed = true; this.error ??= failure('v2_shutdown'); }
    }
  }

  fail(error) {
    if (this.state === 'closed') return;
    this.error ??= error;
    if (this.state !== 'closing') this.state = 'failed';
    clearTimeout(this.startTimer); clearTimeout(this.drainTimer);
    this.ready?.reject(this.error);
    for (const id of this.pending.keys()) this.settle(id, this.error);
    for (const value of this.writes) value.reject(this.error);
    this.writes.clear();
    this.terminate();
    void this.cleanup().catch(() => {});
  }

  cleanup() {
    if (!this.cleanupTask) this.cleanupTask = (async () => {
      try {
        if (this.terminationFailed) throw failure('v2_shutdown');
        if (this.handle) { await this.handle.waitForExit(); await this.handle.done.catch(() => {}); }
      } catch (error) { throw failure('v2_shutdown'); }
      finally {
        clearTimeout(this.startTimer); clearTimeout(this.drainTimer);
        for (const id of this.pending.keys()) this.settle(id, this.error ?? failure('v2_closed'));
        for (const value of this.writes) value.reject(this.error ?? failure('v2_closed'));
        this.writes.clear();
        // Closing the pipes first prevents delayed native write callbacks from emitting unhandled errors.
        if (this.handle) await Promise.all([this.handle.stdin, this.handle.stdout, this.handle.stderr].filter(Boolean).map(stream => {
          if (stream.closed) return undefined;
          return new Promise(resolve => { stream.once('close', resolve); stream.destroy(); });
        }));
        for (const remove of this.listeners.splice(0)) remove();
        this.lineBuffer = Buffer.alloc(0); this.lineBytes = 0;
      }
    })();
    return this.cleanupTask;
  }

  /**
   * Stop new requests, ask a ready engine to shut down, close stdin and join its managed range.
   * @returns {Promise<void>} Shared completion; expiry terminates the process before awaiting its exit.
   * @throws {Error} A safe v2_shutdown error when termination or range observation fails; process exit is then unconfirmed.
   */
  dispose() {
    if (!this.disposeTask) this.disposeTask = (async () => {
      const graceful = this.state === 'ready' && !this.exited && !this.error;
      this.state = 'closing';
      clearTimeout(this.startTimer);
      this.ready?.reject(failure('v2_closed'));
      for (const id of this.pending.keys()) this.settle(id, failure('v2_closed'));
      const deadline = new AbortController();
      const timer = setTimeout(() => deadline.abort(), this.spec.shutdownTimeoutMs);
      try {
        if (graceful) {
          try { await this.rpc('app.shutdown', {}, deadline.signal, this.spec.shutdownTimeoutMs); } catch (error) { /* Shutdown still closes stdin and joins the range. */ }
          try { this.handle.stdin.end(); } catch (error) { this.terminate(); }
          try { if (!await this.handle.waitForExit(deadline.signal)) this.terminate(); } catch (error) { this.terminate(); }
        } else this.terminate();
        await this.cleanup();
        if (this.startTask) await this.startTask.catch(() => {});
      } finally { clearTimeout(timer); this.state = 'closed'; }
    })();
    return this.disposeTask;
  }
}
