"""批量上传文件解析"""
import io
import logging
import os
from fastapi import UploadFile
import chardet

logger = logging.getLogger("file_upload")

MAX_FILE_SIZE = 100 * 1024 * 1024  # 100MB
SHORT_TEXT_THRESHOLD = 2000  # 2000字以下=概要
LONG_TEXT_THRESHOLD = 50000  # 5万字以上=强制切分为已有剧本


async def parse_text_file(file: UploadFile) -> str:
    """解析txt文件"""
    content_bytes = await file.read()
    detected = chardet.detect(content_bytes)
    encoding = detected.get("encoding", "utf-8") or "utf-8"
    try:
        return content_bytes.decode(encoding)
    except Exception:
        return content_bytes.decode("utf-8", errors="ignore")


async def parse_docx_file(file: UploadFile) -> str:
    """解析docx文件
    
    - 仅提取文字内容(段落+表格),自动忽略图片/形状/嵌入对象
    - 对任何无法解析的元素容错跳过,不因图片等非文本内容失败
    """
    try:
        from docx import Document
    except ImportError:
        raise ValueError("未安装python-docx")
    content_bytes = await file.read()
    doc = Document(io.BytesIO(content_bytes))
    
    texts = []
    # 1. 段落文本(自动跳过图片/形状/嵌入对象)
    for p in doc.paragraphs:
        try:
            text = p.text
            if text and text.strip():
                texts.append(text)
        except Exception:
            continue  # 跳过任何异常段落
    
    # 2. 表格中的文字
    for table in doc.tables:
        try:
            for row in table.rows:
                for cell in row.cells:
                    try:
                        cell_text = cell.text.strip()
                        if cell_text:
                            texts.append(cell_text)
                    except Exception:
                        continue
        except Exception:
            continue
    
    return "\n\n".join(texts)


async def parse_pdf_file(file: UploadFile) -> str:
    """解析PDF文件
    
    - 仅提取文字内容,自动忽略图片
    - 任何单页失败都跳过,不影响其他页
    """
    try:
        import pdfplumber
    except ImportError:
        raise ValueError("未安装pdfplumber,无法解析PDF")
    content_bytes = await file.read()
    texts = []
    try:
        with pdfplumber.open(io.BytesIO(content_bytes)) as pdf:
            for page in pdf.pages:
                try:
                    text = page.extract_text()
                    if text:
                        texts.append(text)
                except Exception:
                    continue  # 跳过无法解析的页
    except Exception as e:
        raise ValueError(f"PDF解析失败: {e}")
    return "\n\n".join(texts)


async def parse_markdown_file(file: UploadFile) -> str:
    """解析Markdown文件(当作纯文本)"""
    return await parse_text_file(file)


def extract_title_from_content(content: str, filename: str, prefer_firstline: bool = False) -> str:
    """从内容或文件名提取标题"""
    title_from_name = os.path.splitext(filename)[0][:100]

    # 尝试从第一行提取
    lines = content.strip().split("\n")
    first_line = lines[0].strip() if lines else ""

    # 去除常见前缀(如 "# " "第一章" 等)
    first_line = first_line.lstrip("#").strip()

    if prefer_firstline and first_line and len(first_line) < 80:
        return first_line[:100]

    # 默认:文件名太短或无意义时,用第一行
    if len(title_from_name) < 2 or title_from_name.isdigit():
        if first_line and len(first_line) < 50:
            return first_line[:100]

    return title_from_name


async def parse_file(file: UploadFile, prefer_firstline_title: bool = False) -> dict:
    """解析单个文件

    返回: {
        "title": str,
        "content": str,
        "word_count": int,
        "length_category": "short"|"medium"|"long",
        "filename": str,
        "file_type": str,
        "error": str | None,
    }
    """
    filename = file.filename or "untitled"
    file_type = filename.lower().split(".")[-1] if "." in filename else ""

    # 检查文件大小
    file.file.seek(0, 2)
    size = file.file.tell()
    file.file.seek(0)

    if size > MAX_FILE_SIZE:
        return {
            "title": filename, "content": "", "word_count": 0,
            "length_category": "", "filename": filename, "file_type": file_type,
            "error": f"文件大小{size / 1024 / 1024:.1f}MB超过100MB限制",
        }

    # 根据扩展名解析
    try:
        if file_type == "txt":
            content = await parse_text_file(file)
        elif file_type == "docx":
            content = await parse_docx_file(file)
        elif file_type == "pdf":
            content = await parse_pdf_file(file)
        elif file_type in ("md", "markdown"):
            content = await parse_markdown_file(file)
        else:
            return {
                "title": filename, "content": "", "word_count": 0,
                "length_category": "", "filename": filename, "file_type": file_type,
                "error": f"不支持的格式: .{file_type} (支持: txt/docx/pdf/md)",
            }

        if not content.strip():
            return {
                "title": filename, "content": "", "word_count": 0,
                "length_category": "", "filename": filename, "file_type": file_type,
                "error": "文件内容为空",
            }

        word_count = len(content)
        if word_count < SHORT_TEXT_THRESHOLD:
            length_category = "short"   # 短文,作为概要
        elif word_count < LONG_TEXT_THRESHOLD:
            length_category = "medium"  # 中等,让用户选择
        else:
            length_category = "long"    # 长文,建议切分为已有剧本

        title = extract_title_from_content(content, filename, prefer_firstline_title)

        return {
            "title": title,
            "content": content,
            "word_count": word_count,
            "length_category": length_category,
            "filename": filename,
            "file_type": file_type,
            "error": None,
        }

    except ValueError as ve:
        return {
            "title": filename, "content": "", "word_count": 0,
            "length_category": "", "filename": filename, "file_type": file_type,
            "error": str(ve),
        }
    except Exception as e:
        logger.error(f"解析文件{filename}失败: {e}", exc_info=True)
        return {
            "title": filename, "content": "", "word_count": 0,
            "length_category": "", "filename": filename, "file_type": file_type,
            "error": f"解析失败: {str(e)}",
        }
