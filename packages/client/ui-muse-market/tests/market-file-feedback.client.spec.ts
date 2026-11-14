// @vitest-environment jsdom
/** Byte-preserving archive transport and bounded feedback at the Host result parser. */
import { expect, it, onTestFinished, vi } from 'vitest'
import { archiveBase64, downloadMarketFile, marketFailureOutcome } from '../src/client/market-actions.ts'
import { createMarketFeedback } from '../src/client/market-feedback.tsx'
import type { MarketOutcomeKey } from '../src/client/market-actions.ts'
import { createMarketOperations } from '../src/client/market-remote.ts'
import { RemoteError } from '@deepseek-ai/dsh-typert-protocol'
import { SessionId } from '@deepseek-ai/dsh-session'
import { MarketController } from '../src/client/market-controller.ts'
import type { ClientRemote } from '@deepseek-ai/dsh-api-remotes/client'

it('preserves binary bytes across multiple base64 chunks and releases the download URL', async () => {
  const bytes = Uint8Array.from({ length: 32771 }, (_, index) => index % 256)
  const file = new File([bytes], 'scene.zip')
  Object.defineProperty(file, 'arrayBuffer', { value: async () => bytes.buffer })
  const base64 = await archiveBase64(file)
  expect(Uint8Array.from(atob(base64), character => character.charCodeAt(0))).toEqual(bytes)
  const create = vi.fn<(blob: Blob) => string>().mockReturnValue('blob:market-package'), revoke = vi.fn()
  const NativeURL = URL
  vi.stubGlobal('URL', class extends NativeURL { static override createObjectURL = create; static override revokeObjectURL = revoke })
  onTestFinished(() => { vi.unstubAllGlobals(); vi.restoreAllMocks() })
  const clicked: { name: string; href: string }[] = []
  vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) { clicked.push({ name: this.download, href: this.href }) })
  downloadMarketFile({ name: file.name, base64 })
  expect(clicked).toEqual([{ name: file.name, href: 'blob:market-package' }])
  const blob = create.mock.calls[0]?.[0]
  expect(blob?.type).toBe('application/zip')
  const reader = new FileReader()
  const read = new Promise<ArrayBuffer>((resolve, reject) => {
    reader.onload = () => { if (reader.result instanceof ArrayBuffer) resolve(reader.result); else reject(Error('Expected archive bytes')) }
    reader.onerror = () => { reject(reader.error ?? Error('Archive read failed')) }
  })
  if (!blob) throw Error('Download did not create a blob')
  reader.readAsArrayBuffer(blob)
  expect(new Uint8Array(await read)).toEqual(bytes)
  await vi.waitFor(() => { expect(revoke).toHaveBeenCalledExactlyOnceWith('blob:market-package') })
})

const refusals: [unknown, MarketOutcomeKey][] = [
  [null, 'failed'], ['upstream text', 'failed'], [{}, 'cloudUnavailable'], [{ details: null }, 'cloudUnavailable'],
  [{ code: 'muse-market/access-changed' }, 'signInRequired'], [{ details: { status: 401 } }, 'signInRequired'],
  [{ details: { status: 403 } }, 'permissionDenied'], [{ details: {} }, 'failed'],
  [{ details: { code: 'default-conflict' } }, 'defaultConflict'], [{ details: { code: 'default-in-use' } }, 'releaseInUse'],
  [{ details: { code: 'release-in-use' } }, 'releaseInUse'], [{ details: { code: 'account-changed' } }, 'signInRequired'],
  ...['invalid-archive', 'invalid-manifest', 'archive-mismatch', 'catalog-changed', 'digest-mismatch'].map((code): [unknown, MarketOutcomeKey] => [{ details: { code } }, 'invalidPackage']),
  [{ details: { status: 503, code: 'server-failed' } }, 'cloudUnavailable'],
  [{ details: { status: '503', code: 'other' } }, 'failed'], [{ details: { status: 400, code: 'other' } }, 'failed'],
]
it.each(refusals)('uses locale-owned recovery copy for Host refusal %j', (error, outcome) => {
  expect(marketFailureOutcome(error)).toBe(outcome)
})

it('keeps operation feedback through panel changes and ignores completions after plugin disposal', () => {
  const feedback = createMarketFeedback(), updates = vi.fn()
  const stop = feedback.hooks.outcome.subscribe(updates)
  feedback.report('installedDone', false)
  expect(feedback.hooks.outcome.getSnapshot()).toMatchObject({ key: 'installedDone', failed: false, sequence: 1 })
  feedback.dismiss()
  expect(feedback.hooks.outcome.getSnapshot()).toBeNull()
  expect(updates).toHaveBeenCalledTimes(2)
  stop()
  feedback.report('failed', true)
  expect(updates).toHaveBeenCalledTimes(2)
  feedback.dispose(); feedback.report('done', false); feedback.dismiss()
  expect(feedback.hooks.outcome.getSnapshot()).toBeNull()
})

it('keeps the original Session id and structured refusal through generated Remote envelopes', async () => {
  const unused = async (): Promise<never> => { throw Error('Unexpected operation outside binding and inventory') }
  const error = new RemoteError('muse-market/operation-failed', 'Untrusted upstream text', { code: 'release-in-use' })
  const binding = vi.fn<ClientRemote['museMarketActivation']['binding']>()
    .mockResolvedValue({ ok: true, value: { phase: 'legacy', releases: [] } })
  const operations = createMarketOperations({
    museMarket: { sources: unused, prepare: unused, installed: async () => ({ ok: false, error }),
      importPackage: unused, exportPackage: unused, removePackage: unused },
    museMarketActivation: { defaults: unused, setDefault: unused, binding },
    museMarketCloud: { catalog: unused, identity: unused, getPublication: unused,
      installPublication: unused, publishDraft: unused, review: unused },
  })
  const controller = new MarketController(operations)
  onTestFinished(() => { controller.dispose() })
  const sessionId = SessionId('existing-market-session')
  await expect(controller.operations.binding({ sessionId })).resolves.toEqual({ phase: 'legacy', releases: [] })
  expect(binding).toHaveBeenCalledExactlyOnceWith({ sessionId })
  await expect(controller.operations.installed()).rejects.toBe(error)
  expect(controller.access.getSnapshot().revision).toBe(0)
})
