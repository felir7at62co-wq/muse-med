/** Scoped IM file delivery with Muse's workspace and managed-deliverable checks. */
import { realpath, stat } from 'node:fs/promises'
import { isAbsolute, relative, resolve, sep } from 'node:path'

const TOOL = 'dsh_im_return_file'

function contains(root, file) {
  const path = relative(root, file)
  return path === '' || (!isAbsolute(path) && path !== '..' && !path.startsWith(`..${sep}`))
}

/**
 * Authorize the same workspace files as the previous Muse channel before staging any bytes.
 * @param {object} ctx The initiating Agent's context, including deliverables validators.
 * @param {{path: string}} args The upstream file-return arguments.
 * @param {object} exec The current tool execution and its cancellation signal.
 * @param {number} maxFileBytes The product's validated file size limit.
 * @returns {Promise<string>} Physically contained absolute path passed to the upstream snapshotter.
 */
export async function validateMuseImFile(ctx, args, exec, maxFileBytes) {
  const cwd = exec.agent?.session?.header?.cwd
  if (typeof cwd !== 'string' || !isAbsolute(cwd) || typeof args.path !== 'string' || !args.path.trim()) {
    throw new Error('IM file delivery requires a Session workspace and file path')
  }
  const requested = resolve(cwd, args.path)
  if (!contains(cwd, requested)) throw new Error('IM file is outside the Session workspace')
  const [workspace, file] = await Promise.all([realpath(cwd), realpath(requested)])
  if (!contains(workspace, file)) throw new Error('IM file is outside the physical Session workspace')
  const info = await stat(file)
  if (!info.isFile() || info.size > maxFileBytes) throw new Error('IM file is not a regular file within the configured size limit')
  await ctx.serial('deliverables/validate', [file], exec.signal)
  exec.signal.throwIfAborted()
  return file
}

/**
 * Keep the upstream two-phase artifact registry while exposing its tool only during an owned IM turn.
 * @param {object} ctx Host scope with tools, systemPrompt and Agent/Session events.
 * @param {{registry: object, createTool: Function, maxFileBytes: number}} options The same bundled upstream registry, tool factory and validated product limit.
 * @returns {boolean} True after installing scoped registration and result observers.
 */
export function installMuseImFiles(ctx, { registry, createTool, maxFileBytes }) {
  if (!Number.isFinite(maxFileBytes) || maxFileBytes <= 0) throw new Error('Muse IM file size limit must be positive')
  const tool = createTool({ registry })
  const registered = new Map()
  const remove = agent => {
    const unregister = registered.get(agent)
    if (!unregister) return
    registered.delete(agent)
    unregister()
  }
  const mount = agent => {
    if (!registry.hasActiveConsumer(agent.session) || registered.has(agent)) return
    const definition = { ...tool.definition, async execute(args, exec) {
      if (!registry.hasActiveConsumer(exec.agent?.session)) throw new Error('No active IM delivery consumer owns this turn')
      const path = await validateMuseImFile(agent.ctx, args, exec, maxFileBytes)
      return tool.definition.execute({ ...args, path }, exec)
    } }
    registered.set(agent, agent.ctx.tools.register(definition))
  }
  ctx.on('tools/result', tool.onResult, { global: true })
  ctx.on('agent/inbox/claimed', ({ agent, message, turn }) => {
    registry.observeClaimedMessage(agent.session, message, turn)
    mount(agent)
  }, { global: true })
  ctx.on('session/event', (session, event) => {
    registry.observeSessionEvent(session, event)
    if (event.type === 'turn/end') {
      for (const agent of registered.keys()) if (agent.session === session) remove(agent)
    }
  }, { global: true })
  ctx.on('agent/disposed', ({ agent }) => remove(agent), { global: true })
  ctx.on('session/disposed', session => registry.disposeSession(session), { global: true })
  ctx.effect(() => () => { for (const agent of registered.keys()) remove(agent) })
  ctx.systemPrompt.context({
    name: 'dsh-im:return-file', order: 115,
    text: assembly => registry.hasActiveConsumer(assembly?.agent?.session)
      ? `When the user asks to receive a file or generated image, call ${TOOL} with its path. Only files physically inside this Session workspace may be returned. The file must pass the Host deliverables validators. This tool queues the file for delivery after your turn finishes; never claim it has already been sent or received. The channel reports delivery failures separately.`
      : '',
  })
  return true
}
