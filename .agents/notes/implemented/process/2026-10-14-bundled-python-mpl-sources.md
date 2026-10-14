# Agent Note: Bundled Python MPL source distribution

Status: implemented

English | [中文](2026-10-14-bundled-python-mpl-sources.zh.md)

## Problem

The offline RapidOCR dependency closure includes certificate data and progress utilities under file-level copyleft terms. Treating those terms as permissive would admit unrelated dependencies without reviewing redistribution obligations.

## Decision

The Python notices check accepts only `certifi 2026.7.22` under `MPL-2.0` and `tqdm 4.70.1` under `MPL-2.0 AND MIT`. This exception belongs to the bundled Python check; the npm runtime check continues to reject these identities and terms. A changed name, version or license requires another review.

The hash-verified wheels are extracted without modifying their Python source, certificate data, copyright notices or license files. The shared runtime carries those sources and distribution metadata in `dependencies/python-packages`. Recipients receive the covered source files directly, with their original terms and source-project links in [Third-Party Notices](../../../../THIRD_PARTY_NOTICES.md). The native runtime smoke checks that those materials remain present. The [Mozilla distribution guidance](https://www.mozilla.org/en-US/MPL/2.0/FAQ/) explains the source and notice obligations.

This decision does not supersede the independent [LibreOffice distribution decision](../architecture/2026-09-14-independent-libreoffice-kit.md); that exception applies to different packages and source carriers.

## Alternatives considered

**Classify MPL as permissive.** This weakens checks for every dependency and conceals the source obligations.

**Replace these upstream dependencies with local implementations.** This creates ownership of certificate updates and progress integration without removing a product limitation. Preserving the upstream sources meets the distribution requirements while retaining maintained packages.

## Consequences

Packaging retains readable sources and notices alongside the interpreter. Updating either reviewed dependency requires inspecting its wheel and terms again. Native libraries inside other wheels keep their own bundled licenses; the project-level Python table does not replace those files.
