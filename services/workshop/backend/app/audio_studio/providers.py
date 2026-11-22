"""audio_studio provider 适配层 — RunningHub IndexTTS 工作流。

工作流 __REDACTED__ (IndexTTS-1.5 语音克隆 TTS):
  - 节点 #4 LoadAudio   : 上传参考音色音频, fieldName = "audio"
  - 节点 #7 JjkText     : 待合成文本,         fieldName = "text"
  - 节点 #3 SaveAudio   : 输出 (产出音频)

异步协议 (与 image_studio 高清放大同源):
  1. POST /task/openapi/upload   上传参考音频, 返回 fileName
  2. POST /task/openapi/create   workflowId + nodeInfoList, 返回 taskId
  3. POST /task/openapi/status   轮询状态
  4. POST /task/openapi/outputs  取产出文件 URL
"""
from __future__ import annotations

import json
import os

import httpx

# 工作流节点 id (固定)
AUDIO_REF_NODE_ID = "4"      # LoadAudio (参考音色)
AUDIO_REF_FIELD = "audio"
AUDIO_TEXT_NODE_ID = "7"     # JjkText (待合成文本)
AUDIO_TEXT_FIELD = "text"
# 输出节点 #3 SaveAudio — outputs 接口按 taskId 取全部产出, 无需显式指定

# IndexTTS 工作流完整图 (来自 runninghub.cn/workflow/__REDACTED__)。
# 该工作流非本账号保存的私有工作流, 仅传 workflowId 调 create 会报
# 810 WORKFLOW_NOT_SAVED_OR_NOT_RUNNING; 必须随 create 一并传完整 workflowJson
# 才能以"临时运行"模式跑非本账号工作流 (已实测 code:0)。
# 节点 #4(参考音色) / #7(文本) 的实际值由 nodeInfoList 覆盖, 这里的值仅占位。
AUDIO_WORKFLOW_GRAPH: dict = {
    "3": {
        "inputs": {"filename_prefix": "audio/ComfyUI", "audioUI": "", "audio": ["6", 0]},
        "class_type": "SaveAudio",
        "_meta": {"title": "Save Audio (FLAC) (Deprecated)"},
    },
    "4": {
        "inputs": {"audio": "placeholder.flac", "audioUI": ""},
        "class_type": "LoadAudio",
        "_meta": {"title": "Load Audio"},
    },
    "5": {
        "inputs": {"start_time": "0:00", "end_time": "0:15", "audio": ["4", 0]},
        "class_type": "AudioCrop",
        "_meta": {"title": "AudioCrop"},
    },
    "6": {
        "inputs": {
            "text": ["7", 0],
            "model_version": "IndexTTS-1.5",
            "language": "auto",
            "speed": 1,
            "seed": 1045055454,
            "temperature": 1,
            "top_p": 0.8,
            "top_k": 30,
            "repetition_penalty": 10,
            "length_penalty": 0,
            "num_beams": 3,
            "max_mel_tokens": 1500,
            "sentence_split": "auto",
            "reference_audio": ["5", 0],
        },
        "class_type": "IndexTTSNode",
        "_meta": {"title": "Index TTS"},
    },
    "7": {
        "inputs": {"text": "placeholder"},
        "class_type": "JjkText",
        "_meta": {"title": "Text"},
    },
}


def _rh_cfg() -> tuple[str, str, str]:
    key = os.environ.get("RUNNINGHUB_API_KEY", "").strip()
    base = os.environ.get("RUNNINGHUB_BASE_URL", "https://www.runninghub.cn").rstrip("/")
    wf = os.environ.get("RUNNINGHUB_AUDIO_WORKFLOW_ID", "").strip()
    if not key:
        raise RuntimeError("RUNNINGHUB_API_KEY not configured")
    if not wf:
        raise RuntimeError("RUNNINGHUB_AUDIO_WORKFLOW_ID not configured")
    return key, base, wf


async def rh_upload_audio(raw: bytes, *, filename: str = "ref.flac", timeout: float = 180.0) -> str:
    """上传参考音色音频到 RunningHub, 返回远端 fileName。

    RunningHub 上传接口对音频需带 fileType=audio (图片为 image)。
    """
    key, base, _ = _rh_cfg()
    ctype = "audio/flac"
    low = filename.lower()
    if low.endswith(".wav"):
        ctype = "audio/wav"
    elif low.endswith(".mp3"):
        ctype = "audio/mpeg"
    elif low.endswith(".m4a"):
        ctype = "audio/mp4"
    async with httpx.AsyncClient(timeout=timeout) as c:
        r = await c.post(
            f"{base}/task/openapi/upload",
            data={"apiKey": key, "fileType": "audio"},
            files={"file": (filename, raw, ctype)},
        )
    if r.status_code != 200:
        raise RuntimeError(f"RH audio upload HTTP {r.status_code}: {r.text[:200]}")
    d = r.json()
    if d.get("code") != 0:
        raise RuntimeError(f"RH audio upload error: {d.get('msg')}")
    fn = (d.get("data") or {}).get("fileName")
    if not fn:
        raise RuntimeError(f"RH audio upload no fileName: {str(d)[:200]}")
    return fn


async def rh_create_audio(*, ref_file_name: str, text: str, timeout: float = 60.0) -> str:
    """创建音频生成任务, 返回远端 taskId。

    把参考音色 fileName 注入节点 #4, 待合成文本注入节点 #7。
    """
    key, base, wf = _rh_cfg()
    # 随 create 传完整 workflowJson, 以"临时运行"模式跑非本账号保存的工作流;
    # 节点实际值仍由 nodeInfoList 覆盖 (#4 参考音色 / #7 文本)。
    payload = {
        "apiKey": key,
        "workflowId": wf,
        "workflowJson": json.dumps(AUDIO_WORKFLOW_GRAPH, ensure_ascii=False),
        "nodeInfoList": [
            {"nodeId": AUDIO_REF_NODE_ID, "fieldName": AUDIO_REF_FIELD, "fieldValue": ref_file_name},
            {"nodeId": AUDIO_TEXT_NODE_ID, "fieldName": AUDIO_TEXT_FIELD, "fieldValue": text},
        ],
    }
    async with httpx.AsyncClient(timeout=timeout) as c:
        r = await c.post(f"{base}/task/openapi/create", json=payload)
    if r.status_code != 200:
        raise RuntimeError(f"RH audio create HTTP {r.status_code}: {r.text[:200]}")
    d = r.json()
    if d.get("code") != 0:
        raise RuntimeError(f"RH audio create error: {d.get('msg')}")
    tid = (d.get("data") or {}).get("taskId")
    if not tid:
        raise RuntimeError(f"RH audio create no taskId: {str(d)[:200]}")
    return str(tid)


async def rh_status(task_id: str, *, timeout: float = 30.0) -> str:
    """查询任务状态: RUNNING / SUCCESS / FAILED / QUEUED 等。"""
    key, base, _ = _rh_cfg()
    async with httpx.AsyncClient(timeout=timeout) as c:
        r = await c.post(f"{base}/task/openapi/status", json={"apiKey": key, "taskId": task_id})
    if r.status_code != 200:
        raise RuntimeError(f"RH audio status HTTP {r.status_code}: {r.text[:200]}")
    d = r.json()
    if d.get("code") != 0:
        raise RuntimeError(f"RH audio status error: {d.get('msg')}")
    return str(d.get("data") or "").upper()


async def rh_outputs(task_id: str, *, timeout: float = 60.0) -> list[str]:
    """取产出音频 URL 列表 (SUCCESS 后调用)。"""
    key, base, _ = _rh_cfg()
    async with httpx.AsyncClient(timeout=timeout) as c:
        r = await c.post(f"{base}/task/openapi/outputs", json={"apiKey": key, "taskId": task_id})
    if r.status_code != 200:
        raise RuntimeError(f"RH audio outputs HTTP {r.status_code}: {r.text[:200]}")
    d = r.json()
    if d.get("code") != 0:
        raise RuntimeError(f"RH audio outputs error: {d.get('msg')} {str(d.get('data'))[:200]}")
    data = d.get("data") or []
    urls: list[str] = []
    if isinstance(data, list):
        for it in data:
            if isinstance(it, dict):
                u = it.get("fileUrl") or it.get("url")
                if u:
                    urls.append(u)
            elif isinstance(it, str):
                urls.append(it)
    if not urls:
        raise RuntimeError(f"RH audio outputs no urls: {str(d)[:200]}")
    return urls


async def download_url(url: str, *, timeout: float = 300.0) -> bytes:
    async with httpx.AsyncClient(timeout=timeout) as c:
        r = await c.get(url)
        if r.status_code != 200:
            raise RuntimeError(f"download HTTP {r.status_code}")
        return r.content


def fmt_from_url(url: str) -> str:
    """从产出 URL 后缀推断音频格式。"""
    low = url.lower().split("?")[0]
    for ext in ("flac", "wav", "mp3", "m4a", "ogg"):
        if low.endswith("." + ext):
            return ext
    return "flac"