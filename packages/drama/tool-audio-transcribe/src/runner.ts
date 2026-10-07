/** Local media staging, task receipts, and versioned transcript publication. */
import { createHash, randomUUID } from 'node:crypto'
import { spawn } from 'node:child_process'
import { createReadStream } from 'node:fs'
import { chmod, link, mkdir, open, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises'
import { basename, dirname, join, resolve } from 'node:path'
import { MuseAsrError, type MuseAsrJob, type MuseAsrPurpose, type MuseAccountStatus } from '@deepseek-ai/dsh-muse-account'

/** Host-only account service methods consumed by the model tool. */
export interface AudioAccount {
  status(request: { verify?: boolean }): Promise<MuseAccountStatus>
  submitAudio(file: string, id: string, sha256: string, language: 'zh' | 'auto', purpose?: MuseAsrPurpose): Promise<MuseAsrJob>
  audioStatus(id: string): Promise<MuseAsrJob>
}

/** Process and file limits controlled by the product row. */
export interface AudioRunnerConfig {
  readonly ffmpegPath: string
  readonly ffprobePath: string
  readonly commandTimeoutMs: number
  readonly maxDurationSeconds: number
  readonly maxAudioBytes: number
  readonly chunkSeconds?: number
}

/** Injectable media operations for deterministic tests of receipt and publication behavior. */
export interface AudioMediaOperations {
  probe(source: string): Promise<number>
  encode(source: string, target: string, range?: { offset: number; duration: number }): Promise<void>
}

/** Agent-visible receipt path and local output state. */
export interface AudioRunResult {
  readonly status: MuseAsrJob['status']
  readonly receipt: string
  readonly job_id: string
  readonly purpose?: MuseAsrPurpose
  readonly error_code?: MuseAsrError['code']
  readonly retry_after_seconds?: number
  readonly resume_status?: { readonly method: 'status'; readonly project: string; readonly receipt: string }
  readonly output_txt?: string
  readonly output_json?: string
  readonly output_srt?: string
}

interface AudioPart {
  readonly id: string
  readonly mp3: string
  readonly sha256: string
  readonly offset: number
  readonly retentionExpired?: boolean
  readonly duration: number
  readonly purpose?: MuseAsrPurpose
}

interface Receipt {
  readonly id: string
  readonly source: string
  readonly sourceSha256?: string
  readonly parts?: readonly AudioPart[]
  readonly accountUsername: string
  readonly stem: string
  readonly version: number
  readonly language: 'zh' | 'auto'
  readonly purpose?: MuseAsrPurpose
  readonly sha256: string
  readonly mp3: string
  readonly status: MuseAsrJob['status'] | 'prepared'
}

async function command(executable: string, args: readonly string[], timeoutMs: number): Promise<string> {
  return await new Promise((resolveCommand, reject) => {
    const child = spawn(executable, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
    let output = ''
    let stderrBytes = 0
    let exceededOutput = false
    let timedOut = false
    const timer = setTimeout(() => { timedOut = true; child.kill() }, timeoutMs)
    child.stdout.on('data', (chunk: Buffer) => {
      output += chunk.toString()
      if (output.length > 65_536) { exceededOutput = true; child.kill() }
    })
    child.stderr.on('data', (chunk: Buffer) => {
      stderrBytes += chunk.length
      if (stderrBytes > 65_536) { exceededOutput = true; child.kill() }
    })
    child.once('error', () => { clearTimeout(timer); reject(new Error('Bundled FFmpeg or FFprobe is unavailable')) })
    child.once('close', (code) => {
      clearTimeout(timer)
      if (code === 0 && !exceededOutput && !timedOut) resolveCommand(output)
      else reject(new Error('Media extraction or probe failed'))
    })
  })
}

async function digest(file: string): Promise<string> {
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(file) as AsyncIterable<Uint8Array>) hash.update(chunk)
  return hash.digest('hex')
}

function timestamp(seconds: number): string {
  const ms = Math.round(seconds * 1000)
  const hours = Math.floor(ms / 3_600_000).toString().padStart(2, '0')
  const minutes = Math.floor(ms % 3_600_000 / 60_000).toString().padStart(2, '0')
  const remainder = Math.floor(ms % 60_000 / 1000).toString().padStart(2, '0')
  return `${hours}:${minutes}:${remainder}.${(ms % 1000).toString().padStart(3, '0')}`
}

async function save(file: string, receipt: Receipt): Promise<void> {
  const staged = `${file}.${randomUUID()}.tmp`
  try { await writeFile(staged, `${JSON.stringify(receipt, null, 2)}\n`, { flag: 'wx', mode: 0o600 }); await rename(staged, file) }
  finally { await rm(staged, { force: true }) }
}

async function readReceipt(file: string): Promise<Receipt> {
  const value: unknown = JSON.parse(await readFile(file, 'utf8'))
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error('Invalid transcription receipt')
  const row = value as Record<string, unknown>
  if (typeof row.id !== 'string' || !/^[0-9a-f-]{36}$/i.test(row.id)
    || typeof row.source !== 'string' || typeof row.accountUsername !== 'string' || !row.accountUsername
    || typeof row.stem !== 'string' || !/^[\w.-]+$/.test(row.stem)
    || typeof row.version !== 'number' || !Number.isSafeInteger(row.version) || row.version < 1
    || !['zh', 'auto'].includes(String(row.language)) || typeof row.sha256 !== 'string' || !/^[0-9a-f]{64}$/i.test(row.sha256)
    || typeof row.mp3 !== 'string' || !['prepared', 'preparing', 'processing', 'submitting', 'uncertain', 'complete', 'silent', 'failed'].includes(String(row.status))) throw new Error('Invalid transcription receipt')
  if (row.sourceSha256 !== undefined && (typeof row.sourceSha256 !== 'string' || !/^[0-9a-f]{64}$/i.test(row.sourceSha256))) throw new Error('Invalid source digest')
  if (row.purpose !== undefined && row.purpose !== 'subtitles' && row.purpose !== 'screenplay') throw new Error('Invalid transcription purpose')
  if (row.parts !== undefined && (!Array.isArray(row.parts) || row.parts.length === 0 || row.parts.some((part: unknown) => {
    if (typeof part !== 'object' || part === null) return true
    const item = part as Record<string, unknown>
    return typeof item.id !== 'string' || !/^[0-9a-f-]{36}$/i.test(item.id)
      || typeof item.mp3 !== 'string' || typeof item.sha256 !== 'string' || !/^[0-9a-f]{64}$/i.test(item.sha256)
      || typeof item.offset !== 'number' || !Number.isFinite(item.offset) || item.offset < 0
      || typeof item.duration !== 'number' || !Number.isFinite(item.duration) || item.duration <= 0
  }))) throw new Error('Invalid transcription parts')
  if (Array.isArray(row.parts) && row.parts.some((part: Record<string, unknown>) => part.purpose !== row.purpose)) throw new Error('Transcription part purpose does not match its receipt')
  return { id: row.id, source: row.source, ...(row.sourceSha256 === undefined ? {} : { sourceSha256: row.sourceSha256 }),
    ...(row.parts === undefined ? {} : { parts: row.parts as AudioPart[] }),
    accountUsername: row.accountUsername, stem: row.stem, version: row.version,
    language: row.language as 'zh' | 'auto', ...purposeField(row.purpose), sha256: row.sha256, mp3: row.mp3,
    status: row.status as Receipt['status'] }
}

function purposeField(purpose: MuseAsrPurpose | undefined): { purpose?: MuseAsrPurpose } {
  return purpose === undefined ? {} : { purpose }
}

function assertJobPurpose(job: MuseAsrJob, purpose: MuseAsrPurpose | undefined): void {
  if (job.purpose !== undefined && job.purpose !== purpose) throw new Error('Cloud transcription purpose does not match its receipt')
}

function resolvePurpose(purpose: MuseAsrPurpose | undefined): MuseAsrPurpose {
  return purpose ?? 'subtitles'
}

function rejectedResult(project: string, file: string, receipt: Receipt, error: MuseAsrError): AudioRunResult {
  const resumable = error.code === 'queue_full' || error.code === 'upload_busy' || error.code === 'request_rate'
    || error.code === 'provider_rate'
    || error.code === 'server-unavailable' || error.code === 'response-invalid'
  return {
    status: error.code === 'server-unavailable' || error.code === 'response-invalid' ? 'uncertain'
      : receipt.status === 'prepared' ? 'preparing' : receipt.status,
    receipt: file, job_id: receipt.id, ...purposeField(receipt.purpose), error_code: error.code,
    ...(error.retryAfterSeconds === undefined ? {} : { retry_after_seconds: error.retryAfterSeconds }),
    ...(resumable ? { resume_status: { method: 'status', project, receipt: file } as const } : {}),
  }
}

function portableResult(result: AudioRunResult): AudioRunResult {
  const path = (value: string): string => value.replaceAll('\\', '/')
  return { ...result, receipt: path(result.receipt),
    ...(result.output_txt === undefined ? {} : { output_txt: path(result.output_txt) }),
    ...(result.output_json === undefined ? {} : { output_json: path(result.output_json) }),
    ...(result.output_srt === undefined ? {} : { output_srt: path(result.output_srt) }),
    ...(result.resume_status === undefined ? {} : { resume_status: {
      ...result.resume_status, project: path(result.resume_status.project), receipt: path(result.resume_status.receipt),
    } }),
  }
}

function paths(project: string, receipt: Receipt): { txt: string; json: string; srt: string } {
  const stem = `${receipt.stem}-v${receipt.version}`
  return { txt: join(project, 'transcript', 'raw', stem + '.txt'), json: join(project, 'transcript', 'raw', stem + '.json'), srt: join(project, 'transcript', 'raw', stem + '.srt') }
}

async function publish(project: string, receipt: Receipt, segments: NonNullable<MuseAsrJob['segments']>): Promise<{ txt: string; json: string; srt: string }> {
  const target = paths(project, receipt)
  await mkdir(dirname(target.txt), { recursive: true, mode: 0o700 })
  if (process.platform !== 'win32') await chmod(dirname(target.txt), 0o700)
  const text = segments.map(row => `[${timestamp(row.start)} --> ${timestamp(row.end)}] ${row.text}\n`).join('')
  const srt = segments.map((row, index) => `${index + 1}\n${timestamp(row.start).replace('.', ',')} --> ${timestamp(row.end).replace('.', ',')}\n${row.text}\n`).join('\n')
  for (const [file, content] of [[target.txt, text], [target.json, JSON.stringify(segments, null, 2) + '\n'], [target.srt, srt]] as const) {
    const temporary = `${file}.${randomUUID()}.tmp`
    try {
      await writeFile(temporary, content, { flag: 'wx', mode: 0o600 })
      try { await link(temporary, file) }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST' || await readFile(file, 'utf8') !== content) throw error
      }
    } finally { await rm(temporary, { force: true }) }
  }
  return target
}

/**
 * Create a local receipt before any account-scoped billable submit.
 * @param projectPath - Authorized project root.
 * @param inputPath - Local media to read without changing it.
 * @param language - Provider recognition language.
 * @param account - Current Host account operations.
 * @param config - Local media limits and executable paths.
 * @param media - Optional deterministic media adapter for tests.
 * @param purpose - Transcription use, resolved to subtitles for a new task when omitted.
 * @returns Durable job receipt and current gateway status.
 */
export async function startAudioTranscription(projectPath: string, inputPath: string, language: 'zh' | 'auto', account: AudioAccount, config: AudioRunnerConfig, media?: AudioMediaOperations, purpose?: MuseAsrPurpose): Promise<AudioRunResult> {
  return portableResult(await startReceipt(projectPath, inputPath, language, account, config, media, purpose))
}

async function startReceipt(projectPath: string, inputPath: string, language: 'zh' | 'auto', account: AudioAccount, config: AudioRunnerConfig, media?: AudioMediaOperations, purpose?: MuseAsrPurpose): Promise<AudioRunResult> {
  const resolvedPurpose = resolvePurpose(purpose)
  const project = resolve(projectPath), source = resolve(inputPath)
  const identity = await account.status({})
  if (identity.state !== 'signed-in') throw new Error('Sign in to Muse Account before cloud transcription')
  if (!(await stat(source)).isFile()) throw new Error('Transcription input is not a file')
  const transcript = join(project, 'transcript'), jobs = join(transcript, 'jobs')
  await mkdir(jobs, { recursive: true, mode: 0o700 })
  if (process.platform !== 'win32') {
    await chmod(transcript, 0o700)
    await chmod(jobs, 0o700)
  }
  for (const name of await readdir(jobs)) {
    if (!name.endsWith('.json')) continue
    const file = join(jobs, name)
    const prior = await readReceipt(file)
    if (prior.source === source && !['complete', 'silent', 'failed'].includes(prior.status)) {
      if (prior.accountUsername !== identity.username) throw new Error('Existing transcription receipt belongs to another Muse account')
      if ((prior.purpose ?? 'subtitles') !== resolvedPurpose) throw new Error(`Existing transcription receipt has a different purpose; query status with receipt ${file}`)
      return { status: prior.status === 'prepared' ? 'uncertain' : prior.status, receipt: file, job_id: prior.id, ...purposeField(prior.purpose) }
    }
  }
  const stem = basename(source).replace(/\.[^.]+$/, '').replace(/[^\w.-]+/g, '_').slice(0, 80) || 'media'
  const duration = media ? await media.probe(source)
    : Number((await command(config.ffprobePath, ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=noprint_wrappers=1:nokey=1', source], config.commandTimeoutMs)).trim())
  if (!Number.isFinite(duration) || duration <= 0 || duration > config.maxDurationSeconds) throw new Error('Media duration exceeds the cloud transcription limit')
  let version = 1
  while (true) {
    const prefix = `${stem}-v${version}`
    const existing = await Promise.all([join(jobs, prefix + '.json'), join(project, 'transcript', 'raw', prefix + '.txt'), join(project, 'transcript', 'raw', prefix + '.json')].map(async path => stat(path).then(() => true, () => false)))
    if (!existing.some(Boolean)) break
    version += 1
  }
  const sourceSha256 = await digest(source)
  const chunkSeconds = config.chunkSeconds ?? 600
  if (!Number.isSafeInteger(chunkSeconds) || chunkSeconds < 1 || chunkSeconds > 7200) throw new Error('Invalid cloud audio chunk duration')
  if (duration > chunkSeconds) {
    return await startParts(project, source, sourceSha256, duration, chunkSeconds,
      stem, version, language, resolvedPurpose, identity.username, account, config, media)
  }
  const id = randomUUID(), mp3 = join(jobs, `.${id}.wav`), receiptPath = join(jobs, `${stem}-v${version}.json`)
  try {
    const staged = await open(mp3, 'wx', 0o600)
    await staged.close()
    if (media) await media.encode(source, mp3)
    else await command(config.ffmpegPath, ['-nostdin', '-y', '-hide_banner', '-loglevel', 'error', '-i', source, '-vn', '-ac', '1', '-ar', '16000', '-c:a', 'pcm_s16le', '-f', 'wav', mp3], config.commandTimeoutMs)
    if (process.platform !== 'win32') await chmod(mp3, 0o600)
    const size = (await stat(mp3)).size
    if (!size || size > config.maxAudioBytes) throw new Error('Compressed audio exceeds the cloud transcription size limit')
    if (await digest(source) !== sourceSha256) throw new Error('Media changed during audio extraction')
    const receipt: Receipt = { id, source, sourceSha256, accountUsername: identity.username, stem, version, language, purpose: resolvedPurpose, sha256: await digest(mp3), mp3, status: 'prepared' }
    await writeFile(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`, { flag: 'wx', mode: 0o600 })
    const job = await account.submitAudio(mp3, id, receipt.sha256, language, receipt.purpose)
    if (job.id !== id) throw new Error('Cloud transcription returned a different task ID')
    assertJobPurpose(job, receipt.purpose)
    await save(receiptPath, { ...receipt, status: job.status })
    return { status: job.status, receipt: receiptPath, job_id: id, ...purposeField(receipt.purpose) }
  } catch (error) {
    const persisted = await stat(receiptPath).then(() => true, () => false)
    if (!persisted) await rm(mp3, { force: true })
    else if (error instanceof MuseAsrError) return rejectedResult(project, receiptPath, await readReceipt(receiptPath), error)
    throw error
  }
}

/**
 * Query an existing receipt and publish nonempty TXT/JSON only after complete recognition.
 * @param projectPath - Project containing the receipt and output directory.
 * @param receiptPath - Receipt previously returned by start.
 * @param account - Current Host account operations.
 * @returns Current status and completed output paths when available.
 */
export async function finishAudioTranscription(projectPath: string, receiptPath: string, account: AudioAccount): Promise<AudioRunResult> {
  try { return portableResult(await finishReceipt(projectPath, receiptPath, account)) }
  catch (error) {
    if (!(error instanceof MuseAsrError) || error.code === 'job-not-found') throw error
    const file = resolve(receiptPath)
    return portableResult(rejectedResult(resolve(projectPath), file, await readReceipt(file), error))
  }
}

async function finishReceipt(projectPath: string, receiptPath: string, account: AudioAccount): Promise<AudioRunResult> {
  const project = resolve(projectPath), receiptFile = resolve(receiptPath), jobs = join(project, 'transcript', 'jobs')
  if (dirname(receiptFile) !== jobs || !/^[\w.-]+-v\d+\.json$/.test(basename(receiptFile))) throw new Error('Receipt must be inside this project transcript/jobs directory')
  const receipt = await readReceipt(receiptFile)
  const identity = await account.status({})
  if (identity.state !== 'signed-in' || identity.username !== receipt.accountUsername) throw new Error('Sign in to the Muse account that created this transcription receipt')
  if (![join(jobs, `.${receipt.id}.mp3`), join(jobs, `.${receipt.id}.wav`)].includes(receipt.mp3)
    || basename(receiptFile) !== `${receipt.stem}-v${receipt.version}.json`) throw new Error('Receipt paths do not match this project')
  if (receipt.parts !== undefined) return await finishParts(project, receiptFile, receipt, receipt.parts, account)
  const target = paths(project, receipt)
  if (receipt.status === 'complete' && await stat(target.txt).then(() => true, () => false)
    && await stat(target.json).then(() => true, () => false)) return { status: 'complete', receipt: receiptFile, job_id: receipt.id, ...purposeField(receipt.purpose), output_txt: target.txt, output_json: target.json, ...(await stat(target.srt).then(() => true, () => false) ? { output_srt: target.srt } : {}) }
  let job: MuseAsrJob
  let submitted = false
  try { job = await account.audioStatus(receipt.id) }
  catch (error) {
    if (!(error instanceof MuseAsrError) || error.code !== 'job-not-found'
      || !['prepared', 'uncertain'].includes(receipt.status)
      || !(await stat(receipt.mp3).then(() => true, () => false))) throw error
    job = await account.submitAudio(receipt.mp3, receipt.id, receipt.sha256, receipt.language, receipt.purpose)
    submitted = true
  }
  if (job.id !== receipt.id) throw new Error('Cloud transcription returned a different task ID')
  assertJobPurpose(job, receipt.purpose)
  if (!submitted && ['preparing', 'failed'].includes(job.status)
    && await stat(receipt.mp3).then(() => true, () => false)) {
    job = await account.submitAudio(receipt.mp3, receipt.id, receipt.sha256, receipt.language, receipt.purpose)
  }
  if (job.id !== receipt.id) throw new Error('Cloud transcription returned a different task ID')
  assertJobPurpose(job, receipt.purpose)
  if (job.status === 'complete') {
    if (!job.segments?.length) throw new Error('Cloud transcription has no timed speech segments')
    await publish(project, receipt, job.segments)
    await save(receiptFile, { ...receipt, status: 'complete' })
    await rm(receipt.mp3, { force: true })
    return { status: 'complete', receipt: receiptFile, job_id: receipt.id, ...purposeField(receipt.purpose), output_txt: target.txt, output_json: target.json, ...(await stat(target.srt).then(() => true, () => false) ? { output_srt: target.srt } : {}) }
  }
  await save(receiptFile, { ...receipt, status: job.status })
  if (job.status === 'silent' || job.status === 'failed' || job.retentionExpired) await rm(receipt.mp3, { force: true })
  return { status: job.status, receipt: receiptFile, job_id: receipt.id, ...purposeField(receipt.purpose) }
}


async function startParts(project: string, source: string, sourceSha256: string, duration: number, chunkSeconds: number,
  stem: string, version: number, language: 'zh' | 'auto', purpose: MuseAsrPurpose, username: string, account: AudioAccount,
  config: AudioRunnerConfig, media?: AudioMediaOperations): Promise<AudioRunResult> {
  const id = randomUUID(), jobs = join(project, 'transcript', 'jobs'), receiptFile = join(jobs, `${stem}-v${version}.json`)
  const parts: AudioPart[] = []
  const staged: string[] = []
  let persisted = false
  try {
    for (let offset = 0; offset < duration; offset += chunkSeconds) {
      const partId = randomUUID(), mp3 = join(jobs, `.${partId}.wav`), seconds = Math.min(chunkSeconds, duration - offset)
      const handle = await open(mp3, 'wx', 0o600); await handle.close(); staged.push(mp3)
      if (media) await media.encode(source, mp3, { offset, duration: seconds })
      else await command(config.ffmpegPath, ['-nostdin', '-y', '-hide_banner', '-loglevel', 'error', '-ss', String(offset),
        '-i', source, '-t', String(seconds), '-vn', '-ac', '1', '-ar', '16000', '-c:a', 'pcm_s16le', '-f', 'wav', mp3], config.commandTimeoutMs)
      const size = (await stat(mp3)).size
      if (!size || size > config.maxAudioBytes) throw new Error('Compressed audio part exceeds cloud limit')
      parts.push({ id: partId, mp3, sha256: await digest(mp3), offset, duration: seconds, purpose })
    }
    if (await digest(source) !== sourceSha256) throw new Error('Media changed during audio extraction')
    const receipt: Receipt = { id, source, sourceSha256, stem, version, language, purpose, accountUsername: username,
      mp3: join(jobs, `.${id}.wav`), sha256: sourceSha256, parts, status: 'prepared' }
    await writeFile(receiptFile, JSON.stringify(receipt, null, 2) + '\n', { flag: 'wx', mode: 0o600 })
    persisted = true
    for (const part of parts) {
      const job = await account.submitAudio(part.mp3, part.id, part.sha256, language, part.purpose)
      if (job.id !== part.id) throw new Error('Cloud transcription returned a different part ID')
      assertJobPurpose(job, part.purpose)
    }
    await save(receiptFile, { ...receipt, status: 'processing' })
    return { status: 'processing', receipt: receiptFile, job_id: id, purpose }
  } catch (error) {
    if (persisted && error instanceof MuseAsrError) return rejectedResult(project, receiptFile, await readReceipt(receiptFile), error)
    throw error
  } finally {
    if (!persisted) await Promise.all(staged.map(file => rm(file, { force: true })))
  }
}

async function finishParts(
  project: string, receiptFile: string, receipt: Receipt, parts: readonly AudioPart[], account: AudioAccount,
): Promise<AudioRunResult> {
  const target = paths(project, receipt)
  if (receipt.status === 'complete' && await stat(target.json).then(() => true, () => false)
    && await stat(target.txt).then(() => true, () => false) && await stat(target.srt).then(() => true, () => false)) {
    return { status: 'complete', receipt: receiptFile, job_id: receipt.id, ...purposeField(receipt.purpose), output_txt: target.txt, output_json: target.json, output_srt: target.srt }
  }
  let offset = 0
  const ids = new Set<string>()
  for (const part of parts) {
    if (![join(project, 'transcript', 'jobs', `.${part.id}.mp3`), join(project, 'transcript', 'jobs', `.${part.id}.wav`)].includes(part.mp3) || part.offset !== offset || ids.has(part.id)) throw new Error('Invalid transcription part sequence')
    ids.add(part.id); offset += part.duration
  }
  const results: { job: MuseAsrJob; part: AudioPart }[] = []
  for (const part of parts) {
    let job: MuseAsrJob
    let submitted = false
    try { job = await account.audioStatus(part.id) }
    catch (error) {
      if (!(error instanceof MuseAsrError) || error.code !== 'job-not-found' || part.retentionExpired) throw error
      if (await digest(part.mp3) !== part.sha256) throw new Error('Staged audio part changed')
      job = await account.submitAudio(part.mp3, part.id, part.sha256, receipt.language, part.purpose)
      submitted = true
    }
    if (job.id !== part.id) throw new Error('Cloud transcription returned a different part ID')
    assertJobPurpose(job, part.purpose)
    if (!submitted && job.status === 'preparing' && !part.retentionExpired) {
      if (await digest(part.mp3) !== part.sha256) throw new Error('Staged audio part changed')
      job = await account.submitAudio(part.mp3, part.id, part.sha256, receipt.language, part.purpose)
    }
    if (job.id !== part.id) throw new Error('Cloud transcription returned a different part ID')
    assertJobPurpose(job, part.purpose)
    results.push({ job, part })
  }
  const unresolved = results.some(({ job }) => ['uncertain', 'submitting'].includes(job.status))
  const pending = results.some(({ job }) => ['processing', 'preparing'].includes(job.status))
  const status = unresolved ? 'uncertain' : pending ? 'processing' : results.some(({ job }) => job.status === 'failed') ? 'failed'
    : results.every(({ job }) => job.status === 'silent') ? 'silent' : 'complete'
  if (status === 'complete') {
    const segments = results.flatMap(({ job, part }) => {
      return (job.segments ?? []).map((row) => {
        if (row.end > part.duration + 0.25) throw new Error('Recognition timestamp exceeds its audio part')
        return { ...row, start: row.start + part.offset, end: row.end + part.offset,
          ...(row.speaker_id === undefined ? {} : { speaker_id: `${part.id}:${row.speaker_id}` }),
          ...(row.words === undefined ? {} : { words: row.words.map(word => ({
            ...word, start: word.start + part.offset, end: word.end + part.offset,
          })) }) }
      })
    })
    await publish(project, receipt, segments)
  }
  const updatedParts = parts.map((part, index) => results[index]?.job.retentionExpired ? { ...part, retentionExpired: true } : part)
  await save(receiptFile, { ...receipt, status, parts: updatedParts })
  await Promise.all(updatedParts.filter(part => part.retentionExpired).map(part => rm(part.mp3, { force: true })))
  if (['complete', 'silent', 'failed'].includes(status)) await Promise.all(parts.map(part => rm(part.mp3, { force: true })))
  return { status, receipt: receiptFile, job_id: receipt.id, ...purposeField(receipt.purpose), ...(status === 'complete' ? { output_txt: target.txt, output_json: target.json, output_srt: target.srt } : {}) }
}
