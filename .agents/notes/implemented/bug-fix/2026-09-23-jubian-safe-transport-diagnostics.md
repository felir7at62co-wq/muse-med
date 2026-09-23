# Agent Note: Safe Jubian transport diagnostics

Status: implemented

English | [中文](2026-09-23-jubian-safe-transport-diagnostics.zh.md)

## Problem

`JubianClient` discarded transport failure categories and non-success HTTP status numbers. Its generic message could not distinguish DNS, connection, TLS, timeout or HTTP failures. Exposing original error text would risk leaking credentials, URLs and provider content into tool results.

## Decision

The client preserves `JubianError` codes and its existing optional-detail API. Failed HTTP responses contribute only their numeric status. Transport failures select package-authored text from exact code/name matches on the error or its immediate cause; unknown and deeper failures stay generic. The combined abort signal distinguishes caller cancellation from the client's deadline. The same classification covers response-body reads. Requests remain single-attempt.

## Alternatives considered

**Forward original messages or causes.** Rejected because transport errors can contain secrets and remote text; redacting known tokens cannot establish a safe output set.

**Retry or add new public error codes.** Rejected because diagnostics do not establish whether a write reached the provider, and existing callers already depend on the stable categories.

## Consequences

[Client tests](../../../../packages/jubian/jubian/tests/client.spec.ts) pin exact diagnostic text, HTTP code compatibility, direct and wrapped transport errors, arbitrary nested-secret redaction, cancellation, deadline handling and single-attempt behavior. Unknown codes and deeper causes deliberately provide less detail. No recorded-session or live-failure reproduction is included in this scoped client change. The reported four rapid failures and subsequent successful identical GETs do not establish their historical network cause; this change neither diagnoses nor claims to repair that incident.
