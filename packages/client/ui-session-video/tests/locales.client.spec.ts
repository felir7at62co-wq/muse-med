// @vitest-environment jsdom
/** The mounted plugin must register translations instead of English aliases. */
import { Context } from '@deepseek-ai/cordis'
import { LocaleRuntime } from '@deepseek-ai/dsh-client-locale/client'
import { stubConfigForm } from '@deepseek-ai/dsh-client-test-runtime'
import { expect, it, onTestFinished, vi } from 'vitest'
import { apply } from '../src/client/index.ts'
import { NS } from '../src/client/locales.ts'

// This source-only spec exercises dictionary registration, not generated Remote metadata.
vi.mock('@deepseek-ai/dsh-session-video/remote', () => ({ default: {} }))

it('loads each shipped language through the real plugin scope and withdraws it on disposal', async () => {
  const ctx = new Context()
  onTestFinished(() => ctx.fiber.dispose())
  const locale = new LocaleRuntime(ctx)
  for (const [id, label] of [['ja', '日本語'], ['es', 'Español'], ['fr', 'Français'],
    ['de', 'Deutsch'], ['ru', 'Русский'], ['pt', 'Português']] as const) {
    locale.addLanguage({ id, label, fallback: 'en' })
  }
  const form = stubConfigForm<{ enabled: boolean }>()
  form.publish({ value: { enabled: false } })
  ctx.provide('locale', locale)
  ctx.provide('remote', { $mount: async () => () => {} } as never)
  ctx.provide('remote.sessionVideo', {} as never)
  ctx.provide('configForms', { get: () => form.scope } as never)
  ctx.provide('uiConversation', {} as never)
  ctx.provide('slots', { inject: () => () => {} } as never)
  const dispose = await apply(ctx)
  const t = locale.bind(NS)
  try {
    for (const [language, play, pause] of [
      ['en', 'Play', 'Pause'], ['zh', '播放', '暂停'], ['ja', '再生', '一時停止'],
      ['es', 'Reproducir', 'Pausar'], ['fr', 'Lire', 'Mettre en pause'],
      ['de', 'Wiedergeben', 'Pausieren'], ['ru', 'Воспроизвести', 'Приостановить'],
      ['pt', 'Reproduzir', 'Pausar'],
    ] as const) {
      locale.setLocale(language)
      expect(t('play'), language).toBe(play)
      expect(t('pause'), language).toBe(pause)
    }
  } finally {
    await dispose()
  }
  expect(t('play')).toBe('play')
  expect(form.listenerCount()).toBe(0)
})
