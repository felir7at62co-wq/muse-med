/** Native Session-header entry for the conversation video workspace. */
import type { PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import { Button, IconPlayOutlineRegular, Tooltip } from '@deepseek-ai/dsh-client-ui-primitives'
import type { VideoShared } from './face.ts'

/** Reveal the recorded videos without changing the conversation or draft.
 * @param props - Native Session-header locale and workspace navigation.
 * @returns The video utility beside the conversation title.
 */
export function VideoHeader({ openWorkspace, t }: PropsRuntime<'conversation.session.header.utilities'> & VideoShared) {
  return <Tooltip portal label={t('library')}><span>
    <Button size="sm" variant="ghost" data-muse-video-anchor aria-label={t('library')}
      onClick={() => { openWorkspace() }}><IconPlayOutlineRegular /></Button>
  </span></Tooltip>
}
