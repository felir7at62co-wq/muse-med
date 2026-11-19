/** Sign-in messages between an embedded workbench and its Muse renderer. */
export type WorkbenchLoginResult = { code: string } | { error: 'sign-in-required' | 'unavailable' }

/** Listen for a workbench's own login action while this iframe is mounted.
 * @param frame - The registered workbench iframe.
 * @param origin - Exact origin from its trusted configuration.
 * @param issue - Request an audience-bound code from the authenticated Host.
 * @returns A disposer that invalidates pending deliveries.
 */
export function bindWorkbenchLogin(
  frame: HTMLIFrameElement, origin: string, issue: (challenge: string) => Promise<WorkbenchLoginResult>,
): () => void {
  let generation = 0
  let pending = false
  const invalidate = (): void => { generation++; pending = false }
  const listen = async (event: MessageEvent): Promise<void> => {
    const target = frame.contentWindow
    if (!target || event.source !== target || event.origin !== origin) return
    const input: unknown = event.data
    if (!input || typeof input !== 'object' || !('type' in input) || input.type !== 'muse-workbench-login'
      || !('requestId' in input) || typeof input.requestId !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/u.test(input.requestId)
      || !('challenge' in input) || typeof input.challenge !== 'string' || !/^[A-Za-z0-9_-]{43}$/u.test(input.challenge)) return
    const envelope = { type: 'muse-workbench-login-result', requestId: input.requestId }
    if (pending) { target.postMessage({ ...envelope, error: 'unavailable' }, origin); return }
    const current = generation
    pending = true
    let result: WorkbenchLoginResult
    try { result = await issue(input.challenge) }
    catch (_error) { result = { error: 'unavailable' } }
    if (current !== generation) return
    pending = false
    if (frame.contentWindow === target) target.postMessage({ ...envelope, ...result }, origin)
  }
  const onMessage = (event: MessageEvent): void => { void listen(event) }
  window.addEventListener('message', onMessage)
  frame.addEventListener('load', invalidate)
  return () => {
    invalidate()
    frame.removeEventListener('load', invalidate)
    window.removeEventListener('message', onMessage)
  }
}
