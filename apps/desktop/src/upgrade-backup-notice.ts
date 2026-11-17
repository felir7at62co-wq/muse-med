/** Surface retained installer backups without modifying installer receipts or backup data. */
import { createHash } from 'node:crypto'
import { lstat, mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import { join, win32 } from 'node:path'
import type { MessageBoxOptions, MessageBoxReturnValue } from 'electron'
import type { DesktopLocale } from './locale.ts'

const guid = '[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}'
const receiptName = new RegExp(`^retained-upgrade-(?:\\{${guid}\\}|${guid})\\.txt$`, 'iu')
const maximumReceiptBytes = 32 * 1024

/** Read-only receipt and separate user acknowledgement locations. */
export interface UpgradeBackupNoticeOptions {
  readonly reports: string
  readonly acknowledgements: string
  readonly locale: () => DesktopLocale
  readonly show: (options: MessageBoxOptions) => Promise<MessageBoxReturnValue>
}

/** Notify about each receipt revision only after an explicit acknowledgement. */
export class UpgradeBackupNotice {
  private pending = false
  private disposed = false
  private readonly options: UpgradeBackupNoticeOptions

  /** @param options - Private receipt locations and owner-controlled dialog. */
  constructor(options: UpgradeBackupNoticeOptions) { this.options = options }

  /** Prevent a late dialog response from acknowledging a notice during shutdown. */
  dispose(): void { this.disposed = true }

  /** Display unread installer receipts after an application window becomes available. */
  async show(): Promise<void> {
    if (this.pending || this.disposed) return
    this.pending = true
    try {
      let names: string[]
      let entries: Set<string>
      try { entries = new Set(await readdir(this.options.reports))
        names = [...new Set([...entries].map(name => name.replace(/\.(completed|blocked)$/u, ''))
          .filter(name => receiptName.test(name)))].sort() }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return
        throw error
      }
      for (const name of names) {
        if (this.disposed) return
        const base = join(this.options.reports, name)
        const completed = `${base}.completed`
        const planned = this.validReceipt(name, await this.readReceipt(base), false)
        const candidate = this.validReceipt(name, await this.readReceipt(completed), true)
        const blocked = this.validBlocked(await this.readReceipt(`${base}.blocked`))
        const plannedCurrent = planned?.split('\r\n')[0]?.slice('Prepared upgrade. Original directory: '.length)
        const completedCurrent = candidate?.split('\r\n')[1]?.slice('Current directory: '.length)
        const done = plannedCurrent !== undefined && completedCurrent?.toLowerCase() === plannedCurrent.toLowerCase()
          ? candidate : undefined
        const blockedPresent = entries.has(`${name}.blocked`)
        const completedPresent = entries.has(`${name}.completed`)
        const raw = blockedPresent ? blocked : completedPresent ? done : planned
        // An unreadable receipt is not a completed upgrade. Include the report path for inspection.
        const reportPath = blockedPresent ? `${base}.blocked` : completedPresent ? completed : base
        const messages = this.options.locale().messages
        const details = [`${messages.backupNoticeReport}: ${reportPath}`]
        let message = messages.backupNoticeUnknown
        if (raw !== undefined) {
          const lines = raw.split('\r\n')
          if (lines[0] === undefined || lines[1] === undefined) continue
          if (blockedPresent) {
            message = messages.backupNoticeBlocked
            const old = lines[0].slice('Upgrade blocked. Existing directory: '.length)
            details.push(`${messages.backupNoticeCurrent}: ${old === '<invalid-registered-path>' ? messages.backupNoticePathUnknown : old}`)
            details.push(`${messages.backupNoticeRequested}: ${lines[1].slice('Requested directory: '.length)}`)
          } else if (completedPresent) {
            message = messages.backupNoticeCompleted
            details.push(`${messages.backupNoticeCurrent}: ${lines[1].slice('Current directory: '.length)}`)
            details.push(`${messages.backupNoticeBackup}: ${lines[0].slice('Upgrade completed. Retained backup: '.length)}`)
          } else {
            message = messages.backupNoticePrepared
            details.push(`${messages.backupNoticeCurrent}: ${lines[0].slice('Prepared upgrade. Original directory: '.length)}`)
            details.push(`${messages.backupNoticeBackup}: ${lines[1].slice('Planned backup directory: '.length)}`)
          }
        }
        const identity = createHash('sha256').update(name).update('\0').update(blockedPresent ? 'blocked' : completedPresent ? 'completed' : 'prepared').update('\0').update(raw ?? 'unreadable').digest('hex')
        const marker = join(this.options.acknowledgements, identity)
        try { await lstat(marker); continue } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
        }
        const result = await this.options.show({ type: 'info', title: messages.backupNoticeTitle,
          message, detail: details.join('\n'), buttons: [messages.updateAcknowledge], defaultId: 0, cancelId: -1 })
        if (this.disposed || result.response !== 0) return
        await mkdir(this.options.acknowledgements, { recursive: true })
        try { await writeFile(marker, '', { flag: 'wx' }) } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
        }
      }
    } catch (error) { console.warn('desktop upgrade backup notice: could not read or display receipts', error) }
    finally { this.pending = false }
  }

  private async readReceipt(path: string): Promise<string | undefined> {
    try {
      const info = await lstat(path)
      if (!info.isFile() || info.size > maximumReceiptBytes || info.size % 2 !== 0) return undefined
      const data = await readFile(path)
      if (data.length !== info.size || data.length > maximumReceiptBytes) return undefined
      return data.toString('utf16le')
    } catch { return undefined }
  }

  private validReceipt(name: string, raw: string | undefined, completed: boolean): string | undefined {
    if (raw === undefined) return undefined
    const lines = raw.split('\r\n')
    const first = completed ? 'Upgrade completed. Retained backup: ' : 'Prepared upgrade. Original directory: '
    const second = completed ? 'Current directory: ' : 'Planned backup directory: '
    if (!lines[0]?.startsWith(first) || !lines[1]?.startsWith(second)) return undefined
    if (completed ? lines.length !== 3 || lines[2] !== ''
      : lines.length !== 4 || lines[2] !== 'The presence of this report does not mean the rename or installation completed.' || lines[3] !== '') return undefined
    const one = lines[0].slice(first.length)
    const two = lines[1].slice(second.length)
    const current = completed ? two : one
    const backup = completed ? one : two
    const id = name.slice('retained-upgrade-'.length, -'.txt'.length)
    if (!win32.isAbsolute(current) || /[\u0000-\u001f\u007f]/u.test(current)
      || backup.toLowerCase() !== `${current}.old-${id}`.toLowerCase()) return undefined
    return raw
  }

  private validBlocked(raw: string | undefined): string | undefined {
    if (raw === undefined) return undefined
    const lines = raw.split('\r\n')
    const first = 'Upgrade blocked. Existing directory: '
    const second = 'Requested directory: '
    if (lines.length !== 3 || lines[2] !== '' || !lines[0]?.startsWith(first) || !lines[1]?.startsWith(second)) return undefined
    const old = lines[0].slice(first.length)
    const requested = lines[1].slice(second.length)
    if ((old !== '<invalid-registered-path>' && !win32.isAbsolute(old)) || !win32.isAbsolute(requested)
      || /[\u0000-\u001f\u007f]/u.test(old + requested)) return undefined
    return raw
  }
}
