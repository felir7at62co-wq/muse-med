/** Opt-in installed Fanqie downloads with independent UTF-8, chapter and file verification. */
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { chmod, lstat, mkdtemp, readFile, readdir, realpath, rm } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { pathToFileURL } from 'node:url'

const inside = (root, path) => {
  const name = relative(root, path)
  return name !== '' && !isAbsolute(name) && name !== '..' && !name.startsWith(`..${sep}`)
}
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex')

/** Project only finite public classifications and numeric transport facts from a failed tool result. */
function safeSourceFailure(result) {
  const types = ['HTTPError', 'URLError', 'SSLCertVerificationError', 'SSLEOFError', 'SSLError', 'gaierror',
    'ConnectionRefusedError', 'ConnectionResetError', 'TimeoutError', 'OSError', 'JSONDecodeError',
    'UnicodeDecodeError', 'KeyError', 'ValueError', 'TypeError', 'EngineError', 'Exception']
  const codes = [...types, 'redirect_refused', 'invalid_ciphertext', 'chapter_mismatch', 'authorization_required',
    'chapter_unavailable', 'chapter_size', 'incomplete_chapter', 'incomplete_catalog', 'invalid_catalog',
    'invalid_search_result', 'registration_failed', 'http_response', 'response_size', 'platform_rejected',
    'invalid_content_key', 'missing_chapter', 'book_size', 'input_size', 'invalid_network_mode',
    'missing_runtime', 'invalid_arguments', 'engine_failed', 'cancelled']
  const diagnostic = {}
  if (codes.includes(result.code)) diagnostic.code = result.code
  if (['registration', 'search', 'catalog', 'key-negotiation', 'chapter-download'].includes(result.sourceStage)) {
    diagnostic.sourceStage = result.sourceStage
  }
  if (['log.snssdk.com', 'api5-normal.fqnovel.com'].includes(result.host)) diagnostic.host = result.host
  if (['direct', 'system'].includes(result.networkMode)) diagnostic.networkMode = result.networkMode
  const error = {}
  if (types.includes(result.error?.type)) error.type = result.error.type
  if (types.includes(result.error?.reasonType)) error.reasonType = result.error.reasonType
  if (Number.isSafeInteger(result.error?.httpStatus) && result.error.httpStatus >= 100 && result.error.httpStatus <= 599) {
    error.httpStatus = result.error.httpStatus
  }
  if (Number.isSafeInteger(result.error?.errno)) error.errno = result.error.errno
  if (Object.keys(error).length > 0) diagnostic.error = error
  return Object.keys(diagnostic).length > 0 ? diagnostic : undefined
}

/**
 * Validate the explicit book identity before allocating resources or contacting Fanqie.
 * @param environment Opt-in flag, book ID, exact title and author.
 * @returns The selected identity, or null when installed live acceptance is disabled.
 */
export function fanqieLiveBook(environment) {
  const required = environment.MUSE_FANQIE_LIVE_REQUIRED
  if (required === undefined || required === '0') return null
  assert.equal(required, '1', 'Fanqie live acceptance flag must be 0 or 1')
  const bookId = environment.MUSE_FANQIE_LIVE_BOOK_ID
  const title = environment.MUSE_FANQIE_LIVE_TITLE
  const author = environment.MUSE_FANQIE_LIVE_AUTHOR
  assert.ok(typeof bookId === 'string' && /^\d{10,24}$/u.test(bookId), 'Fanqie live acceptance requires one book ID')
  assert.ok([title, author].every(value => typeof value === 'string' && value === value.trim()
    && value.length > 0 && value.length <= 256 && !/[\u0000-\u001f\u007f]/u.test(value)),
  'Fanqie live acceptance requires an exact title and author')
  return { bookId, title, author }
}

/**
 * Load only the installed client and managed subprocess provider; no workspace package fallback is allowed.
 * @param root Installed dependency root.
 * @param paths Prepared bundled Python path.
 * @returns Owned default-direct client and joined context disposal.
 */
export async function mountFanqieRuntime(root, paths) {
  const requireRuntime = createRequire(join(root, 'package.json'))
  const installed = name => {
    const path = requireRuntime.resolve(name)
    assert.ok(inside(resolve(root), resolve(path)), 'Fanqie live dependency escaped the installed payload')
    return path
  }
  const load = name => import(pathToFileURL(installed(name)).href)
  const manifest = installed('muse-fanqie-download/package.json')
  const [{ Context }, { default: SubprocessLocal }, { FanqieClient }] = await Promise.all([
    load('@deepseek-ai/cordis'), load('@deepseek-ai/dsh-subprocess-local'),
    import(pathToFileURL(join(dirname(manifest), 'src/client.js')).href),
  ])
  const context = new Context()
  let client
  try {
    await context.plugin(SubprocessLocal)
    client = new FanqieClient({ pythonExecutable: paths.python }, context.subprocess)
    assert.equal(client.config.networkMode, 'direct', 'Fanqie installed default must be direct')
    return { client, disposeContext: () => context.fiber.dispose() }
  } catch (error) {
    try { await client?.dispose() }
    finally { await context.fiber.dispose() }
    throw error
  }
}

/** Require the catalog and download to identify the explicitly selected book. */
function selectedBook(result, selected, complete) {
  assert.ok(result.ok === true && result.complete === complete && Array.isArray(result.items)
    && result.items.length === 1, 'Fanqie live result did not complete its requested operation')
  const item = result.items[0]
  assert.ok(item.bookId === selected.bookId && item.title === selected.title && item.author === selected.author,
    'Fanqie live book identity differs')
  assert.ok(Number.isSafeInteger(item.chapterCount) && item.chapterCount > 0 && Array.isArray(item.chapters)
    && item.chapters.length === item.chapterCount, 'Fanqie live chapter coverage differs')
  return item
}

/** Reject linked, special, partial or unreported files and abandoned staging directories. */
async function checkedTree(directory, expectedFile) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name)
    assert.ok(!entry.isSymbolicLink(), 'Fanqie live output contains a link')
    if (entry.isDirectory()) {
      assert.ok(!entry.name.startsWith('.fanqie-') && !entry.name.endsWith('.part'),
        'Fanqie live output contains an incomplete staging directory')
      await checkedTree(path, expectedFile)
    }
    else assert.ok(entry.isFile() && path === expectedFile && !entry.name.endsWith('.part'),
      'Fanqie live output contains an incomplete or unexpected file')
  }
}

/** Independently verify each chapter's code-point count and SHA-256 against the published UTF-8 text. */
function checkChapters(text, title, chapters) {
  const prefix = `${title}\n\n`
  assert.ok(text.startsWith(prefix), 'Fanqie live TXT title differs')
  const characters = [...text]
  let offset = [...prefix].length
  for (const chapter of chapters) {
    assert.ok(Number.isSafeInteger(chapter.characters) && chapter.characters > 0
      && typeof chapter.sha256 === 'string' && /^[a-f0-9]{64}$/u.test(chapter.sha256),
    'Fanqie live chapter receipt is incomplete')
    const body = characters.slice(offset, offset + chapter.characters).join('')
    assert.equal(sha256(body), chapter.sha256, 'Fanqie live chapter hash differs')
    offset += chapter.characters
    assert.equal(characters.slice(offset, offset + 2).join(''), '\n\n', 'Fanqie live chapter separator differs')
    offset += 2
  }
  assert.equal(offset, characters.length, 'Fanqie live TXT has unreported or missing content')
}

/**
 * Verify a complete published book using only the installed engine and bundled Python.
 * @param root Installed dependency root.
 * @param resourcesRuntime Installed external runtimes containing the selected Python.
 * @param environment Explicit opt-in identity and prepared Python path.
 * @param mount Owned runtime factory; only offline tests substitute it.
 * @returns Secret-free identity, counts and digest after joined disposal and private TXT removal.
 */
export async function checkFanqieLive(root, resourcesRuntime, environment = process.env, mount = mountFanqieRuntime) {
  const selected = fanqieLiveBook(environment)
  if (selected === null) return { required: false }
  const python = environment.MUSE_HONGGUO_PYTHON_PATH
  assert.ok(typeof python === 'string' && isAbsolute(python) && inside(resolve(resourcesRuntime), resolve(python)),
    'Fanqie live acceptance requires the bundled Python')
  const workspace = await realpath(await mkdtemp(join(tmpdir(), 'muse-fanqie-live-')))
  let runtime, receipt, sourceFailure, stage = 'mount'
  try {
    try {
      await chmod(workspace, 0o700)
      runtime = await mount(root, { python })
      assert.equal(runtime.client.config.networkMode, 'direct', 'Fanqie live requests must use the installed direct default')
      const signal = AbortSignal.timeout(1_200_000)
      stage = 'catalog'
      const metadata = await runtime.client.call('info', { bookIds: [selected.bookId] }, workspace, signal)
      if (metadata?.ok === false) sourceFailure = safeSourceFailure(metadata)
      const catalog = selectedBook(metadata, selected, false)
      const ids = catalog.chapters.map(chapter => chapter.itemId)
      assert.ok(ids.every(id => typeof id === 'string' && /^\d{10,24}$/u.test(id)) && new Set(ids).size === ids.length,
        'Fanqie live catalog has duplicate or invalid chapter IDs')
      stage = 'download'
      const result = await runtime.client.call('download', { bookIds: [selected.bookId] }, workspace, signal)
      if (result?.ok === false) sourceFailure = safeSourceFailure(result)
      const item = selectedBook(result, selected, true)
      assert.ok(item.complete === true && item.scope === 'current-published-directory'
        && item.downloadedChapters === catalog.chapterCount && item.chapterCount === catalog.chapterCount,
      'Fanqie live published chapter count differs')
      assert.deepEqual(item.chapters.map(chapter => ({ itemId: chapter.itemId, title: chapter.title })), catalog.chapters,
        'Fanqie live download chapter order or identity differs')
      stage = 'files'
      assert.ok(typeof item.file === 'string' && isAbsolute(item.file) && basename(item.file) === `${selected.bookId}.txt`,
        'Fanqie live TXT path is invalid')
      const info = await lstat(item.file)
      const file = await realpath(item.file)
      assert.ok(info.isFile() && !info.isSymbolicLink() && inside(workspace, file), 'Fanqie live TXT escaped its private workspace')
      assert.ok(info.size > 0 && info.size === item.bytes, 'Fanqie live TXT size differs')
      const bytes = await readFile(file)
      const digest = sha256(bytes)
      assert.equal(digest, item.sha256, 'Fanqie live TXT hash differs')
      const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
      assert.ok(!text.includes('\0') && !text.includes('\ufffd'), 'Fanqie live TXT contains damaged characters')
      checkChapters(text, selected.title, item.chapters)
      await checkedTree(workspace, file)
      receipt = { required: true, complete: true, networkMode: 'direct', ...selected,
        chapters: item.chapterCount, bytes: info.size, sha256: digest, utf8: true,
        independentlyHashed: true, chapterReceiptsVerified: true }
    } finally {
      stage = receipt ? 'cleanup' : stage
      try { await runtime?.client.dispose() }
      finally {
        try { await runtime?.disposeContext() }
        finally { await rm(workspace, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 }) }
      }
    }
  } catch (error) {
    // Platform text, arbitrary error messages and temporary device data never enter CI diagnostics.
    throw new Error(`Fanqie live installed acceptance failed (stage=${stage}${sourceFailure ? `; source=${JSON.stringify(sourceFailure)}` : ''})`)
  }
  return { ...receipt, cleanup: true }
}
