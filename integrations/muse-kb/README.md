# MUSE cloud knowledge base patch

English | [中文](README.zh.md)

This directory contains the [cloud service patch](0001-granted-kb-reading.patch) for `E:\工作间\muse-local-dev\source\muse-accounts`. The patch adds account-scoped document grants and a cookie-to-KB access exchange. The Desktop account service uses the exchange after sign-in; it keeps the returned bearer token inside the Host and does not persist it.

## Apply and verify

Run these commands from PowerShell after the isolated Muse branch is merged and the target cloud source has been reviewed:

```powershell
git -C 'E:\工作间' apply --check --directory=muse-local-dev/source 'E:\deepseek-harness\integrations\muse-kb\0001-granted-kb-reading.patch'
git -C 'E:\工作间' apply --directory=muse-local-dev/source 'E:\deepseek-harness\integrations\muse-kb\0001-granted-kb-reading.patch'
Push-Location 'E:\工作间\muse-local-dev\source\muse-accounts'
node --test kb-opening.test.mjs account.test.mjs gateway.test.mjs store.test.mjs
Pop-Location
```

The patch leaves deployment as a separate operation. It adds `kb-grants.mjs` and `kb-opening.test.mjs`, and changes `gateway.mjs`, `kb-mcp.mjs`, and `kb-vault.mjs`. The patch applies to the local cloud source inspected on 2026-09-28; `git apply --check` detects source drift before any file is changed.

## Document grants

Set `MUSE_KB_DOCUMENT_GRANTS` to a JSON file controlled by the gateway administrator and stored outside the editor-writable vault. The gateway validates and loads it at startup. Restart the gateway after changing grants, including removals; a file edit alone does not revoke document access. An unset path creates an empty grant set: no account token can search or read documents. The existing account-bound HMAC bearer can still ingest, but its search and read operations now follow the same grants as the new session token.

```json
{
  "version": 1,
  "grants": [
    {"id": "SRC-2026-09-28-001", "kind": "viral-script", "level": "opening", "access": "all-authenticated", "sha256": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", "title": "Approved script"},
    {"id": "wiki/剧本/节奏复盘", "kind": "knowledge", "level": "read", "access": "accounts", "accountIds": ["0123456789abcdef"], "sha256": "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"}
  ]
}
```

Replace the example IDs with source packet IDs from vault manifests, Wiki paths, and the target account's stable 16-character lowercase hex ID. Replace each example `sha256` with the lowercase SHA-256 of the complete, exact `raw/sources/<ID>/extracted.md` or `wiki/<path>.md` file; `(Get-FileHash -Algorithm SHA256 <path>).Hash.ToLowerInvariant()` prints it on Windows. The optional `title` is administrator owned; source titles otherwise display their ID, never the vault manifest title. Changes to a document require a new digest in the grant file and a gateway restart before the changed bytes can be read. `viral-script` is an administrator designation for a source packet; a title alone never confers that designation. A `knowledge` entry can identify either a source packet or a Wiki page. `opening` permits only the first 24,000 Unicode characters, while `read` permits paged reading of the whole supported document. Only `viral-script` source packets can use `read_opening`; Wiki pages and ordinary source packets use `read` when granted. Entries without `kind` or a valid `sha256` fail gateway startup.

## Account and MCP access

The signed-in account service sends an empty `POST /api/kb/access` with its session cookie and the gateway origin. The gateway returns `{url, token, expiresAt}`. The opaque token expires after at most 15 minutes and stops working when the login session ends, the account is disabled, or its password changes. It lists `search`, `status`, `read`, and `read_opening`; `ingest` is unavailable to this token.

`search` returns only granted IDs to either token type, along with each document's source/Wiki type and administrator-designated kind. The gateway reads each granted file once, verifies its complete bytes against `sha256`, then derives titles, matches, previews, and vector lookups from those bytes. A changed or unreadable file is omitted from `search` and `status`; both read tools reject it. For an `opening` grant, matching and previews use only the first 24,000 characters; vectors built from later text are withheld. `status` counts verified documents and omits the global vector count. `read` accepts a fully granted source or Wiki ID and returns up to 6,000 characters per page. `read_opening` accepts a granted `viral-script` source ID and limits reading to four such pages; it displays the source ID or administrator title. Both read tools return the source's total byte count, exact zero-based character range, current page number, unread-content flag, and next start. The agent follows `nextStart` until the required scene and first hook have actually been read; when the opening limit arrives first, the tool reports that limit and the agent must not claim the reference was complete.

Documents above 4 MiB are rejected by the read and search tools. Within that limit, `read` accepts a 6,000-character-aligned `start` through 4,194,000, so every returned `nextStart` is valid. Search indexes at most the first 400,000 characters after hashing the complete file.
