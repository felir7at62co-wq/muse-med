# Agent Note: Account-private script ingestion beside granted reference reading

Status: implemented

English | [中文](2026-09-29-muse-account-private-script-vault.zh.md)

## Problem

Video transcription gives the editor a reviewed, readable script that should remain available for later writing. The existing knowledge base exposes administrator-granted shared sources for reading, but writing a user's transcript into that shared vault would risk cross-account discovery and confuse editorial material with administrator-approved references. A local project file alone does not make the script available to the signed-in account on another device.

## Decision

The gateway stores reviewed Markdown script sections in a separate private vault below `MUSE_KB_USER_ROOT/<stable account ID>`. The signed-in account's short-lived bearer authorizes `ingest_script`, which accepts bounded text, title, and a safe project-relative source identifier, not a video binary or password. Each immutable section returns a saved, duplicate, or failed result and a `private/SRC-...` ID where available. A partial batch never implies that every section was saved; the editor verifies successful IDs with search and read, retains the local project copy, and reports failures. A model-supplied `reviewed: true` is an input declaration, not server proof of human review or ownership of the source.

Private scripts are searchable by keyword and readable only in that account's context. Shared source and Wiki documents remain read-only to the agent and require explicit administrator grants for the account, source ID, Wiki ID, and permitted read extent; the gateway verifies granted document hashes before serving them. Search combines only that account's private packets with its granted shared results. The `read` and `read_opening` tools accept private IDs owned by that account and eligible granted shared IDs. Neither another account nor a legacy machine bearer can use a private ID. The configured private root must be an existing owner-only directory outside the shared vault; the shared grants file must also be separate and protected from non-owner writes. Startup rejects unsafe paths or permissions.

The [account-access decision](2026-09-28-muse-account-kb-access.md) continues to own UI login, cookie exchange, and the absence of credentials in model tools. Its earlier read-only MCP description applies to shared reference material; this decision adds account-private writing without granting writes to the shared vault. The [editorial decision](2026-09-29-muse-editor-outline-led-drafting.md) owns when reviewed scripts are created and how the editor uses them before drafting.

## Alternatives considered

**Write user scripts into the shared vault with per-document labels.** Labels would have to remain correct through every search, page read, opening read, and administrator operation. A separate per-account root makes the storage and lookup scope explicit while retaining shared grants for curated references.

**Keep reviewed scripts only in the local project.** That avoids server storage but does not let the signed-in account retrieve the script as a knowledge page later. The project copy remains the fallback when cloud writing fails.

**Ingest raw media or every feedback revision automatically.** Media bytes and unreviewed text do not meet the knowledge page's readable-script purpose; automatic feedback writes could preserve an unapproved version. The editor submits reviewed sections and checks the result explicitly.

## Consequences

Private recall is keyword-based; the existing shared vector index does not contain private scripts. The gateway's storage separation and grant checks protect account scope, while editorial correctness and permission to use the source remain human and agent responsibilities. Source packaging alone does not activate the capability: deployment needs the private root and grants configuration, followed by a live two-account write, search, read, and denied cross-account read check. Focused service and Host tests cover the source implementation, but do not substitute for that deployment check.
