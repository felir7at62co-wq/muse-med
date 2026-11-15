/** Deterministic process-local time with distinct creation times for sequential review Sessions. */
let sampledTime = 1792108800000

/** Advance only after an idle-review barrier has completely settled. */
export function advanceReviewClock() { sampledTime += 1 }

/**
 * Own and restore the isolated Host's clock without replacing native timers.
 * @param {import('@deepseek-ai/cordis').Context} ctx - Fixture clock owner.
 */
export function apply(ctx) {
  const original = Date.now
  ctx.effect(() => {
    sampledTime = 1792108800000
    Date.now = () => sampledTime
    return () => { Date.now = original }
  }, 'skill-feedback snapshot clock')
}
