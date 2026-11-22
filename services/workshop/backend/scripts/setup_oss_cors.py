"""一次性: 给 OSS bucket 配 CORS, 让浏览器能跨域 PUT 并读到 ETag header。

dev 已跑过一次, prod 上线前需要再跑一次 (相同 AK/SK 共用 bucket, 实际无需重复, 但脚本是幂等的)。

用法:
    docker exec -w /app drama-dev-orchestrator python scripts/setup_oss_cors.py
"""
import os

from oss2.models import BucketCors, CorsRule
from app.oss.client import get_bucket_internal


def main():
    bucket = get_bucket_internal()

    try:
        current = bucket.get_bucket_cors()
        print("当前 CORS rules:")
        for r in current.rules:
            print(f"  origins={r.allowed_origins}")
            print(f"  methods={r.allowed_methods}")
            print(f"  expose ={r.expose_headers}")
    except Exception as e:
        print(f"  (无现有 CORS: {e.__class__.__name__})")

    rules = [
        CorsRule(
            allowed_origins=[
                # prod/dev 公网来源取 OSS_CORS_PUBLIC_ORIGINS(逗号分隔), 如 http://<公网地址>,http://<公网地址>:9080
                *[o.strip() for o in os.environ.get("OSS_CORS_PUBLIC_ORIGINS", "").split(",") if o.strip()],
                "http://127.0.0.1:3000",            # prod web 本地
                "http://127.0.0.1:3010",            # dev  web 本地
                "http://localhost:3000",
                "http://localhost:3010",
            ],
            allowed_methods=["PUT", "POST", "GET", "HEAD", "DELETE"],
            allowed_headers=["*"],
            expose_headers=["ETag", "x-oss-request-id", "x-oss-version-id"],
            max_age_seconds=600,
        ),
    ]

    bucket.put_bucket_cors(BucketCors(rules))
    print("\n✓ CORS 已配置")

    verify = bucket.get_bucket_cors()
    for r in verify.rules:
        print(f"  origins = {r.allowed_origins}")
        print(f"  methods = {r.allowed_methods}")
        print(f"  headers = {r.allowed_headers}")
        print(f"  expose  = {r.expose_headers}")
        print(f"  max_age = {r.max_age_seconds}s")


if __name__ == "__main__":
    main()
