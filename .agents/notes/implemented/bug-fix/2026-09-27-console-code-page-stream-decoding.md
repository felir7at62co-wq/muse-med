# Agent Note: Console code page decoding for collected stream bytes

Status: implemented

English | [中文](2026-09-27-console-code-page-stream-decoding.zh.md)

## Problem

The reviewed team session recorded 3,828 U+FFFD replacement characters in model-visible tool results. Eight of the eleven affected results are the producer-side case covered by [the child-process encoding note](2026-09-27-pwsh-child-process-output-encoding.md); the other three — 415 characters — were PowerShell's own parse-error text, where `所在位置 行:6` arrived as `����λ�� ��:6`.

No environment can pin that stream. PowerShell parses the whole `-Command` text before running its first statement, so the `ENCODING_PREAMBLE` statement that pins `[Console]::OutputEncoding` has not executed when a parse error is written, and the error text arrives as console-code-page bytes. The same holds for any producer whose encoding no environment variable reaches.

Those bytes stopped existing one layer below the executor. `OutputCollector.readFrom` and `OutputCollector.finalize` decoded a read with `Buffer.toString('utf8')` ([output.ts](../../../../packages/subprocess/subprocess-local/src/output.ts)), and Node's non-fatal UTF-8 decoder writes one U+FFFD per malformed byte sequence. `SubprocessOutputReader` hands consumers text, so no later layer — the pwsh executor, the bash executor, the tool, the model — can recover the bytes. A decode-side repair therefore had exactly one possible home, and it is also the only layer that holds a complete read rather than one producer's share of it.

## Decision

[stream-decoding.ts](../../../../packages/subprocess/subprocess-local/src/stream-decoding.ts) decodes every collected read, and both collector read paths call it.

- Well-formed bytes decode with `Buffer.toString('utf8')` after an `isUtf8` check, so the previous decode is what runs, character for character, whenever the bytes were already valid UTF-8.
- Bytes that are not well-formed UTF-8 are decoded with the Windows ANSI code page, read once per process from `GetACP` through `extendWin32ProcessBindings`. That is the encoding a native Windows program writes to a redirected standard stream: 936 on the reporting host, 1252 on a Western one.
- Bytes that well-formed UTF-8 explains once a character split at an edge of the window is restored keep their replacement character.
- A host with no console code page (POSIX), a code page this runtime has no decoder for, and a code page that is already UTF-8 keep the replacement decode.

`consoleCodePageFallbacks` counts fallback decodes and records the code page of the most recent one, so remaining replacement characters can be attributed to a host rather than guessed at. The Win32 probe is lazy: a process that never reads a malformed stream never binds it.

Command construction is untouched. The argv, the single-element `-Command` delivery, the environment layering, and the `ENCODING_PREAMBLE` all stay exactly as they were, so the stderr text that the [Windows ACL sandbox](../feature/2026-08-08-windows-acl-restricted-token-sandbox.md) matches for runner-failure and denial classification is unchanged.

## Why a window edge is not a code page stream

The retained tail is byte-exact at the configured cap regardless of how the stream was chunked, and an incremental read starts and ends at pipe-chunk offsets, so a stream of well-formed UTF-8 reaches this decoder with a partial character at an edge. Such a slice is not valid UTF-8, and reading it as a code page would replace every character in the slice rather than the one that was cut: a 64 KB Chinese tail whose first character lost its lead byte would arrive as 64 KB of mojibake.

The decoder therefore recognizes the bytes an incomplete sequence can contribute — leading continuation bytes, and a trailing lead byte with fewer continuations than it announces — and keeps the replacement decode for a slice that well-formed UTF-8 explains once those are dropped. Only those bytes are dropped, so a code page stream whose leading bytes happen to look like a cut (`错: file not found`, whose CP936 bytes begin with a lead and a trail byte) is still decoded as the code page.

## Limits of the producer-side pin

[The producer-side pin](2026-09-27-pwsh-child-process-output-encoding.md) and this fallback cover different halves, and neither replaces the other.

- `PYTHONIOENCODING` reaches interpreters that read it, which is CPython and its derivatives. A native program of another runtime that follows the host code page — a .NET Framework console program, a code-page-aware CLI — is reached only by this fallback, which reads its bytes as the host code page and therefore cannot also serve a stream that mixes two encodings inside one read.
- The pin is exported into every command's child environment, so a user command that depends on the host code page sees a different encoding than it would without it: Python code that reads or writes CP936 files through its text streams, or that asserts on `sys.stdout.encoding`, behaves differently. Callers can override the variable per call, and `sys.stdout.buffer` plus file I/O keep their own defaults.
- The pin is inert but present on hosts that already write UTF-8 (pwsh 7, POSIX); this fallback is inert there too, because a well-formed read never consults it.

## Testing

Measured through the real collector and the real `decodeStreamText`, with `pwsh` resolving to `powershell.exe` 5.1 on the reporting host (Windows, no PowerShell 7, active code page 936):

| Producer | Before | After |
|---|---|---|
| PowerShell 5.1 stderr in the console code page | 10 U+FFFD | `所在位置 行:6 字符: 1`, 0 U+FFFD, one fallback decode at code page 936 |
| PowerShell 5.1 parse error, localized on this host | CP936 bytes | `语句块或类型定义中缺少右“}”。`, 0 U+FFFD, one fallback decode at code page 936 |
| PowerShell 5.1 parse error, ASCII-localized | 0 U+FFFD, exact | 0 U+FFFD, exact, zero fallback decodes |
| CPython child with `PYTHONIOENCODING=utf-8` | 0 U+FFFD, exact | 0 U+FFFD, exact |
| CPython child without the pin | 6 U+FFFD in a UTF-8 read | 0 U+FFFD through the fallback |

[stream-decoding.spec.ts](../../../../packages/subprocess/subprocess-local/tests/stream-decoding.spec.ts) pins the rule: the CP936 bytes of `所在位置 行:6 字符: 1` decode to that text with zero replacement characters, well-formed samples decode character for character with the fallback counter unchanged, a slice that no fallback exists for keeps the replacement decode, and a read holding nothing but split characters keeps it too. The console code page is injected in those tests, so they run on every host; a Windows-only test additionally runs the production path with no injection. Two tests drive the real `OutputCollector` through `readFrom` and `finalize`: the byte-exact cut tail, and the CP936 stream on a host whose code page is 936.

Deleting the decode wiring fails the collector test that asserts the CP936 stream, and fails nothing else, which is what makes the pair meaningful. The pwsh-local suites pass unchanged (45 passed, 1 skipped, 1 environment failure: the symlink fixture cannot create a link here). `spawn.spec.ts`'s own OutputCollector tests pass on this host when run outside the platform exclusions that skip that POSIX suite on Windows; its three failures there (`taskkill`, an EPERM group probe) reproduce with the decode wiring removed. The sandbox suites keep their single environment failure (a test expecting a `pwsh` argv[0] on a host that only has `powershell.exe`), and the denial-matching suites — `diagnostics.spec.ts`, `escalation.spec.ts`, `provider-chain.spec.ts` — pass 36 of 36.

## Deferred

- **A split character still decodes alone.** An incremental read that holds only the middle of one character has no complete character to keep, so it keeps its replacement character until the next read. Decoding a stream across reads needs the collector to hold back an incomplete tail, which changes what `readFrom` returns and the offsets consumers resume from.
- **Only the ANSI code page is re-read.** A stream in the OEM code page of a differently configured console, and the code page of a host whose console differs from its ANSI default, keep the UTF-8 reading.
- **Bytes that are valid UTF-8 under another encoding stay wrong.** Well-formed UTF-8 is what the decode rule trusts; a CP936 stream whose bytes happen to form valid UTF-8 (many two-byte CP936 characters do) is indistinguishable from text and is not repaired.
- **Only text reaches the fallback.** A binary payload in a collected stream is decoded as the console code page where it was previously decoded as UTF-8; both readings are lossy, and neither is a payload path.

## Alternatives considered

**Wrap the command so the preamble runs before the parse.** Rejected: `cmd /c chcp 65001` and an `Invoke-Expression` delivery both change the documented one-argv-element invocation and the stderr text that sandbox denial classification matches, and the tool's own README and the [pwsh tool and executor decision](../../archived/feature/2026-08-01-pwsh-tool-and-executor.md) record that invocation. 415 characters do not justify that risk.

**Decode in the pwsh executor rather than in the collector.** Rejected: the executor receives text, not bytes. `SubprocessOutputReader.readFrom` returns `text`, so any decode placed there would run after `toString('utf8')` had already replaced the malformed sequences.

**Decode the spill file to recover the bytes.** Rejected: the spill file exists only when a stream exceeds the in-memory cap, holds the same already-decoded stream, and reading it back would add a file read to an in-memory path.

**Try every candidate code page and pick the most plausible.** Rejected: nothing in the bytes ranks two legacy readings against each other, and the host already states which one its native programs write.

## Consequences

- PowerShell's own parse-error text is readable on a code-page host, so the class of stream that no environment variable can reach now survives the collector; this closes the gap [the producer-side note](2026-09-27-pwsh-child-process-output-encoding.md) recorded as unaddressed.
- That note states that its change touches neither the preamble nor the collector. Its preamble clause still holds; the collector half of that sentence is superseded by this note, which changes what the collector does with a malformed read.
- Every consumer of the subprocess seam inherits the rule, not only the pwsh tool: `bash-local` on Windows, LSP stderr tails, and the PTC runtime read text from the same collector. On POSIX hosts and on well-formed streams the decoded text is unchanged.
- The decode path now depends on a Win32 binding in a file that previously had none. It is bound lazily, on the first malformed read, and a host where the binding fails keeps the replacement decode rather than failing the read.
- The fallback is recorded rather than silent: `consoleCodePageFallbacks` counts it, so a later session review can tell a host-code-page recovery from a stream that was never malformed.
