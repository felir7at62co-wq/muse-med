# Agent Note: Diagnosing an unreadable Jubian response

Status: implemented

English | [中文](2026-09-28-jubian-unreadable-response-diagnostics.zh.md)

## Problem

Every failing Jubian read reported the same six words: `Jubian response did not match the expected envelope`. The 2026-09-27 field report listed `storyboard get`, `prepare_video`, `erase_subtitle`, `model preview`, `video task` and `organize index` failing that way while the same account's browser console showed the data, and the message could not say which of two different things had happened. The transport rejects a body it cannot read as an envelope; a reader in `@deepseek-ai/dsh-jubian-api` rejects a payload it cannot map. Both raise `CONTRACT_CHANGED` with no detail, so an operator cannot tell "the remote sent an array" from "the remote omitted `modelConfig`" — and the one nested detail that did survive, `Expected a JSON object`, came from `jubian_model`'s own `modelConfig` handling rather than from the envelope.

The same report showed the second failure mode: `organize index` refused a manifest whose ten rows all carried `name` and `type`, because the check reported only "an asset is missing name or type" — the same sentence whether the field was absent, blank, or present with a value that did not match one of the three category spellings.

## Decision

**A rejected body is described, never reproduced.** `describePayload()` and `describeUnparsed()` in `packages/jubian/jubian/src/diagnostic.ts` produce one line of structure: the top-level type, the own key names, the array length, the byte count and a bounded excerpt. Values behind a credential-named key become `[redacted]`, an absolute URL is reduced to its origin, long opaque runs are replaced, and strings, containers and nesting are capped. Every `CONTRACT_CHANGED` this client raises carries that description: not JSON, not valid UTF-8 (byte length and a hex prefix instead of text), a scalar top level, an object with no integer `code`, an unmapped application code, the byte cap, and an unreadable body.

**The envelope layouts are read, recorded and bounded.** `JubianResponse.envelope_layout` names what the body actually was. The two documented layouts keep their behavior. Four tolerated ones are accepted because a reader cannot recover a payload the transport refused: a success envelope in a one-element array, a payload object in a one-element array, a bare top-level array, and a payload that is itself a success envelope. A layout that states no code of its own reports `transport.application_code: null`, so the write ledger records `unknown` rather than `accepted` for it. A body that is JSON but none of these still fails.

**`DSH_JUBIAN_DEBUG_DUMP` is an operator's switch, not a default.** When it names a file, `request()` appends one redacted JSONL record per response — timestamp, method, path, HTTP status, application code, envelope layout, byte count, response hash and the redacted body — creating the directory as needed and using owner-only permissions where the platform honors them. It is off unless the variable is set, and no code path enables it. Every call is recorded rather than only `GET`s, because `subtasks` is a `POST` that only reads. Request headers are never read by the dump, and a dump failure never changes the call it observes.

**`organize index` names the entry and the field it rejected.** A manifest row failure reports its index, the fields it read, the observed value and the accepted spellings; a document-level failure describes the top-level structure it found. `type` additionally accepts the provider's own category numbers (`1`, `2`, `3`), which are the same three categories the convention names.

## Alternatives considered

**Put the body, or a truncated copy, in the error.** Rejected: a tool result reaches a model's context, and a provider body can carry a token, a signed URL or a long provider message. A structural description answers "what arrived" without ever carrying a value a caller did not ask for.

**Accept any JSON body as success and let the readers decide.** Rejected: it deletes the envelope check that catches a provider error page, and it would let a body with no `code` at all stand in for a verified success. The tolerated layouts are narrower — they must be one of the four named ones, and each is recorded.

**Unwrap a nested `{code, data}` payload unconditionally.** Rejected: a business payload may legitimately carry both keys. The unwrap happens only when the inner object states a success code, so the ambiguity is resolved by evidence rather than by shape.

**Thread the payload description into every reader in `@deepseek-ai/dsh-jubian-api`.** Deferred, not rejected: those readers do not hold the top-level payload at the point they refuse a field, so the change is a per-reader restructure of a second package with its own tests. Until then a reader-level rejection stays a bare envelope code, the README states that limitation, and the debug dump is the evidence path.

**Configure the dump through the tool row's `Config`.** Rejected: the response bytes and the credential boundary live in the transport, and a `Config` field would let a shipped `cordis.yml` enable payload capture without an operator asking for it in that process.

## Consequences

`packages/jubian/jubian/tests/envelope-layout.spec.ts` pins each layout, the nested unwrap, the description of a non-object body, of an undecodable body, and the absence of a token from a description. `packages/jubian/jubian/tests/debug-dump.spec.ts` pins that the switch writes nothing when unset, that it records a redacted line for a response nothing could read, and (on POSIX) the owner-only file mode. `packages/jubian/tool-jubian/tests/envelope-layout.spec.ts` pins the reported calls themselves: `storyboard get` over a documented envelope, over a one-element array and over a nested envelope, and a non-JSON body failing with the structure in the message. `packages/jubian/tool-jubian/tests/organize.spec.ts` pins the named-entry manifest failures and the numeric category spelling.

The cost is a wider acceptance set than the provider documents. The tolerated layouts are assumptions: no capture of a real Jubian response in these layouts exists in the repository, they are recorded so a capture can confirm or tighten each one, and the README's known limitations say so. The diagnostics describe structure and not values, so a payload whose defect is a wrong value rather than a missing field still needs the dump.
