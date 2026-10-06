/** Exercise packaged original Hongguo modules locally with joined managed process cleanup. */
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { dirname, isAbsolute, join } from 'node:path'
import { pathToFileURL } from 'node:url'

const pythonCheck = `
import importlib.util, json, sys
from pathlib import Path
try:
    bridge, app, ffmpeg = sys.argv[1:]
    spec = importlib.util.spec_from_file_location("muse_packaged_decrypt", bridge)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    if not module.runtime_supported():
        raise ValueError()
    if importlib.util.MAGIC_NUMBER != module.CPYTHON_311_MAGIC:
        raise ValueError()
    if not Path(ffmpeg).is_file():
        raise ValueError()
    with module.suppress_original_output():
        from Crypto.Cipher import AES
        key, plain = bytes(16), bytes(range(16))
        encrypted = AES.new(key, AES.MODE_ECB).encrypt(plain)
        aes = AES.new(key, AES.MODE_ECB).decrypt(encrypted) == plain
        with module.original_modules(Path(app) / "frida", ffmpeg) as decoder:
            offline = callable(decoder)
    if not aes or not offline:
        raise ValueError()
    print(json.dumps({"python": ".".join(map(str, sys.version_info[:3])), "offline": True, "aes": True}))
except BaseException:
    print(json.dumps({"ok": False}))
    sys.exit(1)
`

/** Mount the package's existing client and local subprocess provider without any platform HTTP request. */
async function mountPackagedRuntime(root, paths) {
  const requireRuntime = createRequire(join(root, 'package.json'))
  const load = name => import(pathToFileURL(requireRuntime.resolve(name)).href)
  const [{ Context }, { default: SubprocessLocal }, { HongguoDownloadClient }] = await Promise.all([
    load('@deepseek-ai/cordis'), load('@deepseek-ai/dsh-subprocess-local'), load('muse-hongguo-download'),
  ])
  const context = new Context()
  try {
    await context.plugin(SubprocessLocal)
    const client = new HongguoDownloadClient({
      legacyAppDir: paths.app, javaExecutable: paths.java, pythonExecutable: paths.python,
      bootstrapDevices: true, signerStartupTimeoutMs: 120_000, deviceBootstrapTimeoutMs: 30_000,
    }, { subprocess: context.subprocess,
      request: async () => { throw new Error('Native payload fixture forbids platform requests') } })
    const bridge = join(dirname(requireRuntime.resolve('muse-hongguo-download/package.json')), 'python', 'decrypt.py')
      .replace(/([/\\])app\.asar(?=[/\\])/u, '$1app.asar.unpacked')
    return { client, subprocess: context.subprocess, bridge, disposeContext: () => context.fiber.dispose() }
  } catch (error) {
    await context.fiber.dispose()
    throw error
  }
}

/** Collect a bounded native probe and join its entire managed range even when collection fails. */
async function nativeProbe(subprocess, paths, argv, signal) {
  const handle = subprocess.spawn({ argv, cwd: paths.app, signal, graceMs: 1_000,
    env: { HOME: paths.app, USERPROFILE: paths.app, JAVA_TOOL_OPTIONS: undefined,
      JDK_JAVA_OPTIONS: undefined, _JAVA_OPTIONS: undefined, CLASSPATH: undefined },
    stdio: { stdin: 'ignore', stdout: { maxBytes: 64 * 1024 }, stderr: { maxBytes: 64 * 1024 } } })
  try {
    const outcome = await handle.done
    const stdout = handle.collected.stdout.readFrom(0)
    const stderr = handle.collected.stderr.readFrom(0)
    assert.ok(outcome.exitCode === 0 && outcome.signal === null && !stdout.lossy && !stderr.lossy,
      'Hongguo native probe did not complete')
    return { stdout: stdout.text, stderr: stderr.text }
  } finally {
    handle.terminate()
    await Promise.allSettled([handle.done])
    assert.equal(await handle.waitForExit(), true, 'Hongguo native probe range did not exit')
  }
}

/** Validate the real local signer response without returning or printing its header values. */
async function checkSignature(client, signal) {
  const endpoint = await client.signer.ensure(signal)
  const response = await client.source.sign(endpoint.url, {
    url: 'https://api5-normal-sinfonlinec.fqnovel.com/novel/player/multi_video_detail/v1/?aid=8662&version_code=72932&app_name=novelread&device_platform=android&os=android&channel=googleplay',
    headers: { 'content-type': 'application/json; charset=utf-8', 'user-agent': 'HongguoDownloader/SourceRebuild' },
  }, endpoint.token, signal)
  try {
    let size = 0
    const chunks = []
    assert.equal(response.statusCode, 200, 'Hongguo local signer rejected the fixture')
    for await (const chunk of response) {
      signal.throwIfAborted()
      size += chunk.length
      assert.ok(size <= 128 * 1024, 'Hongguo local signer response exceeded its limit')
      chunks.push(chunk)
    }
    const signed = JSON.parse(Buffer.concat(chunks).toString('utf8'))
    assert.ok(signed && typeof signed === 'object' && !Array.isArray(signed) && !signed.error,
      'Hongguo local signer returned invalid fields')
    const headers = Object.fromEntries(Object.entries(signed).map(([name, value]) => [name.toLowerCase(), value]))
    assert.ok(['x-argus', 'x-gorgon', 'x-khronos'].every(name =>
      (typeof headers[name] === 'string' || typeof headers[name] === 'number') && String(headers[name]).length > 0),
    'Hongguo original signer did not return required headers')
  } finally {
    response.destroy()
  }
}

/**
 * Run native bootstrap, original signing, offline-module loading and AES using only temporary local identity data.
 * @param root Packaged dsh root supplying built runtime dependencies.
 * @param resourcesRuntime Physical external runtime directory.
 * @param environment Prepared source and executable paths for the private smoke home.
 * @param mount Runtime mounting callback; the default uses the packaged Cordis client and subprocess provider.
 * @returns Boolean acceptance results and native versions after managed processes and context disposal complete.
 */
export async function checkHongguoRuntime(root, resourcesRuntime, environment = process.env, mount = mountPackagedRuntime) {
  const paths = { app: environment.MUSE_HONGGUO_LEGACY_APP_DIR, java: environment.MUSE_HONGGUO_JAVA_PATH,
    python: environment.MUSE_HONGGUO_PYTHON_PATH,
    ffmpeg: join(resourcesRuntime, 'media', 'ffmpeg', 'bin', process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg') }
  assert.ok(environment.MUSE_HONGGUO_BOOTSTRAP_DEVICES === '1'
    && [paths.app, paths.java, paths.python].every(value => typeof value === 'string' && isAbsolute(value)),
  'Hongguo native smoke requires prepared local runtime paths')
  const lifetime = new AbortController()
  const timer = setTimeout(() => lifetime.abort(new Error('Hongguo native payload deadline exceeded')), 180_000)
  let runtime
  try {
    runtime = await mount(root, paths)
    await runtime.client.source.load(lifetime.signal)
    await checkSignature(runtime.client, lifetime.signal)
    const java = await nativeProbe(runtime.subprocess, paths, [paths.java, '-version'], lifetime.signal)
    const javaVersion = /(?:openjdk|java) version "(17\.[\d.]+)[^"\r\n]*"/u.exec(java.stderr)?.[1]
    assert.ok(javaVersion, 'Hongguo signer requires native Java 17')
    const python = await nativeProbe(runtime.subprocess, paths,
      [paths.python, '-I', '-B', '-c', pythonCheck, runtime.bridge, paths.app, paths.ffmpeg], lifetime.signal)
    assert.equal(python.stderr, '', 'Hongguo Python probe emitted diagnostics')
    const result = JSON.parse(python.stdout)
    assert.ok(result.offline === true && result.aes === true && /^3\.11\.\d+$/u.test(result.python),
      'Hongguo packaged Python or original offline modules are unavailable')
    return { java: javaVersion, python: result.python, bootstrap: true, signer: true, offline: true, aes: true, cleanup: true }
  } catch (error) {
    // Original modules and local signatures never become fixture diagnostics.
    throw new Error('Hongguo native payload check failed')
  } finally {
    clearTimeout(timer)
    lifetime.abort()
    if (runtime) {
      try {
        try { await runtime.client.dispose() }
        finally { await runtime.disposeContext() }
      } catch (error) {
        throw new Error('Hongguo native payload cleanup failed')
      }
    }
  }
}
