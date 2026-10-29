# Source recovery snapshot

English | [中文](README.zh.md)

This keyless scenario uses a fixed local text, the normal `read` tool, the tool-result pruner, the current-Session `source_recover` tool, and normal `write` and `present` calls. It checks that recovery pages reconstruct the recorded result and do not add a system prompt section.

Recovery covers successful ordinary `read` events only. It does not recover shell or PTC output, image content, or characters omitted by the original read.
