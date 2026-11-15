/** Exercise a complete single-call batch through the selected production executor. */
export async function executeTool(ctx, input) {
  const encoded = JSON.stringify(input.arguments)
  if (encoded === undefined) throw new TypeError('Tool arguments must encode as JSON')
  const batch = await ctx.tools.execute({
    calls: [{ type: 'tool-call', id: input.callId, name: input.name, arguments: encoded }],
    signal: input.signal,
    ...(input.agent === undefined ? {} : { agent: input.agent }),
    ...(input.toolSet === undefined ? {} : { toolSet: input.toolSet }),
  })
  const outcome = batch.results[0]
  if (outcome === undefined) throw new Error('Tool executor omitted its single-call outcome')
  return outcome.result
}
