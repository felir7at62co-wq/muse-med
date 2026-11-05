import { SHIPPED_LOCALE_IDS } from '../../../scripts/shipped-locales.ts'
import { describe, expect, it } from 'vitest'
import { desktopUpdateReadyConfirmation, en, formatDesktopMessage, resolveDesktopLocale, resolveDesktopStartupLocale, ja, es, fr, de, ru, pt, zh } from '../src/locale.ts'

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
    expect(Object.keys(ja)).toEqual(Object.keys(en))
    expect(resolveDesktopLocale('JA-jp')).toEqual({ id: 'ja', messages: ja })
    expect(resolveDesktopLocale('zh-Hans-CN').messages).toEqual(zh)
    expect(resolveDesktopLocale('en-US').messages).toEqual(en)
    expect(resolveDesktopLocale('it-IT').messages).toEqual(en)
  })

  it.each([
    ['es', 'es-MX', es], ['fr', 'fr-CA', fr], ['de', 'de-DE', de],
    ['ru', 'ru-RU', ru], ['pt', 'pt-BR', pt],
  ] as const)('resolves %s, preserves placeholders, and honors saved preferences', (id, tag, messages) => {
    expect(resolveDesktopLocale(tag.toUpperCase())).toEqual({ id, messages })
    expect(resolveDesktopStartupLocale(id, ['zh-CN']).id).toBe(id)
    expect(resolveDesktopStartupLocale(null, ['it-IT', tag, 'en-US']).id).toBe(id)
    expect(Object.keys(messages)).toEqual(Object.keys(en))
    for (const key of Object.keys(en) as (keyof typeof en)[]) {
      const placeholders = (text: string): string[] => (text.match(/\{\w+\}/gu) ?? []).sort()
      expect(placeholders(messages[key]), key).toEqual(placeholders(en[key]))
    }
  })

  it.each(SHIPPED_LOCALE_IDS)('resolves every shipped language %s without fallback', (id) => {
    expect(resolveDesktopLocale(id).id).toBe(id === 'zh' ? 'zh-CN' : id)
    expect(resolveDesktopStartupLocale(null, [id]).id).toBe(id === 'zh' ? 'zh-CN' : id)
  })

  it('formats named values without consuming unknown placeholders', () => {
    expect(formatDesktopMessage('{name}@{version} {missing}', { name: 'plugin', version: '1.2.3' }))
      .toBe('plugin@1.2.3 {missing}')
  })

  it.each([en, zh])('shows the product version and source commit without harness details in About', (messages) => {
    const detail = formatDesktopMessage(messages.aboutVersion, { version: '1.0.0-beta.1', harnessVersion: '0.1.7-rc.8', commitHash: 'abcdef0' })
    expect(detail).toContain('1.0.0-beta.1')
    expect(detail).toContain('abcdef0')
    expect(detail).not.toContain('DSH')
    expect(detail).not.toContain('0.1.7-rc.8')
    expect(messages.aboutVersion).not.toContain('{harnessVersion}')
  })

  it('prefers an explicit supported choice, then the first supported system language', () => {
    expect(resolveDesktopStartupLocale('zh', ['en-US']).id).toBe('zh-CN')
    expect(resolveDesktopStartupLocale('EN', ['zh-CN']).id).toBe('en')
    expect(resolveDesktopStartupLocale(null, ['ja-JP', 'zh-Hant', 'en-US']).id).toBe('ja')
    expect(resolveDesktopStartupLocale(null, ['en-US', 'zh-CN']).id).toBe('en')
    expect(resolveDesktopStartupLocale(null, ['ja-JP']).id).toBe('ja')
    expect(resolveDesktopStartupLocale(null, []).id).toBe('en')
    expect(resolveDesktopStartupLocale('ja', ['zh-CN']).id).toBe('ja')
  })

})
