"""Phase 5 数据库迁移脚本 (PLAN_UI_REVAMP §5.5).

执行方式:
  docker exec drama-dev-orchestrator python -m scripts.migrate_phase5

策略:
  本项目用 AsyncEngine, 但 schema 创建用同步连接更简单。
  这里直接用 psycopg sync 连接执行 raw SQL。
"""
from __future__ import annotations

import os
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

import psycopg


# ---------------------------------------------------------------------------
# 14 张新表的 CREATE TABLE IF NOT EXISTS DDL
# ---------------------------------------------------------------------------

CREATE_TABLES_SQL = [
    # 角色管理
    """
    CREATE TABLE IF NOT EXISTS characters (
        id SERIAL PRIMARY KEY,
        draft_id INTEGER NOT NULL,
        name VARCHAR(64) NOT NULL,
        role VARCHAR(32) DEFAULT '',
        appearance TEXT DEFAULT '',
        personality TEXT DEFAULT '',
        backstory TEXT DEFAULT '',
        avatar_url VARCHAR(512) DEFAULT '',
        avatar_prompt TEXT DEFAULT '',
        traits JSON DEFAULT '[]'::json,
        is_active BOOLEAN DEFAULT TRUE,
        sort_order INTEGER DEFAULT 0,
        created_at TIMESTAMP DEFAULT NOW(),
        updated_at TIMESTAMP DEFAULT NOW()
    )
    """,
    "CREATE INDEX IF NOT EXISTS ix_characters_draft_id ON characters(draft_id)",

    """
    CREATE TABLE IF NOT EXISTS character_relationships (
        id SERIAL PRIMARY KEY,
        draft_id INTEGER NOT NULL,
        from_character_id INTEGER NOT NULL,
        to_character_id INTEGER NOT NULL,
        relation_type VARCHAR(32) DEFAULT '',
        strength INTEGER DEFAULT 50,
        description TEXT DEFAULT '',
        created_at TIMESTAMP DEFAULT NOW()
    )
    """,
    "CREATE INDEX IF NOT EXISTS ix_character_relationships_draft_id ON character_relationships(draft_id)",

    """
    CREATE TABLE IF NOT EXISTS character_consistency_warnings (
        id SERIAL PRIMARY KEY,
        draft_id INTEGER NOT NULL,
        character_id INTEGER,
        character_name VARCHAR(64) DEFAULT '',
        chapter_orders JSON DEFAULT '[]'::json,
        warning_type VARCHAR(32) DEFAULT '',
        severity VARCHAR(8) DEFAULT 'medium',
        description TEXT DEFAULT '',
        suggestion TEXT DEFAULT '',
        resolved BOOLEAN DEFAULT FALSE,
        created_at TIMESTAMP DEFAULT NOW()
    )
    """,
    "CREATE INDEX IF NOT EXISTS ix_character_consistency_warnings_draft_id ON character_consistency_warnings(draft_id)",

    # 导出任务
    """
    CREATE TABLE IF NOT EXISTS export_jobs (
        id SERIAL PRIMARY KEY,
        user_id INTEGER NOT NULL,
        draft_id INTEGER,
        kind VARCHAR(32) NOT NULL,
        config_json JSON DEFAULT '{}'::json,
        status VARCHAR(16) DEFAULT 'pending',
        progress INTEGER DEFAULT 0,
        output_url VARCHAR(512) DEFAULT '',
        error TEXT DEFAULT '',
        created_at TIMESTAMP DEFAULT NOW(),
        started_at TIMESTAMP,
        finished_at TIMESTAMP
    )
    """,
    "CREATE INDEX IF NOT EXISTS ix_export_jobs_user_id ON export_jobs(user_id)",
    "CREATE INDEX IF NOT EXISTS ix_export_jobs_draft_id ON export_jobs(draft_id)",
    "CREATE INDEX IF NOT EXISTS ix_export_jobs_status ON export_jobs(status)",

    # 续写配置
    """
    CREATE TABLE IF NOT EXISTS draft_extend_configs (
        id SERIAL PRIMARY KEY,
        draft_id INTEGER UNIQUE NOT NULL,
        default_target_episodes INTEGER DEFAULT 20,
        default_chunk_size INTEGER DEFAULT 20,
        default_word_target INTEGER DEFAULT 5000,
        default_provider VARCHAR(16) DEFAULT 'gemini',
        forced_level VARCHAR(8),
        user_guidance_template TEXT DEFAULT '',
        created_at TIMESTAMP DEFAULT NOW(),
        updated_at TIMESTAMP DEFAULT NOW()
    )
    """,

    # 邮箱验证码
    """
    CREATE TABLE IF NOT EXISTS email_verifications (
        id SERIAL PRIMARY KEY,
        email VARCHAR(128) NOT NULL,
        code VARCHAR(8) NOT NULL,
        purpose VARCHAR(16) DEFAULT 'register',
        status VARCHAR(16) DEFAULT 'pending',
        attempts INTEGER DEFAULT 0,
        ip VARCHAR(45),
        created_at TIMESTAMP DEFAULT NOW(),
        expires_at TIMESTAMP NOT NULL,
        verified_at TIMESTAMP
    )
    """,
    "CREATE INDEX IF NOT EXISTS ix_email_verifications_email ON email_verifications(email)",

    # Agent 附件
    """
    CREATE TABLE IF NOT EXISTS agent_attachments (
        id SERIAL PRIMARY KEY,
        conversation_id INTEGER NOT NULL,
        message_id INTEGER,
        user_id INTEGER NOT NULL,
        kind VARCHAR(16) DEFAULT 'image',
        filename VARCHAR(256),
        oss_url VARCHAR(512),
        size_bytes INTEGER DEFAULT 0,
        mime_type VARCHAR(64),
        created_at TIMESTAMP DEFAULT NOW()
    )
    """,
    "CREATE INDEX IF NOT EXISTS ix_agent_attachments_conv ON agent_attachments(conversation_id)",
    "CREATE INDEX IF NOT EXISTS ix_agent_attachments_msg ON agent_attachments(message_id)",
    "CREATE INDEX IF NOT EXISTS ix_agent_attachments_user ON agent_attachments(user_id)",

    # Agent 产出物
    """
    CREATE TABLE IF NOT EXISTS agent_artifacts (
        id SERIAL PRIMARY KEY,
        conversation_id INTEGER NOT NULL,
        message_id INTEGER,
        user_id INTEGER NOT NULL,
        kind VARCHAR(16) DEFAULT 'text',
        title VARCHAR(256) DEFAULT '',
        content TEXT DEFAULT '',
        metadata_json JSONB,
        is_pinned BOOLEAN DEFAULT FALSE,
        created_at TIMESTAMP DEFAULT NOW()
    )
    """,
    "CREATE INDEX IF NOT EXISTS ix_agent_artifacts_conv ON agent_artifacts(conversation_id)",
    "CREATE INDEX IF NOT EXISTS ix_agent_artifacts_msg ON agent_artifacts(message_id)",
    "CREATE INDEX IF NOT EXISTS ix_agent_artifacts_user ON agent_artifacts(user_id)",

    # 配额
    """
    CREATE TABLE IF NOT EXISTS prompt_converter_quotas (
        id SERIAL PRIMARY KEY,
        user_id INTEGER NOT NULL,
        quota_date VARCHAR(10),
        used_count INTEGER DEFAULT 0,
        daily_limit INTEGER DEFAULT 20,
        updated_at TIMESTAMP DEFAULT NOW()
    )
    """,
    "CREATE INDEX IF NOT EXISTS ix_prompt_converter_quotas_user ON prompt_converter_quotas(user_id)",
    "CREATE INDEX IF NOT EXISTS ix_prompt_converter_quotas_date ON prompt_converter_quotas(quota_date)",

    """
    CREATE TABLE IF NOT EXISTS image_generation_quotas (
        id SERIAL PRIMARY KEY,
        user_id INTEGER NOT NULL,
        quota_date VARCHAR(10),
        used_count INTEGER DEFAULT 0,
        daily_limit INTEGER DEFAULT 10,
        kind VARCHAR(16) DEFAULT 'any',
        updated_at TIMESTAMP DEFAULT NOW()
    )
    """,
    "CREATE INDEX IF NOT EXISTS ix_image_generation_quotas_user ON image_generation_quotas(user_id)",
    "CREATE INDEX IF NOT EXISTS ix_image_generation_quotas_date ON image_generation_quotas(quota_date)",

    # 用户级批量任务
    """
    CREATE TABLE IF NOT EXISTS draft_batch_jobs (
        id SERIAL PRIMARY KEY,
        draft_id INTEGER NOT NULL,
        user_id INTEGER NOT NULL,
        kind VARCHAR(32) NOT NULL,
        config_json JSON DEFAULT '{}'::json,
        target_episodes JSON DEFAULT '[]'::json,
        status VARCHAR(16) DEFAULT 'pending',
        progress_current INTEGER DEFAULT 0,
        progress_total INTEGER DEFAULT 0,
        error TEXT DEFAULT '',
        created_at TIMESTAMP DEFAULT NOW(),
        started_at TIMESTAMP,
        finished_at TIMESTAMP
    )
    """,
    "CREATE INDEX IF NOT EXISTS ix_draft_batch_jobs_draft ON draft_batch_jobs(draft_id)",
    "CREATE INDEX IF NOT EXISTS ix_draft_batch_jobs_user ON draft_batch_jobs(user_id)",
    "CREATE INDEX IF NOT EXISTS ix_draft_batch_jobs_status ON draft_batch_jobs(status)",

    """
    CREATE TABLE IF NOT EXISTS draft_batch_logs (
        id SERIAL PRIMARY KEY,
        job_id INTEGER NOT NULL,
        episode_order INTEGER,
        log_type VARCHAR(16) DEFAULT 'info',
        message TEXT,
        log_metadata JSON DEFAULT '{}'::json,
        created_at TIMESTAMP DEFAULT NOW()
    )
    """,
    "CREATE INDEX IF NOT EXISTS ix_draft_batch_logs_job ON draft_batch_logs(job_id)",

    # 安全报告
    """
    CREATE TABLE IF NOT EXISTS safety_reports (
        id SERIAL PRIMARY KEY,
        draft_id INTEGER NOT NULL,
        scope VARCHAR(16) DEFAULT 'full',
        overall VARCHAR(16) DEFAULT 'pass',
        summary TEXT DEFAULT '',
        total_issues INTEGER DEFAULT 0,
        high_count INTEGER DEFAULT 0,
        medium_count INTEGER DEFAULT 0,
        low_count INTEGER DEFAULT 0,
        unresolved_count INTEGER DEFAULT 0,
        scores_json JSONB,
        created_at TIMESTAMP DEFAULT NOW(),
        updated_at TIMESTAMP DEFAULT NOW()
    )
    """,
    "CREATE INDEX IF NOT EXISTS ix_safety_reports_draft ON safety_reports(draft_id)",

    """
    CREATE TABLE IF NOT EXISTS safety_risks (
        id SERIAL PRIMARY KEY,
        report_id INTEGER NOT NULL,
        category VARCHAR(32),
        severity VARCHAR(8) DEFAULT 'medium',
        keyword VARCHAR(64),
        snippet TEXT DEFAULT '',
        chapter_order INTEGER,
        position INTEGER,
        reason TEXT DEFAULT '',
        suggestion TEXT DEFAULT '',
        is_resolved BOOLEAN DEFAULT FALSE,
        resolved_at TIMESTAMP,
        created_at TIMESTAMP DEFAULT NOW()
    )
    """,
    "CREATE INDEX IF NOT EXISTS ix_safety_risks_report ON safety_risks(report_id)",
]


ALTER_STATEMENTS = [
    "ALTER TABLE users ADD COLUMN IF NOT EXISTS agreement_accepted_at TIMESTAMP",
    "ALTER TABLE agent_conversations ADD COLUMN IF NOT EXISTS unread_count INTEGER DEFAULT 0",
    "ALTER TABLE agent_conversations ADD COLUMN IF NOT EXISTS last_read_at TIMESTAMP",
    "ALTER TABLE agent_conversations ADD COLUMN IF NOT EXISTS model VARCHAR(32)",
    "ALTER TABLE script_drafts ADD COLUMN IF NOT EXISTS cover_url TEXT DEFAULT ''",
    "ALTER TABLE script_analyses ADD COLUMN IF NOT EXISTS progress_step VARCHAR(50) DEFAULT ''",
    "ALTER TABLE script_analyses ADD COLUMN IF NOT EXISTS progress_current INTEGER DEFAULT 0",
    "ALTER TABLE script_analyses ADD COLUMN IF NOT EXISTS progress_total INTEGER DEFAULT 0",
]


NEW_TABLES = [
    "characters", "character_relationships", "character_consistency_warnings",
    "export_jobs", "draft_extend_configs", "email_verifications",
    "agent_attachments", "agent_artifacts",
    "prompt_converter_quotas", "image_generation_quotas",
    "draft_batch_jobs", "draft_batch_logs",
    "safety_reports", "safety_risks",
]


def get_dsn() -> str:
    """从环境变量读取 sync DSN."""
    url = os.environ.get("DATABASE_URL", "")
    if "postgresql+asyncpg" in url:
        url = url.replace("postgresql+asyncpg", "postgresql")
    elif "postgresql+psycopg" in url:
        url = url.replace("postgresql+psycopg", "postgresql")
    if not url:
        url = "postgresql://drama:drama@postgres:5432/drama_dev"
    return url


def main() -> None:
    print("[migrate_phase5] 开始 Phase 5 数据库迁移...")
    dsn = get_dsn()
    print(f"[migrate_phase5] DSN: {dsn.split('@')[-1] if '@' in dsn else dsn}")

    with psycopg.connect(dsn, autocommit=True) as conn:
        cur = conn.cursor()

        print(f"\n[migrate_phase5] (1/3) 创建 {len(NEW_TABLES)} 张新表 ({len(CREATE_TABLES_SQL)} 条 DDL)...")
        ok = 0
        for sql in CREATE_TABLES_SQL:
            try:
                cur.execute(sql)
                ok += 1
            except Exception as e:
                print(f"  ✗ DDL fail: {e}")
                print(f"    SQL: {sql[:80]}")
        print(f"[migrate_phase5]   ✓ {ok}/{len(CREATE_TABLES_SQL)} 条 DDL 成功")

        print(f"\n[migrate_phase5] (2/3) 执行 {len(ALTER_STATEMENTS)} 条 ALTER TABLE 兜底...")
        for sql in ALTER_STATEMENTS:
            try:
                cur.execute(sql)
                print(f"  ✓ {sql}")
            except Exception as e:
                print(f"  ✗ {sql}\n    error: {e}")

        print("\n[migrate_phase5] (3/3) 校验新表...")
        for t in NEW_TABLES:
            cur.execute("SELECT to_regclass(%s)", (f"public.{t}",))
            row = cur.fetchone()
            status = "✓" if row and row[0] else "✗"
            print(f"  {status} {t}")

    print("\n[migrate_phase5] ✅ 迁移完成")


if __name__ == "__main__":
    main()
