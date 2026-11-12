---
description: "Main Session task cards, execution-chat navigation and native file actions below the conversation title."
kind: "package-reference"
---

# @deepseek-ai/dsh-client-ui-session-coordinator

English | [中文](README.zh.md)

## Summary

This optional UI plugin shows authoritative task status, execution-chat navigation, native delivery files and Stop in Main Sessions. Compact task bubbles sit below the conversation title; the spider moves while work is running, and each bubble opens its task details. Ordinary conversations keep their native interface.

## Table of Contents

- [Use this package](#use-this-package)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)

## Use this package

Load beside the [coordination service](../../session/session-coordinator/README.md). Cards consume its owner-only Remote watch through `useResource`, without model polling. Native conversation navigation retains the execution context; file buttons open actual worker delivery paths through native file actions. Stop reports its request before the ledger confirms settlement.

Cordis disposal releases registrations, resource streams, generated Remote bindings and action feedback. Re-enabling reads retained tasks without dispatching work or changing ordinary Sessions.

The Muse spider button sits above New Session and opens the profile's retained Main conversation. Ordinary Workspace lists omit that conversation but retain execution Sessions. Disabling this plugin removes the button and cards together; re-enabling retains the same Main Session.

## Model Experience

### Visible tasks

#### What the model sees

No additional model input. The coordination service owns `coordinator_report` results and receipts.

#### Token effect

Zero; viewing and expanding cards never calls a model.

#### KV Cache effect

Zero; UI observations do not change Session history.

## Known Limitations and Deferred Work

- Cards report worker state and file declarations, not creative quality or human acceptance.

### Dev Note

Disabling removes the task overlay; the coordination ledger and execution Sessions retain their own owners.
