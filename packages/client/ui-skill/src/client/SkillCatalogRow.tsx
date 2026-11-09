/** Replay-only metadata query summary that keeps cursor fields out of product copy. */
import { IconSkillOutlineRegular, TextShimmer } from '@deepseek-ai/dsh-client-ui-primitives'
import type { ToolCallViewProps } from '@deepseek-ai/dsh-client-ui-tool/client'
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import css from './SkillRow.module.css'

type SkillCatalogRowProps = ToolCallViewProps & PropsLocale<'skill'>

function summary(props: SkillCatalogRowProps): string {
  if (props.phase === 'preparing') return props.t('catalog.preparing')
  const block = props.block
  if (!('kind' in block)) return props.t('catalog.running')
  if (block.error?.code === 'interrupted') return props.t('catalog.stopped')
  if (block.isError) {
    switch (block.error?.code) {
      case 'SKILL_CATALOG_STALE_CURSOR': return props.t('catalog.stale')
      case 'SKILL_CATALOG_FOREIGN_CURSOR': return props.t('catalog.foreign')
      case 'SKILL_CATALOG_INVALID_REQUEST': return props.t('catalog.invalid')
      case 'SKILL_CATALOG_INCOMPLETE': return props.t('catalog.incomplete')
      default: return props.t('catalog.failed')
    }
  }
  const meta = block.meta
  if (meta === undefined || meta === null || typeof meta !== 'object' || Array.isArray(meta)
    || !('kind' in meta) || meta.kind !== 'skill-catalog') return props.t('catalog.done')
  const count = 'count' in meta ? meta.count : undefined
  const total = 'totalMatched' in meta ? meta.totalMatched : undefined
  const more = 'hasMore' in meta ? meta.hasMore : undefined
  if (typeof count !== 'number' || typeof total !== 'number' || !Number.isSafeInteger(count) || !Number.isSafeInteger(total)
    || count < 0 || total < count || typeof more !== 'boolean') return props.t('catalog.done')
  const label = props.t('catalog.count', { count, total })
  return more ? `${label} · ${props.t('catalog.more')}` : label
}

/**
 * Render localized counts and actionable failures from the persisted result metadata.
 * @param props - Keyed toolview payload and locale dictionary.
 * @returns Compact query row using the existing Skill row treatment.
 */
export function SkillCatalogRow(props: SkillCatalogRowProps) {
  const running = props.phase !== 'result'
  const stopped = props.phase === 'result' && props.block.error?.code === 'interrupted'
  const failed = props.phase === 'result' && !stopped && props.block.isError
  const state = props.phase === 'preparing' ? 'preparing' : running ? 'running' : stopped ? 'stopped' : failed ? 'error' : 'ok'
  return <div className={css.card} data-tool="skill_catalog" data-state={state}>
    <div className={css.row}>
      <span className={css.leading}><IconSkillOutlineRegular size={14} /></span>
      <span className={css.title}><TextShimmer active={running}>{props.t('catalog.title')}</TextShimmer></span>
      <span className={css.separator} aria-hidden />
      <span className={`${css.summary}${failed ? ` ${css.errorSummary}` : stopped ? ` ${css.stoppedSummary}` : ''}`}
        role="status">{summary(props)}</span>
    </div>
  </div>
}
