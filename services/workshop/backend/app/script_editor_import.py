"""Validate materials submitted to the native script editor."""

import base64
import io
import json
from pathlib import PurePath
import re
from uuid import UUID
from zipfile import BadZipFile, ZipFile
from zlib import error as ZipCompressionError

from pydantic import BaseModel, ConfigDict, Field

from .script_library import MAX_EPISODE_CHARS, MAX_EPISODES
from .stages.import_script import smart_split_chapters

MAX_IMPORT_BYTES = 4 * 1024 * 1024
MAX_STORYBOARD_CHARS = 500_000
_MAX_DOCX_ENTRIES = 512
_MAX_DOCX_UNCOMPRESSED_BYTES = 24 * 1024 * 1024
_EPISODE_HEADING = re.compile(r"(?m)^[ \t]*第[ \t]*[一二三四五六七八九十百千零壹贰叁肆伍陆柒捌玖\d]+[ \t]*[集章节话回幕场]")


class ImportEpisode(BaseModel):
    """One imported episode with text, structured scenes, or both."""

    model_config = ConfigDict(extra="forbid")

    title: str | None = Field(default=None, max_length=200)
    content: str | None = Field(default=None, max_length=MAX_EPISODE_CHARS)
    shots_json: str | None = Field(default=None, max_length=MAX_STORYBOARD_CHARS, alias="shotsJson")


class ImportFile(BaseModel):
    """A Word or text source sent with the editor request."""

    model_config = ConfigDict(extra="forbid")

    filename: str = Field(min_length=1, max_length=255)
    base64: str = Field(min_length=1, max_length=((MAX_IMPORT_BYTES + 2) // 3) * 4)


class CreateDraftBody(BaseModel):
    """Create an owned draft and optionally populate its episodes."""

    model_config = ConfigDict(extra="forbid")

    title: str = Field(min_length=1, max_length=200)
    episode_count: int | None = Field(default=None, ge=1, le=MAX_EPISODES, alias="episodeCount")
    episodes: list[ImportEpisode] | None = Field(default=None, min_length=1, max_length=MAX_EPISODES)
    file: ImportFile | None = None
    request_id: UUID | None = Field(default=None, alias="requestId")


def validate_editor_text(text: str) -> str:
    """Check that input can be saved unchanged and rendered in Word.

    @param text — Text from JSON or an imported file.
    @returns The original text.
    """
    if re.search(r"[\x00-\x08\x0b\x0c\x0e-\x1f\ud800-\udfff\ufffe\uffff]", text):
        raise ValueError("文字含有无法保存或导出的字符。")
    return text


def parse_shots(shots_json: str) -> list[dict]:
    """Read the editor’s structured screenplay without discarding additional fields.

    @param shots_json — A serialized array of shot objects.
    @returns Validated shot objects in source order.
    """
    try:
        shots = json.loads(shots_json)
        if not isinstance(shots, list) or any(not isinstance(shot, dict) for shot in shots):
            raise ValueError("Shot data must be an array of objects")
        json.dumps(shots, allow_nan=False)
        pending = [(shots, 0)]
        while pending:
            value, depth = pending.pop()
            if depth > 40:
                raise ValueError("Shot data is nested too deeply")
            if isinstance(value, dict):
                for key, child in value.items():
                    validate_editor_text(key)
                    pending.append((child, depth + 1))
            elif isinstance(value, list):
                pending.extend((child, depth + 1) for child in value)
            elif isinstance(value, str):
                validate_editor_text(value)
    except (RecursionError, ValueError) as error:
        raise ValueError("结构化分场稿必须是有效的镜头对象数组。") from error
    return shots


def _word_text(data: bytes) -> str:
    from docx import Document
    from docx.opc.exceptions import PackageNotFoundError
    from lxml.etree import XMLSyntaxError

    try:
        with ZipFile(io.BytesIO(data)) as archive:
            entries = archive.infolist()
            if (
                len(entries) > _MAX_DOCX_ENTRIES
                or sum(entry.file_size for entry in entries) > _MAX_DOCX_UNCOMPRESSED_BYTES
                or len({entry.filename for entry in entries}) != len(entries)
                or any(entry.flag_bits & 1 for entry in entries)
                or "word/document.xml" not in archive.namelist()
            ):
                raise ValueError("Word 文档内容超出限制、加密或格式无效。")
        doc = Document(io.BytesIO(data))
    except (BadZipFile, KeyError, NotImplementedError, PackageNotFoundError, XMLSyntaxError, ZipCompressionError) as error:
        raise ValueError("无法读取 Word 文档，请另存为标准 .docx。") from error
    return "\n".join(paragraph.text for paragraph in doc.paragraphs)


def file_episodes(file: ImportFile) -> list[ImportEpisode]:
    """Extract plain screenplay paragraphs with the Workshop episode splitter.

    @param file — Word, Markdown, or plain text source.
    @returns Ordered text episodes ready to save in a new draft.
    """
    data = base64.b64decode(file.base64, validate=True)
    if not data or len(data) > MAX_IMPORT_BYTES:
        raise ValueError("请选择 4 MiB 以内的非空剧本文件。")
    extension = PurePath(file.filename).suffix.lower()
    if extension == ".docx":
        source = _word_text(data)
    elif extension in (".txt", ".md"):
        try:
            source = data.decode("utf-8-sig")
        except UnicodeDecodeError as error:
            raise ValueError("文本文件需要以 UTF-8 编码保存。") from error
        if extension == ".md":
            source = re.sub(r"(?m)^#{1,6}[ \t]+(?=第)", "", source)
    else:
        raise ValueError("请选择 .docx、.md 或 .txt 文件。")
    source = validate_editor_text(source)
    chapters = smart_split_chapters(source)
    heading = _EPISODE_HEADING.search(source)
    if heading is not None and chapters:
        preface = source[:heading.start()].strip()
        # The splitter can also use inline headings or separator lines. Keep the preface
        # only when the episode rows confirm the numbered heading was its split point.
        if preface and chapters == smart_split_chapters(source[heading.start():]):
            chapters[0]["content"] = preface + "\n\n" + chapters[0]["content"]
    return [
        ImportEpisode(title=episode["title"], content=episode["content"])
        for episode in chapters
    ]
