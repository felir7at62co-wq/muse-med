/** Shared corroboration of optional audio metadata omitted by the storyboard endpoint. */
type Row = Record<string, unknown>

/** Fill missing display metadata only from one exact saved model audio reference.
 * @param row - Readback material, retained unchanged for non-audio rows or conflicting values.
 * @param reviewed - Corresponding reviewed material, if present.
 * @param modelRows - Saved model materials; duplicate matches cannot corroborate metadata.
 * @returns A copy with corroborated missing fields, or the original row without evidence.
 */
export function corroborateAudioMetadata(row: Row, reviewed: Row | undefined, modelRows: Row[]): Row {
  if (row.materialType !== 'audio' || reviewed === undefined) return row
  const matching = modelRows.filter(candidate => candidate.materialType === 'audio'
    && candidate.materialKey === row.materialKey && candidate.materialUrl === row.materialUrl)
  const corroboration = matching.length === 1 ? matching[0] : undefined
  if (corroboration === undefined) return row
  const normalized = { ...row }
  for (const field of ['materialName', 'audioDuration']) {
    if ((normalized[field] === undefined || normalized[field] === null)
      && reviewed[field] !== undefined && reviewed[field] !== null
      && corroboration[field] === reviewed[field]) normalized[field] = reviewed[field]
  }
  return normalized
}
