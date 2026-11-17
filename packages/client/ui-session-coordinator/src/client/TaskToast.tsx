/** App-wide feedback survives closing a task card or switching conversations. */
import type {} from '@deepseek-ai/dsh-client-ui-layout/client'
import { Toast } from '@deepseek-ai/dsh-client-ui-primitives'
import type { HostObservable, PropsHooks, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { CoordinationKey } from './locales.ts'

/** One transient operation result owned by the plugin's root viewing source. */
export interface TaskNotice {
  readonly seq: number
  readonly key: CoordinationKey
  readonly success: boolean
}

/** Renderer-bound feedback source and dismissal. */
export interface TaskToastInjected {
  readonly hooks: { readonly taskNotice: HostObservable<TaskNotice | null> }
  readonly dismiss: () => void
}

type Props = PropsRuntime<'shell.overlay'> & PropsHooks<TaskToastInjected['hooks']>
  & Pick<TaskToastInjected, 'dismiss'> & PropsLocale<'muse-coordination'>

/**
 * Render the shared Toast primitive for a settled task action.
 * @param props - Root feedback hook, localized text and dismissal.
 * @returns floating toast, or no overlay.
 */
export function TaskToast({ useTaskNotice, dismiss, t }: Props) {
  const notice = useTaskNotice(current => current)
  return notice === null ? null : <Toast key={notice.seq} text={t(notice.key)} {...notice.success ? { tone: 'success' as const } : {}} onDone={dismiss} />
}
