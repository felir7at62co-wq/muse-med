# Agent Note: Character reference approval at Jubian tool execution

Status: proposed

English | [中文](2026-10-08-character-reference-approval-at-tool-execution.zh.md)

## Problem

The [character reference checker](../../../../packages/drama/skills/skills/tweet-drama-core/scripts/style_references.py) rejects pending, rejected, missing, changed, and unbound evidence when called. The [skill workflow](../../../../packages/drama/skills/skills/tweet-drama-core/references/style-references.md) asks the Agent to call it before paid image generation. The Jubian tool executor does not call that checker, so an Agent that skips it can upload a valid pending image or submit a reference URL, subject only to unrelated file, request, and budget checks. The [independent Desktop decision](../../implemented/architecture/2026-09-23-muse-med-independent-desktop.md) explicitly describes the current check as a workflow prerequisite rather than a paid-tool authorization check.

## Proposal

Enforce approval in the Jubian operation that can upload a managed image and in every image-generation operation that can consume its URL. Keep the existing project `asset_style_references.json` as the review authority. Do not make an Agent-supplied `approved` flag, source label, or prior successful `check` output authoritative.

### Current entry points

[`jubian_asset upload_reference`](../../../../packages/jubian/tool-jubian/src/methods.ts) receives `image_path` and calls `uploadReferenceMethod`; it has no project or role input today. [`jubian_video image_generate`](../../../../packages/jubian/tool-jubian/src/methods.ts) receives `script_id`, asset identity, `prompt`, `references` as ordered HTTPS URLs, and `idempotency_key`, then builds the paid `/aigc/asset` request. `image_generate_batch` calls the same image method per item and must receive the same check before any item sends. The [tool registration](../../../../packages/jubian/tool-jubian/src/index.ts) validates required arguments and has a `tools/pre-execute` hook for unrelated operations; it currently performs no character-reference review.

### Identity and records

For an enrolled project, the tool should resolve a canonical project root from trusted execution context, bind it to `project_config.json:jubian_script_id` using the existing `validateProjectBinding`, and require the call's role and candidate IDs to identify a record in that project's manifest. Before upload, compare the canonical archived file path and SHA-256 with that record and re-read its current role and candidate decisions. Before generation, compare every managed URL with a tool-owned upload association that records project root, `script_id`, role ID, candidate `note_id`, archived-file SHA-256, returned URL, and the review-record fingerprint. The Jubian module writes this association only after a successful upload and reads it immediately before building each paid request; the drama script continues to own review records. An association never grants approval by itself: re-read the manifest so withdrawal takes effect before another generation.

The tool must identify managed paths by resolving the actual file within a bound project and matching the manifest path and bytes; it must identify managed URLs from its own recorded upload result. A path prefix, filename, or caller-declared origin alone is insufficient. To prevent omission of the new fields from bypassing an enrolled project's image calls, the project binding and enforcement mode must come from Host or project state rather than the Agent's optional arguments. A project without this mode retains the existing tool contract until its references are migrated.

### Refusals and compatibility

For enrolled projects, pending or rejected review, missing or unreadable records, changed or absent files, a different role or project, unknown managed URLs, and withdrawn approval reject before object upload or `/aigc/asset` submission. Missing URL association requires a new reviewed upload rather than trusting the string. Existing direct URLs and non-library references need an explicit migration or approved external-reference path before an enrolled project uses them; legacy projects remain on their current behavior. The owner must decide whether project binding becomes mandatory for every reference upload in an enrolled session, since an arbitrary copied file cannot be recognized reliably from bytes outside that project. This proposal does not claim to block uploads made through other tools or external clients, or generation in an unenrolled project with an arbitrary URL.

## Alternatives considered

**Strengthen skill wording or rely on `check` output.** A direct tool call skips the instruction; a past check also becomes stale after approval withdrawal or file mutation.

**Filter only local library paths.** Copying the image to another path or passing an already uploaded URL bypasses a path filter, while a blanket path ban would disrupt existing user-supplied references.

**Reject every URL in every project immediately.** This breaks existing online and user-supplied reference workflows before a migration path exists.

## Acceptance criteria

- Through the registered tool executor, a pending, rejected, missing, changed, cross-role, cross-project, or withdrawn managed reference yields zero mock object-upload calls and zero mock `/aigc/asset` calls.
- An approved synthetic fixture uploads once, records its exact URL association, and permits single and batch generation only while its current review and project binding still match; all provider calls remain mocked.
- Direct URL and legacy-project tests pin the chosen compatibility rule without treating an Agent-supplied source label as evidence.
- A real Host run demonstrates the same refusal before side effects. It does not require real upload or paid generation.

## Risks

Binding all character image references to project context changes the existing tool inputs and needs a migration for legitimate direct URLs. A scoped project mode limits compatibility impact but cannot police external tools or unenrolled projects. The upload association must be written atomically and never be treated as durable permission after review changes. This proposal does not authorize a broader permission system or modification of the Jubian owner code from the character-library worktree.
