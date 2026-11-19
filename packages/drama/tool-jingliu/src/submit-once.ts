/** Durable records for the Jingliu job route, which does not accept an idempotency key. @module */
import { createHash } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { HarnessError } from '@deepseek-ai/dsh-error'
import type { JsonValue } from '@deepseek-ai/dsh-util-values'
import { isFields } from './catalog.ts'

function digest(values: readonly unknown[]): string {
  return createHash('sha256').update(JSON.stringify(values)).digest('hex')
}

/**
 * Look up a previously dispatched job before estimating cost or reading mutable shot state.
 * @param dir - Host-private receipt directory.
 * @param call - Session and call identifiers.
 * @param input - authenticated identity and original requested scope.
 * @returns the original receipt, or undefined when this call has never submitted.
 */
export async function existingSubmission(
  dir: string, call: readonly string[], input: readonly unknown[],
): Promise<Record<string, JsonValue> | undefined> {
  const path = join(dir, digest(call))
  let fingerprint: string
  try {
    fingerprint = await readFile(path, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return
    throw error
  }
  if (fingerprint && fingerprint !== digest(input)) {
    throw new HarnessError('同一调用已用于其他账号或参数。', 'JINGLIU_JOB_CONFLICT')
  }
  if (fingerprint) {
    try {
      const saved: unknown = JSON.parse(await readFile(path + '.json', 'utf8'))
      if (isFields(saved) && typeof saved.job_id === 'string' && saved.job_id) return saved
    } catch (error) {
      if (!(error instanceof SyntaxError) && (error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
  }
  throw new HarnessError('该调用已有提交记录。请在镜流查询此项目的任务，核对原任务后继续。', 'JINGLIU_JOB_OUTCOME_UNKNOWN')
}

/**
 * Submit a narration job once for this Session call, including after a restart.
 * @param dir - Host-private receipt directory.
 * @param call - Session and call identifiers.
 * @param input - identity and operation for this submission.
 * @param send - authenticated remote submission.
 * @returns original job ID, including on replay of an acknowledged submission.
 */
export async function submitOnce(dir: string, call: readonly string[], input: readonly unknown[],
  send: () => Promise<unknown>): Promise<Record<string, JsonValue>> {
  await mkdir(dir, { recursive: true, mode: 0o700 })
  const path = join(dir, digest(call))
  const fingerprint = digest(input)
  try {
    await writeFile(path, fingerprint, { flag: 'wx', mode: 0o600, flush: true })
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
    const saved = await existingSubmission(dir, call, input)
    if (saved) return saved
    throw new HarnessError('请核对该项目的任务，原提交记录已丢失。', 'JINGLIU_JOB_OUTCOME_UNKNOWN')
  }
  try {
    const response = await send()
    if (!isFields(response) || typeof response.id !== 'string' || !response.id) throw new Error('镜流未返回任务编号')
    const result = { job_id: response.id, job: response }
    await writeFile(path + '.json', JSON.stringify(result), { flag: 'wx', mode: 0o600, flush: true })
    return result
  } catch (error) {
    throw new HarnessError('镜流提交未取得可重放的回执，请先核对项目中的任务。', 'JINGLIU_JOB_OUTCOME_UNKNOWN', { cause: error })
  }
}
