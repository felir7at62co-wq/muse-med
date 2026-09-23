---
description: "Jubian HTTP transport, credential repair, six stable failure codes and the two-phase NDJSON write ledger that dsh-tool-jubian and dsh-jubian-api build on."
kind: "package-reference"
---

# @deepseek-ai/dsh-jubian

English | [中文](README.zh.md)

## Summary

`@deepseek-ai/dsh-jubian` is the single HTTP path to Jubian: you build a `JubianClient` with a credential resolver, send one fixed-origin request, and read back the envelope data, the transport status and a sha256 of the exact response bytes. It repairs the shell separator and quote pair a pasted token usually carries, folds every failure into one of five stable codes that never echo provider text, and records each paid or state-changing call in a two-phase NDJSON ledger where a repeated `idempotency_key` returns the recorded outcome without sending anything. `@deepseek-ai/dsh-tool-jubian` and `@deepseek-ai/dsh-jubian-api` consume it.

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

const client = new JubianClient({ credential: resolveJubianToken })

try {
  const response = await client.request({ method: 'GET', path: '/aigc/asset/123' })
  console.log(response.transport.http_status, response.response_sha256, response.data)
} catch (error) {
  if (error instanceof JubianError) console.error(error.code)
}
```

`path` carries its own query string, and `body` is serialized as JSON for the methods that accept one. Success returns `data` untouched, so a field the provider adds never becomes an error here. The constructor rejects a `timeoutMs` outside 1..60000 and a `maxResponseBytes` outside 1..32 MiB with a `TypeError`; the defaults are 30000 ms and 2 MiB, and `baseUrl` defaults to `https://web.jubianai.net/prod-api`.

### Reading both envelope shapes

Two shapes are live on this provider, and the client hides the difference from you. A single-object endpoint nests its payload under `data`; the list endpoints carry `code`, `total` and `rows` at the top level and have no `data` at all. The client returns the nested `data` when that key exists, and otherwise the whole envelope minus its `msg` text — so `total` and `rows` arrive as one object, and a reader never has to know which shape the provider sent.

### Repairing a stored token

`trimBearerToken()` removes surrounding whitespace, one trailing shell separator (`;` or `&`) and one matching quote pair — the artifacts a shell export or a copied settings value leaves behind — and never rewrites the interior. `isUsableBearerToken()` then requires a non-empty value with no whitespace. A value that still carries an interior space fails locally as `AUTHENTICATION_REQUIRED` before any request leaves, so a broken secret reaches neither the network nor a log. The credential reference this package owns is `JUBIANAI_ADMIN_TOKEN`; the host owns its value.

### The six stable failure codes

`JubianError` keeps its stable code and local message. HTTP failures append only the numeric status, such as `HTTP 502`; recognized timeout, abort, DNS, connection and TLS failures append allowlisted, locally authored detail. Provider messages, bodies, URLs, tokens and original causes are never attached. Unknown transport failures retain `Jubian request failed`; diagnostics do not trigger retries.

| Code | Raised when |
|---|---|
| `AUTHENTICATION_REQUIRED` | The credential resolver throws, the repaired token is unusable, HTTP is 401 or 403, or the envelope `code` is 401 |
| `PERMISSION_DENIED` | The envelope `code` is 403 while HTTP is 2xx |
| `RATE_LIMITED` | HTTP is 429, or the envelope `code` is 429 |
| `CONTRACT_CHANGED` | The body is not JSON, is not valid UTF-8, is not an object, exceeds the byte cap, carries no integer `code`, or carries a code this package does not map |
| `NETWORK_ERROR` | The connection failed, the call timed out, a redirect was refused, or HTTP is any other non-2xx status |
| `BUDGET_EXCEEDED` | A paid call is not covered by the deployment's authorization; the detail names what is missing |

HTTP 200 with an envelope `code` of 401 is the shape this provider returns for a token it will not accept, and it fails exactly like an HTTP 401. The two success codes are `0` and `200`.

### Capping what a project may spend

`checkBudget` answers whether one more paid call fits:

```
settled spend + in-flight reservations + this call's quote <= the project's limit
```

The limit lives in `<ledger>/authorization.json`, written by the operator rather than supplied as a tool argument:

```json
{ "version": 1,
  "projects": { "2708": { "limit": "200", "unit": "CNY", "note": "2026-09-22 用户授权",
                          "estimates": { "storyboard_native_submit": "15" } } } }
```

`estimates` is what a call is charged against when it cannot quote itself. A token-priced video model states a rate per million tokens rather than a price per task, and the token count is only known from the finished task, so the operator states what one such call is worth; the ledger records that estimate as the call's quote. A call with neither a quote nor an estimate is refused, because counting an unknown cost as zero would make the cap meaningless exactly where it matters.

An unsettled or `unknown` paid call with a usable quote counts as reserved: it may have been charged. A paid record without a usable quote blocks further spending for its own project, including when its outcome is `unknown`; another known project's records stay isolated. A paid record with no project blocks further spending across all projects sharing the ledger, regardless of outcome, until a person reconciles its attribution. An unknown outcome never proves zero cost. Amounts are compared as integer hundredths.

Without an authorization file or a mounted drama series budget, paid calls are refused before recording an intent or sending a provider request. A mounted drama budget supplies an automatic CNY ceiling per `script_id`; any existing authorization file can only lower that ceiling, and its absent project entries still refuse. Calls without a quote or accepted per-method estimate remain refused. The shared writer uses `beginChecked` to check the cap and reserve the accepted quote or estimate in one same-process ledger claim; separate processes still have no mutual-exclusion lock. These local settings and files limit accidental spending, not hostile code: an agent with filesystem write access could edit them. A deployment needing human-owned authorization must enforce that separately.

### Recording a write in two phases

`JubianLedger` answers the one question a timeout leaves open: did that charge actually happen? Write an intent line before the request leaves, and a settle line after the response is read.

```ts
import { JubianLedger } from '@deepseek-ai/dsh-jubian'

const ledger = new JubianLedger({ root: ledgerRoot })
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
    outcome: 'accepted',
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
| [`src/client.ts`](src/client.ts) | The one HTTP path: fixed origin, single attempt, byte-bounded read, envelope validation and the response hash |
| [`src/credential.ts`](src/credential.ts) | The credential reference name and the paste-artifact repair applied before any header is built |
| [`src/error.ts`](src/error.ts) | The six stable codes, the HTTP-status mapping and the envelope-code mapping |
| [src/budget.ts](src/budget.ts) | The spend cap: the operator's authorization file, and the verdict for one paid call |
| [src/ledger.ts](src/ledger.ts) | The two-phase NDJSON write ledger: intent lines, settle lines and replay folding |
| — | No runtime invariant companion is published; this transport owns no independently observable lifecycle stream, and its boundary rules are enforced by unit tests instead. |

### One attempt, a fixed origin and a byte bound

`request()` builds the URL as `baseUrl + path`, sets `redirect: 'error'`, and combines the caller's `signal` with its own timeout through `AbortSignal.any()`. There is no retry, no backoff and no polling loop: repeating a call is the caller's decision, and the ledger's idempotency key is what makes that repeat safe for a write. The response body is read chunk by chunk and rejected as `CONTRACT_CHANGED` the moment it passes `maxResponseBytes`, so an oversized or endless body never accumulates in memory. Those exact bytes are then decoded as strict UTF-8 and hashed into `sha256:<hex>`, which is what lets a caller compare what it received against a ledger settle line.

### Both envelope shapes in one return value

The body is parsed once and checked for an integer `code`. `failureForEnvelopeCode()` classifies the non-success codes, and the payload is then chosen: `data` when that key is present, otherwise every top-level field except `msg`. That second branch is what keeps the provider's list endpoints — which report `total` and `rows` and carry no `data` — readable through the same return type as a single-object endpoint.

### Safe failure diagnostics

The client matches exact transport codes or timeout/abort names on the thrown object and its immediate cause, without traversing deeper causes. The combined signal identifies caller cancellation or the client's deadline, including during body reads. HTTP 401 and 403 remain `AUTHENTICATION_REQUIRED`; an envelope `code` of 403 behind HTTP 2xx remains `PERMISSION_DENIED`. The [diagnostic decision](../../../.agents/notes/implemented/bug-fix/2026-09-23-jubian-safe-transport-diagnostics.md) records the redaction trade-off and verification limits.

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
- **A stored token is repaired, never verified** — `trimBearerToken()` removes one trailing separator and one quote pair, and the package never tests the value against the provider, so a revoked-but-well-formed token is discovered only by the first real call.
- **The ledger detects a write, it does not lock one** — `begin()` reads the existing files before it appends, so two processes sharing one ledger root can both write a `begin` line for the same key; serializing writers is the caller's job.
- **Nothing reconciles the ledger automatically** — an intent line without a settle line stays unresolved until a caller or an operator reads the NDJSON files, and no surface lists those open records.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
