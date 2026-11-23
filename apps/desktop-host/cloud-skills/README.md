# Cloud skills

English | [中文](README.zh.md)

This directory holds skills that only the cloud Muse deployment adds, through `customSkillDirs` in its skill-filesystem configuration. It contains no skills at present, and Desktop never scans it. The cloud configuration lists it as a skill root, so it stays in the repository while empty. Cloud Bots receive their skills as DS Bot capabilities.

Skill discovery reads `SKILL.md` in each subdirectory and also reads top-level Markdown files as skills. This README has no skill frontmatter, so discovery skips it and logs a warning.
