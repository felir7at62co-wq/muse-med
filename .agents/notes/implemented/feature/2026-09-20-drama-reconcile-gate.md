# Agent Note: Refuse paid asset creation until the project's assets are reconciled

Status: implemented

English | [中文](2026-09-20-drama-reconcile-gate.zh.md)

## Problem

A short-drama project held a formal asset the pipeline had generated on 2026-08-28 — asset 83840 / material 81426, `isUsed=1`, `hsAssetStatus: Active`, a high-end suit version of a lead character — and `assets_manifest.json` carried no record of it. The agent writing the episode read the manifest as the project's inventory, concluded that version was missing, and paid twice for generations that failed: 0.12 and 1.05 CNY. The manifest records what this pipeline generated, not what the Jubian project contains, so a model that reads only the manifest repeats work that already exists.

The project's workspace shipped a read-only reconcile for exactly this gap (`_tools/asset_reconcile.py`): it lists the remote project's used-and-active assets, subtracts the manifest's ids, and writes the result to `_probe/asset-reconcile.json` with a `ready` verdict that requires every unregistered asset to be registered or explicitly ignored with a note. Nothing made running it a precondition for spending money. The instruction to run it is prose in a skill, which is the failure mode this repository already answers with a gate: a decision belongs in the operation that makes it.

## Decision

`@deepseek-ai/dsh-guard-drama` gains a fifth rule, switched by `reconcileFirst` (default `true`), that refuses one method: `jubian_video` `image_generate`. That method creates a new billed asset, which is the spend the accident produced. Every other Jubian method keeps the rule it had — `jubian_storyboard` `generate` stays with the official-asset rule, `erase_subtitle` and `upscale` stay with the idempotency rule, `confirm_casting` and `remove` keep theirs, and reads are never refused.

The rule locates candidate project roots the way the official-asset rule does — the explicit `projectRoot`, otherwise `<sessionCwd|workspaceRoot>/<workshopDir>` and its immediate child directories — and reads `_probe/asset-reconcile.json` below each. The call proceeds when any candidate carries usable evidence.

Usable is the pipeline tool's own `evidence_state()` verdict, duplicated here because the gate may not run that tool: the file parses as a JSON object; `ran_at` parses as a timestamp, with a stamp carrying no zone read as China Standard Time; that instant is at most 24 hours old and no more than 5 minutes ahead of the clock; `blocking` is empty; `ignored_without_note` is empty; `ready` is exactly `true`.

Every other state is refused with the requirement that failed — no evidence file, unparseable evidence, an unparseable timestamp, staleness with the stamp quoted, a future stamp, the count and ids of undisposed unregistered assets, ignored assets without a note, or a report that is not marked ready — followed by the two commands that clear it, `python _tools/asset_reconcile.py` and `python _tools/asset_reconcile.py --dispose <asset_id> --status ignored --note "…"`, and by the reason the check exists: the manifest records what was generated, not what the project has.

## Alternatives considered

**Gate the paid storyboard submission instead.** `jubian_storyboard` `generate` is the other method that spends money, and it already has the official-asset rule. Assets are generated long before a storyboard is submitted, so gating submission refuses the work after the money is gone — the wrong end of the pipeline for this failure.

**Have the gate run the reconcile itself.** The gate reads files; it does not spawn processes. A pre-execute hook that launched a credentialed Python tool would put a slow, fallible, network-bound operation inside every matching call, and the evidence file exists to keep that work out of dispatch.

**Have the gate fetch the remote assets and compare them itself.** That needs the Jubian token, a second implementation of the comparison, and a network call on the dispatch path; the workspace tool already owns the comparison and the credentials.

**Require the manifest to cover every remote asset.** The gate cannot see the remote project from the files it may read, so the requirement is unverifiable from inside the gate — and the manifest was the artifact that was wrong, so a manifest-only check passes the exact state this rule exists to catch.

**Keep it in the skill as a `--check` the model must run.** That is the state that failed: prose a model can skip, in the same turn where it decides to spend money.

**Put the refusal in the `jubian_video` provider.** `packages/jubian/tool-jubian` is the transport adapter; it knows the remote API and nothing about the workshop layout, and refusing before the body is what `tools/pre-execute` is for.

## Consequences

The gate now mirrors a format owned outside this repository. `_tools/asset_reconcile.py` lives in the production workspace, and its `evidence_state()` is the authority for what counts as usable evidence; `reconcileState()` and the `RECONCILE_*` constants in `packages/guard/drama-gate/src/rules.ts` are the TypeScript copy. A field or window change in that tool has to be followed on both sides, which the package README's Dev Note names.

The check is per workshop, not per project: any candidate root can satisfy it, and the evidence's `script_id` is never compared with the project being written to. In a workshop holding several projects, one project's fresh report lets another create assets. That is the same weakness the official-asset rule carries, and both are recorded in the package README's Known Limitations, together with the boundary that a session stating no cwd in a deployment with no configured fallback is allowed rather than refused.

The reconciliation itself stays out of scope: the rule covers this project's manifest against the assets the remote project already has selected, and says nothing about whether an asset from another project could be reused. That search is the asset-library skill's, and the report's own `cross_project_note` is never read here.

The cost is one small local file read per `image_generate` call, and a new way to block legitimate work: a report older than a day refuses the call until it is re-run. The refusal carries that command, so the repair is one tool call, and the alternative — paying 1.17 CNY for an asset that already exists — is the outcome the rule buys.

## Testing

`packages/guard/drama-gate/tests/rules.spec.ts` pins every requirement separately (missing evidence, JSON that does not parse, JSON that is not a report object, a missing, non-string, or unparseable `ran_at`, evidence 25 hours old, evidence 10 minutes ahead, non-empty `blocking`, non-empty `ignored_without_note`, `ready: false`) and the allow side (fresh and fully disposed evidence, a minimal report with no disposition fields, a zone-less stamp read as `+08:00`, an explicit `projectRoot`, a sibling project's report, a switch turned off, and every untouched paid and read method). `packages/guard/drama-gate/tests/drama-gate.spec.ts` drives `jubian_video.image_generate` through the real tool registry with the shipped defaults, proving the interceptor refuses it before the tool body runs.

In a package-scoped `vitest run --coverage` the new functions report no uncovered statement, branch, or function.
