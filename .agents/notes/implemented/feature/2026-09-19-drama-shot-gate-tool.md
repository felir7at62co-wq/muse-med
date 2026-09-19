# Agent Note: Short-drama shot-script gate as a tool

Status: implemented

English | [中文](2026-09-19-drama-shot-gate-tool.zh.md)

## Problem

The short-drama pipeline's hard rules — one to four whole seconds per shot, nine effective characters per second, a 36-character ceiling, no narration track, an official-asset requirement, packages of at most fourteen content seconds — lived in the `tweet-drama-early-shot-script` skill text and were executed by a Python script the skill told the model to run. A model that skipped the skill, or ran the script with the wrong arguments, could still write a shot script whose violation only surfaced when the paid provider rendered the wrong subtitle or the packaging dropped a shot. The repository rule is that a decision is enforced in the operation that makes it; these rules are decidable — the script text, the asset manifest, and the package budget settle every one of them — so prose was the wrong home.

## Decision

A new `drama/` package group holds `@deepseek-ai/dsh-tool-shot-script`, which registers one model-facing tool, `drama_shot`, with three methods. `validate` reads a script and reports, per shot, the derived duration and its source, the effective-character count, the voice type, whether an off-screen continuation is legal, and the asset bindings, with hard failures and warnings in separate lists. `preview` adds the package plan without writing. `compile` writes `prompts/<episode>.txt`, `matches/<episode>.matched.json`, and the `episode_packages/<episode>/` tree (`package.json`, `shot_script.txt`, `matched.json`, `episode.txt`, and one copy per locally stored bound asset), and returns each package's `content_seconds`, `content_duration_ms`, `submit_seconds`, and its prompt-ordered `material_keys`.

A script with any failure-severity issue returns those failures and writes nothing: the compiler pre-resolves the episode text and every local asset image before the first byte, so a refused compile leaves the project unchanged. Script problems are a domain outcome carried in the canonical result; only environment problems (a missing file, a manifest that is not JSON) throw.

Four rules differ from the Python compiler this port replaces. The writing threshold is fifteen effective characters and the ceiling is thirty-six: sixteen to thirty-six warns, more than thirty-six fails. `台词：无`, `台词：无。` and an empty dialogue line fail instead of compiling a subtitle that reads 无. `出镜人物：无` fails; a shot with no character omits the field entirely. And each silent shot may declare `动作复杂度：简单/一般/较复杂/复杂`, which charges one, two, three, or four seconds to the package, while a silent shot without the label takes the plugin's `actionShotSeconds` (default two). Everything else is ported as written: one to four whole seconds, nine effective characters per second, a fixed negative prompt in the director format, the legacy `时长` field read, compared, and stripped, contiguity of shot numbers, the official-and-complete asset gate, scene as the continuity key, at most fourteen content seconds per package plus one second of natural hold, and the version-4 matched payload layout.

The judgement stays out of the skills on purpose: how a shot reads, how a cut feels, and how a line is phrased are not decidable, so the drama skills keep them and this tool refuses only what the format settles.

## Alternatives considered

**Keep the rules in the skill and the Python compiler.** That is the state this replaces: a rule the model must remember, plus a script a shell has to launch with the right flags. A tool call carries its arguments in the transcript, fails on a missing one, and cannot be half-remembered.

**Enforce in the guard interception instead.** `drama-gate` refuses a `write` or `edit` whose text would break a rule, which covers a session that never compiles anything. It cannot report a whole script's issues, cannot plan a package budget, and cannot produce the artifacts — a refusal is not a compile. The two are complements: the guard catches a bad file on the way in, the tool is the operation that produces the episode.

**Stay in Python.** The pipeline's script format, the asset manifest, and the matched payload are already read by Python skills, so a Python compiler needed no port. It also could not return a structured result to the model, could not be covered by this repository's gates, and lived outside the composition a session actually mounts.

**Put the package in `guard/` or `jubian/`.** The guard group intercepts dispatch; this package registers a tool and decides a format. The Jubian group adapts the remote API; this package never touches the network. A new group states the ownership honestly — the drama pipeline's own formats — even though it starts with one package.

## Consequences

The pipeline's decidable rules now have one executable home with a stable set of issue codes (`no_shots`, `speech_too_long`, `unplaced asset`, and the rest, tabulated in the package README), and a repair loop can key on them. The cost is a second implementation of the format during the transition: the Python compiler remains the reference for the matched payload's byte layout, and the skill text still describes the same rules until sessions move over.

Three limits are deliberate and recorded in the package README: scene is the only continuity key, so a time or costume change inside one scene packs into one package unless the script marks `子任务边界：是`; `actionShotSeconds` may understate what the provider renders, so the package count is a lower bound rather than a billing promise; and compile is not transactional across processes.

The package holds no state between calls and publishes no invariant companion: every answer is a pure function of the files it reads, and there is no independently changing observation to check.

## Testing

`packages/drama/tool-shot-script/tests/` covers the parser, the binder, the packer, and the registered tool through its executor; `npx vitest run --coverage` reports per-file 100% statements, branches, functions, and lines across the five source modules. The tool test validates every returned value against the tool's own `output.schema`, so a canonical value that drifts from its declared schema fails the suite rather than a session.
