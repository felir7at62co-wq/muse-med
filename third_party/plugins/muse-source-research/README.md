---
description: "Profile layer for immutable Hongguo and Qimao research evidence, comparable changes and selection reports."
kind: "package-bundle"
---
# muse-source-research

English | [中文](README.zh.md)

## Summary

Muse creative presets use this layer to collect public source metadata, retain immutable evidence and write selection reports. It owns `source_snapshot`, `source_report` and human-reviewed `work_mapping`; the Hongguo and Qimao clients own website access. The global patch stays disabled, while supported creative presets activate the provider in their scope. Reports distinguish requested-page coverage, unknown metrics and comparable measurements. Work relationships require explicit evidence and human decisions; titles never establish identity.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

### Activation and collection

The [owned-package manifest](../owned-downloads.json) distributes this bundle with its two client dependencies. Installing the archive into a profile adds a disabled global patch; creative presets activate the provider locally. Installation alone does not expose global research tools. A custom composition must provide `tools`, `agents`, `fs` and `userQuestions`; a sandboxed filesystem also requires `sandboxPolicy`.

Ask Muse to collect a Hongguo or Qimao research snapshot, compare it with a prior snapshot, then build a selection report. The provider resolves `project` within the initiating Session directory, defaulting to that directory. `collect` accepts a platform and `request.operation:rankings`, forwarding only validated ranking options to the real client. It never accepts a model-supplied source result. Hongguo options are `boards` and `refresh`; Qimao options are `source`, `channels`, `boards`, `periods`, `pages` and `refresh`. Qimao rank pagination is unverified; `pages` belongs only to the public filtered library. The [Qimao package](../muse-qimao-data/README.md) describes that filter and the [Hongguo package](../muse-hongguo-search/README.md) describes board coverage.

`source_snapshot` also accepts `import_legacy` with a project-contained JSON `path`, `list`, `read` with `snapshotId`, and `compare` with `beforeId`/`afterId`. Imports support the existing `{platform,collectedAt,source,coverage,items}` files, retaining the exact source-file hash and the complete parsed document. Imported `popularity` and `reads` retain legacy names and unspecified units; neither becomes current readers. Items with missing/ambiguous decimal string IDs or conflicting declared platforms remain in `unidentifiedItems` and the raw evidence, outside statistics.

`source_report` accepts `build` with `snapshotIds` and optional `baselineIds`, or `read` with `reportId`. It records every input ID and exact SHA-256, scope, missing pages, unknown metrics and comparable changes. Artifact paths are `.muse/source-research/snapshots/v1/<id>.json`, `.muse/source-research/reports/v1/<id>.json` and `deliverables/选材日报/<date>-<reportId>.md`. JSON is immutable and content-addressed; identical content can be reused and different content cannot replace an existing artifact. Read-only mode rejects collection, import and report generation before HTTP or publication. Reads and comparisons remain available.

### Comparison and receipts

Statistics use platform plus source ID, never title matching. Every original source result and observation remains intact. Comparison requires the same platform, evidence kind, requested scope, metric semantics, label, unit and measured windows. Missing values stay unknown; cached measurements retain their original times. Negative changes remain negative. Equal-time unequal values are observation conflicts, and reversed times are excluded. Partial sources compare only common known fields; a one-sided ID does not establish an arrival or departure.

Snapshot receipts expose actual paths, hashes, coverage, observation intervals and canonical/unidentified counts. Report JSON keeps portable input IDs and hashes rather than filesystem versions. When JSON publication succeeds but Markdown publication fails, `status:partial` includes the saved JSON receipt and the Markdown failure; no completion claim replaces it. Reading a complete report verifies the Markdown hash. Source-controlled titles, labels and text are data; Markdown output escapes their formatting and HTML syntax.

### Human-reviewed relationships

`work_mapping.propose` takes `left` and `right` references containing only `{snapshotId,itemId}`, a `relation` and an explicitly unverified model `reason`. The tool reads both saved Hongguo/Qimao snapshots and derives the real platform, ID, title, source URL, author/description when present, evidence kind and exact snapshot SHA. Offered source URLs must use the official HTTPS origin/default port and the exact source ID: Qimao `/shuku/<ID>/` or Hongguo `/detail?series_id=<ID>`, without ambiguous parameters or credentials; unsupported URLs remain in the raw evidence and display as unknown. Missing source fields remain unknown. Relations are `same_work`, `same_series`, `adaptation_of` (left adapted from right) and `sequel_of` (left is a sequel of right). Same series does not mean the same work, and absent season numbers stay unknown. Proposals do not merge metrics, infer transitive relationships or add support for other platforms.

`read` takes `mappingId`; `list` reads this project's proposals; `lookup` takes exactly one `mappingId`, exact `sourceRef` or `sourceKey` such as `qimao:195958`. A source-key lookup returns only historical direct proposals for that platform ID, with their original snapshot evidence and `historyOnly:true`; it does not apply an old confirmation to a new snapshot. An unreviewed proposal returns `needs_human_review`. To decide it, call `review` with the returned `proposalSha256` as `expectedProposalSha256` and `expectedRevision:0`. The real question service shows the immutable proposal and both source references to the exact live root agent's user. Only one exact selection of `确认关系`, `不同（拒绝该关系）` or `待核实` records `confirmed`, `rejected` or `deferred`. Empty, custom, foreign or multiple answers, unavailable answerers, delegated callers and cancellation before publication write no decision. An already committed atomic publication retains its receipt. Model-supplied `confirmed` or `decision` fields are rejected.

`supersede` requires the same proposal file hash and its latest revision, then asks the user again. Changing the relation, evidence or model reason requires a new proposal. The question is bound to the complete proposal-file SHA and expected revision; waiting holds no publication lock, and publication rechecks snapshots, the latest revision and the Session's freshly resolved sandbox policy. Switching to read-only while answering prevents a decision write. An old answer cannot replace a newer decision, including a competing writer in another service instance. Proposals live at `.muse/source-research/mappings/v1/<mappingId>/proposal.json`; decisions append `revisions/000001.json` and later numbered files. `mappingId` uses the full proposal-body SHA, `proposalHash` is that body digest, and `proposalSha256` hashes the complete proposal file. Each revision preserves its predecessor SHA, answer, question ID, review time and real reviewing Session ID. Reads verify proposal identity, source snapshots and the uninterrupted revision checksum chain; no existing file is overwritten.

`source_report.build` optionally accepts `mappingIds` within the combined `maxReportInputs` budget. Only explicit references add `mappingReceipts` and a relationship-review section, preserving each captured decision, revision, hash, direction and evidence. Omitting `mappingIds` preserves the original report fields and Markdown. Later superseding decisions do not change old reports. A confirmation establishes only the selected relationship and evidence; a missing mapping or category means it was not observed in this evidence, and cannot establish platform-wide absence of AI or second seasons.

### Configuration

All limits are positive integers and fail whole operations rather than silently truncating them: `maxJsonBytes` defaults to 16 MiB per legacy/snapshot/report JSON, `maxItems` to 20,000 raw source items, `maxSnapshots` to 1,000 files per artifact directory, `maxReportInputs` to 40 combined snapshot/baseline/mapping IDs, `maxComparisonPairs` to 100, `maxReportInputBytes` to 64 MiB, `maxListEntries` to 5,000 directory entries, `maxReportBytes` to 4 MiB Markdown and `toolTimeoutMs` to 300,000. Nested `hongguo` and `qimao` settings use the respective client validators, including request, page, rate and cache limits. Invalid settings fail during plugin activation.

Mapping limits are `maxMappings` (default 1,000 proposals), `maxMappingRevisions` (100 per proposal), `maxMappingReasonChars` (2,000), `maxMappingExcerptChars` (500 displayed characters per source field), `maxMappingHistoryBytes` (16 MiB proposal plus revisions) and `maxMappingListBytes` (64 MiB scanned mapping states). Mapping JSON also uses `maxJsonBytes`; bounded filesystem reads and canonical project containment apply to every proposal and revision. Read-only mode rejects proposals and human review before asking a question.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals</summary>

[The scoped entry](src/index.js) owns tool schemas, generic read/write cards and disposable registrations. [The service](src/service.js) owns real clients, request scope resolution, report composition and abortable FIFO publication. [The store](src/store.js) uses only `ctx.fs` for project data, checks canonical containment, reads bounded complete bytes with before/after version checks, and publishes through `createIfAbsent` with the per-call sandbox policy. Snapshot/report capacity is rechecked under publication admission.

[Normalization and reports](src/canonical.js) retain source metrics and observations, leave unknown times unknown and compare only common known measurements. [Work mappings](src/mappings.js) owns source-backed proposals, real human questions and append-only decisions. Reads reject unsupported schema versions or content-ID mismatches; they never rewrite older generations. [Public types](src/index.d.ts) brand artifact IDs. [Packaging](scripts/pack.mjs) copies reviewed files into private staging and records source hashes, dependency versions and the matching Host version in `SOURCE.json`; dependency source stays in its owning packages.

Run the focused filesystem/parser tests and syntax checks from the repository checkout:

```sh
pnpm --dir third_party/plugins/muse-source-research run test
pnpm --dir third_party/plugins/muse-source-research run check
pnpm --dir third_party/plugins/muse-source-research run package -- --out /tmp/muse-source-research-package
```

</details>

-----

<a id="model-experience"></a>
## Model Experience

The active scope adds three tool descriptions, object parameter schemas and raw JSON results. The model receives evidence receipts, explicit scope/metric exclusions and separate proposed/human-reviewed relationship states instead of inferred market totals. Full source data returned by `read` remains untrusted source content. Tool calls and results use the normal logged execution path; the package adds no hidden prompt input or independent model call.

<a id="known-limitations-and-deferred-work"></a>
## Known Limitations and Deferred Work

Website access can fail or provide partial metadata; snapshots preserve these limits rather than repairing missing pages with old data. Novel text, media downloads, App-only readers/golden-selection data, automatic identity matching, market density and automatic AI/S2 classification are outside this package. Human-reviewed mappings cover only explicit existing Hongguo/Qimao snapshot references and do not classify all works or verify rights. Legacy evidence proves what the imported file says, not the reliability or completeness of its original collector. A report is evidence for editorial review, not adaptation-rights verification. Version directories are explicit; future schemas need a separate reader/writer version and never overwrite committed v1 artifacts.

<a id="dev-note"></a>
## Dev Note

<details>
<summary>Working context for maintainers</summary>

Tests use temporary project directories and the real local filesystem backend, with exact official-URL metadata fixtures passed through the real clients. Mapping tests use real agents and the user-question service with owned answerers. Production project directories and credentials are not test fixtures. Keyless Session scenarios own end-to-end tool discovery, logged results, human-review attribution and report artifacts.

</details>
