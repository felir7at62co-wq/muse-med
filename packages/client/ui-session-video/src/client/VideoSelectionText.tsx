/** Recorded selection evidence renders as native inline references in messages and queues. */
import type { UserTextNodeProps } from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { InjectFace, PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import { ReferenceChip } from '@deepseek-ai/dsh-client-ui-primitives'
import type { NS } from './locales.ts'
import type {} from './user-text-rules.ts'
import css from './VideoSelectionText.module.css'

/** Same-conversation navigation supplied by the owning slot registration. */
export interface VideoSelectionTextInjected {
  /** Reveal an already validated source-selection resource. @param address - Exact recorded review link. */
  readonly openVideoSelection: (address: string) => void
}

type VideoSelectionTextProps = UserTextNodeProps<'muse-video-selection'> & InjectFace<VideoSelectionTextInjected> & PropsLocale<typeof NS>

/** Render source labels and original ranges without exposing technical evidence as message copy.
 * @param props - Validated node, current Session, interaction policy and owned navigation callback.
 * @returns Compact inline references; previews and foreign-Session evidence stay noninteractive.
 */
export function VideoSelectionText({ node, interactive, sessionId, openVideoSelection, t }: VideoSelectionTextProps) {
  const canOpen = interactive && node.data.sessionId === sessionId
  return <span className={css.selection} data-muse-video-selection>
    {node.data.items.map((item, index) => {
      const label = item.startSeconds === undefined || item.endSeconds === undefined ? item.label
        : t('selectedSegmentReference', { name: item.label, start: item.startSeconds.toFixed(2), end: item.endSeconds.toFixed(2) })
      return <span key={item.reviewLink}>
        {index > 0 && ' '}
        <ReferenceChip appearance="file" label={label} title={label}
          {...canOpen ? { onActivate: () => { openVideoSelection(item.reviewLink) } } : {}} />
      </span>
    })}
  </span>
}
