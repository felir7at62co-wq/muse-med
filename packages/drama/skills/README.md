---
description: "Search historical drama assets, maintain project state, and assemble confirmed whole-drama deliveries with portable skill resources."
kind: "package-reference"
---

# @deepseek-ai/dsh-drama-skills

English | [中文](README.zh.md)

## Summary

Create and review drama scripts, reuse assets, maintain project state, prepare editable drafts, render episodes, assemble whole-drama deliveries, and claim newly released scripts from the Jubian pool. The entry points are the maintained `skills/*/SKILL.md` files, starting with the pipeline skill. Python scripts and necessary static resources travel together, including the renderer's ending effect and ending sound. User projects, credentials, per-project media, and local environments do not.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

Resolve this package's `package.json`, then give its sibling `skills` directory to the existing skill loader. This resource package registers no Service, Tool, or plugin. Installing the npm package alone does not activate its skills.

Start with [the pipeline](skills/tweet-drama-pipeline/SKILL.md), then read the relevant skill before invoking its scripts. Keep the skill directories adjacent: draft, render, and delivery share core's video-ban checks. Use Python 3.11 or newer. Image helpers require Pillow, document helpers require python-docx, and draft generation requires pyJianYingDraft; each skill owns its other optional dependencies. Draft generation rejects an existing draft directory rather than deleting it; use a distinct `name_prefix` for each candidate, without path separators or Windows-reserved characters. No Python interpreter, dependency environment, or FFmpeg binary is bundled.

Asset scripts use `JUBIAN_ASSET_LIBRARY_ROOT` when set, otherwise `$DSH_HOME/data/jubian-asset-library`, with `~/.dsh` as the home default. Existing `tags.local_path` values are not rewritten. Search is read-only. Vision-tagging maintenance requires explicit `DEEPSEEK_API_KEY` injection and can incur charges; it never reads an env file or a Jubian token. The credential provider and subprocess environment integration belong to the consuming application.

Delivery uses its own `assets/template.json`. An explicit `TWEET_DRAMA_TEMPLATE` must be an existing directory; it does not replace the nine directory names or import third-party files. Assembly can delete stale files in its managed output sections. Output inside the project must stay under `delivery`; project ancestors, upstream overlap, and links inside existing output are refused. Reports go to stdout, not a report file; copying is not a SHA256 verification or a complete media QA.

Script-pool claiming uses [the snatch skill](skills/jubian-snatch/SKILL.md). Claiming a script is a real remote write that assigns it to the calling account. Pool reads are paged and report an incomplete read instead of presenting a partial page as the whole pool. A failed or truncated startup baseline aborts before any claim, so the claimable range cannot silently widen. Every claim passes a two-phase local ledger, and a script whose claim was accepted or whose outcome is unknown is never submitted twice. The post-claim read-back counts only a row naming the account as evidence; a script's disappearance from the pool is not.

Run the offline migration checks from this package directory:

```sh
npm test
```

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Maintenance and packaging</summary>

The maintained source is this directory. The initial inputs are the selected `SKILL.md`, `scripts`, `references`, and relevant tests from the same-named skills under the operator's `.dsh/skills` directory. Only dependencies used by these DSH skills are retained. Installed personal copies remain independent; there is no automatic synchronization.

`package.json#files` lists individual distributable files, not a home-directory tree or a broad directory glob. The package excludes credentials, cookies, caches, logs, virtual environments, executables, user indexes, per-project media, and the third-party template PDF; its only bundled user media are the renderer's two ending resources. Tests stay in source and are not packed. No runtime invariant companion is needed: this package owns static resources, not independently changing runtime observations.

</details>

<a id="model-experience"></a>
## Model Experience

### Loaded skill instructions

#### What the model sees

Loading a skill adds its maintained `SKILL.md` instructions, such as [the pipeline](skills/tweet-drama-pipeline/SKILL.md), through the consuming application's skill loader. Search results and script output enter context only when requested. This package registers no tools and makes no model calls by itself. Paid vision-tagging scripts remain explicit maintenance actions; project model specifications and delivery settings remain authoritative.

#### Token effect

Each loaded skill adds its instruction text; requested script output adds result text whose size depends on the operation and project. Installing the resource files alone adds no tokens. The consuming application's skill loader and tool execution path own selection and output limits.

#### KV Cache effect

Loading instructions or returning script output appends context through the consuming application. The resource package does not rewrite earlier messages or control prompt ordering; cache reuse depends on that application's loader and context policy.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- The current Web profile still needs explicit skill-loader configuration, credential injection, and Python dependency provisioning by its consumer. This package does not change root configuration or claim that the running Web session already uses these resources.
- Draft scripts accept a caller-supplied output directory; they neither locate a teammate's installed Jianying draft root nor pair a rendered MP4 with a verified editable draft automatically.
- The operator explicitly authorized public redistribution of the maintained skill source and the two ending resources. `private: true` and `UNLICENSED` do not grant others a license to modify or redistribute this package; the rights of external Python libraries, fonts, models, and other media remain separate.
- Current DSH drama tools own model catalogs, shot compilation, paid submissions, and credential access. This package does not provide those tools or revive the legacy application's independent state files. Important-role reference preparation defaults to user-provided images: archive, visual review, user confirmation, then the core `style_references.py` check. Missing images pause generation. This is a skill-workflow precondition, not interception inside paid tools. Optional Xiaohongshu access requires the user's explicit choice and a legally configured, account-confirmed endpoint; no automatic installation, browser download, or old-service reuse. Login state is never distributed.
- No provider requests or real-project assembly are exercised by migration tests. Asset data migration must separately preserve or explicitly remap stored absolute paths. Media QA and copy-hash verification remain caller responsibilities.
- The snatch skill ships without its PyQt6 desktop client and without the source project's live probes; both remain local tools. Its claim path is covered by offline tests against a fake transport only, so no real claim and no end-to-end run against the live service was performed while migrating it, and the ledger, paging, and read-back rules are verified offline alone.

<a id="dev-note"></a>
### Dev Note

None.
