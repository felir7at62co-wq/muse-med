/**
 * The feedback dialog and its acknowledgement and failure toasts, rendered as one entry
 * of `conversation.input.overlay` so each Session owns exactly one of each.
 * The Modal and the Toast both portal to `document.body`; the overlay slot
 * only supplies the per-session controller and the composer card the toast
 * centers over.
 * @module @deepseek-ai/dsh-client-ui-message-feedback/client/FeedbackDialog
 */

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import {
  Button, Checkbox, IconWarningOutlineRegular, Modal, Toast,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { FeedbackCategory } from '@deepseek-ai/dsh-command-feedback/types'
import type { FeedbackDialogProps } from './slots.ts'
import type { MessageFeedbackKey } from './locales.ts'
import { FEEDBACK_CATEGORY_CHIPS } from './feedback-delivery.ts'
import css from './FeedbackDialog.module.css'

const CATEGORIES = Object.keys(FEEDBACK_CATEGORY_CHIPS) as FeedbackCategory[]

/** Failure codes with their own copy; every other code reads the generic line. */
const FAILURE_COPY: Partial<Record<string, MessageFeedbackKey>> = {
  'version-conflict': 'error.conflict',
  'note-too-large': 'error.noteTooLarge',
  'muse-feedback/sign-in-required': 'error.museSignIn',
  'muse-feedback/account-changed': 'error.museAccountChanged',
  'muse-feedback/unconfirmed': 'error.museUnconfirmed',
  'muse-feedback/rejected': 'error.museRejected',
  'muse-feedback/rate-limited': 'error.museRateLimited',
  'muse-feedback/unavailable': 'error.museUnavailable',
  'muse-feedback/invalid-input': 'error.museInvalidInput',
}

/**
 * Render one Session's feedback dialog and toast.
 * @param props - the dialog hook, the draft verbs, and the locale seat.
 * @returns the modal while a target is open and either toast while it is showing.
 */
export function FeedbackDialog({
  useDialog, edit, submit, dismiss, dismissFailure, dismissToast, museInbox = false, t,
}: FeedbackDialogProps) {
  const state = useDialog(s => s)
  // The toast centers over the composer card this entry renders inside of.
  const probeRef = useRef<HTMLSpanElement>(null)
  const [card, setCard] = useState<HTMLElement | null>(null)
  useLayoutEffect(() => {
    setCard(probeRef.current?.closest<HTMLElement>('[data-composer-card]') ?? null)
  }, [])
  const toast = state.toast
  const onToastDone = useCallback(() => { dismissToast(toast) }, [dismissToast, toast])
  // A toast retires with the entry that showed it: the Toast's own timer dies
  // on unmount, and the Session's controller must not replay it on return.
  useEffect(() => () => { dismissToast(toast) }, [dismissToast, toast])
  const failureCode = state.failure
  const failure = failureCode === null ? null : t(FAILURE_COPY[failureCode] ?? 'error.generic')
  const onFailureDone = useCallback(() => { dismissFailure() }, [dismissFailure])

  return (
    <>
      <span ref={probeRef} hidden />
      {toast > 0 && failure === null && (
        <Toast
          key={toast}
          text={t(museInbox ? 'toast.museSubmitted' : 'toast.recorded')}
          tone="success"
          anchor={card}
          onDone={onToastDone}
        />
      )}
      {failure !== null && (
        <Toast
          key={`failure-${failureCode}`}
          text={failure}
          icon={<IconWarningOutlineRegular />}
          anchor={card}
          holdMs={6000}
          onDone={onFailureDone}
        />
      )}
      <Modal
        open={state.target !== null}
        title={t('dialog.title')}
        closeLabel={t('close')}
        onClose={dismiss}
        className={css.dialog as string}
        footer={(
          <Button
            variant="primary"
            className={css.submit}
            disabled={state.submitting}
            onClick={() => { void submit() }}
          >
            {state.submitting ? t('submitting') : t('submit')}
          </Button>
        )}
      >
        <div className={css.categories} role="group" aria-label={t('dialog.categories')}>
          {CATEGORIES.map(category => (
            <button
              key={category}
              type="button"
              className={state.category === category ? `${css.chip} ${css.chipActive}` : css.chip}
              aria-pressed={state.category === category}
              disabled={state.submitting}
              onClick={() => { edit({ category: state.category === category ? null : category }) }}
            >
              {t(`category.${category}`)}
            </button>
          ))}
        </div>
        <textarea
          className={css.detail}
          aria-label={t('dialog.detail')}
          placeholder={t(museInbox ? 'dialog.museHint' : 'dialog.hint')}
          value={state.text}
          readOnly={state.submitting}
          onChange={(event) => { edit({ text: event.target.value }) }}
        />
        {museInbox && (
          <Checkbox
            checked={state.includeDiagnostics}
            disabled={state.submitting}
            onChange={(includeDiagnostics) => { edit({ includeDiagnostics }) }}
            label={t('dialog.museDiagnostics')}
            className={css.diagnostics}
          />
        )}
      </Modal>
    </>
  )
}
