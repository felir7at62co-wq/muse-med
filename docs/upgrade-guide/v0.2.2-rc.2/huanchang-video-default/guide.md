---
kind: upgrade-guide
description: "Muse Desktop uses the Jingliu project workspace for new media production and retires the Jubian tools and conversation video selector."
---

# Muse Desktop media production

English | [中文](guide.zh.md)

## Change

Desktop opens Jingliu from the right sidebar. The selected Jingliu project owns its script, assets, shot settings, generation jobs and delivery. Desktop retires its built-in Jubian production tools and conversation video-model selector. Existing conversations, project files and downloaded media remain at their original locations. Previously submitted jobs belong to their original service.

## Migration

1. To follow an existing Jubian job, use the original service and its task ID. Save any media you want to carry into a Jingliu project.
2. Set `MUSE_JINGLIU_ORIGIN` to your Jingliu HTTPS origin and start Muse. Open **Jingliu** below **Browser** in the right sidebar and sign in. Local development can use an HTTP origin on a literal loopback address.
3. Open or create the intended Jingliu project. Import the files you need and choose its production settings in the studio. To use chat tools, run `/jingliu-login`, authorize in Feishu and run the command again in that conversation. Ask Muse to read the script of the named project to verify the connection.
