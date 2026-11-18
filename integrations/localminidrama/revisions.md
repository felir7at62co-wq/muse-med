---
description: "Redacted project-content history and version-checked restoration."
kind: "reference"
---

# Muse content revisions

English | [中文](revisions.zh.md)

## Summary

The production page's **Edit history and restore** dialog compares project-content revisions and restores a selected content snapshot after checking the current version. Restoration never generates media, changes selected media versions or restores paid-generation state. Native HTTP handlers and direct SQL writes to the audited business fields use the same append-only SQLite journal.

## Contents

- [Audited content](#audited-content)
- [Restoration and failures](#restoration-and-failures)
- [Generation records](#generation-records)
- [Integration and verification](#integration-and-verification)

## Audited content

The whitelist covers projects, episodes, characters, scenes, props, storyboards and frame prompts. Content fields include scripts, dialogue, narration, prompts and character descriptions. Media URLs, local paths, adopted frame references and episode/storyboard character/prop associations are read-only audit fields. Authentication, provider configurations, credentials and generation-status tables are outside this journal. Asset-library edits are outside the project-content whitelist.

Activation creates a clearly labelled baseline for existing objects; it cannot recover edits made before activation. Later native writes record before/after values. Deleted objects retain a read-only history in the current project; restoration cannot recreate an object or a deleted project. Actor attribution is unavailable because native direct SQL writes do not carry a user/tool identity.

The journal masks common credential keys, bearer/API token patterns, labelled passwords and signed URL parameters. It never reads provider keys or authentication stores. This pattern matching cannot identify every arbitrary secret written into prose. Masked content cannot be automatically restored. Oversized snapshots or journal-write failures abort the business write in the same database transaction.

## Restoration and failures

Select an object and compare a revision's before/after values. The dialog freezes the observed current revision; a later edit makes restoration fail until the user refreshes and reviews the current content. Restoration writes only the content whitelist and adds another audited revision. It preserves media adoption, associations and paid statuses. Image, video and voice history use their dedicated validated adoption operations.

Each restore uses a database-scoped stable `operation_id`. An identical replay returns the original receipt without overwriting later edits; different inputs with that ID fail. An unconfirmed HTTP response must be reconciled using the original ID. The browser stores only fingerprints and UUIDs in this operation cache. Cache persistence failure stops the restore request. The selected content and operation receipt commit together.

The API prefix is `/api/v1/muse/revisions`: `GET /entities?project_id=…` lists the project's objects, `GET /history?project_id=…&kind=…&entity_id=…` returns paginated history, and `POST /restore` accepts `{project_id,kind,entity_id,revision_id,expected_revision,side,operation_id}`. `side` is `before` or `after`. Association histories have no restorable fields. Foreign-project subjects return 404; stale versions return 409.

## Generation records

`GET /usage?project_id=…` counts native image, video and independent-TTS generation records by completion state. These rows are not verified supplier request counts or an invoice. Token totals and cost remain `null` with `usage_status: unreported`; missing history tables return `available: false`. The dialog does not estimate charges from duration, success or configuration.

## Integration and verification

`planMuseRevisions(root, readSource)` runs after `planCloudPrefix` and `planMuseAudio`, before postproduction changes. It registers the service before native route handlers and reads the latest staged source. Repeated application or changed anchors fail. The owner executes complete SQL under monotonic `muse_revision_schema` version 1, including triggers, without editing the upstream semicolon-splitting migrations. Back up the SQLite database and media storage together before applying a new schema.

`muse_revisions.max_snapshot_bytes` defaults to 2,097,152 and accepts integer values from 1,024 to 16,777,216. Every database connection performing audited writes must register this service's SQLite function; an uninitialized connection fails instead of bypassing the journal. Writes outside the whitelist are not revisioned.

Run `node --test integrations/localminidrama/tests/muse-revisions.test.mjs`. The owner-local suite uses the pinned upstream migrations, private real SQLite databases, loopback HTTP native storyboard handlers and Vue compilation. It verifies restoration, conflicts, replay, redaction, journal failure, association-only edits and unavailable billing values without supplier credentials or paid calls. The expected output belongs to [the revision fixture](tests/expected/muse-revisions.json).

## Dev note

None.
