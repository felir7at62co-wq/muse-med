/**
 * The user's 2026-10-19 下沉 topic rules, ported from `数据与选材/.work/collect_picks.py`.
 * Function names follow the Python originals (`_bag`, `is_blocked`, `directions_hit`, `sink_score`) so the two can be compared line by line.
 */
import type { SinkEvaluation } from '../../shared/hits.ts';
import type { SinkRules } from './rules.ts';

/** Text fields a rule reads; `category` is the Python `cat`. */
export interface SinkInput { title: string | null; tags: string[]; category: string; description: string; }

/** `_bag`: source tags and category, plus every rule word found in the title or description. */
function bag(input: SinkInput, rules: SinkRules): Set<string> {
  const result = new Set(input.tags);
  if (input.category) result.add(input.category);
  const blob = `${input.title ?? ''}${input.description}`;
  for (const word of [...Object.keys(rules.modes), ...Object.keys(rules.sink), ...Object.keys(rules.hard), ...rules.strong, ...rules.block]) {
    if (blob.includes(word)) result.add(word);
  }
  return result;
}

const lower = (value: string) => value.toLowerCase();

/** `is_blocked` parts: hard-flaw words found (tags, or anywhere in title, description and tags) and strong tags in the bag, case-insensitive. */
function blockAndStrong(input: SinkInput, rules: SinkRules, words: Set<string>): { blockHits: string[]; strongHits: string[] } {
  const lowered = new Set([...words].map(lower));
  const blob = lower(`${input.title ?? ''}${input.description}`) + input.tags.map(lower).join('');
  const blockHits = rules.block.filter(word => lowered.has(lower(word)) || blob.includes(lower(word)));
  const strongHits = rules.strong.filter(word => lowered.has(lower(word)));
  return { blockHits: [...new Set(blockHits)], strongHits: [...new Set(strongHits)] };
}

/**
 * `directions_hit`: the user's chosen topic directions found in title, category, description and tags.
 * A keyword directly after a negation character (「不系统」「非系统」) does not count; each direction counts once.
 */
export function directionsHit(input: SinkInput, rules: SinkRules): string[] {
  const low = lower(`${input.title ?? ''}${input.category}${input.description}${input.tags.join('')}`);
  const hits: string[] = [];
  for (const [direction, keywords] of Object.entries(rules.directions)) {
    for (const keyword of keywords) {
      const needle = lower(keyword);
      let index = low.indexOf(needle);
      while (index >= 0) {
        const previous = index > 0 ? low[index - 1]! : '';
        if (!rules.negationPrefixes.includes(previous)) { hits.push(direction); break; }
        index = low.indexOf(needle, index + 1);
      }
      if (hits.includes(direction)) break;
    }
  }
  return hits;
}

/**
 * Evaluates one work with `sink_score`, `is_blocked` and `directions_hit`.
 * Qualifies when not blocked, the score reaches `minScore`, and (by default) a strong tag or a chosen direction matched.
 */
export function evaluateSink(input: SinkInput, rules: SinkRules): SinkEvaluation {
  const words = bag(input, rules);
  const { blockHits, strongHits } = blockAndStrong(input, rules, words);
  const blocked = blockHits.length > 0 && strongHits.length === 0;
  const directions = directionsHit(input, rules);
  const strong = new Set(rules.strong);
  const block = new Set(rules.block);
  let score = 0;
  for (const word of words) {
    score += (rules.modes[word] ?? 0) + (rules.sink[word] ?? 0) + (rules.hard[word] ?? 0);
    if (strong.has(word)) score += rules.strongBonus;
    if (block.has(word)) score -= rules.blockPenalty;
  }
  score += rules.directionBonus * directions.length;
  score = Math.round(score * 10) / 10;
  const enough = !rules.requireStrongOrDirection || strongHits.length > 0 || directions.length > 0;
  return { qualifies: !blocked && enough && score >= rules.minScore, blocked, score, strongHits, blockHits, directions };
}
