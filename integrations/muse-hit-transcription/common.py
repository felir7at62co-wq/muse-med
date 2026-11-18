"""Files and subprocesses owned by the isolated transcription worker."""

from hashlib import file_digest, sha256
import json
import os
from pathlib import Path
import re
import signal
import subprocess
from tempfile import NamedTemporaryFile
from time import monotonic, sleep


class WorkError(Exception):
    """An incomplete stage whose state and evidence must be retained."""

    def __init__(self, code, message):
        super().__init__(message)
        self.code = code


def read(path):
    """Read a JSON record from the expected, unlinked file."""
    if not path.is_file() or path.resolve() != path:
        raise WorkError("FILE_INVALID", f"文件不存在或不是原路径：{path.name}")
    return json.loads(path.read_text(encoding="utf-8"))


def digest(path):
    """Hash media or evidence without loading it all into memory."""
    with path.open("rb") as stream:
        return file_digest(stream, "sha256").hexdigest()


def canonical_json(value):
    """Return the encoded contents of an immutable JSON receipt."""
    return json.dumps(value, ensure_ascii=False, sort_keys=True, indent=2) + "\n"


def write(path, text):
    """Replace an owned receipt atomically and retain it across interruption."""
    with NamedTemporaryFile("w", encoding="utf-8", dir=path.parent, delete=False) as stream:
        temp = Path(stream.name)
        stream.write(text)
        stream.flush()
        os.fsync(stream.fileno())
    try:
        temp.replace(path)
        sync_directory(path.parent)
    finally:
        temp.unlink(missing_ok=True)


def sync_directory(path):
    """Persist the directory entry after writing a receipt."""
    fd = os.open(path, os.O_RDONLY | os.O_DIRECTORY)
    try:
        os.fsync(fd)
    finally:
        os.close(fd)


def save(path, value):
    """Atomically write a JSON receipt."""
    write(path, canonical_json(value))


def freeze(path, text):
    """Keep the original contents when a worker revisits a stage."""
    if path.exists() and (path.resolve() != path or path.read_text(encoding="utf-8") != text):
        raise WorkError("BINDING_CHANGED", f"任务绑定已变更：{path.name}")
    if not path.exists():
        write(path, text)


def under(root, value):
    """Accept an existing regular file only inside its assigned workspace."""
    path = Path(value)
    if not path.is_absolute() or not path.is_relative_to(root) or path.resolve() != path or not path.is_file():
        raise WorkError("FILE_INVALID", "来源或交付文件不在已绑定的目录中")
    return path


def series_id(value):
    """Require a decimal Hongguo identifier without coercion."""
    if not isinstance(value, str) or not re.fullmatch(r"[1-9][0-9]{14,24}", value):
        raise WorkError("INVALID_SERIES", "缺少可信的红果作品编号")
    return value


def text_hash(text):
    """Bind a single prompt or config serialization."""
    return sha256(text.encode("utf-8")).hexdigest()


def stop_group(process):
    """Interrupt the native application and wait for its process group to exit."""
    if process.poll() is not None:
        return
    try:
        os.killpg(process.pid, signal.SIGINT)
    except ProcessLookupError:
        # No member of the group remains to signal.
        process.wait()
        return
    try:
        process.wait(timeout=20)
    except subprocess.TimeoutExpired:
        try:
            os.killpg(process.pid, signal.SIGKILL)
        except ProcessLookupError:
            # The native application exited during the signal attempt.
            pass
        process.wait()


def command(argv, cwd, env, output, errors, deadline_seconds, check_running):
    """Own the process group through deadline, interruption or loss of the job lease."""
    check_running()
    with output.open("wb") as stdout, errors.open("wb") as stderr:
        with subprocess.Popen(argv, cwd=cwd, env=env, stdout=stdout, stderr=stderr, start_new_session=True) as child:
            deadline = monotonic() + deadline_seconds
            try:
                while child.poll() is None:
                    check_running()
                    if monotonic() >= deadline:
                        raise WorkError("PROCESS_TIMEOUT", "处理超时，已保留原任务记录")
                    sleep(0.25)
                check_running()
                return child.returncode
            except BaseException:
                stop_group(child)
                raise
