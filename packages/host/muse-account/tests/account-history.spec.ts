/** Recorded history spans Beijing calendar windows without merging the overlapping request ledger. */
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { brandString } from '@deepseek-ai/dsh-brand'
import { readMuseAccountRelayWorkbench } from '../src/account-history.ts'
import type { MuseAccountId, MuseAccountRelayHistory } from '../src/types.ts'

const account = { id: brandString<MuseAccountId>('0123456789abcdef'), username: 'writer' }
const recordingSince = '2026-10-28T16:23:54.866Z'
const dayMs = 86_400_000
interface DateRange { readonly from: string; readonly to: string }
interface FixtureOptions {
  readonly metrics?: MuseAccountRelayHistory['summary'] | null
  readonly status?: 'recorded' | 'no-requests' | 'unknown' | 'unavailable'
  readonly recordingSince?: string | null
  readonly limited?: boolean
  readonly writeFailures?: number
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(new Date('2026-11-17T17:00:00.000Z'))
})
afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers() })

function metrics(overrides: Partial<MuseAccountRelayHistory['summary']> = {}): MuseAccountRelayHistory['summary'] {
  return { requests: 1, reported: 1, partial: 0, unknown: 0,
    inputTokens: 2, outputTokens: 3, totalTokens: 5,
    inputTokensReports: 1, outputTokensReports: 1, totalTokensReports: 1, ...overrides }
}

function workbench(range: DateRange, { metrics: counts = metrics(), status = 'recorded',
  recordingSince: since = recordingSince, limited = false, writeFailures = 0 }: FixtureOptions = {}) {
  return { scope: 'self', me: { id: account.id, private: 'PRIVATE_IDENTITY' }, filters: { ...range },
    organization: { status: 'ready', updatedAt: '2026-11-17T16:00:00.000Z' },
    members: [{ id: account.id, username: account.username, departmentPaths: [[{ id: '0', name: 'Company' }]],
      usage: { status, metrics: counts }, private: 'PRIVATE_MEMBER' }],
    usage: { available: true, recordingSince: since, coverage: 'server-relay-only', limited, writeFailures },
    coordination: { tasks: [{ prompt: 'PRIVATE_TASK_CONTENT' }] }, production: { private: 'PRIVATE_PRODUCTION' } }
}

function shiftDay(day: string, delta: number): string { return new Date(Date.parse(day) + delta * dayMs).toISOString().slice(0, 10) }

it('rejects an unavailable current-member metric despite available global metering', async () => {
  await expect(readMuseAccountRelayWorkbench({ account, requestTimeoutMs: 1000,
    read: async range => Response.json(workbench(range, { status: 'unavailable', metrics: null })),
  })).rejects.toMatchObject({ code: 'gateway-rejected' })
})

it.each([false, undefined])('retains verified organization without consuming unsupported member metering (available: %s)', async (available) => {
  const value = await readMuseAccountRelayWorkbench({ account, requestTimeoutMs: 1000,
    read: async (range) => {
      const fixture = workbench(range)
      return Response.json({ ...fixture, usage: available === undefined ? undefined : { available },
        members: [{ ...fixture.members[0], usage: { unsupported: 'PRIVATE_METRICS' } }],
      })
    },
  })
  expect(value.organization?.status).toBe('available')
  expect(value.history).toBeUndefined()
  expect(JSON.stringify(value)).not.toContain('PRIVATE_')
})

it.each(['inputTokensReports', 'outputTokensReports', 'totalTokensReports'] as const)(
  'rejects a nonnull token counter without any %s report', async (field) => {
    await expect(readMuseAccountRelayWorkbench({ account, requestTimeoutMs: 1000,
      read: async range => Response.json(workbench(range, { metrics: metrics({ [field]: 0 }) })),
    })).rejects.toMatchObject({ code: 'gateway-rejected' })
  },
)

it('uses one Beijing range for the available recorded history and discards unrelated workbench content', async () => {
  const ranges: DateRange[] = []
  const recorded = metrics({ requests: 2610, reported: 2588, partial: 1, unknown: 21,
    inputTokens: 473_244_710, outputTokens: 1_727_879, totalTokens: 474_972_589,
    inputTokensReports: 2589, outputTokensReports: 2589, totalTokensReports: 2589 })
  const value = await readMuseAccountRelayWorkbench({ account, requestTimeoutMs: 1000,
    read: async (range) => { ranges.push(range); return Response.json(workbench(range, { metrics: recorded })) },
  })
  expect(ranges).toEqual([{ from: '2026-10-20', to: '2026-11-18' }])
  expect(value.history).toEqual({ from: '2026-10-29', to: '2026-11-18', timeZone: 'Asia/Shanghai',
    recordingSince, limited: false, health: { state: 'ok' }, summary: recorded })
  expect(value.organization?.departments).toEqual([{ id: '0', name: 'Company', path: 'Company', pathIds: ['0'] }])
  expect(JSON.stringify(value)).not.toContain('PRIVATE_')
})

it.each([
  ['2026-11-01T16:30:00.000Z', recordingSince, '2026-11-02', '2026-11-02'],
  ['2026-10-20T16:00:00.000Z', '2026-11-01T16:00:00.000Z', '2026-10-21', '2026-11-02'],
] as const)('bounds history by the later Beijing creation/log date for %s', async (createdAt, since, firstFrom, expectedFrom) => {
  const ranges: DateRange[] = []
  const value = await readMuseAccountRelayWorkbench({ account, createdAt, requestTimeoutMs: 1000,
    read: async (range) => { ranges.push(range); return Response.json(workbench(range, { recordingSince: since })) },
  })
  expect(ranges).toEqual([{ from: firstFrom, to: '2026-11-18' }])
  expect(value.history).toMatchObject({ from: expectedFrom, to: '2026-11-18', recordingSince: since })
})

it('covers more than a year through consecutive nonoverlapping windows while retaining the first Beijing end date', async () => {
  const ranges: DateRange[] = [], signals: AbortSignal[] = []
  const since = '2025-07-31T16:00:00.000Z'
  const value = await readMuseAccountRelayWorkbench({ account, createdAt: '2024-12-31T16:00:00.000Z', requestTimeoutMs: 1000,
    read: async (range, signal) => {
      ranges.push(range); signals.push(signal)
      vi.setSystemTime(new Date('2026-11-18T17:00:00.000Z'))
      return Response.json(workbench(range, { recordingSince: since }))
    },
  })
  expect(ranges[0]).toEqual({ from: '2026-10-20', to: '2026-11-18' })
  expect(ranges.at(-1)?.from).toBe('2025-08-01')
  expect(ranges.length).toBeGreaterThan(12)
  expect(new Set(signals).size).toBe(1)
  let coveredDays = 0
  for (const [index, range] of ranges.entries()) {
    const length = (Date.parse(range.to) - Date.parse(range.from)) / dayMs + 1
    expect(length).toBeGreaterThan(0)
    expect(length).toBeLessThanOrEqual(30)
    if (index > 0) expect(range.to).toBe(shiftDay(ranges[index - 1]!.from, -1))
    coveredDays += length
  }
  expect(coveredDays).toBe((Date.parse('2026-11-18') - Date.parse('2025-08-01')) / dayMs + 1)
  expect(value.history).toMatchObject({ from: '2025-08-01', to: '2026-11-18', recordingSince: since,
    summary: { requests: ranges.length, inputTokens: 2 * ranges.length, outputTokens: 3 * ranges.length, totalTokens: 5 * ranges.length } })
})

it.each(['missing usage', 'unavailable usage', 'missing response'])(
  'omits history for %s without inventing profile or group data', async (kind) => {
    const value = await readMuseAccountRelayWorkbench({ account, requestTimeoutMs: 1000,
      read: async (range) => {
        const data = workbench(range)
        return kind === 'missing response' ? undefined : Response.json({ ...data,
          usage: kind === 'missing usage' ? undefined : { available: false },
        })
      },
    })
    expect(value.history).toBeUndefined()
    expect(value.organization?.status).toBe(kind === 'missing response' ? undefined : 'available')
    expect(JSON.stringify(value)).not.toContain('PRIVATE_')
  },
)

it.each(['changed start', 'wrong range', 'wrong start', 'missing filters', 'missing response',
  'unavailable usage', 'missing usage', 'missing member usage', 'invalid counters'])(
  'rejects incomplete history after an intermediate %s response', async (kind) => {
    let calls = 0
    await expect(readMuseAccountRelayWorkbench({ account, requestTimeoutMs: 1000,
      read: async (range) => {
        calls++
        const data = workbench(range, { recordingSince: '2026-09-01T00:00:00.000Z' })
        if (calls === 1) return Response.json(data)
        if (kind === 'missing response') return
        return Response.json({ ...data,
          filters: kind === 'wrong range' ? { ...range, to: shiftDay(range.to, -1) }
            : kind === 'wrong start' ? { ...range, from: shiftDay(range.from, 1) } : kind === 'missing filters' ? undefined : range,
          usage: kind === 'changed start' ? { ...data.usage, recordingSince }
            : kind === 'unavailable usage' ? { available: false } : kind === 'missing usage' ? undefined : data.usage,
          members: [{ ...data.members[0], usage: kind === 'missing member usage' ? undefined
            : kind === 'invalid counters' ? { status: 'recorded', metrics: metrics({ requests: -1 }) } : data.members[0]!.usage }],
        })
      },
    })).rejects.toMatchObject({ code: 'gateway-rejected' })
    expect(calls).toBe(2)
  },
)

it('retains null counters without reports and keeps reported missing or overflowing totals null', async () => {
  const summaries = [
    metrics({ inputTokens: null, inputTokensReports: 0, outputTokens: 2, totalTokens: 2 }),
    metrics({ inputTokens: 5, outputTokens: null, totalTokens: Number.MAX_SAFE_INTEGER }),
    metrics({ inputTokens: 7, outputTokens: 8, totalTokens: 1 }),
  ]
  let calls = 0
  const value = await readMuseAccountRelayWorkbench({ account, requestTimeoutMs: 1000,
    read: async (range) => {
      const counts = summaries[calls++]
      if (counts === undefined) throw new Error('Unexpected history window')
      return Response.json(workbench(range, { recordingSince: '2026-09-01T00:00:00.000Z', metrics: counts }))
    },
  })
  expect(calls).toBe(3)
  expect(value.history?.summary).toEqual({ requests: 3, reported: 3, partial: 0, unknown: 0,
    inputTokens: 12, outputTokens: null, totalTokens: null, inputTokensReports: 2, outputTokensReports: 3, totalTokensReports: 3 })
})

it('keeps all unreported token totals null across multiple history windows', async () => {
  const value = await readMuseAccountRelayWorkbench({ account, requestTimeoutMs: 1000,
    read: async range => Response.json(workbench(range, { recordingSince: '2026-09-01T00:00:00.000Z',
      metrics: metrics({ inputTokens: null, outputTokens: null, totalTokens: null,
        inputTokensReports: 0, outputTokensReports: 0, totalTokensReports: 0 }),
    })),
  })
  expect(value.history?.summary).toMatchObject({ inputTokens: null, outputTokens: null, totalTokens: null,
    inputTokensReports: 0, outputTokensReports: 0, totalTokensReports: 0 })
})

it('rejects unsafe accumulated request and report counts', async () => {
  let calls = 0
  await expect(readMuseAccountRelayWorkbench({ account, requestTimeoutMs: 1000,
    read: async range => Response.json(workbench(range, { recordingSince: '2026-09-01T00:00:00.000Z',
      metrics: calls++ === 0 ? metrics({ requests: Number.MAX_SAFE_INTEGER, reported: Number.MAX_SAFE_INTEGER,
        inputTokensReports: Number.MAX_SAFE_INTEGER, outputTokensReports: Number.MAX_SAFE_INTEGER,
        totalTokensReports: Number.MAX_SAFE_INTEGER }) : metrics(),
    })),
  })).rejects.toMatchObject({ code: 'gateway-rejected' })
  expect(calls).toBe(2)
})

it.each([
  { reported: 0 }, { inputTokensReports: 2 }, { outputTokensReports: 2 }, { totalTokensReports: 2 },
  { requests: Number.MAX_SAFE_INTEGER + 1, reported: Number.MAX_SAFE_INTEGER + 1 },
])('rejects malformed history counter relationships %j', async (overrides) => {
  await expect(readMuseAccountRelayWorkbench({ account, requestTimeoutMs: 1000,
    read: async range => Response.json(workbench(range, { metrics: metrics(overrides) })),
  })).rejects.toMatchObject({ code: 'gateway-rejected' })
})

it.each(['first', 'last'])('retains limited coverage and degraded writes reported in the %s window', async (failureWindow) => {
  let calls = 0
  const value = await readMuseAccountRelayWorkbench({ account, requestTimeoutMs: 1000,
    read: async (range) => {
      calls++
      return Response.json(workbench(range, { recordingSince: '2026-09-01T00:00:00.000Z',
        metrics: calls === 1 ? metrics({ requests: 3, reported: 1, partial: 1, unknown: 1 }) : metrics(),
        limited: calls === 2, writeFailures: calls === (failureWindow === 'first' ? 1 : 3) ? 2 : 0 }))
    },
  })
  expect(value.history).toMatchObject({ limited: true, health: { state: 'degraded' },
    summary: { requests: 5, reported: 3, partial: 1, unknown: 1 } })
})

it('keeps unknown member coverage limited without inventing request or token counts', async () => {
  const value = await readMuseAccountRelayWorkbench({ account, requestTimeoutMs: 1000,
    read: async range => Response.json(workbench(range, { status: 'unknown', metrics: null })),
  })
  expect(value.history).toMatchObject({ limited: true, summary: { requests: 0, reported: 0, partial: 0, unknown: 0,
    inputTokens: null, outputTokens: null, totalTokens: null } })
})

it('accepts a missing log start only for an unlimited no-requests result', async () => {
  const value = await readMuseAccountRelayWorkbench({ account, requestTimeoutMs: 1000,
    read: async range => Response.json(workbench(range, { recordingSince: null, status: 'no-requests', metrics: null })),
  })
  expect(value.history).toMatchObject({ from: '2026-10-20', to: '2026-11-18', recordingSince: null, limited: false,
    summary: { requests: 0, inputTokens: null, outputTokens: null, totalTokens: null } })
})

it.each(['recorded', 'recorded zero', 'unknown', 'limited empty'])(
  'rejects an unknown history start for %s usage', async (kind) => {
    await expect(readMuseAccountRelayWorkbench({ account, requestTimeoutMs: 1000,
      read: async range => Response.json(workbench(range, { recordingSince: null,
        status: kind === 'unknown' ? 'unknown' : kind === 'limited empty' ? 'no-requests' : 'recorded',
        limited: kind === 'limited empty', metrics: kind === 'unknown' || kind === 'limited empty' ? null
          : kind === 'recorded zero' ? metrics({ requests: 0, reported: 0, inputTokensReports: 0, outputTokensReports: 0, totalTokensReports: 0 }) : metrics(),
      })),
    })).rejects.toMatchObject({ code: 'gateway-rejected' })
  },
)

it.each(['creation', 'recording start'])('rejects a future Beijing %s date', async (kind) => {
  const read = vi.fn(async (range: DateRange) => Response.json(workbench(range, {
    recordingSince: kind === 'recording start' ? '2026-11-18T16:00:00.000Z' : recordingSince,
  })))
  await expect(readMuseAccountRelayWorkbench({ account, requestTimeoutMs: 1000,
    ...(kind === 'creation' ? { createdAt: '2026-11-18T16:00:00.000Z' } : {}), read,
  })).rejects.toMatchObject({ code: 'gateway-rejected' })
  expect(read).toHaveBeenCalledTimes(kind === 'creation' ? 0 : 1)
})

it.each(['before first read', 'during read'])('refuses a history read after its shared deadline expires %s', async (stage) => {
  const controller = new AbortController()
  const timeout = vi.spyOn(AbortSignal, 'timeout').mockReturnValue(controller.signal)
  if (stage === 'before first read') controller.abort()
  const read = vi.fn(async (range: DateRange, signal: AbortSignal) => {
    expect(signal).toBe(controller.signal)
    controller.abort()
    return Response.json(workbench(range, { recordingSince: '2026-09-01T00:00:00.000Z' }))
  })
  await expect(readMuseAccountRelayWorkbench({ account, requestTimeoutMs: 1000, read }))
    .rejects.toMatchObject({ code: 'gateway-unavailable' })
  expect(timeout).toHaveBeenCalledExactlyOnceWith(1000)
  expect(read).toHaveBeenCalledTimes(stage === 'before first read' ? 0 : 1)
})
