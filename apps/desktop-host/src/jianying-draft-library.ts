/** Read the explicit Windows JianyingPro draft root without changing editor settings. */
import { open } from 'node:fs/promises'
import { join, win32 } from 'node:path'

const MAX_SETTINGS_BYTES = 256 * 1024

function configuredRoot(settings: string): string | undefined {
  const general = /(?:^|\r?\n)\[General\][\t ]*\r?\n([^]*?)(?=\r?\n\[|$)/u.exec(settings)?.[1]
  const values = [...(general ?? '').matchAll(/^currentCustomDraftPath=(.*)$/gmu)]
  if (values.length !== 1) return undefined
  const value = values[0]?.[1]?.trim() ?? ''
  const unescaped = value.replaceAll('\\\\', '\\')
  const candidate = value.startsWith('\\\\') && !unescaped.startsWith('\\\\') ? `\\${unescaped}` : unescaped
  if (!/^(?:[a-z]:[\\/]|[\\/]{2}[^\\/]+[\\/][^\\/]+)/iu.test(candidate)
    || /[\x00-\x1f"]/u.test(candidate)) return undefined
  return win32.normalize(candidate)
}

/**
 * Compare a requested root with the saved editor setting on Windows.
 * @param requestedRoot - Explicit target supplied for draft generation.
 * @param localAppData - Windows per-user application data directory.
 * @returns Both roots when the editor is configured to browse a different location, or undefined otherwise.
 */
export async function jianyingDraftLibraryMismatch(requestedRoot: string,
  localAppData = process.env.LOCALAPPDATA): Promise<{ active_root: string; saved_root: string } | undefined> {
  if (!localAppData || !win32.isAbsolute(localAppData)) return undefined
  const file = join(localAppData, 'JianyingPro', 'User Data', 'Config', 'globalSetting')
  let active: string | undefined
  try {
    const handle = await open(file, 'r')
    try {
      if (!(await handle.stat()).isFile()) return undefined
      const contents = Buffer.alloc(MAX_SETTINGS_BYTES + 1)
      const { bytesRead } = await handle.read({ buffer: contents })
      if (bytesRead > MAX_SETTINGS_BYTES) return undefined
      active = configuredRoot(contents.toString('utf8', 0, bytesRead).replace(/^\uFEFF/u, ''))
    } finally { await handle.close() }
  } catch { return undefined }
  const canonical = (path: string) => win32.normalize(path).replace(/\\+$/u, '').toLowerCase()
  if (active === undefined || canonical(active) === canonical(requestedRoot)) return undefined
  return { active_root: active, saved_root: requestedRoot }
}
