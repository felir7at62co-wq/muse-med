/** The Loader-mounted tool cancels its real account transport before reporting an aborted call. */
import { randomUUID } from 'node:crypto'
import { copyFile, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import { MuseAccountService, MuseAsrClient, type MuseAccountStatus } from '@deepseek-ai/dsh-muse-account'
import { writeMuseSession } from '@deepseek-ai/dsh-muse-account/src/session.ts'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import Tools from '@deepseek-ai/dsh-tools'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import { expect, it } from 'vitest'
import * as AudioTranscribe from '../src/index.ts'

it('awaits an aborted status transport without recovering later parts and disposes the tool', async () => {
  const root = await mkdtemp(join(tmpdir(), 'audio-loader-cancel-')), ctx = new Context()
  const release = Promise.withResolvers<undefined>(), entered = Promise.withResolvers<AbortSignal>()
  let observed: Promise<unknown> | undefined
  try {
    const jobs = join(root, 'transcript', 'jobs'), receiptFile = join(jobs, 'clip-v1.json')
    const sessionFile = join(root, 'account.json'), id = randomUUID()
    const parts = [0, 10].map((offset) => {
      const partId = randomUUID()
      return { id: partId, mp3: join(jobs, `.${partId}.wav`), sha256: 'a'.repeat(64), offset, duration: 10 }
    })
    await mkdir(jobs, { recursive: true })
    for (const part of parts) await writeFile(part.mp3, 'staged audio')
    const receipt = JSON.stringify({ id, source: join(root, 'clip.mp4'), accountUsername: 'alice', stem: 'clip', version: 1,
      language: 'zh', sha256: 'a'.repeat(64), mp3: join(jobs, `.${id}.wav`), status: 'prepared', parts })
    await writeFile(receiptFile, receipt)
    await writeMuseSession(sessionFile, { baseUrl: 'https://muse.test', cookie: '__Host-muse=fixture', username: 'alice' })
    const requests: string[] = []
    const client = new MuseAsrClient({ baseUrl: 'https://muse.test', sessionFile, requestTimeoutMs: 60_000,
      fetcher: async (_url, init) => {
        requests.push(init!.method!)
        entered.resolve(init!.signal!)
        await release.promise
        init!.signal!.throwIfAborted()
        return Response.json({}, { status: 404 })
      },
    })
    const status = async (): Promise<MuseAccountStatus> => ({ state: 'signed-in', username: 'alice', verified: false })
    const account = { name: 'fixture-account', async apply(context: Context) {
      await context.plugin(MuseAccountService, { controller: { status, logout: status,
        login: async () => { throw new Error('unused fixture login') } }, asr: client })
    } }
    ctx.baseUrl = pathToFileURL(root).href + '/'
    await ctx.plugin(Loader)
    ctx.loader.builtins.include = Include
    const modules = new Map<string, unknown>([
      ['@deepseek-ai/dsh-system-prompt', SystemPrompt], ['@deepseek-ai/dsh-tools', Tools],
      ['fixture-account', account], ['@deepseek-ai/dsh-tool-audio-transcribe', AudioTranscribe],
    ])
    ctx.loader.internal = { version: 'v2', loadCache: new Map(),
      register() { throw new Error('Unexpected loader hooks') },
      getOrCreateModuleJob() { throw new Error('Unexpected loader job') },
      resolveSync() { throw new Error('Unexpected loader resolution') },
      load() { throw new Error('Unexpected loader load') },
      async import(specifier: string) {
        if (!modules.has(specifier)) throw new Error(`Unexpected module ${specifier}`)
        return modules.get(specifier)
      },
    }
    const config = join(root, 'cordis.yml')
    await copyFile(new URL('./fixtures/cancellation.yml', import.meta.url), config)
    await ctx.loader.create({ name: 'cordis:include', config: { path: pathToFileURL(config).href } })
    await ctx.loader.await()
    for (const entry of ctx.loader.entries()) await entry.fiber?.await()
    const tools = ctx.tools, controller = new AbortController()
    let settled = false
    const call = tools.execute({ name: 'audio_transcribe', callId: ToolCallId('cancelled-status'), signal: controller.signal,
      arguments: { method: 'status', project: root, receipt: receiptFile } })
    observed = call.then(() => { settled = true }, () => { settled = true })
    const transportSignal = await Promise.race([entered.promise, call.then((result) => {
      throw new Error(`Tool settled before its status request: ${JSON.stringify(result)}`)
    })])
    controller.abort(new Error('stop transcription'))
    await Promise.resolve(undefined)
    expect(transportSignal.aborted).toBe(true)
    expect(settled).toBe(false)
    release.resolve(undefined)
    expect(await call).toMatchObject({ isError: true, content: [{ type: 'text', text: 'Error: stop transcription' }] })
    expect(requests).toEqual(['GET'])
    expect(await readFile(receiptFile, 'utf8')).toBe(receipt)
    expect((await readdir(jobs)).sort()).toEqual(['clip-v1.json', ...parts.map(part => `.${part.id}.wav`)].sort())
    const entry = [...ctx.loader.entries()].find(row => row.options.name === '@deepseek-ai/dsh-tool-audio-transcribe')
    expect(entry?.fiber).toBeDefined()
    await entry?.fiber?.dispose()
    expect(tools.get('audio_transcribe')).toBeUndefined()
  } finally {
    release.resolve(undefined)
    await observed
    await ctx.fiber.dispose()
    await rm(root, { recursive: true, force: true })
  }
})
