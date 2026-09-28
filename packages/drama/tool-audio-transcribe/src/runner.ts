/** Local media staging, task receipts, and versioned transcript publication. */
import { createHash, randomUUID } from 'node:crypto'
import { spawn } from 'node:child_process'
import { createReadStream } from 'node:fs'
import { chmod, mkdir, open, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises'
import { basename, dirname, join, resolve } from 'node:path'
import { MuseAsrError, type MuseAsrJob, type MuseAccountStatus } from '@deepseek-ai/dsh-muse-account'

/** Host-only account service methods consumed by the model tool. */
export interface AudioAccount {
  status(request: { verify?: boolean }): Promise<MuseAccountStatus>
  submitAudio(file: string, id: string, sha256: string, language: 'zh' | 'auto'): Promise<MuseAsrJob>
  audioStatus(id: string): Promise<MuseAsrJob>
}

/** Process and file limits controlled by the product row. */
export interface AudioRunnerConfig {
  readonly ffmpegPath: string
  readonly ffprobePath: string
  readonly commandTimeoutMs: number
  readonly maxDurationSeconds: number
  readonly maxAudioBytes: number
}

/** Injectable media operations for deterministic tests of receipt and publication behavior. */
export interface AudioMediaOperations {
  probe(source: string): Promise<number>
  encode(source: string, target: string): Promise<void>
}

/** Agent-visible receipt path and local output state. */
export interface AudioRunResult {
  readonly status: MuseAsrJob['status']
  readonly receipt: string
  readonly job_id: string
  readonly output_txt?: string
  readonly output_json?: string
}

interface Receipt {
  readonly id: string
  readonly source: string
  readonly accountUsername: string
  readonly stem: string
  readonly version: number
  readonly language: 'zh' | 'auto'
  readonly sha256: string
  readonly mp3: string
  readonly status: MuseAsrJob['status'] | 'prepared'
}

async function command(executable: string, args: readonly string[], timeoutMs: number): Promise<string> {
  return await new Promise((resolveCommand, reject) => {
    const child = spawn(executable, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
    let output = ''
    const timer = setTimeout(() => child.kill(), timeoutMs)
    child.stdout.on('data', (chunk: Buffer) => { output += chunk.toString(); if (output.length > 65_536) child.kill() })
    child.stderr.on('data', (chunk: Buffer) => { if (chunk.length > 65_536) child.kill() })
    child.once('error', () => { clearTimeout(timer); reject(new Error('Bundled FFmpeg or FFprobe is unavailable')) })
    child.once('close', (code) => {
      clearTimeout(timer)
      if (code === 0) resolveCommand(output)
      else reject(new Error('Media extraction or probe failed'))
    })
  })
}

async function digest(file: string): Promise<string> {
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(file)) {
    if (!Buffer.isBuffer(chunk)) throw new Error('Media stream returned a non-binary chunk')
    hash.update(chunk)
  }
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
  return { id: row.id, source: row.source, accountUsername: row.accountUsername, stem: row.stem, version: row.version,
    language: row.language as 'zh' | 'auto', sha256: row.sha256, mp3: row.mp3,
    status: row.status as Receipt['status'] }
}

function paths(project: string, receipt: Receipt): { txt: string; json: string } {
  const stem = `${receipt.stem}-v${receipt.version}`
  return { txt: join(project, 'transcript', 'raw', stem + '.txt'), json: join(project, 'transcript', 'raw', stem + '.json') }
}

async function publish(project: string, receipt: Receipt, segments: NonNullable<MuseAsrJob['segments']>): Promise<{ txt: string; json: string }> {
  const target = paths(project, receipt)
  await mkdir(dirname(target.txt), { recursive: true, mode: 0o700 })
  if (process.platform !== 'win32') await chmod(dirname(target.txt), 0o700)
  const text = segments.map(row => `[${timestamp(row.start)} --> ${timestamp(row.end)}] ${row.text}\n`).join('')
  await writeFile(target.txt, text, { flag: 'wx', mode: 0o600 })
  try { await writeFile(target.json, JSON.stringify(segments, null, 2) + '\n', { flag: 'wx', mode: 0o600 }) }
  catch (error) { await rm(target.txt, { force: true }); throw error }
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
 * @returns Durable job receipt and current gateway status.
 */
export async function startAudioTranscription(projectPath: string, inputPath: string, language: 'zh' | 'auto', account: AudioAccount, config: AudioRunnerConfig, media?: AudioMediaOperations): Promise<AudioRunResult> {
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
      return { status: prior.status === 'prepared' ? 'uncertain' : prior.status, receipt: file, job_id: prior.id }
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
  const id = randomUUID(), mp3 = join(jobs, `.${id}.mp3`), receiptPath = join(jobs, `${stem}-v${version}.json`)
  try {
    const staged = await open(mp3, 'wx', 0o600)
    await staged.close()
    if (media) await media.encode(source, mp3)
    else await command(config.ffmpegPath, ['-nostdin', '-y', '-hide_banner', '-loglevel', 'error', '-i', source, '-vn', '-ac', '1', '-ar', '16000', '-b:a', '64k', '-f', 'mp3', mp3], config.commandTimeoutMs)
    if (process.platform !== 'win32') await chmod(mp3, 0o600)
    const size = (await stat(mp3)).size
    if (!size || size > config.maxAudioBytes) throw new Error('Compressed audio exceeds the cloud transcription size limit')
    const receipt: Receipt = { id, source, accountUsername: identity.username, stem, version, language, sha256: await digest(mp3), mp3, status: 'prepared' }
    await writeFile(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`, { flag: 'wx', mode: 0o600 })
    const job = await account.submitAudio(mp3, id, receipt.sha256, language)
    if (job.id !== id) throw new Error('Cloud transcription returned a different task ID')
    await save(receiptPath, { ...receipt, status: job.status })
    return { status: job.status, receipt: receiptPath, job_id: id }
  } catch (error) {
    if (!(await stat(receiptPath).then(() => true, () => false))) await rm(mp3, { force: true })
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
  const project = resolve(projectPath), receiptFile = resolve(receiptPath), jobs = join(project, 'transcript', 'jobs')
  if (dirname(receiptFile) !== jobs || !/^[\w.-]+-v\d+\.json$/.test(basename(receiptFile))) throw new Error('Receipt must be inside this project transcript/jobs directory')
  const receipt = await readReceipt(receiptFile)
  const identity = await account.status({})
  if (identity.state !== 'signed-in' || identity.username !== receipt.accountUsername) throw new Error('Sign in to the Muse account that created this transcription receipt')
  if (receipt.mp3 !== join(jobs, `.${receipt.id}.mp3`)
    || basename(receiptFile) !== `${receipt.stem}-v${receipt.version}.json`) throw new Error('Receipt paths do not match this project')
  const target = paths(project, receipt)
  if (receipt.status === 'complete' && await stat(target.txt).then(() => true, () => false)
    && await stat(target.json).then(() => true, () => false)) return { status: 'complete', receipt: receiptFile, job_id: receipt.id, output_txt: target.txt, output_json: target.json }
  let job: MuseAsrJob
  try { job = await account.audioStatus(receipt.id) }
  catch (error) {
    if (!(error instanceof MuseAsrError) || error.code !== 'job-not-found'
      || !['prepared', 'uncertain'].includes(receipt.status)
      || !(await stat(receipt.mp3).then(() => true, () => false))) throw error
    job = await account.submitAudio(receipt.mp3, receipt.id, receipt.sha256, receipt.language)
  }
  if (['preparing', 'failed'].includes(job.status)
    && await stat(receipt.mp3).then(() => true, () => false)) {
    job = await account.submitAudio(receipt.mp3, receipt.id, receipt.sha256, receipt.language)
  }
  if (job.id !== receipt.id) throw new Error('Cloud transcription returned a different task ID')
  if (job.status === 'complete') {
    if (!job.segments?.length) throw new Error('Cloud transcription has no timed speech segments')
    await publish(project, receipt, job.segments)
    await save(receiptFile, { ...receipt, status: 'complete' })
    await rm(receipt.mp3, { force: true })
    return { status: 'complete', receipt: receiptFile, job_id: receipt.id, output_txt: target.txt, output_json: target.json }
  }
  await save(receiptFile, { ...receipt, status: job.status })
  if (job.status === 'silent' || job.status === 'failed' || job.retentionExpired) await rm(receipt.mp3, { force: true })
  return { status: job.status, receipt: receiptFile, job_id: receipt.id }
}
