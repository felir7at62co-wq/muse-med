import type { SessionId } from '@deepseek-ai/dsh-session/types'

/**
 * Open the retained Main Session only while the UI contribution remains active.
 * @param signal - Aborted when the contribution unloads.
 * @param request - Host request to open or create the retained Session.
 * @param opened - Install the identity and navigate after a successful request.
 * @param failed - Report an unsuccessful request while the contribution is active.
 * @returns Completion of the Host request and any active UI update.
 */
export async function openRetainedMain(
  signal: AbortSignal,
  request: () => Promise<{ readonly ok: true; readonly value: SessionId } | { readonly ok: false }>,
  opened: (id: SessionId) => void,
  failed: () => void,
): Promise<void> {
  let result: Awaited<ReturnType<typeof request>>
  try {
    result = await request()
  } catch (error) {
    if (!signal.aborted) throw error
    return
  }
  if (signal.aborted) return
  if (result.ok) opened(result.value)
  else failed()
}
