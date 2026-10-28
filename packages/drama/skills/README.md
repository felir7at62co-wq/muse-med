---
description: "Search historical drama assets, maintain project state, and assemble confirmed whole-drama deliveries with portable skill resources."
kind: "package-reference"
---

# @deepseek-ai/dsh-drama-skills

English | [中文](README.zh.md)

Shot writing keeps a per-episode source-to-shot record for dialogue, speakers, actions, and performance details. The agent reads the confirmed project aspect ratio and style, uses the conversation's selected video model and resolution, calculates each package duration from its shots, and checks the complete batch before parallel submission.

## Summary

Create and review drama scripts, reuse assets, maintain project state, prepare editable drafts, render episodes, assemble whole-drama deliveries, and claim newly released scripts from the Jubian pool. The entry points are the maintained `skills/*/SKILL.md` files selected for the current task. Python scripts and necessary static resources travel together, including the renderer's ending effect and ending sound. User projects, credentials, per-project media, and local environments do not.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

The shot-writing skill metadata identifies creation, revision and source-to-shot requests for either confirmed 9:16 live-action projects or confirmed 16:9 3D CG projects. Confirm existing project settings when the medium or aspect ratio is unknown; skill selection does not change those settings or apply shot-writing guidance to ordinary scene-script formatting.

The [first-pass production workflow](skills/tweet-drama-core/references/first-pass-production.md) establishes the same source-backed action and prop requirements for preparation and media review. It covers physical support stages, asset suitability, persistent scene states, actual prepared prompts and scoped evidence before paid repair. It does not guarantee a stochastic generator's first result or replace actual listening and visual review.

For disputed motion, the inspection skill's `video_review_evidence.py` creates a new local evidence directory containing the continuous interval with available audio, contact sheets with at most six frames, and source/evidence hashes. It requires Pillow and local FFmpeg/FFprobe, preserves existing files, makes no network requests and always leaves media review pending. See its [I/O rules](skills/tweet-drama-project-inspect/references/io-contract.md#motion-evidence-extraction).

The [shared video-quality workflow](skills/tweet-drama-core/references/production-quality.md) covers performance timing, scene and package continuity, exact prepared prompts, evidence-based media review and scoped repairs across projects. Shot scripts can declare concurrent or sequential action, speech and reaction budgets using the [compiler's performance fields](../tool-shot-script/README.md#script-and-timing). These checks and instructions do not establish generated visual or audio quality without reviewing the actual result.

The [project inspection skill](skills/tweet-drama-project-inspect/SKILL.md) provides `inspect_evidence.py <project>` as a read-only local diagnostic. It checks receipt source hashes and raw transcription outputs for reuse candidates and flags explicit delivery claims that still admit unchecked audio. Its JSON output is evidence for review, not media acceptance, live provider health or a new paid-operation gate; it changes no project files and makes no network requests.

Coverage audit and speech preflight share recognition of ordinary parenthetical performance cues for source-listed characters in both source and shot prefixes. Addressed question directions can remain actions when the same actor's separate dialogue immediately follows; quoted content and identity or voice ambiguities remain checked. Complete source text, exact speaker and speech, and OS/VO checks still apply. Existing `shots/EP13-9x16.md` names can be mapped without creating renamed copies. [Existing-project migration](skills/tweet-drama-core/references/io-contract.md#existing-project-migration) uses `accept` and `gate` with `--episode-only` for one explicit in-scope episode without changing the project scope or dropping that episode's evidence checks. Default prefix checks remain unchanged; absent historical acceptance does not require regenerating finished videos.

For mapping authors, `episode_coverage.py <project> source-lines <ID>` returns every nonempty source line using that same contextual classifier. Pending rows remain visible, and the read-only command does not replace maps, assign shots or approve coverage. Use its rows rather than standalone internal helper results, then review shot membership and run acceptance again after mapping changes.

Use `episode_coverage.py <project> source-scan` before authoring episodes to check source integrity and expose unresolved notation throughout the declared assignment. It returns exact episode/line diagnostics without changing source, scope, mappings or acceptance. The same preparation requirements apply across genres; source-backed acceptance criteria precede the first submission and remain unchanged during media review.

Established identities use structural performance notation, including balanced or nested groups, without a genre or action-word dictionary. Cast labels have several supported spellings; absent a roster, plain unannotated dialogue can establish an identity. Separate explicit OS/VO markers retain voice identity beside performance notes. Source and shot checks share this recognition without rewriting either file. Marked actions recognize paired, supported object sounds with sound suffixes or physical impact context; remaining speech cues, quotes or colon clauses stay pending. Terminal delivery cues require the next dialogue to belong to the same declared actor, and exact editorial markers retain heading rows. Pending diagnostics distinguish unsupported syntax or metadata from identity, period, voice, quotation or adjacent-speaker ambiguity; repair gaps without editing the original to fit the parser, substituting manual notes for acceptance or offering a bypass. See the [source classification rules](skills/tweet-drama-core/references/io-contract.md#episode-work-scope-and-coverage).

The [background-render skill](skills/tweet-drama-background-render/SKILL.md#剧变视频转高清) guides authorized SeedVR2 / RunningHub upscaling. It defaults to the latest generated result within the requested episode and package, uses its current processed video, submits once and observes the accepted task in the background. A successful matching HD result with a current output URL is adopted directly; visual, audio and metadata inspection are optional when separately requested. Existing explicit HD authorization does not require per-clip confirmation, and a resolution hint alone does not authorize payment. Its [story-driven BGM guidance](skills/tweet-drama-background-render/references/story-bgm-selection.md) derives musical intent from the adopted video's scene turns, preserves existing source music and user feedback, queries candidates with `bgm_match.story`, and distinguishes title/tag evidence from actual excerpt and mix audition.

Resolve this package's `package.json`, then give its sibling `skills` directory to the existing skill loader. This resource package registers no Service, Tool, or plugin. Installing the npm package alone does not activate its skills. Reference images can come from user files or existing web search and fetch tools; the skill catalog includes no Xiaohongshu client or service setup workflow.

The [16:9 3D shot-writing skill](skills/shot-script-creator-16-9-3d/SKILL.md) and [9:16 live-action shot-writing skill](skills/shot-script-creator-9-16/SKILL.md) provide the user-selected camera language, subject-state tracking and creative examples. Their [director-text examples](skills/tweet-drama-early-shot-script/references/director-format.md) illustrate visible subjects, identity and speech without compiler calls or asset-manifest registration. Muse loads the applicable authoring skill before writing each episode and uses native Jubian card preview, save and readback. Conversation video choices and current tool schemas govern operations; loading a skill does not change the project's medium or canvas. Package size follows story, performance and the selected model's verified capacity, without a fixed fifteen-second density rule.

Choose the relevant skill for the task and read it before invoking its scripts. Keep the skill directories adjacent: draft, render, and delivery share core's video-ban checks. Use Python 3.11 or newer. Image helpers require Pillow, document helpers require python-docx, and draft generation requires pyJianYingDraft; each skill owns its other optional dependencies. Draft generation rejects an existing draft directory rather than deleting it; use a distinct `name_prefix` for each candidate, without path separators or Windows-reserved characters. No Python interpreter, dependency environment, or FFmpeg binary is bundled.

The bundled [3D anime asset skill](skills/anime-3d-assets/SKILL.md) guides character, scene and prop design for short dramas with a default next-generation CG and physically based PBR prefix. Its [style guidance](skills/anime-3d-assets/references/design-and-prompts.md) supports natural-language art direction and optional genre modifiers; asset layouts follow the consuming persona and explicit user requirements. Bundled images and local record helpers are optional resources, not generation prerequisites. Story, emotional impact and visual appeal guide both 3D and live-action work; fixed facial descriptions, prompt ordering, aesthetic scores and separate review reports are not required. Existing project state, payment limits and confirmed casting remain authoritative.

The [project bible skill](skills/tweet-drama-project-bible/SKILL.md) starts with one grouped question for missing creative and live SD model choices, reuses provided answers, and stores reviewed updates through drama_project. The medium question offers photorealistic, 3D and a custom entry; the user's custom text remains in the saved style. Its [audience and screen-style guidance](skills/tweet-drama-project-bible/references/audience-and-style.md) connects the actual script and user-approved references with character appeal, relationship tension, emotional payoff and art direction. Creative hypotheses remain distinct from market evidence, without a fixed analysis template, another report or another model round. Generation resolution and delivery dimensions remain separate; optional character voice guidance accompanies speaker checks and actual audio review. Wiki references guide writing without blocking startup. Existing projects retain stable package/storyboard identities, completed tasks and version records.

The Agent prepares character, scene and prop requirements from the script and confirmed project instructions. The [visual review skill](skills/tweet-drama-asset-vision-check/SKILL.md) checks candidates against the current explicit request and `project_bible.style`; preset names, reference-image media and model names do not supply a default style. Review checks the agreed mood as well as identity and material quality. Live-action fantasy creatures may use cinematic effects; nonhuman assets retain their scripted species and scale without adopting a human face-board layout.

The [asset-matching skill](skills/tweet-drama-shot-asset-match/SKILL.md) separates a stable character and parent asset from an adopted image version. New costume or state images reuse the approved face reference explicitly, while source records retain the material ID, URL and review evidence. A candidate does not automatically replace approved casting. Conflicting saved storyboard image references need explicit source selection, not another paid generation; ordinary visual uncertainty uses a grouped preview, not a new approval tool. Shared references reduce avoidable identity changes but do not guarantee that a generator preserves a face.

Draft creation reads `drama_draft_dir` from local Settings, asks for a missing or invalid editor root, and saves the user-supplied path through the same tool. Request JSON, timeline JSON and SRT accept UTF-8 with or without a BOM while retaining original input bytes. Subtitle alignment defaults to completed Muse cloud receipts with word timings and matching source SHA-256. Fully matched lines retain their measured spans; invalid, overlapping or out-of-clip anchors fail instead of being retimed as aligned. Draft subtitle import also keeps cue times and rejects long lines that lack separately aligned splits, as defined by the [input requirements](skills/tweet-drama-draft-build/references/io-contract.md). Explicit offline recognition requires separately provisioned dependencies and a model.

The [draft skill](skills/tweet-drama-draft-build/SKILL.md) selects Windows `audio_mode: "embedded"` through the same draft tool to preserve video audio with independent BGM; omitted modes retain independent-audio compatibility. The bundled aa剪映 adapter uses the installed native CLI, with capability checks and explicit failure rather than an alternate renderer. [Cloud subtitle guidance](skills/tweet-drama-draft-build/references/cloud-subtitles.md) reuses matching receipts and measured timestamps; explicit spelling corrections in derived files preserve word times and raw evidence. Creating a draft does not itself require another recognition request or an encoded preview. Windows embedded mode adds an ending only for `9:16`, stops at the body end for `16:9`, and records native frame placement differences separately from unchanged source files.

Independent-audio draft delivery follows the explicit project visual medium: `animation_3d` ends at the body and adds no watermark or ending tracks; `photorealistic` adds a two-second editable freeze and the editable white, borderless “内容由AI生成” text at the lower right throughout. Missing legacy types preserve the latter behavior with a warning; source-media markings are not removed. The [draft input requirements](skills/tweet-drama-draft-build/references/io-contract.md) define `timeline.body_end` for inputs that already include an ending, avoiding a second tail. Existing draft directories remain unchanged. Track checks warn about possible duplicate dialogue when body-video volume is nonzero or unspecified beside an independent dialogue track; the candidate and editable dialogue remain available. Windows decoder startup failures with WinError 2 or 5 and no filename append the selected executable path to the original error message.

Project `delivery.draft_style` stores editor-unit subtitle and watermark choices independently of formal-render pixels. A saved timeline section wins as a whole; omitted fields retain draft defaults. Font references and explicit fallbacks remain visible in `muse-review.json`, without font downloads or license claims. The ending overlay is muted while independent ending sound remains; it is a video layer, not a native parameterized editor effect. See the [draft input requirements](skills/tweet-drama-draft-build/references/io-contract.md).

For the independent-audio path, when every body source is a video whose selected presentation timestamps verify constant cadence at the project fps, draft generation places shared shot boundaries and tail holds on whole project frames. The body, ending and AI notice use that same target clock; evidence retains the original body clock and its rounding difference. Source files, dialogue, music and subtitle times are not rewritten. Unsupported cadence, insufficient evidence, a non-video body source or a zero-frame shot keeps the existing microsecond path with a review warning. Saved-file verification does not replace opening, reopening and exporting in Jianying.

The [voice reference skill](skills/tweet-drama-voice-continuity/SKILL.md) reuses each character's approved sample across costume versions. When none exists, it extracts a reviewed, clear single-speaker interval from that character's first generated video; the default is 2 seconds and the reference limit is 15 seconds. The script preserves the source, refuses an existing output and reports measured duration and hashes; confirming the speaker requires actual listening, with user confirmation when the agent cannot inspect audio. Upload and binding preserve the original storyboard ID. Audio references guide generation but do not guarantee identical timbre across SD outputs.

The packaged `prepare_voice_assets.py` also extracts a complete mix and missing-character candidates after a successful video download, keeps current voice profiles, and resumes by task/source/character/interval identity. Its OS-released lock and atomic manifest merge preserve other samples and track records. Long full mixes are retained for editing; two-second speech references may retain background sound; empty intervals report a gap without guessing speech identity. The voice skill owns the request fields and adoption workflow.

The selected-reference import uses the read-only helpers in `tweet-drama-core/scripts/asset_library`. They use `JUBIAN_ASSET_LIBRARY_ROOT` when set, otherwise `$DSH_HOME/data/jubian-asset-library`, with `~/.dsh` as the home default. Media paths resolve within the current data root. The core `import-library` command archives only the user-selected face/outfit pair into a project, preserves the original library and requires review and traceable user confirmation before paid generation.

Episode coverage and pipeline projection share the [explicit work-scope rules](skills/tweet-drama-core/references/io-contract.md#episode-work-scope-and-coverage). A contributor can finish assigned episodes without manufacturing earlier episodes or claiming the whole story is complete. Scoped splitting preserves collaborators’ rows and files; current source, mapping, and shot hashes still control acceptance. Separate workspaces and artifact merges are supported; simultaneous writes to the same local project are not coordinated.

The [per-episode quality workflow](skills/tweet-drama-core/SKILL.md#逐集生成质量流程) runs the offline `episode_coverage.py <project> preflight <episode> --script <shot-script>` check before card preparation, including single-episode work. It compares ordered speech content, speakers and dialogue versus offscreen delivery, reports omissions and additions, and leaves unsupported source expressions pending. It writes no acceptance record and does not replace mapped action/OS/VO coverage, paid-operation protection, listening or visual review. Input changes require another check of the affected episode. [Prop and action review](skills/tweet-drama-asset-vision-check/SKILL.md#道具与剧情动作适配) compares the selected image's relative scale and structure with its scripted use before generation and checks contact and continuity in the resulting video. Unresolved story-breaking defects prevent overall acceptance even when the user defers repairs. This is agent review guidance; the speech checker does not inspect images or enforce a global paid-tool gate.

Delivery uses its own `assets/template.json` and preserves canonical episode IDs from `01` through `9999`, including distinct `14` and `140` filenames. An explicit `TWEET_DRAMA_TEMPLATE` must be an existing directory; it does not replace the nine directory names or import third-party files. Assembly can delete stale files in its managed output sections. Output inside the project must stay under `delivery`; project ancestors, upstream overlap, and links inside existing output are refused. Reports go to stdout, not a report file; copying is not a SHA256 verification or a complete media QA.

Script-pool claiming uses [the snatch skill](skills/jubian-snatch/SKILL.md). Claiming a script is a real remote write that assigns it to the calling account. Pool reads are paged and report an incomplete read instead of presenting a partial page as the whole pool. A failed or truncated startup baseline aborts before any claim, so the claimable range cannot silently widen. Every claim passes a two-phase local ledger, and a script whose claim was accepted or whose outcome is unknown is never submitted twice. The post-claim read-back counts only a row naming the account as evidence; a script's disappearance from the pool is not.

The shared [action-intent workflow](skills/tweet-drama-core/references/first-pass-production.md#动作依据用途与手部状态) distinguishes performed action from spoken conditions, preserves explicit demonstrations and scripted mistakes, and reconciles hands, object uses and destinations before submission. Maintainers can exercise the [cross-genre cases](tests/fixtures/action-intent-cases.json) in isolated skill tests; their expected checks are review criteria, not an automated semantic or media scorer.

Run the offline migration checks from this package directory:

```sh
npm test
```

-----

The voice continuity skill separates the same character's life periods, reuses the shared project library across Muse accounts, and archives duplicate local candidates after an existing voice is verified. A first authorized video package may generate without a voice reference; extraction supplies subsequent packages rather than creating an additional paid audition.

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Maintenance and packaging</summary>

The maintained source is this directory. The initial inputs are the selected `SKILL.md`, `scripts`, `references`, and relevant tests from the same-named skills under the operator's `.dsh/skills` directory. Only dependencies used by these DSH skills are retained. Installed personal copies remain independent; there is no automatic synchronization.

`package.json#files` lists individual distributable files, not a home-directory tree or a broad directory glob. The package excludes credentials, cookies, caches, logs, virtual environments, executables, user indexes, per-project media, and the third-party template PDF; its only bundled user media are the renderer's two ending resources. Tests stay in source and are not packed. This private, unlicensed resource package has no Cordis entry point or TypeScript project. No runtime invariant companion is published because static skill files have no independently changing runtime observations.

The package includes the complete `anime-3d-assets` resource tree for filesystem skill discovery. Updating source does not synchronize personal skill copies or installed releases.

Release checks compare the actual npm archive with that allowlist; missing, unlisted, or stale resources fail before desktop packaging. Shot prompts and packages are authored by the Agent and checked through native storyboard preparation, without a bundled shot compiler skill.

</details>

<a id="model-experience"></a>
## Model Experience

### Loaded skill instructions

#### What the model sees

Loading a skill adds its maintained `SKILL.md` instructions through the consuming application's skill loader. Search results and script output enter context only when requested. This package registers no tools and makes no model calls by itself. Paid vision-tagging scripts remain explicit maintenance actions; project model specifications and delivery settings remain authoritative.

#### Token effect

Each loaded skill adds its instruction text; requested script output adds result text whose size depends on the operation and project. Installing the resource files alone adds no tokens. The consuming application's skill loader and tool execution path own selection and output limits.

#### KV Cache effect

Loading instructions or returning script output appends context through the consuming application. The resource package does not rewrite earlier messages or control prompt ordering; cache reuse depends on that application's loader and context policy.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- The optional anime request preflight is a read-only helper for existing local record workflows; ordinary asset generation does not require it. It is not a global tool interceptor. It accepts the exact project-style prefix before a positive medium on the same first line and rejects a provided `image_style` other than `anime`. Its limited text rules reject explicit PBR prohibitions and positive photographic-medium instructions while retaining direct photography exclusions and the supplied animation direction. It does not rewrite prompts, validate every tool field, make provider requests, or establish the generated image’s visual quality.
- The current Web profile still needs explicit skill-loader configuration, credential injection, and Python dependency provisioning by its consumer. This package does not change root configuration or claim that the running Web session already uses these resources.
- Draft scripts accept a caller-supplied output directory; they neither locate a teammate's installed Jianying draft root nor pair a rendered MP4 with a verified editable draft automatically.
- The operator explicitly authorized public redistribution of the maintained skill source and the two ending resources. `private: true` and `UNLICENSED` do not grant others a license to modify or redistribute this package; the rights of external Python libraries, fonts, models, and other media remain separate.
- Current DSH drama tools own model catalogs, storyboard edits, paid submissions, and credential access. This package does not provide those tools or revive the legacy application's independent state files. For important roles, provided images need visual review and user confirmation; when none are suitable, the agent searches online, checks the source page, license, intended commercial reference use, provider upload rights, and visual suitability, then archives the image and records its own review before the core `style_references.py` check. Missing usable evidence pauses only that role. Online photos remain generation references and never become final cast assets. This is a skill workflow precondition, not interception inside paid tools or payment authorization. Optional Xiaohongshu access requires the user's explicit choice and a legally configured, account-confirmed endpoint; no automatic installation, browser download, or old-service reuse. Login state is never distributed.
- No provider requests or real-project assembly are exercised by migration tests. Asset data migration must separately preserve or explicitly remap stored absolute paths. Media QA and copy-hash verification remain caller responsibilities.
- The snatch skill ships without its PyQt6 desktop client and without the source project's live probes; both remain local tools. Its claim path is covered by offline tests against a fake transport only, so no real claim and no end-to-end run against the live service was performed while migrating it, and the ledger, paging, and read-back rules are verified offline alone.

<a id="dev-note"></a>
### Dev Note

None.
