# Agent Note: Drama production policy and result evidence

Status: implemented

English | [中文](2026-09-21-drama-policy-and-result-evidence.zh.md)

## Problem

Creative estimates cannot establish whether dialogue is audible or a performance works. Treating them as fatal checks encourages cutting original lines to satisfy arithmetic. Conversely, a successful provider task, a plausible filename or a cached encode does not establish that the reviewed result supplies the final picture. Production needs freedom in creative choices without weakening identity, authorization or delivery checks.

## Decision

The shot compiler reports one-to-four-second pacing, nine effective characters per second, the 36-character ceiling, narration and style restrictions as advice rather than fatal errors. Structural validity, official asset identity and package fit remain enforced. `preview` and `compile` require explicit `max_submit_seconds` from the intended board's actual total duration within confirmed model capability, not automatically the model's maximum. The budget includes natural closure; packing preserves whole shots, IDs, speakers, original lines and order rather than truncating them to fit.

The operator-owned `short-drama-local` preset applies live board intent and autonomous pre-charge self-checks within an existing authorization scope. Missing authorization, excess cost and destructive actions outside that scope still require a decision. This is local deployment policy, not a change to every shipped preset. Free storyboard creation forces `isGenerate=0`; paid submission retains its separate frozen-request and reconciliation path. The [model-intent decision](2026-09-21-jubian-model-intent-and-scoped-settings.md) owns exact catalogue matching and scoped configuration writes.

Delivery evidence ties the selected prepared source to the approved review in `pipeline_state.json` through shot/package mapping and video content hashes, with referenced review frames. A filename, stage marker or unrelated successful result cannot grant delivery approval. Pending erasure may supply a labelled draft, never a final-delivery fallback after elapsed time. Technical measurements report unchecked review work explicitly; provider completion does not replace frame inspection, listening or checking the actual render inputs.

Encoded-shot reuse requires the source hash and encoding arguments to match, and only a successful encode publishes its cache identity. An optional BGM plan records declared segments; repeating another episode's ordered source sequence produces advice, not rejection. The plan alone does not establish its audio. A successful `drama_bgm compose` report binds source hashes, offsets, measured gains and the output hash to deterministic assembly, but it does not establish that the music sounds appropriate.

`jubian_watch` admits a current-process job for an accepted operation's `task_id` and `stage` (`generate`, `upscale` or `erase_subtitle`). Completion requires the exact operation identity and successful current results for that stage, not merely a parent success flag. The monitor only reads: it does not submit, retry, alter production state or approve media. Cancellation stops observation, not the provider task; timeout leaves completion unverified. Existing job delivery owns notifications and the default three-consecutive-wake budget, so monitoring adds neither a second continuation loop nor an approval bypass.

## Alternatives considered

**Keep fatal creative heuristics.** They are measurable estimates, not universal requirements. Preserving original speech and inspecting actual performance is more useful than forcing every narrative into one pacing formula.

**Trust filenames, stage labels or elapsed time.** They cannot identify the reviewed bytes or establish successful subtitle removal. Explicit source mapping and review evidence cost more bookkeeping but prevent an old or unreviewed result from becoming the final input.

**Build an independent polling and retry loop.** Existing jobs already own cancellation, result delivery and wake limits. Adding paid recovery to a monitor would conflate observation with authorization and risk duplicate purchases.

## Consequences

Creative warnings require judgement; passing structural checks is not artistic approval. Hashing costs local I/O, review evidence must follow source changes, and process-local monitors must be registered again after restart. Optional plans remain declarations; composer reports add assembly evidence, not listening approval.

The [shot-tool note](2026-09-19-drama-shot-gate-tool.md) remains active for independent tool ownership but is partially superseded on creative policy and fixed budgets. The [render-tool note](2026-09-19-drama-episode-render-tool.md) remains active for delivery style and tail-frame verification. Neither is rewritten into the opposite decision or archived.

Verification distinguishes deterministic checks from production acceptance: compiler/guard regressions, free-write enforcement, cache invalidation, review-evidence matching and monitor lifecycle need focused coverage. Integration, paid-provider behavior and final audiovisual quality require separate evidence; this record does not claim that all are tested or deployed.
