---
description: "Keyless Native verification of local Skill publication, archive roundtrips and disabled installation records."
kind: "reference"
---

# Local Skill publication lifecycle

English | [中文](README.zh.md)

The shipped Headless profile loads the production Muse Market service and a private filesystem Skill through the ordinary Loader. Eight Native calls discover sources, prepare and export a publication, refuse a corrupt import, import the original archive again, inspect disabled installations, remove the record and inspect the empty installation list. The fixture tool forwards all six service methods; it encodes a void return as JSON null and preserves each public RemoteError field in the tool failure. Every complete actual result reaches the next model request.

The workspace proof checks the original SKILL.md frontmatter and every reference, script and binary resource byte, the archive SHA roundtrip, duplicate installation identity and disabled state. A rejected corrupt import leaves every stored file unchanged; removing the record retains the archive and leaves the source Skill unchanged. This scenario publishes locally without activating or executing the Skill or contacting a cloud service.

The [PTC sibling](../muse-skill-market-local-ptc/README.md) exercises the same lifecycle through actual programmatic tool dispatch.
