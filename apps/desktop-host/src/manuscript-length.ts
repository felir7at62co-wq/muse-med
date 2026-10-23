/** Consistent character counts for advisory comparisons of complete manuscript files. */

/** Extracted-text counts include headings, scene labels, speaker names, and prose. */
export interface ManuscriptLength {
  /** Unicode code points other than whitespace, including punctuation and symbols. */
  nonWhitespaceCharacters: number
  /** Unicode letters and numbers; whitespace, punctuation, and symbols are excluded. */
  lettersAndNumbers: number
}

/** Measured growth against the supplied source, without enforcing a delivery condition. */
export interface ManuscriptLengthComparison {
  source: ManuscriptLength
  candidate: ManuscriptLength
  /** Candidate letters and numbers minus source letters and numbers. */
  difference: number
  /** Absent denominator is represented by null, never an infinite ratio. */
  ratio: number | null
  growthPercent: number | null
  /** Only supplied when the caller specifies a tolerance from the user's requirements. */
  maxGrowthPercent?: number
  assessment: 'empty_source' | 'below_source' | 'above_requested_growth' | 'within_requested_growth' | 'no_growth_limit'
}

/**
 * Count the complete extracted text using Unicode code points, without estimating Word's word count.
 * @param text - Complete manuscript text, including its structural lines.
 * @returns Explicit non-whitespace and letter/number counts; neither is a net-prose estimate.
 */
export function measureManuscriptLength(text: string): ManuscriptLength {
  let nonWhitespaceCharacters = 0, lettersAndNumbers = 0
  for (const character of text) {
    if (!/\s/u.test(character)) nonWhitespaceCharacters++
    if (/[\p{L}\p{N}]/u.test(character)) lettersAndNumbers++
  }
  return { nonWhitespaceCharacters, lettersAndNumbers }
}

/**
 * Compare aggregate letter/number counts and report any explicitly requested upper tolerance.
 * @param source - Counts for the corresponding source range.
 * @param candidate - Counts for the complete proposed output over that same range.
 * @param maxGrowthPercent - User-specified permitted growth; omitted when no numeric tolerance is known.
 * @returns Differences and an advisory assessment; no text is changed or delivery rejected.
 */
export function compareManuscriptLengths(source: ManuscriptLength, candidate: ManuscriptLength,
  maxGrowthPercent?: number): ManuscriptLengthComparison {
  const difference = candidate.lettersAndNumbers - source.lettersAndNumbers
  const ratio = source.lettersAndNumbers === 0 ? null : candidate.lettersAndNumbers / source.lettersAndNumbers
  const growthPercent = ratio === null ? null : difference / source.lettersAndNumbers * 100
  const assessment = ratio === null ? 'empty_source' : difference < 0 ? 'below_source'
    : maxGrowthPercent === undefined ? 'no_growth_limit'
      : difference > source.lettersAndNumbers * maxGrowthPercent / 100 ? 'above_requested_growth' : 'within_requested_growth'
  return { source, candidate, difference, ratio, growthPercent,
    ...maxGrowthPercent === undefined ? {} : { maxGrowthPercent }, assessment }
}
