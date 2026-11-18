/** Jingliu desktop-agent catalog and workflow argument validation. @module */
import { Ajv2020 } from 'ajv/dist/2020.js'
import { HarnessError } from '@deepseek-ai/dsh-error'
import type { JingliuSession } from '@deepseek-ai/dsh-jingliu-connection'
import { isJsonValue, type JsonValue } from '@deepseek-ai/dsh-util-values'

type Fields = Record<string, JsonValue>

/**
 * Recognize JSON objects from the service.
 * @param value - decoded HTTP response or field.
 * @returns whether all fields are representable in a tool result.
 */
export function isFields(value: unknown): value is Fields {
  return value !== null && typeof value === 'object' && !Array.isArray(value) && isJsonValue(value)
}

/** Entries declare the operation's scope, cost and exact input schema. */
export interface Workflow {
  name: string
  description: string
  parameters: Fields
  role: string
  risk: 'read' | 'write' | 'generate'
  account_scoped: boolean
  costs: boolean
  needs_confirm: boolean
  long_running: boolean
}

function readEntry(value: unknown): Workflow {
  if (!isFields(value) || typeof value.name !== 'string' || !value.name.length
      || typeof value.description !== 'string' || typeof value.role !== 'string'
      || !isFields(value.parameters) || value.parameters.type !== 'object'
      || !isFields(value.parameters.properties)
      || (value.risk !== 'read' && value.risk !== 'write' && value.risk !== 'generate')
      || typeof value.account_scoped !== 'boolean' || typeof value.costs !== 'boolean'
      || typeof value.needs_confirm !== 'boolean' || typeof value.long_running !== 'boolean') {
    throw new HarnessError('镜流工具目录格式不兼容，请检查所连接的服务版本。', 'JINGLIU_INVALID_CATALOG')
  }
  return {
    name: value.name, description: value.description, role: value.role, parameters: value.parameters,
    risk: value.risk, account_scoped: value.account_scoped, costs: value.costs,
    needs_confirm: value.needs_confirm, long_running: value.long_running,
  }
}

/**
 * Load the current user's workflow catalog.
 * @param session - authenticated Jingliu connection.
 * @param signal - tool cancellation.
 * @returns unique workflow definitions from this backend.
 */
export async function catalog(session: JingliuSession, signal: AbortSignal): Promise<Workflow[]> {
  const value = await session.request('/desktop-agent/tools', { signal })
  if (!isFields(value) || !Array.isArray(value.tools) || value.count !== value.tools.length) {
    throw new HarnessError('镜流没有返回完整的工具目录。', 'JINGLIU_INVALID_CATALOG')
  }
  const entries = value.tools.map(readEntry)
  if (new Set(entries.map(entry => entry.name)).size !== entries.length) {
    throw new HarnessError('镜流目录含重复工作流，无法确定要执行的操作。', 'JINGLIU_INVALID_CATALOG')
  }
  // These studio actions regenerate video prose or submit it before Muse can review the final text.
  const archived = new Set(['run_reprompt', 'revise_shot_prompt', 'reset_shot_prompt', 'run_one_click_film'])
  return entries.filter(entry => !archived.has(entry.name))
}

/**
 * Resolve an exact registered name.
 * @param entries - current catalog.
 * @param name - remote workflow name.
 * @returns the named workflow.
 */
export function lookup(entries: readonly Workflow[], name: string): Workflow {
  const found = entries.find(entry => entry.name === name)
  if (!found) throw new HarnessError('镜流目录里没有这个工作流，请用 jingliu_workflows 查询名称。', 'JINGLIU_UNKNOWN_WORKFLOW')
  return found
}

/**
 * Check arguments before quoting or executing a remote call.
 * @param workflow - declaration from the signed-in backend.
 * @param project - explicitly selected project ID, or empty for account operations.
 * @param input - user-supplied business arguments.
 * @returns validated arguments with the project from the invocation.
 */
export function workflowArgs(workflow: Workflow, project: string, input: Fields): Fields {
  if (workflow.account_scoped === Boolean(project)) {
    throw new HarnessError(workflow.account_scoped ? '账号级操作无需 project_id。' : '请指定从 list_projects 获得的 project_id。', 'JINGLIU_INVALID_PROJECT')
  }
  if (Object.hasOwn(input, 'project_id') && input.project_id !== project) {
    throw new HarnessError('参数中的项目与本次选择不一致。', 'JINGLIU_INVALID_PROJECT')
  }
  const fields = { ...input }
  const properties = workflow.parameters.properties
  if (!isFields(properties)) throw new HarnessError('镜流参数定义无效。', 'JINGLIU_INVALID_CATALOG')
  if (Object.hasOwn(properties, 'project_id')) fields.project_id = project
  else delete fields.project_id
  if (Object.keys(fields).some(key => !Object.hasOwn(properties, key))) {
    throw new HarnessError('参数包含此工作流未声明的字段，请查看 jingliu_workflows 返回的 parameters。', 'JINGLIU_INVALID_ARGUMENTS')
  }
  const validator = new Ajv2020({ strict: false, validateFormats: false, ownProperties: true })
  let validate
  try {
    validate = validator.compile(workflow.parameters)
  } catch (error) {
    throw new HarnessError('镜流工作流的参数定义无法校验。', 'JINGLIU_INVALID_CATALOG', { cause: error })
  }
  if (!validate(fields)) throw new HarnessError(validator.errorsText(validate.errors), 'JINGLIU_INVALID_ARGUMENTS')
  return fields
}
