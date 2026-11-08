---
description: "Keyless authenticated Gateway pause supersession and producer-drain coverage."
kind: "reference"
---

# Gateway update pause supersession

English | [中文](README.zh.md)

The ordinary Loader and shipped Headless profile run a Native fixture tool against the production Gateway, Web server, Connection, access service and Typert registry. Authenticated loopback WebSockets invoke a declared stream service whose `next()` and `return()` operations have explicit release barriers.

After resume admits a replacement stream, releasing the old iterator's `return()` rejects the old pause as superseded while the replacement remains open. The next pause closes the replacement and waits for the still-running old producer's `next()` before resolving. The actual tool result enters the next model request, and `workspace.expected/gateway-pause-proof.json` records the verified observations. Model responses and producer timing are controlled fixture inputs; no external provider is contacted.
