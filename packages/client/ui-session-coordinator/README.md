---
description: "Retained Main Session navigation with native execution conversations and chat result reports."
kind: "package-reference"
---

# @deepseek-ai/dsh-client-ui-session-coordinator

English | [中文](README.zh.md)

## Summary

This optional UI plugin opens the retained Main Session and provides its sidebar entry. Execution conversations use native sidebar rows. Results return through Main Session chat messages; task bubbles do not occupy the conversation header or Session rows.

## Table of Contents

- [Use this package](#use-this-package)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)

## Use this package

Load beside the [coordination service](../../session/session-coordinator/README.md). The service owns task dispatch and completion receipts, including waking the Main Session to relay results. Open an execution conversation through its normal sidebar row to inspect the work.

Successful paired `coordinator_show_report` calls render task reports inline in their originating Turn, outside the folded process details. Their versioned result metadata retains task identity, revision, worker directory, status, report and delivered files for replay. Only current observations of that same assignment update the card; newer revisions, unavailable streams and removed tasks keep the recorded receipt with a historical label. Partial reports retain their shown and total counts.

Each report can open its execution conversation and delivery files. The open button appears only while the Session list contains that execution conversation, so a task that is waiting to start, or that stopped or failed before starting, has none. File previews use that worker's Session and directory, including relative paths. The report has no task-mutation buttons. Malformed, unsupported, nested and failed report results remain in the ordinary tool details without adding report cards. A report's identity includes its Turn so later model reuse of a call id does not replace earlier reports.

Cordis disposal releases registrations, resource streams, generated Remote bindings and action feedback. Re-enabling restores navigation without dispatching work or changing ordinary Sessions.

The retained Main conversation opens on startup when access is available and no user navigation or draft supersedes it. The Muse spider button sits below New Session, shares its left and right edges in the expanded sidebar, and returns to the Main conversation from another conversation. Ordinary Workspace lists omit that conversation but retain execution Sessions. Disabling this plugin removes the button and navigation registrations; re-enabling retains the same Main Session.

## Model Experience

### Main Session navigation

#### What the model sees

No additional model input. The coordination service owns `coordinator_show_report` results and worker receipts.

#### Token effect

Zero; navigating to a conversation does not call a model.

#### KV Cache effect

Zero; UI observations do not change Session history.

## Known Limitations and Deferred Work

- The coordination service owns worker completion reports; completion does not imply creative quality or human acceptance.

### Dev Note

Disabling removes the Main Session entry; the coordination ledger and execution Sessions retain their own owners.
