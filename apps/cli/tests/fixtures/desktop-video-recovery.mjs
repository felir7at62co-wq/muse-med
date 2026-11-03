/** Load the real Jubian tool bundle behind the isolated Desktop Host profile. */
import { readFile } from 'node:fs/promises'
import { apply } from '@deepseek-ai/dsh-tool-jubian'

const { recovery, ledgerRoot, task, subtask, mediaPath, completed } = JSON.parse(process.env.MUSE_HOST_RECOVERY_FIXTURE)
const mediaUrl = subtask.resultList[0].tosVideoUrl

globalThis.fetch = async (url, request) => {
  const method = request?.method ?? 'GET'
  if (process.connected) process.send({ type: 'provider-read', method }, error => { if (error && process.connected) throw error })
  if (url === mediaUrl && method === 'GET') {
    return new Response(await readFile(mediaPath))
  }
  const path = new URL(url).pathname
  if (path.endsWith('/admin/aigc/video/task/list') && method === 'GET') {
    return Response.json({ code: 200, data: { total: completed ? 1 : 0, rows: completed ? [task] : [] } })
  }
  if (completed && path.endsWith('/admin/aigc/video/task/sub/list') && method === 'POST') {
    return Response.json({ code: 200, data: { total: 1, rows: [subtask] } })
  }
  if (completed && path.endsWith(`/admin/aigc/video/task/${task.id}`) && method === 'GET') {
    return Response.json({ code: 200, data: task })
  }
  throw new Error(`Unexpected recovery fixture request: ${method} ${path}`)
}

export async function runProfile() {
  const tools = new Map()
  const disposers = []
  const ctx = {
    on: () => () => {},
    get: () => undefined,
    inject: () => {},
    provide: () => () => {},
    plugin: async () => {},
    effect: callback => {
      const dispose = callback()
      if (typeof dispose === 'function') disposers.push(dispose)
    },
    tools: { register: definition => {
      tools.set(definition.name, definition)
      return () => tools.delete(definition.name)
    } },
    credentials: { resolve: async () => ({ value: 'fixture-token' }) },
    connection: { authenticatedUrl: value => value },
    webServer: { port: 19387, collectIndexInjections: () => [] },
  }
  await apply(ctx, {
    ledgerRoot, workspaceSecrets: false, watchPollIntervalMs: 20,
    videoRecovery: recovery,
  })
  const review = tools.get('jubian_video_review')
  process.on('message', async message => {
    if (message.type !== 'fixture-review') return
    try {
      const result = await review.execute(message.args, {
        signal: new AbortController().signal,
        agent: { session: {
          header: { cwd: recovery.projectDir },
          deriveMessages: () => [{ role: 'user', source: { kind: 'user' },
            content: [{ type: 'text', text: message.userText }] }],
        } },
      })
      process.send({ type: 'fixture-review-result', result })
    } catch (error) {
      process.send({ type: 'fixture-review-result', error: String(error) })
    }
  })
  return {
    ctx,
    shutdown: { shutdown: async () => {
      for (const dispose of disposers.toReversed()) await dispose()
    } },
  }
}
