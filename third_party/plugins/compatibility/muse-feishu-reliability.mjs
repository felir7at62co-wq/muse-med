/** Durable inbound claims for a single active Muse Feishu connection. */
import { randomUUID } from 'node:crypto'
import { closeSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

/**
 * Open bounded, durable message claims without replaying interrupted work.
 * @param {string} file Private app-scoped claim file owned by this connection.
 * @param {{retentionMs: number, maxEntries: number, now?: () => number}} options Validated replay window, capacity and clock.
 * @returns {{has(messageId: string): boolean, claim(messageId: string): boolean}} A synchronous claim committed before dispatch; repeats return false.
 */
export function createInboundClaims(file, { retentionMs, maxEntries, now = Date.now }) {
  if (!Number.isSafeInteger(retentionMs) || retentionMs <= 0 || !Number.isSafeInteger(maxEntries) || maxEntries <= 0) {
    throw new Error('Feishu message claim limits must be positive integers')
  }
  let entries = new Map()
  try {
    const info = lstatSync(file)
    if (!info.isFile() || info.isSymbolicLink()) throw new Error('Feishu message claims must be a regular file')
    const parsed = JSON.parse(readFileSync(file, 'utf8'))
    if (parsed?.version !== 1 || !Array.isArray(parsed.entries) || parsed.entries.length > maxEntries
      || parsed.entries.some(row => !Array.isArray(row) || row.length !== 2 || typeof row[0] !== 'string'
        || row[0].length === 0 || !Number.isSafeInteger(row[1]) || row[1] < 0)) {
      throw new Error('Feishu message claims are invalid')
    }
    entries = new Map(parsed.entries)
    if (entries.size !== parsed.entries.length) throw new Error('Feishu message claims contain duplicate IDs')
  } catch (error) {
    if (error.code !== 'ENOENT') throw error
  }
  return {
    has(messageId) {
      if (typeof messageId !== 'string' || !messageId) throw new Error('Feishu message ID is required')
      const time = now()
      if (!Number.isSafeInteger(time) || time < 0) throw new Error('Feishu message claim clock is invalid')
      const timestamp = entries.get(messageId)
      return timestamp !== undefined && time - timestamp < retentionMs
    },
    claim(messageId) {
      if (typeof messageId !== 'string' || !messageId) throw new Error('Feishu message ID is required')
      const time = now()
      if (!Number.isSafeInteger(time) || time < 0) throw new Error('Feishu message claim clock is invalid')
      const active = new Map([...entries].filter(([, timestamp]) => time - timestamp < retentionMs))
      if (active.has(messageId)) return false
      if (active.size >= maxEntries) throw new Error('Feishu message claim capacity reached; no request was dispatched')
      active.set(messageId, time)
      mkdirSync(dirname(file), { recursive: true, mode: 0o700 })
      const temporary = `${file}.${randomUUID()}.tmp`
      let descriptor
      let published = false
      try {
        descriptor = openSync(temporary, 'wx', 0o600)
        writeFileSync(descriptor, JSON.stringify({ version: 1, entries: [...active] }) + '\n')
        fsyncSync(descriptor)
        closeSync(descriptor)
        descriptor = undefined
        renameSync(temporary, file)
        published = true
      } finally {
        if (descriptor !== undefined) closeSync(descriptor)
        if (!published) {
          try { unlinkSync(temporary) } catch (error) {
            if (error.code !== 'ENOENT') throw error
          }
        }
      }
      entries = active
      return true
    },
  }
}
