---
kind: upgrade-guide
description: Optional Skill cloud entry points require explicit profile configuration and cloud publication identities distinct from local archive digests.
---

# Explicit Skill cloud publication

English | [中文](guide.zh.md)

## Change

`@deepseek-ai/dsh-muse-market/cloud` exposes the separate account-bound `museMarketCloud` Remote namespace. It requires the base local storage service, a configured Muse Account origin and an origin-matching private session file. Cloud publication and publisher ids contain 32 hexadecimal characters; local release ids remain 64-character archive SHA-256 values. Upload creates a private draft; submission, review, installation and activation are independent operations.

`./cloud-host` provides the private loopback catalog for a dedicated named `dsh` profile. Its store, administrator policy and gateway secret are independent of Desktop storage. The gateway checks current account authority at request admission; revocation does not cancel work already admitted or committed.

## Migration

1. To enable the optional client, add `@deepseek-ai/dsh-muse-market/cloud` beside the base service in your named profile. Set `baseUrl` to the canonical HTTPS Muse Account origin used for login, or loopback HTTP. Set `sessionFile` explicitly when the profile uses another private account file. Configure complete JSON budgets and per-request timeout separately from local archive limits; see [the package reference](../../../../packages/host/muse-market/README.md#account-bound-cloud).
2. Deploy the private server only through its dedicated named profile and configure the existing account gateway proxy with the matching secret. Back up the complete server store, including SQLite and immutable blobs. See [gateway deployment](../../../../services/muse-accounts/README.md).
3. Update explicit callers to retain the original upload request key and exact local archive before `publishDraft`. Submit with `review(id, revision, 'submit', '')` only after inspecting the returned draft. On an unconfirmed upload, reuse the same key and archive; on a review conflict, read the original id and require a fresh explicit decision rather than automatically submitting a newer revision.
4. Pass the catalog-selected SHA-256 to `installPublication`. Confirm the complete returned publication and disabled installation. Selecting a default still requires the separate activation service; a cloud approval or download does not select one. Catalog results are bounded to at most 100 records, so narrow the search rather than treating one result as a complete directory.
