/** Cancellation, phase evidence and quiescent browser cleanup for model-editor scenarios. */
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Browser, BrowserType, Page } from 'playwright'
import type { TestContext } from 'vitest'

/** Current browser page and bounded scenario progress retained when an action times out. */
interface ModelBrowserProgress {
  phase(name: string): void
  page(page: Page): Page
}

/**
 * Keep interactions in the case budget and join cleanup in the awaited completion hook.
 * @param test - Owning test's cancellation signal and completion hooks.
 * @param engine - Browser engine under test.
 * @param label - Scenario-owned artifact filename.
 * @param prepare - Install the provider used by this scenario.
 * @param body - Model-editor interactions with phase and current-page observations.
 * @param restore - Remove the scenario's provider after its browser and body settle.
 * @returns Once the body settles; body errors stay intact and cleanup errors reach the completion hook.
 */
export async function runModelBrowserCase(
  test: Pick<TestContext, 'signal' | 'onTestFailed' | 'onTestFinished'>,
  engine: Pick<BrowserType, 'launch'>,
  label: string,
  prepare: () => Promise<void>,
  body: (browser: Browser, progress: ModelBrowserProgress) => Promise<void>,
  restore: () => Promise<void>,
): Promise<void> {
  const started = performance.now()
  const phases: Array<{ phase: string; elapsedMs: number }> = []
  let currentPage: Page | undefined
  let cancelledAt: string | undefined
  let launched: Promise<Browser> | undefined
  let closing: Promise<void> | undefined
  let finishing: Promise<void> | undefined
  let cancellation: Promise<void> | undefined
  let evidence: Promise<void> | undefined
  const phase = (name: string): void => {
    phases.push({ phase: name, elapsedMs: Math.round(performance.now() - started) })
    if (phases.length > 24) phases.shift()
  }
  const report = () => ({ label, cancelledAt, phases, elapsedMs: Math.round(performance.now() - started) })
  const directory = fileURLToPath(new URL('../../../.artifacts/models-settings/', import.meta.url))
  const writeReport = async (): Promise<void> => {
    try {
      await mkdir(directory, { recursive: true })
      await writeFile(join(directory, `${label}.json`), JSON.stringify(report(), null, 2) + '\n')
    } catch (_unavailablePhaseArtifact) { /* Console diagnostics and browser cleanup remain available. */ }
  }
  const capture = (): Promise<void> => evidence ??= (async () => {
    await writeReport()
    try {
      // Optional evidence cannot hold browser cancellation beyond this short capture budget.
      await currentPage?.screenshot({ path: join(directory, `${label}.png`), fullPage: true, timeout: 1_000 })
    } catch (_unavailableFailureScreenshot) { /* The phase record remains when a page cannot render. */ }
  })()
  const close = (): Promise<void> => {
    if (launched === undefined) return Promise.resolve()
    const acquisition = launched
    return closing ??= (async () => {
      phase('close browser')
      const browser = await acquisition.catch(() => undefined)
      await browser?.close()
      phase('browser closed')
    })()
  }
  const abort = (): void => {
    cancelledAt ??= phases.at(-1)?.phase ?? 'prepare provider'
    cancellation ??= (async () => {
      try { await capture() }
      finally { await close() }
    })()
    // The completion hook awaits this same promise and retains cleanup failures.
    void cancellation.catch(() => {})
  }
  test.signal.addEventListener('abort', abort, { once: true })
  test.onTestFailed(async () => {
    await capture()
    process.stderr.write(`models browser progress: ${JSON.stringify(report())}\n`)
  })
  const execution = (async () => {
    test.signal.throwIfAborted()
    phase('prepare provider')
    await prepare()
    test.signal.throwIfAborted()
    phase('launch browser')
    launched = engine.launch()
    const browser = await launched
    test.signal.throwIfAborted()
    await body(browser, { phase, page: (page) => { currentPage = page; return page } })
    phase('body complete')
  })()
  const finish = (): Promise<void> => finishing ??= (async () => {
    const failures = new Set<unknown>()
    try { await cancellation }
    catch (error) { failures.add(error) }
    try { await close() }
    catch (error) { failures.add(error) }
    await execution.then(() => {}, () => {})
    phase('restore provider')
    try { await restore(); phase('provider restored') }
    catch (error) { failures.add(error) }
    if (failures.size > 0) throw new AggregateError([...failures], 'model-browser cleanup failed')
  })()
  test.onTestFinished(async () => {
    try { await finish() }
    finally {
      test.signal.removeEventListener('abort', abort)
      await writeReport()
      process.stdout.write(`models browser progress: ${JSON.stringify(report())}\n`)
    }
  })
  try { await execution }
  catch (error) { await capture(); throw error }
}
