/** Model tool for the Host-owned, read-only public character reference library. */
import type { Context } from '@deepseek-ai/cordis'
import { AttachmentId, IMAGE_RESULT_SCHEMA } from '@deepseek-ai/dsh-attachment'
import type { ImageAttachmentRef } from '@deepseek-ai/dsh-attachment'
import { MAX_PREVIEW_BYTES } from '@deepseek-ai/dsh-character-library'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type {} from '@deepseek-ai/dsh-settings'
import { readAuthoritativeProjectCharacter } from './project-role.ts'
import { matchCharacterReferences } from './reference.ts'

export const name = 'tool-character-reference'
export const inject = ['tools', 'characterLibrary', 'settings']

const outputSchema = { type: 'object', additionalProperties: false, properties: {
  status: { type: 'string', required: true, enum: ['candidates', 'no_match'] },
  character_id: { type: 'string', required: true },
  candidates: { type: 'array', required: true, items: { type: 'object', additionalProperties: false, properties: {
    catalog_asset_id: { type: 'string', required: true },
    original_asset_id: { type: 'string', required: true },
    image_sha256: { type: 'string', required: true },
    collection: { type: 'string', required: true, enum: ['ancient', 'urban'] },
    format: { type: 'string', required: true,
      enum: ['phase1_v2', 'legacy_v1', 'legacy_aliases', 'flat'] },
    metadata_status: { type: 'string', required: true,
      enum: ['pending_review', 'approved_claim', 'rejected_claim', 'unknown'] },
    category: { oneOf: [{ type: 'string' }, { type: 'null' }], required: true },
    setting: { oneOf: [{ type: 'string' }, { type: 'null' }], required: true },
    art_style: { oneOf: [{ type: 'string' }, { type: 'null' }], required: true },
    era: { type: 'array', required: true, items: { type: 'string' } },
    gender: { oneOf: [{ type: 'string' }, { type: 'null' }], required: true },
    appearance: { type: 'array', required: true, items: { type: 'string' } },
    tags: { type: 'array', required: true, items: { type: 'string' } },
    matched_evidence: { type: 'array', required: true, items: { type: 'string' } },
  } } },
  reason: { type: 'string', required: true },
  uncertainty: { type: 'array', required: true, items: { type: 'string' } },
  read_only: { type: 'boolean', required: true, enum: [true] },
  can_publish: { type: 'boolean', required: true, enum: [false] },
  can_reuse: { type: 'boolean', required: true, enum: [false] },
  can_bind: { type: 'boolean', required: true, enum: [false] },
  apply_allowed: { type: 'boolean', required: true, enum: [false] },
  local_writes: { type: 'integer', required: true, enum: [0] },
  remote_writes: { type: 'integer', required: true, enum: [0] },
  paid_requests: { type: 'integer', required: true, enum: [0] },
} } as const

const viewOutputSchema = { type: 'object', additionalProperties: false, properties: {
  catalog_asset_id: { type: 'string', required: true },
  image_sha256: { type: 'string', required: true },
  metadata_status: { type: 'string', required: true,
    enum: ['pending_review', 'approved_claim', 'rejected_claim', 'unknown'] },
  can_bind: { type: 'boolean', required: true, enum: [false] },
  source_read_only: { type: 'boolean', required: true, enum: [true] },
  attachment_saved: { type: 'boolean', required: true, enum: [true] },
  tos_writes: { type: 'integer', required: true, enum: [0] },
  paid_requests: { type: 'integer', required: true, enum: [0] },
  image: { ...IMAGE_RESULT_SCHEMA, required: true },
} } as const

function imageRef(image: {
  readonly attachmentId: string
  readonly mediaType: ImageAttachmentRef['mediaType']
  readonly bytes: number
  readonly width: number
  readonly height: number
  readonly name?: string
  readonly originalDimensions?: { readonly width: number; readonly height: number }
}): ImageAttachmentRef {
  return {
    attachmentId: AttachmentId(image.attachmentId),
    mediaType: image.mediaType,
    bytes: image.bytes,
    width: image.width,
    height: image.height,
    ...(image.name === undefined ? {} : { name: image.name }),
    ...(image.originalDimensions === undefined ? {} : {
      originalDimensions: { ...image.originalDimensions },
    }),
  }
}

/** Register bounded search and verified Agent-visible image inspection. */
export function apply(ctx: Context): void {
  const library = ctx.characterLibrary
  ctx.tools.register(defineTool({
    name: 'drama_character_references',
    description: '根据当前剧本角色需求，从 Host 管理的人物参考库初排最多三张候选。主角默认可检索；配角默认跳过，只有提供剧情相关例外理由才检索。'
      + '返回候选身份、原图 SHA-256 和文字匹配依据；这是检索，不代表已经看图。可按候选 ID 调用 drama_character_reference_view 实际看图，再自行比较、选择或放弃。所有结果仅供参考，不授予发布、复用、绑定或应用权限。'
      + '本工具不接受文件路径、TOS key 或索引位置，不上传、不写入、不调用供应商。',
    parameters: {
      character_id: { type: 'string', required: true, description: '当前项目角色 ID；只用于关联本次建议，不等于 catalog_asset_id。' },
      role_description: { type: 'string', required: true, description: '从当前剧本提取的角色需求摘要，不可编造。' },
      role_class: { type: 'string', required: true,
        enum: ['lead', 'important_support', 'support', 'extra'],
        description: '项目角色类型声明；Host 会与当前 Session 项目圣经中的权威值核对，不一致时拒绝。' },
      supporting_use_reason: { type: 'string',
        description: '非主角使用公共参考库的剧情相关例外理由；缺失时非主角默认不检索。' },
      collection: { type: 'string', enum: ['ancient', 'urban', 'all'], description: '已知人物风格范围；不确定时省略。' },
      required_era: { type: 'string', description: '剧本明确要求的年代；不得从素材状态推断。' },
      gender: { type: 'string', description: '剧本明确要求的性别；不确定时省略。' },
      style_terms: { type: 'array', items: { type: 'string' }, description: '从剧本提取的风格关键词。' },
      trait_terms: { type: 'array', items: { type: 'string' }, description: '从剧本提取的外观或气质关键词。' },
      role_terms: { type: 'array', items: { type: 'string' }, description: '从剧本提取的角色适配关键词。' },
    },
    output: {
      schema: outputSchema,
      render: (_args, value): ContentBlock[] => [{ type: 'text', text: JSON.stringify(value, null, 2) }],
    },
    execute: async (args, exec) => {
      const projectDirectory = exec.agent?.session.header.cwd
      if (projectDirectory === undefined || projectDirectory.trim().length === 0) {
        throw new Error('drama_character_references requires the current Agent Session workspace.')
      }
      return await matchCharacterReferences(library, {
        read: async (directory, characterId, signal) => await readAuthoritativeProjectCharacter(
          ctx.settings,
          directory,
          characterId,
          signal,
        ),
      }, projectDirectory, args, exec.signal)
    },
  }))

  ctx.tools.register(defineTool({
    name: 'drama_character_reference_view',
    description: '实际查看先前检索到的一张人物候选图片。传入候选的 catalog_asset_id 和 image_sha256；Host 重新读取并核对图片身份与原图 SHA-256，然后把图片作为图像内容交给当前支持看图的模型。看图不授予素材使用、绑定或发布许可。',
    parameters: {
      catalog_asset_id: { type: 'string', required: true, description: '检索结果中的稳定 Catalog ID；不是项目 character_id 或供应商资产 ID。' },
      expected_sha256: { type: 'string', required: true, description: '检索结果中的原图 SHA-256；不得自行编造。' },
    },
    output: {
      schema: viewOutputSchema,
      render: (_args, value): ContentBlock[] => {
        const { image, ...details } = value
        return [
          { type: 'text', text: JSON.stringify({ ...details, image_attached: true }) },
          { type: 'image', attachment: imageRef(image) },
        ]
      },
    },
    execute: async (args, exec) => {
      if (!/^[a-f0-9]{64}$/u.test(args.expected_sha256)) {
        throw new Error('drama_character_reference_view requires the candidate image SHA-256.')
      }
      const agent = exec.agent
      if (agent?.session.header.cwd === undefined || agent.session.header.cwd.trim().length === 0) {
        throw new Error('drama_character_reference_view requires the current Agent Session workspace.')
      }
      const attachments = ctx.get('attachments')
      if (attachments === undefined) {
        throw new Error('drama_character_reference_view requires a durable image attachment service.')
      }
      const routed = agent.session.requestHeader()?.config
      const provider = routed?.provider ?? agent.options.provider
      const model = routed?.model ?? agent.options.model
      const llm = ctx.get('llm')
      if (provider === undefined || model === undefined || llm === undefined) {
        throw new Error('drama_character_reference_view cannot resolve the current model route.')
      }
      const active = await llm.resolveModelInfo(provider, model, exec.signal)
      if (!active.inputModalities?.includes('image')) {
        throw new Error('drama_character_reference_view requires an image-capable model route.')
      }
      const limits = attachments.imageLimits
      const maxBytes = Math.min(limits.maxImageBytes, limits.maxMessageImageBytes, MAX_PREVIEW_BYTES)
      if (limits.maxImagesPerMessage < 1 || maxBytes < 1) {
        throw new Error('drama_character_reference_view exceeds the deployment image limits.')
      }
      exec.signal.throwIfAborted()
      const preview = await library.preview({
        catalogAssetId: args.catalog_asset_id,
        expectedSha256: args.expected_sha256,
        maxBytes,
      }, exec.signal)
      if (preview.catalogAssetId !== args.catalog_asset_id || preview.sha256 !== args.expected_sha256) {
        throw new Error('drama_character_reference_view rejected a changed image identity.')
      }
      if (preview.metadataStatus === 'rejected_claim') {
        throw new Error('drama_character_reference_view rejected a candidate withdrawn from reference search.')
      }
      if (!limits.mediaTypes.includes(preview.contentType)) {
        throw new Error('drama_character_reference_view image type is unavailable in this deployment.')
      }
      exec.signal.throwIfAborted()
      // The committed attachment, not raw base64, survives the tool/result log.
      const ref = await attachments.saveImage({ data: preview.data, mediaType: preview.contentType })
      exec.signal.throwIfAborted()
      return {
        catalog_asset_id: preview.catalogAssetId,
        image_sha256: preview.sha256,
        metadata_status: preview.metadataStatus,
        can_bind: false,
        source_read_only: true,
        attachment_saved: true,
        tos_writes: 0 as const,
        paid_requests: 0 as const,
        image: {
          attachmentId: ref.attachmentId,
          mediaType: ref.mediaType,
          bytes: ref.bytes,
          width: ref.width,
          height: ref.height,
          ...(ref.name === undefined ? {} : { name: ref.name }),
          ...(ref.originalDimensions === undefined ? {} : {
            originalDimensions: { ...ref.originalDimensions },
          }),
        },
      }
    },
  }))
}

export type {
  CharacterLibraryMatcher,
  CharacterRoleAuthority,
  CharacterReferenceRequest,
  CharacterReferenceResult,
} from './reference.ts'
