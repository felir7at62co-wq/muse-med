"""M5增强版数据库迁移脚本。

添加新字段:
- script_drafts: episode_count, original_outline
- script_chapters: version
- script_storyboards: version, updated_at
- 新表: script_episode_history

运行: python -m scripts.migrate_m5_enhancement
"""
import asyncio
import sys
from pathlib import Path

# 添加项目根目录到路径
sys.path.insert(0, str(Path(__file__).parent.parent))

from app.db.session import engine
from sqlalchemy import text


async def migrate():
    """执行迁移"""
    
    async with engine.begin() as conn:
        print("开始M5增强版数据库迁移...")
        
        # 1. ScriptDraft 表扩展
        print("\n[1/5] 扩展 script_drafts 表...")
        try:
            await conn.execute(text(
                "ALTER TABLE script_drafts ADD COLUMN episode_count INTEGER DEFAULT 3"
            ))
            print("  ✓ 添加 episode_count 字段")
        except Exception as e:
            if "duplicate column" in str(e).lower():
                print("  - episode_count 字段已存在,跳过")
            else:
                raise
        
        try:
            await conn.execute(text(
                "ALTER TABLE script_drafts ADD COLUMN original_outline JSON DEFAULT '{}'"
            ))
            print("  ✓ 添加 original_outline 字段")
        except Exception as e:
            if "duplicate column" in str(e).lower():
                print("  - original_outline 字段已存在,跳过")
            else:
                raise
        
        # 2. ScriptChapter 表扩展
        print("\n[2/5] 扩展 script_chapters 表...")
        try:
            await conn.execute(text(
                "ALTER TABLE script_chapters ADD COLUMN version INTEGER DEFAULT 1"
            ))
            print("  ✓ 添加 version 字段")
        except Exception as e:
            if "duplicate column" in str(e).lower():
                print("  - version 字段已存在,跳过")
            else:
                raise
        
        # 3. ScriptStoryboard 表扩展
        print("\n[3/5] 扩展 script_storyboards 表...")
        try:
            await conn.execute(text(
                "ALTER TABLE script_storyboards ADD COLUMN version INTEGER DEFAULT 1"
            ))
            print("  ✓ 添加 version 字段")
        except Exception as e:
            if "duplicate column" in str(e).lower():
                print("  - version 字段已存在,跳过")
            else:
                raise
        
        try:
            await conn.execute(text(
                "ALTER TABLE script_storyboards ADD COLUMN updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP"
            ))
            print("  ✓ 添加 updated_at 字段")
        except Exception as e:
            if "duplicate column" in str(e).lower():
                print("  - updated_at 字段已存在,跳过")
            else:
                raise
        
        # 4. 创建历史版本表 (PostgreSQL语法)
        print("\n[4/5] 创建 script_episode_history 表...")
        try:
            await conn.execute(text("""
                CREATE TABLE IF NOT EXISTS script_episode_history (
                    id SERIAL PRIMARY KEY,
                    draft_id INTEGER NOT NULL,
                    episode_order INTEGER NOT NULL,
                    stage VARCHAR(32) NOT NULL,
                    content JSON NOT NULL,
                    version INTEGER NOT NULL,
                    created_by VARCHAR(32) DEFAULT 'ai_generate',
                    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
                )
            """))
            print("  ✓ 创建 script_episode_history 表")
        except Exception as e:
            if "already exists" in str(e).lower():
                print("  - script_episode_history 表已存在,跳过")
            else:
                raise
        
        # 5. 创建索引
        print("\n[5/5] 创建索引...")
        try:
            await conn.execute(text(
                "CREATE INDEX IF NOT EXISTS idx_history_draft_episode ON script_episode_history(draft_id, episode_order, stage)"
            ))
            print("  ✓ 创建 idx_history_draft_episode 索引")
        except Exception as e:
            print(f"  - 索引创建失败或已存在: {e}")
        
        # 6. 数据迁移: 为现有数据设置默认值
        print("\n[6/6] 迁移现有数据...")
        
        # 为现有 drafts 设置 episode_count (基于 outline.chapters 长度)
        result = await conn.execute(text(
            "SELECT id, outline FROM script_drafts WHERE episode_count IS NULL OR episode_count = 0"
        ))
        rows = result.fetchall()
        for row in rows:
            draft_id, outline = row
            if outline and isinstance(outline, dict):
                chapters = outline.get('chapters', [])
                if not chapters:
                    chapters = outline.get('episodes', [])
                episode_count = len(chapters) if chapters else 3
            else:
                episode_count = 3
            
            await conn.execute(
                text("UPDATE script_drafts SET episode_count = :count WHERE id = :id"),
                {"count": episode_count, "id": draft_id}
            )
        print(f"  ✓ 更新了 {len(rows)} 个草稿的 episode_count")
        
        # 为现有 chapters 设置 version = 1
        await conn.execute(text(
            "UPDATE script_chapters SET version = 1 WHERE version IS NULL OR version = 0"
        ))
        print("  ✓ 更新了现有章节的 version")
        
        # 为现有 storyboards 设置 version = 1
        await conn.execute(text(
            "UPDATE script_storyboards SET version = 1 WHERE version IS NULL OR version = 0"
        ))
        print("  ✓ 更新了现有剧本的 version")
        
        print("\n✅ M5增强版数据库迁移完成!")


if __name__ == "__main__":
    asyncio.run(migrate())
