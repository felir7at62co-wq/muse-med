/** Same-connection workspace file gestures and Host-validated composer references. */
import { Service, type Context } from '@deepseek-ai/cordis'
import type { ClientRemote } from '@deepseek-ai/dsh-api-remotes/client'
import type { ISessions, SessionBinding } from '@deepseek-ai/dsh-api-session-controller/client'
import type { Branded } from '@deepseek-ai/dsh-brand'
import { randomUUID } from '@deepseek-ai/dsh-util-crypto'
import { formatFileMention } from '@deepseek-ai/dsh-file-reference/grammar'
import { workspaceTitleOf } from '@deepseek-ai/dsh-util-workspace-path'
import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { InputHub } from './input/hub.ts'
import type { ReferenceInsert } from './contract/draft-editor.ts'
import type { ComposerBlocks } from './contract/composer-blocks.ts'

/** Browser-local identity of the current workspace file drag. */
export type WorkspaceFileDragTicket = Branded<'WorkspaceFileDragTicket'>

/** The custom drag format contains a ticket, never a caller-supplied path. */
const WORKSPACE_FILE_DRAG_TYPE = 'application/x-dsh-workspace-file'

/** File tree gestures shared by a single Client connection. */
export interface WorkspaceFileReferenceActions {
  /** Browser drag format recognized by this connection's composer. */
  readonly dragType: string
  /**
   * Retain selected paths behind a ticket owned by this connection.
   * @param sessionId - source Session.
   * @param root - displayed workspace root.
   * @param paths - selected file paths.
   * @returns an opaque browser-local ticket.
   */
  startDrag(sessionId: SessionId, root: string, paths: readonly string[]): WorkspaceFileDragTicket
  /**
   * Retire the current drag.
   * @param ticket - Current ticket to retire after an aborted or completed drag.
   */
  endDrag(ticket: WorkspaceFileDragTicket): void
  /**
   * Consume a current ticket and validate its files for the target composer.
   * @param sessionId - target composer Session.
   * @param ticket - browser drop data.
   * @returns whether a current same-connection drag was inserted.
   */
  drop(sessionId: SessionId, ticket: string): Promise<boolean>
  /**
   * Validate workspace files and insert references at the live editor selection.
   * @param sessionId - target composer Session.
   * @param root - source workspace root.
   * @param paths - ordered regular files.
   * @returns whether validation and insertion succeeded; failures appear on the Session's composer.
   */
  add(sessionId: SessionId, root: string, paths: readonly string[]): Promise<boolean>
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Same-connection workspace references owned by the Conversation plugin. */
    workspaceFileReferences: WorkspaceFileReferenceActions
  }
}

/** One connection's active drag and its cancellable reference intake. */
export class WorkspaceFileReferences extends Service implements WorkspaceFileReferenceActions {
  /** @inheritdoc */
  readonly dragType = WORKSPACE_FILE_DRAG_TYPE
  private readonly lifetime = new AbortController()
  private readonly operations = new Set<Promise<boolean>>()
  private readonly state: { drag?: {
    readonly ticket: WorkspaceFileDragTicket
    readonly root: string
    readonly paths: readonly string[]
    readonly source: SessionBinding
  } } = {}

  /**
   * @param ctx - connection context.
   * @param sessions - retained Session bindings.
   * @param input - resident editor owner.
   * @param blocks - composer availability.
   * @param remote - current Host workspace validation, absent before the namespace arrives.
   * @param t - composer rejection copy.
   */
  constructor(
    ctx: Context,
    private readonly sessions: ISessions,
    private readonly input: InputHub,
    private readonly blocks: ComposerBlocks,
    private readonly remote: () => Pick<ClientRemote, 'workspaceFiles'> | undefined,
    private readonly t: TranslateNS<'conversation'>,
  ) {
    super(ctx, 'workspaceFileReferences')
    ctx.effect(() => async () => {
      delete this.state.drag
      this.lifetime.abort()
      await Promise.allSettled([...this.operations])
    }, 'workspace-file-references: intake')
  }

  /** @inheritdoc */
  startDrag(sessionId: SessionId, root: string, paths: readonly string[]): WorkspaceFileDragTicket {
    const ticket = randomUUID() as WorkspaceFileDragTicket
    delete this.state.drag
    const source = this.sessions.binding(sessionId)
    if (source !== undefined) this.state.drag = { ticket, root, paths: [...paths], source }
    return ticket
  }

  /** @inheritdoc */
  endDrag(ticket: WorkspaceFileDragTicket): void {
    if (this.state.drag?.ticket === ticket) delete this.state.drag
  }

  /** @inheritdoc */
  async drop(sessionId: SessionId, ticket: string): Promise<boolean> {
    const drag = this.state.drag
    if (drag?.ticket !== ticket) return false
    delete this.state.drag
    if (this.sessions.binding(drag.source.sessionId) !== drag.source) return false
    return this.add(sessionId, drag.root, drag.paths)
  }

  /** @inheritdoc */
  async add(sessionId: SessionId, root: string, paths: readonly string[]): Promise<boolean> {
    const binding = this.sessions.binding(sessionId)
    if (binding === undefined || paths.length === 0 || this.lifetime.signal.aborted) return false
    const controller = new AbortController()
    const dispose = binding.ctx.effect(() => () => { controller.abort() }, 'workspace-file-references: validation')
    const signal = AbortSignal.any([controller.signal, this.lifetime.signal])
    const operation = this.insert(sessionId, root, paths, binding, signal)
    this.operations.add(operation)
    try { return await operation } finally {
      this.operations.delete(operation)
      await dispose()
    }
  }

  private async insert(
    sessionId: SessionId, root: string, paths: readonly string[],
    binding: SessionBinding, signal: AbortSignal,
  ): Promise<boolean> {
    const shell = this.input.shellFor(binding)
    const accepts = (): boolean => {
      const session = binding.session.getSnapshot()
      return !session.removed && session.subagent === null
        && this.blocks.storeFor(sessionId).getSnapshot() === undefined
        && shell.snapshot.phase !== 'adjudicating' && shell.snapshot.phase !== 'submitting'
    }
    if (!accepts()) {
      shell.notify('error', this.t('attachment.dropBlocked'))
      return false
    }
    const remote = this.remote()
    if (remote === undefined) {
      shell.notify('error', this.t('attachment.workspaceUnavailable'))
      return false
    }
    const result = await remote.workspaceFiles.references(sessionId, root, paths, signal)
    if (signal.aborted || this.sessions.binding(sessionId) !== binding) return false
    if (!result.ok) {
      shell.notify('error', this.t('attachment.workspaceUnavailable'))
      return false
    }
    const references: ReferenceInsert[] = []
    for (const path of result.value) {
      const mention = formatFileMention({ path, kind: 'file' }, false)
      if (mention === undefined) {
        shell.notify('error', this.t('attachment.pathUnsupported'))
        return false
      }
      references.push({ source: 'reference', ref: mention, label: workspaceTitleOf(path), appearance: 'file', clipboardText: mention })
    }
    if (!accepts() || !shell.addFiles(references, [])) return false
    shell.focus()
    return true
  }
}
