# Agent Note: PowerShell child-process output encoding

Status: implemented

English | [中文](2026-09-27-pwsh-child-process-output-encoding.zh.md)

## Problem

A reviewed team session recorded 3,828 U+FFFD replacement characters in model-visible tool results: every Chinese line from those producers was unreadable to the model, and one line held 1,495 of them. Six of the eleven affected tool results were CPython output (3,243 characters); three were PowerShell's own parse-error text, where `所在位置 行:6` arrived as `����λ�� ��:6`.

The decode side owns one read at a time: `OutputCollector` turns the bytes of a single read — for a foreground command, the whole collected stdout — into one text ([output.ts](../../../../packages/subprocess/subprocess-local/src/output.ts)). One read is therefore the unit of encoding, and a read is not a producer: the field result that carried PowerShell's own `(未设置)` beside CPython's garbled `����: False` shows both producers' bytes arriving inside one tool result, where no single per-read rule recovers both.

The producer side was the gap. The UTF-8 preamble added for the Windows PowerShell 5.1 fallback pins `[Console]::OutputEncoding` and `$OutputEncoding` ([index.ts](../../../../packages/shell/pwsh-local/src/index.ts)), which governs PowerShell's own writers only: a native child process chooses the encoding of its redirected stdout/stderr itself, and on a CP936 host CPython took it from `locale.getpreferredencoding()`. Six of the eleven field results were exactly that case, and pinning the producer also restores the single-encoding read: when every producer writes UTF-8, a read holds one encoding again.

## Decision

`ENV_OVERRIDES` in [pwsh-local's entry](../../../../packages/shell/pwsh-local/src/index.ts) carries `PYTHONIOENCODING=utf-8`, so every command's child environment makes CPython write its three text streams in UTF-8, the encoding a collected read decodes as text. The environment belongs to the pwsh executor rather than to the subprocess service because the pwsh tool is where the defect was observed; `childEnv` in the subprocess layer serves every consumer on every platform (LSP stderr tails, PTC runtimes, git) and none of them reported it.

This change touches neither the preamble nor the collector, and the documented environment layering is unchanged: terminal overrides first, then the caller's `env`, then `dshEnv`, so an explicit `PYTHONIOENCODING` from a caller still outranks this default.

## Why the encoding is declared per producer

- `[Console]::OutputEncoding` and `chcp 65001` do not reach a redirected child. Measured on the reporting host shape (Windows, no PowerShell 7 install, active code page 936, Windows PowerShell 5.1 fallback): a CPython child reported `sys.stdout.encoding`/`sys.stderr.encoding` as `gbk gbk` with the preamble present or absent and after `chcp 65001`, and its bytes stayed CP936 in every combination. Both settings govern the console and PowerShell's own writers, not another process's stdio.
- PowerShell and a native child share one collected read. In a single command (`Write-Output "ps 中文测试 ✓"; python emit.py`) the collected stdout held PowerShell's UTF-8 bytes and CPython's CP936 bytes together, so one rule applied to that read cannot recover both halves: a code-page reading corrupts the PowerShell half, and a UTF-8 reading corrupts the CPython half. The read is not divisible by producer either — the collector concatenates the chunks it retained and keeps no producer boundary.
- `PYTHONIOENCODING` covers stdin, stdout, and stderr only. `PYTHONUTF8=1` (PEP 540 UTF-8 mode) would additionally change `open()`'s default encoding and the file-system encoding for every Python command the model runs, which changes user script behavior rather than repairing unreadable output.

## Testing

Measured through the real executor and the real collector, with `pwsh` resolving to `powershell.exe` 5.1 on the CP936 reporting host:

| Producer | Before | After |
|---|---|---|
| PowerShell `Write-Output "中文测试 ✓"` | 0 U+FFFD, exact | 0 U+FFFD, exact |
| `Get-ChildItem` under a Chinese path | 0 U+FFFD, exact | 0 U+FFFD, exact |
| CPython child stdout + stderr | 6 + 6 U+FFFD | 0 + 0 U+FFFD, exact |
| PowerShell and CPython in one command | one read, two encodings | 0 U+FFFD, exact on both halves |

[executor.spec.ts](../../../../packages/shell/pwsh-local/tests/executor.spec.ts) pins both directions. A pure test asserts the override reaches the spawn spec and that a caller entry still outranks it; a real-process test runs a CPython child through the executor and asserts the child reports `utf-8` for both text streams plus exact text, then forces `PYTHONIOENCODING=cp936` and asserts the child reports `cp936`. The encoding the child resolves is the mechanism this package owns, so the assertion does not depend on the subprocess layer's own decoding rules; deleting the override fails it on any host with CPython, not only on a code-page host.

## Deferred

PowerShell parses the entire `-Command` text before executing its first statement, so a command with a syntax error is reported before the preamble runs and nothing in this invocation is pinned. Reproduced on a console-attached Windows PowerShell 5.1 host: the parse-error stderr arrived as CP936 bytes (`所在位置 行:1`) with the preamble present or absent, byte-identical to the field's `����λ�� ��:6`. Runtime errors are unaffected, because their statement has already run. Covering parse errors needs either a `cmd /c chcp 65001` wrapper or deferring the command text past the initial parse (`Invoke-Expression`), and both change the documented one-argv-element invocation and the stderr text that the [Windows ACL sandbox](../feature/2026-08-08-windows-acl-restricted-token-sandbox.md) matches for runner-failure and denial classification. [pwsh-local's README](../../../../packages/shell/pwsh-local/README.md) records that this pin does not cover that text, so its encoding is whatever the subprocess layer's decode rule gives it.

## Alternatives considered

**Leave the encoding to a decode-side fallback.** Not adopted as the only fix: the read is the decode unit, and the field tool result above carries both producers' bytes inside one read, which no single per-read rule decodes. The producer pin is what makes the read uniformly UTF-8; a fallback remains the only place a stream no environment can pin (the parse error above) can be handled.

**Set `chcp 65001` in the preamble.** Rejected: measured to leave a redirected child's encoding untouched, and it mutates the console that the sandboxed path shares with the host.

**`PYTHONUTF8=1` instead of `PYTHONIOENCODING`.** Rejected: PEP 540 also changes `open()` defaults and file-system encoding, so it can break Python commands that read or write code-page files, while the defect is confined to the collected streams.

**Restructure command delivery to cover parse errors too.** Rejected for this change: a `cmd.exe` wrapper or `Invoke-Expression` delivery changes line and column reporting, the single-argv invocation that the [pwsh tool and executor decision](../../archived/feature/2026-08-01-pwsh-tool-and-executor.md) records, and the stderr that sandbox classification matches — a large blast radius for 415 of the field's 3,828 characters, and unverifiable without a console-attached host.

**Tombstone or translate code-page bytes at the tool layer.** Rejected: the tool layer receives text, not bytes, and could only guess at a mix that the producer-side pin eliminates at its source.

## Consequences

- CPython output from the `pwsh` tool is UTF-8 on code-page hosts, so a command that mixes it with PowerShell's own output is one encoding again; a caller who overrides the variable returns that producer to the host code page.
- The executor now carries one runtime-specific pin beside its renderer pins. A child of another runtime that follows the host code page (for example a .NET Framework console program) still needs its own pin, which a caller supplies through `env` or inside the command; the README states that limit for the model and for maintainers.
- The override is inert where the host already writes UTF-8 (pwsh 7, POSIX hosts), so no non-Chinese or binary output changes: the variable selects the encoding of CPython's text streams and leaves `sys.stdout.buffer` and binary payloads alone.
