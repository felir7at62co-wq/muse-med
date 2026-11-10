/** Read the current physical host identity without registering or changing any saved state. */
import { createHash } from 'node:crypto';
import { win32 } from 'node:path';

const messages = {
  v2_device_invalid: '红果 v2 无法核对当前电脑的物理设备身份',
  v2_cancelled: '红果 v2 设备身份核对已取消',
  v2_request_timeout: '红果 v2 设备身份核对超时',
};
class DeviceIdentityError extends Error {
  constructor(code) { super(messages[code]); this.code = code; }
}
const failure = code => new DeviceIdentityError(code);
const guid = '[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}';

/** Parse one exact OS identity field and derive its ID without exposing the original value.
 * @param {string} platform Operating system whose fixed read-only command produced the text.
 * @param {string} text Complete, bounded command stdout.
 * @returns {string} Domain-separated Mac identity or the original case-sensitive Windows identity.
 */
export function parseV2DeviceIdentity(platform, text) {
  if (typeof text !== 'string') throw failure('v2_device_invalid');
  const pattern = platform === 'darwin' ? new RegExp(`^\\s*"IOPlatformUUID"\\s*=\\s*"(${guid})"\\s*$`, 'gm')
    : platform === 'win32' ? new RegExp(`^\\s*MachineGuid\\s+REG_SZ\\s+(${guid})\\s*$`, 'gmi') : null;
  if (!pattern) throw failure('v2_device_invalid');
  const matches = [...text.matchAll(pattern)];
  if (matches.length !== 1) throw failure('v2_device_invalid');
  const value = matches[0][1];
  const input = platform === 'darwin' ? 'muse-mac-physical-v1:' + value.toLowerCase() : 'mg:' + value;
  return 'd1:' + createHash('sha256').update(input).digest('hex').slice(0, 32);
}

function command() {
  if (process.platform === 'darwin') return { argv: ['/usr/sbin/ioreg', '-rd1', '-c', 'IOPlatformExpertDevice'], cwd: '/', env: { LANG: 'C', PATH: '/usr/bin:/bin:/usr/sbin:/sbin' } };
  const root = process.env.SystemRoot;
  if (process.platform !== 'win32' || typeof root !== 'string' || !/^[a-z]:[\\/]/iu.test(root) || root.includes('\0')) throw failure('v2_device_invalid');
  return { argv: [win32.join(root, 'System32', 'reg.exe'), 'query', 'HKLM\\SOFTWARE\\Microsoft\\Cryptography', '/v', 'MachineGuid', '/reg:64'],
    cwd: root, env: { SystemRoot: root, PATH: win32.join(root, 'System32') } };
}

function captured(handle, name, maximum) {
  const output = handle.collected[name]?.readFrom(0);
  if (!output || typeof output.text !== 'string' || output.lossy || output.truncated || Buffer.byteLength(output.text) > maximum) throw failure('v2_device_invalid');
  return output.text;
}

/** Read and join one managed OS command; reject missing/truncated output without logging identifiers.
 * @param {object} subprocess Managed subprocess service with bounded collected output and joined exit.
 * @param {object} config Resolved v2RequestTimeoutMs, v2MaxLineBytes and mediaProcessGraceMs.
 * @param {AbortSignal} [signal] Optional caller cancellation.
 * @returns {Promise<string>} Current physical device ID, without writing or rotating saved state.
 */
export async function readV2DeviceIdentity(subprocess, config, signal) {
  const deadline = new AbortController();
  const active = AbortSignal.any([deadline.signal, ...(signal ? [signal] : [])]);
  const timer = setTimeout(() => deadline.abort(), config.v2RequestTimeoutMs);
  let handle, abort;
  try {
    active.throwIfAborted();
    handle = subprocess.spawn({ ...command(), stdio: { stdin: 'ignore', stdout: { maxBytes: config.v2MaxLineBytes }, stderr: { maxBytes: config.v2MaxLineBytes } },
      signal: active, graceMs: config.mediaProcessGraceMs });
    const aborted = new Promise((_resolve, reject) => {
      abort = () => reject(failure('v2_cancelled'));
      active.addEventListener('abort', abort, { once: true });
      if (active.aborted) abort();
    });
    const result = await Promise.race([handle.done, aborted]);
    if (!await handle.waitForExit(active)) throw failure('v2_device_invalid');
    active.throwIfAborted();
    if (result.exitCode !== 0 || result.signal) throw failure('v2_device_invalid');
    const stdout = captured(handle, 'stdout', config.v2MaxLineBytes);
    if (captured(handle, 'stderr', config.v2MaxLineBytes).trim()) throw failure('v2_device_invalid');
    return parseV2DeviceIdentity(process.platform, stdout);
  } catch (error) {
    if (handle) {
      handle.terminate();
      await Promise.allSettled([handle.done, handle.waitForExit()]);
    }
    if (signal?.aborted) throw failure('v2_cancelled');
    if (deadline.signal.aborted) throw failure('v2_request_timeout');
    throw failure('v2_device_invalid');
  } finally {
    clearTimeout(timer);
    if (abort) active.removeEventListener('abort', abort);
  }
}
