---
title: Muse Skill Evolution
description: Idle task review, owned Skill versions and bounded product feedback.
kind: reference
---

# Muse Skill Evolution

English | [中文](README.zh.md)

Muse learns reusable procedures from newly completed tool-assisted tasks. This independent plugin adapts DS Bot's experience-review criteria without loading the archived Bot runtime. It creates ordinary Markdown Skills, exposes them through native Skill discovery, and retains proposals and versions for inspection and rollback. The same tool-free review can submit a bounded product suggestion to the existing Muse opinion inbox; code changes and PR handling belong to the downstream maintainer or Codex workflow.

## Learning and ownership

After a human-initiated root turn completes with at least `minToolCalls` calls and one successful result, a bounded evidence batch is queued. Pure chat, delegated review turns, failed and cancelled turns do not qualify. Review begins after the configured idle delay while root agents are idle. Existing Session history is never scanned. Resuming an interrupted review does not repeat its model request automatically.

The reviewer uses the source turn's selected provider, model and reasoning effort through a separate persisted native Session with no tools. Requests, responses, usage and the source Session identity remain inspectable. It may propose creation, update, or no change. A successful turn is evidence of completion, not user acceptance; review instructions require reusable evidence and exclude secrets, personal facts, copied logs and one-off progress.

Automatic application is limited to newly created `muse-learned-*` Skills and unchanged files already owned by this plugin. Updates require the exact reviewed baseline. Existing manual, bundled and workspace Skills receive proposals only. Manual edits, name collisions, read-only permissions and paths outside the source Session's writable roots retain proposals without overwriting files. No generated scripts, global instructions or memory files are written. The live initiating Session must still exist for automatic application.

## Management and files

Ask Muse to inspect learned Skills, show proposals, inspect version history or list automatic feedback receipts using `muse_skill_evolution`. Its write actions use the actual calling Session's permissions. Applying a proposal cannot take ownership of an unrelated Skill. Rollback writes a new owned version from a saved version and checks the current file hash; earlier versions remain retained.

The default private state directory is `<DSH_HOME>/muse-skill-evolution`; generated files live at `<DSH_HOME>/skills/<name>/SKILL.md`. Both locations are configurable absolute paths. A versioned index, immutable version files and a recovery journal preserve file/index transactions. Damaged or future state fails explicitly. Record capacity blocks new entries while retaining existing history. Recovery confirms already-written Skill bytes; an interrupted write that never reached the file becomes a blocked receipt for a new authorized application. Skill proposals and review records remain local. A product-feedback candidate and its original submission request are retained in the same private index before any inbox request. Present malformed or future feedback metadata fails instead of resetting submission history. The plugin does not publish Skills or modify product source files.

## Product feedback

A review can independently propose a Skill and one product report, or no Skill with one report. Reports contain observed and expected behavior, observed steps or an explicit unknown, acceptance checks and references to evidence actually supplied to the reviewer. They are marked as automated candidates that have not been independently reproduced. An invalid report is visibly rejected without preventing a valid Skill from being applied; a failed Skill or failed inbox request does not erase the other outcome.

The plugin calls the currently available `museAccount.feedback` service with the actual source Session, `includeDiagnostics:false` and a stable request ID. No raw conversation excerpts, copied logs, private paths or credentials are intentionally included in its plain-text summary. The existing account service owns sign-in, known-secret filtering and account-change checks. Without that service or the original live Session, a candidate remains local. Feedback is report data for later review, not code, deployment commands or an instruction to execute a fix.

One atomic local claim checks normalized exact content across retained runs, reserves the UTC-day attempt allowance and saves the immutable original request before a single POST. Evidence indexes and source identities do not change that content identity. This suppresses exact duplicates across Sessions, not every semantic paraphrase. A report matching an earlier proposed, limited, uncertain or submitted candidate is not automatically sent again, including after a setting change, a later UTC day or an account change.

Only a confirmed inbox receipt marks a submission successful. A receipt retains the inbox ID, revision and whether the server acknowledged duplicate protection; an older server's missing acknowledgement is shown as unavailable. Response loss, an account change or an interrupted submission remains unknown and is never automatically retried. Once an inbox request has begun, provider withdrawal and plugin shutdown wait for its bounded completion and save the actual receipt or unknown outcome. A saved report does not establish that Codex created a PR, or that a fix was merged or released.

`muse_skill_evolution` with `action:feedback` lists retained candidates, validation rejections and receipts without the source evidence excerpts. It provides no retry action.

## Configuration and model use

The bundle patch activates the plugin in the Host. `enabled`, `autoApplyOwned` and `autoSubmitFeedback` default to `true`. Set `enabled:false` to stop new review collection, new inbox submissions and Skill writes; set `autoApplyOwned:false` to retain Skill proposals for explicit application. Set `autoSubmitFeedback:false` to retain product candidates locally. `maxFeedbackPerDay:4` limits attempted inbox submissions by UTC date; zero prevents submissions. Disabled or limited candidates remain retained and are not automatically sent later. `home` and `skillsRoot` override the private locations.

Defaults are `idleMs:600000`, `minToolCalls:3`, `maxReviewsPerDay:4` counted by UTC date, `inputMaxChars:24000`, `outputMaxTokens:4096`, `requestTimeoutMs:120000`, `maxSkills:20`, `maxRuns:1000`, `maxProposals:200`, `maxVersions:1000`, `descriptionMaxChars:300`, `contentMaxChars:8000` and `toolOutputMaxChars:24000`. Configuration is schema-validated at activation. Model reviews consume the selected provider's normal usage and may incur its usual charges. Set `maxReviewsPerDay:0` to prevent review requests while retaining collected work. Existing queued work resumes when a later eligible activity schedules it; there is no daily polling job.

## Model Experience

The management tool returns structured local status, proposal and version receipts through normal logged execution. The reviewer receives bounded redacted task text, tool outcome summaries and the available Skill catalog. Its model-visible input and output are recorded in its own Session. Newly committed Skills become discoverable through the native provider; the next task can load their complete content with `skill`.

Model review can still propose an unsuitable procedure or an incorrect product report. Versioning and ownership checks protect files; they do not establish the semantic quality of learned advice. Keyless fixtures verify execution, logging, permissions, discovery and rollback. They do not establish real-provider creative quality.

## Development

Use a built checkout with the matching Host peers. Run `pnpm --dir third_party/plugins/muse-skill-evolution test` for focused checks and `pnpm --dir third_party/plugins/muse-skill-evolution run package -- --out /absolute/output` to create the archive. Packaging uses private staging and includes source hashes, exact Host identity, Apache attribution and the retained Bot revision. It does not read a live Muse home.
