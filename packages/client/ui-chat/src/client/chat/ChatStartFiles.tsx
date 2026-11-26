/** Empty conversations expose the mounted composer's existing file picker. */
import { Button, IconPaperclipOutlineRegular } from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import css from './ChatStartFiles.module.css'

/** Session-addressed file action supplied by the Chat owner. */
export interface ChatStartFilesActions {
  /** Open the current composer's file dialog or show its localized refusal. */
  readonly addFiles: () => void
}

/** Offer ordinary file intake without sending or changing the existing draft.
 * @param props - Current Session, composer phase, locale and existing picker action.
 * @returns A compact file action on the empty-conversation options row.
 */
export function ChatStartFiles({ useInput, useSession, addFiles, t }:
Pick<PropsRuntime<'conversation.hero.options'>, 'useInput' | 'useSession'> & PropsLocale<'chat'> & ChatStartFilesActions) {
  const phase = useInput(state => state.phase)
  const removed = useSession(state => state.removed)
  return <Button size="sm" variant="ghost" className={css.action} disabled={removed || phase !== 'plain'} onClick={addFiles}>
    <IconPaperclipOutlineRegular /><span>{t('chat.addFiles')}</span>
  </Button>
}
