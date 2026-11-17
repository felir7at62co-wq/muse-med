/** Logged manuscript material receipts, reconstructed by the Session projection registry. */
import { Service, type Context } from '@deepseek-ai/cordis'
import type { Session } from '@deepseek-ai/dsh-session'
import type { ProjectionHandle } from '@deepseek-ai/dsh-session-projection'
import { z } from 'zod'

const MATERIAL_PREFIX = '{"manuscript_video_evidence":'

/** One returned draft-material identity, as written in a `manuscript_video_evidence` notice. */
export const manuscriptVideoReceiptSchema = z.object({ path: z.string(), sha256: z.string(), evidence_key: z.string(),
  presentation_version: z.string().optional(),
  complete_lf_text_sha256: z.string().optional(),
  source_material_sha256: z.string(),
  source_identity_sha256: z.string().optional(),
  read_source_identity_sha256: z.string().optional(),
  returned_frames: z.array(z.object({ review_id: z.string(), frame_id: z.string() })),
  scene_versions: z.array(z.object({ id: z.string(), sha256: z.string() })) })
/** Receipt fields that identify one returned draft and source-material version. */
export type ManuscriptVideoReceipt = z.infer<typeof manuscriptVideoReceiptSchema>

const noticeSchema = z.object({ manuscript_video_evidence: z.object({ receipt: manuscriptVideoReceiptSchema }) })
const receiptStateSchema = z.object({ receipts: z.array(manuscriptVideoReceiptSchema) })
type ReceiptState = z.infer<typeof receiptStateSchema>

/**
 * Read the receipt of one material notice text block.
 * @param text - Text block of a `muse-manuscript` message; every material notice starts with its evidence key.
 * @returns The receipt, or undefined for other blocks and malformed notices.
 */
export function manuscriptVideoReceiptOf(text: string): ManuscriptVideoReceipt | undefined {
  if (!text.startsWith(MATERIAL_PREFIX)) return undefined
  let value: unknown
  try { value = JSON.parse(text) }
  catch (error) {
    if (error instanceof SyntaxError) return undefined
    throw error
  }
  const parsed = noticeSchema.safeParse(value)
  return parsed.success ? parsed.data.manuscript_video_evidence.receipt : undefined
}

declare module '@deepseek-ai/cordis' {
  interface Context { manuscriptVideoReceipts: ManuscriptVideoReceipts }
}

/** Host-private reader; receipt state is absent from client projection snapshots. */
class ManuscriptVideoReceipts extends Service {
  static inject = ['sessionProjections']
  private projection!: ProjectionHandle<ReceiptState>

  constructor(ctx: Context) {
    super(ctx, 'manuscriptVideoReceipts')
  }

  protected async [Service.init](): Promise<void> {
    this.projection = await this.ctx.sessionProjections.register({ key: 'manuscriptVideoReceipts', stateVersion: 1,
      stateSchema: receiptStateSchema, init: () => ({ receipts: [] }),
      apply: (state, event) => {
        if (event.type !== 'user/message' || event.data.source.kind !== 'muse-manuscript') return state
        let receipts = state.receipts
        for (const block of event.data.content) {
          const receipt = block.type === 'text' ? manuscriptVideoReceiptOf(block.text) : undefined
          if (receipt === undefined) continue
          // The latest logged receipt of one identity is last, matching a whole-log `findLast`.
          receipts = [...receipts.filter(old => old.path !== receipt.path || old.evidence_key !== receipt.evidence_key), receipt]
        }
        return receipts === state.receipts ? state : { receipts }
      },
    })
  }

  stateOf(session: Session): ReceiptState { return this.projection.stateOf(session) }
}

/**
 * Install the Host-only receipt projection; registration completes before this resolves.
 * @param ctx - Registry scope owning registration and teardown.
 * @returns Completion after the private reader is available.
 */
export async function installManuscriptVideoReceipts(ctx: Context): Promise<void> {
  await ctx.plugin(ManuscriptVideoReceipts)
}

/**
 * Return the latest logged receipt for each draft path and evidence key, including notices that compaction later replaced.
 * @param ctx - Registry with the Host receipt projection installed.
 * @param session - Current author Session.
 * @returns Receipts ordered by the log position of their latest notice.
 */
export function loggedManuscriptVideoReceipts(ctx: Context, session: Session): readonly ManuscriptVideoReceipt[] {
  const reader = ctx.get('manuscriptVideoReceipts')
  if (reader === undefined) throw new Error('Manuscript material receipts are unavailable')
  return reader.stateOf(session).receipts
}
