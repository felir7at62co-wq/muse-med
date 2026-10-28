/** Local BM25 ranking over tool metadata supplied by the caller. */

/** Searchable metadata for one already-authorized tool. */
export interface ToolSearchDocument {
  readonly name: string
  readonly description: string
  readonly parameters: Readonly<Record<string, unknown>>
  readonly keywords?: readonly string[]
}

/** BM25 term saturation and document-length normalization selected by the deployment. */
export interface ToolSearchRanking {
  readonly k1: number
  readonly b: number
}

/** One matching tool name and its lexical relevance score. */
export interface ToolSearchMatch {
  readonly name: string
  readonly score: number
}

interface IndexedDocument {
  name: string
  normalizedName: string
  length: number
}

function normalize(value: string): string {
  return value.normalize('NFKC').toLowerCase().trim()
}

function terms(value: string, segmenter: Intl.Segmenter): string[] {
  const normalized = normalize(value.replace(/([\p{Ll}\d])(\p{Lu})/gu, '$1 $2'))
  const words = [...segmenter.segment(normalized)].filter(part => part.isWordLike).map(part => part.segment)
  return words.flatMap((word) => {
    const fragments = word.split(/[_./:\-]+/u).filter(Boolean)
    return fragments.length > 1 ? [word, ...fragments] : fragments
  })
}

function parameterText(parameters: Readonly<Record<string, unknown>>): string {
  const text: string[] = []
  const visit = (value: unknown): void => {
    if (Array.isArray(value)) {
      for (const child of value) visit(child)
    } else if (value !== null && typeof value === 'object') {
      for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
        if (key === 'properties' && child !== null && typeof child === 'object' && !Array.isArray(child)) {
          text.push(...Object.keys(child))
        }
        if ((key === 'description' || key === 'title') && typeof child === 'string') text.push(child)
        else if (key === 'enum' && Array.isArray(child)) {
          text.push(...child.filter((item): item is string => typeof item === 'string'))
        } else visit(child)
      }
    }
  }
  visit(parameters)
  return text.join('\n')
}

/** Reusable lexical index; rebuilding is necessary only when searchable metadata changes. */
export class ToolSearchIndex {
  private readonly segmenter = new Intl.Segmenter('zh', { granularity: 'word' })
  private readonly documents: IndexedDocument[]
  private readonly postings = new Map<string, Map<IndexedDocument, number>>()
  private readonly averageLength: number

  /**
   * Index the caller's authorized catalog without copying executable tools or full schemas into results.
   * @param documents - Tool names, descriptions, argument metadata, and optional deployment keywords.
   * @param ranking - Validated BM25 parameters supplied by the owning plugin.
   */
  constructor(documents: readonly ToolSearchDocument[], private readonly ranking: ToolSearchRanking) {
    this.documents = documents.map((document) => {
      const tokens = terms([document.name, document.description, parameterText(document.parameters),
        ...(document.keywords ?? [])].join('\n'), this.segmenter)
      const indexed = { name: document.name, normalizedName: normalize(document.name), length: tokens.length }
      for (const token of tokens) {
        const posting = this.postings.get(token) ?? new Map<IndexedDocument, number>()
        posting.set(indexed, (posting.get(indexed) ?? 0) + 1)
        this.postings.set(token, posting)
      }
      return indexed
    })
    this.averageLength = this.documents.length
      ? this.documents.reduce((sum, document) => sum + document.length, 0) / this.documents.length : 0
  }

  /**
   * Return lexical matches, putting an exact tool-name query first and resolving score ties by name.
   * @param query - Natural-language request or exact tool name; blank input has no matches.
   * @param limit - Maximum number of results; nonpositive limits return no results.
   * @returns Matching names and scores, never unrelated fallback entries or full definitions.
   */
  search(query: string, limit: number): ToolSearchMatch[] {
    const normalizedQuery = normalize(query)
    if (!normalizedQuery || limit <= 0) return []
    const scores = new Map<IndexedDocument, number>()
    for (const term of new Set(terms(query, this.segmenter))) {
      const posting = this.postings.get(term)
      if (!posting) continue
      const inverseFrequency = Math.log(1 + (this.documents.length - posting.size + 0.5) / (posting.size + 0.5))
      for (const [document, frequency] of posting) {
        const normalization = 1 - this.ranking.b + this.ranking.b * document.length / this.averageLength
        const score = inverseFrequency * frequency * (this.ranking.k1 + 1)
          / (frequency + this.ranking.k1 * normalization)
        scores.set(document, (scores.get(document) ?? 0) + score)
      }
    }
    return this.documents.flatMap((document) => {
      const exact = document.normalizedName === normalizedQuery
      const score = scores.get(document) ?? 0
      return exact || score > 0 ? [{ name: document.name, score, exact }] : []
    }).sort((left, right) => Number(right.exact) - Number(left.exact) || right.score - left.score
      || left.name.localeCompare(right.name, 'en'))
      .slice(0, limit).map(({ name, score }) => ({ name, score }))
  }
}
