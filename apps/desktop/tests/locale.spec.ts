import { describe, expect, it } from 'vitest'
import { desktopUpdateReadyConfirmation, en, formatDesktopMessage, resolveDesktopLocale, resolveDesktopStartupLocale, zh } from '../src/locale.ts'

describe('desktop locale dictionaries', () => {
  it.each([['en', en], ['zh-CN', zh]] as const)('shows verified manual installation guidance in %s without claiming an automatic restart', async (language, messages) => {
    await expect(JSON.stringify({
      ready: { ...desktopUpdateReadyConfirmation(messages, '1.0.4', 'darwin', true), button: messages.updateManualOpen },
      active: { message: messages.updateActiveTasks, detail: messages.updateManualActiveTasksDetail,
        buttons: [messages.updateManualStopTasks, messages.updateLater] },
    }, null, 2) + '\n').toMatchFileSnapshot(`./expected/update-manual-macos-${language}.json`)
  })
  it.each([en, zh])('names Muse in the application, welcome, and About surfaces', (messages) => {
    expect(messages.productName).toBe('Muse')
    expect(messages.welcomeBrand).toBe('Muse')
    expect(messages.aboutProduct).toBe('Muse')
  })

  it('ships the same key set in English and Chinese', () => {
    expect(Object.keys(zh)).toEqual(Object.keys(en))
    expect(resolveDesktopLocale('zh-Hans-CN').messages).toEqual(zh)
    expect(resolveDesktopLocale('en-US').messages).toEqual(en)
    expect(resolveDesktopLocale('fr-FR').messages).toEqual(en)
  })

  it('formats named values without consuming unknown placeholders', () => {
    expect(formatDesktopMessage('{name}@{version} {missing}', { name: 'plugin', version: '1.2.3' }))
      .toBe('plugin@1.2.3 {missing}')
  })

  it.each([en, zh])('keeps the product version, harness version, and source commit in About details', (messages) => {
    const detail = formatDesktopMessage(messages.aboutVersion, { version: '1.0.0-beta.1', harnessVersion: '0.1.7-rc.8', commitHash: 'abcdef0' })
    expect(detail).toContain('1.0.0-beta.1')
    expect(detail).toContain('DSH 0.1.7-rc.8')
    expect(detail).toContain('abcdef0')
  })

  it('prefers an explicit supported choice, then the first supported system language', () => {
    expect(resolveDesktopStartupLocale('zh', ['en-US']).id).toBe('zh-CN')
    expect(resolveDesktopStartupLocale('EN', ['zh-CN']).id).toBe('en')
    expect(resolveDesktopStartupLocale(null, ['ja-JP', 'zh-Hant', 'en-US']).id).toBe('zh-CN')
    expect(resolveDesktopStartupLocale(null, ['en-US', 'zh-CN']).id).toBe('en')
    expect(resolveDesktopStartupLocale(null, ['ja-JP']).id).toBe('en')
    expect(resolveDesktopStartupLocale(null, []).id).toBe('en')
    expect(resolveDesktopStartupLocale('ja', ['zh-CN']).id).toBe('zh-CN')
  })

})
