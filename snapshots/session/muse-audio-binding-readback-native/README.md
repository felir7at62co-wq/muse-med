---
description: "Keyless Native verification of persistent audio-reference names and original-key readback recovery."
kind: "reference"
---

# Audio binding and readback

English | [中文](README.zh.md)

The shipped Headless profile loads production Jubian through the ordinary Loader against an authenticated loopback HTTP fixture. Five Native calls preview two distinct audio references with the same display name, apply the reviewed fingerprint, independently read the card, then reconcile the original key after a changed name and an HTTP failure. Exactly one free `isGenerate: 0` PUT persists the fallback and explicit filenames while retaining the image, card identity, model settings and duration. The later calls only read; the original ledger bytes remain unchanged. Every complete actual result reaches the next model request, and an independent workspace proof records these observations. Controlled provider data does not establish listening, generated voice identity or media quality.

The [PTC sibling](../muse-audio-binding-readback-ptc/README.md) runs the same five operations through actual `tools.jubian_storyboard` dispatches.
