/** Open the active production session's workspace file tree. */
import { Button, IconFolderCloseRegular, Tooltip } from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import css from './StudioMaterials.module.css'

/** Action contributed by the file tree owner for the selected session. */
export interface StudioMaterialsActions {
  readonly openMaterials: () => void
}

/**
 * Expose the native workspace navigator from the Muse conversation header.
 * @param props - selected session metadata, localized control, and file-tree action.
 * @returns a labeled button if the session has a workspace directory.
 */
export function StudioMaterials({ sessionId, useSessions, openMaterials, t }:
Pick<PropsRuntime<'conversation.session.header.utilities'>, 'sessionId' | 'useSessions'> & PropsLocale<'sidebarFiles'> & StudioMaterialsActions) {
  const directory = useSessions(sessions => sessions.byId[sessionId]?.cwd)
  if (directory === undefined) return null
  return <Tooltip label={t('studio.materials')} side="bottom" portal>
    <Button size="sm" variant="ghost" className={css.action} aria-label={t('studio.materials')} onClick={openMaterials}>
      <IconFolderCloseRegular size={16} />
      <span className={css.label}>{t('studio.materials')}</span>
    </Button>
  </Tooltip>
}
