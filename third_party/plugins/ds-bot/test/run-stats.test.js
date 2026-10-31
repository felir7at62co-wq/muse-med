import assert from 'node:assert/strict'
import { test } from 'node:test'
import { runStatsOf } from '../src/client/text.js'
import { DICTIONARY, installLocale } from '../src/client/i18n.js'

const texts = values => runStatsOf(values).map(entry => entry.text)

test('the figures read as DSH counts them', () => {
  const values = {
    sessionStats: { turns: 12, decodeMs: 4000, decodeTokens: 150 },
    tokenUsage: { uncachedInputTokens: 50, cacheReadTokens: 900, cacheWriteTokens: 50, outputTokens: 400 },
    contextPressure: { pressureTokens: 41_000, contextWindow: 100_000 },
  }
  assert.deepEqual(texts(values), ['12 turns', '38 tok/s', 'Cache hit 90%', 'Context 41%'])
  assert.equal(runStatsOf(values).at(-1).title, '41.0K of 100.0K tokens of context in use')
})

test('a slow speed keeps a decimal, and a projected count wins over the last measure', () => {
  const values = {
    sessionStats: { turns: 1, decodeMs: 2000, decodeTokens: 9 },
    contextPressure: { pressureTokens: 10, projectedTokens: 30, contextWindow: 100 },
  }
  assert.deepEqual(texts(values), ['1 turn', '4.5 tok/s', 'Context 30%'])
})

test('a cache hit short of whole never reads 100%', () => {
  const hit = cacheReadTokens => texts({ tokenUsage: { uncachedInputTokens: 1000 - cacheReadTokens, cacheReadTokens } })
  assert.deepEqual(hit(996), ['Cache hit 99.6%'])
  assert.deepEqual(hit(1000), ['Cache hit 100%'])
  assert.deepEqual(hit(0), ['Cache hit 0%'])
})

test('nothing to count leaves the line empty', () => {
  assert.deepEqual(runStatsOf(null), [])
  assert.deepEqual(runStatsOf({ sessionStats: { turns: 0, decodeMs: 0, decodeTokens: 0 }, tokenUsage: { uncachedInputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 } }), [])
  assert.deepEqual(texts({ contextPressure: { contextWindow: 100 } }), [])
})


test('the working figure uses the calibrated prepared estimate and lists physical capacity separately', () => {
  const values = { contextPressure: {
    projectedTokens: 449_000, workingContextTokens: 534_000, workingTokenLimit: 475_000, contextWindow: 1_000_000,
  } }
  assert.deepEqual(texts(values), ['Working context 112%'])
  assert.equal(runStatsOf(values)[0].title, 'Last request estimate: 534.0K / 475.0K tokens; model window 1.0M')
  assert.deepEqual(texts({ contextPressure: { workingContextTokens: 0, workingTokenLimit: 475_000, contextWindow: 1_000_000 } }), ['Working context 0%'])
})

test('missing paired working metadata retains the existing context display', () => {
  for (const extra of [{ workingTokenLimit: 475_000 }, { workingContextTokens: 534_000 }]) {
    const values = { contextPressure: { projectedTokens: 449_000, contextWindow: 1_000_000, ...extra } }
    assert.deepEqual(texts(values), ['Context 45%'])
    assert.equal(runStatsOf(values)[0].title, '449.0K of 1.0M tokens of context in use')
  }
})

test('the prepared working estimate and model capacity follow the interface language', () => {
  const off = installLocale({
    register: () => () => {},
    bind: () => key => DICTIONARY.zh[key] ?? key,
    getLocale: () => ({ active: 'zh' }),
  })
  try {
    const values = { contextPressure: { workingContextTokens: 498_000, workingTokenLimit: 475_000, contextWindow: 1_000_000 } }
    assert.deepEqual(texts(values), ['工作上下文 105%'])
    assert.equal(runStatsOf(values)[0].title, '最近一次请求的上下文估算：498.0K / 475.0K tokens；模型总窗口 1.0M')
  } finally { off() }
})
