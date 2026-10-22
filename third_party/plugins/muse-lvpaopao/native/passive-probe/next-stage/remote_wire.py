"""Owned, socket-free protobuf codec for the recorded remote-debug field facts.

This analysis module uses google.protobuf dynamic descriptors. It does not import
the upstream implementation, open transports, evaluate received scripts, or
authenticate a JavaScript context. All lengths below are local resource limits,
not claims about undocumented peer limits. Protocol facts and source hashes live
in ../../remote-debug-wire-facts.json.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Mapping
import zlib

from google.protobuf import descriptor_pb2, descriptor_pool, message_factory
from google.protobuf.message import DecodeError, Message


CATEGORY_CHROME_DEVTOOLS = "chromeDevtools"
CATEGORY_CHROME_DEVTOOLS_RESULT = "chromeDevtoolsResult"
CATEGORY_ADD_JS_CONTEXT = "addJsContext"
CATEGORY_REMOVE_JS_CONTEXT = "removeJsContext"
CATEGORY_CONNECT_JS_CONTEXT = "connectJsContext"
CATEGORY_SETUP_CONTEXT = "setupContext"

COMPRESSION_NONE = 0
COMPRESSION_ZLIB = 1
MAX_PAYLOAD_BYTES = 4 * 1024 * 1024
MAX_DATA_BYTES = MAX_PAYLOAD_BYTES
MAX_FRAME_BYTES = MAX_DATA_BYTES + 1024
MAX_CATEGORY_BYTES = 64
MAX_CONTEXT_ID_BYTES = 4096
UINT32_MAX = (1 << 32) - 1


class WireError(ValueError):
    """A frame exceeds the owned codec's supported fields or resource limits."""


def _message_types() -> dict[str, type[Message]]:
    """Build private dynamic descriptors from field numbers, without JS code."""
    fd = descriptor_pb2.FileDescriptorProto()
    fd.name = "muse_probe_remote_wire.proto"
    fd.package = "muse_probe_wire"
    fd.syntax = "proto2"
    field = descriptor_pb2.FieldDescriptorProto

    def add(name: str, definitions: tuple[tuple, ...]) -> None:
        msg = fd.message_type.add(name=name)
        for number, name_, type_, repeated, nested in definitions:
            item = msg.field.add(
                number=number,
                name=name_,
                type=type_,
                label=field.LABEL_REPEATED if repeated else field.LABEL_OPTIONAL,
            )
            if nested:
                item.type_name = ".muse_probe_wire." + nested

    outer = (
        (1, "seq", field.TYPE_UINT32, False, None),
        (2, "after", field.TYPE_UINT32, False, None),
        (3, "category", field.TYPE_STRING, False, None),
        (4, "data", field.TYPE_BYTES, False, None),
        (5, "compressAlgo", field.TYPE_UINT32, False, None),
        (6, "originalSize", field.TYPE_UINT32, False, None),
    )
    add("DebugMessage", outer)
    # uint32 parsers may truncate oversized varints. A second maintained-parser
    # view checks every numeric occurrence at uint64 width before accepting it.
    add("OuterBounds", tuple(
        (number, name, field.TYPE_UINT64, True, None)
        for number, name, type_, _, _ in outer if type_ == field.TYPE_UINT32
    ))
    chrome = (
        (1, "opId", field.TYPE_UINT64, False, None),
        (2, "payload", field.TYPE_STRING, False, None),
        (3, "jscontextId", field.TYPE_STRING, False, None),
    )
    add("ChromeDevtools", chrome)
    add("ChromeDevtoolsResult", chrome)
    add("AddJsContext", (
        (1, "jscontextId", field.TYPE_STRING, False, None),
        (2, "jscontextName", field.TYPE_STRING, False, None),
    ))
    for name in ("RemoveJsContext", "ConnectJsContext"):
        add(name, ((1, "jscontextId", field.TYPE_STRING, False, None),))
    add("MethodWithArgs", (
        (1, "methodName", field.TYPE_STRING, False, None),
        (2, "methodArgList", field.TYPE_STRING, True, None),
    ))
    add("RegisterInterface", (
        (1, "objName", field.TYPE_STRING, False, None),
        (2, "objMethodList", field.TYPE_MESSAGE, True, "MethodWithArgs"),
    ))
    add("DeviceInfo", (
        (1, "deviceName", field.TYPE_STRING, False, None),
        (2, "deviceModel", field.TYPE_STRING, False, None),
        (3, "systemVersion", field.TYPE_STRING, False, None),
        (4, "wechatVersion", field.TYPE_STRING, False, None),
        (5, "publibVersion", field.TYPE_UINT32, False, None),
        (6, "screenWidth", field.TYPE_FLOAT, False, None),
        (7, "pixelRatio", field.TYPE_FLOAT, False, None),
        (8, "userAgent", field.TYPE_STRING, False, None),
    ))
    add("SetupContext", (
        (1, "registerInterface", field.TYPE_MESSAGE, False, "RegisterInterface"),
        (2, "deviceInfo", field.TYPE_MESSAGE, False, "DeviceInfo"),
        (3, "configureJs", field.TYPE_STRING, False, None),
        (4, "publicJsMd5", field.TYPE_STRING, False, None),
        (5, "threeJsMd5", field.TYPE_STRING, False, None),
        (6, "supportCompressAlgo", field.TYPE_UINT32, False, None),
    ))
    pool = descriptor_pool.DescriptorPool()
    pool.Add(fd)
    return {
        msg.name: message_factory.GetMessageClass(
            pool.FindMessageTypeByName("muse_probe_wire." + msg.name)
        ) for msg in fd.message_type
    }


_TYPES = _message_types()
_PAYLOAD_TYPES = {
    CATEGORY_CHROME_DEVTOOLS: "ChromeDevtools",
    CATEGORY_CHROME_DEVTOOLS_RESULT: "ChromeDevtoolsResult",
    CATEGORY_ADD_JS_CONTEXT: "AddJsContext",
    CATEGORY_REMOVE_JS_CONTEXT: "RemoveJsContext",
    CATEGORY_CONNECT_JS_CONTEXT: "ConnectJsContext",
    CATEGORY_SETUP_CONTEXT: "SetupContext",
}


@dataclass(frozen=True)
class OuterFrame:
    """Validated envelope; data is still the wire representation of its body."""

    seq: int
    after: int
    category: str
    data: bytes
    compress_algo: int
    original_size: int


@dataclass(frozen=True)
class DecodedFrame:
    """Envelope and parsed body; neither establishes an authenticated AppID."""

    outer: OuterFrame
    payload: Message


@dataclass(frozen=True)
class ContextMetadata:
    """Context id/name only; name is never used as an AppID authorization test."""

    category: str
    context_id: str
    context_name: str | None


@dataclass(frozen=True)
class SetupMetadata:
    """Script-free setup summary that omits device identifiers and source text."""

    support_compress_algo: int
    registered_object: str
    method_names: tuple[str, ...]
    has_configure_js: bool


def _parse(type_name: str, raw: bytes) -> Message:
    value = _TYPES[type_name]()
    try:
        value.ParseFromString(raw)
        # Proto2 implementations can retain invalid UTF-8 strings as bytes.
        for field, item in value.ListFields():
            if field.type == field.TYPE_STRING:
                strings = item if field.is_repeated else (item,)
                if not all(isinstance(text, str) for text in strings):
                    raise UnicodeError("invalid protobuf UTF-8")
    except (DecodeError, UnicodeError) as error:
        raise WireError("malformed or truncated protobuf message") from error
    return value


def _uint32(value: int, name: str) -> None:
    if type(value) is not int or not 0 <= value <= UINT32_MAX:
        raise WireError(name + " must be a uint32")


def _body_bytes(outer: OuterFrame) -> bytes:
    if outer.compress_algo == COMPRESSION_NONE:
        # Reference writers emit zero, but readers do not use this informational
        # field when compression is disabled. Its resource cap is checked above.
        return outer.data
    if outer.compress_algo != COMPRESSION_ZLIB:
        raise WireError("unsupported compression flags")
    decoder = zlib.decompressobj()
    try:
        body = decoder.decompress(outer.data, MAX_PAYLOAD_BYTES + 1)
    except zlib.error as error:
        raise WireError("invalid zlib data") from error
    if len(body) > MAX_PAYLOAD_BYTES or decoder.unconsumed_tail:
        raise WireError("decompressed body exceeds 4 MiB")
    if not decoder.eof:
        raise WireError("truncated zlib stream")
    if decoder.unused_data:
        raise WireError("trailing bytes or concatenated zlib streams")
    if len(body) != outer.original_size:
        raise WireError("originalSize does not match decompressed body")
    return body


def _read_outer(frame: bytes) -> tuple[OuterFrame, bytes]:
    if not isinstance(frame, bytes):
        raise WireError("frame must be bytes")
    if len(frame) > MAX_FRAME_BYTES:
        raise WireError("outer frame exceeds size limit")
    parsed = _parse("DebugMessage", frame)
    bounds = _parse("OuterBounds", frame)
    for name in ("seq", "after", "compressAlgo", "originalSize"):
        values = getattr(bounds, name)
        if len(values) > 1:
            raise WireError("duplicate outer numeric field: " + name)
        if bool(values) != parsed.HasField(name):
            raise WireError("invalid wire type for outer numeric field: " + name)
        for value in values:
            _uint32(value, name)
    if not parsed.category or len(parsed.category.encode("utf-8")) > MAX_CATEGORY_BYTES:
        raise WireError("category must contain 1 to 64 UTF-8 bytes")
    if len(parsed.data) > MAX_DATA_BYTES:
        raise WireError("outer data exceeds 4 MiB")
    if parsed.originalSize > MAX_PAYLOAD_BYTES:
        raise WireError("originalSize exceeds 4 MiB")
    outer = OuterFrame(
        parsed.seq, parsed.after, parsed.category, bytes(parsed.data),
        parsed.compressAlgo, parsed.originalSize,
    )
    return outer, _body_bytes(outer)


def decode_outer(frame: bytes) -> OuterFrame:
    """Validate a bounded envelope, including compression, without guessing type."""
    outer, _ = _read_outer(frame)
    return outer


def decode_frame(frame: bytes) -> DecodedFrame:
    """Decode one supported category; unknown categories fail without evaluation."""
    outer, body = _read_outer(frame)
    type_name = _PAYLOAD_TYPES.get(outer.category)
    if type_name is None:
        raise WireError("unsupported category")
    return DecodedFrame(outer, _parse(type_name, body))


def encode_frame(
    category: str,
    payload: Mapping[str, object],
    *,
    seq: int = 0,
    after: int = 0,
    compress_algo: int = COMPRESSION_NONE,
) -> bytes:
    """Encode independently authored field values; no socket or peer operation."""
    type_name = _PAYLOAD_TYPES.get(category)
    if type_name is None:
        raise WireError("unsupported category")
    _uint32(seq, "seq")
    _uint32(after, "after")
    if type(compress_algo) is not int or compress_algo not in (0, 1):
        raise WireError("unsupported compression flags")
    try:
        inner = _TYPES[type_name](**payload).SerializeToString(deterministic=True)
    except (TypeError, ValueError, OverflowError) as error:
        raise WireError("invalid inner fields") from error
    if len(inner) > MAX_PAYLOAD_BYTES:
        raise WireError("inner body exceeds 4 MiB")
    data = zlib.compress(inner) if compress_algo == COMPRESSION_ZLIB else inner
    if len(data) > MAX_DATA_BYTES:
        raise WireError("encoded data exceeds 4 MiB")
    outer = _TYPES["DebugMessage"](
        seq=seq, after=after, category=category, data=data,
        compressAlgo=compress_algo,
        originalSize=len(inner) if compress_algo == COMPRESSION_ZLIB else 0,
    )
    encoded = outer.SerializeToString(deterministic=True)
    if len(encoded) > MAX_FRAME_BYTES:
        raise WireError("outer frame exceeds size limit")
    return encoded


def get_context_metadata(frame: DecodedFrame) -> ContextMetadata | None:
    """Read nonempty bounded context metadata; do not infer or approve AppIDs."""
    if frame.outer.category not in (
        CATEGORY_ADD_JS_CONTEXT, CATEGORY_REMOVE_JS_CONTEXT,
        CATEGORY_CONNECT_JS_CONTEXT, CATEGORY_CHROME_DEVTOOLS,
        CATEGORY_CHROME_DEVTOOLS_RESULT,
    ):
        return None
    context_id = frame.payload.jscontextId
    if not context_id or len(context_id.encode("utf-8")) > MAX_CONTEXT_ID_BYTES:
        return None
    name = frame.payload.jscontextName if frame.outer.category == CATEGORY_ADD_JS_CONTEXT else None
    return ContextMetadata(frame.outer.category, context_id, name)


def get_setup_metadata(frame: DecodedFrame) -> SetupMetadata | None:
    """Return registration/compression metadata without scripts or device values."""
    if frame.outer.category != CATEGORY_SETUP_CONTEXT:
        return None
    value = frame.payload
    return SetupMetadata(
        value.supportCompressAlgo,
        value.registerInterface.objName,
        tuple(method.methodName for method in value.registerInterface.objMethodList),
        bool(value.configureJs),
    )
