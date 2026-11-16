/** Conversation header launcher for the Session-owned right-Sidebar video workspace. */
import type { PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import { IconChevronDownOutlineRegular } from '@deepseek-ai/dsh-client-ui-primitives'
import type { VideoShared } from './face.ts'
import css from './VideoShelf.module.css'

/** Reserve the native Chat header footprint independently of the workspace.
 * @returns Non-interactive header spacing while the optional video interface is enabled.
 */
export function VideoShelfSpacer() {
  return <div className={css.spacer} data-muse-video-spacer aria-hidden="true" />
}

/** Reveal this conversation's existing dockable workspace without changing its draft.
 * @param props - Native Chat view, locale and Session-addressed navigation callback.
 * @returns The Muse spider launcher beside Chat, or null for another conversation view.
 */
export function VideoShelf({ activeView, openWorkspace, t }: PropsRuntime<'conversation.content.overlay'> & VideoShared) {
  if (activeView !== 'chat') return null
  return <div className={css.seat} data-muse-video-launcher>
    <section className={css.bubble} aria-label={t('library')}>
      <div className={css.heading} data-muse-video-heading>
        <button type="button" className={css.anchor} data-muse-video-anchor
          aria-label={t('library')} onClick={() => { openWorkspace() }}>
          <span className={css.spider} aria-hidden="true" /><span>{t('brand')}</span><IconChevronDownOutlineRegular />
        </button>
      </div>
    </section>
  </div>
}
