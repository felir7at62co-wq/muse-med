---
description: "Jubian HTTP transport, credential repair, six stable failure codes and the two-phase NDJSON write ledger that dsh-tool-jubian and dsh-jubian-api build on."
kind: "package-reference"
---

# @deepseek-ai/dsh-jubian

English | [中文](README.zh.md)

## Summary

`@deepseek-ai/dsh-jubian` sends fixed-origin Jubian requests using a credential resolver and returns response data, status, and a digest of the response bytes. It repairs common pasted-token artifacts and reports six stable failure codes without exposing provider text. Its two-phase NDJSON ledger records paid or state-changing calls; a repeated `idempotency_key` yields the prior record so the caller avoids resending.

`pool_claim` records screenplay-pool submissions. The claim tool checks prior records for the same script before another key can submit; uncertain outcomes remain `unknown` until read-only reconciliation.

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

Import the library when your own code must talk to Jubian directly. It is a dependency, not a composition row: it registers no Cordis service, tool, prompt section or session event, so no `cordis.yml` row mounts it, and everything a model can see belongs to `@deepseek-ai/dsh-tool-jubian`.

### When to choose it

Choose it when you own the call site — a tool package, a test with a stubbed `fetch`, or a script that reads one provider endpoint. Reach for `@deepseek-ai/dsh-tool-jubian` instead when a model should call Jubian through tools, and for `@deepseek-ai/dsh-jubian-api` when you need typed readers for a payload this client already delivered.

### Sending one request

`request()` resolves the credential, sends exactly one attempt, and returns the envelope payload together with the evidence of how it arrived:

```ts
import { JubianClient, JubianError } from '@deepseek-ai/dsh-jubian'

const token = process.env.JUBIANAI_ADMIN_TOKEN
if (!token) throw new Error('Set JUBIANAI_ADMIN_TOKEN')
const client = new JubianClient({ credential: async () => token })

try {
  const response = await client.request({ method: 'GET', path: '/aigc/asset/123' })
  console.log(response.transport.http_status, response.response_sha256, response.data)
} catch (error) {
  if (error instanceof JubianError) console.error(error.code)
}
```

`path` carries its own query string, and `body` is serialized as JSON for the methods that accept one. Success returns `data` untouched, so a field the provider adds never becomes an error here. The constructor rejects a `timeoutMs` outside 1..60000 and a `maxResponseBytes` outside 1..32 MiB with a `TypeError`; the defaults are 30000 ms and 2 MiB, and `baseUrl` defaults to `https://web.jubianai.net/prod-api`.

### Reading every envelope layout this provider sends

Two layouts are documented, and the client hides the difference from you. A single-object endpoint nests its payload under `data`; the list endpoints carry `code`, `total` and `rows` at the top level and have no `data` at all. The client returns the nested `data` when that key exists, and otherwise the whole envelope minus its `msg` text — so `total` and `rows` arrive as one object, and a reader never has to know which layout the provider sent. Four further layouts are tolerated because a reader cannot recover a payload the transport rejected: a success envelope wrapped in a one-element array, a payload object wrapped in a one-element array, a bare top-level array, and a payload that is itself a success envelope. Every response names the layout it used in `envelope_layout`, and a tolerated layout that carries no envelope of its own reports `transport.application_code: null`, so no caller can mistake it for a verified success. A body that is valid JSON but none of these — a string, a number, `null`, or an object with no integer `code` — still fails as `CONTRACT_CHANGED`.

### Repairing a stored token

`trimBearerToken()` removes surrounding whitespace, one trailing shell separator (`;` or `&`) and one matching quote pair — the artifacts a shell export or a copied settings value leaves behind — and never rewrites the interior. `isUsableBearerToken()` then requires a non-empty value with no whitespace. A value that still carries an interior space fails locally as `AUTHENTICATION_REQUIRED` before any request leaves, so a broken secret reaches neither the network nor a log. The credential reference this package owns is `JUBIANAI_ADMIN_TOKEN`; the host owns its value.

`workspaceJubianClient()` uses a nonblank credential-store value first. When workspace secrets are enabled and the store is empty, `workspacePipelineToken()` searches the start directory and up to eleven parents for the nearest readable `.agents/secrets/pipeline.env`. That file supplies a nonempty `JUBIANAI_ADMIN_TOKEN`, then `JUBIANAI_TOKEN`; a readable file with neither stops the search. Each request reads the current values without logging them.

### The six stable failure codes

`JubianError` keeps its stable code and local message. HTTP failures append only the numeric status, such as `HTTP 502`; recognized timeout, abort, DNS, connection and TLS failures append allowlisted, locally authored detail. Provider messages, bodies, URLs, tokens and original causes are never attached. Unknown transport failures retain `Jubian request failed`; diagnostics do not trigger retries.

| Code | Raised when |
|---|---|
| `AUTHENTICATION_REQUIRED` | The credential resolver throws, the repaired token is unusable, HTTP is 401 or 403, or the envelope `code` is 401 |
| `PERMISSION_DENIED` | The envelope `code` is 403 while HTTP is 2xx |
| `RATE_LIMITED` | HTTP is 429, or the envelope `code` is 429 |
| `CONTRACT_CHANGED` | The body is not JSON, is not valid UTF-8, is not an object, exceeds the byte cap, carries no integer `code`, or carries a code this package does not map; the detail describes the body's structure |
| `NETWORK_ERROR` | The connection failed, the call timed out, a redirect was refused, or HTTP is any other non-2xx status |
| `BUDGET_EXCEEDED` | A paid call is not covered by the deployment's authorization; the detail names what is missing |

HTTP 200 with an envelope `code` of 401 is the shape this provider returns for a token it will not accept, and it fails exactly like an HTTP 401. The two success codes are `0` and `200`.

A rejected body is described by `describePayload()` or `describeUnparsed()` rather than reproduced: the top-level type, the own key names, the array length, the byte count and one bounded excerpt, with the values of credential-named fields removed, absolute URLs reduced to their origin, and long opaque runs replaced. `Jubian response did not match the expected envelope: top-level array of 7 elements, first element object with keys [id, scriptId, …]` is what such a failure now says.

### Capping what a project may spend

`checkBudget` answers whether one more paid call fits:

```
settled spend + in-flight reservations + this call's quote <= the project's limit
```

Explicit project limits live in `<ledger>/authorization.json`. The operator can edit it, or the shared budget writer can save a verified user authorization:

```json
{ "version": 1,
  "projects": { "2708": { "limit": "200", "unit": "CNY", "note": "2026-09-22 用户授权",
                          "estimates": { "storyboard_native_submit": "15" } } } }
```

`estimates` is what a call is charged against when it cannot quote itself. A token-priced video model states a rate per million tokens rather than a price per task, and the token count is only known from the finished task, so the operator states what one such call is worth; the ledger records that estimate as the call's quote. A call with neither a quote nor an estimate is refused, because counting an unknown cost as zero would make the cap meaningless exactly where it matters.

An unsettled or `unknown` paid call with a usable quote counts as reserved: it may have been charged. A paid record without a usable amount and currency blocks further spending for its own project, including when its outcome is `unknown`; another known project's records stay isolated. A paid record with no project blocks further spending across all projects sharing the ledger, regardless of outcome, until a person reconciles its attribution. Any recorded quote currency different from the project's authorized currency blocks further spending, including mixed-currency history; amounts in different currencies are never combined for authorization. An unknown outcome never proves zero cost. Amounts are compared as integer hundredths.

Without a matching project authorization or a mounted drama default budget, paid calls are refused before recording an intent or sending a provider request. The default supplies a CNY ceiling for projects without their own authorization; an explicit project entry replaces that default. Calls without a quote or accepted estimate remain refused. `readProjectBudget` reports the effective amount, real spend and reservations, and an exact revision; its public `ProjectBudget` JSON type is available from `@deepseek-ai/dsh-jubian/types`. `updateProjectBudget` preserves existing estimates, other projects and accounting, appends user evidence to `authorization_history`, checks the revision under the ledger reservation queue and an exclusive `.authorization.lock`, then atomically replaces the JSON and reads it back. A ceiling below accounted spending, incomplete accounting, unsupported currency, malformed file or stale revision refuses before replacing any bytes. Budget writers exclude other writers across processes; paid reservations remain serialized only in one runtime. Local file access is not a separate security boundary.

Storyboard video batches use `checkBudget(..., count)` inside `beginManyChecked` to compare the full batch estimate before any provider PUT and append each original key's priced intent together. Every paid method requires a per-call quote or estimate of at least 0.01 in its authorized currency; a positive fractional-cent amount that rounds to zero cannot authorize spending. A rejected budget or existing key appends no new intents. The same-process queue also serializes this reservation with single paid writes; separate processes remain outside that queue.

### Recording a write in two phases

`JubianLedger` answers the one question a timeout leaves open: did that charge actually happen? Write an intent line before the request leaves, and a settle line after the response is read.

```ts
import { JubianClient, JubianLedger } from '@deepseek-ai/dsh-jubian'

const token = process.env.JUBIANAI_ADMIN_TOKEN
if (!token) throw new Error('Set JUBIANAI_ADMIN_TOKEN')
const client = new JubianClient({ credential: async () => token })
const ledger = new JubianLedger({ root: './jubian-ledger' })
const begun = await ledger.begin({
  idempotencyKey: 'episode-1-upscale-428322',
  method: 'video_upscale',
  requestSha256: 'sha256:9f2c…',
})

if (!begun.replayed) {
  const response = await client.request({ method: 'POST', path: '/aigc/video/upscale', body: { taskId: 428322 } })
  await ledger.settle('episode-1-upscale-428322', {
    httpStatus: response.transport.http_status,
    applicationCode: response.transport.application_code,
    responseSha256: response.response_sha256,
    outcome: response.transport.application_code === 0 || response.transport.application_code === 200
      ? 'accepted' : 'unknown',
  })
}
```

`begin()` writes the intent line and returns `replayed: true` with the existing record when that key was already recorded, in which case you send nothing at all. `settle()` appends the outcome after the response is read. One NDJSON file per day, `<root>/YYYY-MM-DD.ndjson`, holds both lines, so a text scan shows every attempt; an intent line with no settle line is exactly the unknown state a timeout produces.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

The package is five small modules over `fetch`: one boundary that owns the wire, one that repairs a credential, one that names failures, and one that records writes. Nothing here holds state between calls except the ledger's own files.

### Source map

| File | Role |
|---|---|
| [`src/index.ts`](src/index.ts) | The public surface: the client, the credential helpers, the failure codes and the ledger |
| [`src/client.ts`](src/client.ts) | The one HTTP path: fixed origin, single attempt, byte-bounded read, envelope layout reading and the response hash |
| [`src/credential.ts`](src/credential.ts) | The credential reference name and the paste-artifact repair applied before any header is built |
| [`src/workspace.ts`](src/workspace.ts) | Shared store-first client construction and optional workspace token lookup |
| [`src/diagnostic.ts`](src/diagnostic.ts) | The redacted structure description every rejected body and every dump record is written from |
| [`src/debug-dump.ts`](src/debug-dump.ts) | The opt-in JSONL response dump behind `DSH_JUBIAN_DEBUG_DUMP` |
| [`src/error.ts`](src/error.ts) | The six stable codes, the HTTP-status mapping and the envelope-code mapping |
| [src/budget.ts](src/budget.ts) | The spend cap: the operator's authorization file, and the verdict for one paid call |
| [src/ledger.ts](src/ledger.ts) | The two-phase NDJSON write ledger: intent lines, settle lines and replay folding |
| — | No runtime invariant companion is published; this transport owns no independently observable lifecycle stream, and its boundary rules are enforced by unit tests instead. |

### One attempt, a fixed origin and a byte bound

`request()` builds the URL as `baseUrl + path`, sets `redirect: 'error'`, and combines the caller's `signal` with its own timeout through `AbortSignal.any()`. There is no retry, no backoff and no polling loop: repeating a call is the caller's decision, and the ledger's idempotency key is what makes that repeat safe for a write. The response body is read chunk by chunk and rejected as `CONTRACT_CHANGED` the moment it passes `maxResponseBytes`, so an oversized or endless body never accumulates in memory. Those exact bytes are then decoded as strict UTF-8 and hashed into `sha256:<hex>`, which is what lets a caller compare what it received against a ledger settle line.

### Every envelope layout in one return value

The body is parsed once and read as one of the layouts above. `failureForEnvelopeCode()` classifies the non-success codes before any payload is chosen, and `envelope_layout` reports which layout was actually read. The flat branch — every top-level field except `msg` — is what keeps the provider's list endpoints, which report `total` and `rows` and carry no `data`, readable through the same return type as a single-object endpoint. A one-element array is read as the object it holds, a bare longer array is handed to the reader as that array, and a payload that is itself a success envelope is unwrapped once more. A layout that states no code of its own reports `transport.application_code: null` instead of inventing one.

### Safe failure diagnostics

The client matches exact transport codes or timeout/abort names on the thrown object and its immediate cause, without traversing deeper causes. The combined signal identifies caller cancellation or the client's deadline, including during body reads. HTTP 401 and 403 remain `AUTHENTICATION_REQUIRED`; an envelope `code` of 403 behind HTTP 2xx remains `PERMISSION_DENIED`. A body this client will not accept is reported with `describePayload()` or `describeUnparsed()`: top-level type, own key names, array length, byte count and one bounded excerpt, with credential-named fields redacted and absolute URLs reduced to their origin, so a tool result can say what arrived without reproducing it. The [diagnostic decision](../../../.agents/notes/implemented/bug-fix/2026-09-23-jubian-safe-transport-diagnostics.md) records the redaction trade-off and verification limits, and the [layout decision](../../../.agents/notes/implemented/bug-fix/2026-09-28-jubian-unreadable-response-diagnostics.md) records why the tolerated layouts exist.

<a id="dumping-responses-on-purpose"></a>
### Dumping responses on purpose

Setting `DSH_JUBIAN_DEBUG_DUMP` to a file path makes `request()` append one JSONL record per response: the timestamp, method, path, HTTP status, application code, envelope layout, byte length, response hash and the redacted payload. It is off whenever the variable is unset or blank, nothing enables it automatically, and the file's directory is created on first write. Every call is recorded, not only `GET`s, because `subtasks` is a `POST` that only reads; request headers, including `Authorization`, are never read by the dump, and each body goes through the same redaction the error diagnostics use. The file is created with owner-only permissions where the platform honors them, and no dump failure ever changes the call it observes. Share the file, never a token: it is written so an operator can send back what the remote returned without sending back a credential.

### What the two-phase ledger buys

`begin()` reads every existing NDJSON file for the key and folds the matching lines into one record before it appends anything: a `begin` line opens the record, and a later `settle` line with the same key fills in `http_status`, `application_code`, `response_sha256` and `outcome`. A hit returns `{ replayed: true, record }` and the caller must not send. `outcome` is `accepted` only for an HTTP 2xx response whose application code is `0` or `200`; every other case is `unknown`. That distinction is the point: after a timeout the file shows an intent line with no settle line, which is the honest answer rather than a guess.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

Read these pages when you need the layer above this transport or the repository rules it follows.

- [Jubian tools package](../tool-jubian/README.md) — the model-facing tools that own the credential reference, the ledger root and every paid write.
- [Module graph](../../../docs/module-graph.md) — where this transport sits in the repository package order.
- [Adding a package](../../../docs/cookbook/adding-a-package.md) — the package contract this README and its bilingual pair follow.

-----

<a id="model-experience"></a>
## Model Experience

None, as the package registers no tool, prompt section or session event, and `@deepseek-ai/dsh-tool-jubian` owns every model-visible use of this transport.

#### KV Cache effect

This package contributes nothing to a request prefix. The tools and results a model sees belong to `@deepseek-ai/dsh-tool-jubian`, so mounting or upgrading this dependency alone cannot change a reusable prefix.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

These constraints are current package behavior, not a task backlog.

- **One attempt, never a retry** — a timeout, a refused redirect or an HTTP 429 leaves the call failed, and repeating it is the caller's decision. For a write, the ledger's idempotency key is what makes that repeat safe rather than a second charge.
- **The byte cap fails the call instead of truncating it** — a body larger than `maxResponseBytes` is rejected as `CONTRACT_CHANGED` after at most that many bytes, so a large provider list must be re-read through the provider's own paging parameters rather than by raising the cap.
- **An unrecognized envelope code reads as a contract change** — `failureForEnvelopeCode()` maps only 0, 200, 401, 403 and 429; any other application code becomes `CONTRACT_CHANGED`, so a newly introduced provider code arrives as a shape change rather than as its own failure category.
- **A tolerated layout is recorded, not yet promoted to a rule** — the arrays and the nested envelope above are accepted because a transport cannot know what a reader can use, and `envelope_layout` names what was seen; tightening one to its own rule needs a real capture of an endpoint that sends it, so the accepted set is deliberately wider than the documented one.
- **A tolerated layout carries no application code** — `array-payload` and `array-single` report `transport.application_code: null`, so a caller that needs the provider's own success code (the write ledger, for instance) records `unknown` rather than `accepted` for those bodies.
- **A reader's own rejection carries no structure description** — the description above belongs to this client's envelope reading; a reader in `@deepseek-ai/dsh-jubian-api` that rejects a readable payload still reports `CONTRACT_CHANGED` with no field named, so that case is investigated through the debug dump rather than from the message.
- **The debug dump is a file an operator has to remove** — it holds provider payloads with credentials redacted by key name, URL origin and opaque-run replacement; values that carry a credential under an unremarkable key name, and anything already redacted incorrectly upstream, are not detected, so the file stays local and is deleted after the diagnosis.
- **A stored token is repaired, never verified** — `trimBearerToken()` removes one trailing separator and one quote pair, and the package never tests the value against the provider, so a revoked-but-well-formed token is discovered only by the first real call.
- **The ledger detects a write, it does not lock one** — `begin()` reads the existing files before it appends, so two processes sharing one ledger root can both write a `begin` line for the same key; serializing writers is the caller's job.
- **Nothing reconciles the ledger automatically** — an intent line without a settle line stays unresolved until a caller or an operator reads the NDJSON files, and no surface lists those open records.

A configured default project limit also applies to projects absent from an existing authorization file. Explicit lower project limits remain effective; a missing price remains unknown rather than zero.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
