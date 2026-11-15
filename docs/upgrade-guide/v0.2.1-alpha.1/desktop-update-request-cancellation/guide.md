---
kind: upgrade-guide
description: "Approved Desktop updates cancel active HTTP requests and pause Remote streams before installation."
---
# Desktop updates cancel active client requests

English | [中文](guide.zh.md)

## Change

After an update is approved, Desktop cancels existing HTTP client requests and pauses Remote socket streams before stopping the Host. In-process Remote streams must finish or close before installation can proceed. This can interrupt a read or download that previously continued during update preparation.

## Migration

1. Finish or save client operations before confirming installation. If an update fails and admission resumes, retry any interrupted client requests.
2. Client route and Remote stream implementations must handle cancellation and finish cleanup. Confirm an update does not proceed until in-flight handlers and socket stream iterators have settled.
