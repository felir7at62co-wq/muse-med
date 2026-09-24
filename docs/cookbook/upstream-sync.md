# Cookbook: syncing an upstream DSH release into the fork

English | [中文](upstream-sync.zh.md)

This checkout is a fork of DeepSeek Harness that carries the muse-med product, so an upstream move is a deliberate operation rather than a background `git pull`. The rehearsal and triage scripts make that operation repeatable: one answers what a merge would conflict on, the other answers who owns each decision. Run them on a schedule instead of waiting for a release to force the question.

The blocked failure this procedure prevents is a merge started without knowing its size. At the time of writing the pinned base is 2499 commits behind `origin/master`, and a rehearsal reports **77 conflicted files — 63 content, 14 modify/delete**. That number is the point: it is a morning of triage, not an unbounded integration.

## 1. Confirm the pin before reading any finding

```sh
pnpm exec tsx scripts/upstream-sync-rehearsal.ts
```

The rehearsal reads [`upstream.json`](../../upstream.json), re-derives the base with `git merge-base HEAD <ref>`, and **fails when the record and Git disagree**, naming both commits. A stale pin is the one way a rehearsal reports a finding about a move nobody is making, so treat that failure as the procedure's first step rather than an obstacle. `--ref` rehearses another branch; `--out` writes the JSON report.

## 2. Triage by owner

```sh
pnpm exec tsx scripts/upstream-sync-triage.ts --out .local/architecture/triage-record.json --markdown .local/architecture/triage-record.md
```

The triage classifies every conflict by which side owns the decision, using what each side holds rather than a list of filenames:

| Owner | Meaning | What to do |
|---|---|---|
| `product` | The fork keeps a file the upstream ref deleted. | Decide keep or drop, and say why. |
| `upstream` | The upstream ref keeps a file the fork deleted. | Accept the deletion or restore the file deliberately. |
| `own` | Both sides hold and edited the path. | Merge the two intentions. |
| `generated` | A declared generator writes the path. | Regenerate; never edit it to express a product fact. |

Both deletion owners are product decisions, not merge mechanics: Git reports the direction and leaves the file in the tree only for the `product` direction, so each path named there needs a human answer either way.

## 3. Keep generated outputs declared

[`scripts/upstream-sync-generated-paths.json`](../../scripts/upstream-sync-generated-paths.json) lists the paths a generator owns, beside the script that reads it. Extend it when a generator is added: no mechanical rule identifies a generated file reliably, because the generators write through locals, helpers, and computed paths, so the declaration is explicit and read literally. An absent manifest declares nothing; a manifest that names a missing file, or that puts two generators on one path, fails loudly rather than silently narrowing the generated set.

## 4. Never edit an upstream-owned generated file to express a product fact

A conflicted catalog is regenerated, not merged. The same rule applies outside a sync: a product fact belongs in product source, and the generator then carries it into the generated file. Editing `docs/tool-catalog.md` by hand loses the change at the next regeneration and hides where the fact actually lives.

## 5. Verify

```sh
pnpm exec tsx scripts/upstream-sync-rehearsal.ts
pnpm exec vitest run scripts/upstream-sync-rehearsal.spec.ts scripts/upstream-sync-triage.spec.ts --maxWorkers=1
```

Both scripts assert that the working tree and the ref set are byte-identical before and after, and both throw rather than report when that assertion fails: a rehearsal that mutated the repository would be a defect in the rehearsal, not a finding about the merge. Neither script writes a ref or a working-tree file, so running them is always safe.

An upstream move is complete when the pin in [`upstream.json`](../../upstream.json) names the new base, every conflicted path has been triaged, and the product still builds and packages. Record the new base in the same change that accepts it, so the next rehearsal compares against a base someone confirmed rather than the one Git happened to derive.
