import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { MessageBoxOptions, MessageBoxReturnValue } from 'electron'
import { afterEach, expect, it, vi } from 'vitest'
import { UpgradeBackupNotice } from '../src/upgrade-backup-notice.ts'
import { resolveDesktopLocale } from '../src/locale.ts'

const roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))) })
const id = '{12345678-1234-1234-1234-123456789abc}'
const otherId = '{12345678-1234-1234-1234-123456789abd}'

async function setup() {
  const root = await mkdtemp(join(tmpdir(), 'muse-backup-notice-'))
  roots.push(root)
  const reports = join(root, 'reports')
  const acknowledgements = join(root, 'ack')
  await mkdir(reports)
  const show = vi.fn<(options: MessageBoxOptions) => Promise<MessageBoxReturnValue>>(async () => ({ response: 0, checkboxChecked: false }))
  const options = { reports, acknowledgements, locale: () => resolveDesktopLocale('zh'), show }
  const put = async (idValue: string, completed = false) => {
    const original = 'C:\\Muse'
    const backup = `${original}.old-${idValue}`
    const body = completed ? `Upgrade completed. Retained backup: ${backup}\r\nCurrent directory: ${original}\r\n`
      : `Prepared upgrade. Original directory: ${original}\r\nPlanned backup directory: ${backup}\r\nThe presence of this report does not mean the rename or installation completed.\r\n`
    const path = join(reports, `retained-upgrade-${idValue}.txt${completed ? '.completed' : ''}`)
    await writeFile(path, Buffer.from(body, 'utf16le'))
    return path
  }
  return { options, reports, acknowledgements, show, put }
}

it('shows separate prepared and completed revisions and retains all original reports', async () => {
  const f = await setup()
  const planned = await f.put(id)
  const original = await readFile(planned)
  await new UpgradeBackupNotice(f.options).show()
  expect(f.show).toHaveBeenCalledTimes(1)
  expect(f.show.mock.calls[0]?.[0].message).toContain('是否完成尚不确定')
  expect(f.show.mock.calls[0]?.[0].detail).toContain(`C:\\Muse.old-${id}`)
  await new UpgradeBackupNotice(f.options).show()
  expect(f.show).toHaveBeenCalledTimes(1)
  await f.put(id, true)
  await f.put(otherId)
  await new UpgradeBackupNotice(f.options).show()
  expect(f.show).toHaveBeenCalledTimes(3)
  expect(f.show.mock.calls[1]?.[0].message).toContain('不会自动迁回')
  expect(f.show.mock.calls[1]?.[0].detail).toContain(`C:\\Muse.old-${id}`)
  expect(await readFile(planned)).toEqual(original)
})

it('does not acknowledge cancellation, disposal or corrupt completion as a successful upgrade', async () => {
  const f = await setup()
  await f.put(id)
  await writeFile(join(f.reports, `retained-upgrade-${id}.txt.completed`), Buffer.from('Upgrade completed. Retained backup: C:\\bad', 'utf16le'))
  f.show.mockResolvedValueOnce({ response: -1, checkboxChecked: false })
  const notice = new UpgradeBackupNotice(f.options)
  await notice.show()
  expect(f.show.mock.calls[0]?.[0].message).toContain('状态未知')
  expect(f.show.mock.calls[0]?.[0].detail).toContain(join(f.reports, `retained-upgrade-${id}.txt.completed`))
  await notice.show()
  expect(f.show).toHaveBeenCalledTimes(2)
  await f.put(id, true)
  notice.dispose()
  await notice.show()
  expect(f.show).toHaveBeenCalledTimes(2)
  await new UpgradeBackupNotice(f.options).show()
  expect(f.show).toHaveBeenCalledTimes(3)
  expect(f.show.mock.calls[2]?.[0].message).toContain('更新已完成')
})

it('shows a damaged planned report for inspection without presenting its partial contents', async () => {
  const f = await setup()
  const path = await f.put(id)
  await writeFile(path, Buffer.from('Upgrade completed. Retained backup: bogus', 'utf16le'))
  await new UpgradeBackupNotice(f.options).show()
  expect(f.show).toHaveBeenCalledOnce()
  expect(f.show.mock.calls[0]?.[0].message).toContain('状态未知')
  expect(f.show.mock.calls[0]?.[0].detail).toContain(path)
  expect(f.show.mock.calls[0]?.[0].detail).not.toContain('bogus')
})

it('shows a blocked upgrade without requiring a planned receipt', async () => {
  const f = await setup()
  const path = join(f.reports, `retained-upgrade-${id}.txt.blocked`)
  await writeFile(path, Buffer.from('Upgrade blocked. Existing directory: C:\\Old\r\nRequested directory: C:\\New\r\n', 'utf16le'))
  await new UpgradeBackupNotice(f.options).show()
  expect(f.show).toHaveBeenCalledOnce()
  expect(f.show.mock.calls[0]?.[0].message).toContain('升级已被阻止')
  expect(f.show.mock.calls[0]?.[0].detail).toContain(path)
})

it('shows a blocked receipt with an invalid registered-path placeholder', async () => {
  const f = await setup()
  const path = join(f.reports, `retained-upgrade-${id}.txt.blocked`)
  await writeFile(path, Buffer.from('Upgrade blocked. Existing directory: <invalid-registered-path>\r\nRequested directory: C:\\New\r\n', 'utf16le'))
  await new UpgradeBackupNotice(f.options).show()
  expect(f.show.mock.calls[0]?.[0].message).toContain('升级已被阻止')
  expect(f.show.mock.calls[0]?.[0].detail).toContain('安装目录: 未知')
  expect(f.show.mock.calls[0]?.[0].detail).toContain(path)
})

it('points to an orphaned or damaged completion or blocked receipt without asserting success', async () => {
  const f = await setup()
  const completion = join(f.reports, `retained-upgrade-${id}.txt.completed`)
  const blocked = join(f.reports, `retained-upgrade-${otherId}.txt.blocked`)
  await writeFile(completion, Buffer.from('Upgrade completed. Retained backup: corrupt', 'utf16le'))
  await writeFile(blocked, Buffer.from('Upgrade blocked. Existing directory: corrupt', 'utf16le'))
  await new UpgradeBackupNotice(f.options).show()
  expect(f.show).toHaveBeenCalledTimes(2)
  expect(f.show.mock.calls[0]?.[0].message).toContain('状态未知')
  expect(f.show.mock.calls[0]?.[0].detail).toContain(completion)
  expect(f.show.mock.calls[1]?.[0].message).toContain('状态未知')
  expect(f.show.mock.calls[1]?.[0].detail).toContain(blocked)
})

it('recognizes a valid identifier without braces and rejects malformed report names', async () => {
  const f = await setup()
  await f.put('12345678-1234-1234-1234-123456789abc')
  await f.put('12345678-1234-1234-1234-123456789abz')
  await new UpgradeBackupNotice(f.options).show()
  expect(f.show).toHaveBeenCalledOnce()
  expect(f.show.mock.calls[0]?.[0].detail).toContain('12345678-1234-1234-1234-123456789abc')
})
