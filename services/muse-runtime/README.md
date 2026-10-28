---
description: "Graceful admission closure for the separately deployed Muse workroom broker."
kind: "reference"
---

# Muse runtime broker

English | [中文](README.zh.md)

`graceful-shutdown.mjs` closes the HTTP server before awaiting accepted operations. The caller synchronously rejects further requests, supplies all pending ensure promises and the serialized operation tail, and awaits completion after SIGTERM or SIGINT. This includes administrator stop requests. The module never kills a container or exits the process; a hung operation keeps shutdown incomplete.

The deployed broker remains a separately reviewed server source. A release imports this module through a hash-bound derived broker file and records both hashes in its deployment manifest. The Desktop build does not launch this service.

Run the isolated HTTP lifecycle tests with `node --test services/muse-runtime/tests/graceful-shutdown.test.mjs`.
