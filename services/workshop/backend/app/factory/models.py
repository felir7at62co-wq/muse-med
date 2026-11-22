"""Factory 数据模型

内容裂变工厂的核心数据模型：
- FactoryJob: 任务表
- FactoryProduct: 产物表
- FactoryStats: 统计表
"""
from sqlalchemy import Column, Integer, String, Text, Float, DateTime, Date, BigInteger, func
from sqlalchemy.dialects.postgresql import JSONB
from ..db.models import Base


class FactoryJob(Base):
    """工厂任务表"""
    __tablename__ = "factory_jobs"
    
    id = Column(Integer, primary_key=True, index=True)
    user_id = Column(Integer, nullable=False, index=True)
    job_type = Column(String(50), nullable=False, index=True)  # create_spawn/import_spawn/batch_video
    status = Column(String(50), nullable=False, default="pending", index=True)  # pending/running/succeeded/failed/partial_failed
    config = Column(JSONB, nullable=False, default={})
    progress = Column(JSONB, nullable=False, default={})
    result = Column(JSONB, nullable=False, default={})
    total_tokens = Column(Integer, nullable=False, default=0)
    prompt_tokens = Column(Integer, nullable=False, default=0)
    completion_tokens = Column(Integer, nullable=False, default=0)
    cached_tokens = Column(Integer, nullable=False, default=0)
    error_message = Column(Text)
    created_at = Column(DateTime, nullable=False, server_default=func.now())
    updated_at = Column(DateTime, nullable=False, server_default=func.now(), onupdate=func.now())
    finished_at = Column(DateTime)


class FactoryProduct(Base):
    """工厂产物表"""
    __tablename__ = "factory_products"
    
    id = Column(Integer, primary_key=True, index=True)
    job_id = Column(Integer, nullable=False, index=True)
    user_id = Column(Integer, nullable=False, index=True)
    product_type = Column(String(50), nullable=False, index=True)  # outline/script/novel/tweet/video
    title = Column(String(500))
    content = Column(Text)
    meta_data = Column("metadata", JSONB, nullable=False, default={})  # Python用meta_data,DB用metadata
    quality_score = Column(Float)
    parent_id = Column(Integer, index=True)  # 溯源链：指向父产物
    draft_id = Column(Integer, index=True)  # 关联的草稿ID（如果已导入到草稿系统）
    status = Column(String(50), nullable=False, default="completed")  # pending/running/completed/failed
    created_at = Column(DateTime, nullable=False, server_default=func.now())


class FactoryDistTarget(Base):
    """分发目标表 — 飞书多维表格目标配置(可命名复用)

    name: 分发对象名称(如"A组编剧"),同步到分发弹窗的"分发给谁"下拉列表
    url: 飞书多维表格链接(wiki或base链接,含?table=)
    field_mapping: {"title": "剧名", "script": "剧本", "genre": "类型", "outline": "大纲"}
                   value为飞书表格中的表头名,空字符串表示不分发该要素
    """
    __tablename__ = "factory_dist_targets"

    id = Column(Integer, primary_key=True, index=True)
    user_id = Column(Integer, nullable=False, index=True)
    name = Column(String(200), nullable=False)
    url = Column(Text, nullable=False)
    field_mapping = Column(JSONB, nullable=False, default={})
    created_at = Column(DateTime, nullable=False, server_default=func.now())
    updated_at = Column(DateTime, nullable=False, server_default=func.now(), onupdate=func.now())


class FactoryStats(Base):
    """工厂统计表（每日）"""
    __tablename__ = "factory_stats"
    
    id = Column(Integer, primary_key=True, index=True)
    date = Column(Date, nullable=False, unique=True, index=True)
    total_jobs = Column(Integer, nullable=False, default=0)
    success_jobs = Column(Integer, nullable=False, default=0)
    failed_jobs = Column(Integer, nullable=False, default=0)
    total_tokens = Column(BigInteger, nullable=False, default=0)
    job_type_dist = Column(JSONB, nullable=False, default={})  # {"create_spawn": 10, "import_spawn": 5}
    avg_duration = Column(Float)  # 平均耗时（秒）
    created_at = Column(DateTime, nullable=False, server_default=func.now())
