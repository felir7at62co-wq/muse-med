/** Application-owned browser transport for the initiating Session's download tool call. */
import { randomUUID, createHash } from 'node:crypto'
import { createReadStream, realpathSync } from 'node:fs'
import { stat, link, writeFile, unlink } from 'node:fs/promises'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-subprocess'
import type {
  DouyinTaskId,
  DouyinDesktopRequest,
  DouyinDesktopResult,
} from '@deepseek-ai/dsh-client-ui-sidebar-browser/types'
import { mediaEvidence, nativeMediaFacts } from './douyin-media-facts.ts'

interface BrowserAcquisition {
  readonly version: 2
  /**
   * @param agent - initiating real Agent.
   * @param url - requested official page.
   * @param signal - tool lifetime.
   * @param maxDownloadBytes - validated tool deployment's per-video file bound.
   * @returns verified receipt or explicit failure.
   */
  download(agent: Agent, url: string, signal: AbortSignal, maxDownloadBytes: number): Promise<object>
}
declare module '@deepseek-ai/cordis' {
  interface Context {
    douyinBrowser: BrowserAcquisition
  }
}

/** Bounded, credential-free native-media result parser. */
function resultOf(value: unknown): DouyinDesktopResult | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const v = value as Record<string, unknown>
  if (
    v.type !== 'douyin-browser-result' ||
    typeof v.requestId !== 'string' ||
    typeof v.code !== 'string' ||
    !/^[A-Z0-9_]{1,64}$/.test(v.code)
  )
    return undefined
  if (v.targetVideoId !== undefined && (typeof v.targetVideoId !== 'string' || !/^\d{10,25}$/.test(v.targetVideoId)))
    return undefined
  if (v.path !== undefined && typeof v.path !== 'string') return undefined
  return value as DouyinDesktopResult
}

/** @param ctx - booted profile. @returns after installing the owned transport and its disposer. */
export function installDesktopDouyinBrowser(ctx: Context): void {
  const pending = new Map<
    string,
    { resolve: (value: DouyinDesktopResult) => void; timer: ReturnType<typeof setTimeout> }
  >()
  const lifetime = new AbortController()
  const downloads = new Set<Promise<object>>()
  let closing = false
  const taskLifetimes = new Map<string, AbortController>()
  const answer = (value: unknown): void => {
    if (
      typeof value === 'object' &&
      value !== null &&
      'type' in value &&
      value.type === 'douyin-browser-revoked' &&
      'taskId' in value &&
      typeof value.taskId === 'string'
    ) {
      const reason =
        'code' in value && typeof value.code === 'string' && /^[A-Z0-9_]{1,64}$/.test(value.code)
          ? value.code
          : 'CANCELLED'
      taskLifetimes.get(value.taskId)?.abort(reason)
      return
    }
    const result = resultOf(value)
    if (result === undefined) return
    const entry = pending.get(result.requestId)
    if (entry === undefined) return
    pending.delete(result.requestId)
    clearTimeout(entry.timer)
    entry.resolve(result)
  }
  process.on('message', answer)
  const send = (request: DouyinDesktopRequest): Promise<DouyinDesktopResult> =>
    new Promise((resolveResult) => {
      const finish = (code: string): void => {
        answer({ type: 'douyin-browser-result', requestId: request.requestId, code })
      }
      pending.set(request.requestId, {
        resolve: resolveResult,
        timer: setTimeout(() => {
          finish('TRANSPORT_TIMEOUT')
        }, 130_000),
      })
      if (closing || !process.connected || process.send === undefined) {
        finish('HOST_UNAVAILABLE')
        return
      }
      process.send(request, (error) => {
        if (error !== null) finish('HOST_UNAVAILABLE')
      })
    })
  const disconnect = (): void => {
    lifetime.abort()
    closing = true
    for (const id of [...pending.keys()])
      answer({ type: 'douyin-browser-result', requestId: id, code: 'HOST_UNAVAILABLE' })
  }
  process.once('disconnect', disconnect)
  ctx.effect(
    () => async () => {
      disconnect()
      await Promise.allSettled(downloads)
      process.removeListener('message', answer)
      process.removeListener('disconnect', disconnect)
    },
    'douyin: settle transport on Host shutdown',
  )
  const acquire = async (agent: Agent, url: string, callerSignal: AbortSignal, maxDownloadBytes: number): Promise<object> => {
    const taskLifetime = new AbortController()
    const signal = AbortSignal.any([callerSignal, lifetime.signal, taskLifetime.signal])
    const taskId = randomUUID() as DouyinTaskId
    const workspace = agent.session.header.cwd
    if (typeof workspace !== 'string') return { status: 'blocked', code: 'WORKSPACE_UNAVAILABLE' }
    let cwd: string
    try {
      cwd = realpathSync(workspace)
    } catch {
      return { status: 'blocked', code: 'WORKSPACE_UNAVAILABLE' }
    }
    let page: URL
    try {
      page = new URL(url)
    } catch {
      return { status: 'blocked', code: 'INVALID_URL' }
    }
    const pathId = /^\/(?:share\/)?video\/(\d{10,25})\/?$/.exec(page.pathname)?.[1]
    const modal = page.searchParams.getAll('modal_id')
    const target =
      pathId !== undefined
        ? modal.length === 0 || (modal.length === 1 && modal[0] === pathId)
        : page.hostname === 'www.douyin.com' &&
          ['/', '/discover', '/jingxuan'].includes(page.pathname) &&
          modal.length === 1 &&
          /^\d{10,25}$/.test(modal[0] ?? '')
    const official =
      url.length <= 8192 &&
      page.protocol === 'https:' &&
      !page.username &&
      !page.password &&
      (!page.port || page.port === '443') &&
      (page.hostname === 'v.douyin.com'
        ? /^\/[A-Za-z0-9_-]+\/?$/.test(page.pathname)
        : ['www.douyin.com', 'www.iesdouyin.com'].includes(page.hostname) && target)
    if (!official) return { status: 'blocked', code: 'INVALID_URL' }
    taskLifetimes.set(taskId, taskLifetime)
    const base = { type: 'douyin-browser' as const, taskId, sessionId: agent.id, cwd, url, maxDownloadBytes }
    const release = (): Promise<DouyinDesktopResult> => send({ ...base, requestId: randomUUID(), action: 'release' })
    const abort = (): void => {
      if (!taskLifetime.signal.aborted) void release()
    }
    signal.addEventListener('abort', abort, { once: true })
    try {
      signal.throwIfAborted()
      const prepared = await send({ ...base, requestId: randomUUID(), action: 'prepare' })
      signal.throwIfAborted()
      if (prepared.code !== 'PREPARED' || prepared.targetVideoId === undefined)
        return { status: 'blocked', code: prepared.code, taskId }
      const target = prepared.targetVideoId
      const staged = await send({ ...base, requestId: randomUUID(), action: 'download', targetVideoId: target })
      signal.throwIfAborted()
      if (staged.code !== 'STAGED') return { status: 'blocked', code: staged.code, taskId, targetVideoId: target }
      return await verifyNativeMedia(ctx, staged, cwd, taskId, target, maxDownloadBytes, signal)
    } catch (_error) {
      const revoked: unknown = taskLifetime.signal.reason
      return {
        status: 'blocked',
        code:
          taskLifetime.signal.aborted && typeof revoked === 'string'
            ? revoked
            : signal.aborted
              ? 'CANCELLED'
              : 'MEDIA_VERIFICATION_FAILED',
        taskId,
      }
    } finally {
      signal.removeEventListener('abort', abort)
      taskLifetimes.delete(taskId)
      await release()
    }
  }
  ctx.effect(
    () =>
      ctx.provide('douyinBrowser', {
        version: 2,
        download(agent, url, callerSignal, maxDownloadBytes) {
          const operation = acquire(agent, url, callerSignal, maxDownloadBytes)
          downloads.add(operation)
          return operation.finally(() => {
            downloads.delete(operation)
          })
        },
      }),
    'douyin: main-owned browser acquisition',
  )
}

/**
 * @param ctx - owning Host.
 * @param args - trusted verification command.
 * @param cwd - session root.
 * @param signal - lifetime.
 * @returns bounded stdout after process exit.
 */
async function mediaCommand(ctx: Context, args: string[], cwd: string, signal: AbortSignal): Promise<string> {
  const env = Object.fromEntries(
    Object.entries(process.env).filter(
      ([key, value]) =>
        value !== undefined && !/KEY|SECRET|TOKEN|PASSWORD|COOKIE|PROXY|PYTHON|NODE_OPTIONS|SSL_CERT/i.test(key),
    ),
  )
  const handle = ctx.subprocess.spawn({
    argv: args,
    cwd,
    env,
    signal,
    graceMs: 1000,
    stdio: { stdin: 'ignore', stdout: { maxBytes: 65536 }, stderr: { maxBytes: 4096 } },
  })
  const outcome = await handle.done
  await handle.waitForExit()
  signal.throwIfAborted()
  const output = handle.collected.stdout?.readFrom(0)
  if (outcome.exitCode !== 0 || outcome.signal || output?.lossy) throw new Error('Media verification failed')
  return output?.text ?? ''
}

/**
 * @param ctx - real subprocess service.
 * @param staged - native completion.
 * @param cwd - canonical root.
 * @param taskId - owned task.
 * @param target - approved video.
 * @param maxDownloadBytes - validated tool deployment's per-video file bound.
 * @param signal - lifetime.
 * @returns file-backed verified receipt.
 */
async function verifyNativeMedia(
  ctx: Context,
  staged: DouyinDesktopResult,
  cwd: string,
  taskId: string,
  target: string,
  maxDownloadBytes: number,
  signal: AbortSignal,
): Promise<object> {
  const file = join(cwd, 'source', 'media', 'douyin', `.native-${taskId}`, 'video.mp4')
  if (staged.path !== file || staged.targetVideoId !== target || realpathSync(file) !== file)
    throw new Error('Invalid media location')
  const info = await stat(file)
  if (!info.isFile() || info.size <= 0 || info.size > maxDownloadBytes) throw new Error('Invalid media size')
  const evidence = mediaEvidence(staged.evidence, target)
  const probe = await ctx.subprocess.resolveExecutable(process.env.DSH_FFPROBE_PATH ?? 'ffprobe', undefined, signal)
  const decoder = await ctx.subprocess.resolveExecutable(process.env.DSH_FFMPEG_PATH ?? 'ffmpeg', undefined, signal)
  const bounded = AbortSignal.any([signal, AbortSignal.timeout(120_000)])
  const metadata: unknown = JSON.parse(
    await mediaCommand(
      ctx,
      [
        probe,
        '-v',
        'error',
        '-protocol_whitelist',
        'file,pipe',
        '-f',
        'mov',
        '-show_entries',
        'format=duration:stream=codec_type,width,height',
        '-of',
        'json',
        file,
      ],
      cwd,
      bounded,
    ),
  )
  const { duration, width, height } = nativeMediaFacts(metadata, evidence)
  await mediaCommand(
    ctx,
    [
      decoder,
      '-v',
      'error',
      '-xerror',
      '-protocol_whitelist',
      'file,pipe',
      '-f',
      'mov',
      '-i',
      file,
      '-map',
      '0:v:0',
      '-map',
      '0:a?',
      '-f',
      'null',
      '-',
    ],
    cwd,
    bounded,
  )
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(file) as AsyncIterable<Buffer>) {
    bounded.throwIfAborted()
    hash.update(chunk)
  }
  const targetPath = join(cwd, 'source', 'media', 'douyin', `${target}-${taskId}.mp4`)
  const receipt = targetPath + '.source.json'
  const record = {
    status: 'downloaded',
    path: targetPath,
    receipt,
    source: `https://www.douyin.com/video/${target}`,
    bytes: info.size,
    sha256: hash.digest('hex'),
    duration_seconds: duration,
    width,
    height,
    full_decode_verified: true,
    authentication: 'muse-browser',
    taskId,
    targetVideoId: target,
    evidence,
    retrieved_at: new Date().toISOString(),
  }
  bounded.throwIfAborted()
  await link(file, targetPath)
  try {
    await writeFile(receipt, JSON.stringify(record, null, 2) + '\n', { flag: 'wx', mode: 0o600, signal: bounded })
    bounded.throwIfAborted()
  } catch (error) {
    await unlink(targetPath)
    try {
      await unlink(receipt)
    } catch (_error) {
      /* Exclusive task receipt may not have been created. */
    }
    throw error
  }
  return record
}
