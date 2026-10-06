/** Lazy ownership of the original authenticated, loopback-only Java signing service. */
import { randomBytes, randomInt } from 'node:crypto';
import { chmod, copyFile, lstat, mkdir, mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { DownloadError } from './errors.js';

const captureFiles = ['libmetasec_ml.so', 'ms_16777218.bin'];
const failure = (code = 'missing_original_signer') => new DownloadError(code,
  code === 'signer_start_timeout' ? '原签名器启动超过时限；本次启动的进程和临时文件已清理'
    : code === 'cancelled' ? '原签名器启动已取消；本次启动的进程和临时文件已清理'
      : code === 'signer_stopped' ? '本机原签名器已停止；请重启 Muse 后重试'
        : '缺少可用的本机原签名运行环境；请检查 Java 17 和原源码签名素材');
const outputBytes = 64 * 1024;

function waitFor(work, signal) {
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const abort = () => reject(signal.reason);
    signal.addEventListener('abort', abort, { once: true });
    work.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
  });
}

/** Calls share one lazy startup; disposal waits for the managed process range and private directory cleanup. */
export class LocalSigner {
  constructor(subprocess, config, dependencies = {}) {
    this.subprocess = subprocess;
    this.config = config;
    this.port = dependencies.port ?? (() => randomInt(49152, 65536));
    this.lifetime = new AbortController();
    this.state = null;
    this.waiters = new Set();
  }

  /**
   * Resolve a private signing endpoint without writing its token into process.env or persisted configuration.
   * @param {AbortSignal} signal Cancellation of the calling catalog request.
   * @returns {Promise<object>} Loopback endpoint and private per-instance authentication token.
   */
  async ensure(signal) {
    signal.throwIfAborted();
    if (this.lifetime.signal.aborted) throw failure('cancelled');
    if (this.state?.ready) {
      if (this.state.exited) throw failure('signer_stopped');
      return this.state.ready;
    }
    if (!this.state) {
      const state = { controller: new AbortController(), directory: null, handle: null, cleanup: null, ready: null, exited: false };
      this.state = state;
      state.work = this.start(state);
    }
    const state = this.state, waiter = {};
    this.waiters.add(waiter);
    try { return await waitFor(state.work, signal); }
    catch (error) {
      if (signal.aborted) throw failure('cancelled');
      throw error;
    } finally {
      this.waiters.delete(waiter);
      if (!state.ready && !this.waiters.size) {
        state.controller.abort();
        await Promise.allSettled([state.work]);
      }
    }
  }

  async cleanup(state) {
    if (!state.cleanup) state.cleanup = (async () => {
      if (state.handle) {
        state.handle.terminate();
        await Promise.allSettled([state.handle.done, state.handle.waitForExit()]);
      }
      if (state.directory) await rm(state.directory, { recursive: true, force: true });
    })();
    await state.cleanup;
  }

  async start(state) {
    const deadline = new AbortController();
    const timer = setTimeout(() => deadline.abort(), this.config.signerStartupTimeoutMs);
    const active = AbortSignal.any([this.lifetime.signal, state.controller.signal, deadline.signal]);
    try {
      active.throwIfAborted();
      if (!this.subprocess || !this.config.javaExecutable || !this.config.legacyAppDir) throw failure();
      const java = await this.subprocess.resolveExecutable(this.config.javaExecutable, undefined, active);
      const app = await realpath(this.config.legacyAppDir);
      state.directory = await mkdtemp(join(tmpdir(), 'muse-hongguo-sign-'));
      state.directory = await realpath(state.directory);
      await chmod(state.directory, 0o700);
      const signing = join(state.directory, 'sign'), capture = join(state.directory, 'capture', 'fq_oversea');
      await mkdir(signing, { mode: 0o700 });
      await mkdir(capture, { recursive: true, mode: 0o700 });
      for (const [source, target] of [
        [join(app, 'sign', 'unidbg-sign.jar'), join(signing, 'unidbg-sign.jar')],
        ...captureFiles.map(name => [join(app, 'capture', 'fq_oversea', name), join(capture, name)]),
      ]) {
        active.throwIfAborted();
        const info = await lstat(source);
        if (!info.isFile() || info.isSymbolicLink()) throw failure();
        await copyFile(source, target);
        await chmod(target, 0o600);
      }
      const token = randomBytes(32).toString('hex');
      for (let attempt = 0; attempt < this.config.signerPortAttempts; attempt++) {
        active.throwIfAborted();
        const port = this.port();
        const handle = this.subprocess.spawn({
          argv: [java, `-Xmx${this.config.signerHeapMb}m`, '-XX:+ExitOnOutOfMemoryError',
            `-Duser.home=${state.directory}`, '--add-opens', 'java.base/java.lang=ALL-UNNAMED',
            '-cp', 'unidbg-sign.jar', 'com.hongguo.sign.FqTrace', 'serve', String(port)],
          cwd: signing, env: { BIND_HOST: '127.0.0.1', HG_SIGN_TOKEN: token,
            JAVA_TOOL_OPTIONS: undefined, JDK_JAVA_OPTIONS: undefined, _JAVA_OPTIONS: undefined, CLASSPATH: undefined },
          stdio: { stdin: 'ignore', stdout: { maxBytes: outputBytes }, stderr: { maxBytes: outputBytes } },
          graceMs: this.config.mediaProcessGraceMs, signal: active,
        });
        state.handle = handle;
        const ended = handle.done.then(() => { state.exited = true; }, () => { state.exited = true; });
        let ready = false;
        while (!state.exited) {
          active.throwIfAborted();
          const output = handle.collected.stdout?.readFrom(0);
          if (!output || output.lossy) throw failure();
          const line = `unidbg 离线签名服务已启动: 127.0.0.1:${port}/sign (auth on,`;
          if (output.text.includes(line) && /番茄海外 init 完成 base=0x[\da-f]+/i.test(output.text)) { ready = true; break; }
          await Promise.race([delay(this.config.signerPollIntervalMs, undefined, { signal: active }), ended]);
        }
        active.throwIfAborted();
        if (ready && !state.exited) {
          state.ready = { url: `http://127.0.0.1:${port}/sign`, token };
          void ended.then(() => this.cleanup(state)).catch(error => {
            // The shared cleanup promise preserves its failure for dispose().
          });
          return state.ready;
        }
        handle.terminate();
        await handle.waitForExit();
        const errorOutput = handle.collected.stderr?.readFrom(0);
        if (!errorOutput || errorOutput.lossy || !/java\.net\.BindException: Address already in use/.test(errorOutput.text)) throw failure();
        state.handle = null;
        state.exited = false;
      }
      throw failure();
    } catch (error) {
      await this.cleanup(state);
      if (this.state === state) this.state = null;
      if (deadline.signal.aborted) throw failure('signer_start_timeout');
      if (active.aborted) throw failure('cancelled');
      if (error instanceof DownloadError) throw error;
      throw failure();
    } finally { clearTimeout(timer); }
  }

  /** Abort startup or a ready signer and wait until all owned work and files are gone. */
  async dispose() {
    this.lifetime.abort();
    const state = this.state;
    if (!state) return;
    await Promise.allSettled([state.work]);
    await this.cleanup(state);
  }
}
