/**
 * The mechanical artifact check for one `agent({schema})` result: a child that
 * settles `completed` still satisfies this run only when it delivered the
 * object the declared schema promises. The check is decidable and structural —
 * the result must be a JSON object and every property named in the schema's
 * top-level `required` list must be an own property — so an observer can tell
 * "the child finished" from "the child's artifact is usable" without reading
 * the child Session.
 *
 * Content quality stays with the caller: a schema can require a `dialogue`
 * array but cannot require it to be non-empty. Callers that need semantic
 * acceptance validate the returned value in the script.
 *
 * @module @deepseek-ai/dsh-workflow-ptc/artifact
 */

import type { ObjectJsonSchema } from '@deepseek-ai/dsh-tools'

/** Named cause of a rejected artifact; `missing` names the first required property the result omitted. */
export interface ArtifactFailure {
  /** Why the result is not a usable artifact. */
  readonly kind: 'not-a-record' | 'missing-required-property'
  /** The absent required property, for `missing-required-property`. */
  readonly missing?: string
}

/** The artifact check's verdict for one structured result. */
export type ArtifactVerdict =
  | { readonly ok: true }
  | { readonly ok: false; readonly failure: ArtifactFailure }

const ACCEPTED: ArtifactVerdict = { ok: true }

/** Whether a value is a JSON object rather than an array, null, or a scalar. */
function isJsonObject(value: unknown): boolean {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Check one child's structured result against the schema its call declared.
 * @param schema - the object-rooted schema the `agent()` call requested.
 * @param value - the provider-captured structured result.
 * @returns the verdict; a failure names the structural cause.
 */
export function checkArtifact(schema: ObjectJsonSchema, value: unknown): ArtifactVerdict {
  if (!isJsonObject(value)) return { ok: false, failure: { kind: 'not-a-record' } }
  for (const property of schema.required ?? []) {
    if (!Object.hasOwn(value as object, property)) {
      return { ok: false, failure: { kind: 'missing-required-property', missing: property } }
    }
  }
  return ACCEPTED
}

/**
 * Render one rejected artifact as the model- and log-readable detail carried by
 * the failure reason.
 * @param failure - the rejected artifact's named cause.
 * @returns the detail text naming what the result lacked.
 */
export function renderArtifactFailure(failure: ArtifactFailure): string {
  return failure.kind === 'not-a-record'
    ? 'the structured result is not a JSON object'
    : `the structured result is missing the required property "${String(failure.missing)}"`
}
