# Agent Note: Drama rules sit in one of three tiers

Status: implemented

English | [中文](2026-09-22-drama-rule-tiers.zh.md)

## Problem

The short-drama pipeline's rules lived in preset prose, skill prose, and three enforcement points with no stated rule for where a new one belongs. The same numbers — 1–4 seconds per shot, 9 effective characters per second, 36 characters, a 15-character split suggestion — appeared both as "hard gate" wording and as advice, so a model could not tell a rule it must satisfy from a number it may argue with. A project that genuinely needs a tighter pacing ceiling, such as the delivery requirement of at most 18 effective characters per shot, had nowhere to state it: it stayed a sentence in a prompt, and nothing refused the episode that ignored it.

## Decision

Every rule belongs to exactly one tier, and the tier decides the owner:

1. **执行底线 — enforced by the operation.** Refusals that hold in every project: the drama gate's idempotency key, shot-script and matched-JSON structure, official asset before a paid storyboard submission, reconcile before a billed asset, and the operation-to-project binding; the Jubian ledger and budget gate before a paid call; and `drama_shot`'s structural failures and package budget.
2. **项目交付要求 — declared by the project, judged by the tool.** A project states its own requirements in the `project_config.json` that already marks its root. `drama_shot` reads them and judges by what it finds: `delivery.max_effective_chars_per_shot` is the per-shot effective-character ceiling, and speech above it is a failure (`speech_exceeds_project_limit`) rather than a warning. Every method resolves the project — from its own `project` argument, else from the nearest `project_config.json` at or above the script, within four directories — so `validate` and `preview` report the requirement before anything is compiled. The refusal names both honest repairs: split the line along the original semantics, or change that project's requirement. A project that declares no ceiling leaves the built-in numbers as advice; a ceiling that is present but not a positive integer fails the call instead of being ignored.
3. **创作建议 — advisory.** 1–4 second shots, 9 effective characters per second, the 36-character suggestion, the 15-character split threshold, and preferring on-screen dialogue are warnings or prose. They never block compilation, and a model may deviate for performance, pauses, or narrative reasons while preserving the original text, its order, and its speakers.

The drama preset states these three tiers to the model, so a refusal can be placed in a tier, and the repository side is what makes the project tier real rather than descriptive.

## Alternatives considered

**Keep the ceiling advisory even when a project declares it.** A project requirement would then be indistinguishable from this tool's own suggestion, which is the confusion the tiers exist to remove. The escape hatch stays explicit instead: changing the requirement is an edit to that project's own config.

**Put the per-shot ceiling in the deployment-wide `drama` settings section.** `drama-settings` owns one document for the whole deployment, and a requirement that differs per project cannot live there. The project config is reused because the pipeline already writes it and the drama gate already binds paid operations by the `jubian_script_id` in it.

**Read the requirement only from an explicit `project` argument.** `validate` and `preview` would then miss it, and the model would learn the project's requirement only when compilation already failed. The ancestor lookup mirrors `video_bans.py`, which resolves the same project root from the same file.

**Weaken the project ceiling to a warning plus a report field.** A new result field would have to be added to the tool's fixed output schema, and the model would still be free to ignore it; a failure with the file, the key, and the value named is the smaller and stronger surface.

## Consequences

Speech above a project's declared ceiling now blocks compilation and writes nothing, while the identical script in a project that declares no ceiling still compiles with a warning. The tiers are therefore observable in `drama_shot`'s own results, not only in prose.

The key is documented in the package README in both languages, named in the tool description so a refusal connects to `project_config.json`, and listed in the generated tool catalog.

A project config that does not parse yields no requirement, so the built-in numbers stay advisory; the same broken file also stops the drama gate from binding a paid call to that project. The two agree because the requirement is optional and the binding is not.

Tier 3 rules stay out of the tools on purpose: enforcing pacing would make the pipeline rewrite text the user wrote, which the format's rules exist to prevent.
