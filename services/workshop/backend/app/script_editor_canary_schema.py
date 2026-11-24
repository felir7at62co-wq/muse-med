"""Install only the two draft editor tables."""
import asyncio

from sqlalchemy import inspect, text
from .auth.models import User
from .db.models import ScriptEditorCandidate, ScriptEditorPublication
from .db.session import engine

tables = [ScriptEditorCandidate.__table__, ScriptEditorPublication.__table__]


def add_tables(connection):
    tables[0].metadata.create_all(connection, tables=tables)
    inspector = inspect(connection)
    for table in tables:
        assert {c["name"] for c in inspector.get_columns(table.name)} == set(table.columns.keys())
        assert set(inspector.get_pk_constraint(table.name)["constrained_columns"]) == {column.name for column in table.primary_key}
    assert {x["referred_table"] for x in inspector.get_foreign_keys("script_editor_candidates")} == {"script_drafts", "users"}
    print("Editor tables verified")


async def main():
    try:
        async with engine.begin() as connection:
            await connection.execute(text("SET LOCAL lock_timeout = '2s'"))
            await connection.execute(text("SET LOCAL statement_timeout = '12s'"))
            await connection.run_sync(add_tables)
    finally:
        await engine.dispose()


if __name__ == "__main__":
    asyncio.run(main())
