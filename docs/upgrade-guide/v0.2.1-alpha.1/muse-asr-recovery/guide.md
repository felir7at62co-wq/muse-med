---
kind: upgrade-guide
description: "Cloud transcription recovery stops offering status polling for ended Flash requests whose original provider response cannot be queried."
---

# Muse transcription recovery

English | [中文](guide.zh.md)

## Change

Previously, an unresolved Flash receipt could offer repeated status calls even after its synchronous supplier request had ended. The gateway now reports safe `service_version`, `provider_diagnostic` and `recovery` metadata; the desktop tool retains those fields in each receipt and audio part. `recovery.next_action: inspect_receipt` with `capability: no_query` stops automatic polling and does not authorize another paid submission. A client transport error still requires gateway reconciliation before it establishes supplier uncertainty. Legacy receipts remain readable.

Unsubmitted queued jobs can move to available resources of the same service version. Submitted and uncertain jobs keep their original application, resource and task ID. Standard recognition continues querying the original provider task. ASR remains the preferred speech source; an accepted queue entry is not cancellation evidence or permission to duplicate recognition through OCR.

## Migration

1. Deploy the updated gateway and desktop together, following the [account gateway procedure](../../../../services/muse-accounts/README.md). Retain every resource definition referenced by existing receipts. Configure `requestRatePerMinute` in the private ASR configuration for the expected batch traffic; this does not increase supplier QPS or worker grants.
2. Preserve project `transcript/jobs/` receipts and their original IDs. Existing unresolved Flash jobs cannot be recovered by creating new IDs automatically. An explicitly requested new attempt may incur an additional charge.
3. Consumers of `audio_transcribe` results must follow `recovery.next_action` and retain the safe metadata. Call the original `resume_status` only when it is returned. For `poll_original`, query the original task; for `wait`, retain it; for `inspect_receipt`, report the unresolved response. `resume_upload` permits only an original-ID upload confirmed not submitted to the provider.
4. Confirm that a stopped Flash request returns `inspect_receipt` without a status retry, while a recoverable standard task retains its original query identity. Use the [transcription tool reference](../../../../packages/drama/tool-audio-transcribe/README.md) for queue and OCR allocation rules.
