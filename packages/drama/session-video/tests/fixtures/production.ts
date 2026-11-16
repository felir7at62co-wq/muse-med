/** Recorded native tool facts connecting a local video with a real episode directory entry.
 * @param path - Existing video path returned by the media download.
 * @param episodeNumber - Display number from the episode directory.
 * @param episodeId - Exact provider episode identity.
 * @param taskId - Exact provider generation task identity.
 * @param startSeq - First durable event sequence in this fixture.
 * @returns Native call/result event pairs without filename-derived grouping.
 */
export function productionVideoEvents(path: string, episodeNumber = 31, episodeId = 131, taskId = 17, startSeq = 1): {
  seq: number
  type: string
  data: unknown
}[] {
  const calls = [
    { name: 'jubian_model', args: { method: 'episodes', script_id: 10 }, result: {
      episodes: { total: 1, rows: [{ episode_id: episodeId, episode_count: episodeNumber, name: `Episode ${episodeNumber}` }] },
    } },
    { name: 'jubian_video', args: { method: 'task', task_id: taskId }, result: {
      task: { task_id: taskId, script_id: 10, episode_id: episodeId },
    } },
    { name: 'jubian_media', args: { method: 'download', media_kind: 'video', task_id: taskId, subtask_id: taskId * 10 }, result: { path } },
  ]
  return calls.flatMap((call, index) => {
    const callId = `production-${startSeq}-${index}`
    return [{ seq: startSeq + index * 2, type: 'tool/call', data: { callId, name: call.name, arguments: JSON.stringify(call.args) } },
      { seq: startSeq + index * 2 + 1, type: 'tool/result', data: { message: { toolCallId: callId,
        content: [{ type: 'text', text: JSON.stringify(call.result) }] } } }]
  })
}
