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
  ctx.provide('inputTriggers', { registerSource: () => () => {} } as never)
  ctx.provide('sidebarRight', {} as never)
  ctx.provide('slots', { inject: () => () => {} } as never)
  const dispose = await apply(ctx)
  const t = locale.bind(NS)
  try {
    for (const [language, play, pause, title, review] of [
      ['en', 'Play', 'Pause', 'Muse video workspace', 'Review selected videos'],
      ['zh', '播放', '暂停', 'Muse 视频工作区', '让 Muse 看看'],
      ['ja', '再生', '一時停止', 'Muse 動画ワークスペース', '選択した動画を確認してもらう'],
      ['es', 'Reproducir', 'Pausar', 'Espacio de vídeo de Muse', 'Revisar vídeos seleccionados'],
      ['fr', 'Lire', 'Mettre en pause', 'Espace vidéo Muse', 'Analyser les vidéos sélectionnées'],
      ['de', 'Wiedergeben', 'Pausieren', 'Muse-Videobereich', 'Ausgewählte Videos prüfen'],
      ['ru', 'Воспроизвести', 'Приостановить', 'Рабочая область видео Muse', 'Проверить выбранные видео'],
      ['pt', 'Reproduzir', 'Pausar', 'Área de vídeo do Muse', 'Analisar vídeos selecionados'],
    ] as const) {
      locale.setLocale(language)
      expect(t('play'), language).toBe(play)
      expect(t('pause'), language).toBe(pause)
      expect(t('settingTitle'), language).toBe(title)
      expect(t('reviewSelected'), language).toBe(review)
    }
  } finally {
    await dispose()
  }
  expect(t('play')).toBe('play')
  expect(form.listenerCount()).toBe(0)
})
