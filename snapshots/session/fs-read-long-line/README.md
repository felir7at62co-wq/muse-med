# Long-line read snapshot

English | [中文](README.zh.md)

This keyless headless scenario reads a streamed CRLF text file containing a line longer than the default limit, follows the line and Unicode code-point column cursors, and writes and presents the reconstructed text. The checked-in LF seed is converted to CRLF before the first read and restored after the checks. Its fixture compares each recorded cursor with the next call and checks the SHA-256 of the concatenated content and saved delivery. The delivered text uses the read tool's LF normalization and does not claim to preserve the source file's original bytes.
