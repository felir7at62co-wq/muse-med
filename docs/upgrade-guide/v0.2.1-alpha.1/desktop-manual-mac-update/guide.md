---
kind: upgrade-guide
description: "Mac installers without a Developer ID use a verified manual installation path instead of native Squirrel replacement."
---

# Mac update installation

English | [中文](guide.zh.md)

## Change

Mac packages built without a Developer ID receive a complete ad-hoc bundle signature and a sealed manual-installation mode. Their updater verifies the downloaded DMG and the contained application, then opens the installer after installation confirmation and the normal running-task check. The user replaces the application in Applications. Developer ID packages continue to use native Squirrel signature verification and replacement.

Muse 1.0.2 packages that lack a complete bundle resource seal cannot acquire this migration through their existing native updater. Its requirement is tied to the old executable signature, so a newly sealed ad-hoc bundle needs a one-time manual installation. See [Desktop installer behavior](../../../../apps/desktop/README.md#unsigned-installers).

## Migration

1. Download the new Mac ARM DMG from the official release. Confirm its published checksum before installation.
2. Finish or save current work and quit Muse. Open the DMG and replace the existing Muse application in Applications; retain the user data directory.
3. Open the installed application and check its version. The account gateway may require another login independently of this installation.
4. For later manual-mode updates, approve the download and installation separately. Follow the prompt to replace the app after the verified installer opens; a download alone does not replace it.
5. If verification fails, retain the failure details and download a fresh official installer. Do not alter signed resources or disable native signature checks.
