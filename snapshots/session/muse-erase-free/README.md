# Verified free subtitle erasure snapshot

English | [中文](README.zh.md)

This authored Session runs the real Jubian tools through the shipped Headless profile with an isolated HTTP provider. It pins a unique live Fire catalogue row at `0 元/条`, a zero project budget, and a durable `0.00 CNY` intent before submission. Replaying the original key performs no HTTP requests; a fresh key after the price becomes positive is refused before another intent or submission. No manual authorization, real provider request, or actual billed cost is observed.

`session.v4.jsonl` is the canonical replay input; `writer.expected.jsonl` records current output. `workspace.expected/erase-free-proof.json` independently checks provider calls, ledger state and the model's receipt of every tool result.
