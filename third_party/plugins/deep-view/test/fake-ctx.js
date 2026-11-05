// Fixture-owned effects drain pending operations before private data is removed.
export function fakeContext() {
  const registeredTools = new Map(), listeners = new Map(), warnings = [], disposers = []
  const agentsRegistry = { map: new Map(), get(id) { return this.map.get(id) }, roots() { return [...this.map.values()].filter(agent => agent.root !== false) } }
  let disposal
  const ctx = {
    registeredTools, listeners, warnings, agentsRegistry, agents: agentsRegistry,
    logger: { warn: (...args) => warnings.push(args.join(' ')) },
    tools: { register: definition => {
      if (registeredTools.has(definition.name)) throw new Error(`tool "${definition.name}" is already registered`)
      registeredTools.set(definition.name, definition)
      return ctx.effect(() => () => registeredTools.delete(definition.name))
    } },
    on: (event, fn) => {
      listeners.set(event, [...(listeners.get(event) ?? []), fn])
      return ctx.effect(() => () => listeners.set(event, listeners.get(event).filter(item => item !== fn)))
    },
    effect: fn => { const dispose = fn(); if (typeof dispose === 'function') disposers.push(dispose); return dispose },
    get: name => name === 'agents' ? agentsRegistry : undefined,
    connection: { fetch: { register: () => async () => {} } }, sessionController: {}, sessions: {},
    dispose: () => disposal ??= Promise.all(disposers.splice(0).reverse().map(dispose => dispose())),
  }
  return ctx
}
