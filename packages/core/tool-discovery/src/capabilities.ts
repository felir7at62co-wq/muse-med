/** Capability categories projected only from the caller's authorized tool names. */

/** Deployment-owned capability description and exact or trailing-star tool patterns. */
export interface CapabilityDefinition {
  readonly id: string
  readonly title: string
  readonly description: string
  readonly tools: readonly string[]
}

/** Discoverable category metadata without exposing its tool definitions. */
export interface CapabilitySummary {
  readonly id: string
  readonly title: string
  readonly description: string
  readonly tool_count: number
}

function matches(name: string, definition: CapabilityDefinition): boolean {
  return definition.tools.some(pattern => pattern.endsWith('*')
    ? name.startsWith(pattern.slice(0, -1)) : name === pattern)
}

/**
 * List categories that contain at least one currently authorized tool, in configured order.
 * @param definitions - Validated category descriptions and tool-name patterns.
 * @param toolNames - Names from the caller's current authorized registry view.
 * @returns Metadata and matching tool counts; empty and unauthorized categories are omitted.
 */
export function capabilitySummaries(
  definitions: readonly CapabilityDefinition[], toolNames: readonly string[],
): CapabilitySummary[] {
  return definitions.flatMap((definition) => {
    const toolCount = toolNames.filter(name => matches(name, definition)).length
    return toolCount ? [{ id: definition.id, title: definition.title,
      description: definition.description, tool_count: toolCount }] : []
  })
}

/**
 * Find every configured category that includes a tool, without changing its authorization.
 * @param name - One tool name from the caller's authorized view.
 * @param definitions - Validated category descriptions and tool-name patterns.
 * @returns Matching category identifiers in configured order, or an empty array.
 */
export function capabilityMemberships(name: string, definitions: readonly CapabilityDefinition[]): string[] {
  return definitions.filter(definition => matches(name, definition)).map(definition => definition.id)
}

/** Reserved category for authorized tools with no configured membership. */
export const UNCATEGORIZED_CAPABILITY = 'uncategorized'

/**
 * Add a browsable category for authorized tools absent from configured groups.
 * @param definitions - Deployment categories; the reserved id cannot be configured.
 * @param toolNames - Current authorized tools eligible for discovery.
 * @param residentNames - Constant tools whose definitions are already visible.
 * @returns Configured groups and, when needed, a category containing only unassigned deferred tools.
 */
export function discoverableCapabilities(
  definitions: readonly CapabilityDefinition[], toolNames: readonly string[], residentNames: ReadonlySet<string>,
): readonly CapabilityDefinition[] {
  const unassigned = toolNames.filter(name => !residentNames.has(name) && !definitions.some(definition => matches(name, definition)))
  return unassigned.length ? [...definitions, { id: UNCATEGORIZED_CAPABILITY, title: 'Other authorized tools',
    description: 'Browse authorized tools not assigned to another capability.', tools: unassigned }] : definitions
}
