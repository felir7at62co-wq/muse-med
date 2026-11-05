---
kind: upgrade-guide
description: "GitHub package addresses resolve through HTTPS in pnpm 12, so SSH access requires a Git URL rewrite."
---

# GitHub plugin installation over SSH requires a Git rewrite

English | [中文](guide.zh.md)

## Change

The older Desktop package installer could select SSH from an explicit `git+ssh://` address. The bundled pnpm 12 resolves GitHub repositories through their HTTPS URLs, including when the address uses `git+ssh://` or `github:`. Users who access a private GitHub repository with an SSH key must configure Git for the account running Desktop. See [pnpm’s Git resolution rules](https://pnpm.io/package-sources#how-git-dependencies-are-resolved).

## Migration

1. In a terminal under the same account as Desktop, configure the rewrite for the repository's owner. Replace `OWNER` with the GitHub account or organization name.

   ```sh
   git config --global --add url."git@github.com:OWNER/".insteadOf "https://github.com/OWNER/"
   ```

2. Run `git ls-remote https://github.com/OWNER/REPO.git HEAD` with the actual owner and repository. Confirm that Git prints the commit hash for `HEAD`.
3. Retry installation in Desktop and confirm that the bundle appears in the installed list.
