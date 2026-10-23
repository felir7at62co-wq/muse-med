# Private remote-wire codec preparation

`remote_wire.py` is an owned, socket-free analysis module built from field facts in `../../remote-debug-wire-facts.json`. It does not import or execute the extracted JavaScript, open connections, evaluate received scripts, start a controller, authenticate an AppID, or call wx/native business APIs. No active bridge is implemented by this module.

Use a prepared interpreter with the platform dependency lock from the native directory; no global installation is required. The tested environment is Python3.14.8 / google.protobuf7.36.2. The module explicitly rejects invalid UTF-8 retained as byte values by proto2 implementations. It builds private dynamic descriptors using maintained google.protobuf; it does not implement protobuf varints or copy a generated Tencent codec.

## API

- `encode_frame(category, payload, *, seq=0, after=0, compress_algo=0) -> bytes`: payload is a mapping using protobuf field spelling. For a Chrome message use `opId`, `payload` (CDP JSON text), `jscontextId`. Outer seq, inner opId and CDP JSON id are independent. opId preserves the uint64 range.
- `decode_frame(bytes) -> DecodedFrame`: `.outer` contains seq, after, category, data, compress_algo, original_size; `.payload` is a dynamic protobuf message. Unknown categories fail explicitly. `.outer.data` remains compressed wire data when compression=1; use the parsed payload rather than guessing its encoding.
- `decode_outer(bytes) -> OuterFrame`: validates envelope and bounded decompression, including unknown categories for passive observation; it does not guess an inner message or execute data.
- `get_context_metadata(frame) -> ContextMetadata | None`: returns an explicit nonempty context id and, for addJsContext, its display name. Empty/overlong ids return None. No fallback/default context, AppID inference, or selection occurs.
- `get_setup_metadata(frame) -> SetupMetadata | None`: returns compression capability, registered object/method names and a has_configure_js boolean. It omits device values and script contents. configureJs is only parsed as text, never executed.
- `WireError`: malformed/truncated protobuf, invalid UTF8, unsupported categories/flags and local limits become this error. The codec performs no logging.

Supported exact categories: chromeDevtools, chromeDevtoolsResult, addJsContext, removeJsContext, connectJsContext, setupContext. Setup includes independently authored descriptors for RegisterInterface, MethodWithArgs and DeviceInfo using the recorded field numbers/types.

## Deliberate supported subset

Inner and decompressed body maximum4MiB; wire data maximum4MiB; frame maximum4MiB+1024; category1–64UTF8 bytes. Numeric outer fields must fit uint32, including original wire varints that protobuf's uint32 parser could otherwise truncate; a second dynamic uint64 parser view enforces this without a handwritten wire parser. Duplicate numeric outer fields are rejected as ambiguous. Unknown outer field numbers are skipped by protobuf.

Compression0 writer emits originalSize=0 as the reference wrapper does. The incoming reader treats originalSize as informational when compression=0 and ignores it after the existing uint32/size cap; no native-producer zero-header assumption is imposed. Compression1 is zlib-framed deflate/inflate and requires originalSize to equal the actual decompressed length; decompression is output-limited before allocation can exceed4MiB+1. Truncated/concatenated/trailing streams and unknown compression flag bits are rejected. These are explicit local resource/format choices, not a claim that every production peer has been observed using them.

## Verification

`./venv-mac/bin/python -m unittest -v test_remote_wire.py`:22tests passed, exit0; log `wire-unittest.log`. Tests use synthetic binary fixtures and independently described protobuf frames, including exact field tags, uint64 precision, setup/context metadata, compression boundaries/bombs, malformed/truncated/invalidUTF8 payloads, outer uint32 overflow, unknown flags and cleanup-free operation. `./venv-mac/bin/python -m py_compile remote_wire.py test_remote_wire.py` also passed. First test execution caught pure-Python protobuf raising UnicodeDecodeError rather than DecodeError for invalid UTF8; both are now normalized and regression-tested.

No runtime25560 wire compatibility, handshake/heartbeat requirement, sequence timing, context authentication or active operation has been established by these tests. See `wire-preparation-receipt.json` for owned-file hashes and environment evidence.
