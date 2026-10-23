import { randomUUID } from 'node:crypto'
import type { Session } from '@deepseek-ai/dsh-session'
import type { CharacterReferenceAuthority } from '@deepseek-ai/dsh-tool-character-reference'
import {
  CHARACTER_REFERENCE_PRIVATE_ENVIRONMENT,
  CHARACTER_REFERENCE_PRIVATE_SCOPE,
  type CharacterReferenceQaAuthorizationStore,
} from './character-reference-qa-authorization.ts'

const QUESTION_ID = 'character-reference-private-rights'
const DECLINE = '取消，不授权'
const CONFIRM = '确认：我委托生成并亲自上传此图，拥有本项目参考生图权利'

/** Exact identity supplied by the Agent; the Host rereads every field before granting. */
export interface ProjectPrivateReferenceRequest {
  readonly scriptId: number
  readonly characterId: string
  readonly catalogAssetId: string
  readonly imageSha256: string
}

/** The UI answer is trusted only when this question was displayed to the live Session owner. */
export interface ProjectPrivateQuestionService {
  ask(input: {
    readonly agent: unknown
    readonly signal?: AbortSignal
    readonly questions: Array<{
      readonly id: string
      readonly header: string
      readonly question: string
      readonly detail: string
      readonly options: Array<{ readonly label: string; readonly description: string }>
    }>
  }): Promise<{ readonly answers: Array<{ readonly id: string; readonly selected: string[]; readonly custom?: string }> }>
}

/** Model-safe proof of a one-shot, project-private owner attestation; never a public review. */
export interface ProjectPrivateAuthorizationResult extends Record<string, string | number | boolean> {
  readonly authorization_id: string
  readonly authorization_version: 1
  readonly script_id: number
  readonly character_id: string
  readonly role_class: string
  readonly catalog_asset_id: string
  readonly image_sha256: string
  readonly catalog_status: 'pending_review'
  readonly scope: typeof CHARACTER_REFERENCE_PRIVATE_SCOPE
  readonly can_publish: false
  readonly can_formally_bind: false
  readonly can_cross_project_reuse: false
}

/**
 * Ask the actual Muse user to attest to an exact pending image for one project and one derivative.
 * The Agent cannot supply the answer, source declaration, or grant identity.
 * @param input - Host authority, signed-in owner, live question UI, private ledger, and exact image identity.
 * @returns A model-safe one-shot authorization identity without a provider URL.
 */
export async function authorizeProjectPrivateCharacterReference(input: {
  readonly authority: CharacterReferenceAuthority
  readonly store: CharacterReferenceQaAuthorizationStore
  readonly questions: ProjectPrivateQuestionService
  readonly agent: { readonly session: Session }
  /** Verified Muse account identity plus Session identity, obtained by the Host, never the Agent. */
  readonly ownerId: string
  readonly verifyOwner: () => Promise<string>
  readonly request: ProjectPrivateReferenceRequest
  readonly signal?: AbortSignal
  readonly now?: () => Date
}): Promise<ProjectPrivateAuthorizationResult> {
  if (input.store.environment !== CHARACTER_REFERENCE_PRIVATE_ENVIRONMENT) {
    throw new Error('Project-private authorization cannot be issued by an isolated QA ledger.')
  }
  if (!input.ownerId.trim()) throw new Error('Project-private authorization requires a verified Muse account owner.')
  const { session } = input.agent
  const expected = input.request
  const read = async () => await input.authority.read(session, {
    scriptId: expected.scriptId,
    characterId: expected.characterId,
    catalogAssetId: expected.catalogAssetId,
    expectedSha256: expected.imageSha256,
  }, input.signal)
  const first = await read()
  if (first.metadataStatus !== 'pending_review') {
    throw new Error('This self-authorization applies only to a personally uploaded pending_review image.')
  }
  const answer = await input.questions.ask({
    agent: input.agent,
    ...(input.signal === undefined ? {} : { signal: input.signal }),
    questions: [{
      id: QUESTION_ID,
      header: '人物图授权',
      question: `请确认这张图的来源与权利：是否允许用于项目 ${first.scriptId} 的「${first.characterName}」生成一张参考衍生图？`,
      detail: `Agent 自行看图并决定是否选用，你只需确认此图确由你委托生成并亲自上传，且有权交给剧变用于本项目。图片身份：${first.catalogAssetId}；SHA-256：${first.imageSha256}。原图仍为 pending_review；不批准发布、正式绑定、他人或其他项目复用。生图费用另受项目预算控制。`,
      options: [
        { label: DECLINE, description: '保持待审核；不上传、不生图。' },
        { label: CONFIRM, description: '只授权本次项目与角色的一次托管上传和一次衍生生图。' },
      ],
    }],
  })
  const reply = answer.answers.find(item => item.id === QUESTION_ID)
  if (reply?.selected.length !== 1 || reply.selected[0] !== CONFIRM || reply.custom?.trim()) {
    throw new Error('The Muse user did not explicitly authorize this project-private reference.')
  }
  input.signal?.throwIfAborted()
  if (await input.verifyOwner() !== input.ownerId) {
    throw new Error('The Muse account changed while awaiting owner authorization.')
  }
  const current = await read()
  if (current.scriptId !== first.scriptId || current.characterId !== first.characterId
    || current.roleClass !== first.roleClass || current.catalogAssetId !== first.catalogAssetId
    || current.imageSha256 !== first.imageSha256 || current.metadataStatus !== first.metadataStatus) {
    throw new Error('The project, role, or image changed while awaiting owner authorization.')
  }
  const createdAt = (input.now?.() ?? new Date()).toISOString()
  const authorizationId = randomUUID()
  input.store.appendGrant({
    authorizationId,
    authorizationVersion: 1,
    environment: CHARACTER_REFERENCE_PRIVATE_ENVIRONMENT,
    actorId: input.ownerId,
    reviewerId: `self-attested:${input.ownerId}`,
    sourceDeclaration: CONFIRM,
    projectId: current.scriptId,
    characterId: current.characterId,
    roleClass: current.roleClass,
    catalogId: current.catalogAssetId,
    imageSha256: current.imageSha256,
    catalogStatus: 'pending_review',
    scope: CHARACTER_REFERENCE_PRIVATE_SCOPE,
    maxGenerationUses: 1,
    allowPublish: false,
    allowFormalBind: false,
    allowCrossProjectReuse: false,
    productionApproved: false,
    createdAt,
  })
  return {
    authorization_id: authorizationId,
    authorization_version: 1,
    script_id: current.scriptId,
    character_id: current.characterId,
    role_class: current.roleClass,
    catalog_asset_id: current.catalogAssetId,
    image_sha256: current.imageSha256,
    catalog_status: 'pending_review',
    scope: CHARACTER_REFERENCE_PRIVATE_SCOPE,
    can_publish: false,
    can_formally_bind: false,
    can_cross_project_reuse: false,
  }
}
