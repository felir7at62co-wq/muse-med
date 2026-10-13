/** Opt-in, local-only character reference recommendation for isolated QA. */
import { isAbsolute } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { recommendCharacterReference } from './reference.ts'

export const name = 'tool-character-reference'
export const inject = ['tools']

/** Deployment-owned location of the local QA reference draft. */
export interface Config {
  /** Absolute local path to the unpublished draft index; never an Agent argument or TOS URL. */
  referenceIndexPath: string
}

/** Register only the read-only reference tool, with no asset/import/generation capability. */
export function apply(ctx: Context, config: Config = { referenceIndexPath: '' }): void {
  if (!config.referenceIndexPath || !isAbsolute(config.referenceIndexPath)) {
    throw new Error('tool-character-reference needs an absolute local referenceIndexPath.')
  }
  const indexPath = config.referenceIndexPath
  ctx.tools.register(defineTool({
    name: 'drama_character_references',
    description: '仅从部署配置指定的本地公共人物参考草稿读取一个最佳参考。输入角色描述、风格与已知外观标签；返回理由和不确定项。'
      + '这是 QA 只读建议，不是已批准素材或剧变资产。不得调用导入、select_assets、生成或任何写入工具。'
      + '年代未被明确证实或候选同分时不推荐。调用方提供的角色需求尚未自动核验剧本原文。',
    parameters: {
      role_description: { type: 'string', required: true, description: '角色需求摘要；必须来自当前剧本，不可编造。' },
      style: { type: 'string', enum: ['urban', 'ancient'], description: '已知风格，未确认时省略。' },
      desired_tags: { type: 'array', items: { type: 'string' }, description: '从需求中提取的具体服装或外观标签。' },
      era: { type: 'string', description: '明确要求的年代；草稿未确认该年代则不给出推荐。' },
    },
    output: {
      schema: { type: 'object', additionalProperties: false, properties: {
        status: { type: 'string', required: true, enum: ['recommended', 'no_match', 'needs_review'] },
        search_scope: { type: 'string', required: true, enum: ['local_draft_public_reference'] },
        recommendation: { type: 'object', additionalProperties: false, properties: {
          reference_id: { type: 'string', required: true },
          preview_path: { type: 'string', required: true },
          metadata_path: { type: 'string', required: true },
          status: { type: 'string', required: true },
        } },
        reason: { type: 'string', required: true },
        evidence: { type: 'array', required: true, items: { type: 'object', additionalProperties: false, properties: {
          label: { type: 'string', required: true },
          source_kind: { type: 'string', required: true },
          source_record: { type: 'string', required: true },
        } } },
        uncertainty: { type: 'array', required: true, items: { type: 'string' } },
        read_only: { type: 'boolean', required: true },
        apply_allowed: { type: 'boolean', required: true },
        local_writes: { type: 'integer', required: true },
        remote_writes: { type: 'integer', required: true },
        paid_requests: { type: 'integer', required: true },
      } },
      render: (_args, value): ContentBlock[] => [{ type: 'text', text: JSON.stringify(value, null, 2) }],
    },
    execute: async args => recommendCharacterReference(indexPath, args),
  }))
}
