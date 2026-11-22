"""Embedding + Rerank helper.

支持两种 provider（通过 EMBED_PROVIDER 切换，默认 openai）：
- openai    : OpenAI 兼容协议（ai.kegeai.top、OpenAI 原生等）
- dashscope : 阿里云百炼原生协议（__REDACTED__ 不适用，
              multimodal-embedding 系列如 __REDACTED__ 必须走此协议）

用法：
    from app.models.embed import embed_texts, rerank_documents
    vecs = await embed_texts(["text1", "text2"])
    ranked = await rerank_documents("query", ["doc a", "doc b"], top_n=2)

环境变量：
    EMBED_PROVIDER      openai | dashscope        （默认 openai）
    EMBED_API_KEY       sk-...                    （缺省 fallback 到 OPENAI_API_KEY）
    EMBED_BASE_URL      自定义地址                （缺省按 provider 各自默认值）
    EMBED_MODEL         __REDACTED__ / __REDACTED__ / ...
    RERANK_PROVIDER     openai | dashscope        （未设则沿用 EMBED_PROVIDER）
    RERANK_API_KEY      同上
    RERANK_BASE_URL     同上
    RERANK_MODEL        __REDACTED__ / __REDACTED__ / ...
"""
from __future__ import annotations

import os
from typing import Any

import httpx

# ---------------------------------------------------------------------------
# provider 配置解析
# ---------------------------------------------------------------------------
_OPENAI_DEFAULT_BASE = "https://api.openai.com/v1"
_DASHSCOPE_DEFAULT_BASE = "https://dashscope.aliyuncs.com"


def _embed_cfg() -> tuple[str, str, str, str]:
    """返回 (provider, api_key, base_url, model)。"""
    provider = (os.environ.get("EMBED_PROVIDER") or "openai").strip().lower()
    api_key = os.environ.get("EMBED_API_KEY") or os.environ.get("OPENAI_API_KEY") or ""
    model = os.environ.get("EMBED_MODEL", "__REDACTED__")
    if provider == "dashscope":
        base = (os.environ.get("EMBED_BASE_URL") or _DASHSCOPE_DEFAULT_BASE).rstrip("/")
    else:
        base = (
            os.environ.get("EMBED_BASE_URL")
            or os.environ.get("OPENAI_BASE_URL")
            or _OPENAI_DEFAULT_BASE
        ).rstrip("/")
    return provider, api_key, base, model


def _rerank_cfg() -> tuple[str, str, str, str]:
    """返回 (provider, api_key, base_url, model)。

    若未单独配置 RERANK_*，回退到 EMBED_* 配置（最常见场景：同一供应商既给 embed 又给 rerank）。
    """
    provider = (
        os.environ.get("RERANK_PROVIDER")
        or os.environ.get("EMBED_PROVIDER")
        or "openai"
    ).strip().lower()
    api_key = (
        os.environ.get("RERANK_API_KEY")
        or os.environ.get("EMBED_API_KEY")
        or os.environ.get("OPENAI_API_KEY")
        or ""
    )
    model = os.environ.get("RERANK_MODEL", "__REDACTED__")
    if provider == "dashscope":
        base = (
            os.environ.get("RERANK_BASE_URL")
            or os.environ.get("EMBED_BASE_URL")
            or _DASHSCOPE_DEFAULT_BASE
        ).rstrip("/")
    else:
        base = (
            os.environ.get("RERANK_BASE_URL")
            or os.environ.get("EMBED_BASE_URL")
            or os.environ.get("OPENAI_BASE_URL")
            or _OPENAI_DEFAULT_BASE
        ).rstrip("/")
    return provider, api_key, base, model


def _headers(api_key: str) -> dict[str, str]:
    h = {"Content-Type": "application/json"}
    if api_key:
        h["Authorization"] = f"Bearer {api_key}"
    return h


# ---------------------------------------------------------------------------
# Embedding
# ---------------------------------------------------------------------------
async def embed_texts(texts: list[str], *, timeout: float = 30.0) -> list[list[float]]:
    """向量化。失败返回空列表。"""
    if not texts:
        return []
    provider, api_key, base_url, model = _embed_cfg()

    async with httpx.AsyncClient(timeout=timeout) as c:
        try:
            if provider == "dashscope":
                # 百炼多模态 embedding 原生协议
                url = (
                    f"{base_url}/api/v1/services/embeddings/"
                    "multimodal-embedding/multimodal-embedding"
                )
                payload = {
                    "model": model,
                    "input": {"contents": [{"text": t} for t in texts]},
                }
                r = await c.post(url, headers=_headers(api_key), json=payload)
                r.raise_for_status()
                items = r.json().get("output", {}).get("embeddings", [])
                return [it.get("embedding", []) for it in items]
            else:
                # OpenAI 兼容协议
                url = f"{base_url}/embeddings"
                payload = {"model": model, "input": texts}
                r = await c.post(url, headers=_headers(api_key), json=payload)
                r.raise_for_status()
                data = r.json().get("data", [])
                return [item.get("embedding", []) for item in data]
        except Exception:
            return []


# ---------------------------------------------------------------------------
# Rerank
# ---------------------------------------------------------------------------
async def rerank_documents(
    query: str,
    documents: list[str],
    *,
    top_n: int | None = None,
    timeout: float = 30.0,
) -> list[dict[str, Any]]:
    """对候选文档重排。

    返回 [{"index": int, "score": float, "document": str}]，按 score 降序。
    失败时透明降级为原顺序 + 均匀分数（永不抛错）。
    """
    if not documents:
        return []
    provider, api_key, base_url, model = _rerank_cfg()

    async with httpx.AsyncClient(timeout=timeout) as c:
        try:
            if provider == "dashscope":
                # 百炼 text-rerank 原生协议
                url = (
                    f"{base_url}/api/v1/services/rerank/"
                    "text-rerank/text-rerank"
                )
                payload: dict[str, Any] = {
                    "model": model,
                    "input": {"query": query, "documents": documents},
                }
                if top_n is not None:
                    payload["parameters"] = {"top_n": top_n}
                r = await c.post(url, headers=_headers(api_key), json=payload)
                r.raise_for_status()
                res = r.json().get("output", {}).get("results", [])
            else:
                # OpenAI 兼容协议
                url = f"{base_url}/rerank"
                payload = {"model": model, "query": query, "documents": documents}
                if top_n is not None:
                    payload["top_n"] = top_n
                r = await c.post(url, headers=_headers(api_key), json=payload)
                r.raise_for_status()
                res = r.json().get("results", [])

            out: list[dict[str, Any]] = []
            for item in res:
                idx = int(item.get("index", 0))
                score = float(
                    item.get("relevance_score", item.get("score", 0.0))
                )
                out.append(
                    {
                        "index": idx,
                        "score": score,
                        "document": documents[idx] if 0 <= idx < len(documents) else "",
                    }
                )
            # 保障降序
            out.sort(key=lambda x: x["score"], reverse=True)
            return out

        except Exception:
            n = len(documents)
            return [
                {"index": i, "score": 1.0 - i / max(n, 1), "document": documents[i]}
                for i in range(n if top_n is None else min(top_n, n))
            ]
