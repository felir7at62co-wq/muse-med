/** Offline busy shared voice slot; all asset writes and unexpected requests are rejected. */
export const name = 'shared-voice-pending-fixture'
export function apply(ctx) {
  ctx.effect(() => ctx.provide('museAccount', { async requestVoiceSlot(request, token) {
    if (token !== 'offline-shared-voice-fixture' || request.action !== 'acquire' || request.script_id !== 2708
      || request.character_id !== 'zhou' || request.voice_period_id !== 'adult'
      || request.operation_key !== 'offline-original-voice-key') {
      throw new Error('Unexpected offline voice coordination request')
    }
    return { state: 'busy', script_id: 2708, character_id: 'zhou', voice_period_id: 'adult', blocking_state: 'submitted' }
  } }))
  ctx.effect(() => {
    const original = globalThis.fetch
    globalThis.fetch = async (input, init) => {
      const url = new URL(input instanceof Request ? input.url : input.toString())
      if (url.origin !== 'https://shared-voice.invalid' || url.pathname !== '/prod-api/aigc/asset/list'
        || init?.method !== 'GET' || url.searchParams.get('scriptId') !== '2708'
        || url.searchParams.get('assetType') !== '4' || url.searchParams.get('pageNum') !== '1') {
        throw new Error('Offline pending fixture rejects writes and unexpected traffic')
      }
      return Response.json({ code: 200, data: { total: 0, rows: [] } })
    }
    return () => { globalThis.fetch = original }
  })
}
