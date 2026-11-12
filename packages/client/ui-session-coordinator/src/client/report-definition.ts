/** Successful paired report calls publish visible rows outside the process disclosure. */
import { PartialArguments } from '@deepseek-ai/dsh-util-values'
import type { ChatNode } from '@deepseek-ai/dsh-client-ui-chat/client'
import type { ConversationNodeDefinition, ToolResultNode } from '@deepseek-ai/dsh-client-ui-conversation/client'
import { recordedReport } from './report-model.ts'

/** One root report call's recorded arguments and successful result. */
interface ReportState {
  readonly argsRaw: string
  readonly callTime: number
  readonly result: ToolResultNode | null
}

declare module '@deepseek-ai/dsh-client-ui-chat/client' {
  interface ChatNodeDataMap {
    /** Paired report result, rendered outside the collapsed process details. */
    'muse-coordination-report': { readonly block: ToolResultNode }
  }
}

/** One visible report per successful root invocation, reproduced by Session replay. */
export const reportDefinition: ConversationNodeDefinition<ReportState> = {
  kind: 'muse-coordination-report', target: 'chat',
  match: (event) => {
    if (event.type === 'tool/call' && event.data.name === 'coordinator_show_report') {
      return { id: `${event.data.turn}:${String(event.data.callId)}`, role: 'start' }
    }
    if (event.type === 'tool/result' && event.data.message.isError !== true && recordedReport(event.data.meta) !== null) {
      return { id: `${event.data.turn}:${String(event.data.message.source.callId)}`, role: 'update' }
    }
    return null
  },
  start: (_context, match) => {
    if (match.event.type !== 'tool/call') throw new Error('report start requires tool/call')
    return { argsRaw: match.event.data.arguments, callTime: match.event.time, result: null }
  },
  update: (context, match) => {
    const event = match.event
    if (event.type !== 'tool/result' || event.data.message.isError === true || recordedReport(event.data.meta) === null) return context.state
    return { ...context.state, result: {
      kind: 'tool-result', seq: event.seq, time: event.time, callId: String(event.data.message.source.callId),
      name: 'coordinator_show_report', args: PartialArguments.fromText(context.state.argsRaw),
      call: { name: 'coordinator_show_report', argsRaw: context.state.argsRaw }, callTime: context.state.callTime,
      content: event.data.message.content, isError: false, meta: event.data.meta, subCalls: [],
    } }
  },
  buildViewNode: (context) => {
    const result = context.state?.result
    const match = context.matches.findLast(value => value.event.type === 'tool/result' && value.event.seq === result?.seq)
    if (result === null || result === undefined || match === undefined) return null
    return { key: context.key, kind: 'muse-coordination-report', id: context.id, target: 'chat',
      anchorSeq: result.seq, location: match.location, visibility: 'visible', groupTree: 'turn', data: { block: result },
    } satisfies ChatNode<'muse-coordination-report'>
  },
}
