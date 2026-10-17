---
kind: upgrade-guide
description: "Todo tool success text changes from a counts sentence to a JSON progress result."
---

# Todo progress results

English | [中文](guide.zh.md)

## Change

The successful model-visible result of `todo_write` is JSON text containing `todos`, `counts`, `current`, `next`, and `reminder`, replacing the fixed counts sentence. Consumers that parse the old sentence must change. The new `todo_update` tool returns the same fields after changing one task. The `todo/write` event and its item fields are unchanged.

## Migration

1. Parse successful Todo result text as JSON instead of matching the old sentence. Use `counts` for totals, `current` for active task texts, and nullable `next` for the first pending task. Treat `reminder` as advisory text.
2. Keep reading complete lists from `todo/write` for durable task state. For `todo_update` calls, use the successful result's `todos` to render the complete list; its arguments identify only one task.
3. Verify that completing one task with `start_next: true` preserves the remaining list and starts at most one pending task. Existing sessions require no data migration.
