/** Resident conversation navigation and Session-specific header content. */
import clsx from 'clsx'
import type { ConversationHeaderProps } from '../contract/slots.ts'
import { conversationPhase } from '../contract/snapshot.ts'
import css from './ConversationRoot.module.css'

/**
 * Keeps global navigation available before a Session exists.
 * @param props - Optional Session sources and authorized header slots.
 * @returns The persistent header with any selected Session's title and views.
 */
export function ConversationHeader({ sessionId, useSession, useConversation, renderSlot, useHeaderPresentation }: ConversationHeaderProps) {
  const headerPresentation = useHeaderPresentation(value => value)
  const session = useSession(s => s)
  const conversation = useConversation(s => s)
  const blank = session === undefined || conversation === undefined
    || (session.blank && conversationPhase(session, conversation) === 'blank')
  return (
    <>
      {headerPresentation === 'floating' && <div className={css.headerFade} aria-hidden="true" />}
      <header className={clsx(css.header, blank && css.headerBlank, headerPresentation === 'floating' && css.headerFloating)} data-window-drag data-conversation-header-presentation={headerPresentation}>
        <div className={css.headerLeading} data-conversation-header-leading="">
          {renderSlot('conversation.header.leading', {})}
        </div>
        {sessionId === undefined
        // The empty title row keeps the blank-Session header height, so the
        // Hero centers its input card at the same offset before a Session exists.
          ? <div className={css.titleRow} />
          : renderSlot('conversation.session.header', { hideChrome: blank, presentation: headerPresentation })}
      </header>
    </>
  )
}
