# English editing intent and a verified receipt

English | [中文](README.zh.md)

This keyless Headless scenario starts with “Edit the screenplay and give me a Word file.” An undeclared `present` must return `MANUSCRIPT_DELIVERY_REQUIRED`. A later prose-only file claim receives the logged missing-receipt reminder. The writer then performs actual file writes and reads, compares separate original and candidate files in a native review, declares reviewed delivery and presents with the returned label.

The fixture checks the exact human requirement in the child review, one recovery reminder, one successful presentation, file bytes and the complete delivery ledger. It uses Markdown candidates and explicitly reports that limitation. It verifies editing intent, comparison and receipt behavior; it does not claim Word export or creative acceptance.

Production manuscript and delivery services run through the shipped Headless profile. The model provider replays authored responses without real-model fallback. A fixture-only built-library override permits a bounded regression control using an isolated copy; it never changes the shipping library or historical fixtures.
