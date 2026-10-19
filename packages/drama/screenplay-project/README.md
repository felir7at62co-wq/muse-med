---
description: "Source-backed screenplay projects with configurable review guidance and recoverable character knowledge."
kind: "package-reference"
---

# @deepseek-ai/dsh-screenplay-project

English | [中文](README.zh.md)

## Summary

`screenplay_project` imports immutable novel text or timed speech, assigns source-unit identities, and renders structured episodes. Independent review is the default; deployments can select sequential self-check or autonomous advisory review. Advisory review lets the Agent adopt a candidate without prior approval while preserving source, version and authorization checks. Adoption advances one episode at a time; subsequent work reads the adopted state rather than a model-written progress summary.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

### When to choose it

Use this tool for source-backed novel, video, or trope adaptation projects that need saved episode versions and recovery after interruption. Freeform writing without episode acceptance can use the existing writing skills directly.

### Minimal configuration

In a `dsh` profile composition that already mounts `fs`, `tools`, `attachments`, and `llm`, add:

```yaml
- id: screenplay-project
  name: '@deepseek-ai/dsh-screenplay-project'
  config: {}
```

| Field | Default | Meaning |
|---|---|---|
| `reviewMode` | `independent` | `self-check` requires sequential same-session review; `advisory` lets the Agent decide when to review new and existing projects |
| `refinementMode` | `disabled` | `source-preserving-v1` exposes explicit creation refinement forks; disabled retains the historical model schema |
| `storyFaithfulMode` | `disabled` | `story-faithful-v2` exposes work-scoped video creation with review guidance selected by `reviewMode` |
| `maxSourceBytes` | `16777216` | Maximum original file bytes |
| `maxProjectBytes` | `33554432` | Maximum project artifact bytes |
| `maxReadUnits` | `100` | Maximum source units, facts, or drafted scene files in one operation |
| `maxReadBytes` | `65536` | Maximum encoded source-window or individual scene-file bytes |
| `maxFactBatch` | `20` | Maximum facts proposed or independently reviewed in one atomic mutation; rejection reports the requested count and configured range |

The [configuration catalog](../../../docs/config-catalog.md#deepseek-aidsh-screenplay-project) owns accepted configuration fields. These budgets do not fix the number of episodes or chapters.

### Review policies

`reviewMode: advisory` applies to new and existing projects. It uses `review_policy: advisory` without changing the historical `review_mode` or review-context digests. Reading an existing project applies the policy in memory; the next successful project mutation persists it. A read-only operation does not rewrite the file or its historical review records. Once persisted, the advisory policy remains effective under later `independent` or `self-check` configuration; configuration does not convert the project back to strict review.

The Agent decides whether to record `review_fact`, `review_facts` or candidate `review`. New advisory records retain the real actor, time, decision and reason with `kind: advisory`; they do not claim independent review or manufactured A/B/C evidence. Unreviewed or rejected facts can be staged, and `commit` can adopt a current candidate without a prior approval. `export`, Word and presentation consumers use that adopted version; adoption does not mean that a review passed. `review_advisory` reports pending and rejected fact/candidate counts with guidance; it does not fabricate approvals. Story inventories, `story_notes` and C semantic reports are optional in advisory mode; supplied records still undergo source, location, identity and digest validation.

Source files, source locations, candidate digests, current revisions, episode order and genuine user authorization remain validated. Advisory review does not permit invented evidence, altered originals, stale writes or expansion of adaptation permission. Historical review identities remain verifiable.

The independent-review and A/B/C prerequisites below apply only to projects without `review_policy: advisory` under strict `independent` or `self-check` configuration. They are not mandatory approval steps in an advisory deployment. Muse selects advisory review; see the [migration guide](../../../docs/upgrade-guide/v0.2.1-alpha.1/muse-screenplay-advisory/guide.md).

### Story-faithful video creation

An explicitly configured creation deployment uses `storyFaithfulMode: story-faithful-v2` with `reviewMode: self-check` or `advisory` and trusted `video_inspect` evidence. New video-to-script work selects this story-faithful goal; verbatim transcript and subtitle requests keep the ordinary strict path. `init_story_faithful` binds the latest real user request, actual video file versions, per-video episode associations, episode scope and bounded supplement categories. A single video and single scoped episode resolve that association automatically; multiple videos or episodes need explicit associations. The model checks the user's intended work and scope; quote authenticity alone does not establish semantic consent. A grant covers ordinary emotional, colloquial dialogue, reaction and filmable-expression improvements within that work without requesting permission for each line. Changed key events, action results, relationships, stance, motivation, conditions, causality or reveal order require a new explicit scope. Adaptation mode and reasons cannot grant that scope. V2 `status` also returns `story_policy.authorization_sha256`, computed by the Host from the actual authorization; use that value for supplemental facts rather than recreating the digest.

Writers prepare current-episode source facts and a story inventory directly from the original work, without creating a full verbatim screenplay first. Five inventory dimensions cover events, action results, emotion/conflict, relationship/stance and causality/reveals; a genuinely inapplicable dimension needs a reason. Every item retains reviewed source facts and real source-unit locations, critical/unknown status, causal dependencies and any essential listeners. Inventory creation, actual source/inventory rereads and review occur in separate model steps. `story_notes` maps every item to actual output scene/beat/text, accounts for all episode source facts with retention, merging or non-story omission reasons, records source-to-output changes, scene arrangements and editor-comment dispositions. New work uses source locations without invented before text. An actual modified input retains a bounded exact candidate snapshot; repeated revisions do not recursively embed earlier snapshots.

Story-faithful candidates may split or merge scenes and change source expression channels while retaining essential actions, actual attribution, narrative layers and character knowledge. Original ASR, observation units and source facts remain unchanged. Authorized short OS or reaction/dialogue facts remain `origin: adaptation` and bind `story_supplement` to the actual grant and episode context; an author-analysis source is not relabeled as a character thought. Key public speech cannot become private OS while its listeners still acquire its meaning. Source actions retain the original actor and actual frame evidence; source speech retains textual evidence.

An `action_result` item can contain a result announced through speech. Critical items referencing action facts must retain an action in their output mappings; speech-only results may use correctly attributed dialogue or audible VO without adding an action. Other source references, essential-action coverage and later semantic review remain required.

`video_inspect` first probes actual duration and plans the complete interval, then creates real sampled-frame manifests. The Host verifies successful tool results, every outer PTC result and a later successful image-capable model request containing the frames. Model-written metadata or `verified_readback` flags cannot establish this evidence. Every probed window of the episode's entire associated original video needs actual image evidence; model-defined coverage intervals cannot crop away the remaining duration. This version does not split one original video into multiple episode-specific crop ranges. Sampled frames do not establish continuous viewing. V2 can leave noncritical heuristic candidate points unsampled, while critical unknown evidence remains pending. Ordinary strict/V1 video coverage retains its existing deferred-point requirements. New source/frame versions or relevant source facts supersede an unaccepted inventory; previously accepted episode scopes retain their bound versions when later episodes append sources. Status reports pending evidence; an interrupted current episode can re-inspect, reread and submit a new inventory. Withdrawing an episode source fact retires inventories covering its source units. Unused superseded inventories remain readable with valid withdrawal and original review records, but cannot be approved or staged again. A candidate that references a fact in its body or story-change notes requires a fork before withdrawal.

Under strict self-check, candidate A writing is followed by B actual rereads of the complete current candidate, its inventory, original episode sources and necessary accepted foreknowledge. A later C model step submits `semantic_report`: reconstructed events, emotion/conflict, relationships/stance, causality/reveals and exact source/output judgments for every item. Host-generated policy, inventory, candidate and episode-scope hashes bind the report and final approval. Any declared story-preservation deviation or unverified judgment blocks approval. Faithful expression edits belong in `story_notes.changes`; preserved source-identity and sampling limits belong in `story_notes.unresolved` and the relevant check explanations. These notes cannot excuse uncertainty about a required event, relationship, condition, action result or reveal. Machines check references, locations, digests, sequential evidence and declared deviations; artistic and story meaning remain model judgments, not automated semantic detection. Commit waits for the C tool and every outer program to succeed; a review and commit inside one unfinished PTC program cannot bypass that requirement.

`fork_story_faithful` explicitly creates a new branch from an ordinary original project, preserves its old accepted prefix and review identities, retains exact original adaptation facts without granting new supplementation authority, links legacy source indexes to the authorized videos and saves any selected actual input candidates. It neither requires a complete verbatim baseline nor changes the original project. Existing `source-preserving-v1` branches cannot directly change strategy; start V2 from the preserved original work instead. Export keeps the screenplay body pure and delivers a separate final-bound modification report. Formal export, Word and presentation consumers must run `validateAcceptedStoryEvidence` with trusted inspection and, under strict self-check, successful C-log validators before using `acceptedScripts`. Cold recovery of Host-saved source observations verifies original Session event references and current source bytes before or after episode acceptance, without extracting frames again; missing original logs block verification. Source authorization compares the resolved video path; original manifest paths and receipts remain unchanged, and the source version must still match. Under strict review, retained old independent prefixes keep their original checks and do not require V2 evidence stamps.

### Source-preserving refinement

An explicitly configured creation deployment can set `refinementMode: source-preserving-v1`; this requires live `sessionProjections`. `fork_refinement` names actual baseline candidate IDs, a continuous episode scope, scope instructions, an exact quote from a currently visible real `source: user` message, the model's consent assessment, and an explicit subset of `performance_detail`, `minimal_os`, and `supporting_dialogue`. An empty subset authorizes only source-backed expression and display changes. The Host derives the real session, message, sequence and message digest; attachment, tool, assistant and third-party bodies cannot grant permission. Quote matching establishes text authenticity, not the semantics of consent. The model must check the user's own intent and each category against the original request; one scoped grant can be reused within that project. A blocking legacy question tool's plain result is insufficient human evidence; use a direct user reply. Adaptation mode and an adaptation reason never grant supplementation.

The fork preserves the original project and source files, original fact content, mode, instructions and historical review kind. It stores complete actual input candidate snapshots and hashes the bounded policy. This version refines beats within unchanged scene metadata: it refuses changes to scene count, place, time, characters, narrative layer and transitions. The actual baseline source IDs, coverage windows and required expressions remain unchanged. Original source facts retain their unique first-appearance order, expression channels, actors, audibility, witnesses and knowledge conditions; duplicate identical expressions can collapse. These structural checks do not establish unchanged dramatic meaning. New events, relationships, motives, key lines and reveal-order changes require a separately confirmed workflow.

A bounded supplemental fact retains `origin: adaptation`, a reason, original episode-specific baseline source anchors, and `supplemental` category, policy and authorization digests. Performance details are actor-attributed action facts; minimal OS is that actor's thought; supporting dialogue is that actor's speech. The original source fact is never relabeled. Original author analysis stays in its original expression while an explicitly authorized actor thought may be a separate adaptation fact. Managed video conversion keeps its normal source-only requirements; only an explicit, valid refinement candidate can use its bounded supplement exception. Refinement writes are refused in disabled deployments.

Each refinement `stage` or `stage_files` supplies `modification_notes`: located before and after beat text with reasons, editor comments marked adopted, partial, not adopted or unknown, unresolved and unhandled work, and limited semantic and visual check ranges. Every changed baseline beat needs a before location, every changed output beat an after location; false text and empty templates are refused. Visual claims name actual image units in the input/output scope. The Host derives input/output version references, content digest, supplemental origins and machine-check ranges before hashing the full candidate. Same-session candidate rereads include the complete baseline and the union of both versions' facts, prerequisites and source windows; historical inherited reviews retain their original context hash.

An optional action `sync_with` names a 1-based adjacent speech beat in the same scene, with `synchrony_reason`. Only a valid explicit refinement candidate can use it. The renderer retains action facts and ordered character-knowledge updates, displays the action once in the same actor's speech parentheses, and preserves both channels in the source-line map. It never turns action into dialogue or invents an OS/VO channel. `rendered.script` and accepted screenplay Markdown remain pure script; optional `modification_notes` is a separate report. `export` writes `episode-<episode>-<candidate>.modification-notes.md` beside the script and source sidecar, with exact report filename and digest. The fixed `《修改说明》` names the actual final candidate hash, baseline, scope, changes, comments, supplemental grant and outstanding checks; stage-time limited checks and the later real version review remain distinct. Read, review, load, acceptance and delivery reject stale content, policy or notes. Reports use one canonical trailing newline.

### Project operations

Strict creation projects can use `reviewMode: self-check`; this requires live `sessionProjections`. `init` stores `review_mode: self-check` from deployment configuration, never from model arguments. Existing projects with omitted mode remain independent in that strict deployment; an advisory deployment instead applies the policy above. In self-check projects, the following independent-review instructions apply to historical independent records; new facts and candidates use the original session's explicitly recorded self-check. A writing step produces the fact or candidate. A later model step rereads every required current source unit and complete fact or candidate with `read_source`, `read_fact`, `list_facts`, or `read_candidate`. The next model step makes the review decision. Reads can be batched within one step; different `run_code` calls in the same model reply do not create another step. Each successful `review_facts` batch advances the project revision. Before reviewing another batch, reread the current sources and remaining facts in a new model step, then review in the next; changing `expected_revision` in one program cannot reuse earlier reads. A later failed call does not roll back earlier successful batches. Self-check never represents independent review.

Self-check reads forward their canonical text and images into the next model context even when a PTC program does not print its intermediate values. Only successful final reads under a successful outer program supply evidence. Exact read text and attachment references must remain in model history. Once the images have reached a successful model response, later logged image offloading may retain that read evidence; images offloaded before any successful observation supply no evidence. Reviews bind the current project revision and bytes, immutable fact or candidate digest, complete referenced facts including knowledge prerequisites, source anchors and declared coverage windows, and host step sequences. Partial windows supply only returned entries; changed files, stale revisions, missing rereads, same-step decisions, blocked or replaced reads and failed outer programs are refused. A restart or discarded context requires new rereads. Review records retain the real actor, `kind: self-check`, and their evidence; accepted status and export results disclose that kind. Existing omitted review kinds retain independent actor checks. Replays validate content bindings and step ordering; evidence project identities and revisions identify the original review location and are retained across forks rather than compared with the branch's reset revision.

Video conversion initializes with `workflow: video_to_screenplay`. Before drafting an episode, import and independently review its visual and speech facts. Both staging methods require `coverage.windows` identifying the complete episode source ranges and `coverage.required_beats` mapping each approved source fact to action, dialogue, OS or VO. Every approved fact in those ranges must appear in the inventory and actual corresponding beats; unresolved facts block staging. Visual action facts require frame references in the declared ranges; named action actors require matching reviewed attribution. Action facts remain action beats even when they also cite checked text; they cannot supply dialogue or OS/VO. Dialogue and OS/VO require checked text in those ranges, not a frame reference alone. Default source conversion rejects adaptation additions; the separately authorized refinement above provides the only bounded exception.

A video candidate without action beats needs an independent `zero_action_reason` on approval, recording the actual source recheck. Verified dialogue-only material can pass; adding unsupported action is refused. Coverage travels with the candidate digest, scene-file assembly, acceptance and export. Recovery uses the saved source windows and reviews. Imported video metadata retains the sampled interval, requested and decoded timecodes, and outstanding adaptive observations. A window may declare an episode `interval` within its video manifest; omitted intervals conservatively use the complete manifest scope. Only deferred points inside that episode interval block staging, approval, acceptance and export until a source window includes a supplemental sample requested at that point from the same video version. Sampled intervals describe inspection scope, never continuous visual coverage; absent interval metadata in older manifests remains unspecified. Projects without this optional workflow retain their existing behavior. These checks cover the prepared inventory; independent review still checks unclassified events, emotion, identity and actual OS/VO in the original material.

`propose_facts` submits a bounded list of individually attributed facts; `review_facts` carries an independent decision and reason for every fact. Either operation publishes once and advances the revision once. An empty, over-budget, invalid or duplicate-review batch publishes nothing. Read and classify all source context before reviewing; batching does not waive semantic review. Single-fact operations remain available.


Mount this plugin with `fs`, `tools`, `attachments`, and `llm`; a sandboxing filesystem also requires `sandboxPolicy`. Mutations use the initiating session's standing policy. `project` names one JSON artifact, not a directory. `init` records the user's direction and faithful or adaptation mode. `import_source` accepts UTF-8 text, native `audio_transcribe` segment arrays, account responses containing `segments`, or actual `video_inspect` sampled-frame manifests. Exact original bytes determine the source SHA-256. Unit numbering starts at one and retains original line or segment order; available speech times and speaker IDs survive import.

Facts distinguish actions, speech, character thoughts, and author analysis. Exact quoted substrings must occur in their referenced units. Adaptation facts require the project's adaptation mode and an explicit reason, or the explicitly authorized bounded refinement described above. Frame reads return the original verified image attachments beside timecodes, require an image-capable route, and reject a changed video original. A different session reviews their meaning, attribution, and narrative layer. `stage` accepts complete scenes with typed action, dialogue, OS, or VO beats referring to approved facts. OS requires the same character's thought; author analysis is unassigned commentary. Continuous scenes retain place, time and layer. Entering a flashback and returning from it require explicit transitions; `return_present` also marks a return from a dream or imagined scene.

Character knowledge derives from accepted beats. Declared witnesses can see an action or hear dialogue. OS and audience-only VO have no on-scene witnesses; actual offscreen speech, such as a phone call or played voice message, declares `audible_in_scene: true` and the characters who hear it in `witnesses`. That declaration requires attributed, approved speech facts and cannot make thoughts or author analysis audible. Omitted or false audibility retains the existing audience-only behavior. Present, flashback, dream, and imagined knowledge remain separate. These records describe acquired information and make no universal claim that every character is unaware of unspecified information. Cross-layer recollection or an altered event needs a separately reviewed fact in the destination layer.

Scene `characters` and beat `actor` retain exact undecorated names. `voice_only_characters` lists participants heard only through VO in that scene; the renderer labels those names with `（VO）` in the character line. Repeated names, names outside `characters`, participants without a VO beat, and participants attributed other beat kinds are refused. Omission preserves existing character lines; labeling does not itself grant listeners knowledge.

Source IDs are opaque: copy `status.sources[].id` unchanged, including its `:text`, `:transcript`, or `:video_inspection` suffix, and select by the returned kind and path. An omitted suffix is rejected with matching complete IDs; the tool never silently selects one, including when identical bytes have multiple source kinds. Read units use `id` and `text`; fact review state uses `review.decision`, with an absent review meaning unreviewed.

`list_facts` restores complete facts and their reviews in original order after an interrupted writer. It fits the requested prefix within `maxReadBytes` and returns `next` for continuation; callers follow that offset until null rather than inferring completion from their requested count. One fact that exceeds the byte budget fails without truncation. `read_candidate` returns the exact structured version, rendered script, and referenced facts for review. Review binds the application-issued candidate identity and SHA-256. Only independently approved next episodes can be committed. `status` returns the next episode and accepted versions for recovery. `export` generates the accepted Markdown and source map, including renderer-assigned line numbers and host-assigned timestamps. New candidates bind their source IDs into their content digest, so later source imports cannot change accepted exports. Legacy candidates retain their original digest and original all-sources export behavior. Existing canonical legacy sidecars can retain an earlier verified source prefix after later imports; all rendered references must remain covered and all other bytes must match. Legacy source inventories were not digest-bound, so unrelated trailing-source removal cannot be distinguished from a historical shorter inventory. Repeating export preserves identical outputs and rejects edited files; an interrupted export can be completed by repeating the same command.

-----

`stage_files` assembles an episode from ordered JSON files containing one complete structured scene each. Invalid UTF-8 or JSON reports the file path; invalid scene fields report that path and the affected field locations. Missing fields are rejected without defaults or partial candidate publication. It verifies every file exists, parses its fields, and checks file versions again before publishing. File count uses `maxReadUnits`; each file uses `maxReadBytes`. The resulting candidate contains an immutable copy of the scenes and follows the same attribution and independent-review rules as `stage`. Writers can save scenes in separate bounded requests and resume those files after output truncation without regenerating one large tool argument. Dialogue facts retain individual conversational turns; combining answers across another character's question requires reviewer rejection.

`fork_project` starts a revision in a new destination file before a chosen accepted episode, or before the next episode. It retains the original direction, verified sources, fact history and accepted ancestors; it records the exact parent file digest and revision. Later episodes must be rewritten and independently reviewed in order. The original project and exports remain unchanged, and an existing destination is refused.

`withdraw_fact` independently withdraws an erroneous approved fact while retaining its original review. Withdrawn facts remain readable but cannot support new scenes. A fact already cited by any saved candidate, including its knowledge prerequisites, requires a fork before the earliest affected episode; the original candidate and export remain readable in their original project. The correcting writer proposes a replacement fact for independent review. Withdrawal records are host-owned, reject changes by the original proposer, and cannot alter candidate history. In explicit self-check projects, the original proposer can withdraw only a fact whose original approval is also self-check: reread its current approved record and sources in a model step after approval, then withdraw in a later model step with a correction reason. This retains the original approval and records a separate self-check withdrawal. The existing fork requirement for referenced facts remains; replacement facts receive new identities and a new review. Independent approvals and withdrawals cannot use this exception.

Rendering uses the accepted episode number and scene order, source-verified interior/exterior settings, and explicit Chinese narrative-layer labels. Omitted settings display as unresolved; the program does not infer them from a place name. A writer may mark one source-backed suspense beat in the final scene with `hook`; semantic review checks its evidence. Source-index line numbers include these headings and the marker. This projection leaves earlier exported files unchanged.

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

Each mutation replaces one validated project file atomically through the mounted filesystem with a file-version guard and the caller's expected revision. A write rejected for cancellation or a stale file version cannot advance the persisted project. An outer program failure does not undo earlier successful mutations; recover their actual state with `status`. A single-entry content-hash cache reuses validated project data, accepted character knowledge and source indexes on repeated reads. Every call still reads and hashes project and source bytes, checks video versions, and retains the filesystem compare-and-swap guard; cached results are copied before use. Accepted-history replay builds fact and candidate indexes once instead of repeatedly searching complete arrays. Imported originals are rehashed before operations; changed source files or inconsistent source indexes fail. Candidate content digests are checked when loading the artifact. Rejected and superseded candidates remain available, and existing accepted versions are never overwritten. Project format version 1 is independent of released Session generations; commands and canonical results use the existing logged tool events.

Oversized reads fail and require a smaller window instead of silently truncating text. Failed scene assembly reports the resolved file path; voice-only registration reports the scene and required character fields. Story mapping failures identify the item, source fact and listeners, and incomplete change notes identify the scene and beat. These diagnostics do not relax validation or publish partial candidates.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [Filesystem subsystem](../../../docs/subsystems/filesystem.md) — Guarded reads and atomic writes.
- [Tools subsystem](../../../docs/subsystems/tools.md) — Canonical logged command results.
- [Speech transcription](../tool-audio-transcribe/README.md) — Timed source artifacts and durable jobs.

<a id="model-experience"></a>
## Model Experience

### The `screenplay_project` tool

#### What the model sees

The [tool catalog](../../../docs/tool-catalog.md#deepseek-aidsh-screenplay-project) owns the operation schemas and description. Canonical results contain bounded source windows, application-issued identities and revisions, candidate text, reviews, accepted state, or exported paths. They use the generic persisted tool card. Successful strict V2 approvals project a compact `story-faithful-review-result-v2` receipt into model-visible and durable tool content, binding the candidate identity, content digest, complete review digest, acceptance digest and review revision. This keeps approval matching independent of previews truncated by the spill policy. PTC still returns the full canonical `{revision, candidate, rendered}` value; use `read_candidate` to inspect the complete version. Earlier full-candidate review logs remain verifiable. Both projections require the exact successful review request and every successful enclosing PTC result in the original C step.

#### Token effect

The mounted schema adds a fixed request cost. Source windows are bounded by configuration; candidate reads include complete episode content and its referenced facts. Calls add results without inserting the complete source into every request. Strict self-check rereads also append canonical context, increasing the next request by the selected read content. Advisory results add review advice without requiring another model step.

#### KV Cache effect

Results append to conversation history. Changing the schema or description changes the reusable request prefix; project mutations do not rewrite earlier messages.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

Mechanical checks still need semantic review and appropriate allocation budgets.

- **Semantic review** — exact quote binding and attribution types do not establish that a paraphrase preserves meaning. The reviewer must inspect originals, the complete candidate, and approved adaptation direction; same-model self-check and advisory judgment retain the limitations of same-model review. Speaker separation IDs alone do not establish a character's name.
- **Artifact authority** — the validated project is the continuation record for this tool. Review evidence is not a cryptographic signature, and direct external edits are not reviews; general filesystem access remains available to the agent, and the tool cannot make arbitrary files immutable against that access.
- **Storage scale** — originals and episode versions share one guarded JSON artifact. The default artifact limit remains 32 MiB; writes and changed-project validation still traverse the full artifact, and source hashing remains proportional to original bytes. The bounded read cache does not make episode capacity unlimited. Very large projects require an explicitly increased allocation budget; this provider does not yet shard its history.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
